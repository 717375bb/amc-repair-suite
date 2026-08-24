/// <reference lib="dom" />
import type { Page } from 'playwright';

const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Shared "create a work package for a line that has none" mechanism.
 *
 * MOVED here verbatim from aeroRepair/partDetails.ts (where it was private)
 * so the vendor-code engine can use the SAME proven implementation rather
 * than growing a second one. Aero Repair's behaviour is unchanged — it now
 * imports these instead of defining them.
 *
 * Generalizing this to the vendor-code grid is evidence-backed, not
 * assumed. A real captured vendor-code grid
 * (data/diagnostics/grid-wait-21844-2026-08-03T15-02-09-834Z.html — vendor
 * 21844, production) contains a genuine no-work-package row, and its DOM
 * confirms every structural assumption this module relies on:
 *   - the row's anchors, in order, are [0] Part No ("D98C08-607"),
 *     [1] Serial No ("1280"), then Owner / Location / vendor — so Part No
 *     and Serial No are the first two `<a>` links, exactly as Aero
 *     Repair's own part-number-anchored walk already assumed;
 *   - Part Name ("BOOSTER PUMP PRESSURE") and Part Type ("INTERCHG") are
 *     plain text, NOT links, which is why the two are adjacent as anchors
 *     even though a column sits between them visually;
 *   - the row carries `input[name="aInventory"]` (type CHECKBOX) and
 *     exactly ONE `input[name="aWorkOrderVendorOrShop"]` (type RADIO) —
 *     the two controls createWorkPackageForLine requires. Note MXI writes
 *     these `type` attributes in UPPERCASE.
 */
/**
 * Addition 1 (Create Work Package) — locates the SPECIFIC no-work-package
 * row (exact partNumber + serialNumber) on the currently-rendered filtered
 * grid. Mirrors batchDiscovery.ts's findNoWorkPackageLinesForPart's own
 * confirmed DOM-walk technique (every real per-line row, with or without a
 * work package, has its own Part No and Serial No as two consecutive plain
 * `<a>` links) but scoped to one exact serial, and additionally returns the
 * row's own full accessible-name text — used to build a
 * `page.getByRole('row', ...)` locator, the same real selector confirmed
 * live in discovery-work-package-recording.ts — plus the composed
 * part-description text (everything in the row's own text before the Part
 * No token) needed for the Work Package name. Returns null if this exact
 * line currently has a work package (a real "Repair ..." link exists for
 * it) or isn't present on this grid at all — a definitive read either way,
 * never guessed.
 */
export async function findNoWorkPackageRowForSerial(
  page: Page,
  partNumber: string,
  serialNumber: string,
): Promise<{ inventoryToken: string; partDescription: string } | null> {
  return page.evaluate(
    ({ pn, sn }: { pn: string; sn: string }) => {
      const repairLinkRe = new RegExp(`^Repair .*\\(PN: ${pn.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}, SN: [^)]+\\)$`);
      const trs = Array.from(document.querySelectorAll('tr'));
      for (const tr of trs) {
        const text = (tr.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text.includes('USSTG')) continue;
        if (text.includes('Options...')) continue; // admin/wrapper row, not a real line

        const linkTexts = Array.from(tr.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim());
        const pnIdx = linkTexts.indexOf(pn);
        if (pnIdx === -1) continue; // not this part number's own row

        const rowSerial = linkTexts[pnIdx + 1];
        if (rowSerial !== sn) continue; // not this specific serial

        const hasRepairLink = linkTexts.some((t) => repairLinkRe.test(t));
        if (hasRepairLink) continue; // already has a work package — not this case

        const inventoryToken = tr.querySelector('input[name="aInventory"]')?.getAttribute('value');
        if (!inventoryToken) continue; // no real inventory control -> not a real line

        const pnPos = text.indexOf(pn);
        const partDescription = pnPos > 0 ? text.slice(0, pnPos).trim() : '';
        return { inventoryToken, partDescription };
      }
      return null;
    },
    { pn: partNumber, sn: serialNumber },
  );
}

