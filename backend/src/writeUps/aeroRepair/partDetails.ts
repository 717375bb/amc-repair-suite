/// <reference lib="dom" />
import type { Page, Locator } from 'playwright';
import { NOTES_HEADER_TEXT } from './constants.js';
import { captureEmptyReadEvidence } from './emptyReadCapture.js';
import { waitBeforeRetry } from './retryBackoff.js';
import {
  waitForGridResolved,
  waitForVendorBidsResolved,
  waitForWorkPackageDetailsResolved,
} from './gridWait.js';
import type { PartOwnDetails } from '../shared/partOwnDetails.js';
import { extractRemovalTaskInfo } from '../shared/removalTaskInfo.js';
import { createWorkPackageForLine, findNoWorkPackageRowForSerial } from '../shared/createWorkPackage.js';

/**
 * navigateToUnassignedTasksView, closeUnassignedTasksView,
 * openPartOwnDetails, closePartOwnDetails, readPartOwnDetails,
 * extractCleanPartDescription, PartOwnDetails, UsageParmRow moved to
 * backend/src/writeUps/shared/ per confirmed vendor-agnostic status (a
 * second real vendor, 0T1Y4, uses the identical mechanics). Re-exported
 * here so every existing call site in this module keeps working
 * unchanged. isZeroUsage and composeAeroRepairNotesText stay here — both
 * genuinely Aero-Repair-specific (see their own docstrings below).
 */
export {
  navigateToUnassignedTasksView,
  closeUnassignedTasksView,
} from '../shared/unassignedTasks.js';
export {
  openPartOwnDetails,
  closePartOwnDetails,
  readPartOwnDetails,
  extractCleanPartDescription,
} from '../shared/partOwnDetails.js';
export type { PartOwnDetails, UsageParmRow } from '../shared/partOwnDetails.js';

/**
 * Fixed pause after actions, same pacing fix and same reasoning as
 * mxiWriter/selectors.ts's CLICK_DELAY_MS — MXI's server-driven page updates
 * can't always keep up with Playwright firing the next action immediately.
 */
const CLICK_DELAY_MS = 750;

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface RepairLineInfo {
  /** Extracted from the matched link's own accessible name — not guessed. */
  serialNumber: string;
  /** The full matched link text, e.g. "Repair WHEEL ASSY, NLG (PN: 5013640, SN: AUG10-2534)". */
  linkText: string;
  /** This line's real "Removal Information > Task > Name" — see shared/removalTaskInfo.ts's docstring. Captured here (before navigating away) since it's only visible on the grid row. */
  removalTaskName: string | null;
  /** This line's real "Removal Information > Task > ID" — see shared/removalTaskInfo.ts's docstring. */
  removalTaskId: string | null;
  /**
   * Addition 1 (Create Work Package) — true only when this call itself had
   * to create the work package (the line had none when this function was
   * called). false for the ordinary case (a work package already existed).
   */
  workPackageCreated: boolean;
  /** The exact composed name used, only when workPackageCreated is true. */
  createdWorkPackageName: string | null;
}

/**
 * Real, discovered live: the Options dialog's filters (Inventory Condition
 * REPREQ/RFB, Location Type USSTG/DOCK, OEM Part No, Turn-In date range,
 * Vendor/Shop, Owner, Supply Location, Part Type selection) are NOT a
 * fresh default every time — they persist across sessions on whatever
 * account is logged in. A real incident: a manually-set filter left over
 * from earlier browsing on this project's own test account silently made
 * an automated production scan report "no inventory" for every one of the
 * 6 known part numbers — a false negative indistinguishable from genuinely
 * empty inventory, discovered only because the user happened to know their
 * own account state and could compare.
 *
 * Confirmed live: the dialog's own "Reset Filters" control restores every
 * filter field to its true default (REPREQ/RFB/USSTG all checked, DOCK
 * unchecked, OEM Part No and every other field cleared) in one click, and
 * that default already matches what this flow wants (USSTG only, not
 * DOCK). Per explicit instruction, USSTG-checked/DOCK-unchecked is also
 * enforced explicitly below rather than left as an implicit side effect of
 * Reset Filters — so this still holds even if that button's own default
 * ever changes. Called here, every time, before filling OEM Part No — so
 * this flow never depends on whatever's currently saved on the account
 * being used, on stage or production alike.
 */
