import path from 'node:path';
import { insertWriteUpAction, insertWriteUpDockMove, insertWriteUpIssueDecision, openDb } from '../../db/db.js';
import type { MxiClient } from '../../mxiWriter/mxiClient.js';
import { verifyLineStillEligible } from './batchDiscovery.js';
import { appendDiscoveryLogRows, type CompletedRow, type ExceptionRow } from './discoveryLog.js';
import { issueGeneratedOrder, moveOutboundShipmentToDock, readOrderRealState } from './issueOrder.js';
import { isSessionLossError } from './retryBackoff.js';
import { runAeroRepairWriteUp } from './writeUp.js';
import type { UsageParmRow } from './partDetails.js';

export const LOG_FILE_PATH = path.join('data', 'aero-repair-writeup-log.xlsx');
const REVIEWED_BY = 'batch-execute-automated';

/**
 * Extracted from aeroRepairBatchExecuteCli.ts so aeroRepairContinueAdHocCli.ts
 * (the one-time manual-continuation proof command) can drive the exact
 * same real flow — write-up through Issue Order and Move to Dock, same
 * independent-verification discipline throughout — rather than
 * duplicating it and risking the two paths drifting apart.
 */
export type ProcessLineResult =
  | {
      status: 'completed';
      orderNumber: string;
      stationCode: string;
      routingLocation: string;
      shipmentId: string | null;
      /** Additive field for the Order Write-Ups UI's "task assigned, then completed" summary — see CLAUDE_CODE_PROMPT frontend spec. */
      unassignedTaskWasAssigned?: boolean;
    }
  | { status: 'no_longer_eligible' }
  | { status: 'no_tasks_assigned'; stationCode: string }
  | { status: 'multiple_candidate_tasks'; stationCode: string; candidateNames: string[] }
  | { status: 'ad_hoc_pending_manual_continuation'; serialNumber: string; taskName: string }
  | { status: 'unrecognized_station'; stationCode: string }
  /**
   * CLAUDE_CODE_PROMPT (email-maintenance-records button, 2026-08-14) —
   * partNumber/serialNumber/usageRows added (previously carried nothing at
   * all) per explicit user instruction, so the frontend can build a
   * plain-text times/cycles table for the new "email Maintenance Records"
   * draft button without re-reading MXI.
   */
  | { status: 'zero_usage'; partNumber: string; serialNumber: string; usageRows: UsageParmRow[] }
  | { status: 'unassigned_task_multiple_present'; candidateCount: number }
  | { status: 'unassigned_task_detection_suspect' }
  | { status: 'no_removal_task_info_found' }
  /**
   * CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — the RO was
   * created but Request Authorization/Issue Order/Move to Dock were never
   * reached. Structurally distinct from 'completed': processLine below
   * returns immediately on this status, before the issue/dock block that
   * only ever runs for a 'pending_issue' write_up_actions row.
   */
  | { status: 'order_created_do_not_ship'; orderNumber: string; reason: string; externalReferenceNote: string }
  | { status: 'automation_error'; step: string; errorMessage: string; stationCode: string | null }
  /**
   * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — main-pass-only,
   * non-terminal: a retryable failure (indeterminate read, target not
   * found in a grid that may not have finished rendering, etc.) was hit
   * on the single main-pass attempt. Never returned when `phase ===
   * 'second'` — the second pass always resolves to a real terminal
   * status, same as every other variant above.
   */
  | { status: 'quarantined'; reason: 'no_longer_eligible' | 'automation_error'; detail: string };

