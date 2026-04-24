import http from "k6/http";
import { BASE_URL, okStatus, resolveFirstProjectId, tag } from "./common.js";

// /tasks is a pure SQLite read — this script is the canary that catches the
// "we slowed down the DB layer" class of regression; thresholds are tight on
// purpose because the endpoint has no business talking to the filesystem.
export const options = {
  scenarios: {
    steady: {
      executor: "constant-vus",
      vus: 20,
      duration: "20s",
    },
  },
  thresholds: {
    "http_req_failed{endpoint:tasks}": ["rate<0.01"],
    // Payload is ~100KB per task list; serialization + SQLite joins dominate
    // under 20 VUs. Budgets set above baseline (~570ms p95) so 2-3× regressions
    // still fail the suite while normal load does not flap.
    "http_req_duration{endpoint:tasks}": ["p(95)<1200", "p(99)<2000"],
  },
};

export function setup() {
  const projectId = resolveFirstProjectId();
  return { projectId };
}

const check200 = okStatus("tasks");

export default function (data) {
  const url = data.projectId
    ? `${BASE_URL}/tasks?projectId=${encodeURIComponent(data.projectId)}`
    : `${BASE_URL}/tasks`;
  const res = http.get(url, tag("tasks"));
  check200(res);
}