export async function resetOptionsFilters(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Reset Filters' }).click();
  await pace(page);

  await page.locator('#idCheckboxShowUSSTGLocations').check();
  await page.locator('#idCheckboxShowOtherLocations').uncheck();
  await pace(page);
}

/**
 * Filters the To Do List to a single OEM part number and selects a matching
 * "Repair <description> (PN: X, SN: Y)" line — reusing the real recorded
 * selectors (`Options...` -> `#idOEMPartNo` -> OK -> click the matching
 * repair link).
 *
 * Deliberately does NOT hardcode any specific part's description text
 * ("WHEEL ASSY, NLG" etc.) — that would only be true for one of the 6 real
 * part numbers and would be exactly the kind of fabrication this project's
 * selectors are supposed to avoid. Instead matches on the fixed structural
 * shape the recording actually showed ("Repair " prefix + "(PN: <partNumber>,
 * SN: <anything>)" suffix) and extracts the serial number from whatever
 * matches, rather than assuming it in advance.
 *
 * `preferredSerialNumber` is optional: when given, selects the line whose
 * extracted serial number matches it exactly (falls back to the first
 * match if not found); when omitted, selects the first matching line —
 * same default behavior as before. Added once live testing repeatedly
 * confirmed a part number can have several open repair lines at once
 * (5013640 has 5 as of this session) — picking a specific one is needed to
 * test more than whichever line happens to be first, e.g. exercising
 * different routing stations for the same part number.
 */
async function navigateToPartGridAndGetCandidates(
  page: Page,
  partNumber: string,
  todoListUrl: string,
): Promise<{ candidates: Locator; candidateCount: number }> {
  await page.goto(todoListUrl);
  await page.getByRole('link', { name: 'Options...' }).click();
  await pace(page);
  await resetOptionsFilters(page);
  await page.locator('#idOEMPartNo').click();
  await pace(page);
  await page.locator('#idOEMPartNo').fill(partNumber);
  // Real discovery from a live failure (not the recording — the recording's
  // non-exact `getByRole('link', { name: 'OK' })` is ambiguous: Playwright's
  // substring match means "OK" also matches any link whose text merely
  // CONTAINS "ok", e.g. real squawk links ending in "...broken" (br-OK-en).
  // A live run against an order whose page also listed several "...broken"
  // task links threw a strict-mode violation. The error output itself
  // revealed this button's real, specific id — used here instead of the
  // ambiguous text match.
  await page.locator('#idButtonOptionsOK').click();
  // Content-aware wait, not a fixed pace() — see gridWait.ts. This was the
  // one of the three grid-read paths with ZERO retry protection until the
  // caller below added it; it now also gets the same definitive-state
  // guarantee as the other two, closing the same business-hours/large-
  // result-set failure class here too.
  await waitForGridResolved(page, partNumber);

  // Deliberately NOT anchored on a "Repair " prefix — see
  // vendorCodeWriteUp.ts's REPAIR_LINK_PATTERN docstring. A work package
  // named anything else (most obviously one renamed to "Scrap ..." by the
  // in-house scrap flow) is still a real work package, and treating it as
  // absent is what caused duplicates to be created over existing ones.
  // The part number stays anchored, which is the safety property that
  // actually matters on this part-filtered grid.
  const repairLinkPattern = new RegExp(`\\(PN: ${escapeRegExp(partNumber)}, SN: [^)]+\\)$`);
  const candidates = page.getByRole('link', { name: repairLinkPattern });
  const candidateCount = await candidates.count();
  return { candidates, candidateCount };
}

/**
 * findNoWorkPackageRowForSerial and createWorkPackageForLine MOVED to
 * shared/createWorkPackage.ts so the vendor-code engine uses this same
 * proven implementation instead of a second copy. Imported above;
 * behaviour here is unchanged.
 */

