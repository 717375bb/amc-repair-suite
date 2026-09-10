/**
 * CLAUDE_CODE_PROMPT (hidden launcher, 2026-09-10) — per explicit user
 * direction: closing the browser tab should be what stops the backend and
 * frontend, once their console windows are hidden and no longer offer a
 * window to close. This is the frontend half of that: as long as this tab
 * is open (loaded, not necessarily focused — a minimized/background tab
 * still counts), it pings the backend on an interval.
 * `scripts/run-suite-hidden.cjs` (a separate orchestrator process) polls
 * how long it's been since the last ping and decides when to actually stop
 * anything — this module makes no shutdown decision itself, it just tells
 * the truth about whether a tab is still open.
 *
 * Started once, unconditionally, from main.tsx — before login, not inside
 * any authenticated route — so the server doesn't shut itself out from
 * under someone sitting on the login page.
 *
 * `setInterval` continues running (throttled, but non-zero) in a
 * backgrounded/minimized tab in every modern browser, which is exactly the
 * behavior wanted here: only an actual tab CLOSE (or navigating away from
 * the app entirely) should ever let the heartbeat lapse. No cleanup/
 * clearInterval call exists here on purpose — there is nothing that should
 * ever stop this once the page has loaded, short of the page itself going
 * away, which stops it for free.
 */
const HEARTBEAT_INTERVAL_MS = 5_000

export function startHeartbeat(): void {
  const ping = () => {
    fetch('/api/heartbeat', { method: 'POST' }).catch(() => {
      // The backend being briefly unreachable (a cold start, a network
      // blip) is not this module's problem to solve — the orchestrator's
      // own grace period already tolerates a real gap. Never surface this
      // as a user-facing error.
    })
  }
  ping()
  setInterval(ping, HEARTBEAT_INTERVAL_MS)
}
