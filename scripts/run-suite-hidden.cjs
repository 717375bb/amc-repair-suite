/**
 * Runs the backend and frontend with NO visible console windows, opens the
 * app in the browser once both are up, and stops both automatically once
 * the browser tab actually closes (see src/lib/heartbeat.ts's `pagehide`
 * handler and server.ts's /api/heartbeat-closed) — with a long heartbeat-
 * timeout fallback for the abnormal case where that signal never arrives
 * at all. See HEARTBEAT_TIMEOUT_MS's own comment below for why this is no
 * longer inferred from a short ping timeout alone: real production runs
 * were killed mid-write when a merely-backgrounded (not closed) tab's
 * throttled timer missed a 30-second window on its own.
 *
 * WHY THIS EXISTS (2026-09-10, per explicit user direction): the previous
 * launcher (Start-AMC-Repair-Suite.bat alone) opened the backend and
 * frontend each in their own `cmd /k` console window — functional, but
 * "unclean." This script is meant to be launched HIDDEN (no window of its
 * own either) — see scripts/Start-Hidden.ps1, which wraps it in
 * `Start-Process -WindowStyle Hidden` — and takes over everything
 * Start-AMC-Repair-Suite.bat used to do after its own pre-flight checks
 * (npm install / .env prep), which stay in the .bat itself since those are
 * one-time, visible-on-purpose steps a first-run analyst should see.
 *
 * This process is the SOLE authority on when to stop the backend/frontend
 * — it is the one thing polling heartbeat-status and deciding "no tab has
 * pinged in too long," specifically so two independent shutdown timers
 * (one per child) can never race each other or disagree.
 *
 * Everything is logged to logs/ (repo root, gitignored) since there is no
 * visible console to read errors from anymore — check there first if
 * something doesn't come up.
 */

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const REPO_ROOT = path.join(__dirname, '..');
const BACKEND_DIR = path.join(REPO_ROOT, 'backend');
const LOG_DIR = path.join(REPO_ROOT, 'logs');
// CLAUDE_CODE_PROMPT (hidden launcher, 2026-09-10) — a JSON state file
// with all three real PIDs, not just this process's own. Windows does not
// deliver a real SIGTERM to a Node process the way POSIX does —
// Stop-Process/taskkill without cooperation just force-terminates it, so
// this process's own `process.on('SIGTERM', ...)` handler below is NOT a
// reliable stop path on its own (confirmed against Node's own documented
// Windows signal limitations, not assumed). Stop-AMC-Repair-Suite.ps1
// reads this file and taskkills all three PIDs directly instead of
// depending on this process waking up to clean up after itself.
const STATE_FILE = path.join(LOG_DIR, 'hidden-launcher-state.json');

const BACKEND_HEALTH_URL = 'http://127.0.0.1:3001/health';
const FRONTEND_URL = 'http://127.0.0.1:5173';
const HEARTBEAT_STATUS_URL = 'http://127.0.0.1:3001/api/heartbeat-status';
const APP_URL = 'http://localhost:5173';

// How long to wait, from process start, before the heartbeat-timeout check
// is even allowed to fire — covers backend/frontend startup time plus the
// time for the browser to actually load the page and send its first ping.
const STARTUP_GRACE_MS = 60_000;
// CLAUDE_CODE_PROMPT (real production incident, 2026-09-10, same day) —
// REAL BUG FOUND AND FIXED: this was 30_000 (30s), on the theory that a
// backgrounded tab's throttled-but-non-zero timer would still comfortably
// clear it. Confirmed wrong against real logs from this machine —
// logs/launcher.log recorded three separate shutdowns at "no heartbeat for
// 34529ms" / "32678ms" / "34944ms", each just past that threshold, and
// logs/backend.log shows a real ESD-write batch (production MXI orders)
// running right up to the same timestamp as the last of those three. The
// analyst had not closed the tab — it was simply backgrounded during a
// long run, and browser timer throttling alone was enough to miss a 30s
// window on a 5s interval.
//
// The primary shutdown signal is now `explicitlyClosed` (see
// heartbeat.ts's `pagehide` handler and server.ts's /api/heartbeat-closed)
// — a real signal fired only on an actual tab close, not an inferred one.
// This timeout is now purely a SAFETY NET for the abnormal case where that
// signal never arrives at all (a crash, a forced kill, the machine losing
// power) — it no longer needs to be tight, so it's set generously long
// specifically so ordinary background-tab throttling can never trigger it
// again while a normal, still-open tab has simply gone quiet for a while.
const HEARTBEAT_TIMEOUT_MS = 20 * 60_000; // 20 minutes
const HEARTBEAT_POLL_MS = 5_000;
const STARTUP_POLL_MS = 500;
const STARTUP_TIMEOUT_MS = 120_000;

