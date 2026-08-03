import type { Page } from 'playwright';

const CLICK_DELAY_MS = 750;
const GRID_WAIT_TIMEOUT_MS = 30_000;
const GRID_WAIT_POLL_MS = 250;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Moved here from aeroRepair/selectors.ts per
 * VENDOR_MODULE_REFACTOR_SPEC.md section 3.4 — confirmed identical
 * mechanics across Aero Repair's and 0T1Y4's real recordings (the warranty
 * recording just never calls selectAuthFlow, leaving the dropdown at its
 * resting default — see resolveAuthFlowPolicy in vendorConfig.ts for how a
 * vendor's config expresses that). Pure relocation, no behavior change —
 * EXCEPT for the wait added to selectAuthFlow below, a real, separately
 * found and fixed bug, not a refactor side effect (see its own docstring).
 */

/** `Request Authorization` link on the newly-created RO's page. */
export async function clickRequestAuthorization(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Request Authorization' }).click();
  await pace(page);
}

/**
 * REAL BUG FOUND AND FIXED, discovered live against production during the
 * 0T1Y4 global-dropdown-label confirmation diagnostic (not caused by the
 * refactor — this function's logic is unchanged from before the move, only
 * its location changed): reading `#idDropdownAuthFlows` immediately after
 * clickRequestAuthorization's fixed 750ms pace found ZERO `<option>`
 * elements, and the subsequent `.selectOption()` call timed out 30s later
 * waiting for that same locator — the exact same "fixed pace with no
 * content-aware wait" vulnerability class already found and fixed six other
 * times in this codebase (grid rows, vendor bids, task-definition
 * candidates, generated order number, work-package-details, unassigned-
 * tasks section) had never been applied here. It simply hadn't manifested
 * before by luck of timing — every real Aero Repair auth-flow request to
 * date (including this session's own stage smoke test minutes earlier)
 * happened to have enough surrounding latency for the dropdown to already
 * be rendered.
 *
 * Real consequence when it does fire: a genuine order (`P000BCSA`, this
 * session) gets created in production, "Request Authorization" is clicked,
 * and the whole write-up attempt then throws before ever selecting an Auth
 * Flow or confirming the request — the order is left sitting real,
 * OPEN/PENDING, unauthorized, until a human notices it. Already contained
 * by runAeroRepairWriteUp's own outer try/catch (surfaces as a normal
 * 'error' outcome, doesn't crash the batch) but still a real, avoidable gap.
 *
 * Fixed the same way as every other instance: wait for a DEFINITIVE end
 * state (at least one real `<option>` rendered) before selecting, instead
 * of trusting the fixed pace() alone.
 */
export async function selectAuthFlow(page: Page, label: string): Promise<void> {
  const start = Date.now();
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#idDropdownAuthFlows option').length > 0,
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
  } catch (err) {
    throw new Error(
      `Auth Flow dropdown did not resolve to a definitive state (no #idDropdownAuthFlows option elements ` +
        `rendered) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to select blindly. Underlying error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  console.log(`[grid-wait] auth-flow dropdown resolved in ${Date.now() - start}ms`);

  await page.locator('#idDropdownAuthFlows').selectOption({ label });
  await pace(page);
}

/**
 * Real, from discovery-noprice-recording.ts (a real stage recording): for
 * SOME vendors, confirming the authorization request can surface a
 * DIFFERENT "Confirm" interstitial page — "[MXERR-30583] ... total amount
 * 0.00 USD is less than '<vendor>' vendor minimum purchase amount ... Do
 * you want to continue?" with YES/NO. Per explicit user confirmation, this
 * is a real, expected, irrelevant business condition (the order's total
 * amount hasn't been priced yet at this point in the flow) — click YES to
 * proceed, never NO.
 *
 * Deliberately NOT gated by vendor code: the dialog is driven by real
 * order-amount-vs-vendor-minimum data, not by which vendor is running, so
 * a vendor-code flag could be both wrong (a vendor not on the flagged list
 * could still show it under the right data conditions) and incomplete.
 * Detects it generically via the confirmed real message text and clicks
 * YES only when it's actually present — a no-op read for every vendor/
 * order that never shows it (confirmed: Aero Repair's own real order
 * history has never triggered this, so this addition is zero-risk there).
 */
async function handleMinimumPurchaseAmountConfirmation(page: Page): Promise<void> {
  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('vendor minimum purchase amount')) {
    console.log('[auth-flow] Minimum purchase amount confirmation dialog detected — clicking YES (confirmed irrelevant, per explicit user direction).');
    await page.getByRole('link', { name: 'YES' }).click();
    await pace(page);
  }
}

/**
 * The "OK" that submits the authorization request itself — deliberately
 * NOT the "Issue Order" step that follows it. Followed by a check for the
 * minimum-purchase-amount confirmation dialog (see
 * handleMinimumPurchaseAmountConfirmation) — real, from
 * discovery-noprice-recording.ts, not invented.
 */
export async function confirmAuthorizationRequest(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);
  await handleMinimumPurchaseAmountConfirmation(page);
}

export { resolveAuthFlowPolicy } from './vendorConfig.js';
export type { AuthFlowOverride, AuthFlowPolicy, ResolvedAuthFlowPolicy } from './vendorConfig.js';