/**
 * Addition 1 (Create Work Package) — confirmed real mechanism from
 * discovery-work-package-recording.ts, taken literally: BOTH the inventory
 * checkbox and the vendor radio must be checked before "Create Work
 * Package" is clicked (confirmed rule), then the newly-generated work
 * package's own `aName` field is filled with a name composed from PARSED
 * row data — never by replicating the recording's own dblclick/click
 * text-selection noise (that was the human manually selecting/copying text
 * during capture, not a real mechanism to reproduce). Each of the two
 * checkbox/radio checks is independently read back and confirmed BEFORE
 * proceeding — if either cannot be confirmed checked, this throws rather
 * than clicking Create Work Package on an unconfirmed state (guardrail, per
 * explicit instruction).
 *
 * Per explicit confirmation the recording is complete and nothing was
 * skipped: there is no separate OK/Save link in this flow at all — the
 * recording's own last action on `aName` is the `.fill()`, immediately
 * followed by the browser landing on CheckDetails.jsp. The real mechanism
 * is the field committing/navigating on blur, not a submit click; codegen
 * only ever captures the resulting navigation, not the blur event itself.
 * Replicated here with an explicit `Tab` press right after `.fill()` (the
 * same "move focus away" a real user's next action would cause) rather than
 * a fabricated OK click. The subsequent independent re-verification (a
 * fresh grid re-navigation confirming the exact composed name — see the
 * caller, findFirstRepairLineForPart) is what actually proves this worked,
 * regardless of exactly which page the browser lands on in between.
 */
export async function createWorkPackageForLine(
  page: Page,
  partNumber: string,
  serialNumber: string,
  /**
   * The row's own `input[name="aInventory"]` VALUE — a unique per-inventory
   * `{AES}` token.
   *
   * REAL BUG FOUND AND FIXED (2026-08-24) — this parameter used to be the
   * row's raw text, used as `getByRole('row', { name: rowText, exact: true })`.
   * That never matched anything: the callers derive that text from
   * `Element.textContent`, which includes the inline `<script>`/comment
   * bodies MXI puts inside its grid rows (a real row's text begins
   * "BOOSTER PUMP PRESSURED98C08-607INTERCHG1280PSA (PSA Airlines)
   * DCA/USSTG <!-- function onClick_iButtonSpecialHandling1() ..."), while
   * an accessible NAME is built from rendered text and excludes all of it.
   * So the locator resolved to 0 rows and this function threw on the very
   * first `.check()` every time.
   *
   * Caught by replaying this module against a real captured production
   * grid (data/diagnostics/grid-wait-21844-*.html) in a real browser,
   * before it ran against MXI. Corroborated independently by the audit DB:
   * `write_up_actions` has never recorded a single 'work_package_created'
   * row, so this path had never once completed. It went unnoticed because
   * a one-time proof gate stopped every such line immediately afterwards
   * anyway — the gate masked the failure it was supposed to be guarding.
   *
   * The token is exact, unique per row, and structural, so it does not
   * depend on how MXI renders text.
   */
  inventoryToken: string,
  partDescription: string,
): Promise<{ workPackageName: string }> {
  // The token is base64-ish ({AES}, +, /, =) — all safe unquoted inside a
  // double-quoted CSS attribute selector; only " and \ would need escaping
  // and neither occurs in this alphabet.
  const row = page
    .locator(`input[name="aInventory"][value="${inventoryToken}"]`)
    .locator('xpath=ancestor::tr[1]');

  const inventoryCheckbox = row.locator('input[name="aInventory"]');
  await inventoryCheckbox.check();
  await pace(page);
  if (!(await inventoryCheckbox.isChecked())) {
    throw new Error(
      `Create Work Package guardrail failed for ${partNumber}/${serialNumber}: input[name="aInventory"] did not ` +
        `confirm checked — refusing to click Create Work Package without both required boxes confirmed.`,
    );
  }

  const vendorRadio = row.getByRole('radio');
  await vendorRadio.check();
  await pace(page);
  if (!(await vendorRadio.isChecked())) {
    throw new Error(
      `Create Work Package guardrail failed for ${partNumber}/${serialNumber}: the vendor radio did not confirm ` +
        `checked — refusing to click Create Work Package without both required boxes confirmed.`,
    );
  }

  const workPackageName = `Repair ${partDescription} (PN: ${partNumber}, SN: ${serialNumber})`;

  await page.getByRole('link', { name: 'Create Work Package' }).click();
  await pace(page);
  const nameField = page.locator('input[name="aName"]');
  await nameField.click();
  await nameField.fill(workPackageName);
  // Real mechanism per the recording (see docstring above): the field
  // commits and navigates on blur, not a submit click. Tab moves focus away
  // the same way a real user's next action would.
  await nameField.press('Tab');
  await pace(page);

  return { workPackageName };
}


