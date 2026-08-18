import { insertWriteUpAction, openDb, type WriteUpActionInsert } from '../../db/db.js';
import type { VendorConfig } from './vendorConfig.js';
import type { VendorCodeWriteUpOutcome } from './vendorCodeWriteUp.js';
import { createLogger } from '../../logging/logger.js';

const log = createLogger('writeup');

/**
 * Shared outcome -> console output + write_up_actions row logic, extracted
 * from vendorCodeWriteUpCli.ts so vendorCodeBatchExecuteCli.ts can drive
 * the exact same real logging (not a duplicate that could drift), same
 * reuse reason as Aero Repair's own processLine.ts/logProcessLineResult.
 * Returns whether the outcome was a genuine success — the single-line CLI
 * uses this to set process.exitCode; batch-execute uses it to count
 * successes/exceptions without letting one line's exception affect the
 * whole batch's own exit code.
 */
export function logVendorCodeOutcome(
  db: ReturnType<typeof openDb>,
  config: VendorConfig,
  env: string,
  outcome: VendorCodeWriteUpOutcome,
): { success: boolean } {
  let dbOutcome: WriteUpActionInsert['outcome'];
  let filledFieldsJson: string | null = null;
  let errorMessage: string | null = null;
  let orderNumber: string | null = null;
  let success = true;
  let partNumberForLog = '(unknown)';
  if (
    outcome.status === 'authorized_only' ||
    outcome.status === 'issued_and_docked' ||
    outcome.status === 'issued_not_docked' ||
    outcome.status === 'order_created_do_not_ship' ||
    outcome.status === 'order_created_awaiting_rma'
  ) {
    partNumberForLog = outcome.fields.partNumber;
  } else if ('partNumber' in outcome && outcome.partNumber) {
    partNumberForLog = outcome.partNumber;
  }

  switch (outcome.status) {
    case 'authorized_only': {
      dbOutcome = 'authorized_only';
      filledFieldsJson = JSON.stringify(outcome.fields, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      log.info({ fields: outcome.fields }, 'AUTHORIZATION_ONLY — real order authorized, Issue Order never called');
      break;
    }
    case 'issued_and_docked': {
      dbOutcome = 'issued_and_docked';
      filledFieldsJson = JSON.stringify(outcome.fields, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      log.info(
        { fields: outcome.fields, shipmentId: outcome.shipmentId ?? null },
        'ISSUE_AND_DOCK — real order issued and docked',
      );
      break;
    }
    case 'issued_not_docked': {
      dbOutcome = 'issued_not_docked';
      filledFieldsJson = JSON.stringify(outcome.fields, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      log.info(
        { fields: outcome.fields },
        'ISSUED, NOT DOCKED — real order issued; Move to Dock intentionally skipped this run (shipset Delta 5)',
      );
      break;
    }
    case 'order_created_do_not_ship': {
      dbOutcome = 'order_created_do_not_ship';
      filledFieldsJson = JSON.stringify({ ...outcome.fields, reason: outcome.reason, externalReferenceNote: outcome.externalReferenceNote }, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      log.info(
        { fields: outcome.fields, reason: outcome.reason },
        'CREATE ORDER ONLY — real order created, DO NOT SHIP recorded. No authorization, issue, or dock',
      );
      break;
    }
    case 'order_created_awaiting_rma': {
      dbOutcome = 'order_created_awaiting_rma';
      filledFieldsJson = JSON.stringify({ ...outcome.fields, externalReferenceNote: outcome.externalReferenceNote }, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      log.info(
        { fields: outcome.fields, externalReferenceNote: outcome.externalReferenceNote },
        'RMA — real order created, externalReferenceNote recorded. No authorization, issue, or dock',
      );
      break;
    }
    case 'no_candidate_lines': {
      dbOutcome = 'no_candidate_lines';
      log.info({ vendorCode: outcome.vendorCode }, 'No candidate lines found for vendor code');
      break;
    }
    case 'unassigned_task_present': {
      dbOutcome = 'unassigned_task_present';
      filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, taskDetail: outcome.taskDetail }, null, 2);
      log.error(
        { partNumber: outcome.partNumber, serialNumber: outcome.serialNumber, taskDetail: outcome.taskDetail },
        'a real unassigned task is present. Nothing filled.',
      );
      success = false;
      break;
    }
    case 'no_removal_task_info_found': {
      dbOutcome = 'no_removal_task_info_found';
      log.error(
        { partNumber: outcome.partNumber, serialNumber: outcome.serialNumber },
        "no task assigned, and this line's own Removal Information has no Task Name/ID either. That data is the actual removal reason and can't be guessed — flagging for manual review rather than fabricating an Ad-Hoc task.",
      );
      success = false;
      break;
    }
    case 'zero_usage': {
      dbOutcome = 'zero_usage';
      filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, usageRows: outcome.usageRows }, null, 2);
      log.error(
        { partNumber: outcome.partNumber, serialNumber: outcome.serialNumber, usageRows: outcome.usageRows },
        'Current Usage shows all-zero — records-error exception, unchanged from Aero Repair\'s.',
      );
      success = false;
      break;
    }
    case 'usage_table_absent_unexpected': {
      dbOutcome = 'usage_table_absent_unexpected';
      log.error(
        { partNumber: outcome.partNumber, serialNumber: outcome.serialNumber },
        'Usage Table Absent (Unexpected) — no usage table found and this line did not match the BN override. Nothing filled.',
      );
      success = false;
      break;
    }
    case 'receiving_notes_flagged_account': {
      dbOutcome = 'receiving_notes_flagged_account';
      filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, receivingNotes: outcome.receivingNotes }, null, 2);
      log.error(
        { partNumber: outcome.partNumber, serialNumber: outcome.serialNumber, receivingNotes: outcome.receivingNotes },
        'receiving notes mention "account" — flagged for manual review per explicit instruction. Nothing filled.',
      );
      success = false;
      break;
    }
    case 'authorization_not_confirmed': {
      dbOutcome = 'authorization_not_confirmed';
      orderNumber = outcome.orderNumber;
      filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, realAuthorizationStatus: outcome.realAuthorizationStatus }, null, 2);
      log.error(
        { orderNumber: outcome.orderNumber, realAuthorizationStatus: outcome.realAuthorizationStatus ?? null },
        'Authorization Not Confirmed. Review manually in MXI before retrying.',
      );
      success = false;
      break;
    }
    case 'error': {
      dbOutcome = 'error';
      errorMessage = outcome.errorMessage;
      filledFieldsJson = outcome.serialNumber ? JSON.stringify({ serialNumber: outcome.serialNumber }, null, 2) : null;
      log.error({ vendorConfigId: config.id, errorMessage: outcome.errorMessage }, 'Vendor write-up failed');
      success = false;
      break;
    }
  }

  insertWriteUpAction(db, {
    vendor: config.id,
    partNumber: partNumberForLog,
    targetEnv: env,
    outcome: dbOutcome,
    stationCode: null,
    routedLocation: null,
    filledFieldsJson,
    errorMessage,
    orderNumber,
  });

  return { success };
}