export async function findFirstRepairLineForPart(
  page: Page,
  partNumber: string,
  todoListUrl: string,
  preferredSerialNumber?: string,
  /**
   * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — defaults to 3
   * (unchanged behavior). processLine.ts passes 1 for a main-pass attempt
   * so the main pass never burns inline backoff on a single line; a
   * retryable failure quarantines immediately and gets the full
   * multi-attempt treatment only on the second pass.
   */
  maxAttempts = 2,
): Promise<RepairLineInfo> {
  // Definite-assignment: always set in one of the two branches below
  // (the if-branch either assigns it before breaking out of its retry
  // loop, or throws before this variable is ever read).
  let candidates!: Locator;
  let chosenLinkText: string | null = null;
  // Addition 1 (Create Work Package) — set true only on the recovery path
  // below, which creates a real work package for a line that had none.
  let workPackageCreated = false;
  let createdWorkPackageName: string | null = null;

  if (preferredSerialNumber) {
    // REAL CAUSE CONFIRMED via captured evidence from a real production
    // run (see retryBackoff.ts's docstring for the full account):
    // sustained continuous automated volume, not a structural DOM issue —
    // this function previously had ZERO retry protection at all, unlike
    // its two batchDiscovery.ts siblings, despite sharing the exact same
    // failure mode (this exact throw fired repeatedly during the same
    // real dense failure cluster). Now retries the whole navigate+search
    // up to 3 times, with a real pause between attempts
    // (`waitBeforeRetry`), before concluding the serial genuinely isn't
    // present — same discipline as findCandidateLinesWithRetry/
    // verifyLineStillEligible. Attempt count is now caller-controlled
    // (`maxAttempts`, default 3) — see this function's own signature
    // docstring for why the main execute pass overrides it to 1.
    const MAX_ATTEMPTS = maxAttempts;
    let lastCandidateCount = 0;
    // Same reasoning as batchDiscovery.ts's two retry loops:
    // navigateToPartGridAndGetCandidates can now throw (an inconclusive
    // grid read that never resolved within waitForGridResolved's 30s), and
    // that throw must survive to the caller on the final attempt rather
    // than being silently treated as "0 candidates, serial not found" —
    // those must only ever mean a confirmed read.
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const result = await navigateToPartGridAndGetCandidates(page, partNumber, todoListUrl);
        candidates = result.candidates;
        const candidateCount = result.candidateCount;
        lastCandidateCount = candidateCount;
        lastError = null;

        for (let i = 0; i < candidateCount; i++) {
          const text = (await candidates.nth(i).innerText()).trim();
          if (text.includes(`SN: ${preferredSerialNumber})`)) {
            chosenLinkText = text;
            break;
          }
        }
        if (chosenLinkText) break;
      } catch (err) {
        lastError = err;
      }
      if (attempt < MAX_ATTEMPTS) await waitBeforeRetry(page, attempt);
    }

    if (!chosenLinkText && lastError) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }

    // REAL BUG FOUND AND FIXED, from a real production batch run: when a
    // specific preferredSerialNumber was requested but not found among
    // this call's own candidates, this used to silently fall through to
    // candidates.first() — a COMPLETELY DIFFERENT line, with no error and
    // no indication a substitution happened. Confirmed live: a batch-execute
    // call explicitly targeting SN `S-DEC22-0869` (already independently
    // verified present in the grid moments earlier by this project's own
    // fresh-eligibility re-check) silently processed SN `APR14-2338`
    // instead — caught only because that fallback line happened to ALSO
    // fail a later safety check (vendor-bid matching); had it not, this
    // would have silently created/authorized/issued/docked a real order
    // against the wrong physical part while the caller believed it was
    // acting on the requested one. Regardless of the exact cause, silently
    // substituting a different line when a SPECIFIC one was requested is
    // never safe — now throws instead, matching the same "refuse to
    // guess" discipline already used by selectVendorRadioForRouting and
    // routeStationToAeroRepairLocation elsewhere in this module. Omitting
    // preferredSerialNumber entirely (the "just pick the first open line"
    // use case) is unaffected — falling back to candidates.first() only
    // happens in that intentional, no-preference case now.
    if (!chosenLinkText) {
      // Addition 1 (Create Work Package) — REPLACES the old "No Work
      // Package (Bad From Stock)" terminal exception: before concluding
      // this serial genuinely isn't findable, check whether it's present
      // as a NO-work-package row instead (a real USSTG inventory row with
      // no "Repair ..." link at all — see batchDiscovery.ts's
      // findNoWorkPackageLinesForPart for the confirmed real shape). If so,
      // create the work package for real, then re-search this same grid —
      // the line should now have a genuine "Repair ..." link this function
      // can proceed with normally.
      const noWorkPackageRow = await findNoWorkPackageRowForSerial(page, partNumber, preferredSerialNumber);
      if (noWorkPackageRow) {
        const { workPackageName } = await createWorkPackageForLine(
          page,
          partNumber,
          preferredSerialNumber,
          noWorkPackageRow.inventoryToken,
          noWorkPackageRow.partDescription,
        );

        // Independent re-verification (standing discipline #3): a FRESH
        // grid read, not trusting whatever page state Create Work
        // Package's own click sequence left behind. The work package must
        // now exist on this exact line, with a name matching the composed
        // string EXACTLY, before proceeding into the task-paste step.
        const reread = await navigateToPartGridAndGetCandidates(page, partNumber, todoListUrl);
        let verifiedLinkText: string | null = null;
        for (let i = 0; i < reread.candidateCount; i++) {
          const text = (await reread.candidates.nth(i).innerText()).trim();
          if (text.includes(`SN: ${preferredSerialNumber})`)) {
            verifiedLinkText = text;
            break;
          }
        }

        if (verifiedLinkText !== workPackageName) {
          throw new Error(
            `work_package_creation_not_confirmed: after creating a work package for ${partNumber}/${preferredSerialNumber}, ` +
              `independent re-verification did not find a repair line whose name exactly matches "${workPackageName}" ` +
              `(found instead: ${verifiedLinkText ?? '(no matching line at all)'}).`,
          );
        }

        candidates = reread.candidates;
        chosenLinkText = verifiedLinkText;
        workPackageCreated = true;
        createdWorkPackageName = workPackageName;
      }
    }

    if (!chosenLinkText) {
      // Evidence capture added after a real "consistent empty read"
      // symptom (reported for 5013640) couldn't be reproduced across 18
      // isolated diagnostic attempts — this is one of the paths that
      // reported symptom could plausibly have gone through instead of the
      // one actually tested (discoverEligibleLines), since this function
      // is used during real write-up execution (batch-execute), a
      // genuinely different code path than discovery's own.
      await captureEmptyReadEvidence(page, 'find-first-repair-line-preferred-serial-not-found', {
        partNumber,
        preferredSerialNumber,
        candidateCount: lastCandidateCount,
      });
      throw new Error(
        `Preferred serial number "${preferredSerialNumber}" was not found among ${lastCandidateCount} candidate line(s) for part ${partNumber} (after ${MAX_ATTEMPTS} attempts), and no no-work-package row matched it either — refusing to silently process a different line instead.`,
      );
    }
  } else {
    const result = await navigateToPartGridAndGetCandidates(page, partNumber, todoListUrl);
    candidates = result.candidates;
  }

  const repairLink = chosenLinkText
    ? page.getByRole('link', { name: chosenLinkText, exact: true })
    : candidates.first();
  const linkText = chosenLinkText ?? (await repairLink.innerText()).trim();

  const serialMatch = linkText.match(/\(PN: [^,]+, SN: ([^)]+)\)/);
  if (!serialMatch) {
    throw new Error(
      `Could not extract a serial number from repair line "${linkText}" for part ${partNumber} — the link's text didn't match the expected "(PN: X, SN: Y)" shape.`,
    );
  }

  // Captured BEFORE clicking away — Removal Information is only visible on
  // this grid row, not on Work Package Details. See shared/removalTaskInfo.ts.
  const removalTask = await extractRemovalTaskInfo(repairLink);

  await repairLink.click();
  // SYSTEMATIC AUDIT FIX: this used to be just pace() before returning —
  // every caller (writeUp.ts, aeroRepairContinueAdHocCli.ts) immediately
  // reads readAssignedTasksAreaText() (a whole-page innerText read) right
  // after this function returns, with no wait of its own. Same
  // vulnerability class as the OEM-grid/vendor-bid/unassigned-tasks reads
  // already fixed this project — see gridWait.ts's
  // waitForWorkPackageDetailsResolved for the full account.
  await waitForWorkPackageDetailsResolved(page);

  return {
    serialNumber: serialMatch[1],
    linkText,
    removalTaskName: removalTask.name,
    removalTaskId: removalTask.id,
    workPackageCreated,
    createdWorkPackageName,
  };
}