export interface NoWorkPackageRow {
  partNumber: string;
  serialNumber: string;
  /** The row's own unique input[name="aInventory"] value — how
   *  createWorkPackageForLine locates the row. See its docstring for why
   *  this is NOT the row text. */
  inventoryToken: string;
  /** Everything before the Part No token — the Work Package name's description. */
  partDescription: string;
}

/**
 * Lists EVERY genuine no-work-package row on the currently-rendered grid,
 * without needing a part number up front.
 *
 * findNoWorkPackageRowForSerial (above) anchors on a known Part No, which
 * the Aero Repair flow always has because it searches one part number at a
 * time. A vendor-code search doesn't — it filters by vendor and gets back
 * whatever parts that vendor holds — so this variant identifies the Part
 * No / Serial No structurally instead: they are the row's first two `<a>`
 * links (confirmed against the real captured grid cited in this module's
 * header docstring).
 *
 * Three structural guards keep the grid's own admin/wrapper rows out.
 * Those wrappers are duplicate copies of the whole page nested inside one
 * outer `<tr>` (confirmed live — see batchDiscovery.ts's
 * findNoWorkPackageLinesForPart), so they would otherwise look like rows
 * with dozens of anchors:
 *   1. the row must contain EXACTLY ONE `input[name="aInventory"]` — a
 *      wrapper row nesting N real rows contains N of them, and a
 *      non-line row contains none. This is the strongest of the three and
 *      is why it isn't relying on text matching alone;
 *   2. it must not contain the literal "Options..." filter-dialog text,
 *      which no real per-line row ever does;
 *   3. it must mention USSTG, so a DOCK row is never a candidate for
 *      automatic work-package creation.
 *
 * A row that already HAS a work package (a real "Repair ... (PN: X, SN: Y)"
 * link) is excluded — that's the normal case the caller already handles.
 */
export async function findNoWorkPackageRowsOnGrid(page: Page): Promise<NoWorkPackageRow[]> {
  return page.evaluate(() => {
    const repairLinkRe = /^Repair .*\(PN: .*, SN: [^)]+\)$/;
    const out: { partNumber: string; serialNumber: string; inventoryToken: string; partDescription: string }[] = [];

    for (const tr of Array.from(document.querySelectorAll('tr'))) {
      // Guard 1 — exactly one inventory checkbox means exactly one real line.
      const inventoryInputs = tr.querySelectorAll('input[name="aInventory"]');
      if (inventoryInputs.length !== 1) continue;
      const inventoryToken = inventoryInputs[0].getAttribute('value');
      if (!inventoryToken) continue;

      const text = (tr.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.includes('Options...')) continue; // Guard 2 — admin/wrapper row.
      if (!text.includes('USSTG')) continue; // Guard 3 — never auto-create for a DOCK row.

      const linkTexts = Array.from(tr.querySelectorAll('a')).map((a) => (a.textContent ?? '').trim());
      if (linkTexts.some((t) => repairLinkRe.test(t))) continue; // already has a work package.

      const partNumber = linkTexts[0];
      const serialNumber = linkTexts[1];
      // Never guess at a row whose shape doesn't match the confirmed one.
      if (!partNumber || !serialNumber) continue;

      const pnPos = text.indexOf(partNumber);
      out.push({
        partNumber,
        serialNumber,
        inventoryToken,
        partDescription: pnPos > 0 ? text.slice(0, pnPos).trim() : '',
      });
    }
    return out;
  });
}
