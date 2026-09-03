import type { Page } from 'playwright';
import { clickActionLink } from '../writeUps/shared/clickActionLink.js';

/**
 * Fixed pause after every click/check action. Added after real production
 * use showed the browser firing the next action faster than MXI's own
 * server-driven page updates could keep up with — this is a pragmatic
 * pacing fix, not a wait-for-specific-condition fix, since there was no
 * single reliable element/state to wait on across every action here.
 */
const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * DOM interaction for PSA Airlines' Maintenix (MXI) instance.
 *
 * Every function below (except attemptCancelEdit, see its own docstring) is
 * implemented from real `npx playwright codegen` recordings against stage
 * MXI — none of this is guessed. The read path (login, findOrderByNumber,
 * readEsdField) was recorded and verified first; the ESD write path
 * (updateEsdField, submitChanges) was recorded, then re-recorded through
 * "Issue Order" once a first smoke test showed the change doesn't persist
 * without it — see submitChanges' docstring.
 *
 * Architecture discovered while adding the Notes to Receiver path (confirmed
 * via live, non-destructive diagnostics against stage, not assumed from
 * reading the notes recording):
 *
 * Searching an order number lands directly on that order's "RO Details"
 * page — not a results grid. RO Details has its own tab bar (Order Lines /
 * Details / Filled Requests / ...) and its own top-level action bar
 * (Unauthorize Order / Issue Order / Cancel Order / ...). "Edit Lines" (the
 * ESD field's home) is a sub-view reached from the Order Lines tab; "Notes
 * to Receiver" lives on the separate Details tab, reachable directly from
 * RO Details with no need to ever touch Edit Lines or the ESD field.
 * "Issue Order" is a top-level RO Details action, not something nested
 * inside the ESD-edit flow — it's the same shared reissue mechanism
 * regardless of whether ESD, Notes, or both changed.
 *
 * The notes recording this was built from also clicked into the ESD field
 * before doing anything else, exactly like the "I just did it out of
 * habit" pattern already seen once in the ESD-only session — a live,
 * non-destructive diagnostic confirmed the Details tab is NOT reachable
 * from inside an entered-but-unconfirmed Edit Lines view (you must exit it
 * via OK/YES first), but IS reachable directly from a fresh RO Details page
 * with no Edit Lines detour at all. navigateToOrder() (the lighter
 * navigation, below) is used instead of findOrderByNumber() whenever ESD
 * isn't being touched.
 */

/**
 * Pressing Enter in the password field submits and completes login on its
 * own — confirmed against real stage MXI. There is no separate "Sign In"
 * button click needed (or, on the page this lands on, present at all).
 *
 * loginUrl is the caller's configured MxiConfig.baseUrl (stage or
 * production) — this used to be a hardcoded stage constant here, which
 * meant --env production correctly swapped credentials but silently kept
 * navigating to stage regardless. Never hardcode an environment URL in
 * this file again; always thread it through from the caller's config.
 */
export async function login(page: Page, username: string, password: string, loginUrl: string): Promise<void> {
  await page.goto(loginUrl);
  await page.getByRole('textbox', { name: 'Username' }).click();
  await pace(page);
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByRole('textbox', { name: 'Username' }).press('Tab');
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('textbox', { name: 'Password' }).press('Enter');
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Uses the global barcode/order search box on the To Do List page, then
 * selects the (first) matching purchase order line and opens it in the
 * line-edit view — which is also where the RO ESD ("Promise By") field
 * lives, so readEsdField() expects to be called right after this.
 *
 * Known limitation: only the first matching line is selected. Multi-line
 * purchase orders aren't handled yet — Phase 1 operates at order
 * granularity, so this hasn't come up, but flag it if it does.
 */
export async function findOrderByNumber(page: Page, orderNumber: string, todoListUrl: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.locator('#idBarcodeSearchInput').click();
  await pace(page);
  await page.locator('#idBarcodeSearchInput').fill(orderNumber);
  await page.locator('#idBarcodeSearchInput').press('Enter');
  await pace(page);
  // REAL FAILURE FIXED (2026-08-28): a quote write on P000BEJY failed with
  // `locator.click: Timeout 30000ms ... waiting for getByRole('link', {
  // name: 'Edit Lines' })`. The bare click reported only what it wanted,
  // never what was on the page — so there was no way to tell whether the
  // order had no selectable line, had moved to a state that offers no Edit
  // Lines, or simply had not rendered.
  //
  // The line checkbox is also confirmed present before checking it, rather
  // than assumed: "Edit Lines" is unusable without a selected line, so an
  // absent checkbox is the more likely real cause and is worth saying so.
  const lineCheckbox = page.locator('input[name="aPurchaseOrderLine"]');
  try {
    await lineCheckbox.first().waitFor({ state: 'visible', timeout: 15_000 });
  } catch {
    throw new Error(
      `Order ${orderNumber} shows no selectable order line (no input[name="aPurchaseOrderLine"] on the page), ` +
        `so "Edit Lines" cannot be opened. The order may be closed, cancelled, or not yet rendered.`,
    );
  }
  await lineCheckbox.first().check();
  await pace(page);
  await clickActionLink(page, 'Edit Lines', { label: `Edit Lines on ${orderNumber}` });
  await pace(page);
}

/**
 * Lighter navigation than findOrderByNumber(): searches and lands on the
 * order's RO Details page, but does NOT check a line or enter "Edit Lines".
 * Use this whenever the ESD field itself isn't being touched — e.g. before
 * readNoteToReceiver()/updateNoteToReceiver(), which live on RO Details'
 * separate Details tab and don't need (or want) Edit Lines at all.
 */
export async function navigateToOrder(page: Page, orderNumber: string, todoListUrl: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.locator('#idBarcodeSearchInput').click();
  await pace(page);
  await page.locator('#idBarcodeSearchInput').fill(orderNumber);
  await page.locator('#idBarcodeSearchInput').press('Enter');
  await pace(page);
}

/**
 * Reads the "Issued: N time(s)" counter visible on the base RO Details page
 * (confirmed present in the same text block as Order Status/Vendor — see
 * selectors.ts's architecture note above). Must be called after
 * navigateToOrder() (or findOrderByNumber(), which also lands there before
 * drilling into Edit Lines). Returns null if the counter text isn't found
 * (rather than throwing) — this is a monitoring/diagnostic signal, not a
 * core write-path dependency, so a parse miss shouldn't fail the caller.
 */
export async function readIssuedCount(page: Page): Promise<number | null> {
  const bodyText = await page.locator('body').innerText();
  const match = bodyText.match(/Issued:\s*(\d+)\s*time/i);
  return match ? Number(match[1]) : null;
}

/**
 * Reads (does not modify) the RO ESD / "Promise By" date field. Must be
 * called after findOrderByNumber() has navigated into the line-edit view.
 *
 * Caution carried over from the recording, not yet verified either way:
 * entering the line-edit view to read this field may place a record lock
 * or leave an "edited by" trail in MXI even without submitting — worth
 * confirming with someone who knows Maintenix's locking behavior before
 * relying on this for frequent/automated polling.
 */
export async function readEsdField(page: Page): Promise<string | null> {
  const field = page.locator('input[name^="aPromiseBy_"][name$="_$DATE$"]').first();
  const value = await field.inputValue();
  return value.trim().length > 0 ? value : null;
}

/**
 * Real, from a codegen recording against stage. Format is DD-MMM-YYYY (e.g.
 * "08-JUL-2026"), matching what readEsdField() returns.
 *
 * Two live tests corrected this from the initially-recorded click →
 * Backspace → type sequence to a direct .fill(). What happened, for the
 * record (both confirmed via a non-destructive diagnostic script, no
 * submit involved):
 *
 *  - The field DOES fully select its existing text on click — verified
 *    directly via the DOM: selectionStart/selectionEnd covered the whole
 *    value, even before an explicit Ctrl+A.
 *  - Despite that, pressing Backspace only ever deleted ONE character, and
 *    every subsequent typed character was silently rejected — the field's
 *    value never changed after the first keystroke. This points to custom
 *    per-keystroke JS validation on this field (common in older masked
 *    date inputs) that doesn't respect the reported selection.
 *  - Two live writes were corrupted by this before it was caught: writing
 *    "09-JUL-2026" over "10-JUL-2026" produced "10-JUL-2020" (only the
 *    last character actually changed), and a second attempt to fix it
 *    produced "10-JUL-2021" — same failure pattern regardless of whether
 *    Backspace alone or Ctrl+A+Backspace preceded the typing.
 *  - `.fill()` sets the value via a direct DOM `input`/`change` event
 *    rather than simulating individual keydown/keypress events, which
 *    sidesteps whatever the per-keystroke handler is doing. Confirmed
 *    directly (diagnostic, no submit): `.fill("09-JUL-2026")` set the field
 *    to exactly that value, correctly, in one step.
 */
export async function updateEsdField(page: Page, newEsd: string): Promise<void> {
  const field = page.locator('input[name^="aPromiseBy_"][name$="_$DATE$"]').first();
  await field.fill(newEsd);
}

/**
 * Confirms an edit made inside "Edit Lines" (e.g. the ESD or price field).
 * Exits back to the RO Details page — the "Details" tab and "Issue Order"
 * are both reachable from there afterward, confirmed via live diagnostic
 * (neither is reachable from inside an unconfirmed Edit Lines view).
 *
 * REAL BUG FOUND AND FIXED (user-reported, 2026-08-21): this used to click
 * "OK" and then UNCONDITIONALLY click "YES", producing
 * `locator.click: Timeout 30000ms exceeded - waiting for
 * getByRole('link', { name: 'YES' })` whenever that warning never appeared.
 *
 * The "YES" is the *"this line will need to be re-issued"* confirmation —
 * by definition it only shows when the edit actually forces re-issue/
 * re-authorization. On an order that doesn't need it, MXI commits the OK
 * and goes straight back to RO Details, so waiting for YES was waiting for
 * something that was never coming.
 *
 * **This is almost certainly the root of the long-documented "reissueOrder
 * reliability gap"** (see writeEsdAndNotes.ts and
 * PHASE2_MXI_WRITER_SPEC.md): a real 40-order run recorded thrown
 * exceptions here where the ESD had nonetheless committed correctly. That
 * is exactly this shape — the OK committed the edit, then the YES wait
 * timed out and threw, so a genuinely successful write was reported as a
 * failure. It was described as an anomaly rather than diagnosed.
 *
 * Now waits for a DEFINITIVE end state instead of assuming one: either the
 * YES confirmation is present (click it), or we're already back on RO
 * Details (nothing to confirm). Same content-aware-wait discipline as
 * shared/unassignedTasks.ts's waitForUnassignedTasksSectionResolved, and
 * the same conditional-YES precedent already set by
 * shared/authFlow.ts's handleMinimumPurchaseAmountConfirmation.
 *
 * Deliberately does NOT throw when neither marker resolves in time: every
 * caller independently re-verifies the real committed value afterward
 * (writePriceLineUpdate, writeEsdAndNotes), so a slow page becomes a
 * verification failure with real evidence rather than a spurious timeout
 * on a write that actually worked. Returns whether the confirmation was
 * shown, for the audit trail; existing callers may ignore it.
 */
export async function confirmEsdLineEdit(page: Page): Promise<{ confirmationShown: boolean }> {
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);

  const RESOLVE_TIMEOUT_MS = 15_000;
  try {
    await page.waitForFunction(
      () => {
        const linkNames = Array.from(document.querySelectorAll('a')).map((a) =>
          (a.textContent ?? '').replace(/\s+/g, ' ').trim().toUpperCase(),
        );
        if (linkNames.includes('YES')) return true;
        // Back on RO Details: no re-issue warning was needed.
        const bodyText = (document.body?.innerText ?? '').replace(/\s+/g, ' ');
        return linkNames.includes('ISSUE ORDER') || bodyText.includes('Order Status:');
      },
      undefined,
      { timeout: RESOLVE_TIMEOUT_MS, polling: 250 },
    );
  } catch {
    // Neither marker resolved. Fall through — the caller's own verification
    // is the authority on whether the edit actually committed.
  }

  const yesLink = page.getByRole('link', { name: 'YES' });
  if ((await yesLink.count()) > 0) {
    await yesLink.first().click();
    await pace(page);
    return { confirmationShown: true };
  }

  return { confirmationShown: false };
}

/**
 * Clicks the top-level "Issue Order" action on the RO Details page, then
 * its own confirmation ("OK", exact match — there are multiple "OK"-labeled
 * elements on screen at that point, hence the exact match). This is a
 * top-level RO Details action, not something nested inside the ESD-edit
 * flow — the same shared reissue mechanism regardless of whether ESD,
 * Notes, or both changed in this edit session (confirmed live: "Issue
 * Order" appears in RO Details' own action bar, reachable independent of
 * which sub-view — Edit Lines or the Details tab — was used beforehand).
 *
 * A first smoke test that stopped after confirmEsdLineEdit's "YES"
 * (skipping this) completed without error but the date change did NOT
 * persist on re-read — re-issuing isn't a habitual extra step, it's
 * required for a change to actually save. "Issue Order" is a real, separate
 * action beyond "save this field" (per context, it may re-notify the
 * vendor) — worth remembering if this is ever used somewhere the frequency
 * or side effects of re-issuing matter.
 */
export async function reissueOrder(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Issue Order' }).click();
  await pace(page);
  // Best-effort, for the same reason confirmEsdLineEdit's YES is now
  // conditional: a confirmation that doesn't always appear must not be
  // waited on for the full 30s default and then thrown, on an action that
  // may well have already committed. Short bounded wait, click if present.
  const ok = page.getByRole('link', { name: 'OK', exact: true });
  try {
    await ok.first().waitFor({ state: 'visible', timeout: 10_000 });
    await ok.first().click();
    await pace(page);
  } catch {
    // No confirmation appeared — callers independently verify the real
    // outcome (writeEsdAndNotes re-reads; writePriceLineUpdate checks the
    // issued count), so this is not treated as a failure on its own.
  }
}

/**
 * ESD-only submit: confirmEsdLineEdit() then reissueOrder(). Kept as a
 * named step for the ESD-only write path (writeEsd.ts) — behaviorally
 * identical to before this was split into its two reusable pieces for the
 * combined ESD+Notes path (writeEsdAndNotes.ts).
 */
export async function submitChanges(page: Page): Promise<void> {
  await confirmEsdLineEdit(page);
  await reissueOrder(page);
}

/**
 * Reads #idNoteToReceiver's current text via `.innerText()` — does not
 * click "Details" itself. Callers must already be on the Details tab (both
 * readNoteToReceiver() and updateNoteToReceiver() below click it before
 * calling this, so each stays independently callable while only clicking
 * "Details" once per call).
 */
async function readNoteFieldText(page: Page): Promise<string | null> {
  const value = await page.locator('#idNoteToReceiver').innerText();
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Reads (does not modify) the Notes to Receiver field. Must be called after
 * navigateToOrder() (or findOrderByNumber(), if ESD is also being touched
 * in the same session) has landed on the order's RO Details page — this
 * clicks the separate "Details" tab itself.
 *
 * Deliberately does NOT click into edit mode: confirmed live that
 * #idNoteToReceiver in its normal (non-edit) state is a plain text element,
 * not an <input> — `.inputValue()` throws on it ("Node is not an <input>,
 * <textarea> or <select> element"). `.innerText()` reads it correctly
 * without ever entering edit mode, which is also the safer choice given the
 * still-open record-lock question (see readEsdField's caveat) — this read
 * path doesn't even touch the "Edit" button, let alone Edit Lines.
 */
export async function readNoteToReceiver(page: Page): Promise<string | null> {
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await pace(page);
  return readNoteFieldText(page);
}

/**
 * Appends one new dated entry to the Notes to Receiver field — never
 * overwrites existing content. Real-order research (Part B) found this
 * field is an accumulating log, not a single value: every multi-entry
 * example found had earlier-dated entries before later-dated ones
 * (`P000AED1`: 01/22/2026 before 04/16/26; `P000AG1D`: 2.16.26 before
 * 5.21.2026), confirmed from the actual samples, not assumed — so new
 * entries are appended at the END, separated from prior content by a blank
 * line, matching every real example.
 *
 * `newEntryText` is just the one new entry (already formatted
 * "M.D.YY - <text>" by the caller, see server.ts's assembleNoteText) — this
 * function reads whatever is currently in the field first, and if it's
 * non-blank, combines it as `${newEntryText}\n\n${existing}`; if the field
 * was blank, writes just `newEntryText` with no leading separator.
 *
 * **NEWEST ENTRY FIRST**, changed 2026-08-24 (commit 752d764) so the most
 * recent note is at the top of the field. The paragraph above used to say
 * entries were appended at the END, and that stale sentence caused a real
 * bug: writeEsdAndNotes' verification was written against it and compared
 * the re-read field to `${existing}\n\n${newEntryText}`, which can never
 * occur — so from that date every note write onto an order with existing
 * history was reported as FAILED, and the self-heal then wrote the same
 * entry a second time. Verification no longer depends on the order at all
 * (see noteVerification.ts), but keep this sentence honest regardless.
 *
 * The very first version of this function used `.fill(noteText)` directly
 * with no read-first step, which would have silently destroyed any real
 * prior note history the first time it ran against an order that had one —
 * caught before that happened, not after, via Part B's read-only research.
 *
 * Returns the pre-write value so the caller (writeEsdAndNotes.ts) can
 * verify after reissuing that prior history is still intact, not just that
 * the new entry landed — reading it again here would need a second
 * "Details" click for no benefit, since this function already reads it once
 * as a natural part of combining the text.
 *
 * Must be called after navigateToOrder()/findOrderByNumber() has landed on
 * RO Details — clicks the "Details" tab, then the "Edit" button
 * (#idButtonEditPODetails, which is what turns #idNoteToReceiver from a
 * plain text element into a real fillable one), fills the combined text,
 * then clicks "OK" to confirm this specific field edit. Does NOT reissue —
 * call reissueOrder() afterward (once, whether or not the ESD field was
 * also changed in this session).
 *
 * Uses `.fill()` from the start, consistent with updateEsdField's
 * corrected approach — no click+backspace+type sequence, no reason to risk
 * repeating that corruption pattern on a field never tested that way here.
 */
export async function updateNoteToReceiver(
  page: Page,
  newEntryText: string,
): Promise<{ previousNote: string | null }> {
  await page.getByRole('link', { name: 'Details', exact: true }).click();
  await pace(page);
  const previousNote = await readNoteFieldText(page);
  const combinedText = previousNote ? `${newEntryText}\n\n${previousNote}` : newEntryText;

  await page.locator('#idButtonEditPODetails').click();
  await pace(page);
  await page.locator('#idNoteToReceiver').fill(combinedText);
  await page.getByRole('link', { name: 'OK' }).click();
  await pace(page);

  return { previousNote };
}

/**
 * Best-effort cleanup only: tries a few plausible "back out of this edit"
 * labels and gives up silently if none exist. Must never throw — a failed
 * cleanup attempt must not mask the real error that triggered it, and must
 * never be mistaken for a verified selector the way the functions above are.
 *
 * A live diagnostic (while mapping the Notes to Receiver flow) specifically
 * checked for cancel/exit/close after entering Edit Lines and confirming
 * the ESD line edit (OK/YES) — none of the three candidate labels were
 * present. So on real stage MXI, at least at that point in the flow, this
 * function currently finds nothing and silently no-ops; it's still worth
 * keeping (cheap, never wrong, and other failure points in the combined
 * ESD+Notes flow haven't been checked the same way), but don't assume it
 * actually backs anything out until that's confirmed for whichever point
 * it's called from.
 */
export async function attemptCancelEdit(page: Page): Promise<void> {
  const candidateNames = [/^cancel$/i, /^exit$/i, /^close$/i];
  for (const name of candidateNames) {
    try {
      const link = page.getByRole('link', { name });
      if ((await link.count()) > 0) {
        await link.first().click({ timeout: 3000 });
        await pace(page);
        return;
      }
    } catch {
      // Ignore and try the next candidate — this is best-effort only.
    }
  }
}
