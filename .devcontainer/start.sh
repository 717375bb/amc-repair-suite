#!/usr/bin/env bash
# Launches both dev servers in the background and returns immediately, so
# postStartCommand doesn't block container startup. Logs go to /tmp so they
# can be tailed if something doesn't come up (`tail -f /tmp/amc-*.log`).
set -uo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

echo "==> Starting backend (npm run server)..."
(cd "$REPO_ROOT/backend" && nohup npm run server > /tmp/amc-backend.log 2>&1 &)

echo "==> Starting frontend (npm run dev)..."
(cd "$REPO_ROOT" && nohup npm run dev > /tmp/amc-frontend.log 2>&1 &)

echo "==> Both started in the background. Logs: /tmp/amc-backend.log, /tmp/amc-frontend.log"
echo "    Port 5173 will open automatically once the frontend is ready."
