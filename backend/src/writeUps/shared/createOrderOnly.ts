import type { Page } from 'playwright';
import { navigateToOrderByNumber } from './issueAndDock.js';
import { openGeneratedOrder } from './scheduleWorkPackageForm.js';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — shared across
 * every vendor (Aero Repair included), per explicit confirmed scope: "one
 * of the few behaviors that applies to Aero Repair rather than excluding
 * it." Real, from discovery-onlyCreateOrder-recording.ts.
 */

const DO_NOT_SHIP_PREFIX = 'DO NOT SHIP';

/**
 * The one and only qualifying condition for now (confirmed scope,
 * 2026-08-07). Used both to compose the note AND wherever this condition
 * gets logged/recorded — a single source of truth so the note and the
 * audit reason can never drift apart, per explicit instruction.
 */
export const ZERO_USAGE_DO_NOT_SHIP_REASON = 'ZERO TIMES AND CYCLES';

/**
 * `aPOExternalReference` is a single-line INPUT, not a textarea (confirmed
 * live) — collapses any embedded newlines to a single space rather than
 * silently truncating or letting Playwright's .fill() choke on them.
 */
export function composeDoNotShipNote(reason: string): string {
  const singleLineReason = reason.replace(/\s*\n+\s*/g, ' ').trim();
  return `${DO_NOT_SHIP_PREFIX} ${singleLineReason}`;
}

/**
 * The CREATE_ORDER_ONLY terminal sequence, real from the recording: click
 * into the just-generated order, Details tab, Edit PO Details, fill the
 * External Reference field with the composed note, OK, Close. Terminates
 * here — no Request Authorization, no Issue Order, no Move to Dock is
 * called by this function or anything after it in either caller; the
 * structural guarantee comes from each caller's own early-return dispatch,
 * not from this function refusing to chain further (see
 * runAeroRepairWriteUp / runVendorCodeWriteUp for where that guard lives).
 */
export async function completeCreateOrderOnly(page: Page, orderNumber: string, note: string): Promise<void> {
  await openGeneratedOrder(page, orderNumber);
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await pace(page);
  await page.locator('#idButtonEditPODetails').click();
  await pace(page);
  await page.locator('input[name="aPOExternalReference"]').click();
  await pace(page);
  await page.locator('input[name="aPOExternalReference"]').fill(note);
  await pace(page);
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

export interface ExternalReferenceVerification {
  committed: boolean;
  realValue: string | null;
}

/**
 * Independent re-verification (standing discipline #3) — navigates via a
 * SEPARATE path (the order-number search box, same mechanism
 * readOrderRealState already uses for exactly this reason) rather than
 * trusting the write's own click sequence. GUESSED: the recording never
 * shows a plain read-only display of this field outside "Edit PO
 * Details" — only the edit-mode input. This re-enters edit mode on a
 * fresh navigation (a genuinely independent read, not reusing the
 * original write's own page state) and reads the input's real committed
 * value directly, then leaves without saving again. Flagged for
 * confirmation if a plain, non-edit display of this field turns out to
 * exist and would be a cleaner read path.
 */
export async function verifyExternalReferenceCommitted(
  page: Page,
  orderNumber: string,
  todoListUrl: string,
  expectedNote: string,
): Promise<ExternalReferenceVerification> {
  await navigateToOrderByNumber(page, orderNumber, todoListUrl);
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await pace(page);
  await page.locator('#idButtonEditPODetails').click();
  await pace(page);
  const realValue = await page.locator('input[name="aPOExternalReference"]').inputValue();
  // Leave the edit view without re-submitting a second write — OK here
  // just re-confirms the SAME already-committed value, never a new one.
  await page.getByRole('link', { name: 'OK', exact: true }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
  return { committed: realValue.trim() === expectedNote, realValue };
}

/** Confirms the order is in the expected pre-authorization state: created, not authorized, not issued, not docked. */
export function isPreAuthorizationState(orderStatus: string | null, authorizationStatus: string | null): boolean {
  return orderStatus === 'OPEN' && (authorizationStatus === null || authorizationStatus === 'PENDING');
}
