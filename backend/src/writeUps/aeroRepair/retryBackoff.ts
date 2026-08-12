import type { Page } from 'playwright';

/**
 * Real cause confirmed via captured evidence, not assumed: the empty
 * reads this backs off from correlate with SUSTAINED continuous
 * automated volume, not a structural DOM problem or a per-request coin
 * flip. Direct evidence from a real production run (2026-07-27): every
 * failing read's own on-empty capture (screenshot + DOM text) showed a
 * perfectly-rendered grid — often with the exact target line visibly
 * present — proving the underlying data/render eventually completes
 * correctly; no throttle banner, no rate-limit message, and no
 * session-expired redirect appeared in any capture checked, including
 * ones taken deep inside the worst failure stretch. Failures clustered
 * densely (60+ consecutive captures, ~7s apart, over ~7.5 minutes)
 * immediately after 8 consecutive fully-successful write-up->issue->dock
 * cycles (confirmed via `write_up_actions`/`write_up_issue_decisions`
 * timestamps) — onset correlates with sustained prior volume, not with
 * failing from the very first request. `MxiClient` runs the whole batch
 * on one persistent, long-lived browser page (`mxiClient.ts`), consistent
 * with rendering/responsiveness degrading over a long continuous session
 * rather than being wrong from the start.
 *
 * The retries these paths already had fired back-to-back with ZERO delay
 * between attempts — hitting the same degraded window three times in a
 * row gives the underlying slowdown no chance to clear, plausibly making
 * it worse, not better. This adds a real, increasing pause BETWEEN
 * attempts (not before the first) so a retry actually has a chance of
 * landing in a recovered state.
 *
 * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 2 — escalated from the
 * original 3s/6s schedule to 5s/15s/30s, tuned above the observed
 * business-hours latency spike (confirmed real: the failing 53-order run
 * was 9:10-10:20 AM ET) and sized larger for the large-result-set class of
 * part number (`90001200-1`-class) that this project has repeatedly found
 * needs the most real time to fully render.
 */
const RETRY_BACKOFF_SCHEDULE_MS = [5000, 15000, 30000];

export async function waitBeforeRetry(page: Page, attemptJustFailed: number): Promise<void> {
  const delayMs = RETRY_BACKOFF_SCHEDULE_MS[attemptJustFailed - 1] ?? RETRY_BACKOFF_SCHEDULE_MS[RETRY_BACKOFF_SCHEDULE_MS.length - 1];
  await page.waitForTimeout(delayMs);
}

/**
 * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3, requirement 4 — REAL GAP
 * FOUND: `runAeroRepairWriteUp`'s own catch-all (writeUp.ts) previously
 * swallowed EVERY thrown error, including a genuine MXI session/login
 * loss, into a per-line `{status: 'error'}` outcome — contradicting this
 * module's own documented intent (see aeroRepairBatchExecuteCli.ts's
 * docstring: "Session/login loss is the one exception that halts entirely
 * ... same standing rule as the ESD writer's mxiClient halt-on-session-loss
 * behavior") and the already-correct precedent in
 * vendorCodeBatchDiscoveryCli.ts, which explicitly re-throws on these same
 * message substrings rather than treating session death as a per-line
 * failure. Matched against mxiClient.ts's own real thrown messages
 * (`MXI session not established: ...`, `MXI session lost and
 * re-authentication failed (...)`, `Session still not valid after
 * re-authentication attempt.`) — not guessed.
 */
export function isSessionLossError(message: string): boolean {
  return (
    message.includes('MXI session not established') ||
    message.includes('MXI session lost') ||
    message.includes('Session still not valid') ||
    message.includes('Re-authentication failed')
  );
}
