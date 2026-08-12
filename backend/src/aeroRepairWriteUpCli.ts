import 'dotenv/config';
import path from 'node:path';
import { insertWriteUpAction, openDb } from './db/db.js';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { AERO_REPAIR_PART_NUMBERS } from './writeUps/aeroRepair/constants.js';
import { runAeroRepairWriteUp } from './writeUps/aeroRepair/writeUp.js';

/**
 * CLI smoke test for the Aero Repair write-up flow, ONE part number (and
 * optionally one specific serial number) at a time. It walks the full flow
 * through filling the Schedule Work Package form, requesting authorization,
 * and confirming the Auth Flow selection — then STOPS. Nothing is
 * submitted past that point (Issue Order is never clicked), regardless of
 * outcome; everything filled is printed for manual review.
 *
 * This is the FIRST of a two-phase review gate, required for every
 * production run until each routing destination has an established
 * production track record (stage-only proof isn't enough — NH and Georgia
 * included, despite being proven in stage). When a real order was
 * generated and authorization was requested, the outcome logged is
 * 'pending_issue', not a terminal 'filled' — it sits there until a
 * separate, explicit `npm run aero-repair:approve-issue` or
 * `aero-repair:reject-issue` decision is made (see
 * `npm run aero-repair:review-pending` to list what's waiting).
 *
 * Every attempt (pending_issue, filled, no-tasks exception, unrecognized
 * station, or error) is logged to the append-only write_up_actions table,
 * same pattern as mxi_writes.
 *
 * Usage: npm run aero-repair:write-up -- <partNumber> [serialNumber] [--env production]
 *   serialNumber is optional — omit to use whichever open repair line for
 *   this part number is matched first (a part number can have several open
 *   lines at once; pass this to target a specific one instead).
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const partNumber = rest[0];
  const preferredSerialNumber = rest[1];

  if (!partNumber) {
    console.error('Usage: npm run aero-repair:write-up -- <partNumber> [serialNumber] [--env production]');
    console.error(`Known Aero Repair part numbers: ${AERO_REPAIR_PART_NUMBERS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Target MXI environment: ${env.toUpperCase()}`);
  if (!AERO_REPAIR_PART_NUMBERS.includes(partNumber)) {
    console.warn(
      `Warning: "${partNumber}" is not one of the 6 known Aero Repair part numbers (${AERO_REPAIR_PART_NUMBERS.join(', ')}). Proceeding anyway — this is a smoke test, not a hard gate.`,
    );
  }

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    client = await createReadyMxiClient(env);
    const outcome = await runAeroRepairWriteUp(client, partNumber, preferredSerialNumber);

    let dbOutcome:
      | 'pending_issue'
      | 'filled'
      | 'no_tasks_assigned'
      | 'multiple_candidate_tasks'
      | 'ad_hoc_pending_manual_continuation'
      | 'unrecognized_station'
      | 'zero_usage'
      | 'unassigned_task_multiple_present'
      | 'unassigned_task_detection_suspect'
      | 'no_removal_task_info_found'
      | 'order_created_do_not_ship'
      | 'error';
    let stationCode: string | null = null;
    let routedLocation: string | null = null;
    let filledFieldsJson: string | null = null;
    let errorMessage: string | null = null;
    let orderNumber: string | null = null;

    if (outcome.unassignedTaskWasAssigned) {
      insertWriteUpAction(db, {
        vendor: 'aeroRepair',
        partNumber,
        targetEnv: env,
        outcome: 'unassigned_task_assigned',
        stationCode: null,
        routedLocation: null,
        filledFieldsJson: JSON.stringify({ serialNumber: preferredSerialNumber ?? null }, null, 2),
        errorMessage: null,
        orderNumber: null,
      });
    }

    switch (outcome.status) {
      case 'filled': {
        stationCode = outcome.fields.routing.status === 'routed' ? outcome.fields.routing.stationCode : null;
        routedLocation = outcome.fields.routing.status === 'routed' ? outcome.fields.routing.location : null;
        filledFieldsJson = JSON.stringify(outcome.fields, null, 2);
        orderNumber = outcome.fields.generatedOrderNumber;

        // A real order + authorization request is a review-gated pending
        // state, not terminal — only log plain 'filled' for the (unlikely)
        // case where no order number was ever found to authorize.
        dbOutcome = outcome.fields.generatedOrderNumber && outcome.fields.authorizationRequested
          ? 'pending_issue'
          : 'filled';

        console.log('');
        console.log('=== STOPPED BEFORE ISSUE — nothing was submitted past Auth Flow confirmation. ===');
        console.log('The following was filled and is ready for manual review:');
        console.log(filledFieldsJson);
        console.log('=== END OF FIELDS FOR MANUAL REVIEW ===');
        if (dbOutcome === 'pending_issue') {
          console.log('');
          console.log(`Order ${orderNumber} is now PENDING ISSUE REVIEW.`);
          console.log('Run `npm run aero-repair:review-pending` to see it listed, then either:');
          const envFlag = env === 'production' ? ' --env production' : '';
          console.log(`  npm run aero-repair:approve-issue -- ${orderNumber}${envFlag}`);
          console.log(`  npm run aero-repair:reject-issue -- ${orderNumber} "<reason>"${envFlag}`);
        }
        break;
      }
      case 'no_tasks_assigned': {
        dbOutcome = 'no_tasks_assigned';
        console.log(`Part ${partNumber}: no-tasks-assigned exception detected (0 real candidate tasks found). Nothing was filled.`);
        break;
      }
      case 'multiple_candidate_tasks': {
        dbOutcome = 'multiple_candidate_tasks';
        console.log(
          `Part ${partNumber}: ${outcome.candidateNames.length} real candidate tasks found — flagging for human review, not guessing among them:`,
        );
        outcome.candidateNames.forEach((name) => console.log(`  - ${name}`));
        break;
      }
      case 'ad_hoc_pending_manual_continuation': {
        dbOutcome = 'ad_hoc_pending_manual_continuation';
        console.log('');
        console.log('=== AD-HOC TASK CREATED — PAUSED, pending one-time manual proof. ===');
        console.log(`Part: ${partNumber}  Serial: ${outcome.serialNumber}`);
        console.log(`Ad-Hoc task created: "${outcome.taskName}"`);
        console.log('The rest of the flow (Auth Flow, Issue Order, Move to Dock) has not been');
        console.log('exercised end-to-end yet starting from a freshly-created Ad-Hoc task.');
        console.log('Run this to manually continue and prove it for real:');
        const envFlag = env === 'production' ? ' --env production' : '';
        console.log(`  npm run aero-repair:continue-ad-hoc -- ${partNumber} ${outcome.serialNumber}${envFlag}`);
        break;
      }
      case 'unrecognized_station': {
        dbOutcome = 'unrecognized_station';
        stationCode = outcome.stationCode;
        console.error(
          `Part ${partNumber}: station "${outcome.stationCode}" is not one of the 12 known Aero Repair stations. Flagging, not guessing a routing.`,
        );
        process.exitCode = 1;
        break;
      }
      case 'zero_usage': {
        dbOutcome = 'zero_usage';
        console.error(
          `Part ${partNumber} / SN ${outcome.serialNumber}: Current Usage shows CYCLES and HOURS both at exactly 0 (TSN/TSO/TSI) — a maintenance-records data problem, not a real repair-eligible line. Nothing was filled.`,
        );
        process.exitCode = 1;
        break;
      }
      case 'unassigned_task_multiple_present': {
        dbOutcome = 'unassigned_task_multiple_present';
        filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, candidateCount: outcome.candidateCount }, null, 2);
        console.error(
          `Part ${partNumber} / SN ${outcome.serialNumber}: ${outcome.candidateCount} genuinely-assignable unassigned tasks found — flagging for human review, not guessing among them. Nothing was filled.`,
        );
        process.exitCode = 1;
        break;
      }
      case 'unassigned_task_detection_suspect': {
        dbOutcome = 'unassigned_task_detection_suspect';
        filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber }, null, 2);
        console.error(
          `Part ${partNumber} / SN ${outcome.serialNumber}: a task checkbox was detected on the Unassigned Tasks sub-tab, but it filtered out as PC (administrative) — detection is suspect. Nothing was filled or assigned.`,
        );
        process.exitCode = 1;
        break;
      }
      case 'no_removal_task_info_found': {
        dbOutcome = 'no_removal_task_info_found';
        console.error(
          `Part ${partNumber} / SN ${outcome.serialNumber}: no task assigned, and this line's own Removal ` +
            `Information has no Task Name/ID either — the real removal reason can't be determined. Nothing was filled.`,
        );
        process.exitCode = 1;
        break;
      }
      case 'order_created_do_not_ship': {
        dbOutcome = 'order_created_do_not_ship';
        orderNumber = outcome.generatedOrderNumber;
        filledFieldsJson = JSON.stringify(
          { serialNumber: outcome.serialNumber, reason: outcome.reason, externalReferenceNote: outcome.externalReferenceNote },
          null,
          2,
        );
        console.log('');
        console.log(`=== CREATE ORDER ONLY — order ${outcome.generatedOrderNumber} created, marked DO NOT SHIP (${outcome.reason}). ===`);
        console.log('No authorization, issue, or dock was performed for this line.');
        break;
      }
      case 'error': {
        dbOutcome = 'error';
        errorMessage = outcome.errorMessage;
        filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber }, null, 2);
        console.error(`Part ${partNumber}: write-up attempt failed: ${outcome.errorMessage}`);
        process.exitCode = 1;
        break;
      }
    }

    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: dbOutcome,
      stationCode,
      routedLocation,
      filledFieldsJson,
      errorMessage,
      orderNumber,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Aero Repair write-up smoke test failed:', errorMessage);
    insertWriteUpAction(db, {
      vendor: 'aeroRepair',
      partNumber,
      targetEnv: env,
      outcome: 'error',
      stationCode: null,
      routedLocation: null,
      filledFieldsJson: null,
      errorMessage,
      orderNumber: null,
    });
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
