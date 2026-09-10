import type { Page } from 'playwright';
import { clickActionLink } from '../writeUps/shared/clickActionLink.js';
import type { MxiClient } from './mxiClient.js';
import { navigateToOrder } from './selectors.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('mxi');

const CLICK_DELAY_MS = 750;
async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * CLAUDE_CODE_PROMPT (AWB -> Inbound shipment, 2026-09-09) — per explicit
 * user direction: "If it finds an AWB in report, add it to the Inbound...
 * according to discovery-awb-inbound-recording.ts."
 *
 * **UNVERIFIED AGAINST REAL MXI — this entire module has never been run
 * live.** Every other write path in this codebase (ESD field, Notes to
 * Receiver, Invoice Price Writer's price/reauthorization fields) required
 * at least one real, watched smoke test before being trusted — several
 * caught real corruption/reliability bugs that reading the recording alone
 * never would have (see CLAUDE.md's Phase 2c section, PHASE2_MXI_WRITER_SPEC.md).
 * This module should get the exact same treatment before it is ever wired
 * into an unattended/batch path: run `npm run mxi:write-inbound-awb`
 * (mxiWriteInboundAwb.ts) once, watched, against a known stage order with a
 * real inbound shipment, and independently re-verify in a plain browser.
 *
 * What the recording (`backend/discovery-awb-inbound-recording.ts`,
 * gitignored, never committed) actually shows, read literally rather than
 * assumed:
 * 1. Search an order number via the ToDoList barcode box.
 * 2. Click "Receipt & Returns".
 * 3. Click a specific shipment record (e.g. "SRRR7001M24H").
 * 4. Click "Edit Shipment".
 * 5. Click the Waybill Number field (`input[name="aWaybillNumber"]`), fill
 *    it, then three Ctrl+ArrowDown presses.
 * 6. Click OK.
 *
 * Two corrections applied versus the literal recording, both following this
 * project's own established precedent rather than guessing fresh:
 * - **No "reauthorize" step exists anywhere in the recording** — no
 *   Request Authorization link, no Auth Flow dropdown. The user was shown
 *   this discrepancy directly and confirmed: do exactly what the recording
 *   shows, nothing more. This module never touches authorization.
 * - **The search sequence's "type P000, Ctrl+B, overwrite with the real
 *   value" and the post-fill "Ctrl+ArrowDown x3" are treated as recording
 *   noise, not required steps** — the same judgment this codebase already
 *   made for the ESD field's own recording (`selectors.ts`'s
 *   `navigateToOrder`/`updateEsdField` docstrings) and for the Invoice
 *   Price Writer's "Alt+9 and extra clicks" (see
 *   INVOICE_PRICE_WRITER_HANDOFF.md). `navigateToOrder()` (already proven
 *   correct via `.fill()` + Enter) is reused for the search, and
 *   `.fill()` is used for the Waybill Number field for the exact reason
 *   the ESD field's own corruption incident established: `.fill()` sets
 *   the value via a direct DOM event, unlike simulated keystrokes, which a
 *   masked/validated field can silently reject past the first character.
 *
 * The INBOUND shipment (the one bringing the part back FROM the vendor) is
 * identified as the mirror image of `shared/issueAndDock.ts`'s own,
 * real-recording-confirmed OUTBOUND-shipment finder: that one matches
 * "Ship From: <STATION>/DOCK"; this one matches "Ship To: <STATION>/DOCK"
 * instead (same field, opposite direction). This mirroring is a reasonable
 * inference from a proven mechanism, not independently confirmed against a
 * real page showing both shipments side by side — flagged here rather than
 * presented as equally proven.
 */

const SHIPMENT_ID_PATTERN = /^SRRR\d+/;
const WAYBILL_FIELD_SELECTOR = 'input[name="aWaybillNumber"]';

/**
 * Read-only. Navigates to the order's Receipt & Returns tab and finds the
 * INBOUND shipment (Ship To ending in "/DOCK"), leaving the page sitting on
 * that shipment's own detail view when found. Returns null (not a throw) if
 * no inbound shipment exists — a real, expected state for an order that
 * hasn't shipped back yet, not a failure.
 */
export async function findInboundShipmentId(page: Page, todoListUrl: string, orderNumber: string): Promise<string | null> {
  await navigateToOrder(page, orderNumber, todoListUrl);
  await clickActionLink(page, 'Receipt & Returns', { label: 'Receipt & Returns' });
  await pace(page);

  let shipmentIds: string[] = [];
  try {
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll('a')).some((a) => /^SRRR\d+/.test((a.textContent ?? '').trim())),
      undefined,
      { timeout: 15_000, polling: 250 },
    );
    shipmentIds = await page.getByRole('link', { name: SHIPMENT_ID_PATTERN }).allInnerTexts();
  } catch {
    // Genuinely no shipment records on this order yet — handled below.
  }

  for (const shipmentId of shipmentIds) {
    await navigateToOrder(page, orderNumber, todoListUrl);
    await clickActionLink(page, 'Receipt & Returns', { label: 'Receipt & Returns' });
    await pace(page);
    await clickActionLink(page, shipmentId, { exact: true, label: shipmentId });
    await pace(page);

    const bodyText = await page.locator('body').innerText();
    const shipToMatch = bodyText.match(/Ship To:\s*([^\t\n]+)/);
    if (shipToMatch && shipToMatch[1].trim().toUpperCase().endsWith('/DOCK')) {
      return shipmentId;
    }
  }

  log.info({ orderNumber, shipmentIdsSeen: shipmentIds }, '[awb-inbound] no inbound shipment (Ship To .../DOCK) found for this order');
  return null;
}

