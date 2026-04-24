import http from "k6/http";
import { BASE_URL, okStatus, resolveFirstProjectId, tag } from "./common.js";

// /chat/sessions currently reads Codex session metas from disk. With the 30s
// in-memory cache a sustained 10-VU load should sit well under the cold-call
// cost — this script pins the steady-state budget.
export const options = {
  scenarios: {
    steady: {
      executor: "constant-vus",
      vus: 10,
      duration: "20s",
    },
  },
  thresholds: {
    "http_req_failed{endpoint:chat-sessions}": ["rate<0.01"],
    "http_req_duration{endpoint:chat-sessions}": ["p(95)<3000", "p(99)<6000"],
  },
};

export function setup() {
  const projectId = resolveFirstProjectId();
  if (!projectId) {
    throw new Error("No project present in the dev DB — seed a project before running k6.");
  }
  return { projectId };
}

const check200 = okStatus("chat-sessions");

export default function (data) {
  const res = http.get(
    `${BASE_URL}/chat/sessions?projectId=${encodeURIComponent(data.projectId)}`,
    tag("chat-sessions"),
  );
  check200(res);
}
