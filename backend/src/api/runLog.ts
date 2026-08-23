import type { ProcessLineResult } from '../writeUps/aeroRepair/processLine.js';
import type { DiscoveredLine } from '../writeUps/aeroRepair/batchDiscovery.js';
import type { VendorCodeWriteUpOutcome } from '../writeUps/shared/vendorCodeWriteUp.js';
import type { UsageParmRow } from '../writeUps/shared/partOwnDetails.js';

/**
 * Frontend-facing structured event — never raw CLI stdout. One plain-English
 * sentence per line, full technical detail available but collapsed by
 * default. See "1 (1).md"'s "per-line log must be readable by a
 * non-technical analyst" section for the full rationale.
 */
export interface RunLogEvent {
  seq: number;
  timestamp: string;
  vendorId: string;
  vendorDisplayName: string;
  partNumber: string;
  serialNumber: string;
  description: string;
  /**
   * 'retrying' — CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3: a
   * main-pass line hit a retryable failure and was quarantined for the
   * automatic end-of-run second pass, rather than immediately finalized.
   * Never a terminal status — every quarantined line gets exactly one more
   * event later with its real terminal status.
   */
  status: 'in_progress' | 'completed' | 'skipped' | 'exception' | 'retrying';
  summary: string;
  orderNumber?: string;
  routedTo?: string;
  /** Machine-readable, for grouping/filtering — never shown as the primary sentence. */
  exceptionType?: string;
  /** Full technical text — collapsed by default behind "Show technical details." */
  detail?: string;
  /**
   * CLAUDE_CODE_PROMPT (email-maintenance-records button, 2026-08-14) —
   * only ever set on exceptionType 'zero_usage' events, for the frontend's
   * "Email Maintenance Records" draft button. Structured (not folded into
   * `detail`) so the frontend can build a clean plain-text table rather
   * than parsing it back out of a free-text technical-details blob.
   */
  usageRows?: UsageParmRow[];
}

/**
 * Pattern-matches the well-known distinct exception messages this project's
 * own guardrails throw (Vendor Bid Not Found, usage_table_rows_empty,
 * unassigned_task_state_indeterminate, unassigned_task_assignment_not_confirmed)
 * out of an otherwise-generic 'automation_error'/'error' outcome's raw
 * errorMessage — so the analyst-facing summary can be specific instead of a
 * blanket "something went wrong" whenever the underlying guardrail already
 * knows exactly what happened. Falls back to a generic message for anything
 * unrecognized — never guesses a MORE specific cause than the evidence
 * supports.
 */
function classifyErrorMessage(errorMessage: string): { exceptionType: string; summary: string } {
  if (errorMessage.includes('Vendor Bid Not Found') || errorMessage.includes('did not resolve to a definitive state (target location')) {
    return { exceptionType: 'vendor_bid_not_found', summary: "Could not find this vendor's bid on the line. Needs manual review." };
  }
  if (errorMessage.startsWith('usage_table_rows_empty') || errorMessage.includes('usage_table_rows_empty:')) {
    return { exceptionType: 'usage_table_rows_empty', summary: 'Times and cycles could not be read from this line. Needs manual review.' };
  }
  if (errorMessage.startsWith('unassigned_task_state_indeterminate') || errorMessage.includes('unassigned_task_state_indeterminate:')) {
    return { exceptionType: 'unassigned_task_state_indeterminate', summary: "Couldn't confirm this line's task status. Needs manual review." };
  }
  if (errorMessage.startsWith('unassigned_task_assignment_not_confirmed') || errorMessage.includes('unassigned_task_assignment_not_confirmed:')) {
    return { exceptionType: 'unassigned_task_assignment_not_confirmed', summary: "Assigned a task but couldn't confirm it stuck. Needs manual review." };
  }
  return { exceptionType: 'automation_error', summary: 'Something went wrong on this line. Needs manual review.' };
}

/**
 * CLAUDE_CODE_PROMPT_WRITEUP_FAILSAFE.md Layer 3 — a main-pass line was
 * quarantined (retryable failure, not yet final) rather than immediately
 * finalized. Every quarantined line gets exactly one more event later,
 * from the second pass, with its real terminal status.
 */
