/// <reference lib="dom" />
import type { Page, Locator } from 'playwright';
import { AERO_REPAIR_ROUTING, NOTES_HEADER_TEXT } from './constants.js';
import { captureEmptyReadEvidence } from './emptyReadCapture.js';
import { waitBeforeRetry } from './retryBackoff.js';
import {
  waitForBodyTextIncludes,
  waitForGridResolved,
  waitForVendorBidsResolved,
  waitForWorkPackageDetailsResolved,
} from './gridWait.js';

const KNOWN_VENDOR_LOCATION_COUNT = new Set(Object.values(AERO_REPAIR_ROUTING)).size;

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

  const repairLinkPattern = new RegExp(`^Repair .*\\(PN: ${escapeRegExp(partNumber)}, SN: [^)]+\\)$`);
  const candidates = page.getByRole('link', { name: repairLinkPattern });
  const candidateCount = await candidates.count();
  return { candidates, candidateCount };
}

export async function findFirstRepairLineForPart(
  page: Page,
  partNumber: string,
  todoListUrl: string,
  preferredSerialNumber?: string,
): Promise<RepairLineInfo> {
  // Definite-assignment: always set in one of the two branches below
  // (the if-branch either assigns it before breaking out of its retry
  // loop, or throws before this variable is ever read).
  let candidates!: Locator;
  let chosenLinkText: string | null = null;

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
    // verifyLineStillEligible.
    const MAX_ATTEMPTS = 3;
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
        `Preferred serial number "${preferredSerialNumber}" was not found among ${lastCandidateCount} candidate line(s) for part ${partNumber} (after ${MAX_ATTEMPTS} attempts) — refusing to silently process a different line instead.`,
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

  await repairLink.click();
  // SYSTEMATIC AUDIT FIX: this used to be just pace() before returning —
  // every caller (writeUp.ts, aeroRepairContinueAdHocCli.ts) immediately
  // reads readAssignedTasksAreaText() (a whole-page innerText read) right
  // after this function returns, with no wait of its own. Same
  // vulnerability class as the OEM-grid/vendor-bid/unassigned-tasks reads
  // already fixed this project — see gridWait.ts's
  // waitForWorkPackageDetailsResolved for the full account.
  await waitForWorkPackageDetailsResolved(page);

  return { serialNumber: serialMatch[1], linkText };
}

/**
 * After clicking the repair line, the recording did NOT go straight to the
 * inventory checkbox — it detoured through "Unassigned" -> "Unassigned
 * Tasks" -> "Close" first (lines 14-18 of the recording). This function
 * replicates the two clicks that get there, WITHOUT replaying the
 * recording's own `page.goto(CheckDetails.jsp?aCheck=...)` calls — those
 * URLs embed an encoded token specific to that one recorded check instance
 * and would be wrong (or fail outright) for a different order/part. Real
 * live testing confirmed the goto-only jump doesn't work: skipping this
 * detour entirely made the next step (finding the inventory checkbox) time
 * out, because the page was never actually in the right state — this
 * navigation is a real prerequisite, independent of any exception check.
 *
 * NOT where the no-tasks-assigned exception is checked (a real correction
 * from an earlier session): this view's own "no open tasks" message is a
 * different, normal/expected state — confirmed live to appear on every
 * real line checked, including ones with genuine assigned work. The real
 * exception check happens BEFORE this function is even called, on the
 * default "Assigned Tasks" tab (see selectors.ts's readAssignedTasksAreaText).
 */
export async function navigateToUnassignedTasksView(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Unassigned' }).click();
  await pace(page);
  await page.getByRole('link', { name: 'Unassigned Tasks' }).click();
  await pace(page);
}

export async function closeUnassignedTasksView(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
}

/**
 * Opens the part's own details view: checks the target line's inventory
 * checkbox and a vendor radio (scoped to the row matching the known-unique
 * repair-link text), then clicks the serial-number link to open the
 * details page.
 *
 * REAL BUG FOUND AND FIXED via live testing (same root cause as
 * selectors.ts's readCurrentLocationCode): this originally used `.first()`
 * on `input[name="aInventory"]` with NO scoping to the target line —
 * silently checking row 1's checkbox/radio regardless of which line
 * findFirstRepairLineForPart had actually selected, whenever a part number
 * has multiple open repair lines (5013640 genuinely does). The final
 * serial-number-link click still targeted the correct line (matched
 * exactly by serialNumber), but the checkbox/radio state leading up to it
 * did not. Now scoped via linkText, same ancestor-of-known-unique-link
 * technique used elsewhere in this module.
 */
