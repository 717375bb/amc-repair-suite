import type { Page } from 'playwright';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import {
  AUTH_FLOW,
  CONDITIONS_LABEL,
  PURCHASING_CONTACT,
  TRANSPORTATION_LABEL,
} from './constants.js';
import { buildWheelsBrakesChargeToAccount } from './chargeToAccount.js';
import { isNoTasksAssignedException, isUnassignedTaskPresent } from './noTaskException.js';
import { isAdHocContinuationProven } from './adHocContinuationProof.js';
import { captureEmptyReadEvidence } from './emptyReadCapture.js';
import { waitForUnassignedTasksSectionResolved, waitForWorkPackageDetailsResolved } from './gridWait.js';
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
} from './partDetails.js';
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
  extractWorkPackageCheckId,
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
  readUnassignedTasksAreaText,
  selectAuthFlow,
  selectConditions,
  selectExternalVendorWorkPackage,
  selectTransportation,
} from './selectors.js';

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

export type AeroRepairWriteUpOutcome =
  | { status: 'filled'; fields: AeroRepairWriteUpFields }
  | { status: 'no_tasks_assigned'; partNumber: string }
  | { status: 'multiple_candidate_tasks'; partNumber: string; candidateNames: string[] }
  | {
      status: 'ad_hoc_pending_manual_continuation';
      partNumber: string;
      serialNumber: string;
      taskName: string;
    }
  | { status: 'unrecognized_station'; partNumber: string; stationCode: string }
  | { status: 'zero_usage'; partNumber: string; serialNumber: string }
  | { status: 'unassigned_task_present'; partNumber: string; serialNumber: string; taskDetail: string }
  | { status: 'error'; partNumber: string; serialNumber: string | null; errorMessage: string };

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

    const { serialNumber, linkText } = await findFirstRepairLineForPart(
      page,
      partNumber,
      client.todoListUrl,
      preferredSerialNumber,
    );
    knownSerialNumber = serialNumber;

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
        return { status: 'no_tasks_assigned', partNumber };
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
        };
      }

      // Exactly one real repair-relevant candidate — create an Ad-Hoc task
      // named after its real name text (createAdHocTaskForCandidate), then
      // continue the flow normally.
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
      // to trigger the prompt, using the real candidate's own name text
      // rather than the recording's literal "test" placeholder.
      //
      // Per explicit instruction: the real Work Package/Check ID is
      // appended directly after the candidate name in the Ad-Hoc task's
      // own name field. Extracted from assignedTasksText (already read
      // above) since that's the only page in this flow that displays it —
      // the Task Selection panel createAdHocTaskForCandidate operates on
      // does not show it. Throws rather than silently create a task
      // without the ID if the expected format isn't found.
      const checkId = extractWorkPackageCheckId(assignedTasksText);
      if (!checkId) {
        throw new Error(
          `Could not extract a Work Package/Check ID from the Assigned Tasks tab's title line — refusing to create an Ad-Hoc task without it: "${assignedTasksText.split('\n')[0]}"`,
        );
      }
      const taskName = `${candidates[0].name} ${checkId}`;
      await createAdHocTaskForCandidate(page, candidates[0], checkId);

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
    // isUnassignedTaskPresent — see gridWait.ts's
    // waitForUnassignedTasksSectionResolved for the full account.
    await waitForUnassignedTasksSectionResolved(page);
    // REAL GAP CLOSED: this view was previously a pure navigational
    // pass-through — required to reach the rest of the flow, but its
    // content was never read or checked. It has its own separately-
    // confirmed empty-state text (NO_UNASSIGNED_TASKS_TEXT), distinct from
    // the default Assigned Tasks tab's NO_TASKS_ASSIGNED_TEXT already
    // checked above — a genuine unassigned task row here is a real,
    // independent exception, not something the Assigned-Tasks-tab check
    // could ever catch (that check only sees tasks already formally
    // assigned to this work package). Read BEFORE closing — once Close is
    // clicked this content is gone.
    const unassignedTasksText = await readUnassignedTasksAreaText(page);
    if (isUnassignedTaskPresent(unassignedTasksText)) {
      await closeUnassignedTasksView(page);
      return { status: 'unassigned_task_present', partNumber, serialNumber, taskDetail: unassignedTasksText };
    }
    // The confirmed-empty state (isUnassignedTaskPresent === false) is
    // itself a meaningful result being trusted to mean "safe to continue"
    // — captured here, before closing, for the same reason as the other
    // three read paths: a false "confirmed empty" here (e.g. the page not
    // having fully rendered the real task row yet) would silently let a
    // work package with genuine unassigned work continue as if clean.
    await captureEmptyReadEvidence(page, 'unassigned-task-empty-state', { partNumber, serialNumber });
    await closeUnassignedTasksView(page);

    const currentLocation = await readCurrentLocationCode(page, linkText);
    const stationCode = currentLocation.split('/')[0];
    const routing = routeStationToAeroRepairLocation(stationCode);
    if (routing.status === 'exception') {
      return { status: 'unrecognized_station', partNumber, stationCode: routing.stationCode };
    }

    await openPartOwnDetails(page, linkText, serialNumber);
    const partOwnDetails = await readPartOwnDetails(page, partNumber, serialNumber);

    // Zero-usage records-error check: if the Current Usage table shows every
    // TSN/TSO/TSI value (CYCLES and HOURS both) as exactly zero, this is a
    // maintenance-records data problem, not a real repair-eligible line —
    // skip the write-up rather than schedule work against records that
    // can't reflect the part's real usage. Close the details view first,
    // same as every other early-return path in this function, so nothing
    // is left open/pending on the page.
    if (isZeroUsage(partOwnDetails.usageRows)) {
      await closePartOwnDetails(page);
      return { status: 'zero_usage', partNumber, serialNumber };
    }

    const notesText = composeAeroRepairNotesText(partOwnDetails);

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
    const chargeToAccountAfter = buildWheelsBrakesChargeToAccount(chargeToAccountBefore);
    await fillChargeToAccount(page, chargeToAccountAfter);

    await fillPurchasingContact(page, PURCHASING_CONTACT);
    await selectConditions(page, CONDITIONS_LABEL);
    await fillReturnToLocation(page, returnToLocation);
    await selectTransportation(page, TRANSPORTATION_LABEL);
    await fillNotesToVendor(page, notesText);

    await confirmScheduleWorkPackage(page);
    const generatedOrderNumber = await findGeneratedOrderNumber(page, linkText);

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
    };
  } catch (err) {
    return {
      status: 'error',
      partNumber,
      serialNumber: knownSerialNumber,
      errorMessage: err instanceof Error ? err.message : String(err),
    };
  }
}
