/**
 * Waits until a local server actually answers, then exits 0.
 *
 * Usage:  node scripts/wait-for-server.cjs <url> <friendly name> [timeoutSeconds]
 *
 * WHY THIS EXISTS (2026-09-04). Start-AMC-Repair-Suite.bat launched the
 * backend and the frontend at the same moment, waited a flat 6 seconds, and
 * opened the browser. On a cold start the backend routinely takes longer
 * than that — it opens two SQLite databases and initialises a Playwright
 * client before it listens — so the app frequently loaded against a backend
 * that was not up yet. The visible symptom is a UI that appears to work but
 * fails its first requests, which reads as "the app is broken" rather than
 * "it started too early".
 *
 * Polling the real endpoint replaces a guess about how long startup takes
 * with the actual answer. `GET /health` is deliberately unauthenticated for
 * exactly this kind of check (see security.md §2).
 *
 * Plain CommonJS with no dependencies, matching prepare-local-env.cjs — this
 * runs before `npm install` has necessarily finished anything.
 */

const http = require('node:http');

const url = process.argv[2];
const name = process.argv[3] || url;
const timeoutSeconds = Number(process.argv[4] || 90);

if (!url) {
  console.error('usage: node scripts/wait-for-server.cjs <url> <name> [timeoutSeconds]');
  process.exit(2);
}

const POLL_MS = 500;
const deadline = Date.now() + timeoutSeconds * 1000;
let lastReason = 'not started yet';
let announced = false;

function attempt() {
  const request = http.get(url, (res) => {
    // ANY HTTP response means the server is listening and serving. A 401 or
    // 404 still proves it is up, which is the only question being asked
    // here — this must not become a health assertion it was never meant to
    // make.
    res.resume();
    process.stdout.write('\n');
    console.log(`${name} is up (HTTP ${res.statusCode}).`);
    process.exit(0);
  });

  request.on('error', (err) => {
    lastReason = err.code || err.message;
    retry();
  });
  request.setTimeout(2000, () => {
    lastReason = 'no response within 2s';
    request.destroy();
    // 'error' fires after destroy(), which calls retry() — don't double-retry.
  });
}

function retry() {
  if (Date.now() >= deadline) {
    process.stdout.write('\n');
    console.error(
      `${name} did not come up within ${timeoutSeconds}s (last: ${lastReason}).\n` +
        `Its own window is still open — look there for the real error.`,
    );
    // Exit 1 so the launcher can say something useful rather than opening a
    // browser onto a server that is not there.
    process.exit(1);
  }
  if (!announced) {
    process.stdout.write(`Waiting for ${name}`);
    announced = true;
  }
  process.stdout.write('.');
  setTimeout(attempt, POLL_MS);
}

attempt();
