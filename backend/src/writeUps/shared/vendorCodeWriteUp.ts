import type { Page, Locator } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { waitBeforeRetry } from '../aeroRepair/retryBackoff.js';
import {
  AUTH_FLOW_REPAIR,
  resolveAuthFlowPolicy,
  resolveShipsetCase,
  WARRANTY_TERMINAL_STATE_CHARGE_TO_ACCOUNT_SUFFIX,
  type ResolvedAuthFlowPolicy,
  type ShipsetCaseConfig,
  type TerminalState,
  type VendorConfig,
} from './vendorConfig.js';
import { buildChargeToAccountWithSuffix, buildDefaultRepairChargeToAccount } from './chargeToAccount.js';
import { classifyUsageTable } from './usageTable.js';
import {
  createAdHocTaskForCandidate,
  openCreateNewTask,
  readAssignedTasksAreaText,
  readUnassignedTasksAreaText,
  waitForWorkPackageDetailsResolved,
} from './taskRecovery.js';
import {
  clickScheduleWorkPackage,
  confirmScheduleWorkPackage,
  fillChargeToAccount,
  fillNotesToVendor,
  fillPurchasingContact,
  fillReturnToLocation,
  findGeneratedOrderNumber,
  openGeneratedOrder,
  readChargeToAccount,
  readCurrentLocationCode,
  selectConditions,
  selectTransportation,
  transformReturnToLocation,
} from './scheduleWorkPackageForm.js';
import { clickRequestAuthorization, confirmAuthorizationRequest, selectAuthFlow } from './authFlow.js';
import { issueGeneratedOrder, moveOutboundShipmentToDock, readOrderRealState } from './issueAndDock.js';
import {
  isUnassignedTaskPresent,
  navigateToUnassignedTasksView,
  closeUnassignedTasksView,
  waitForUnassignedTasksSectionResolved,
  readUnassignedTaskCandidates,
  assignUnassignedTask,
  detectUnassignedTaskState,
} from './unassignedTasks.js';
import { isNoTasksAssignedException } from '../aeroRepair/noTaskException.js';
import { resetOptionsFilters } from '../aeroRepair/partDetails.js';
import { isAwaitingRequestedAuthorization, parseRowOrderState, readRowCellTexts } from './rowOrderAuthorization.js';
import { closePartOwnDetails, openPartOwnDetails, readPartOwnDetails, type PartOwnDetails, type UsageParmRow } from './partOwnDetails.js';
import { completeCreateOrderOnly, composeAwaitingRmaNote, composeDoNotShipNote, verifyExternalReferenceCommitted, ZERO_USAGE_DO_NOT_SHIP_REASON } from './createOrderOnly.js';
import { closePartDetailsReceivingNotes, openPartDetailsReceivingNotes, readPartDetailsReceivingNotes } from './partDetailsReceivingNotes.js';
import { isRmaVendor } from './rmaVendors.js';
import { buildContractChargeToAccount, detectContractCode, type ContractCode } from './contractCodes.js';
import { evaluateBaseStation } from './approvedLocations.js';
import { readRemovalDate } from './readRemovalDate.js';
import { composeRemovalDateLine } from './removalDate.js';
import { captureVendorCodeGridDiagnostics } from './vendorCodeGridDiagnostics.js';
import { createWorkPackageForLine, findNoWorkPackageRowsOnGrid } from './createWorkPackage.js';
import { extractRemovalTaskInfo, readPreferredVendorIndicator, type PreferredVendorIndicatorState } from './removalTaskInfo.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

const CLICK_DELAY_MS = 750;
const GRID_WAIT_TIMEOUT_MS = 30_000;
const GRID_WAIT_POLL_MS = 250;
const BN_OVERRIDE_ID = 'BN_SERIAL_REPAIR_FLOW';

/**
 * CLAUDE_CODE_PROMPT (mayday, preferred-vendor check disabled) — per
 * explicit user direction: the preferred-vendor check (Addition 3) only
 * behaves correctly for a specific list of part numbers the user doesn't
 * currently have, so it's disabled globally rather than being trusted
 * broadly. This is a single kill-switch, not a removal — every piece of
 * the feature (readPreferredVendorIndicator, the per-candidate read in
 * findCandidateLinesForVendorCodeOnce, the vendor_not_preferred outcome,
 * its DB/UI mapping) stays fully intact and untouched. Flip this back to
 * `true` once the real part-number list exists (and at that point,
 * consider narrowing via config.checkPreferredVendor per-vendor/per-part
 * instead of this all-or-nothing switch, per that field's own docstring
 * in vendorConfig.ts). Deliberately NOT touched per-vendor in the
 * registry — that would mean re-editing every entry to re-enable later,
 * instead of this one line.
 */
const PREFERRED_VENDOR_CHECK_GLOBALLY_ENABLED = true;

/**
 * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — literal
 * fallback for a blank-autofilled Charge To Account, per explicit user
 * direction given after the first live test showed leaving it blank
 * silently prevents order creation. Applies to every vendor in this shared
 * engine's family except Skypaxxx (7A9Y2) — see the doNotShipReason branch
 * below.
 */
const CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK = 'CR7REPAIR';

async function pace(page: Page): Promise<void> {
  await page.waitForTimeout(CLICK_DELAY_MS);
}

/**
 * Generalized from 0T1Y4's own module, per explicit user direction: the
 * process is genuinely identical for every vendor using this same real
 * mechanism (vendor-code search + BN-prefix override + warranty terminal
 * state) — the ONLY thing that varies is which VendorConfig is passed in.
 * 0T1Y4 was the first (and, at the time of this generalization, only)
 * real, live-proven consumer; see shared/vendorRegistry.ts for how new
 * vendors are added (a config entry, not new code).
 */

// ---- Search (moved from 0t1y4/search.ts, unchanged — already generic) ----

/**
 * Real, from discovery-0t1y4-warranty-recording.ts: Options... -> Reset
 * Filters -> location filters -> #idVendorShop fill -> OK.
 *
 * REAL BUG FOUND AND FIXED (2026-08-28) — the cause of "No lines currently
 * found for this vendor" on lines that are plainly still in MXI.
 *
 * This used to click `getByRole('cell', { name: 'When selected, items at
 * USSTG' }).nth(1)`, and the docstring here claimed that was the USSTG
 * control, deliberately NOT reused from aeroRepair's ID-based
 * resetOptionsFilters() because "nothing confirms the two are the same
 * underlying control."
 *
 * They are the same controls, and the cell click was hitting the WRONG one.
 * Probed live against production: MXI puts the identical `title` text
 * ("When selected, items at USSTG type locations will be shown.") on the
 * adjacent DOCK checkbox's cell, so two cells carry that accessible name
 * and `.nth(1)` is the second — `aShowInvDockLocations`
 * (#idCheckboxShowOtherLocations), not USSTG. Observed state through the
 * real sequence:
 *
 *   dialog opens     USSTG=true   Dock=false
 *   Reset Filters    USSTG=true   Dock=TRUE
 *   .nth(1) click    USSTG=true   Dock=FALSE   <- only the Dock box moved
 *
 * So the step that was supposed to guarantee "show USSTG items" never
 * touched USSTG at all. It worked only because USSTG happened to already
 * be on. It is a blind TOGGLE, so its result depends entirely on the state
 * the dialog was already in — and that state persists per session. Any run
 * that started with USSTG off searched with USSTG off, found zero rows,
 * and reported `no_candidate_lines` for a vendor whose lines were sitting
 * right there. That is exactly the intermittency: discovery finds the
 * lines, a later pass does not.
 *
 * Now uses the same idempotent, ID-based helper aeroRepair has always
 * used. `.check()`/`.uncheck()` state the intent instead of toggling, so
 * the end state is identical every time regardless of what came before —
 * and identical between discovery and execute, which is what stops the two
 * from disagreeing.
 */
async function navigateToVendorCodeGrid(page: Page, todoListUrl: string, vendorCode: string): Promise<void> {
  await page.goto(todoListUrl);
  await page.getByRole('link', { name: 'Options...' }).click();
  await pace(page);
  // Same end state the cell click produced on a good run (USSTG shown, Dock
  // hidden) — but asserted rather than toggled into.
  await resetOptionsFilters(page);
  await page.locator('#idVendorShop').click();
  await pace(page);
  await page.locator('#idVendorShop').fill(vendorCode);
  await pace(page);
  // REAL BUG FOUND AND FIXED, caught live in production by a read-only
  // listing diagnostic before this ever reached a write call: the raw
  // recorded getByRole('link', { name: 'OK' }) is a substring match, and
  // this same Options dialog's real page also has unrelated task links
  // whose text contains "ok" (e.g. "...broken" — br-OK-en), causing a
  // strict-mode violation. Same known issue already fixed in
  // aeroRepair/partDetails.ts's navigateToPartGridAndGetCandidates — the
  // error output confirmed the real element id is identical:
  // #idButtonOptionsOK, the same Options dialog shared by every vendor's
  // search flow.
  await page.locator('#idButtonOptionsOK').click();
  await waitForVendorCodeGridResolved(page, vendorCode);
}

