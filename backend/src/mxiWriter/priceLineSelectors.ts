import type { Page } from 'playwright';
import { enterPasswordIfPrompted } from './scrapFlowHelpers.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('mxi');

/**
 * Invoice Price Writer — new selectors, built from two real
 * `npx playwright codegen` recordings against production MXI
 * (`backend/discovery-invoice-write-recording.ts`,
 * `backend/discovery-invoice-recording.ts`), cross-checked against each
 * other to separate real required steps from exploratory recording noise
 * (confirmed directly with the user, not assumed):
 * - Recording #1's `Alt+9` before filling the price, and both recordings'
 *   several extra clicks on the price field before the real `.fill()`, are
 *   recording noise — recording #2 (the more complete one) fills directly
 *   with plain `.fill()`, no keyboard tricks, matching this project's own
 *   proven-safe pattern for masked fields (see updateEsdField's docstring
 *   for the original corruption incident that established `.fill()` as the
 *   right approach over simulated keystrokes).
 * - The "Cancel" link click and the trailing Password-field click after
 *   the final "OK" button in recording #2 are confirmed-with-the-user as
 *   incidental/exploratory, not real required steps.
 *
 * Reuses findOrderByNumber / updateEsdField / confirmEsdLineEdit /
 * reissueOrder from selectors.ts unchanged — this file only adds what
 * those don't already do: the Unit Price / Price Type fields, the serial
 * number cross-check, and the mid-flow re-authorization dialog.
 */

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Confirmed live (read-only diagnostic against a real production order,
 * P000BB8K): the line description on the Edit Lines page reads e.g.
 * "Repair VALVE SHUT-OFF CARGO (PN: VP0615E00, SN: L106604297) [...]" — the
 * exact "(PN: X, SN: Y)" pattern writeUps/shared/partOwnDetails.ts already
 * parses elsewhere in this codebase. Reads from Edit Lines' own body text
 * — no extra navigation needed, this is called right after
 * findOrderByNumber() has already landed there.
 */
export async function readLineSerialNumber(page: Page): Promise<string | null> {
  const bodyText = await page.locator('body').innerText();
  const match = bodyText.match(/\(PN:\s*[^,]+,\s*SN:\s*([^)]+)\)/);
  return match ? match[1].trim() : null;
}

/**
 * Reads the current Unit Price value. Prefix-matched + .first(), same
 * robustness convention as selectors.ts's aPromiseBy_ field (real line
 * index varies; this project's own established limitation is "only the
 * first matching line," not hardcoding index 1).
 */
export async function readUnitPrice(page: Page): Promise<string | null> {
  const field = page.locator('input[id^="idUnitPrice_"]').first();
  const value = await field.inputValue();
  return value.trim().length > 0 ? value : null;
}

/**
 * Confirmed from a real recording: plain .fill() on the Unit Price field
 * works directly, no clear-then-type sequence needed (unlike the
 * click->Backspace->type sequence that corrupted the ESD field early in
 * this project — .fill() is what fixed that, and recording #2 confirms the
 * same direct-fill approach works here too).
 */
export async function updateUnitPrice(page: Page, newPrice: string): Promise<void> {
  const field = page.locator('input[id^="idUnitPrice_"]').first();
  await field.fill(newPrice);
}

/** Confirmed always 'QUOTE' for this flow, per explicit user direction — not per-row logic. */
export async function updatePriceType(page: Page, priceType: string = 'QUOTE'): Promise<void> {
  const field = page.locator('select[id^="idPriceType_"]').first();
  await field.selectOption(priceType);
}

/**
 * Real, detectable page state (confirmed live: RO Details shows an
 * explicit "Authorization Status: ..." field) — not a guessed business
 * rule for when authorization is/isn't needed. A pure read, no click.
 */
export async function isReauthorizationNeeded(page: Page): Promise<boolean> {
  return (await page.getByRole('link', { name: 'Request Authorization' }).count()) > 0;
}

/**
 * The mid-flow credential re-entry dialog, confirmed from a real
 * recording (discovery-invoice-recording.ts): username is auto-filled (no
 * action needed), only the Password field
 * (getByRole('textbox', { name: 'Password:' })) needs filling. Uses the
 * same per-user MXI credential already threaded into this process's env
 * by mxiCredentialEnvOverrides() — never a new credential-entry UI.
 */