/**
 * REAL BUG FOUND AND FIXED via live testing, with real consequences: this
 * originally checked whichever vendor radio was first within the target
 * line's immediate <tr> — which is NOT the same as the vendor matching the
 * computed routing location. The grid's real structure (confirmed via
 * direct DOM inspection): a line's "main" row (containing the repair link,
 * identifiable by also containing "INTERCHG") is followed by one sibling
 * <tr> per vendor bid, until the NEXT line's own main row starts. "First"
 * bid isn't the routed one — a live test confirmed an order's real Vendor
 * ended up "AERO REPAIR - NH" even though routing computed Georgia for
 * that station, because NH happened to be listed first for that
 * particular line.
 *
 * SECOND REAL BUG FOUND AND FIXED, live against production (not stage) —
 * the fix above only walked SIBLING rows after the main row, but the
 * main row's own <tr> also embeds the FIRST vendor bid's own radio
 * (confirmed via direct DOM inspection in an earlier session:
 * radioCount:1 on the main row itself). Whenever the routing-target
 * vendor happens to be that first-listed one — true for a real production
 * line (`5013640` / `AUG04-0967`, DCA -> NH, where NH was the main row's
 * own embedded vendor) — the sibling-only walk never found it and threw,
 * even though a matching bid genuinely existed. Now checks the main row
 * itself first, before walking siblings.
 *
 * Walks the main <tr> then its sibling <tr>s (stopping at the next one
 * containing "INTERCHG"), finds the one whose text contains
 * routingLocation, and clicks its radio via a real DOM click (dispatches a
 * genuine click event, same as `HTMLElement.click()` does per spec).
 * Throws if no vendor bid matches — refusing to guess/default to some
 * other vendor, same discipline as the routing table's own unrecognized-
 * station handling.
 */