export async function processLine(
  db: ReturnType<typeof openDb>,
  client: MxiClient,
  env: string,
  partNumber: string,
  serialNumber: string,
  /**
   * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — 'main' (one
   * content-aware attempt per underlying read, no inline backoff; a
   * retryable failure is quarantined rather than finalized) or 'second'
   * (today's original behavior, unchanged: full multi-attempt retry with
   * real backoff, and every outcome — including a repeat failure — is
   * final). Required, not defaulted, so every call site makes this choice
   * explicitly rather than inheriting a silent default.
   */
  phase: 'main' | 'second',
): Promise<ProcessLineResult> {
  try {
    return await processLineInner(db, client, env, partNumber, serialNumber, phase);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    // REAL GAP FOUND AND FIXED (Layer 3): verifyLineStillEligible can
    // throw on a genuinely indeterminate read (never treated as a
    // confirmed negative — see its own docstring), and that throw was
    // previously completely uncaught here, propagating all the way to
    // executeRunner.ts's top-level catch and halting the ENTIRE run over
    // one line's transient read failure — exactly the "a per-line
    // retryable failure never [halts the whole run]" rule this fix
    // exists to uphold. Session loss is the one genuine exception and is
    // deliberately re-thrown, not quarantined — see isSessionLossError's
    // own docstring.
    if (isSessionLossError(errorMessage)) {
      throw err;
    }
    if (phase === 'main') {
      insertWriteUpAction(db, {
        vendor: 'aeroRepair',
        partNumber,
        targetEnv: env,
        outcome: 'quarantined',
        stationCode: null,
        routedLocation: null,
        filledFieldsJson: JSON.stringify({ serialNumber, reason: 'automation_error' }, null, 2),
        errorMessage,
        orderNumber: null,
      });
      return { status: 'quarantined', reason: 'automation_error', detail: errorMessage };
    }
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'error',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber }, null, 2),
      errorMessage,
      orderNumber: null,
    });
    return { status: 'automation_error', step: 'eligibility-check', errorMessage, stationCode: null };
  }
}

