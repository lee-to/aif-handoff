/**
 * Headers for the API's internal broadcast endpoints
 * (`POST /tasks/:id/broadcast`, `POST /projects/:id/broadcast`).
 *
 * `internalBroadcastAuth` accepts a caller in exactly two ways: a request token
 * matching the configured `INTERNAL_BROADCAST_TOKEN`, or — when no token is
 * configured at all — any caller while `NODE_ENV=test`. Every out-of-process
 * producer of WS events (agent coordinator, MCP tools) must send the token,
 * otherwise the broadcast is rejected with 401 and the event never reaches the
 * web UI or the agent's wake channel.
 *
 * Both accepted header forms are sent, because the middleware reads either one.
 *
 * The token is passed in rather than read here so each caller resolves it
 * through its own `getEnv()` binding.
 */
export function internalBroadcastHeaders(token: string | undefined | null): Record<string, string> {
  const trimmedToken = token?.trim() ?? "";
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (trimmedToken) {
    headers.Authorization = `Bearer ${trimmedToken}`;
    headers["X-Internal-Broadcast-Token"] = trimmedToken;
  }

  return headers;
}
