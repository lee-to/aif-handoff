import http from "k6/http";
import { BASE_URL, okStatus, tag } from "./common.js";

// Stampede scenario for /runtime-profiles: 20 virtual users hit the endpoint
// concurrently so the server-side cache has to serve all of them from a single
// expensive scan. This is the regression we just fixed — 14s cold pre-fix, so
// the thresholds here assume the capped-scan + 60s snapshot cache are live.
export const options = {
  scenarios: {
    stampede: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "5s", target: 20 },
        { duration: "20s", target: 20 },
        { duration: "5s", target: 0 },
      ],
      gracefulRampDown: "5s",
    },
  },
  thresholds: {
    "http_req_failed{endpoint:runtime-profiles}": ["rate<0.01"],
    "http_req_duration{endpoint:runtime-profiles}": ["p(95)<8000", "p(99)<12000"],
  },
};

const check200 = okStatus("runtime-profiles");

export default function () {
  const res = http.get(
    `${BASE_URL}/runtime-profiles?includeGlobal=true&enabledOnly=false`,
    tag("runtime-profiles"),
  );
  check200(res);
}
