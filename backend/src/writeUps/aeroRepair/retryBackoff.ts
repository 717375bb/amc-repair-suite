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
 */
export async function waitBeforeRetry(page: Page, attemptJustFailed: number): Promise<void> {
  const delayMs = attemptJustFailed * 3000; // 3s after attempt 1 fails, 6s after attempt 2, ...
  await page.waitForTimeout(delayMs);
}
