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
 * CLAUDE_CODE_PROMPT (real production incident, 2026-09-10, same day) —
 * REAL BUG FOUND AND FIXED: this used to rely SOLELY on the absence of a
 * ping to infer "the tab closed," with the orchestrator's own timeout set
 * to 30 seconds. That inference is wrong: the original comment's claim
 * that a backgrounded tab's `setInterval` keeps firing "throttled, but
 * non-zero" is true, but understated the effect — modern browsers throttle
 * a backgrounded tab's timers hard enough that a 5-second interval can
 * silently slip past 30+ seconds between actual callbacks, with NO signal
 * that anything is wrong. Confirmed against real logs from this exact
 * machine: three separate production runs were killed this way
 * (logs/launcher.log: "no heartbeat for 34529ms" / "32678ms" / "34944ms"
 * — all just past the old 30s threshold), and logs/backend.log shows an
 * active ESD-write batch (real MXI orders, one every ~18s) running right
 * up to the same timestamp as the last of those three kills. The analyst
 * had not closed anything — the tab was simply backgrounded while a long
 * run executed, which is the whole point of automating it.
 *
 * Fixed with an EXPLICIT signal instead of an inferred one: `pagehide`
 * fires reliably when a tab is actually closed or navigated away from,
 * but does NOT fire merely from being backgrounded/minimized/switched
 * away from — exactly the distinction that was missing. `sendBeacon` is
 * built specifically to survive page teardown (a plain fetch() started
 * during unload is not reliably delivered). The interval ping keeps
 * running as before, now purely as a safety net for the abnormal case
 * where the tab is killed without ever unloading normally (a crash, a
 * forced process kill, the machine losing power) — see
 * run-suite-hidden.cjs for how that fallback's own timeout was widened to
 * match (it no longer needs to be tight, since it's not the primary
 * signal anymore).
 */
const HEARTBEAT_INTERVAL_MS = 5_000

function ping(): void {
  fetch('/api/heartbeat', { method: 'POST' }).catch(() => {
    // The backend being briefly unreachable (a cold start, a network
    // blip) is not this module's problem to solve — the orchestrator's
    // own grace period already tolerates a real gap. Never surface this
    // as a user-facing error.
  })
}

export function startHeartbeat(): void {
  ping()
  setInterval(ping, HEARTBEAT_INTERVAL_MS)

  // Fires on an actual tab close or navigation away — NOT on the tab
  // merely losing focus or being backgrounded (that's `visibilitychange`,
  // deliberately not used here, since it fires far too often to mean
  // "the tab is gone"). sendBeacon (not fetch) is required here: a fetch
  // call started inside a pagehide handler is not guaranteed to complete
  // once the page starts unloading, while sendBeacon is specifically
  // designed by browser vendors to survive it.
  window.addEventListener('pagehide', () => {
    navigator.sendBeacon('/api/heartbeat-closed')
  })
}