/**
 * Content-aware wait: either a real per-line row or the page's own "no
 * inventory" empty-state text. Not scoped to one known part number — a
 * vendor-code search can return lines for ANY part number.
 *
 * REAL BUG FOUND AND FIXED, per CLAUDE_CODE_PROMPT_GRID_WAIT_FIX.md's own
 * evidence-first sequencing (evidence capture shipped first; this
 * predicate change only happened after real evidence, below, confirmed
 * the actual cause — not the document's own MOD/ADREQ/CALREQ hypothesis,
 * which real evidence did NOT support): the predicate previously required
 * a "Repair "-prefixed link, generalized from a two-vendor sample (Aero
 * Repair, 0T1Y4) where every real row happened to have a work package
 * already. Live evidence captured against vendor 21844 in production
 * (data/diagnostics/grid-wait-21844-*) showed a REAL row genuinely
 * present — "BOOSTER PUMP PRESSURE | D98C08-607 | ... | [blank Work
 * Package] | ... | 21844 (BARFIELD INSTRUMENT CORP) | REPAIR | APPROVED"
 * — with a completely blank Work Package column, so it never matched the
 * "Repair ..." pattern, wasn't "no inventory" either, and hung the full
 * 30s. This is the EXACT same real phenomenon already discovered and
 * handled for Aero Repair (see aeroRepair/batchDiscovery.ts's
 * findNoWorkPackageLinesForPart docstring — "a real USSTG inventory row
 * can have a completely BLANK Work Package column... while still being a
 * genuine, real open inventory row"), just never generalized to this
 * vendor-code family. Fixed the same structural way Aero Repair's own
 * grid-resolved check does: any real per-line row has `input[name=
 * "aInventory"]` regardless of whether it has a work package yet — check
 * for that instead of requiring the work-package-specific link pattern.
 * findCandidateLinesForVendorCodeOnce (below) still only returns rows that
 * DO have a real "Repair ..." link as eligible candidates — a real row
 * with no work package correctly resolves to "0 eligible candidates" for
 * this vendor, a legitimate zero, not an indeterminate hang.
 */