fs.mkdirSync(LOG_DIR, { recursive: true });
const startedAt = Date.now();

function timestamp() {
  return new Date().toISOString();
}

function openLog(name) {
  return fs.openSync(path.join(LOG_DIR, name), 'a');
}

function log(message) {
  fs.appendFileSync(path.join(LOG_DIR, 'launcher.log'), `[${timestamp()}] ${message}\n`);
}

/** Waits until `url` answers with ANY HTTP response — same "up means it responded at all" contract as wait-for-server.cjs. */
function waitForUrl(url, label) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    function attempt() {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', retry);
      req.setTimeout(2000, () => req.destroy());
    }
    function retry() {
      if (Date.now() >= deadline) {
        reject(new Error(`${label} did not come up within ${STARTUP_TIMEOUT_MS / 1000}s.`));
        return;
      }
      setTimeout(attempt, STARTUP_POLL_MS);
    }
    attempt();
  });
}

/** { msSinceLastHeartbeat: number|null, explicitlyClosed: boolean } from the backend, or null if the backend itself didn't respond (already gone/restarting). */
function getHeartbeatStatus() {
  return new Promise((resolve) => {
    const req = http.get(HEARTBEAT_STATUS_URL, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => req.destroy());
  });
}

/** Full process-tree kill — a plain child.kill() on Windows does not reliably take node's own subprocesses down with it. */
function killTree(pid, label) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    log(`${label} (pid ${pid}) stopped.`);
  } catch (err) {
    // Already gone is the common, harmless case (taskkill exits non-zero
    // when the pid no longer exists) — log it, never throw over cleanup.
    log(`${label} (pid ${pid}) stop attempt: ${err.message}`);
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function main() {
  log('Hidden launcher starting.');
  writeState({ launcherPid: process.pid, backendPid: null, frontendPid: null, startedAt });

  const tsxCli = path.join(BACKEND_DIR, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const viteBin = path.join(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

  // CLAUDE_CODE_PROMPT (hidden launcher, 2026-09-10) - real bug found and
  // fixed: without `detached: true`, a child spawned on Windows stays in
  // its parent's console process group, so a CTRL_CLOSE_EVENT on some
  // ancestor console (e.g. Start-AMC-Repair-Suite.bat's own window
  // auto-closing after its startup countdown) can cascade down and kill
  // it too - confirmed live: the backend died ~23s after a clean startup,
  // with zero error logged (a real crash logs a stack trace; this didn't,
  // which is itself the tell that something external killed it, not the
  // process itself). `.unref()` alongside `detached: true` is what
  // actually decouples it - detached alone still leaves this orchestrator
  // process's own event loop implicitly waiting on the child handle.
  const backend = spawn(process.execPath, [tsxCli, path.join(BACKEND_DIR, 'src', 'server.ts')], {
    cwd: BACKEND_DIR,
    stdio: ['ignore', openLog('backend.log'), openLog('backend.log')],
    windowsHide: true,
    detached: true,
  });
  backend.unref();
  log(`Backend spawned (pid ${backend.pid}).`);

  const frontend = spawn(process.execPath, [viteBin], {
    cwd: REPO_ROOT,
    stdio: ['ignore', openLog('frontend.log'), openLog('frontend.log')],
    windowsHide: true,
    detached: true,
  });
  frontend.unref();
  log(`Frontend spawned (pid ${frontend.pid}).`);
  writeState({ launcherPid: process.pid, backendPid: backend.pid, frontendPid: frontend.pid, startedAt });

  const shutdown = (reason) => {
    log(`Shutting down: ${reason}`);
    killTree(backend.pid, 'Backend');
    killTree(frontend.pid, 'Frontend');
    try {
      fs.unlinkSync(STATE_FILE);
    } catch {
      /* already gone — fine */
    }
    process.exit(0);
  };

  // CLAUDE_CODE_PROMPT (hidden launcher, 2026-09-10) — a child dying on its
  // own (a real crash, not us stopping it) brings the other one down too,
  // rather than leaving a half-running suite with no visible sign anything
  // went wrong (a dead backend with the frontend still serving a page that
  // just fails every request looks exactly like "it's fine, just slow").
  //
  // Guarded by shuttingDown: calling shutdown() below kills BOTH children,
  // which makes each of them fire this exact 'exit' handler again — without
  // the guard, the second child's own crash-triggered shutdown() would
  // re-enter and try to kill an already-dying process tree a second time.
  let shuttingDown = false;
  const shutdownOnce = (reason) => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdown(reason);
  };
  backend.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      log(`Backend exited unexpectedly (code ${code}).`);
      shutdownOnce(`backend crashed (code ${code})`);
    }
  });
  frontend.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      log(`Frontend exited unexpectedly (code ${code}).`);
      shutdownOnce(`frontend crashed (code ${code})`);
    }
  });

  // Best-effort only — see the STATE_FILE comment above for why
  // Stop-AMC-Repair-Suite.ps1 does NOT rely on this actually firing on
  // Windows. Still worth having for the cases where it does work (e.g. a
  // real POSIX environment, or a debugging Ctrl+C in an attached terminal).
  process.on('SIGTERM', () => shutdownOnce('SIGTERM received'));
  process.on('SIGINT', () => shutdownOnce('SIGINT received'));

  try {
    await waitForUrl(BACKEND_HEALTH_URL, 'Backend');
    log('Backend is up.');
    await waitForUrl(FRONTEND_URL, 'Frontend');
    log('Frontend is up.');
  } catch (err) {
    log(`Startup failed: ${err.message}`);
    shutdownOnce('startup failed');
    return;
  }

  spawn('cmd', ['/c', 'start', '', APP_URL], { windowsHide: true, detached: true }).unref();
  log(`Opened ${APP_URL} in the browser.`);

  // Shutdown-decision loop — the sole shutdown authority, see module
  // docstring. Three distinct signals, checked in order of how much they
  // should be trusted:
  //   1. explicitlyClosed — a real, browser-guaranteed "the tab actually
  //      closed" signal (heartbeat.ts's pagehide handler). Acted on
  //      immediately; this is the normal, expected way this fires.
  //   2. msSinceLastHeartbeat past HEARTBEAT_TIMEOUT_MS — an INFERRED
  //      signal (no ping received in a while), which real production logs
  //      proved unreliable at a short timeout (see that constant's own
  //      comment) — now purely a long safety net for the case where
  //      pagehide never fires at all (a crash, a forced kill).
  //   3. The heartbeat-status endpoint itself being unreachable — could be
  //      a genuinely dead backend, or could be one transient blip (the
  //      backend momentarily busy). Requires 3 CONSECUTIVE failures
  //      (~15s at the default poll interval) before acting, rather than
  //      the previous behavior of treating a single failed check as
  //      instant proof of anything — same "don't act on an inferred
  //      signal without persistence" reasoning as point 2.
  let consecutiveStatusFailures = 0;
  setInterval(async () => {
    if (Date.now() - startedAt < STARTUP_GRACE_MS) return;
    const status = await getHeartbeatStatus();

    if (status === null) {
      consecutiveStatusFailures += 1;
      if (consecutiveStatusFailures >= 3) {
        shutdownOnce(`could not reach heartbeat-status ${consecutiveStatusFailures} times in a row`);
      }
      return;
    }
    consecutiveStatusFailures = 0;

    if (status.explicitlyClosed === true) {
      shutdownOnce('frontend tab was closed');
      return;
    }
    const ms = status.msSinceLastHeartbeat;
    if (ms === null || ms > HEARTBEAT_TIMEOUT_MS) {
      shutdownOnce(ms === null ? 'no heartbeat ever reached the backend' : `no heartbeat for ${ms}ms (fallback safety net)`);
    }
  }, HEARTBEAT_POLL_MS);
}

main().catch((err) => {
  log(`Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
