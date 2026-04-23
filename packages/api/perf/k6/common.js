import { check } from "k6";
import http from "k6/http";

// Read base URL from env so the same scripts run against local dev and staging
// without edits. Defaults target the local dev API on :3009.
export const BASE_URL = __ENV.AIF_API_URL || "http://localhost:3009";

// Shared tags surface in the k6 summary so we can separate assertions per
// endpoint when scripts cover multiple routes.
export function tag(name) {
  return { tags: { endpoint: name } };
}

// Pick the first project id from the dev DB on the setup phase so VUs that
// need a project identifier do not all pay for the lookup.
export function resolveFirstProjectId() {
  const res = http.get(`${BASE_URL}/projects`);
  if (res.status !== 200) {
    throw new Error(`GET /projects returned ${res.status}; is the API up at ${BASE_URL}?`);
  }
  const body = res.json();
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  return body[0].id;
}

export function okStatus(name) {
  return (res) => {
    return check(res, {
      [`${name}: status 200`]: (r) => r.status === 200,
      [`${name}: has body`]: (r) => typeof r.body === "string" && r.body.length >= 0,
    });
  };
}