export async function performReauthorization(page: Page, password: string): Promise<void> {
  await page.getByRole('link', { name: 'Request Authorization' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);

  // REAL FAILURE FIXED (2026-08-28): this filled the password
  // UNCONDITIONALLY, so when MXI did not prompt for it the run sat for 30s
  // on `locator.fill: Timeout ... waiting for getByRole('textbox', { name:
  // 'Password:' })` and failed the quote (order P000BEJY, 15:46).
  //
  // The prompt is intermittent — that is already known and already handled
  // everywhere else in this codebase by enterPasswordIfPrompted, which the
  // scrap flow has used from the start. This path simply never adopted it.
  // It also clicks the confirming OK itself, so the unconditional click
  // below went too.
  const prompted = await enterPasswordIfPrompted(page, password);
  if (!prompted) {
    log.info({}, '[price] no password prompt appeared during reauthorization — continuing');
  }
  await pace(page);
}

/**
 * How many distinct order lines Edit Lines shows for this order — used to
 * detect the multi-line case (skip + flag rather than guess which line to
 * touch, per this project's existing "only first matching line" limitation
 * elsewhere). Counts Unit Price inputs, since exactly one exists per line.
 */
export async function countOrderLines(page: Page): Promise<number> {
  return page.locator('input[id^="idUnitPrice_"]').count();
}

/**
 * The "Issue Order" step, made tolerant of the order already being
 * authorized.
 *
 * REAL CASE, per explicit user direction (2026-08-21): an order that is
 * already authorized shows NO "Request Authorization" action, but the Issue
 * control is still present and still has to be clicked — and that run
 * should count as a success.
 *
 * The previous code always called selectors.ts's reissueOrder(), which
 * clicks a hard-coded 'Issue Order' link and THROWS on a timeout if it
 * isn't found. That turned an otherwise-perfectly-good write (price and ESD
 * both committed) into a reported failure. This version never throws for a
 * missing control: it reports what it actually found, and lets the caller
 * judge against the real order state instead.
 *
 * 'Issue Order' is the only label ever confirmed against real MXI in this
 * project, so it is tried first and exactly. Rather than GUESS at
 * alternatives — which this project's discipline forbids — an unmatched
 * case enumerates every link whose name starts with "Issue" and returns
 * them as evidence, so the first real occurrence tells us the true label
 * instead of failing blind.
 */
export interface IssueControlResult {
  clicked: boolean;
  /** The label actually clicked, or null when nothing was. */
  label: string | null;
  /** Every "Issue*" link present when the expected one wasn't matched — real evidence, not a guess. */
  candidates: string[];
}

export async function clickIssueOrderTolerant(page: Page): Promise<IssueControlResult> {
  const exact = page.getByRole('link', { name: 'Issue Order' });
  if ((await exact.count()) > 0) {
    await exact.first().click();
    await pace(page);
    await confirmIssueDialogIfPresent(page);
    return { clicked: true, label: 'Issue Order', candidates: [] };
  }

  // Not the confirmed label. Collect what IS there before deciding.
  const candidates = (await page.getByRole('link').allInnerTexts())
    .map((t) => t.replace(/\s+/g, ' ').trim())
    .filter((t) => /^issue\b/i.test(t));

  const unique = [...new Set(candidates)];
  if (unique.length === 1) {
    await page.getByRole('link', { name: unique[0] }).first().click();
    await pace(page);
    await confirmIssueDialogIfPresent(page);
    return { clicked: true, label: unique[0], candidates: unique };
  }

  // Zero candidates (already issued, or the action genuinely isn't
  // offered), or several (ambiguous — never guess which one issues a real
  // order). Report rather than act.
  return { clicked: false, label: null, candidates: unique };
}

/**
 * The confirmation that follows Issue Order. Best-effort with a short
 * timeout: it does not always appear, and blocking the full default
 * timeout on an absent dialog would stall every order in a batch.
 */
async function confirmIssueDialogIfPresent(page: Page): Promise<void> {
  const ok = page.getByRole('link', { name: 'OK', exact: true });
  try {
    await ok.first().waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    return; // no confirmation shown — nothing to click
  }
  await ok.first().click();
  await pace(page);
}
