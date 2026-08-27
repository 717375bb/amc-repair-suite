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
 * Aero Repair's per-serial variant: the one no-work-package row matching an
 * exact part number + serial, or null.
 *
 * REWRITTEN 2026-08-25 to delegate to findNoWorkPackageRowsOnGrid rather
 * than keep a second DOM walk. It previously carried its own copy of the
 * "Repair ... (PN: ..., SN: ...)" link-text test, which is exactly the
 * check the user's report was about — a work package named anything else
 * read as no work package at all, and a duplicate got created over it.
 * Sharing one implementation means the two engines cannot drift on what
 * counts as "has a work package" again.
 *
 * Both callers run against the same To Do List grid (Aero Repair filters
 * it by part number, the vendor-code family by vendor code), so the row
 * shape and header are identical — confirmed against the real captured
 * grid cited in this module's header docstring.
 */
export async function findNoWorkPackageRowForSerial(
  page: Page,
  partNumber: string,
  serialNumber: string,
): Promise<{ inventoryToken: string; partDescription: string } | null> {
  const rows = await findNoWorkPackageRowsOnGrid(page);
  const hit = rows.find((r) => r.partNumber === partNumber && r.serialNumber === serialNumber);
  return hit ? { inventoryToken: hit.inventoryToken, partDescription: hit.partDescription } : null;
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
  await page.getByText('OK', { exact: true }).click();
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
  /**
   * The row's own "<STATION>/<CODE>" location, or null if the row carries
   * no readable token. Needed because these rows never have a repair link
   * for the normal grid reader to hang off, yet still have to pass the
   * approved-base check like any other line.
   */
  currentLocation: string | null;
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
    // Fallback only, for a grid whose Work Package header cannot be
    // located. Not anchored on a "Repair " prefix either — the whole point
    // of this change is that the package's NAME does not decide whether it
    // exists.
    const repairLinkRe = /\(PN: .*, SN: [^)]+\)$/;
    const out: { partNumber: string; serialNumber: string; inventoryToken: string; partDescription: string; currentLocation: string | null }[] = [];

    // NOTE — the Work Package lookup below is written as straight-line code
    // with NO named helper functions, on purpose. tsx/esbuild compiles this
    // file with keepNames, which wraps a const-assigned arrow in a
    // `__name(...)` helper; that helper does not exist inside the page, so
    // factoring this out dies at runtime with "__name is not defined".
    // Caught by running this against the real captured grid before it
    // shipped — it would have failed on the first live run.

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

      // --- Does this row's Work Package column hold ANY value? ---
      //
      // REAL BUG FOUND AND FIXED (2026-08-25), per explicit user direction:
      // "if, in the USSTG line, there is any value in the work package at
      // all, it is assumed that a work package does exist and the script
      // proceeds." Presence used to be decided by matching the LINK TEXT
      // against /^Repair .*\(PN: ..., SN: ...\)$/, so a package named
      // anything else — most obviously one this suite itself renames to
      // "Scrap ..." during an in-house scrap — read as no work package at
      // all, and a duplicate got created on top of a real one.
      //
      // The column is located from the HEADER, not a fixed index, so
      // adding or removing columns via Options > Display Columns cannot
      // silently shift it. Confirmed against the real captured grid
      // (data/diagnostics/grid-wait-21844-*.html): the top header row
      // carries "Work Package" as its own colspan=1 cell, every cell
      // before it is colspan=1 too, and the matching data cell is index 6
      // — empty (&nbsp;) on that genuinely no-work-package row.
      let wpCell: string | null = null;
      const table = tr.closest('table');
      const headerRow = table ? table.querySelector('tr') : null;
      if (headerRow && headerRow !== tr) {
        let column = 0;
        let target = -1;
        for (const cell of Array.from(headerRow.querySelectorAll(':scope > td, :scope > th'))) {
          const headerText = (cell.textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
          if (headerText === 'Work Package') {
            target = column;
            break;
          }
          column += Number.parseInt(cell.getAttribute('colspan') ?? '1', 10) || 1;
        }
        if (target >= 0) {
          const cells = Array.from(tr.querySelectorAll(':scope > td, :scope > th'));
          if (target < cells.length) {
            wpCell = (cells[target].textContent ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
          }
        }
      }

      if (wpCell === null) {
        // Column not locatable on this grid — fall back to the old
        // link-text test rather than risk creating a duplicate work
        // package off an unreadable row.
        if (linkTexts.some((t) => repairLinkRe.test(t))) continue;
      } else if (wpCell !== '') {
        continue; // ANY value means a work package exists. This is the fix.
      }

      const partNumber = linkTexts[0];
      const serialNumber = linkTexts[1];
      // Never guess at a row whose shape doesn't match the confirmed one.
      if (!partNumber || !serialNumber) continue;

      const pnPos = text.indexOf(partNumber);
      // Same location token every other reader in this suite matches, and
      // case-insensitive for the same reason: MXI's location casing varies
      // by site (DFW/REPAIR1/SHOP1 alongside PNS/Repair1/Shop1).
      const locationMatch = text.match(/\b([A-Za-z]{3})\/([A-Za-z0-9]+)\b/);
      out.push({
        partNumber,
        serialNumber,
        inventoryToken,
        partDescription: pnPos > 0 ? text.slice(0, pnPos).trim() : '',
        currentLocation: locationMatch ? `${locationMatch[1]}/${locationMatch[2]}` : null,
      });
    }
    return out;
  });
}