export function quarantinedLineToLogEvent(
  seq: number,
  vendorId: string,
  vendorDisplayName: string,
  target: { partNumber: string; serialNumber: string },
): RunLogEvent {
  return {
    seq,
    timestamp: new Date().toISOString(),
    vendorId,
    vendorDisplayName,
    partNumber: target.partNumber,
    serialNumber: target.serialNumber,
    description: target.partNumber,
    status: 'retrying',
    summary: 'Hit a temporary snag — will retry automatically once the main pass finishes.',
  };
}

/** Aero Repair's own discovery-time exception classifications — before any execute attempt. */
export function discoveredLineToLogEvent(
  seq: number,
  vendorId: string,
  vendorDisplayName: string,
  line: DiscoveredLine,
): RunLogEvent {
  const base = {
    seq,
    timestamp: new Date().toISOString(),
    vendorId,
    vendorDisplayName,
    partNumber: line.partNumber,
    serialNumber: line.serialNumber,
    description: line.linkText.replace(/^Repair /, '').replace(/\s*\(PN:.*$/, '') || line.partNumber,
  };

  switch (line.classification) {
    case 'eligible-for-write-up':
      return {
        ...base,
        status: 'completed', // discovery-time "found, selectable" — not an exception
        summary: `Ready to write up — routes to ${line.routingLocation ?? '(unknown)'}.`,
        routedTo: line.routingLocation ?? undefined,
      };
    case 'no-task-exception':
      return {
        ...base,
        status: 'exception',
        summary: 'No task on this line yet. Needs manual review.',
        exceptionType: 'no_task_assigned',
      };
    case 'unrecognized-station-exception':
      return {
        ...base,
        status: 'exception',
        summary: "This line's station isn't in the routing table yet. Needs manual review.",
        exceptionType: 'unrecognized_station',
      };
    case 'no-work-package':
      // Addition 1 (Create Work Package) — no longer a blocking exception:
      // this line will get a work package created automatically, then
      // continue the normal write-up, same as an ordinary eligible line.
      return {
        ...base,
        status: 'completed', // discovery-time "found, selectable" — not an exception
        summary: 'No work package yet — one will be created automatically.',
        detail: line.note ?? undefined,
      };
  }
}

/** Aero Repair's own execute-time per-line outcome, per processLine()'s real ProcessLineResult union. */
export function aeroRepairResultToLogEvent(
  seq: number,
  vendorId: string,
  vendorDisplayName: string,
  target: { partNumber: string; serialNumber: string },
  result: ProcessLineResult,
): RunLogEvent {
  const base = {
    seq,
    timestamp: new Date().toISOString(),
    vendorId,
    vendorDisplayName,
    partNumber: target.partNumber,
    serialNumber: target.serialNumber,
    description: target.partNumber,
  };

  switch (result.status) {
    case 'completed': {
      const dockPart = result.shipmentId ? 'and moved to dock' : 'and issued';
      const summary = result.unassignedTaskWasAssigned
        ? `Task assigned to work package, then order ${result.orderNumber} created.`
        : `Order ${result.orderNumber} created ${dockPart} — routed to ${result.routingLocation}.`;
      return { ...base, status: 'completed', summary, orderNumber: result.orderNumber, routedTo: result.routingLocation };
    }
    case 'no_longer_eligible':
      return { ...base, status: 'skipped', summary: 'Already handled by someone else — skipped.', exceptionType: 'no_longer_eligible' };
    case 'no_tasks_assigned':
      return { ...base, status: 'exception', summary: 'No task on this line yet. Needs manual review.', exceptionType: 'no_task_assigned' };
    case 'multiple_candidate_tasks':
      return {
        ...base,
        status: 'exception',
        summary: 'Multiple possible tasks found on this line — needs manual review to pick the right one.',
        exceptionType: 'multiple_candidate_tasks',
        detail: `Candidates: ${result.candidateNames.join('; ')}`,
      };
    case 'ad_hoc_pending_manual_continuation':
      return {
        ...base,
        serialNumber: result.serialNumber,
        status: 'exception',
        summary: 'A task was created, but this line needs a one-time manual confirmation before continuing. Needs manual review.',
        exceptionType: 'ad_hoc_pending_manual_continuation',
        detail: `Ad-Hoc task created: "${result.taskName}"`,
      };
    case 'work_package_created_pending_manual_continuation':
      return {
        ...base,
        serialNumber: result.serialNumber,
        status: 'exception',
        summary: 'A work package was created, but this line needs a one-time manual confirmation before continuing. Needs manual review.',
        exceptionType: 'work_package_created_pending_manual_continuation',
        detail: `Work package created: "${result.workPackageName}"`,
      };
    case 'unrecognized_station':
      return { ...base, status: 'exception', summary: "This line's station isn't in the routing table yet. Needs manual review.", exceptionType: 'unrecognized_station' };
    case 'zero_usage':
      return {
        ...base,
        partNumber: result.partNumber,
        serialNumber: result.serialNumber,
        status: 'exception',
        summary: 'Times and cycles read as zero — records issue. Needs manual review.',
        exceptionType: 'zero_usage',
        usageRows: result.usageRows,
      };
    case 'unassigned_task_multiple_present':
      return {
        ...base,
        status: 'exception',
        summary: 'Multiple unassigned tasks found — needs manual review to decide which to assign.',
        exceptionType: 'unassigned_task_multiple_present',
        detail: `${result.candidateCount} candidate(s) found.`,
      };
    case 'unassigned_task_detection_suspect':
      return { ...base, status: 'exception', summary: "This line's task status looked ambiguous. Needs manual review.", exceptionType: 'unassigned_task_detection_suspect' };
    case 'no_removal_task_info_found':
      return { ...base, status: 'exception', summary: 'No task info available for this line. Needs manual review.', exceptionType: 'no_removal_task_info_found' };
    case 'order_created_do_not_ship':
      return {
        ...base,
        status: 'exception',
        summary: `Order ${result.orderNumber} created — marked DO NOT SHIP (${result.reason.toLowerCase()}). Needs manual review before it can proceed.`,
        exceptionType: 'order_created_do_not_ship',
        orderNumber: result.orderNumber,
        detail: result.externalReferenceNote,
      };
    case 'automation_error': {
      const { exceptionType, summary } = classifyErrorMessage(result.errorMessage);
      return { ...base, status: 'exception', summary, exceptionType, detail: `Failed at step "${result.step}": ${result.errorMessage}` };
    }
    case 'quarantined':
      // Never actually reached: executeRunner.ts intercepts a 'quarantined'
      // ProcessLineResult before ever calling this function, using
      // quarantinedLineToLogEvent instead (see its own docstring above).
      // This case exists only to satisfy exhaustiveness now that
      // 'quarantined' is part of the ProcessLineResult union.
      throw new Error('aeroRepairResultToLogEvent should never be called with a "quarantined" result — use quarantinedLineToLogEvent instead.');
  }
}

/**
 * Mirrors aeroRepairResultToLogEvent's own handling of an auto-assigned
 * task: the line no longer STOPS for an unassigned task (per explicit user
 * direction -- "I don't want those to be skipped anymore"), so the fact
 * that one was assigned has to stay visible in the run log, or an
 * assignment made on the user's behalf would be invisible.
 */
function withAssignedTaskPrefix(summary: string, fields: { unassignedTaskWasAssigned: boolean }): string {
  return fields.unassignedTaskWasAssigned ? `Task assigned to work package, then ${summary.charAt(0).toLowerCase()}${summary.slice(1)}` : summary;
}

/** Vendor-code family's own execute-time per-line outcome, per runVendorCodeWriteUp()'s real VendorCodeWriteUpOutcome union. */
export function vendorCodeOutcomeToLogEvent(
  seq: number,
  vendorId: string,
  vendorDisplayName: string,
  target: { partNumber: string; serialNumber: string },
  outcome: VendorCodeWriteUpOutcome,
): RunLogEvent {
  const base = {
    seq,
    timestamp: new Date().toISOString(),
    vendorId,
    vendorDisplayName,
    partNumber: target.partNumber,
    serialNumber: target.serialNumber,
    description: target.partNumber,
  };

  switch (outcome.status) {
    case 'authorized_only':
      return {
        ...base,
        partNumber: outcome.fields.partNumber,
        status: 'completed',
        summary: withAssignedTaskPrefix('Warranty authorization submitted — no order issued (handled by warranty dept).', outcome.fields),
        orderNumber: outcome.fields.generatedOrderNumber ?? undefined,
      };
    case 'issued_and_docked':
      return {
        ...base,
        partNumber: outcome.fields.partNumber,
        status: 'completed',
        summary: withAssignedTaskPrefix(`Order ${outcome.fields.generatedOrderNumber} created and moved to dock.`, outcome.fields),
        orderNumber: outcome.fields.generatedOrderNumber ?? undefined,
      };
    case 'issued_not_docked':
      return {
        ...base,
        partNumber: outcome.fields.partNumber,
        status: 'completed',
        summary: withAssignedTaskPrefix(`Order ${outcome.fields.generatedOrderNumber} created and issued — move to dock intentionally held back for now.`, outcome.fields),
        orderNumber: outcome.fields.generatedOrderNumber ?? undefined,
      };
    case 'order_created_do_not_ship':
      return {
        ...base,
        partNumber: outcome.fields.partNumber,
        status: 'exception',
        summary: withAssignedTaskPrefix(`Order ${outcome.fields.generatedOrderNumber} created — marked DO NOT SHIP (${outcome.reason.toLowerCase()}). Needs manual review before it can proceed.`, outcome.fields),
        exceptionType: 'order_created_do_not_ship',
        orderNumber: outcome.fields.generatedOrderNumber ?? undefined,
        detail: outcome.externalReferenceNote,
      };
    case 'order_created_awaiting_rma':
      return {
        ...base,
        partNumber: outcome.fields.partNumber,
        status: 'exception',
        summary: withAssignedTaskPrefix(`Order ${outcome.fields.generatedOrderNumber} created — awaiting RMA. Needs manual review before it can proceed.`, outcome.fields),
        exceptionType: 'order_created_awaiting_rma',
        orderNumber: outcome.fields.generatedOrderNumber ?? undefined,
        detail: outcome.externalReferenceNote,
      };
    case 'no_candidate_lines':
      return { ...base, status: 'exception', summary: 'No lines currently found for this vendor. Needs manual review.', exceptionType: 'no_candidate_lines' };
    case 'vendor_not_preferred':
      // Addition 3 (preferred-vendor check) — a legitimate, expected
      // business outcome, never surfaced as a failure/needs-review.
      return {
        ...base,
        partNumber: outcome.partNumber,
        serialNumber: outcome.serialNumber,
        status: 'skipped',
        summary: 'Another vendor is preferred for this part — skipped.',
        exceptionType: 'vendor_not_preferred',
      };
    case 'unassigned_task_present':
      return {
        ...base,
        partNumber: outcome.partNumber,
        serialNumber: outcome.serialNumber,
        status: 'exception',
        summary: 'An unassigned task is present on this line. Needs manual review.',
        exceptionType: 'unassigned_task_present',
        detail: outcome.taskDetail,
      };
    case 'no_removal_task_info_found':
      return { ...base, partNumber: outcome.partNumber, serialNumber: outcome.serialNumber, status: 'exception', summary: 'No task info available for this line. Needs manual review.', exceptionType: 'no_removal_task_info_found' };
    case 'zero_usage':
      return {
        ...base,
        partNumber: outcome.partNumber,
        serialNumber: outcome.serialNumber,
        status: 'exception',
        summary: 'Times and cycles read as zero — records issue. Needs manual review.',
        exceptionType: 'zero_usage',
        usageRows: outcome.usageRows,
      };
    case 'usage_table_absent_unexpected':
      return { ...base, partNumber: outcome.partNumber, serialNumber: outcome.serialNumber, status: 'exception', summary: 'Expected to find times and cycles but no table was there. Needs manual review.', exceptionType: 'usage_table_absent_unexpected' };
    case 'receiving_notes_flagged_account':
      return {
        ...base,
        partNumber: outcome.partNumber,
        serialNumber: outcome.serialNumber,
        status: 'exception',
        summary: 'Receiving notes mention "account" — flagged rather than risk the wrong Charge To Account. Needs manual review.',
        exceptionType: 'receiving_notes_flagged_account',
        detail: outcome.receivingNotes,
      };
    case 'authorization_not_confirmed':
      return {
        ...base,
        partNumber: outcome.partNumber,
        serialNumber: outcome.serialNumber,
        status: 'exception',
        summary: `Order ${outcome.orderNumber}'s authorization could not be confirmed. Needs manual review.`,
        exceptionType: 'authorization_not_confirmed',
        orderNumber: outcome.orderNumber,
        detail: `Real authorization status: ${outcome.realAuthorizationStatus ?? '(not found)'}`,
      };
    case 'error': {
      const { exceptionType, summary } = classifyErrorMessage(outcome.errorMessage);
      return {
        ...base,
        partNumber: outcome.partNumber ?? target.partNumber,
        serialNumber: outcome.serialNumber ?? target.serialNumber,
        status: 'exception',
        summary,
        exceptionType,
        detail: outcome.errorMessage,
      };
    }
  }
}
