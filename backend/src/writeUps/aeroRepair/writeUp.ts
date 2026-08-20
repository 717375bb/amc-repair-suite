import type { Page } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { createLogger } from '../../logging/logger.js';
import {
  AUTH_FLOW,
  CONDITIONS_LABEL,
  NOTES_HEADER_TEXT,
  PURCHASING_CONTACT,
  TRANSPORTATION_LABEL,
} from './constants.js';
import { completeCreateOrderOnly, composeDoNotShipNote, verifyExternalReferenceCommitted, ZERO_USAGE_DO_NOT_SHIP_REASON } from '../shared/createOrderOnly.js';
import { buildWheelsBrakesChargeToAccount } from './chargeToAccount.js';
import { isNoTasksAssignedException } from './noTaskException.js';
import { isAdHocContinuationProven } from './adHocContinuationProof.js';
import { isWorkPackageCreationProven } from './workPackageCreationProof.js';
import { captureEmptyReadEvidence, captureUnassignedTaskPositiveDetection } from './emptyReadCapture.js';
import { waitForUnassignedTasksSectionResolved, waitForWorkPackageDetailsResolved } from './gridWait.js';
import { detectUnassignedTaskState } from '../shared/unassignedTasks.js';
import { assignUnassignedTask, readUnassignedTaskCandidates } from './unassignedTaskAssignment.js';
import {
  closePartOwnDetails,
  closeUnassignedTasksView,
  composeAeroRepairNotesText,
  findFirstRepairLineForPart,
  isZeroUsage,
  navigateToUnassignedTasksView,
  openPartOwnDetails,
  readPartOwnDetails,
  recheckRepairLineForSchedule,
  type UsageParmRow,
} from './partDetails.js';
import { isSessionLossError } from './retryBackoff.js';
import { routeStationToAeroRepairLocation, type RoutingResult } from './routing.js';
import { transformReturnToLocation } from './returnToLocation.js';
import { readOrderRealState } from './issueOrder.js';
import {
  cancelCreateNewTask,
  clickRequestAuthorization,
  confirmAuthorizationRequest,
  confirmScheduleWorkPackage,
  clickScheduleWorkPackage,
  createAdHocTaskForCandidate,
  reopenRepairLineAfterTaskCreation,
  fillChargeToAccount,
  fillNotesToVendor,
  fillPurchasingContact,
  fillReturnToLocation,
  findGeneratedOrderNumber,
  openCreateNewTask,
  openGeneratedOrder,
  readAssignedTasksAreaText,
  readChargeToAccount,
  readCurrentLocationCode,
  readTaskDefinitionCandidates,
  selectAuthFlow,
  selectConditions,
  selectExternalVendorWorkPackage,
  selectTransportation,
} from './selectors.js';

const log = createLogger('writeup');

/**
 * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — literal
 * fallback for a blank-autofilled Charge To Account, per explicit user
 * direction given after the shared vendor-code engine's first live test
 * showed leaving it blank silently prevents order creation.
 */
const AERO_REPAIR_CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK = 'CR7WHEELSBRAKES';

export interface AeroRepairWriteUpFields {
  partNumber: string;
  serialNumber: string;
  currentLocation: string;
  routing: RoutingResult;
  purchasingContact: string;
  returnToLocation: string;
  conditions: string;
  transportation: string;
  chargeToAccountBefore: string;
  chargeToAccountAfter: string;
  notesText: string;
  generatedOrderNumber: string | null;
  /** Null if generatedOrderNumber wasn't found — authorization couldn't be requested without it. */
  authFlow: string | null;
  /** True once the authorization-request OK (recording line 46) was clicked. Issue Order is NEVER clicked either way. */
  authorizationRequested: boolean;
}