export async function selectVendorRadioForRouting(
  page: Page,
  linkText: string,
  routingLocation: string,
): Promise<void> {
  // PART B FIX: this used to read the vendor-bid rows via a single
  // immediate page.evaluate() right after the caller's fixed 750ms
  // pace(), with no wait of its own — the same render-latency class of
  // bug Part A fixed for the three grid-read paths, just never applied
  // here. Content-aware wait first: waits until AT LEAST ONE structurally-
  // valid (radio-bearing) bid row has rendered for this line — see
  // gridWait.ts's waitForVendorBidsResolved.
  //
  // DEFECT 1 REWRITE: this no longer requires the target routingLocation
  // to already be present, or a fixed ">= 4 known vendor locations" count,
  // before proceeding — that hardcoded threshold encoded an assumption
  // (every line has exactly the 4 wheel locations) that real brake lines
  // can violate. Whether THIS SPECIFIC location is among the rendered bids
  // is now a separate classification step below, done once rendering is
  // confirmed complete — a definitively-rendered bid list that genuinely
  // lacks the target location raises "Vendor Bid Not Found" (a real,
  // actionable exception), never an indeterminate-state timeout.
  const rows = await waitForVendorBidsResolved(page, linkText);

  const matchedRow = rows.find((row) => row.hasRadio && row.text.includes(routingLocation));

  if (!matchedRow) {
    // Capture-on-failure, same discipline that made the grid-read bug
    // solvable — a screenshot + raw page text at the exact moment a real,
    // definitively-rendered bid list turns out not to include the target
    // location, so the next real occurrence is diagnosable directly.
    await captureEmptyReadEvidence(page, 'vendor-bid-not-found', {
      linkText,
      routingLocation,
      renderedBidCount: rows.filter((row) => row.hasRadio).length,
      renderedBidText: rows.filter((row) => row.hasRadio).map((row) => row.text),
    });
    throw new Error(
      `Vendor Bid Not Found: no rendered bid row for line "${linkText}" matches routing location "${routingLocation}" ` +
        `among ${rows.filter((row) => row.hasRadio).length} rendered bid row(s) — refusing to guess a different vendor.`,
    );
  }

  // Real DOM click via Playwright's own locator — matches this specific
  // row's own radio input directly, no positional/`.first()` guessing.
  await matchedRow.radio.click();
  await pace(page);
}

