import 'dotenv/config';
import path from 'node:path';
import { openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { findFirstRepairLineForPart } from '../writeUps/aeroRepair/partDetails.js';
import { markWorkPackageCreationProven } from '../writeUps/aeroRepair/workPackageCreationProof.js';
import { logProcessLineResult, processLine } from '../writeUps/aeroRepair/processLine.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * The ONE-TIME manual confirmation command for Addition 1's (Create Work
 * Package) previously-unproven continuation — mirrors
 * aeroRepairContinueAdHocCli.ts exactly, same reasoning
 * (workPackageCreationProof.ts's docstring has the full account of why this
 * gate exists: standing discipline #8 requires proving any genuinely new
 * write path against one real, closely-watched line before it runs
 * unattended — independent of selector confidence).
 *
 * Explicitly naming one real order and running this command IS the manual
 * confirmation — no separate interactive prompt, matching this project's
 * existing pattern.
 *
 * Reuses processLine (writeUps/aeroRepair/processLine.ts) — the exact same
 * write-up -> Issue Order -> Move to Dock flow the normal batch path runs,
 * with the exact same independent-verification discipline. Since the
 * target line now genuinely has a real work package (created by the
 * earlier paused run), runAeroRepairWriteUp's no-work-package recovery
 * simply won't fire this time — no special-cased continuation logic
 * needed, this line now looks like any other "has a work package" line to
 * the rest of the flow.
 *
 * Only sets the persistent proof flag (workPackageCreationProof.ts) when
 * processLine itself reports a genuinely-verified terminal outcome that
 * isn't itself another pause or a failure — the same discipline used
 * everywhere else in this module (never mistake a failed proof attempt for
 * a successful one).
 *
 * Usage: npm run aero-repair:continue-work-package -- <partNumber> <serialNumber> [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const partNumber = rest[0];
  const serialNumber = rest[1];

  if (!partNumber || !serialNumber) {
    log.error('Usage: npm run aero-repair:continue-work-package -- <partNumber> <serialNumber> [--env production]');
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

    // Confirm live, don't just assume: the line should now genuinely have
    // a real work package (created by the earlier paused run) — not still
    // absent. findFirstRepairLineForPart's own recovery would otherwise
    // try to create a SECOND one, which must never happen silently.
    const { linkText, workPackageCreated } = await findFirstRepairLineForPart(
      page,
      partNumber,
      client.todoListUrl,
      serialNumber,
    );
    if (workPackageCreated) {
      log.error(
        { linkText },
        'Refusing to proceed: this call itself just created ANOTHER work package for this line — expected one to already exist from the earlier paused run. State may have changed since then; check manually before retrying.',
      );
      process.exitCode = 1;
      return;
    }
    log.info({ linkText }, 'Confirmed: line already has a real work package. Proceeding through the rest of the flow for real.');

    const result = await processLine(db, client, env, partNumber, serialNumber, 'second');
    await logProcessLineResult({ partNumber, serialNumber }, result, env);

    if (
      result.status === 'completed' ||
      result.status === 'order_created_do_not_ship' ||
      result.status === 'no_tasks_assigned' ||
      result.status === 'multiple_candidate_tasks' ||
      result.status === 'zero_usage' ||
      result.status === 'unassigned_task_multiple_present' ||
      result.status === 'unassigned_task_detection_suspect' ||
      result.status === 'no_removal_task_info_found' ||
      result.status === 'unrecognized_station'
    ) {
      // Any of these means the flow ran genuinely past the freshly-created
      // work package to a real, independently-verified terminal outcome —
      // proof that the Create Work Package -> continue sequence works, even
      // if THIS particular line then hit an unrelated, pre-existing
      // exception (e.g. unrecognized_station). ad_hoc_pending_manual_continuation
      // and work_package_created_pending_manual_continuation are
      // deliberately excluded — those are themselves still-unproven pauses,
      // not proof.
      await markWorkPackageCreationProven(env, partNumber, serialNumber, linkText);
      log.info('');
      log.info('=== PROVEN: the Create Work Package path now runs fully automatically for future no-work-package cases. ===');
      log.info({ outcome: result }, 'Outcome');
    } else {
      log.info('');
      log.info('=== NOT PROVEN — the pause remains in place for the next Create Work Package case. ===');
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