export async function waitForVendorCodeGridResolved(page: Page, vendorCode: string): Promise<void> {
  const start = Date.now();
  let resolutionReason: 'real_row' | 'no_inventory' = 'real_row';
  try {
    await page.waitForFunction(
      () => {
        // REAL BUG FOUND AND FIXED (2026-09-04) — the cause of "the read is
        // only picking up a couple of lines".
        //
        // MXI ships this grid with the table styled `visibility: hidden` and
        // reveals it from a jQuery ready handler:
        //
        //   jQuery('#idTableUnserviceableStaging_encapsulatingTable')
        //     .css('visibility','visible');
        //
        // The rows are in the DOM BEFORE that runs. This predicate used to
        // require only that `input[name="aInventory"]` existed, so it could
        // return during that window — and the caller then read the grid with
        // getByRole, which matches the ACCESSIBILITY TREE and excludes
        // anything `visibility: hidden`. Net effect: a CSS count of 8 real
        // rows alongside 0 findable repair links, i.e. lines silently
        // missing from the read while sitting plainly in MXI.
        //
        // Measured live: at the moment of submit the table reads
        // visibility=hidden with 0 accessible links; ~500ms later it is
        // visible with all 8. Waiting for the table to actually be shown
        // closes that window at its source, rather than each reader
        // compensating for it.
        const table = document.querySelector('#idTableUnserviceableStaging_encapsulatingTable');
        const tableShown = !table || getComputedStyle(table).visibility !== 'hidden';
        const hasRealRow = document.querySelectorAll('input[name="aInventory"]').length > 0 && tableShown;
        const bodyText = document.body?.innerText ?? '';
        return hasRealRow || bodyText.includes('no inventory');
      },
      undefined,
      { timeout: GRID_WAIT_TIMEOUT_MS, polling: GRID_WAIT_POLL_MS },
    );
    resolutionReason = (await page.locator('input[name="aInventory"]').count()) > 0 ? 'real_row' : 'no_inventory';
  } catch (err) {
    // Evidence capture BEFORE throwing, per
    // CLAUDE_CODE_PROMPT_GRID_WAIT_FIX.md item 1 — converts an opaque hang
    // into hard, inspectable evidence (row count, first rows' text, full
    // grid text, overlay/dialog presence, screenshot, HTML dump) rather
    // than a bare timeout message. Best-effort — never masks the real
    // error even if capture itself fails.
    await captureVendorCodeGridDiagnostics(page, vendorCode);
    throw new Error(
      `Vendor-code grid for vendor "${vendorCode}" did not resolve to a definitive state (no real inventory row ` +
        `AND no "no inventory" empty-state text) within ${GRID_WAIT_TIMEOUT_MS}ms — refusing to treat this ` +
        `as a genuine empty result. Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log.debug(
    { vendorCode, durationMs: Date.now() - start, resolutionReason },
    '[grid-wait] vendor-code grid resolved',
  );
}

export interface VendorCodeCandidateLine {
  partNumber: string;
  /** The real serial number, OR for a BN-prefix line, the full "BN NNNNNN" value. */
  serialNumber: string;
  linkText: string;
  /** True if this line's link text used the "BN:" label instead of "SN:". */
  isBnLine: boolean;
  /**
   * The row's own real "Removal Information > Task > Name" — confirmed via
   * direct DOM inspection (discovery-inspectRemovalInfoAndNoTask.ts against
   * real production line 861CA01/957): a `td.longString` cell containing
   * an `<a href=".../TaskDetails.jsp?aTask=<token>">`, immediately followed
   * by a `td.shortString` cell with an `<a>` to the SAME `aTask=<token>`
   * whose text is the real Task ID (see `removalTaskId` below). This is
   * DIFFERENT from the Work Package/Check ID
   * (extractWorkPackageCheckId reads that from the Assigned Tasks tab's
   * title line instead) — two genuinely different real MXI fields,
   * confirmed distinct on the same real line (Task ID "TRFKE00GY46E" vs.
   * Check ID "TRFKE00GY4KC"). Null if this row's Removal Information
   * genuinely has no Task Name (rare per explicit user confirmation, but
   * not assumed impossible — never guessed, never fabricated).
   */
  removalTaskName: string | null;
  /** The Removal Information Task ID paired with removalTaskName — see its docstring. */
  removalTaskId: string | null;
  /**
   * The line's own "<STATION>/<CODE>" location, read off the grid row at
   * discovery time. Null when the row carries no readable location token.
   * Feeds the approved-base check (approvedLocations.ts) so a line at a
   * base PSA does not create orders out of is skipped before it is ever
   * offered for write-up.
   */
  currentLocation: string | null;
  /**
   * True for a real USSTG inventory row that has NO work package yet (no
   * "Repair ..." link at all). Such a row used to be dropped silently by
   * findCandidateLinesForVendorCodeOnce, so the vendor resolved to "0
   * eligible candidates" — 15 real `no_candidate_lines` outcomes in the
   * two weeks before this was fixed. It is now surfaced as a genuine
   * candidate; runVendorCodeWriteUp creates the work package for real,
   * re-reads the grid to confirm it, and then continues normally. The
   * other fields on such a candidate are necessarily placeholders until
   * that happens: there is no repair link to derive linkText from, and
   * Removal Information is only readable from the repair link's own row
   * cells, so both are filled in from the post-creation re-read.
   */
  needsWorkPackage?: boolean;
  /** Only set when needsWorkPackage — the unique aInventory token createWorkPackageForLine locates the row by. */
  noWorkPackageInventoryToken?: string;
  /** Only set when needsWorkPackage — the Work Package name's description part. */
  noWorkPackagePartDescription?: string;
  /**
   * Preferred-vendor check (Addition 3) — read from the SAME row, at the
   * SAME time as removalTaskName/removalTaskId above, while still on the
   * grid (the checkbox this reads does not exist once the line is opened).
   * See readPreferredVendorIndicator's own docstring for the tri-state
   * meaning. Read for every candidate regardless of config.checkPreferredVendor
   * — cheap, and keeps the read itself unconditional; only the DECISION to
   * act on it is config-gated, in runVendorCodeWriteUp below.
   */
  preferredVendorState: PreferredVendorIndicatorState;
}

/**
 * Matches a work-package link on the grid and pulls its part number and
 * serial (or BN) out of the name.
 *
 * BROADENED 2026-08-25, per explicit user direction that any value in the
 * Work Package column means a work package exists and the line should be
 * written up. This used to be anchored `/^Repair .*\(PN: ...\)$/`, so a
 * package named anything else was invisible here — and, separately,
 * invisible to the no-work-package scanner too, which is why a duplicate
 * package got created on top of a real one. The most obvious case is a
 * package this suite itself renames to "Scrap ..." during an in-house
 * scrap, but nothing guarantees "Repair " is the only prefix MXI or an
 * analyst ever uses.
 *
 * Only the "(PN: X, SN|BN: Y)" suffix is required now. That is safe on
 * this grid specifically: the real captured row
 * (data/diagnostics/grid-wait-21844-*.html) shows its only other links are
 * Part No, Serial No, Owner, Location, Special Handling and the vendor —
 * none of which end in that suffix — so the work-package cell's link
 * remains the only thing this can match.
 */
const REPAIR_LINK_PATTERN = /\(PN: ([^,]+), (SN|BN): ([^)]+)\)$/;

/**
 * The "<STATION>/<CODE>" location token from a candidate's own grid row.
 *
 * Same row-scoped approach and same case-insensitive pattern as
 * scheduleWorkPackageForm.ts's readCurrentLocationCode (MXI's location
 * casing genuinely varies by site — DFW/REPAIR1/SHOP1 alongside
 * PNS/Repair1/Shop1). Differs in one deliberate way: it returns null
 * instead of throwing, because at DISCOVERY an unreadable location must
 * become a visible skipped line with a reason, not an aborted vendor.
 */
async function readRowLocationCode(repairLink: Locator): Promise<string | null> {
  try {
    const rowText = await repairLink.locator('xpath=ancestor::tr[1]').innerText();
    const match = rowText.match(/\b([A-Za-z]{3})\/([A-Za-z0-9]+)\b/);
    return match ? `${match[1]}/${match[2]}` : null;
  } catch {
    return null;
  }
}

async function findCandidateLinesForVendorCodeOnce(
  page: Page,
  todoListUrl: string,
  vendorCode: string,
): Promise<VendorCodeCandidateLine[]> {
  await navigateToVendorCodeGrid(page, todoListUrl, vendorCode);

  // How many real inventory lines the grid is actually showing. Read FIRST,
  // and kept, so a zero-candidate result can be judged against it below:
  // "the grid was empty" and "the grid had rows we failed to read" are
  // different facts and must never collapse into the same report.
  const realRowCount = await page.locator('input[name="aInventory"]').count();

  // The empty-state text is only believed when the grid also genuinely has
  // no rows. It used to be a bare substring test over the whole body, which
  // would return "no lines" for a page that had real rows AND that phrase
  // somewhere in it.
  const bodyText = await page.locator('body').innerText();
  if (bodyText.includes('no inventory') && realRowCount === 0) return [];

  const repairLinks = page.getByRole('link', { name: REPAIR_LINK_PATTERN });
  const count = await repairLinks.count();

  const candidates: VendorCodeCandidateLine[] = [];
  /** Lines skipped because an order already exists and is awaiting authorization. */
  const excludedAwaitingAuthorization: string[] = [];
  for (let i = 0; i < count; i++) {
    const linkText = (await repairLinks.nth(i).innerText()).trim();
    const match = linkText.match(REPAIR_LINK_PATTERN);
    if (!match) continue;

    // Per the analyst (2026-09-04): a line that already has an order whose
    // authorization is still only REQUESTED is not a candidate — the order
    // exists and is waiting on someone else, so writing it up again would
    // duplicate work already in flight. Both conditions are required; see
    // rowOrderAuthorization.ts.
    const orderState = parseRowOrderState(await readRowCellTexts(repairLinks.nth(i)));
    if (isAwaitingRequestedAuthorization(orderState)) {
      excludedAwaitingAuthorization.push(`${match[1]}/${match[3]} (${orderState.orderNumber})`);
      continue;
    }

    const removalTask = await extractRemovalTaskInfo(repairLinks.nth(i));
    const preferredVendorState = await readPreferredVendorIndicator(repairLinks.nth(i));
    // Read off the SAME row, at the same time, so DISCOVERY can decide
    // whether PSA even creates orders out of this base. Without it a
    // non-approved base could only be caught at execute time, after a run
    // slot had already been spent on the line.
    const currentLocation = await readRowLocationCode(repairLinks.nth(i));

    candidates.push({
      partNumber: match[1],
      serialNumber: match[3],
      linkText,
      isBnLine: match[2] === 'BN',
      removalTaskName: removalTask.name,
      removalTaskId: removalTask.id,
      preferredVendorState,
      currentLocation,
    });
  }

  // REAL SKIP FOUND AND FIXED (2026-08-24), per explicit user direction:
  // "The MXI writer is still skipping items with no work package."
  //
  // Only rows carrying a real "Repair ..." link were ever collected above,
  // so a genuine USSTG inventory row with a blank Work Package column was
  // dropped here without a trace — not flagged, not counted, absent from
  // every report. For a vendor whose open rows were ALL in that state, the
  // whole vendor resolved to `no_candidate_lines` (15 real occurrences in
  // the two weeks before this fix).
  //
  // Aero Repair already handled exactly this (batchDiscovery.ts's
  // findNoWorkPackageLinesForPart, then partDetails.ts creating the work
  // package for real); the mechanism was simply never generalized to this
  // vendor-code family. It is now shared outright — see
  // shared/createWorkPackage.ts, whose header docstring cites the real
  // captured vendor-code grid that confirms the row shape.
  const noWorkPackageRows = await findNoWorkPackageRowsOnGrid(page);
  for (const row of noWorkPackageRows) {
    candidates.push({
      partNumber: row.partNumber,
      serialNumber: row.serialNumber,
      // No repair link exists yet by definition. Both of these are filled
      // in from the post-creation grid re-read, never guessed.
      linkText: '',
      isBnLine: false,
      removalTaskName: null,
      removalTaskId: null,
      // The preferred-vendor checkbox lives on the repair link's own row
      // cells, so it cannot be read yet. 'not_found' is the honest value;
      // it is re-read after creation, before any decision uses it.
      preferredVendorState: 'not_found',
      needsWorkPackage: true,
      currentLocation: row.currentLocation,
      noWorkPackageInventoryToken: row.inventoryToken,
      noWorkPackagePartDescription: row.partDescription,
    });
  }
  if (noWorkPackageRows.length > 0) {
    log.info(
      { vendorCode, count: noWorkPackageRows.length },
      '[work-package] found real inventory row(s) with no work package — will create before writing up',
    );
  }

  // THE SILENT-DROP GUARD, per the analyst's requirement that finding lines
  // succeed 100% of the time even when nothing can be done with them.
  //
  // Rows exist on the grid but neither extractor produced a candidate: the
  // repair-link suffix did not match and the row did not read as
  // work-package-less. That is OUR failure to read the grid, not an empty
  // vendor — and reporting it as "No lines currently found" tells the
  // analyst something false about MXI. Captured with evidence so the next
  // occurrence is diagnosable instead of anecdotal.
  if (excludedAwaitingAuthorization.length > 0) {
    log.info(
      { vendorCode, count: excludedAwaitingAuthorization.length, lines: excludedAwaitingAuthorization },
      '[vendor-grid] lines skipped — an order already exists and its authorization is still REQUESTED',
    );
  }

  // The excluded count is subtracted deliberately: a vendor whose every row
  // is legitimately awaiting authorization is NOT a locator failure, and
  // throwing there would turn a correct, expected outcome into an error.
  if (candidates.length === 0 && excludedAwaitingAuthorization.length === 0 && realRowCount > 0) {
    const rowText = await page
      .locator('tr:has(input[name="aInventory"])')
      .allInnerTexts()
      .catch(() => [] as string[]);
    await captureVendorCodeGridDiagnostics(page, `${vendorCode}-unreadable-rows`);
    throw new Error(
      `Vendor "${vendorCode}" grid shows ${realRowCount} real inventory row(s), but none could be read as a ` +
        `candidate line. This is a locator failure, not an empty vendor — the lines are in MXI. First row text: ` +
        `${JSON.stringify(rowText[0]?.replace(/\s+/g, ' ').trim().slice(0, 220) ?? '(unreadable)')}`,
    );
  }

  return candidates;
}

/**
 * REAL BUG FOUND AND FIXED, discovered live in production during 0T1Y4's
 * first-ever watched run: this search had zero retry protection, unlike
 * every one of aeroRepair/batchDiscovery.ts's equivalent candidate
 * searches — the same "consistent empty read" failure class already
 * root-caused for Aero Repair (MXI server latency under real concurrent
 * load, scaled by result-set size). Fixed the same proven way: only
 * trusts an empty result once 3 consecutive attempts, with a real pause
 * between them, all agree.
 */
export async function findCandidateLinesForVendorCode(
  page: Page,
  todoListUrl: string,
  vendorCode: string,
): Promise<VendorCodeCandidateLine[]> {
  // Restored to 2 on 2026-08-28 (3 was too slow in practice). It had been set to 1, which left the
  // retry loop and its backoff as dead code — a vendor whose grid answered
  // slowly got exactly one chance and then reported "no lines found". The
  // search is read-only and idempotent, so re-running it costs nothing but
  // time and removes a whole class of one-shot timing failures.
  const MAX_ATTEMPTS = 2;
  let lastResult: VendorCodeCandidateLine[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    lastResult = await findCandidateLinesForVendorCodeOnce(page, todoListUrl, vendorCode);
    if (lastResult.length > 0) return lastResult;
    if (attempt < MAX_ATTEMPTS) {
      log.info({ vendorCode, attempt }, '[vendor-grid] no candidates found — re-running the search before believing it');
      await waitBeforeRetry(page, attempt);
    }
  }

  // Every attempt came back empty AND the grid positively said so each
  // time. Believable, but still captured: "this vendor genuinely has no
  // open lines" is a claim about real work, and the analyst has been
  // burned by it being wrong.
  log.warn(
    { vendorCode, attempts: MAX_ATTEMPTS },
    '[vendor-grid] vendor reported empty after every attempt — capturing the grid for review',
  );
  await captureVendorCodeGridDiagnostics(page, `${vendorCode}-reported-empty`);
  return lastResult;
}

export async function openVendorCodeCandidate(page: Page, candidate: VendorCodeCandidateLine): Promise<void> {
  await page.getByRole('link', { name: candidate.linkText, exact: true }).click();
  await pace(page);
}

/**
 * Re-checks the target candidate's own row checkbox + radio right before
 * Schedule Work Package — mirrors the real recording's post-details-close
 * re-selection. NOT reusing Aero Repair's recheckRepairLineForSchedule():
 * that function also performs routing-based vendor-BID matching, a concept
 * that doesn't exist for a vendor-code search — its candidates are already
 * uniquely identified, confirmed via both real recordings to have exactly
 * one radio per row.
 */
async function recheckCandidateForSchedule(page: Page, candidate: VendorCodeCandidateLine): Promise<void> {
  const repairLink = page.getByRole('link', { name: candidate.linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  await targetTr.locator('input[name="aInventory"]').check();
  await pace(page);
  const radios = targetTr.getByRole('radio');
  if ((await radios.count()) > 0) {
    await radios.first().check();
    await pace(page);
  }
}

/**
 * CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case) — reads the "Task"
 * column's own text from the target line's HOME-PAGE grid row, BEFORE the
 * line is ever opened. Explicit requirement: the task name inside the work
 * package can be blank, so it must be read from here, not from inside.
 *
 * GUESSED / UNCONFIRMED SHAPE: discovery-7A9Y2-AJS-sn-recording.ts only
 * captures this row's FLATTENED accessible-name text (a single
 * getByRole('row', {name: '...'}) match), not its real HTML — so the exact
 * cell boundary for "Task" (vs. the adjacent Aircraft/Inventory, Work
 * Package No, and Last Turn In Date columns in the same row) is inferred
 * from that one example's own shape, not independently confirmed via raw
 * DOM inspection the way most other selectors in this project are. The
 * recorded row read: "...WO - 46716438 TO_25-079-005-22-JIC (SEAT REFRESH -
 * REMOVE AND INSTALL SEATS) TRFKE009A60X UNSCHED 06-AUG-2026 07:37 EDT" —
 * this regex anchors on the "WO - <digits>" token immediately before the
 * task name and a "TRFKE..."-shaped Work Package No token immediately
 * after it (the same real ID prefix confirmed on every other real Work
 * Package/Check ID seen elsewhere in this project). Flag this for
 * confirmation before trusting it against a line whose real row text
 * deviates from this one example's shape.
 */
const USSTG_TASK_NAME_PATTERN = /WO - \d+\s+(.+?)\s+TRFKE[A-Z0-9]+\s+\S+\s+\d{2}-[A-Z]{3}-\d{4}/;

export async function readUsstgLineTaskName(page: Page, linkText: string): Promise<string | null> {
  const repairLink = page.getByRole('link', { name: linkText, exact: true });
  const targetTr = repairLink.locator('xpath=ancestor::tr[1]');
  const rowText = (await targetTr.innerText()).replace(/\s+/g, ' ').trim();
  const match = rowText.match(USSTG_TASK_NAME_PATTERN);
  return match ? match[1].trim() : null;
}

// ---- Notes composition (moved from 0t1y4/notes.ts, parameterized) ----

/** Confirmed correct: header line + blank line + part description + Usage Parm table. */
export function composeNotesForNormalLine(
  details: PartOwnDetails,
  notesHeader: string,
  /**
   * Aerotron only, per explicit user direction (2026-08-27): the exact
   * wording "Removal date: DD-MMM-YYYY", sitting directly above the times
   * and cycles table. Undefined for every other vendor, whose note stays
   * byte-for-byte what it was.
   */
  removalDateLine?: string,
): string {
  const partLine = `${details.partDescription} (PN: ${details.partNumber}, SN: ${details.serialNumber})`;
  const tableHeader = 'Usage Parm\tTSN\tTSO\tTSI';
  const tableRows = details.usageRows.map((row) => `${row.label}\t${row.tsn}\t${row.tso}\t${row.tsi}`);
  const middle = removalDateLine ? [partLine, removalDateLine] : [partLine];
  return [notesHeader, '', ...middle, tableHeader, ...tableRows].join('\n') + '\n';
}

/** Confirmed correct as recorded: header-only, no description line even though PN/SN are available. */
export function composeNotesForBnLine(notesHeader: string): string {
  return `${notesHeader}\n`;
}

// ---- Orchestrator (moved from 0t1y4/writeUp.ts, parameterized by config) ----

export interface VendorCodeWriteUpFields {
  partNumber: string;
  serialNumber: string;
  isBnLine: boolean;
  purchasingContact: string;
  returnToLocation: string;
  conditions: string;
  transportation: string;
  chargeToAccountBefore: string;
  chargeToAccountAfter: string;
  notesText: string;
  generatedOrderNumber: string;
  authFlow: string;
  /**
   * True when this line had a genuine unassigned task that was assigned
   * automatically in the same pass. Kept auditable because the line no
   * longer stops for it -- without this, an assignment would be invisible
   * in the outcome record.
   */
  unassignedTaskWasAssigned: boolean;
  /**
   * True when this line had no work package and one was created
   * automatically in the same pass. Same reasoning as
   * unassignedTaskWasAssigned above: the line no longer stops for it, so
   * without this the creation would be invisible in the outcome record.
   */
  workPackageWasCreated: boolean;
}

export type VendorCodeWriteUpOutcome =
  | { status: 'authorized_only'; fields: VendorCodeWriteUpFields }
  | { status: 'issued_and_docked'; fields: VendorCodeWriteUpFields; shipmentId: string | null }
  /**
   * CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 5) — a genuinely
   * distinct terminal state from both of the above: the order WAS issued,
   * but Move to Dock was deliberately skipped this run (a temporary safety
   * measure, config-gated — see ShipsetCaseConfig.moveToDockOnInitialRun).
   * Never reused for a real dock FAILURE (that stays 'error', thrown) —
   * this status means the skip was intentional and the order is otherwise
   * healthy, so a caller can't mistake this for either "fully done" or "a
   * problem occurred."
   */
  | { status: 'issued_not_docked'; fields: VendorCodeWriteUpFields }
  /**
   * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — the RO was
   * created (Schedule Work Package ran normally, real Note To Vendor
   * written) but Request Authorization/Issue Order/Move to Dock were never
   * reached — structurally, not via a skippable check. `reason` and
   * `externalReferenceNote` are composed from the SAME string (see
   * shared/createOrderOnly.ts) so the audit trail and the real MXI field
   * can never drift apart.
   */
  | {
      status: 'order_created_do_not_ship';
      fields: VendorCodeWriteUpFields;
      reason: string;
      externalReferenceNote: string;
      /**
       * The part's usage table, carried ONLY when the reason is zero times
       * and cycles.
       *
       * REAL GAP THIS CLOSES (2026-08-28). When "Create Order Only" was
       * added, a zero-usage line on a USSTG line stopped returning the
       * `zero_usage` outcome and started returning this one instead. That
       * was the intended MXI behaviour — but it silently took the
       * Maintenance Records email draft with it, because the draft button
       * is offered on zero-usage events and needs these rows. `zero_usage`
       * has not fired since 2026-08-07, and effectively every line here is
       * USSTG, so the notification simply stopped happening.
       *
       * What to do in MXI and who to tell about bad data are separate
       * concerns; the redirect should only ever have changed the first.
       */
      zeroUsageRows?: UsageParmRow[];
      /** The part's Barcode, carried alongside zeroUsageRows for the records email. */
      zeroUsageBarcode?: string | null;
    }
  /**
   * CLAUDE_CODE_PROMPT (#1, RMA framework) — a genuinely distinct terminal
   * state from order_created_do_not_ship above: gated on vendor MEMBERSHIP
   * (isRmaVendor), not a per-line data condition, and stops at the same
   * point (right after Schedule Work Package -> OK, before Request
   * Authorization). Dormant this batch — RMA_VENDOR_IDS is empty, see
   * shared/rmaVendors.ts.
   */
  | { status: 'order_created_awaiting_rma'; fields: VendorCodeWriteUpFields; externalReferenceNote: string }
  | { status: 'no_candidate_lines'; vendorCode: string }
  /**
   * The vendor requires a removal date in its Note To Vendor, but the
   * event history could not be READ. Distinct from a history that simply
   * holds no removal event, which is a legitimate answer and gets the
   * placeholder instead.
   */
  | { status: 'removal_date_unreadable'; partNumber: string; serialNumber: string; reason: string }
  /**
   * The line's base is not one PSA creates repair orders out of.
   * Discovery already filters these, so reaching here means the line was
   * selected from an older snapshot — re-checked rather than trusted.
   */
  | { status: 'base_not_approved'; partNumber: string; serialNumber: string; currentLocation: string | null; reason: string }
  /**
   * CLAUDE_CODE_PROMPT (Addition 3, preferred-vendor check) — a legitimate,
   * expected business outcome, not an error: another vendor is preferred
   * for this part, so this vendor's bid is skipped before any write.
   * Read-only, no order created, no fields filled.
   */
  | { status: 'vendor_not_preferred'; partNumber: string; serialNumber: string }
  | { status: 'unassigned_task_present'; partNumber: string; serialNumber: string; taskDetail: string }
  | { status: 'no_removal_task_info_found'; partNumber: string; serialNumber: string }
  /**
   * CLAUDE_CODE_PROMPT (email-maintenance-records button, 2026-08-14) —
   * usageRows added per explicit user instruction, so the frontend can
   * build a plain-text times/cycles table for the new "email Maintenance
   * Records" draft button without re-reading MXI. Same UsageParmRow shape
   * already used everywhere else this table is read/composed
   * (shared/partOwnDetails.ts).
   */
  | { status: 'zero_usage'; partNumber: string; serialNumber: string; usageRows: UsageParmRow[] }
  | { status: 'usage_table_absent_unexpected'; partNumber: string; serialNumber: string }
  /**
   * CLAUDE_CODE_PROMPT (new vendor batch, 2026-08-14) — per explicit user
   * instruction: "If anything comes up in the part notes that reads in the
   * word 'account', flag it and move on. I don't want wrong accounts."
   * Fires only for vendors with hasPartDetailsStep set, checked BEFORE
   * Schedule Work Package is clicked — no order is created for this line,
   * same "refuse to guess" discipline as usage_table_absent_unexpected
   * above. A case-insensitive plain substring match on the real receiving-
   * notes text (shared/partDetailsReceivingNotes.ts), not a keyword list —
   * the instruction was specifically "the word 'account'".
   */
  | { status: 'receiving_notes_flagged_account'; partNumber: string; serialNumber: string; receivingNotes: string }
  | {
      status: 'authorization_not_confirmed';
      partNumber: string;
      serialNumber: string;
      orderNumber: string;
      realAuthorizationStatus: string | null;
    }
  | { status: 'error'; partNumber: string | null; serialNumber: string | null; errorMessage: string };

/**
 * Generic vendor-code-search write-up flow. `preferredSerialNumber` selects
 * a specific candidate (refuses to silently substitute a different line,
 * same discipline as Aero Repair's findFirstRepairLineForPart); omitted
 * picks the first candidate found for this vendor's code.
 *
 * BN-prefix lines (per resolveAuthFlowPolicy's matched override) replay
 * the BN recording's own real sequence: Create New Task -> Ad-Hoc Task
 * creation UNCONDITIONALLY right after opening the line. Normal lines
 * replay the warranty recording's own sequence: the Unassigned Tasks
 * detour, actually checked (not just clicked through) via
 * isUnassignedTaskPresent.
 *
 * Authorization-status expectations differ deliberately by flow, per
 * explicit user correction after 0T1Y4's first live runs: the BN/REPAIR
 * flow mirrors Aero Repair's own REPAIR authorization (retries seeking a
 * real, synchronous APPROVED within the session); the WARRANTY flow
 * accepts REQUESTED as its correct terminal state — the external
 * vendor/manufacturer approval that would move it to APPROVED happens
 * outside this session, on its own timeline, and retrying past REQUESTED
 * is actively wrong (the "Request Authorization" link genuinely
 * disappears once a request is already in flight).
 */
export async function runVendorCodeWriteUp(
  client: MxiClient,
  config: VendorConfig,
  preferredSerialNumber?: string,
): Promise<VendorCodeWriteUpOutcome> {
  let knownPartNumber: string | null = null;
  let knownSerialNumber: string | null = preferredSerialNumber ?? null;
  /** True once this line's missing work package was created and verified in this same pass. */
  let workPackageWasCreated = false;
  let receivingNotes: string | null = null;
  function setWaiveTimes(receivingNotes: string | null): boolean {

    return (receivingNotes ?? '').includes(
        'UNIT CAN BE SENT OUT WITH 0 TIMES AND CYCLES'
    );
  }

  try {
    const page: Page = await client.getAuthenticatedPage();
    const vendorCode = config.search.kind === 'vendorCode' ? config.search.vendorCode : '';

    const candidates = await findCandidateLinesForVendorCode(page, client.todoListUrl, vendorCode);
    if (candidates.length === 0) {
      return { status: 'no_candidate_lines', vendorCode };
    }

    let candidate: VendorCodeCandidateLine | undefined;
    if (preferredSerialNumber) {
      candidate = candidates.find((c) => c.serialNumber === preferredSerialNumber);
      if (!candidate) {
        throw new Error(
            `Preferred serial number "${preferredSerialNumber}" was not found among ${candidates.length} candidate ` +
            `line(s) for vendor ${vendorCode} — refusing to silently process a different line instead.`,
        );
      }
    } else {
      candidate = candidates[0];
    }
    knownPartNumber = candidate.partNumber;
    knownSerialNumber = candidate.serialNumber;

    // No work package on this line yet — create one for real, then carry
    // on as an ordinary line. Mirrors Aero Repair's own proven sequence
    // (partDetails.ts's findFirstRepairLineForPart) step for step,
    // including its independent re-verification: a FRESH grid read must
    // show a repair line whose name matches the composed string EXACTLY
    // before anything else happens. Never trusts the creation click.
    if (candidate.needsWorkPackage) {
      const { workPackageName } = await createWorkPackageForLine(
        page,
        candidate.partNumber,
        candidate.serialNumber,
        candidate.noWorkPackageInventoryToken!,
        candidate.noWorkPackagePartDescription!,
      );

      const reread = await findCandidateLinesForVendorCodeOnce(page, client.todoListUrl, vendorCode);
      const verified = reread.find(
        (c) => !c.needsWorkPackage && c.serialNumber === candidate!.serialNumber && c.partNumber === candidate!.partNumber,
      );
      if (!verified || verified.linkText !== workPackageName) {
        throw new Error(
          `work_package_creation_not_confirmed: after creating a work package for ${candidate.partNumber}/` +
            `${candidate.serialNumber} (vendor ${vendorCode}), independent re-verification did not find a repair ` +
            `line whose name exactly matches "${workPackageName}" (found instead: ` +
            `${verified?.linkText ?? '(no matching line at all)'}).`,
        );
      }

      // Swap in the fully-populated candidate from the re-read: it now has
      // the real linkText, isBnLine, Removal Information, and
      // preferred-vendor state, none of which were readable before the
      // work package existed.
      candidate = verified;
      workPackageWasCreated = true;
      log.info(
        { vendorCode, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, workPackageName },
        '[work-package] created and verified — continuing the write-up in the same pass',
      );
    }

    // CLAUDE_CODE_PROMPT (Addition 3, preferred-vendor check) — read-only,
    // checked BEFORE any navigation/write for this candidate (the checkbox
    // only exists on this grid row, already captured in
    // findCandidateLinesForVendorCodeOnce at the same time as
    // removalTaskName/removalTaskId). Broad scope per explicit instruction:
    // applies to every vendor in this shared engine unless a future config
    // narrows it (config.checkPreferredVendor === false) — Aero Repair is
    // untouched since it never calls this module. A 'not_found' read is
    // never silently treated as "not preferred" — refusing to guess, same
    // discipline as every other definitive-read requirement in this project.
    //
    // Globally disabled for now (PREFERRED_VENDOR_CHECK_GLOBALLY_ENABLED,
    // see its own docstring above) — the read itself still happens
    // unconditionally in findCandidateLinesForVendorCodeOnce (cheap,
    // harmless), only the decision to act on it is suppressed here.
    const checkPreferredVendor = PREFERRED_VENDOR_CHECK_GLOBALLY_ENABLED && config.checkPreferredVendor !== false;
    if (checkPreferredVendor) {
      if (candidate.preferredVendorState === 'not_found') {
        throw new Error(
          `Preferred-vendor indicator not found for ${candidate.partNumber}/${candidate.serialNumber} ` +
            `(vendor ${config.id}) — the row has no "td.checkbox > input[type=CHECKBOX]" cell to read. ` +
            `Refusing to guess whether this vendor is preferred.`,
        );
      }
      if (candidate.preferredVendorState === 'not_preferred') {
        log.info(
          { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber },
          '[preferred-vendor] another vendor is preferred for this part — skipping this bid before any write',
        );
        return {
          status: 'vendor_not_preferred',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
        };
      }
    }

    // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case) — read the shipset
    // trigger from the HOME-PAGE grid row BEFORE opening the line (per
    // explicit instruction: the task name inside the work package can be
    // blank and reading from there causes false negatives). A no-op,
    // single-line read for every vendor without a shipsetCase configured.
    const usstgTaskName = await readUsstgLineTaskName(page, candidate.linkText);
    const shipset: ShipsetCaseConfig | null = resolveShipsetCase(usstgTaskName, config);

    const resolved: ResolvedAuthFlowPolicy = shipset
      ? {
          authFlow: shipset.authFlow,
          terminalState: shipset.terminalState,
          // Never consulted for a shipset line — Delta 3/4 skip the usage-table
          // read entirely below, so this placeholder value is never read.
          usageTableExpectation: 'expectedPresent',
          matchedOverrideId: shipset.id,
        }
      : resolveAuthFlowPolicy(candidate.serialNumber, config);

    const isBnFlow = resolved.matchedOverrideId === BN_OVERRIDE_ID;
    /**
     * True once a genuine unassigned task was assigned and independently
     * re-verified in THIS pass. Mirrors Aero Repair's own field of the same
     * name — kept so "how many lines needed an assignment" stays auditable
     * rather than becoming invisible now that it no longer skips the line.
     */
    let unassignedTaskWasAssigned = false;
    // CLAUDE_CODE_PROMPT (#1, new vendors) — until this batch, REPAIR
    // authorization was ONLY ever reached via the BN override or a shipset
    // case, so isBnFlow doubled as "is this a REPAIR-authorization flow"
    // for the retry-until-APPROVED gate below. 76863/4X623/6FVE5/75818 are
    // the first vendors where REPAIR is the DEFAULT (no override at all) —
    // isBnFlow is false for them even though they need the same
    // retry-until-APPROVED discipline as a real BN line.
    //
    // SUPERSEDED 2026-08-26: this used to be a `const isRepairFlow` read
    // off `resolved.authFlow` here. The gate now keys on
    // `effectiveAuthFlow` at the point of use instead, because a Parker
    // contract line only becomes a REPAIR flow once its receiving notes
    // have been read — which happens far below this point, long after the
    // serial-number-based resolution. Deciding it here would have locked
    // in WARRANTY before the deciding evidence was even available.

    await openVendorCodeCandidate(page, candidate);
    await waitForWorkPackageDetailsResolved(page);

    // REAL BUG FOUND AND FIXED, discovered live via direct DOM inspection,
    // a real user-provided screenshot, and explicit user correction: this
    // used to assume "no tasks assigned" only ever happens on BN lines
    // (true for the one recorded example) and, when it fired, created an
    // Ad-Hoc task with a FABRICATED name. Both assumptions were wrong.
    // Real evidence: (1) a genuine NORMAL line (861CA01/957) can also show
    // "no tasks assigned"; (2) a genuine BN line (BN 394600) can already
    // have a real, pre-existing task. The real distinguishing condition is
    // whether a task exists at all — not isBnFlow. (3) When no task
    // exists, the correct Ad-Hoc task name is THIS line's own real
    // "Removal Information > Task > Name / ID" grid columns (confirmed via
    // discovery-inspectRemovalInfoAndNoTask.ts and the user's screenshot:
    // 861CA01/957 shows Name="AC service bus caution message on #2 eng
    // with apu batt charger msg", ID="TRFKE00GY46E") — a DIFFERENT real
    // field from the Work Package/Check ID this code previously used
    // (that same line's Check ID is "TRFKE00GY4KC"). Per explicit user
    // confirmation, Removal Information's Task Name/ID is present on
    // almost every real line — genuinely missing data (both null) is now
    // the real "flag as error" case, not "no task currently assigned."
    const assignedTasksText = await readAssignedTasksAreaText(page);
    //await closeUnassignedTasksView(page);
    if (isNoTasksAssignedException(assignedTasksText)) {
      // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 6) — a
      // missing assigned task is NOT a blocker for this case: no abort, no
      // prompt, no retry, no Ad-Hoc creation attempt. Distinct from the
      // UNASSIGNED-task detour below (a task that exists but isn't yet
      // attached) — that check is untouched by this delta and only runs
      // for lines that DO have an assigned task.
      if (shipset && shipset.allowMissingAssignedTask) {
        log.info(
          { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, shipsetId: shipset.id },
          '[vendor-config] no assigned task exists — shipset case tolerates this (Delta 6), continuing without Ad-Hoc creation',
        );
        // REAL BUG FOUND AND FIXED via the first live watched run against
        // production (real line 41034002-111/68676): unlike the Ad-Hoc
        // creation branch below (whose own Close/Close sequence lands back
        // on the grid automatically), this tolerate-and-continue branch
        // does no UI interaction at all — it was left sitting on Work
        // Package Details, where readCurrentLocationCode's own
        // candidate.linkText lookup (which expects the GRID page) timed
        // out after 30s. Explicit re-navigation restores the same page
        // state every other branch already relies on.
        await navigateToVendorCodeGrid(page, client.todoListUrl, vendorCode);
      } else if (!candidate.removalTaskName || !candidate.removalTaskId) {
        return {
          status: 'no_removal_task_info_found',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
        };
      } else {
        await openCreateNewTask(page);
        await createAdHocTaskForCandidate(
          page,
          { name: candidate.removalTaskName, taskClass: '' },
          candidate.removalTaskId,
        );
        // Real, from discovery-0t1y4-bn-recording.ts lines 19-20: after
        // Ad-Hoc creation's Close/Close, the very next action is a
        // row-scoped checkbox re-check on the vendor-code grid — no
        // repair-link re-click in between. We're already back on the grid.
        // Per explicit user instruction, the process CONTINUES from here
        // (Schedule Work Package, Authorize, Issue/Dock where applicable)
        // rather than stopping — no longer a hard exception either way.
        await waitForVendorCodeGridResolved(page, vendorCode);
      }
    } else if (!isBnFlow) {
      // A real task already exists. The Unassigned Tasks detour (checking
      // for a genuine BLOCKING unassigned task) only applies here, matching
      // the warranty recording's own real sequence (which always had a
      // pre-existing task) — BN lines with an already-existing task skip
      // this detour too, matching the BN recording's own sequence, which
      // never visits it regardless of task state.
      await navigateToUnassignedTasksView(page);
      await waitForUnassignedTasksSectionResolved(page);
      const unassignedTasksText = await readUnassignedTasksAreaText(page);
      if (isUnassignedTaskPresent(unassignedTasksText)) {
        // Rows whose task type is administrative (PC / PC-PC / FORECAST /
        // REPL) were never a real block and are filtered out here.
        const { filtered } = await readUnassignedTaskCandidates(page);

        // AUTO-ASSIGN (2026-08-23, per explicit user direction: "I don't
        // want those to be skipped anymore").
        //
        // This engine used to stop at `unassigned_task_present` and skip
        // the line, while Aero Repair had auto-assigned the single
        // remaining candidate for months. That asymmetry was a deliberate
        // caution on my part, not a real difference between the flows —
        // and it cost real skipped lines (7 in the last three days alone,
        // across 1DH10, 0T1Y4 and 6MXR1). Same mechanism, same shared
        // helpers, same independent re-verification as Aero Repair's.
        if (filtered.length > 1) {
          // Genuine ambiguity. Still stops rather than guessing which task
          // to attach to a real work package — matching Aero Repair, which
          // has always drawn the line here too.
          await closeUnassignedTasksView(page);
          return {
            status: 'unassigned_task_present',
            partNumber: candidate.partNumber,
            serialNumber: candidate.serialNumber,
            taskDetail:
              `${filtered.length} genuinely assignable unassigned tasks — refusing to guess which one to attach. ` +
              `Candidates: ${filtered.map((f) => f.rowText).join(' | ')}`,
          };
        }

        if (filtered.length === 1) {
          log.info(
            { vendorCode, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, task: filtered[0].rowText },
            '[unassigned-task] assigning the single genuine candidate and continuing',
          );
          await assignUnassignedTask(page, filtered[0].index);
          await closeUnassignedTasksView(page);

          // Never trust the click. Re-open via a fresh navigation and
          // confirm the task is genuinely gone before continuing into a
          // real write-up — same discipline as Aero Repair's own path.
          await navigateToUnassignedTasksView(page);
          await waitForUnassignedTasksSectionResolved(page);
          const reVerify = await detectUnassignedTaskState(page);
          await closeUnassignedTasksView(page);

          if (reVerify.state !== 'absent') {
            return {
              status: 'unassigned_task_present',
              partNumber: candidate.partNumber,
              serialNumber: candidate.serialNumber,
              taskDetail:
                `Assigned the unassigned task, but independent re-verification did not show the confirmed empty ` +
                `state (re-verified as "${reVerify.state}"). Not continuing on an unconfirmed assignment.`,
            };
          }
          unassignedTaskWasAssigned = true;
          // Falls through into the normal write-up, in the SAME pass.
        } else {
          await closeUnassignedTasksView(page);
        }
      } else {
        await closeUnassignedTasksView(page);
      }
    }
    // else: isBnFlow && a real task already exists — no detour, no Ad-Hoc
    // creation, proceed directly (matches the BN recording's own sequence).

    const currentLocation = await readCurrentLocationCode(page, candidate.linkText);
    // APPROVED-BASE CHECK, second of two. Discovery already skipped these,
    // but a line can be selected off a stale snapshot, so this re-reads the
    // live location and decides again rather than trusting the earlier pass.
    // Placed BEFORE transformReturnToLocation (routing a base PSA cannot
    // order out of would be meaningless) and before any field is filled, so
    // nothing is written.
    const approval = evaluateBaseStation(currentLocation);
    if (!approval.approved) {
      log.info(
        { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, currentLocation },
        '[approved-base] line is not at an approved base — skipping, nothing changed',
      );
      return {
        status: 'base_not_approved',
        partNumber: candidate.partNumber,
        serialNumber: candidate.serialNumber,
        currentLocation,
        reason: approval.reason ?? 'Not an approved base for order creation.',
      };
    }

    const returnToLocation = transformReturnToLocation(currentLocation);

    // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — a single,
    // explicit allowlisted redirect: ONLY zero-usage-on-a-USSTG-line
    // qualifies (confirmed scope, 2026-08-07). Every other exception in
    // this function keeps its normal behavior untouched. Applies to every
    // vendor including BN lines — no vendor/flow gate — per explicit
    // instruction. `effectiveTerminalState` overrides whatever
    // resolveAuthFlowPolicy/shipset resolved, since a DO-NOT-SHIP line
    // never reaches Request Authorization regardless of what its own
    // normal terminal state would otherwise have been.
    let effectiveTerminalState: TerminalState = resolved.terminalState;
    /**
     * The auth flow actually used, as opposed to the one resolved from the
     * serial number alone. A Parker contract code found in the part's
     * receiving notes — which are only readable AFTER the line is opened,
     * long after resolveAuthFlowPolicy has run — flips this from WARRANTY
     * to REPAIR. Mirrors effectiveTerminalState above, which already exists
     * for exactly the same reason (the zero-usage CREATE_ORDER_ONLY
     * redirect).
     */
    let effectiveAuthFlow: string = resolved.authFlow;
    /**
     * Set once the part's receiving notes have been read. The Charge To
     * Account itself cannot be built here — it needs the line's own
     * CR-prefix, which is only read further down, after the Schedule Work
     * Package form has autofilled.
     */
    let contractCode: ContractCode | null = null;
    let doNotShipReason: string | null = null;
    /** Populated only on the zero-times-and-cycles redirect. See the outcome type. */
    let zeroUsageRows: UsageParmRow[] | undefined;
    let zeroUsageBarcode: string | null | undefined;
    let receivingNotes: string | null = null;
    let notesText: string;
    if (shipset) {
      // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Deltas 3 & 4) —
      // Notes to Vendor is a fixed literal (never composed from usage/part
      // data, so the times/cycles formatting helper is never called at
      // all), and zero usage is normal/expected for this case. Delta 4's
      // own stated preference: skip the times/cycles read + validation
      // entirely rather than read it and discard the result — this also
      // means the existing zero-usage guard structurally never runs for a
      // shipset line, satisfying Delta 4 without a separate suppression
      // flag. Every other vendor's and every non-shipset 7A9Y2 line's own
      // usage read/validation below is completely untouched.
      log.info(
        { vendorConfigId: config.id, shipsetId: shipset.id, notesText: shipset.notesText },
        '[vendor-config] shipset case — skipping the times/cycles read entirely (Delta 3/4); Notes to Vendor fixed',
      );
      notesText = shipset.notesText;
    } else {
      if (config.hasPartDetailsStep) {
        await openPartDetailsReceivingNotes(page, candidate.linkText, candidate.partNumber);
        receivingNotes = await readPartDetailsReceivingNotes(page);
        log.info(
            { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, receivingNotes: receivingNotes ?? null },
            '[vendor-config] part-level receiving notes',
        );
        if (setWaiveTimes(receivingNotes)) {
          resolved.usageTableExpectation = 'expectedAbsent';
        }
        await closePartDetailsReceivingNotes(page);

        // PARKER CONTRACT CODES — resolved here, BEFORE the "account"
        // guard below, and deliberately so.
        //
        // That guard stops any line whose notes mention "account", because
        // a human referring to an account means we do not know which one to
        // use and must not guess. A recognised contract code is the
        // opposite situation: it says exactly which account to use. Letting
        // the guard fire first would stop every contract line —
        // "Charge to account PARKERCPH" trips it — and the whole point of
        // this rule is that those lines run automatically.
        //
        // Applies to EVERY vendor in this engine, not a fixed list: the
        // codes travel with the CONTRACT, not the vendor. (The first
        // version scoped this to Parker, which was wrong on the facts —
        // FOKKERPBH is Aerotron's, not Parker's.) Aero Repair is excluded
        // structurally rather than by a check: it runs through its own
        // engine, which never imports this module.
        contractCode = detectContractCode(receivingNotes);
        if (contractCode) {
          // Not warranty work — billed against the contract. Bypass the
          // warranty flow, take REPAIR authorization, and issue + dock,
          // instead of stopping at authorization-only like the rest of
          // this vendor family.
          effectiveAuthFlow = AUTH_FLOW_REPAIR;
          effectiveTerminalState = 'ISSUE_AND_DOCK';
          log.info(
              {
                vendorConfigId: config.id,
                partNumber: candidate.partNumber,
                serialNumber: candidate.serialNumber,
                contractCode,
                authFlow: effectiveAuthFlow,
                terminalState: effectiveTerminalState,
              },
              '[contract-code] contract code found in receiving notes — repair flow, issue and dock',
          );
        }

        if (!contractCode && receivingNotes && /account/i.test(receivingNotes)) {
          log.error(
              { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, receivingNotes },
              '[vendor-config] receiving notes mention "account" — flagging for manual review per explicit instruction rather than risk writing to the wrong Charge To Account. Nothing filled, no order created',
          );
          return {
            status: 'receiving_notes_flagged_account',
            partNumber: candidate.partNumber,
            serialNumber: candidate.serialNumber,
            receivingNotes,
          };
        }
      }
      await openPartOwnDetails(page, candidate.linkText, candidate.serialNumber);
      const partOwnDetails = await readPartOwnDetails(page, candidate.partNumber, candidate.serialNumber);

      // AEROTRON REMOVAL DATE (2026-08-27) — read in this SAME visit,
      // while the part's own details page is already open, rather than
      // opening it a second time. readRemovalDate returns the page to the
      // Details tab before it finishes; that is load-bearing, not tidying,
      // because MXI remembers the active tab per session and leaving it on
      // Historical would break the next line's usage read.
      let removalDateLine: string | undefined;
      if (config.needsRemovalDateInNotes) {
        const removal = await readRemovalDate(page);
        if (removal.status === 'unreadable') {
          // Deliberately NOT the placeholder. "(not found)" is a real
          // answer meaning the history holds no removal event; using it
          // for a failed READ would make a broken selector produce notes
          // that look correct on every line.
          await closePartOwnDetails(page);
          return {
            status: 'removal_date_unreadable',
            partNumber: candidate.partNumber,
            serialNumber: candidate.serialNumber,
            reason: removal.error ?? 'Could not read the event history.',
          };
        }
        removalDateLine = composeRemovalDateLine(removal.formatted);
      }
      const usageClassification = classifyUsageTable(partOwnDetails.usageRows);

      if (usageClassification === 'present_all_zero' && !setWaiveTimes(receivingNotes)) {
        // CLAUDE_CODE_PROMPT ("Create Order Only") — the single allowlisted
        // redirect. Confirmed scope: USSTG lines only. currentLocation was
        // already read above in the exact "<STATION>/<CODE>" shape every
        // other station check in this project uses.
        const isUsstgLine = currentLocation.split('/')[1]?.toUpperCase() === 'USSTG';
        if (isUsstgLine) {
          doNotShipReason = ZERO_USAGE_DO_NOT_SHIP_REASON;
          effectiveTerminalState = 'CREATE_ORDER_ONLY';
          // Kept so the Maintenance Records draft is still offered for this
          // part. The redirect changes what happens in MXI; it should never
          // have changed whether Records gets told the data is wrong.
          zeroUsageRows = partOwnDetails.usageRows;
          zeroUsageBarcode = partOwnDetails.barcode;
          log.info(
            { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, doNotShipReason },
            '[create-order-only] zero usage detected on a USSTG line — routing to CREATE_ORDER_ONLY instead of the Zero Usage exception',
          );
        } else {
          await closePartOwnDetails(page);
          return {
            status: 'zero_usage',
            partNumber: candidate.partNumber,
            serialNumber: candidate.serialNumber,
            usageRows: partOwnDetails.usageRows,
          };
        }
      }
      if (usageClassification === 'absent' && resolved.usageTableExpectation !== 'expectedAbsent') {
        await closePartOwnDetails(page);
        return {
          status: 'usage_table_absent_unexpected',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
        };
      }

      // A DO-NOT-SHIP line gets the bare header only — confirmed rule: the
      // usage block is added "on non-zero-usage lines," and this line's
      // usage is, definitionally, all zero. Matches the recording exactly
      // (a normal, non-BN line whose Note To Vendor was header-only).
      notesText = doNotShipReason || isBnFlow
        ? composeNotesForBnLine(config.form.notesHeader)
        : composeNotesForNormalLine(partOwnDetails, config.form.notesHeader, removalDateLine);
      await closePartOwnDetails(page);

      // CLAUDE_CODE_PROMPT (#1, new vendors) — the part-level Details /
      // receiving-notes step, real from discovery-76863-AJS-sn-recording.ts.
      // Only vendors confirmed to show this in their own recording opt in
      // (originally 76863, 1DH10; the 2026-08-14 batch enables it for all 26
      // new vendors per explicit user instruction — "let live testing
      // confirm" — so a vendor that genuinely lacks this step will surface
      // as a real, visible failure the first time it's run, not a silent
      // guess). Real recorded sequence runs this AFTER closePartOwnDetails
      // and BEFORE the recheck below — not the other way around. The
      // read value is now consumed: see the "account" flag check right
      // below (CLAUDE_CODE_PROMPT, new vendor batch, 2026-08-14).

    }

    await recheckCandidateForSchedule(page, candidate);
    await clickScheduleWorkPackage(page);

    const chargeToAccountBefore = await readChargeToAccount(page);
    let chargeToAccountAfter: string;
    if (shipset) {
      // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 7) — always
      // the literal value, never derived from whatever MXI autofills.
      // Explicitly clear + re-enter (fillChargeToAccount already does a
      // click + .fill(), which replaces rather than appends), then read
      // back and assert — no special logging needed when overwriting an
      // autofilled value, per explicit instruction.
      chargeToAccountAfter = shipset.chargeToAccount;
      await fillChargeToAccount(page, chargeToAccountAfter);
      const chargeToAccountReadBack = await readChargeToAccount(page);
      if (chargeToAccountReadBack !== shipset.chargeToAccount) {
        throw new Error(
          `Charge To Account read-back mismatch for ${candidate.partNumber}/${candidate.serialNumber}: expected ` +
            `literal "${shipset.chargeToAccount}" (Delta 7), got "${chargeToAccountReadBack}".`,
        );
      }
    } else if (doNotShipReason) {
      // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — REAL
      // FINDING from the first live test: this line's Charge To Account
      // autofilled completely blank (no "<CR-prefix>ROUTINE+NONROUTINE"
      // shape to preserve), and leaving it blank made Schedule Work
      // Package's "OK" silently produce no order at all (confirmed via a
      // fresh read-only re-check: no order was created, line unchanged).
      // Per explicit user direction after this finding was reported: every
      // vendor in this shared-engine family EXCEPT Skypaxxx (7A9Y2) gets a
      // fixed literal fallback here — Skypaxxx keeps the original
      // leave-it-untouched behavior since its shipset case already governs
      // Charge To Account via Delta 7 above, and non-shipset Skypaxxx lines
      // were explicitly told to skip this fallback too.
      if (config.id === '7a9y2') {
        chargeToAccountAfter = chargeToAccountBefore;
        log.info(
          { vendorConfigId: config.id, partNumber: candidate.partNumber, serialNumber: candidate.serialNumber, chargeToAccountBefore },
          '[create-order-only] Charge To Account left untouched — Skypaxxx is explicitly excluded from the CREATE_ORDER_ONLY fallback',
        );
      } else {
        chargeToAccountAfter = CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK;
        await fillChargeToAccount(page, chargeToAccountAfter);
        const chargeToAccountReadBack = await readChargeToAccount(page);
        if (chargeToAccountReadBack !== CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK) {
          throw new Error(
            `Charge To Account read-back mismatch for ${candidate.partNumber}/${candidate.serialNumber}: expected ` +
              `literal "${CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK}" (CREATE_ORDER_ONLY fallback), got "${chargeToAccountReadBack}".`,
          );
        }
      }
    } else {
      // CLAUDE_CODE_PROMPT (charge-to-account default rule, 2026-08-14) —
      // per explicit user instruction: unless a vendor is explicitly stated
      // otherwise, this suite always lands on "<CR-prefix>REPAIR" here,
      // regardless of what the removal site left autofilled — the ONLY
      // exception in this shared engine is Collins (76863's own fixed
      // COLLINSDISPATCH100 suffix, which still needs an exact-shape match
      // since it's a real, different value, not "REPAIR" with a different
      // prefix). Aero Repair's separate WHEELSBRAKES flow lives in its own
      // module entirely and is untouched by this. See
      // chargeToAccount.ts's buildDefaultRepairChargeToAccount for the
      // "default to CR7 if no CR-prefix is present at all" rule.
      // CONTRACT CODES — see contractCodes.ts.
      //
      // Built here rather than at the notes read, because it needs THIS
      // line's own CR-prefix, and that is only known once the Schedule Work
      // Package form has autofilled (chargeToAccountBefore, just above).
      //
      // CORRECTED 2026-08-27, per explicit user direction: "these accounts
      // DO need the CR7/9 prefix just like normal." The first version wrote
      // the bare code with no prefix.
      //
      // Uses contractCodes.ts's own lenient prefix extraction rather than
      // buildChargeToAccountWithSuffix: that one requires the autofilled
      // value to be exactly "<CR-prefix>ROUTINE+NONROUTINE" and THROWS
      // otherwise — and that value is already known to vary live (a real
      // "CR7HMV" was hit). Throwing there would fail a contract line over
      // the shape of a value being overwritten anyway.
      //
      // REAL BUG FIXED (2026-08-26) and still worth knowing: the original
      // prototype assigned `config.form.chargeToAccountSuffix` directly.
      // VENDOR_REGISTRY is `Object.freeze`d, but that freeze is SHALLOW —
      // `config.form` stays mutable — so it permanently re-coded the
      // registry for the rest of the process. Nothing here mutates config.
      if (contractCode) {
        chargeToAccountAfter = buildContractChargeToAccount(chargeToAccountBefore, contractCode);
      } else {
        chargeToAccountAfter =
          config.form.chargeToAccountSuffix === WARRANTY_TERMINAL_STATE_CHARGE_TO_ACCOUNT_SUFFIX
            ? buildDefaultRepairChargeToAccount(chargeToAccountBefore)
            : buildChargeToAccountWithSuffix(chargeToAccountBefore, config.form.chargeToAccountSuffix);
      }
      await fillChargeToAccount(page, chargeToAccountAfter);
    }
    await fillPurchasingContact(page, config.form.purchasingContact);
    await selectConditions(page, config.form.conditions);
    await fillReturnToLocation(page, returnToLocation);

    if (shipset && shipset.transportationType === null) {
      // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 1) — leave
      // the dropdown untouched at whatever MXI presents. Never select an
      // empty option, never clear it — simply never call selectTransportation
      // at all, so a future regression (silently falling back to FEDEX-2)
      // is visible in the run log as a MISSING line, not a wrong value.
      log.info({ vendorConfigId: config.id }, '[vendor-config] Transportation Type step intentionally SKIPPED (Delta 1 — shipset leaves it blank)');
    } else {
      await selectTransportation(page, shipset ? shipset.transportationType! : config.form.transportation);
    }

    await fillNotesToVendor(page, notesText);
    await confirmScheduleWorkPackage(page);

    const generatedOrderNumber = await findGeneratedOrderNumber(page, candidate.linkText);
    if (!generatedOrderNumber) {
      throw new Error(
        `No order number was found after confirming Schedule Work Package for ${candidate.partNumber}/${candidate.serialNumber}.`,
      );
    }

    // CLAUDE_CODE_PROMPT (#1, RMA framework) — STRUCTURAL guard, same shape
    // as the CREATE_ORDER_ONLY guard right below: a pure vendor-MEMBERSHIP
    // check (no notes/content scan), independent of and checked before the
    // per-line doNotShipReason condition. Dormant this batch — isRmaVendor
    // is false for every vendor in VENDOR_REGISTRY right now (empty
    // RMA_VENDOR_IDS), so this branch never actually executes yet.
    if (isRmaVendor(config)) {
      const note = composeAwaitingRmaNote();
      await completeCreateOrderOnly(page, generatedOrderNumber, note);

      const verification = await verifyExternalReferenceCommitted(page, generatedOrderNumber, client.todoListUrl, note);
      if (!verification.committed) {
        throw new Error(
          `RMA external reference verification failed for order ${generatedOrderNumber} ` +
            `(${candidate.partNumber}/${candidate.serialNumber}): expected "${note}", got ` +
            `"${verification.realValue ?? '(not found)'}".`,
        );
      }

      const rmaFields: VendorCodeWriteUpFields = {
        partNumber: candidate.partNumber,
        serialNumber: candidate.serialNumber,
        isBnLine: isBnFlow,
        purchasingContact: config.form.purchasingContact,
        returnToLocation,
        conditions: config.form.conditions,
        transportation: shipset && shipset.transportationType === null ? '(intentionally skipped — Delta 1)' : config.form.transportation,
        chargeToAccountBefore,
        chargeToAccountAfter,
        notesText,
        generatedOrderNumber,
        authFlow: '(not requested — RMA vendor)',
        unassignedTaskWasAssigned,
        workPackageWasCreated,
      };
      return { status: 'order_created_awaiting_rma', fields: rmaFields, externalReferenceNote: note };
    }

    // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — STRUCTURAL
    // guard: this branch returns before openGeneratedOrder/Request
    // Authorization/Issue Order/Move to Dock are ever reached below, not
    // via a skippable flag. completeCreateOrderOnly() does its own
    // openGeneratedOrder() internally (the order-number link only exists
    // on THIS page, right after Schedule Work Package confirms) — calling
    // it again below (the normal path's own openGeneratedOrder call) would
    // be a double-click on a link that's no longer there.
    if (effectiveTerminalState === 'CREATE_ORDER_ONLY' && doNotShipReason) {
      const note = composeDoNotShipNote(doNotShipReason);
      await completeCreateOrderOnly(page, generatedOrderNumber, note);

      const verification = await verifyExternalReferenceCommitted(page, generatedOrderNumber, client.todoListUrl, note);
      if (!verification.committed) {
        throw new Error(
          `CREATE_ORDER_ONLY external reference verification failed for order ${generatedOrderNumber} ` +
            `(${candidate.partNumber}/${candidate.serialNumber}): expected "${note}", got ` +
            `"${verification.realValue ?? '(not found)'}".`,
        );
      }

      const doNotShipFields: VendorCodeWriteUpFields = {
        partNumber: candidate.partNumber,
        serialNumber: candidate.serialNumber,
        isBnLine: isBnFlow,
        purchasingContact: config.form.purchasingContact,
        returnToLocation,
        conditions: config.form.conditions,
        transportation: shipset && shipset.transportationType === null ? '(intentionally skipped — Delta 1)' : config.form.transportation,
        chargeToAccountBefore,
        chargeToAccountAfter,
        notesText,
        generatedOrderNumber,
        authFlow: '(not requested — CREATE_ORDER_ONLY)',
        unassignedTaskWasAssigned,
        workPackageWasCreated,
      };
      return {
        status: 'order_created_do_not_ship',
        fields: doNotShipFields,
        reason: doNotShipReason,
        externalReferenceNote: note,
        zeroUsageRows,
        zeroUsageBarcode,
      };
    }

    await openGeneratedOrder(page, generatedOrderNumber);

    let realAuthStatus: string | null;
    // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 2) — REPAIR
    // authorization, not WARRANTY: mirrors the BN/REPAIR retry discipline
    // (seeking a real, synchronous APPROVED within the session), the same
    // as Aero Repair's own REPAIR flow — not the WARRANTY branch's
    // REQUESTED-is-fine acceptance, since this is explicitly a non-warranty
    // situation per the delta. isRepairFlow (not isBnFlow) as of #1 — see
    // its own docstring above for why.
    // effectiveAuthFlow, not the serial-resolved one: a Parker contract
    // line is REPAIR authorization even though its serial resolved to
    // WARRANTY, and it needs this branch's retry-until-APPROVED discipline.
    if (effectiveAuthFlow === AUTH_FLOW_REPAIR || shipset) {
      const MAX_AUTH_ATTEMPTS = 2;
      let approved = false;
      realAuthStatus = null;
      for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
        // An order that is already authorized shows no "Request
        // Authorization" action, and therefore no Auth Flow dropdown and no
        // confirmation either — pressing on would just move the 30s timeout
        // from one step to the next. The real status is re-read below and
        // decides the outcome regardless of which path got us here.
        const authResult = await clickRequestAuthorization(page);
        if (authResult.status === 'requested') {
          await selectAuthFlow(page, effectiveAuthFlow);
          await confirmAuthorizationRequest(page);
        }

        const attemptState = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
        realAuthStatus = attemptState.authorizationStatus;
        if (attemptState.authorizationStatus === 'APPROVED') {
          approved = true;
          break;
        }
      }
      if (!approved) {
        return {
          status: 'authorization_not_confirmed',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
          orderNumber: generatedOrderNumber,
          realAuthorizationStatus: realAuthStatus,
        };
      }
    } else {
      // Same reasoning as the REPAIR branch above: no request action means
      // there is nothing to confirm either.
      const authResult = await clickRequestAuthorization(page);
      if (authResult.status === 'requested') {
        await confirmAuthorizationRequest(page);
      }

      const state = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
      realAuthStatus = state.authorizationStatus;
      if (realAuthStatus !== 'REQUESTED' && realAuthStatus !== 'APPROVED') {
        return {
          status: 'authorization_not_confirmed',
          partNumber: candidate.partNumber,
          serialNumber: candidate.serialNumber,
          orderNumber: generatedOrderNumber,
          realAuthorizationStatus: realAuthStatus,
        };
      }
    }

    const fields: VendorCodeWriteUpFields = {
      partNumber: candidate.partNumber,
      serialNumber: candidate.serialNumber,
      isBnLine: isBnFlow,
      purchasingContact: config.form.purchasingContact,
      returnToLocation,
      conditions: config.form.conditions,
      // Reflects what actually happened, not the vendor's baseline default —
      // a shipset line with transportationType: null never had this step run at all (Delta 1).
      transportation: shipset && shipset.transportationType === null ? '(intentionally skipped — Delta 1)' : config.form.transportation,
      chargeToAccountBefore,
      chargeToAccountAfter,
      notesText,
      generatedOrderNumber,
      authFlow: effectiveAuthFlow,
      unassignedTaskWasAssigned,
      workPackageWasCreated,
    };

    // Structural dispatch per VENDOR_MODULE_REFACTOR_SPEC.md section 3.2 —
    // no code path from the AUTHORIZATION_ONLY branch can reach
    // issueGeneratedOrder/moveOutboundShipmentToDock; it simply never calls
    // them, not via an early return that a future edit could bypass.
    switch (effectiveTerminalState) {
      case 'ISSUE_AND_DOCK': {
        const issueResult = await issueGeneratedOrder(client, generatedOrderNumber);
        const postIssueState = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
        if (postIssueState.orderStatus !== 'ISSUED') {
          throw new Error(
            `Order ${generatedOrderNumber} not confirmed ISSUED (real status: ${postIssueState.orderStatus ?? '(not found)'}; ` +
              `issueGeneratedOrder reported: ${issueResult.status}${issueResult.errorMessage ? ' — ' + issueResult.errorMessage : ''}).`,
          );
        }
        // CLAUDE_CODE_PROMPT (vendor 7A9Y2 "shipset" case, Delta 5) — a
        // deliberate, temporary safety measure for the first production
        // runs: skip Move to Dock, ALL OTHER STEPS (including Issue Order
        // above) still run as normal. Config-gated (moveToDockOnInitialRun)
        // so the capability stays reachable by flipping the flag later —
        // no code change needed to re-enable.
        if (shipset && !shipset.moveToDockOnInitialRun) {
          log.info(
            { vendorConfigId: config.id, generatedOrderNumber, shipsetId: shipset.id },
            '[vendor-config] order issued successfully — Move to Dock intentionally SKIPPED on this run (Delta 5)',
          );
          return { status: 'issued_not_docked', fields };
        }

        const dockResult = await moveOutboundShipmentToDock(client, generatedOrderNumber);
        if (dockResult.status === 'failed' || dockResult.status === 'no_outbound_shipment_found') {
          throw new Error(`Move to Dock failed for order ${generatedOrderNumber}: ${dockResult.errorMessage ?? dockResult.status}`);
        }
        return { status: 'issued_and_docked', fields, shipmentId: dockResult.shipmentId };
      }
      case 'AUTHORIZATION_ONLY': {
        return { status: 'authorized_only', fields };
      }
      case 'CREATE_ORDER_ONLY': {
        // Structurally unreachable: effectiveTerminalState is only ever set
        // to CREATE_ORDER_ONLY together with doNotShipReason, and that
        // combination already returned above, well before this switch,
        // openGeneratedOrder, or Request Authorization ever ran. This case
        // exists only to satisfy TerminalState's exhaustiveness now that
        // CREATE_ORDER_ONLY is a member of the shared type.
        throw new Error(
          `Unreachable: effectiveTerminalState was 'CREATE_ORDER_ONLY' without a doNotShipReason for ` +
            `${candidate.partNumber}/${candidate.serialNumber} — this should have returned above.`,
        );
      }
    }
  } catch (err) {
    return {
      status: 'error',
      partNumber: knownPartNumber,
      serialNumber: knownSerialNumber,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