async function processLineInner(
  db: ReturnType<typeof openDb>,
  client: MxiClient,
  env: string,
  partNumber: string,
  serialNumber: string,
  phase: 'main' | 'second',
): Promise<ProcessLineResult> {
  const stillEligible = await verifyLineStillEligible(client, partNumber, serialNumber, phase === 'main' ? 1 : 3);
  if (!stillEligible) {
    if (phase === 'main') {
      // Per explicit fix spec: "Retire the ability to emit 'Already handled
      // by someone else' from a single partial-grid read ... even [a
      // complete-grid confirmed absence should] prefer to let the second
      // pass confirm." Quarantined, not finalized — see the 'quarantined'
      // audit-only outcome's own docstring in db.ts.
      insertWriteUpAction(db, {
        vendor: 'aeroRepair',
        partNumber,
        targetEnv: env,
        outcome: 'quarantined',
        stationCode: null,
        routedLocation: null,
        filledFieldsJson: JSON.stringify({ serialNumber, reason: 'no_longer_eligible' }, null, 2),
        errorMessage: null,
        orderNumber: null,
      });
      return { status: 'quarantined', reason: 'no_longer_eligible', detail: 'Line was not confirmed eligible on the main-pass attempt.' };
    }
    // REAL GAP FOUND AND FIXED: this used to return without ever calling
    // insertWriteUpAction, same as no_tasks_assigned/multiple_candidate_tasks
    // below — meaning every "No Longer Eligible" skip (10 real ones found
    // across three days) existed ONLY in the xlsx log, invisible to any DB
    // query. Now recorded here too, so the DB alone is a complete record.
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'no_longer_eligible',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber }, null, 2),
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'no_longer_eligible' };
  }

  const writeUpOutcome = await runAeroRepairWriteUp(client, partNumber, serialNumber, phase === 'main' ? 1 : 3);

  // CLAUDE_CODE_PROMPT_AERO_BUGS.md Defect 2, change 7: a distinct,
  // append-only record of every line that required a real task assignment
  // — separate from whatever the write-up's own eventual outcome is (an
  // assignment can be followed by ANY outcome: filled, unrecognized_station,
  // zero_usage, ...), so it's auditable how many lines needed this without
  // grepping filledFieldsJson across every outcome type.
  if (writeUpOutcome.unassignedTaskWasAssigned) {
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'unassigned_task_assigned',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber }, null, 2),
      errorMessage: null,
      orderNumber: null,
    });
  }

  if (writeUpOutcome.status === 'no_tasks_assigned') {
    // REAL GAP FOUND AND FIXED: same as no_longer_eligible above — this
    // outcome (60 real occurrences) was previously xlsx-only.
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'no_tasks_assigned',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber }, null, 2),
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'no_tasks_assigned', stationCode: '(unknown)' };
  }
  if (writeUpOutcome.status === 'multiple_candidate_tasks') {
    // REAL GAP FOUND AND FIXED: same as above — previously xlsx-only.
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'multiple_candidate_tasks',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify(
        { serialNumber, candidateNames: writeUpOutcome.candidateNames },
        null,
        2,
      ),
      errorMessage: null,
      orderNumber: null,
    });
    return {
      status: 'multiple_candidate_tasks',
      stationCode: '(unknown)',
      candidateNames: writeUpOutcome.candidateNames,
    };
  }
  if (writeUpOutcome.status === 'ad_hoc_pending_manual_continuation') {
    // A real mutation happened (the Ad-Hoc task was genuinely created) —
    // unlike no_tasks_assigned/multiple_candidate_tasks (both read-only),
    // this gets a real write_up_actions row, same as every other real
    // write this module makes.
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'ad_hoc_pending_manual_continuation',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify(
        { serialNumber: writeUpOutcome.serialNumber, taskName: writeUpOutcome.taskName },
        null,
        2,
      ),
      errorMessage: null,
      orderNumber: null,
    });
    return {
      status: 'ad_hoc_pending_manual_continuation',
      serialNumber: writeUpOutcome.serialNumber,
      taskName: writeUpOutcome.taskName,
    };
  }
  if (writeUpOutcome.status === 'unrecognized_station') {
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'unrecognized_station',
      stationCode: writeUpOutcome.stationCode,
      routedLocation: null,
      filledFieldsJson: null,
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'unrecognized_station', stationCode: writeUpOutcome.stationCode };
  }
  if (writeUpOutcome.status === 'zero_usage') {
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'zero_usage',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber: writeUpOutcome.serialNumber, usageRows: writeUpOutcome.usageRows }, null, 2),
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'zero_usage', partNumber, serialNumber: writeUpOutcome.serialNumber, usageRows: writeUpOutcome.usageRows };
  }
  if (writeUpOutcome.status === 'unassigned_task_multiple_present') {
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'unassigned_task_multiple_present',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify(
        { serialNumber: writeUpOutcome.serialNumber, candidateCount: writeUpOutcome.candidateCount },
        null,
        2,
      ),
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'unassigned_task_multiple_present', candidateCount: writeUpOutcome.candidateCount };
  }
  if (writeUpOutcome.status === 'unassigned_task_detection_suspect') {
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'unassigned_task_detection_suspect',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber: writeUpOutcome.serialNumber }, null, 2),
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'unassigned_task_detection_suspect' };
  }
  if (writeUpOutcome.status === 'no_removal_task_info_found') {
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'no_removal_task_info_found',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber: writeUpOutcome.serialNumber }, null, 2),
      errorMessage: null,
      orderNumber: null,
    });
    return { status: 'no_removal_task_info_found' };
  }
  if (writeUpOutcome.status === 'order_created_do_not_ship') {
    // CLAUDE_CODE_PROMPT ("Create Order Only" terminal state) — structural
    // guard: returns here, before the issue/dock block further down that
    // only ever runs for a 'pending_issue' outcome (this status never
    // produces one). No insertWriteUpIssueDecision/insertWriteUpDockMove
    // row is ever created for this outcome — genuinely never reached.
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'order_created_do_not_ship',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify(
        { serialNumber: writeUpOutcome.serialNumber, reason: writeUpOutcome.reason, externalReferenceNote: writeUpOutcome.externalReferenceNote },
        null,
        2,
      ),
      errorMessage: null,
      orderNumber: writeUpOutcome.generatedOrderNumber,
    });
    return {
      status: 'order_created_do_not_ship',
      orderNumber: writeUpOutcome.generatedOrderNumber,
      reason: writeUpOutcome.reason,
      externalReferenceNote: writeUpOutcome.externalReferenceNote,
    };
  }
  if (writeUpOutcome.status === 'error') {
    if (phase === 'main') {
      // Per Layer 3: a main-pass read/automation failure quarantines
      // rather than finalizing as 'error' — the exact same failure class
      // (indeterminate reads, target-not-found-in-an-incomplete-grid,
      // Unassigned-Tasks detection timing) that this whole fix targets.
      insertWriteUpAction(db, {
        vendor: 'aeroRepair',
        partNumber,
        targetEnv: env,
        outcome: 'quarantined',
        stationCode: null,
        routedLocation: null,
        filledFieldsJson: JSON.stringify({ serialNumber: writeUpOutcome.serialNumber, reason: 'automation_error' }, null, 2),
        errorMessage: writeUpOutcome.errorMessage,
        orderNumber: null,
      });
      return { status: 'quarantined', reason: 'automation_error', detail: writeUpOutcome.errorMessage };
    }
    // GAP FOUND AND FIXED: this used to log filledFieldsJson: null for
    // every error, so a write_up_actions 'error' row could never be
    // attributed to a specific line without cross-referencing the xlsx log
    // separately. writeUpOutcome now carries serialNumber (see writeUp.ts),
    // so it's recorded here the same way every other non-'error' outcome
    // already records identifying context.
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'error',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: JSON.stringify({ serialNumber: writeUpOutcome.serialNumber }, null, 2),
      errorMessage: writeUpOutcome.errorMessage,
      orderNumber: null,
    });
    return { status: 'automation_error', step: 'write-up', errorMessage: writeUpOutcome.errorMessage, stationCode: null };
  }

  // status === 'filled'
  const { fields } = writeUpOutcome;
  const stationCode = fields.routing.status === 'routed' ? fields.routing.stationCode : null;
  const routedLocation = fields.routing.status === 'routed' ? fields.routing.location : null;
  const dbOutcome = fields.generatedOrderNumber && fields.authorizationRequested ? 'pending_issue' : 'filled';

  const writeUpActionId = insertWriteUpAction(db, {
    vendor: 'aeroRepair',
    partNumber,
    targetEnv: env,
    outcome: dbOutcome,
    stationCode,
    routedLocation,
    filledFieldsJson: JSON.stringify(fields, null, 2),
    errorMessage: null,
    orderNumber: fields.generatedOrderNumber,
  });

  if (!fields.generatedOrderNumber || !fields.authorizationRequested) {
    return {
      status: 'automation_error',
      step: 'write-up',
      errorMessage: 'Write-up completed but no order number was generated or authorization was not requested.',
      stationCode,
    };
  }
  const orderNumber = fields.generatedOrderNumber;

  // Issue Order — no pause, per the relaxed-gate decision. Independently
  // re-verified regardless of what issueGeneratedOrder itself reported,
  // same discipline as the manual approve-issue CLI.
  const issueResult = await issueGeneratedOrder(client, orderNumber);
  const page = await client.getAuthenticatedPage();
  const { orderStatus } = await readOrderRealState(page, orderNumber, client.todoListUrl);
  const genuinelyIssued = orderStatus === 'ISSUED';

  const writeUpIssueDecisionId = insertWriteUpIssueDecision(db, {
    writeUpActionId,
    orderNumber,
    targetEnv: env,
    action: 'approved_issue',
    issueStatus: genuinelyIssued ? 'success' : 'failed',
    errorMessage: issueResult.status === 'success' ? null : issueResult.errorMessage,
    reviewedBy: REVIEWED_BY,
  });

  if (!genuinelyIssued) {
    return {
      status: 'automation_error',
      step: 'issue-order',
      errorMessage: `Order ${orderNumber} not confirmed ISSUED (real status: ${orderStatus ?? '(not found)'}; issueGeneratedOrder reported: ${issueResult.status}${issueResult.errorMessage ? ' — ' + issueResult.errorMessage : ''}).`,
      stationCode,
    };
  }

  // Move to Dock — same flow, no pause.
  const dockResult = await moveOutboundShipmentToDock(client, orderNumber);

  insertWriteUpDockMove(db, {
    writeUpIssueDecisionId,
    orderNumber,
    targetEnv: env,
    shipmentId: dockResult.shipmentId,
    moveStatus: dockResult.status,
    errorMessage: dockResult.status === 'success' || dockResult.status === 'already_docked_externally' ? null : dockResult.errorMessage,
  });

  if (dockResult.status === 'failed' || dockResult.status === 'no_outbound_shipment_found') {
    return {
      status: 'automation_error',
      step: 'move-to-dock',
      errorMessage: dockResult.errorMessage ?? dockResult.status,
      stationCode,
    };
  }

  return {
    status: 'completed',
    orderNumber,
    stationCode: stationCode ?? '(unknown)',
    routingLocation: routedLocation ?? '(unknown)',
    shipmentId: dockResult.shipmentId,
    unassignedTaskWasAssigned: writeUpOutcome.unassignedTaskWasAssigned,
  };
}