export async function openPartOwnDetails(page: Page, linkText: string, serialNumber: string): Promise<void> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');

  await targetTr.locator('input[name="aInventory"]').check();
  await pace(page);

  const vendorRadios = targetTr.getByRole('radio');
  if ((await vendorRadios.count()) > 0) {
    await vendorRadios.first().check();
    await pace(page);
  }

  await page.getByRole('link', { name: serialNumber, exact: true }).click();
  await pace(page);
}

/**
 * Closes the part-details view opened by openPartOwnDetails() — real
 * action from the recording (line 22: "Close"). Lands back on the
 * OEM-part-number-filtered grid.
 */
export async function closePartOwnDetails(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Close' }).click();
  await pace(page);
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
  // here. Content-aware wait first: either the target location is already
  // present, or all KNOWN_VENDOR_LOCATION_COUNT real vendor bids have
  // rendered — see gridWait.ts's waitForVendorBidsResolved.
  await waitForVendorBidsResolved(page, linkText, routingLocation, KNOWN_VENDOR_LOCATION_COUNT);

  const result = await page.evaluate(
    ({ targetLinkText, location }) => {
      const links = Array.from(document.querySelectorAll('a'));
      const targetLink = links.find((a) => a.textContent?.trim() === targetLinkText);
      if (!targetLink) return { found: false, matchedVendorText: null };

      const mainTr = targetLink.closest('tr');
      if (!mainTr) return { found: false, matchedVendorText: null };

      let current: Element | null = mainTr;
      let isMainRow = true;
      while (current && current.tagName === 'TR') {
        const text = current.textContent ?? '';
        if (!isMainRow && text.includes('INTERCHG')) break; // reached the next line's own main row
        if (text.includes(location)) {
          const radio = current.querySelector('input[type="radio"]');
          if (radio) {
            (radio as HTMLInputElement).click();
            return { found: true, matchedVendorText: text.replace(/\s+/g, ' ').trim() };
          }
        }
        current = current.nextElementSibling;
        isMainRow = false;
      }
      return { found: false, matchedVendorText: null };
    },
    { targetLinkText: linkText, location: routingLocation },
  );

  if (!result.found) {
    // PART B: capture-on-failure, same discipline that made the grid-read
    // bug solvable — a screenshot + raw page text at the exact moment a
    // vendor match fails, so the next real occurrence is diagnosable
    // directly instead of needing another live reproduction attempt.
    await captureEmptyReadEvidence(page, 'vendor-bid-not-found', { linkText, routingLocation });
    throw new Error(
      `Could not find a vendor bid matching routing location "${routingLocation}" for line "${linkText}" — refusing to guess a different vendor.`,
    );
  }
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

export interface UsageParmRow {
  /** e.g. "CYCLES" | "HOURS" — as literal a label as the real page shows, not assumed to be only these two. */
  label: string;
  tsn: string;
  tso: string;
  tsi: string;
}

export interface PartOwnDetails {
  partDescription: string;
  partNumber: string;
  serialNumber: string;
  usageRows: UsageParmRow[];
  /**
   * Full raw text of the page at the moment of reading, captured via a
   * direct DOM `.innerText()` call — not the browser's manual mouse-select/
   * copy/paste mechanism (which the user has separately flagged as
   * unreliable on this page; that unreliability is specific to human mouse
   * selection and doesn't apply to reading the DOM directly, same as
   * readNoteToReceiver()'s existing `.innerText()` read on Notes to
   * Receiver). partDescription/usageRows above are only a best-effort
   * parse of this text — this raw field is the ground truth for
   * cross-checking against a real screenshot of the same page.
   */
  rawText: string;
}

const USAGE_ROW_LABELS = ['CYCLES', 'HOURS'];

/**
 * Best-effort parse only — the real structure of this page has not been
 * confirmed yet (this is the first live read of it). Looks for a line
 * starting with one of the known usage-parameter labels followed by
 * whitespace-separated numeric tokens; does NOT assume tab characters
 * (the recording's tab-separated table was typed/pasted by a human into a
 * textarea, not necessarily how this page's own DOM renders it).
 */
function parseUsageRows(rawText: string): UsageParmRow[] {
  const rows: UsageParmRow[] = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    for (const label of USAGE_ROW_LABELS) {
      if (trimmed.toUpperCase().startsWith(label)) {
        const numbers = trimmed
          .slice(label.length)
          .trim()
          .split(/\s+/)
          .filter((token) => /^-?\d+(\.\d+)?$/.test(token));
        if (numbers.length >= 3) {
          rows.push({ label, tsn: numbers[0], tso: numbers[1], tsi: numbers[2] });
        }
      }
    }
  }
  return rows;
}

