import { insertWriteUpAction, openDb, type WriteUpActionInsert } from '../../db/db.js';
import type { VendorConfig } from './vendorConfig.js';
import type { VendorCodeWriteUpOutcome } from './vendorCodeWriteUp.js';

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
  if (outcome.status === 'authorized_only' || outcome.status === 'issued_and_docked') {
    partNumberForLog = outcome.fields.partNumber;
  } else if ('partNumber' in outcome && outcome.partNumber) {
    partNumberForLog = outcome.partNumber;
  }

  switch (outcome.status) {
    case 'authorized_only': {
      dbOutcome = 'authorized_only';
      filledFieldsJson = JSON.stringify(outcome.fields, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      console.log('\n=== AUTHORIZATION_ONLY — real order authorized, Issue Order never called. ===');
      console.log(filledFieldsJson);
      break;
    }
    case 'issued_and_docked': {
      dbOutcome = 'issued_and_docked';
      filledFieldsJson = JSON.stringify(outcome.fields, null, 2);
      orderNumber = outcome.fields.generatedOrderNumber;
      console.log(`\n=== ISSUE_AND_DOCK — real order issued and docked (shipment ${outcome.shipmentId ?? '(n/a)'}). ===`);
      console.log(filledFieldsJson);
      break;
    }
    case 'no_candidate_lines': {
      dbOutcome = 'no_candidate_lines';
      console.log(`No candidate lines found for vendor code "${outcome.vendorCode}".`);
      break;
    }
    case 'unassigned_task_present': {
      dbOutcome = 'unassigned_task_present';
      filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, taskDetail: outcome.taskDetail }, null, 2);
      console.error(`Part ${outcome.partNumber} / SN ${outcome.serialNumber}: a real unassigned task is present. Nothing filled.`);
      success = false;
      break;
    }
    case 'no_task_found_for_bn_line': {
      dbOutcome = 'no_task_found_for_bn_line';
      console.error(
        `Part ${outcome.partNumber} / SN ${outcome.serialNumber}: no task found on this BN line. Its real name/description ` +
          `is the actual removal reason and can't be guessed — flagging for manual review rather than fabricating an Ad-Hoc task.`,
      );
      success = false;
      break;
    }
    case 'zero_usage': {
      dbOutcome = 'zero_usage';
      console.error(`Part ${outcome.partNumber} / SN ${outcome.serialNumber}: Current Usage shows all-zero — records-error exception, unchanged from Aero Repair's.`);
      success = false;
      break;
    }
    case 'usage_table_absent_unexpected': {
      dbOutcome = 'usage_table_absent_unexpected';
      console.error(
        `Part ${outcome.partNumber} / SN ${outcome.serialNumber}: Usage Table Absent (Unexpected) — no usage table ` +
          `found and this line did not match the BN override. Nothing filled.`,
      );
      success = false;
      break;
    }
    case 'authorization_not_confirmed': {
      dbOutcome = 'authorization_not_confirmed';
      orderNumber = outcome.orderNumber;
      filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, realAuthorizationStatus: outcome.realAuthorizationStatus }, null, 2);
      console.error(
        `Order ${outcome.orderNumber} — Authorization Not Confirmed. Real Authorization Status: ` +
          `${outcome.realAuthorizationStatus ?? '(not found)'}. Review manually in MXI before retrying.`,
      );
      success = false;
      break;
    }
    case 'error': {
      dbOutcome = 'error';
      errorMessage = outcome.errorMessage;
      filledFieldsJson = outcome.serialNumber ? JSON.stringify({ serialNumber: outcome.serialNumber }, null, 2) : null;
      console.error(`Vendor ${config.id} write-up failed: ${outcome.errorMessage}`);
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
