import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { findFirstRepairLineForPart } from '../writeUps/aeroRepair/partDetails.js';
import { readAssignedTasksAreaText } from '../writeUps/aeroRepair/selectors.js';
import { isNoTasksAssignedException } from '../writeUps/aeroRepair/noTaskException.js';
import { markAdHocContinuationProven } from '../writeUps/aeroRepair/adHocContinuationProof.js';
import { logProcessLineResult, processLine } from '../writeUps/aeroRepair/processLine.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * The ONE-TIME manual confirmation command for the single-candidate
 * Ad-Hoc recovery path's previously-unproven continuation. Explicitly
 * naming one real order and running this command IS the manual
 * confirmation — no separate interactive prompt, matching this project's
 * existing pattern (aeroRepairWriteUpCli.ts's own "STOPPED BEFORE ISSUE"
 * gate, approve-and-write's --confirm flag).
 *
 * Reuses processLine (writeUps/aeroRepair/processLine.ts) — the exact
 * same write-up -> Issue Order -> Move to Dock flow the normal batch path
 * runs, with the exact same independent-verification discipline. Since
 * the target line now genuinely has a real task (created by the earlier
 * paused run), runAeroRepairWriteUp's no-task check simply won't fire
 * this time — no special-cased continuation logic needed, this line now
 * looks like any other "has a task" line to the rest of the flow.
 *
 * Only sets the persistent proof flag (adHocContinuationProof.ts) when
 * processLine itself reports `status: 'completed'` — the same genuinely-
 * independently-verified signal (order confirmed ISSUED via
 * readOrderRealState, shipment confirmed docked) used everywhere else in
 * this module. Any other outcome leaves the gate in place for next time —
 * a failed proof attempt must never be mistaken for a successful one.
 *
 * Usage: npm run aero-repair:continue-ad-hoc -- <partNumber> <serialNumber> [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const partNumber = rest[0];
  const serialNumber = rest[1];

  if (!partNumber || !serialNumber) {
    log.error('Usage: npm run aero-repair:continue-ad-hoc -- <partNumber> <serialNumber> [--env production]');
    process.exitCode = 1;
    return;
  }

  log.info({ env: env.toUpperCase() }, 'Target MXI environment');
  log.info({ partNumber, serialNumber }, 'Continuing');

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    client = await createReadyMxiClient(env);
    const page = await client.getAuthenticatedPage();

    // Confirm live, don't just assume: the line should now genuinely show
    // a real task (created by the earlier paused run) — not still
    // "no tasks assigned". If it somehow still is, something has changed
    // since the pause and this needs a human to look, not a blind retry.
    const { linkText } = await findFirstRepairLineForPart(page, partNumber, client.todoListUrl, serialNumber);
    const assignedTasksText = await readAssignedTasksAreaText(page);
    if (isNoTasksAssignedException(assignedTasksText)) {
      log.error(
        { linkText },
        'Refusing to proceed: line still shows "no tasks assigned" — expected a real task to already exist from the earlier paused run. State may have changed since then; check manually before retrying.',
      );
      process.exitCode = 1;
      return;
    }
    log.info({ linkText }, 'Confirmed: line has a real task assigned. Proceeding through the rest of the flow for real.');

    const result = await processLine(db, client, env, partNumber, serialNumber, 'second');
    await logProcessLineResult({ partNumber, serialNumber }, result, env);

    if (result.status === 'completed') {
      await markAdHocContinuationProven(env, result.orderNumber, partNumber, serialNumber);
      log.info('');
      log.info('=== PROVEN: the Ad-Hoc recovery path now runs fully automatically for future single-candidate cases. ===');
      log.info(
        { orderNumber: result.orderNumber, routingLocation: result.routingLocation, shipmentId: result.shipmentId ?? null },
        'Order routed and docked',
      );
    } else {
      log.info('');
      log.info('=== NOT PROVEN — the pause remains in place for the next single-candidate case. ===');
      log.info({ outcome: result }, 'Outcome');
      process.exitCode = 1;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ errorMessage }, 'Continuation attempt failed');
    log.info('The pause remains in place — this was not counted as a successful proof.');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
