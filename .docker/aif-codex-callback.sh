#!/usr/bin/env bash
# aif-codex-callback — fallback CLI for completing the Codex OAuth callback
# from inside the agent container when the broker UI is not available.
#
# Usage:
#   docker compose exec agent aif-codex-callback "<redirect-url>"
#
# Validates scheme/host/port/params before issuing the curl. This is a
# defence-in-depth fallback; do not relax these checks.

set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: aif-codex-callback \"<redirect-url>\"" >&2
  exit 2
fi

URL="$1"
ALLOWED_PORT="${AIF_CODEX_LOGIN_LOOPBACK_PORT:-1455}"

# Require http:// scheme
case "$URL" in
  http://*) ;;
  *)
    echo "error: scheme_not_allowed (only http:// accepted)" >&2
    exit 3
    ;;
esac

# Extract host and port from the URL (strip scheme and path)
host_port="${URL#http://}"
host_port="${host_port%%/*}"
host="${host_port%%:*}"
if [[ "$host_port" == *:* ]]; then
  port="${host_port##*:}"
else
  port=80
fi

if [ "$host" != "127.0.0.1" ] && [ "$host" != "localhost" ]; then
  echo "error: host_not_allowed (got '$host')" >&2
  exit 4
fi

if [ "$port" != "$ALLOWED_PORT" ]; then
  echo "error: port_not_allowed (got '$port', expected '$ALLOWED_PORT')" >&2
  exit 5
fi

# Require code and state query params
if ! echo "$URL" | grep -qE '[?&]code=[^&]+'; then
  echo "error: missing_code" >&2
  exit 6
fi
if ! echo "$URL" | grep -qE '[?&]state=[^&]+'; then
  echo "error: missing_state" >&2
  exit 7
fi

echo "[aif-codex-callback] forwarding to loopback (params redacted)"
curl -sSf -o /dev/null --max-time 10 "$URL"
echo "[aif-codex-callback] ok"
