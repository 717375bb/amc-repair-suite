#!/usr/bin/env bash
# Launches both dev servers in the background and returns immediately, so
# postStartCommand doesn't block container startup. Logs go to /tmp so they
# can be tailed if something doesn't come up (`tail -f /tmp/amc-*.log`).
#
# Real bug found via live testing: plain `nohup ... &` was NOT enough to
# survive postStartCommand's own process returning — Codespaces tears down
# the process group the lifecycle command ran in once it exits, and nohup
# only blocks SIGHUP, not that. `setsid` puts each server in a brand new
# session (a different process group entirely), which does survive.
# Confirmed: running this manually in an interactive terminal always
# "worked" (interactive terminals aren't torn down the same way), which is
# why that alone didn't prove postStartCommand itself would work.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

echo "==> Starting backend (npm run server)..."
(cd "$REPO_ROOT/backend" && setsid nohup npm run server < /dev/null > /tmp/amc-backend.log 2>&1 &)

echo "==> Starting frontend (npm run dev)..."
(cd "$REPO_ROOT" && setsid nohup npm run dev < /dev/null > /tmp/amc-frontend.log 2>&1 &)

echo "==> Both started in the background. Logs: /tmp/amc-backend.log, /tmp/amc-frontend.log"
echo "    Port 5173 will open automatically once the frontend is ready."