/**
 * Zero-usage records-error check: true only if BOTH the CYCLES row and the
 * HOURS row are present AND every one of the 6 values (TSN/TSO/TSI × 2) is
 * exactly zero. Compared numerically (`Number(...) === 0`), not by string
 * equality, so "0", "0.0", "0.00" etc. all correctly count as zero.
 *
 * Deliberately conservative: if either row is missing entirely (a parse
 * miss, or a genuinely different page shape), this returns false rather
 * than guessing — a write-up should never be skipped over a usage check
 * this function couldn't actually confirm.
 */
export function isZeroUsage(usageRows: UsageParmRow[]): boolean {
  return USAGE_ROW_LABELS.every((label) => {
    const row = usageRows.find((r) => r.label === label);
    if (!row) return false;
    return Number(row.tsn) === 0 && Number(row.tso) === 0 && Number(row.tsi) === 0;
  });
}

/**
 * Cross-checked live (2026-07-18 session): the raw candidate line reads
 * e.g. "Inventory Details  WHEEL ASSY, NLG (PN: 5013640, SN: JUL14-3229)"
 * — a page-title fragment ("Inventory Details") glued to the front, and
 * the same "(PN: X, SN: Y)" segment composeAeroRepairNotesText() already
 * appends on its own. Left unstripped, that segment got duplicated
 * verbatim in the composed Notes text — confirmed by actually running
 * composeAeroRepairNotesText() with the unstripped value, not just by
 * inspecting the parsing code. Strips both the leading page-title
 * fragment and the trailing "(PN: ..., SN: ...)" suffix, leaving just the
 * clean part name (e.g. "WHEEL ASSY, NLG").
 */
export function extractCleanPartDescription(
  candidateLine: string | undefined,
  partNumber: string,
  serialNumber: string,
): string {
  if (!candidateLine) return '';
  const suffixPattern = new RegExp(
    `\\s*\\(PN:\\s*${escapeRegExp(partNumber)},\\s*SN:\\s*${escapeRegExp(serialNumber)}\\)\\s*$`,
  );
  return candidateLine
    .replace(/^Inventory Details\s+/i, '')
    .replace(suffixPattern, '')
    .trim();
}

/**
 * Reads the part's own details view via direct DOM text extraction
 * (`.innerText()` on the whole page, same technique as
 * mxiWriter/selectors.ts's readNoteToReceiver() and this module's own
 * readAssignedTasksAreaText()) — not the browser's manual copy/paste
 * mechanism. No specific container ID is known for this view yet (the
 * recording only clicked into it and closed it, never reading anything),
 * so this reads the whole page body rather than guessing a container
 * selector, matching this project's rule against fabricating selectors
 * for a page not yet inspected.
 *
 * partNumber/serialNumber are passed in from the caller (already known
 * from findFirstRepairLineForPart) rather than re-parsed from this page.
 * usageRows is a best-effort parse of the raw text; `rawText` is the
 * reliable field for cross-checking against a real screenshot.
 */
export async function readPartOwnDetails(
  page: Page,
  partNumber: string,
  serialNumber: string,
): Promise<PartOwnDetails> {
  // SYSTEMATIC AUDIT FIX: this used to read page.locator('body').innerText()
  // immediately after openPartOwnDetails's click+750ms pace — the same
  // whole-body-read-with-no-wait vulnerability class fixed elsewhere. Waits
  // for the serial number to actually appear in the rendered page before
  // reading — the exact substring this function's own descriptionLine
  // lookup below already depends on being present.
  await waitForBodyTextIncludes(page, serialNumber, `Part own details for ${partNumber}/${serialNumber}`);
  const rawText = await page.locator('body').innerText();

  const descriptionLine = rawText
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.includes(partNumber) && line.includes(serialNumber));

  return {
    partDescription: extractCleanPartDescription(descriptionLine, partNumber, serialNumber),
    partNumber,
    serialNumber,
    usageRows: parseUsageRows(rawText),
    rawText,
  };
}

/**
 * Builds the full Notes field value: the real permanent header text, a
 * blank line, then the part-description line, then the Usage Parm table —
 * exactly the structural shape the recording showed (verified against its
 * literal final `.fill()` argument), using the real extracted values passed
 * in rather than the recording's known-wrong stand-in data.
 */
export function composeAeroRepairNotesText(details: PartOwnDetails): string {
  const partLine = `${details.partDescription} (PN: ${details.partNumber}, SN: ${details.serialNumber})`;
  const tableHeader = 'Usage Parm\tTSN\tTSO\tTSI';
  const tableRows = details.usageRows.map((row) => `${row.label}\t${row.tsn}\t${row.tso}\t${row.tsi}`);

  return [NOTES_HEADER_TEXT, '', partLine, tableHeader, ...tableRows].join('\n') + '\n';
}
