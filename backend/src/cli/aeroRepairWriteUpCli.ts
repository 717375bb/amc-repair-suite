import 'dotenv/config';
import path from 'node:path';
import { insertWriteUpAction, openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { AERO_REPAIR_PART_NUMBERS } from '../writeUps/aeroRepair/constants.js';
import { runAeroRepairWriteUp } from '../writeUps/aeroRepair/writeUp.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

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
    log.error('Usage: npm run aero-repair:write-up -- <partNumber> [serialNumber] [--env production]');
    log.error({ knownPartNumbers: AERO_REPAIR_PART_NUMBERS }, 'Known Aero Repair part numbers');
    process.exitCode = 1;
    return;
  }

  log.info({ env: env.toUpperCase() }, 'Target MXI environment');
  if (!AERO_REPAIR_PART_NUMBERS.includes(partNumber)) {
    log.warn(
      { partNumber, knownPartNumbers: AERO_REPAIR_PART_NUMBERS },
      'Part number is not one of the 6 known Aero Repair part numbers. Proceeding anyway — this is a smoke test, not a hard gate.',
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
      | 'work_package_created_pending_manual_continuation'
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

    if (outcome.workPackageWasCreated) {
      insertWriteUpAction(db, {
        vendor: 'aeroRepair',
        partNumber,
        targetEnv: env,
        outcome: 'work_package_created',
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

        log.info('');
        log.info('=== STOPPED BEFORE ISSUE — nothing was submitted past Auth Flow confirmation. ===');
        log.info('The following was filled and is ready for manual review:');
        log.info({ filledFieldsJson }, 'Filled fields for manual review');
        log.info('=== END OF FIELDS FOR MANUAL REVIEW ===');
        if (dbOutcome === 'pending_issue') {
          log.info('');
          log.info({ orderNumber }, 'Order is now PENDING ISSUE REVIEW');
          log.info('Run `npm run aero-repair:review-pending` to see it listed, then either:');
          const envFlag = env === 'production' ? ' --env production' : '';
          log.info(
            { command: `npm run aero-repair:approve-issue -- ${orderNumber}${envFlag}` },
            'Approve-issue command',
          );
          log.info(
            { command: `npm run aero-repair:reject-issue -- ${orderNumber} "<reason>"${envFlag}` },
            'Reject-issue command',
          );
        }
        break;
      }
      case 'no_tasks_assigned': {
        dbOutcome = 'no_tasks_assigned';
        log.info(
          { partNumber },
          'No-tasks-assigned exception detected (0 real candidate tasks found). Nothing was filled.',
        );
        break;
      }
      case 'multiple_candidate_tasks': {
        dbOutcome = 'multiple_candidate_tasks';
        log.info(
          { partNumber, candidateCount: outcome.candidateNames.length },
          'Real candidate tasks found — flagging for human review, not guessing among them',
        );
        outcome.candidateNames.forEach((name) => log.info({ candidateName: name }, 'Candidate task'));
        break;
      }
      case 'ad_hoc_pending_manual_continuation': {
        dbOutcome = 'ad_hoc_pending_manual_continuation';
        log.info('');
        log.info('=== AD-HOC TASK CREATED — PAUSED, pending one-time manual proof. ===');
        log.info({ partNumber, serialNumber: outcome.serialNumber }, 'Part / Serial');
        log.info({ taskName: outcome.taskName }, 'Ad-Hoc task created');
        log.info('The rest of the flow (Auth Flow, Issue Order, Move to Dock) has not been');
        log.info('exercised end-to-end yet starting from a freshly-created Ad-Hoc task.');
        log.info('Run this to manually continue and prove it for real:');
        const envFlag = env === 'production' ? ' --env production' : '';
        log.info(
          { command: `npm run aero-repair:continue-ad-hoc -- ${partNumber} ${outcome.serialNumber}${envFlag}` },
          'Continue-ad-hoc command',
        );
        break;
      }
      case 'work_package_created_pending_manual_continuation': {
        dbOutcome = 'work_package_created_pending_manual_continuation';
        log.info('');
        log.info('=== WORK PACKAGE CREATED — PAUSED, pending one-time manual proof. ===');
        log.info({ partNumber, serialNumber: outcome.serialNumber }, 'Part / Serial');
        log.info({ workPackageName: outcome.workPackageName }, 'Work package created');
        log.info('The rest of the flow (task-paste, Schedule Work Package, Authorization,');
        log.info('Issue Order, Move to Dock) has not been exercised end-to-end yet starting');
        log.info('from a freshly-created work package.');
        log.info('Run this to manually continue and prove it for real:');
        const envFlag = env === 'production' ? ' --env production' : '';
        log.info(
          { command: `npm run aero-repair:continue-work-package -- ${partNumber} ${outcome.serialNumber}${envFlag}` },
          'Continue-work-package command',
        );
        break;
      }
      case 'unrecognized_station': {
        dbOutcome = 'unrecognized_station';
        stationCode = outcome.stationCode;
        log.error(
          { partNumber, stationCode: outcome.stationCode },
          'Station is not one of the 12 known Aero Repair stations. Flagging, not guessing a routing.',
        );
        process.exitCode = 1;
        break;
      }
      case 'zero_usage': {
        dbOutcome = 'zero_usage';
        log.error(
          { partNumber, serialNumber: outcome.serialNumber },
          'Current Usage shows CYCLES and HOURS both at exactly 0 (TSN/TSO/TSI) — a maintenance-records data problem, not a real repair-eligible line. Nothing was filled.',
        );
        process.exitCode = 1;
        break;
      }
      case 'unassigned_task_multiple_present': {
        dbOutcome = 'unassigned_task_multiple_present';
        filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber, candidateCount: outcome.candidateCount }, null, 2);
        log.error(
          { partNumber, serialNumber: outcome.serialNumber, candidateCount: outcome.candidateCount },
          'Genuinely-assignable unassigned tasks found — flagging for human review, not guessing among them. Nothing was filled.',
        );
        process.exitCode = 1;
        break;
      }
      case 'unassigned_task_detection_suspect': {
        dbOutcome = 'unassigned_task_detection_suspect';
        filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber }, null, 2);
        log.error(
          { partNumber, serialNumber: outcome.serialNumber },
          'A task checkbox was detected on the Unassigned Tasks sub-tab, but it filtered out as PC (administrative) — detection is suspect. Nothing was filled or assigned.',
        );
        process.exitCode = 1;
        break;
      }
      case 'no_removal_task_info_found': {
        dbOutcome = 'no_removal_task_info_found';
        log.error(
          { partNumber, serialNumber: outcome.serialNumber },
          "No task assigned, and this line's own Removal Information has no Task Name/ID either — the real removal reason can't be determined. Nothing was filled.",
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
        log.info('');
        log.info(
          { orderNumber: outcome.generatedOrderNumber, reason: outcome.reason },
          '=== CREATE ORDER ONLY — order created, marked DO NOT SHIP. ===',
        );
        log.info('No authorization, issue, or dock was performed for this line.');
        break;
      }
      case 'error': {
        dbOutcome = 'error';
        errorMessage = outcome.errorMessage;
        filledFieldsJson = JSON.stringify({ serialNumber: outcome.serialNumber }, null, 2);
        log.error({ partNumber, errorMessage: outcome.errorMessage }, 'Write-up attempt failed');
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
    log.error({ errorMessage }, 'Aero Repair write-up smoke test failed');
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
