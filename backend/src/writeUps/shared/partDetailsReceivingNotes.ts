import type { Page } from 'playwright';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * CLAUDE_CODE_PROMPT (#1, new vendors) — the part-level "Details" view, real
 * from discovery-76863-AJS-sn-recording.ts. Distinct from TWO other,
 * differently-scoped things that share the same "Details" label elsewhere
 * in this codebase — never conflate:
 *   - shared/createOrderOnly.ts's Details step is on the GENERATED ORDER
 *     page (Edit PO Details -> aPOExternalReference) — a completely
 *     different page reached after Schedule Work Package, not this one.
 *   - shared/partOwnDetails.ts's "part own details" view is reached by
 *     clicking the line's own identifier (serial/BN) link and shows the
 *     Usage Parm table — a different page again, reached earlier in the
 *     same flow, immediately before this one.
 * This view is reached from the GRID ROW via its part-number cell (not the
 * identifier link) and shows a receiving-notes box that may carry a special
 * charge-to-account code (the recording's own real example: "COVERED UNDER
 * ROCKWELL..."). Real per-vendor sequence, confirmed from the recording:
 * openPartOwnDetails -> closePartOwnDetails -> click the PN cell -> this
 * module's open/read/close -> THEN recheck the row's radio/checkbox ->
 * Schedule Work Package (recheck happens AFTER this step, not before).
 *
 * Dormant for this batch: no vendor's charge-to-account decision reads the
 * returned value yet (that's Aerotron 2N512's rule, deferred) — only
 * VendorConfig.hasPartDetailsStep-flagged vendors (76863, 1DH10) even run
 * this at all; every other vendor's real behavior is unchanged.
 */
export async function openPartDetailsReceivingNotes(page: Page, linkText: string, partNumber: string): Promise<void> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  await targetTr.getByRole('cell', { name: partNumber, exact: true }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await pace(page);
}

//const RECEIVING_NOTES_SELECTOR = '#idContentRow_IdGrpReceivingNotes > td';

/** Null if the box genuinely isn't present on this part's Details view — never guessed/fabricated. */
export async function readPartDetailsReceivingNotes(page: Page): Promise<string | null> {
  return (await page.locator('#idCellPartNote').innerText()).trim();
  //const locator = page.locator(RECEIVING_NOTES_SELECTOR);
  //if ((await locator.count()) === 0) return null;
  //return (await locator.first().innerText()).trim();
}

/** Real from the recording: a single "OK" (not "Close") dismisses this specific view. */
export async function closePartDetailsReceivingNotes(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
}