/**
 * Shared per-line result -> xlsx row logging, extracted alongside
 * processLine for the same reuse reason. Logs immediately (not
 * accumulated), same as the original batch-execute loop.
 */
export async function logProcessLineResult(
  target: { partNumber: string; serialNumber: string },
  result: ProcessLineResult,
  env: string,
): Promise<void> {
  const dateFound = new Date().toISOString();
  const completed: CompletedRow[] = [];
  const exceptions: ExceptionRow[] = [];

  if (result.status === 'completed') {
    console.log(`COMPLETED: order ${result.orderNumber}, routed to ${result.routingLocation}, docked (shipment ${result.shipmentId ?? '(n/a)'}).`);
    completed.push({
      orderNumber: result.orderNumber,
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: result.stationCode,
      routingDestination: result.routingLocation,
      date: dateFound,
    });
  } else if (result.status === 'no_longer_eligible') {
    console.log('SKIPPED: no longer eligible (claimed by another process since discovery).');
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'No Longer Eligible (claimed by another process)',
      details: `Fresh re-check immediately before processing found this line no longer eligible — an order now exists for it, or it is no longer present in the open-inventory grid.`,
      suggestedAction: 'No action needed — this is expected on a shared production system. Another process or user has already claimed this line.',
    });
  } else if (result.status === 'no_tasks_assigned') {
    console.log('SKIPPED: no tasks assigned (re-discovered live, not just from the earlier scan).');
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: result.stationCode,
      dateFound,
      issueType: 'No Task Assigned',
      details: `Line has no assigned tasks on the default Assigned Tasks tab (found live during batch execution, not just discovery).`,
      suggestedAction:
        'Manually assign a task to this work package before a write-up can be created, or confirm no repair is needed.',
    });
  } else if (result.status === 'multiple_candidate_tasks') {
    console.log(`SKIPPED: ${result.candidateNames.length} candidate tasks found, flagging for human review (not guessing among them).`);
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: result.stationCode,
      dateFound,
      issueType: 'Multiple Candidate Tasks',
      details: `Line has ${result.candidateNames.length} real candidate task definitions, not yet formally assigned: ${result.candidateNames.join('; ')}`,
      suggestedAction: 'Manually determine which task (if any) applies and assign it before a write-up can be created — automation refuses to guess among multiple candidates.',
    });
  } else if (result.status === 'ad_hoc_pending_manual_continuation') {
    const envFlag = env === 'production' ? ' --env production' : '';
    const continueCommand = `npm run aero-repair:continue-ad-hoc -- ${target.partNumber} ${result.serialNumber}${envFlag}`;
    console.log(`PAUSED: Ad-Hoc task created ("${result.taskName}") — pending one-time manual proof.`);
    console.log(`Run to continue: ${continueCommand}`);
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'Ad-Hoc Task Created - Pending Manual Continuation',
      details: `Created Ad-Hoc task "${result.taskName}" but paused before Auth Flow/Issue Order/Move to Dock — this specific recovery path's continuation has not yet been proven end-to-end. A real task was created; nothing further was submitted.`,
      suggestedAction: `Run \`${continueCommand}\` to manually continue this one order and prove the path for real. Once that succeeds, subsequent single-candidate cases will run fully automatically.`,
    });
  } else if (result.status === 'unrecognized_station') {
    console.log(`SKIPPED: unrecognized station "${result.stationCode}".`);
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: result.stationCode,
      dateFound,
      issueType: 'Unrecognized Station',
      details: `Line is at station "${result.stationCode}", which has no entry in the 12-station Aero Repair routing table.`,
      suggestedAction: "This part's current station isn't in the automated routing table — manually determine the correct Aero Repair location.",
    });
  } else if (result.status === 'zero_usage') {
    console.log('SKIPPED: Current Usage shows all-zero CYCLES/HOURS (TSN/TSO/TSI) — likely a maintenance-records data problem.');
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'Zero Usage - Records Error',
      details: 'Current Usage table shows CYCLES and HOURS both at exactly 0 for TSN/TSO/TSI — a real part in active repair inventory should not show zero usage across the board.',
      suggestedAction: 'Notify the maintenance records team to correct this part\'s usage data before a write-up can be created for it.',
    });
  } else if (result.status === 'unassigned_task_multiple_present') {
    console.log(`SKIPPED: ${result.candidateCount} genuinely-assignable unassigned tasks found, flagging for human review (not guessing among them).`);
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'Multiple Unassigned Tasks',
      details: `Unassigned Tasks sub-tab shows ${result.candidateCount} real, non-PC candidate tasks — ambiguous which (if not all) should be assigned to this work package.`,
      suggestedAction: 'Manually determine which unassigned task(s) apply and assign them — automation refuses to guess among multiple candidates.',
    });
  } else if (result.status === 'unassigned_task_detection_suspect') {
    console.log('SKIPPED: a task checkbox was detected on the Unassigned Tasks sub-tab, but every candidate filtered out as PC (administrative) — detection is suspect.');
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'Unassigned Task Detection Suspect',
      details: 'A real task checkbox was present on the Unassigned Tasks sub-tab, but it was the PC (Parts Card) administrative row, not a genuine assignable task — refusing to assign it and refusing to silently treat this line as clean.',
      suggestedAction: 'Manually inspect this line\'s Unassigned Tasks sub-tab to confirm whether anything genuinely needs assignment.',
    });
  } else if (result.status === 'no_removal_task_info_found') {
    console.log('SKIPPED: no task assigned, and this line\'s Removal Information has no Task Name/ID either.');
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'No Removal Task Info Found',
      details: 'No task is currently assigned to this work package, and the line\'s own Removal Information (Task Name/ID) is also empty — the real removal reason can\'t be determined, so no Ad-Hoc task was created.',
      suggestedAction: 'Manually determine the real removal reason/task and assign or create it before a write-up can be created for this line.',
    });
  } else if (result.status === 'order_created_do_not_ship') {
    console.log(`CREATE ORDER ONLY: order ${result.orderNumber} created, marked DO NOT SHIP (${result.reason}). No authorization, issue, or dock.`);
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: '(unknown)',
      dateFound,
      issueType: 'Order Created - DO NOT SHIP',
      details: `Order ${result.orderNumber} created and marked "${result.externalReferenceNote}" — reason: ${result.reason}. Not authorized, issued, or docked.`,
      suggestedAction: 'Once the underlying records issue is corrected, finish the workflow (authorize, issue, dock) on this existing order — a separate, not-yet-built capability. Do not create a second order for this line.',
    });
  } else if (result.status === 'quarantined') {
    // CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — non-terminal:
    // deliberately NOT pushed to the xlsx exceptions sheet (that log is
    // for real, final review-worthy outcomes). The automatic second pass
    // will call logProcessLineResult again with this line's real terminal
    // result once it resolves.
    console.log(`QUARANTINED (will retry automatically after the main pass): ${result.reason} — ${result.detail}`);
  } else {
    console.error(`AUTOMATION ERROR at step "${result.step}": ${result.errorMessage}`);
    exceptions.push({
      partNumber: target.partNumber,
      serialNumber: target.serialNumber,
      station: result.stationCode ?? '(unknown)',
      dateFound,
      issueType: 'Automation Error',
      details: `Failed at step "${result.step}": ${result.errorMessage}`,
      suggestedAction: 'Review manually in MXI and determine real state before retrying — do not assume nothing happened.',
    });
  }

  await appendDiscoveryLogRows(LOG_FILE_PATH, { exceptions, completed });
}