/**
 * Rechecks the line checkbox (the recording's lines 23-24 — closing the
 * details view apparently loses the selection) and selects the vendor
 * radio matching the computed routing location, before Schedule Work
 * Package.
 */
export async function recheckRepairLineForSchedule(
  page: Page,
  linkText: string,
  routingLocation: string,
): Promise<void> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');

  await targetTr.locator('input[name="aInventory"]').check();
  await pace(page);

  await selectVendorRadioForRouting(page, linkText, routingLocation);
}

const USAGE_ROW_LABELS = ['CYCLES', 'HOURS'];

/**
 * Zero-usage records-error check: true only if BOTH the CYCLES row and the
 * HOURS row are present AND every one of the 6 values (TSN/TSO/TSI × 2) is
 * exactly zero. Compared numerically (`Number(...) === 0`), not by string
 * equality, so "0", "0.0", "0.00" etc. all correctly count as zero.
 *
 * Deliberately conservative: if either row is missing entirely (a parse
 * miss, or a genuinely different page shape), this returns false rather
 * than guessing — a write-up should never be skipped over a usage check
 * this function couldn't actually confirm. Aero-Repair-specific (binary),
 * left untouched by the shared 3-way classifyUsageTable() built for 0T1Y4
 * — see VENDOR_MODULE_REFACTOR_SPEC.md section 3.3 for why the two are
 * deliberately not unified.
 */
export function isZeroUsage(usageRows: { label: string; tsn: string; tso: string; tsi: string }[]): boolean {
  return USAGE_ROW_LABELS.every((label) => {
    const row = usageRows.find((r) => r.label === label);
    if (!row) return false;
    return Number(row.tsn) === 0 && Number(row.tso) === 0 && Number(row.tsi) === 0;
  });
}

/**
 * Builds the full Notes field value: the real permanent header text, a
 * blank line, then the part-description line, then the Usage Parm table —
 * exactly the structural shape the recording showed (verified against its
 * literal final `.fill()` argument), using the real extracted values passed
 * in rather than the recording's known-wrong stand-in data. Aero-Repair-
 * specific — hardcodes this module's own NOTES_HEADER_TEXT rather than
 * taking one as a parameter; see 0T1Y4's own shared/vendorCodeWriteUp.ts
 * notes composition for the parameterized equivalent.
 */
export function composeAeroRepairNotesText(details: PartOwnDetails): string {
  // CLAUDE_CODE_PROMPT_USAGE_TABLE_BUG.md, required change 4 — defense in
  // depth: shared/partOwnDetails.ts's waitForUsageTableResolved already
  // throws before this function is normally ever reached in the read-
  // failure case (table element found, 0 data rows) — this guard exists so
  // this function can never itself produce a header-only Usage Parm block,
  // independent of whether the upstream wait's own guarantee holds. The
  // genuinely-absent-table case (usageTableFound: false — the pre-existing
  // BN-override state) is deliberately NOT touched here; that's existing,
  // accepted behavior, not the bug this guards against.
  if (details.usageTableFound && details.usageRows.length === 0) {
    throw new Error(
      `usage_table_rows_empty: Usage Parm table for ${details.partNumber}/${details.serialNumber} was found but ` +
        `returned zero data rows — refusing to write a header-only usage block.`,
    );
  }

  const partLine = `${details.partDescription} (PN: ${details.partNumber}, SN: ${details.serialNumber})`;
  const tableHeader = 'Usage Parm\tTSN\tTSO\tTSI';
  const tableRows = details.usageRows.map((row) => `${row.label}\t${row.tsn}\t${row.tso}\t${row.tsi}`);

  return [NOTES_HEADER_TEXT, '', partLine, tableHeader, ...tableRows].join('\n') + '\n';
}