type AeroRepairWriteUpOutcomeVariant =
  | { status: 'filled'; fields: AeroRepairWriteUpFields }
  | { status: 'no_tasks_assigned'; partNumber: string }
  | { status: 'multiple_candidate_tasks'; partNumber: string; candidateNames: string[] }
  | {
      status: 'ad_hoc_pending_manual_continuation';
      partNumber: string;
      serialNumber: string;
      taskName: string;
    }
  /**
   * Addition 1 (Create Work Package) — mirrors ad_hoc_pending_manual_continuation
   * above exactly: a real work package WAS created and independently
   * re-verified (name matches exactly), but per workPackageCreationProof.ts's
   * one-time gate, this specific new write path pauses here — once per env —
   * until a human manually confirms the rest of the flow (task-paste,
   * Schedule Work Package, ...) completes correctly from a freshly-created
   * work package. Never a guess at whether the creation itself is safe to
   * build on — a real mutation already happened and was verified; only
   * CONTINUING past it automatically is gated.
   */
  | {
      status: 'work_package_created_pending_manual_continuation';
      partNumber: string;
      serialNumber: string;
      workPackageName: string;
    }
  | { status: 'unrecognized_station'; partNumber: string; stationCode: string }
  /**
   * CLAUDE_CODE_PROMPT (email-maintenance-records button, 2026-08-14) —
   * usageRows added per explicit user instruction, same shape/reasoning as
   * the shared vendor-code engine's own zero_usage outcome.
   */
  | { status: 'zero_usage'; partNumber: string; serialNumber: string; usageRows: UsageParmRow[] }
  /**
   * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — confirmed
   * scope: applies to Aero Repair too, not excluded. The RO was created
   * (Schedule Work Package ran normally, real Note To Vendor written) but
   * Request Authorization/Issue Order/Move to Dock were never reached —
   * structurally, not via a skippable check (processLine.ts must not
   * attempt issue/dock for this outcome). `reason` and
   * `externalReferenceNote` are composed from the SAME string (see
   * shared/createOrderOnly.ts) so the audit trail and the real MXI field
   * can never drift apart.
   */
  | {
      status: 'order_created_do_not_ship';
      partNumber: string;
      serialNumber: string;
      generatedOrderNumber: string;
      reason: string;
      externalReferenceNote: string;
    }
  /**
   * DEFECT 2 REWRITE: the old 'unassigned_task_present' terminal SKIP is
   * gone — a genuine unassigned task is now auto-assigned and the SAME
   * pass continues into the normal write-up (see unassignedTaskWasAssigned
   * below for how that's still made auditable). Only the two genuinely
   * ambiguous/suspect shapes below still short-circuit, per the explicit
   * "stop and ask Brayden rather than guessing" instruction.
   */
  | { status: 'unassigned_task_multiple_present'; partNumber: string; serialNumber: string; candidateCount: number }
  | { status: 'unassigned_task_detection_suspect'; partNumber: string; serialNumber: string }
  | { status: 'no_removal_task_info_found'; partNumber: string; serialNumber: string }
  | { status: 'error'; partNumber: string; serialNumber: string | null; errorMessage: string };

/**
 * `unassignedTaskWasAssigned` is a shared, optional field across every
 * variant above (not just 'filled') — change 7's real ask is "auditable how
 * many lines required assignment," and assignment can be followed by ANY
 * eventual outcome (unrecognized_station, zero_usage, filled, ...), not
 * just a successful write-up. Set true only on the path that performed a
 * real assignment + independent re-verification (see runAeroRepairWriteUp
 * below); processLine.ts inserts a distinct 'unassigned_task_assigned'
 * write_up_actions row whenever this is true, in addition to whatever the
 * eventual outcome-specific row is.
 */
/**
 * `workPackageWasCreated` mirrors `unassignedTaskWasAssigned` exactly:
 * a shared, optional field across every variant (not just 'filled') — set
 * true only once workPackageCreationProof.ts's gate has already been
 * confirmed proven and the flow continues past a freshly-created work
 * package in the SAME pass. processLine.ts inserts a distinct
 * 'work_package_created' write_up_actions row whenever this is true, in
 * addition to whatever the eventual outcome-specific row is — same pattern
 * as unassigned_task_assigned.
 */
export type AeroRepairWriteUpOutcome = AeroRepairWriteUpOutcomeVariant & {
  unassignedTaskWasAssigned?: boolean;
  workPackageWasCreated?: boolean;
};

