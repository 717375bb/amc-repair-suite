import type { Page } from 'playwright';

/**
 * DOM interaction for PSA Airlines' Maintenix (MXI) instance.
 *
 * Every function below (except attemptCancelEdit, see its own docstring) is
 * implemented from real `npx playwright codegen` recordings against stage
 * MXI — none of this is guessed. The read path (login, findOrderByNumber,
 * readEsdField) was recorded and verified first; the write path
 * (updateEsdField, submitChanges) was recorded, then re-recorded through
 * "Issue Order" once a first smoke test showed the change doesn't persist
 * without it — see submitChanges' docstring.
 */

const LOGIN_URL = 'https://stage.maintenix.psa.aa.com/maintenix/common/security/login.jsp';
export const TODO_LIST_URL = 'https://stage.maintenix.psa.aa.com/maintenix/common/ToDoList.jsp';

/**
 * Pressing Enter in the password field submits and completes login on its
 * own — confirmed against real stage MXI. There is no separate "Sign In"
 * button click needed (or, on the page this lands on, present at all).
 */
export async function login(page: Page, username: string, password: string): Promise<void> {
  await page.goto(LOGIN_URL);
  await page.getByRole('textbox', { name: 'Username' }).click();
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
export async function findOrderByNumber(page: Page, orderNumber: string): Promise<void> {
  await page.goto(TODO_LIST_URL);
  await page.locator('#idBarcodeSearchInput').click();
  await page.locator('#idBarcodeSearchInput').fill(orderNumber);
  await page.locator('#idBarcodeSearchInput').press('Enter');
  await page.locator('input[name="aPurchaseOrderLine"]').first().check();
  await page.getByRole('link', { name: 'Edit Lines' }).click();
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
 * Real, from a codegen recording. Confirms the "needs to be re-issued"
 * warning ("OK" then "YES"), then clicks "Issue Order" and its own
 * confirmation ("OK", exact match — there are multiple "OK"-labeled
 * elements on screen at that point, hence the exact match).
 *
 * A first smoke test that stopped after "YES" (skipping Issue Order)
 * completed without error but the date change did NOT persist on re-read —
 * for a date-only line edit, re-issuing the order isn't just a habitual
 * next step, it's required for the change to actually save. Confirmed by
 * re-recording through the full flow on a second order and re-testing.
 *
 * "Issue Order" is a real, separate action beyond "save this date" (per
 * context, it may re-notify the vendor) — worth remembering if this is
 * ever used somewhere the frequency or side effects of re-issuing matter.
 */
export async function submitChanges(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'OK' }).click();
  await page.getByRole('link', { name: 'YES' }).click();
  await page.getByRole('link', { name: 'Issue Order' }).click();
  await page.getByRole('link', { name: 'OK', exact: true }).click();
}

/**
 * NOT verified against the real system — no lock or "edited by" behavior
 * has been confirmed either way yet (see readEsdField's caveat above).
 * Best-effort cleanup only: tries a few plausible "back out of this edit"
 * labels and gives up silently if none exist. Must never throw — a failed
 * cleanup attempt must not mask the real error that triggered it, and must
 * never be mistaken for a verified selector the way the functions above are.
 */
export async function attemptCancelEdit(page: Page): Promise<void> {
  const candidateNames = [/^cancel$/i, /^exit$/i, /^close$/i];
  for (const name of candidateNames) {
    try {
      const link = page.getByRole('link', { name });
      if ((await link.count()) > 0) {
        await link.first().click({ timeout: 3000 });
        return;
      }
    } catch {
      // Ignore and try the next candidate — this is best-effort only.
    }
  }
}