/**
 * Must be called with the page already sitting on the target shipment's own
 * detail view (i.e. right after findInboundShipmentId() returns non-null).
 * Enters "Edit Shipment", reads the current Waybill Number value via the
 * DOM directly (no separate navigation — there is no confirmed
 * cancel/exit control for this dialog, same gap already documented for the
 * ESD field's own edit view, so a read-only detour in and back out isn't
 * safe to assume exists).
 */
export async function readWaybillNumberInEditMode(page: Page): Promise<string> {
  await clickActionLink(page, 'Edit Shipment', { label: 'Edit Shipment' });
  await pace(page);
  const field = page.locator(WAYBILL_FIELD_SELECTOR);
  await field.waitFor({ state: 'visible', timeout: 15_000 });
  return (await field.inputValue()).trim();
}

/**
 * Must be called immediately after readWaybillNumberInEditMode() (same Edit
 * Shipment session — the field is already visible). Uses `.fill()`, never
 * click+backspace+type — see this module's own docstring for why.
 */
export async function fillWaybillNumberAndConfirm(page: Page, awb: string): Promise<void> {
  const field = page.locator(WAYBILL_FIELD_SELECTOR);
  await field.fill(awb);
  await pace(page);
  await clickActionLink(page, 'OK', { exact: true, label: 'OK (confirm Edit Shipment)' });
  await pace(page);
}

export interface WriteInboundAwbResult {
  status: 'success' | 'failed' | 'skipped' | 'no_inbound_shipment_found';
  shipmentId: string | null;
  errorMessage: string | null;
}

/**
 * Orchestrator, mirroring writeEsdAndNotes()'s own discipline: never trust
 * "no exception" — always independently re-navigate and re-read the real
 * committed value afterward, from a fresh page state, not from whatever the
 * edit dialog reported on its own way out.
 *
 * Never overwrites a real, DIFFERENT existing Waybill Number — reports
 * 'skipped' instead. This field's semantics (single value vs. an
 * accumulating log, like Notes to Receiver turned out to be) are not
 * confirmed; refusing to overwrite an unexpected existing value is the same
 * conservative default this project already applied to Notes to Receiver
 * before its real accumulating-log behavior was confirmed. If the field
 * already holds exactly the AWB being written, this is a no-op success,
 * not a skip — same "already correct" idempotence expectation as every
 * other writer here.
 */
export async function writeInboundAwb(client: MxiClient, orderNumber: string, awb: string): Promise<WriteInboundAwbResult> {
  const trimmedAwb = awb.trim();
  if (!trimmedAwb) {
    return { status: 'failed', shipmentId: null, errorMessage: 'No AWB value given to write.' };
  }

  try {
    const page = await client.getAuthenticatedPage();
    const shipmentId = await findInboundShipmentId(page, client.todoListUrl, orderNumber);
    if (!shipmentId) {
      return { status: 'no_inbound_shipment_found', shipmentId: null, errorMessage: null };
    }

    const currentValue = await readWaybillNumberInEditMode(page);
    if (currentValue && currentValue.toUpperCase() !== trimmedAwb.toUpperCase()) {
      log.warn(
        { orderNumber, shipmentId, currentValue, attemptedAwb: trimmedAwb },
        '[awb-inbound] Waybill Number already holds a different value — refusing to overwrite',
      );
      // Best-effort: leave the dialog the way it was found (re-submit the
      // unchanged value) rather than abandon it half-open with no confirmed
      // exit control.
      await fillWaybillNumberAndConfirm(page, currentValue);
      return {
        status: 'skipped',
        shipmentId,
        errorMessage: `Waybill Number already set to "${currentValue}" — not overwritten with "${trimmedAwb}".`,
      };
    }
    if (currentValue.toUpperCase() === trimmedAwb.toUpperCase()) {
      await fillWaybillNumberAndConfirm(page, currentValue);
      return { status: 'success', shipmentId, errorMessage: null };
    }

    await fillWaybillNumberAndConfirm(page, trimmedAwb);

    // Independent re-verification, from scratch — same discipline as
    // writeEsdAndNotes()'s own re-read, not trusting the edit dialog's own
    // apparent success.
    const verifyShipmentId = await findInboundShipmentId(page, client.todoListUrl, orderNumber);
    if (!verifyShipmentId) {
      return { status: 'failed', shipmentId, errorMessage: 'Could not re-locate the inbound shipment to verify the write.' };
    }
    const verifiedValue = await readWaybillNumberInEditMode(page);
    // Close the re-opened edit dialog cleanly rather than abandon it.
    await fillWaybillNumberAndConfirm(page, verifiedValue);

    if (verifiedValue.toUpperCase() === trimmedAwb.toUpperCase()) {
      return { status: 'success', shipmentId: verifyShipmentId, errorMessage: null };
    }
    return {
      status: 'failed',
      shipmentId: verifyShipmentId,
      errorMessage: `Wrote "${trimmedAwb}" but re-read "${verifiedValue}" afterward — the write did not take.`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ orderNumber, errorMessage }, '[awb-inbound] write failed');
    return { status: 'failed', shipmentId: null, errorMessage };
  }
}