/**
 * Walks the Aero Repair write-up flow for ONE part number: fills and
 * confirms the Schedule Work Package form (charge-to-account, purchasing
 * contact, conditions, transportation, return-to-location, notes), then —
 * now that AUTH_FLOW has a confirmed value — proceeds into the newly
 * generated order, requests authorization, and selects the Auth Flow.
 *
 * Still deliberately STOPS before Issue Order (recording lines 47-48) —
 * that remains the "final Issue" step this task says not to submit yet.
 * If no generated order number was found, authorization is skipped
 * (authFlow stays null, authorizationRequested stays false) rather than
 * guessed at.
 *
 * Never clicks Issue Order under any circumstance — this only fills
 * fields and requests authorization, for manual review before the final
 * submission step.
 */
export async function runAeroRepairWriteUp(
  client: MxiClient,
  partNumber: string,
  preferredSerialNumber?: string,
  /**
   * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — defaults to 3
   * (existing, unchanged behavior for every direct caller). processLine.ts
   * passes 1 for a main-pass attempt (no inline backoff burned per line —
   * a retryable failure quarantines immediately instead) and leaves the
   * default (3, with Layer 2's fixed 5s/15s/30s backoff) for its second-pass
   * reprocessing call.
   */
  maxAttempts = 3,
): Promise<AeroRepairWriteUpOutcome> {
  // GAP FOUND AND FIXED: the 'error' outcome previously carried no
  // serialNumber at all, so a write_up_actions 'error' row could never be
  // attributed to a specific line without cross-referencing the xlsx log
  // (which only has it because the CALLER already knew what it asked for).
  // Tracked here, updated the moment the real serial is known, and used in
  // the catch block below — falls back to preferredSerialNumber (still
  // meaningful — it identifies which line was BEING attempted) if the
  // failure happened before findFirstRepairLineForPart ever returned.
  let knownSerialNumber: string | null = preferredSerialNumber ?? null;
  try {
    const page: Page = await client.getAuthenticatedPage();

    const { serialNumber, linkText, removalTaskName, removalTaskId, workPackageCreated, createdWorkPackageName } =
      await findFirstRepairLineForPart(page, partNumber, client.todoListUrl, preferredSerialNumber, maxAttempts);
    knownSerialNumber = serialNumber;

    // Addition 1 (Create Work Package) — a real work package was just
    // created and independently re-verified (findFirstRepairLineForPart's
    // own guarantee). Per workPackageCreationProof.ts's one-time gate, do
    // not continue automatically into the rest of the flow (task-paste,
    // Schedule Work Package, ...) until a human has manually confirmed it
    // for real, once, in this env — same discipline already trusted here
    // for the Ad-Hoc-continuation gap (isAdHocContinuationProven).
    if (workPackageCreated) {
      const workPackageCreationProven = await isWorkPackageCreationProven(client.config.env);
      if (!workPackageCreationProven) {
        return {
          status: 'work_package_created_pending_manual_continuation',
          partNumber,
          serialNumber,
          workPackageName: createdWorkPackageName!,
        };
      }
    }
    const workPackageWasCreated = workPackageCreated;

    // Real bug found and fixed this session: this check previously ran
    // AFTER navigateToUnassignedTasksView, reading the "Unassigned Tasks"
    // sub-tab — but that tab's "no open tasks" message is the NORMAL state
    // (confirmed live: every real line checked shows it, including lines
    // with genuine assigned work) and must never block anything, per
    // explicit user clarification. The actual blocking condition lives on
    // the DEFAULT "Assigned Tasks" tab landed on immediately after
    // clicking the repair link — checked here, BEFORE that navigation.
    //
    // RECOVERY PATH, added after a real recorded walkthrough
    // (discovery-notaskwriteup-recording.ts) revealed one: before treating
    // "no tasks assigned" as a hard stop, the order's own "Create New
    // Task" panel lists real candidate task definitions not yet formally
    // assigned to this line (readTaskDefinitionCandidates).
    //
    // REAL CORRECTION, found via a dedicated follow-up investigation: the
    // first version of this logic flagged "multiple candidates" on every
    // single real no-task line checked (4/4) and treated that as the
    // routine, expected case. Direct investigation proved that wrong on
    // two counts. First, the "Blocks and Requirements" panel this reads
    // from was suspected of pooling in a sibling serial's task — it
    // isn't; it's simply never serial-scoped at all, a fixed template
    // catalog offered identically regardless of which serial you arrived
    // from (confirmed: 4 different real serials, 3 different part
    // numbers, same 2-template shape every time). The genuinely
    // serial-scoped source — where "Inventory" always matches the exact
    // target PN+SN, confirmed live — is the SAME default Assigned Tasks
    // tab already read one line above via readAssignedTasksAreaText;
    // that's what correctly gates entry into this whole recovery block.
    // Second, and more directly actionable: one of the two templates is
    // ALWAYS `taskClass: 'PC'` (Parts Card — administrative paperwork,
    // never the actual repair task). Excluding it, every one of the 4 real
    // no-task lines checked resolved to exactly one genuine repair-class
    // candidate (REPL in 3 cases, MOD — a Service-Bulletin-driven
    // modification — in the 4th) — matching the real-world expectation
    // that one physical part has exactly one right answer. "Multiple
    // candidates" is therefore the rare case now, not the routine one, as
    // originally assumed before this correction. Evidence base: 4/4 real
    // cases, spanning 3 of the 6 known part numbers (90001200-1 x2,
    // 5013641, 90001201-1) — not yet observed for 5013640, 5013642-1, or
    // 90001201-2's own no-task scenario specifically.
    const assignedTasksText = await readAssignedTasksAreaText(page);
    if (isNoTasksAssignedException(assignedTasksText)) {
      await openCreateNewTask(page);
      const allCandidates = await readTaskDefinitionCandidates(page);
      // PC (Parts Card) is a real, always-offered template — never itself
      // the repair task — excluded before counting, per the finding above.
      const candidates = allCandidates.filter((c) => c.taskClass !== 'PC');

      if (candidates.length === 0) {
        await cancelCreateNewTask(page);
        return { status: 'no_tasks_assigned', partNumber, workPackageWasCreated };
      }

      if (candidates.length > 1) {
        // Now the genuine rare-anomaly case, not the routine one: after
        // excluding the always-present PC template, more than one
        // repair-relevant candidate remains — real ambiguity, flag for a
        // human rather than guess, same "refuse to guess" discipline
        // already used by selectVendorRadioForRouting and
        // findFirstRepairLineForPart elsewhere in this module.
        await cancelCreateNewTask(page);
        return {
          status: 'multiple_candidate_tasks',
          partNumber,
          candidateNames: candidates.map((c) => c.name),
          workPackageWasCreated,
        };
      }

      // Exactly one real repair-relevant candidate (the Task-Definition
      // panel's own 0/1/2+ counting above is unchanged — still the real
      // gate on whether this line is unambiguous enough to auto-create a
      // task at all). Create an Ad-Hoc task, then continue the flow
      // normally.
      //
      // DESIGN PIVOT: the Task-Definition-based creation path
      // (select the candidate's own aTaskDefinition radio -> OK -> a
      // second confirmation page) was live-tested and found to trigger a
      // genuine, deliberate MXI step-up re-authentication dialog at that
      // second page's commit step — confirmed via a timed test to be tied
      // to that specific action, not session staleness. No automated,
      // credential-free way through that exists. Per explicit user
      // decision, made with full awareness of the tradeoff: switched to
      // Ad-Hoc task creation instead — the same real mechanism the
      // original recording used, confirmed live (same investigation) not
      // to trigger the prompt.
      //
      // REAL BUG FOUND AND FIXED, per explicit user correction: the Ad-Hoc
      // task's name previously used the Task-Definition panel's own
      // template label (candidates[0].name — an administrative catalog
      // entry, e.g. "32-41-01-01-010-REPL (MAIN WHEEL ASSY 900-...)") plus
      // the Work Package/Check ID (extractWorkPackageCheckId, from the
      // Assigned Tasks tab's title line). Same real mistake as the
      // vendor-code family's original implementation: the correct source
      // is this line's own real "Removal Information > Task > Name / ID"
      // grid columns (captured in findFirstRepairLineForPart, before ever
      // leaving the grid — see shared/removalTaskInfo.ts) — the actual
      // real-world removal reason, a genuinely different field from both
      // the Task-Definition label AND the Work Package/Check ID. Per
      // explicit user confirmation this data is present on almost every
      // real line; genuinely missing data is now the real "flag as error"
      // case, not a reason to fabricate a name from the wrong source.
      if (!removalTaskName || !removalTaskId) {
        await cancelCreateNewTask(page);
        return { status: 'no_removal_task_info_found', partNumber, serialNumber, workPackageWasCreated };
      }
      const taskName = `${removalTaskName} ${removalTaskId}`;
      await createAdHocTaskForCandidate(page, { name: removalTaskName, taskClass: '' }, removalTaskId);

      // REAL GAP FOUND AND FIXED via a live end-to-end failure: after the
      // Ad-Hoc task's final "Close" click, the page lands back on the
      // filtered To Do List grid, not Work Package Details — the very
      // next call below needs to be back on that page. Re-click the same
      // repair line (still present on this same filtered grid) to get
      // back there. Never needed before this recovery path existed, since
      // the original flow only ever reached Work Package Details once,
      // straight from the repair link click.
      await reopenRepairLineAfterTaskCreation(page, linkText);
      // PART A FIX: this exact in-session sequence — reopen the line right
      // after Ad-Hoc creation, then fall straight into the rest of the flow
      // — has never actually been proven end-to-end (the July 25 proof only
      // exercised the separate continue-ad-hoc CLI, a fresh navigation days
      // later against a line that already has its task — see gridWait.ts's
      // waitForWorkPackageDetailsResolved for the full trace). Content-aware
      // wait, same discipline as elsewhere: confirm Work Package Details has
      // actually reloaded before proceeding, rather than trusting a fixed
      // pace() and clicking blindly into whatever page actually loaded.
      await waitForWorkPackageDetailsResolved(page);

      // ONE-TIME PAUSE GATE: everything from here through Auth Flow,
      // Issue Order, and Move to Dock — starting from a freshly-created
      // Ad-Hoc task — has never been exercised end-to-end in one unbroken
      // run (the closest real attempt failed one step later, at
      // navigateToUnassignedTasksView, before the fix above existed; the
      // fix itself was only confirmed via an isolated mechanism test, not
      // a full live run). Per explicit instruction: pause here, once,
      // until a real manual continuation proves the rest of the flow
      // works — independently verified, same discipline as every other
      // first-time proof in this project — then never pause again.
      // Scoped per-env (isAdHocContinuationProven) so proving this in
      // stage can't silently unlock unattended production use.
      const proven = await isAdHocContinuationProven(client.config.env);
      if (!proven) {
        return {
          status: 'ad_hoc_pending_manual_continuation',
          partNumber,
          serialNumber,
          taskName,
          workPackageWasCreated,
        };
      }
    }

    await navigateToUnassignedTasksView(page);
    // REAL BUG FOUND AND FIXED via direct evidence: navigateToUnassignedTasksView's
    // fixed 750ms pace() was not reliably enough time for this specific
    // sub-tab to finish rendering under real load — every one of 49 real
    // false "unassigned task present" reads captured the page truncated
    // right after "Enforce Workscope Order:", never reaching this section
    // at all. Content-aware wait added, same principle as Part A's OEM-grid
    // fix: wait for a DEFINITIVE end state (a confirmed section-rendered
    // marker or the empty-state text itself) before ever evaluating
    // detection state — see gridWait.ts's waitForUnassignedTasksSectionResolved
    // for the full account.
    await waitForUnassignedTasksSectionResolved(page);

    // DEFECT 2 REWRITE: an unassigned task is a routine, resolvable
    // condition (a task allocated to this part number that hasn't yet been
    // attached to the work package) — not a blocked line. Tri-state
    // detection (change 4): 'present' requires a real assignable checkbox,
    // 'absent' requires the confirmed empty-state text, and anything
    // matching neither is 'inconclusive' — raised as a distinct exception
    // rather than silently treated as either.
    let unassignedTaskWasAssigned = false;
    const detection = await detectUnassignedTaskState(page);
    if (detection.state === 'inconclusive') {
      await captureUnassignedTaskPositiveDetection(page, {
        partNumber,
        serialNumber,
        detectionState: detection.state,
        taskCheckboxCount: detection.taskCheckboxCount,
      });
      await closeUnassignedTasksView(page);
      throw new Error(
        `unassigned_task_state_indeterminate: Unassigned Tasks section for ${partNumber}/${serialNumber} showed ` +
          `neither a real task checkbox nor the confirmed empty-state text — refusing to treat this as either a ` +
          `genuine "present" or "absent" result.`,
      );
    }

    if (detection.state === 'present') {
      // This branch has never been verified against a real true positive
      // before now, and is wired to a real WRITE action — full evidence
      // (screenshot + body HTML + innerText) BEFORE any click, while the
      // row is still on-page (change 5).
      await captureUnassignedTaskPositiveDetection(page, { partNumber, serialNumber });

      const { filtered } = await readUnassignedTaskCandidates(page);

      if (filtered.length === 0) {
        // REAL FIX (2026-08-20, per explicit user direction): a real
        // checkbox was detected, but every one of them filtered out as an
        // ignored administrative/non-repair type (PC, PC-PC, FORECAST,
        // REPL) — genuinely nothing to assign, not a suspect read.
        // Previously this stopped and flagged the line for manual review
        // (the original, more cautious behavior from when this ignore list
        // was still new and unproven at scale); now that it's confirmed
        // correct, continue the write-up exactly like the confirmed-absent
        // state instead.
        await closeUnassignedTasksView(page);
      } else if (filtered.length > 1) {
        // Real ambiguity: more than one genuinely-assignable candidate.
        // Per explicit instruction, stop and flag for human review rather
        // than guessing which one(s) to assign or assigning only the first
        // and continuing silently (change 2).
        await closeUnassignedTasksView(page);
        return {
          status: 'unassigned_task_multiple_present',
          partNumber,
          serialNumber,
          candidateCount: filtered.length,
          workPackageWasCreated,
        };
      } else {
        // Exactly one genuine, assignable candidate — assign it and
        // continue the SAME pass into the normal write-up flow (change 1).
        await assignUnassignedTask(page, filtered[0].index);
        await closeUnassignedTasksView(page);

        // Independent re-verification (standing discipline #3, change 6):
        // never trust the click's own apparent success. Re-open the same
        // view via a fresh navigation and confirm the task is genuinely
        // gone before proceeding.
        await navigateToUnassignedTasksView(page);
        await waitForUnassignedTasksSectionResolved(page);
        const reVerify = await detectUnassignedTaskState(page);
        await closeUnassignedTasksView(page);

        if (reVerify.state !== 'absent') {
          throw new Error(
            `unassigned_task_assignment_not_confirmed: after assigning task index ${filtered[0].index} for ` +
              `${partNumber}/${serialNumber}, independent re-verification did not show the confirmed empty state ` +
              `(re-verified state: ${reVerify.state}).`,
          );
        }
        unassignedTaskWasAssigned = true;
      }
    } else {
      // The confirmed-empty state ('absent') is itself a meaningful result
      // being trusted to mean "safe to continue" — captured here, before
      // closing, for the same reason as the other read paths: a false
      // "confirmed empty" here (e.g. the page not having fully rendered
      // the real task row yet) would silently let a work package with
      // genuine unassigned work continue as if clean.
      await captureEmptyReadEvidence(page, 'unassigned-task-empty-state', { partNumber, serialNumber });
      await closeUnassignedTasksView(page);
    }

    const currentLocation = await readCurrentLocationCode(page, linkText);
    const stationCode = currentLocation.split('/')[0];
    const routing = routeStationToAeroRepairLocation(stationCode);
    if (routing.status === 'exception') {
      return {
        status: 'unrecognized_station',
        partNumber,
        stationCode: routing.stationCode,
        unassignedTaskWasAssigned,
        workPackageWasCreated,
      };
    }

    await openPartOwnDetails(page, linkText, serialNumber);
    const partOwnDetails = await readPartOwnDetails(page, partNumber, serialNumber);

    // Zero-usage records-error check: if the Current Usage table shows every
    // TSN/TSO/TSI value (CYCLES and HOURS both) as exactly zero, this is a
    // maintenance-records data problem, not a real repair-eligible line.
    //
    // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — the single
    // allowlisted redirect (confirmed scope, 2026-08-07): on a USSTG line,
    // this no longer skips the write-up — it runs the normal write-up
    // through Schedule Work Package (creating the RO), then diverts to
    // CREATE_ORDER_ONLY instead of requesting authorization. Confirmed
    // scope explicitly includes Aero Repair, no vendor gate. Any other
    // location state keeps the original zero_usage exception untouched.
    let doNotShipReason: string | null = null;
    if (isZeroUsage(partOwnDetails.usageRows)) {
      const isUsstgLine = currentLocation.split('/')[1] === 'USSTG';
      if (isUsstgLine) {
        doNotShipReason = ZERO_USAGE_DO_NOT_SHIP_REASON;
        log.info(
          { partNumber, serialNumber, doNotShipReason },
          '[create-order-only] aeroRepair: zero usage detected on a USSTG line — routing to CREATE_ORDER_ONLY instead of the Zero Usage exception',
        );
      } else {
        await closePartOwnDetails(page);
        return {
          status: 'zero_usage',
          partNumber,
          serialNumber,
          usageRows: partOwnDetails.usageRows,
          unassignedTaskWasAssigned,
          workPackageWasCreated,
        };
      }
    }

    // A DO-NOT-SHIP line gets the bare header only — confirmed rule: the
    // usage block is added "on non-zero-usage lines," and this line's
    // usage is, definitionally, all zero. Matches the recording exactly.
    const notesText = doNotShipReason ? `${NOTES_HEADER_TEXT}\n` : composeAeroRepairNotesText(partOwnDetails);

    const returnToLocation = transformReturnToLocation(currentLocation);

    // Real from the recording (line 22 Close, lines 23-24 recheck) — the
    // details view loses the line selection, so it must be re-checked
    // before Schedule Work Package works at all. Previously missing
    // entirely from this function (it went straight from the details page
    // to clickScheduleWorkPackage, which can't work — that link doesn't
    // exist there).
    await closePartOwnDetails(page);
    await recheckRepairLineForSchedule(page, linkText, routing.location);

    await clickScheduleWorkPackage(page);
    // ScheduleCheck.jsp defaults to "Work done internally" — NOT covered
    // by the recording (its test order had exactly one eligible vendor
    // bid; live testing confirmed selecting a vendor radio doesn't bypass
    // this toggle when a line has multiple bids, as ours does). Required
    // to reach the real vendor fields at all — see selectors.ts's docstring.
    await selectExternalVendorWorkPackage(page);

    const chargeToAccountBefore = await readChargeToAccount(page);
    let chargeToAccountAfter: string;
    if (doNotShipReason) {
      // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — REAL
      // FINDING from the shared vendor-code engine's own first live test
      // (21844/D98C08-607/1280): leaving Charge To Account blank made
      // Schedule Work Package's "OK" silently produce no order at all.
      // Per explicit user direction after that finding: Aero Repair gets
      // its own fixed literal fallback here, "CR7WHEELSBRAKES".
      chargeToAccountAfter = AERO_REPAIR_CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK;
      await fillChargeToAccount(page, chargeToAccountAfter);
      const chargeToAccountReadBack = await readChargeToAccount(page);
      if (chargeToAccountReadBack !== AERO_REPAIR_CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK) {
        throw new Error(
          `Charge To Account read-back mismatch for ${partNumber}/${serialNumber}: expected literal ` +
            `"${AERO_REPAIR_CREATE_ORDER_ONLY_CHARGE_TO_ACCOUNT_FALLBACK}" (CREATE_ORDER_ONLY fallback), got "${chargeToAccountReadBack}".`,
        );
      }
    } else {
      chargeToAccountAfter = buildWheelsBrakesChargeToAccount(chargeToAccountBefore);
      await fillChargeToAccount(page, chargeToAccountAfter);
    }

    await fillPurchasingContact(page, PURCHASING_CONTACT);
    await selectConditions(page, CONDITIONS_LABEL);
    await fillReturnToLocation(page, returnToLocation);
    await selectTransportation(page, TRANSPORTATION_LABEL);
    await fillNotesToVendor(page, notesText);

    await confirmScheduleWorkPackage(page);
    const generatedOrderNumber = await findGeneratedOrderNumber(page, linkText);

    // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — STRUCTURAL
    // guard: this branch returns before Request Authorization/Issue
    // Order/Move to Dock are ever reached below (processLine.ts's own
    // Issue/Dock calls are gated on the 'filled' status + authorizationRequested,
    // both of which this outcome never produces, so it's unreachable from
    // there too — not via a skippable flag).
    if (doNotShipReason) {
      if (!generatedOrderNumber) {
        throw new Error(
          `CREATE_ORDER_ONLY (reason: ${doNotShipReason}) but no order number was found after Schedule Work ` +
            `Package for ${partNumber}/${serialNumber}.`,
        );
      }
      const note = composeDoNotShipNote(doNotShipReason);
      await completeCreateOrderOnly(page, generatedOrderNumber, note);

      const verification = await verifyExternalReferenceCommitted(page, generatedOrderNumber, client.todoListUrl, note);
      if (!verification.committed) {
        throw new Error(
          `CREATE_ORDER_ONLY external reference verification failed for order ${generatedOrderNumber} ` +
            `(${partNumber}/${serialNumber}): expected "${note}", got "${verification.realValue ?? '(not found)'}".`,
        );
      }

      return {
        status: 'order_created_do_not_ship',
        partNumber,
        serialNumber,
        generatedOrderNumber,
        reason: doNotShipReason,
        externalReferenceNote: note,
        unassignedTaskWasAssigned,
        workPackageWasCreated,
      };
    }

    let authFlow: string | null = null;
    let authorizationRequested = false;

    // REAL BUG FOUND AND FIXED, from a real production batch run: this
    // used to set `authorizationRequested = true` unconditionally right
    // after confirmAuthorizationRequest()'s click, with no verification —
    // the exact same class of bug as the ESD module's documented
    // reissueOrder() anomaly (a click that reports no error, yet doesn't
    // reliably commit server-side). Confirmed live, 3 times across one
    // batch run (real orders P000BB18, P000BB1P, P000BB1Q): the click
    // sequence completed with no thrown error, but the real Authorization
    // Status stayed PENDING (not APPROVED) and Order Status stayed OPEN
    // (not AUTH) — so every downstream Issue Order attempt failed,
    // confusingly, on an order that never should have been considered
    // "authorization requested" in the first place. Now independently
    // re-reads the real Authorization Status after the click; if it's not
    // APPROVED, retries the whole request-authorization sequence once
    // (a fresh attempt, not just re-checking) before giving up — a
    // transient rendering/timing delay, the same general class of issue
    // found elsewhere in this project this session, is exactly the kind
    // of failure a prompt retry can resolve. Only reports
    // `authorizationRequested: true` once the real state actually
    // confirms it — a caller can now trust this field instead of
    // discovering the truth only when Issue Order later fails.
    if (generatedOrderNumber) {
      // openGeneratedOrder clicks the order-number link that only exists
      // on the page right after Schedule Work Package — called once,
      // here, to transition onto the order's own RO Details page. Each
      // retry below re-lands on that same RO Details page via
      // readOrderRealState's own fresh search navigation, so
      // clickRequestAuthorization can be retried directly without
      // needing that link again.
      await openGeneratedOrder(page, generatedOrderNumber);

      const MAX_AUTH_ATTEMPTS = 2;
      for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
        await clickRequestAuthorization(page);
        await selectAuthFlow(page, AUTH_FLOW);
        authFlow = AUTH_FLOW;
        await confirmAuthorizationRequest(page);

        const realState = await readOrderRealState(page, generatedOrderNumber, client.todoListUrl);
        if (realState.authorizationStatus === 'APPROVED') {
          authorizationRequested = true;
          break;
        }
      }
    }

    return {
      status: 'filled',
      fields: {
        partNumber,
        serialNumber,
        currentLocation,
        routing,
        purchasingContact: PURCHASING_CONTACT,
        returnToLocation,
        conditions: CONDITIONS_LABEL,
        transportation: TRANSPORTATION_LABEL,
        chargeToAccountBefore,
        chargeToAccountAfter,
        notesText,
        generatedOrderNumber,
        authFlow,
        authorizationRequested,
      },
      unassignedTaskWasAssigned,
      workPackageWasCreated,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3, requirement 4 — REAL
    // BUG FOUND AND FIXED: this used to swallow EVERY throw, including a
    // genuine session/login loss, into a per-line error — contradicting
    // this module's own documented "session loss halts the whole run"
    // intent (see retryBackoff.ts's isSessionLossError docstring for the
    // full account). Re-thrown here instead of converted to a per-line
    // outcome, so it propagates to processLine.ts and the batch loop's
    // own top-level catch, which halts the run rather than quarantining a
    // condition that will never resolve by retrying one line.
    if (isSessionLossError(errorMessage)) {
      throw err;
    }
    return {
      status: 'error',
      partNumber,
      serialNumber: knownSerialNumber,
      errorMessage,
    };
  }
}
