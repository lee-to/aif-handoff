#!/bin/sh
# Fix ownership of mounted volumes, then drop to node user
if [ "$(id -u)" = "0" ]; then
  chown -R node:node /data /home/www /home/node/.claude /home/node/.claude.json 2>/dev/null || true
  export HOME=/home/node
  exec gosu node "$@"
else
  exec "$@"
fi
