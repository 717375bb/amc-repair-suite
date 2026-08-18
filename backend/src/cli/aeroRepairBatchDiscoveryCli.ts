import 'dotenv/config';
import path from 'node:path';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { discoverEligibleLines, type DiscoveredLine } from '../writeUps/aeroRepair/batchDiscovery.js';
import { appendDiscoveryLogRows, type ExceptionRow } from '../writeUps/aeroRepair/discoveryLog.js';
import { saveEligibleLines, ELIGIBLE_LINES_FILE_PATH } from '../writeUps/aeroRepair/eligibleLinesFile.js';
import { AERO_REPAIR_PART_NUMBERS } from '../writeUps/aeroRepair/constants.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

const NO_TASK_SUGGESTED_ACTION =
  'Manually assign a task to this work package before a write-up can be created, or confirm no repair is needed.';
const UNRECOGNIZED_STATION_SUGGESTED_ACTION =
  "This part's current station isn't in the automated routing table — manually determine the correct Aero Repair location.";

const LOG_FILE_PATH = path.join('data', 'aero-repair-writeup-log.xlsx');

/**
 * Read-only batch discovery across all 6 known Aero Repair part numbers:
 * finds every currently-open line with no existing order yet, classifies
 * each into eligible-for-write-up / no-task-exception /
 * unrecognized-station-exception, and appends exception rows to the
 * append-only tracking file (backend/data/aero-repair-writeup-log.xlsx).
 *
 * This pass is deliberately read-only — no write-up execution, no order
 * creation, no MXI writes of any kind. Nothing beyond the tracking file
 * itself is written to. "Completed" sheet rows are only ever added by a
 * FUTURE write-up-execution pass, not this one.
 *
 * Also saves every eligible-for-write-up line to
 * data/aero-repair-eligible-lines.json — the handoff file
 * batch-execute reads by default so a second command
 * (`npm run aero-repair:batch-execute -- --env production`, no
 * partNumber:serialNumber args typed by hand) can act on exactly what this
 * scan found.
 *
 * Usage: npm run aero-repair:batch-discovery -- [--env production]
 */
async function main(): Promise<void> {
  const { env } = parseEnvFlag(process.argv.slice(2));
  log.info({ env: env.toUpperCase() }, 'Target MXI environment');
  log.info('Read-only batch discovery — no writes, no order creation, no edit mode.');

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    const lines = await discoverEligibleLines(client);

    const dateFound = new Date().toISOString();
    // Addition 1 (Create Work Package) — 'no-work-package' RETIRED as a
    // terminal exception: no longer mapped to an ExceptionRow here at all,
    // same treatment as 'no-task-exception' below (both are now real,
    // automated recovery paths, not "a human must handle this" cases).
    // Only 'unrecognized-station-exception' remains a genuine exception row.
    const exceptionRows: ExceptionRow[] = lines
      .filter((line) => line.classification !== 'eligible-for-write-up' && line.classification !== 'no-work-package')
      .map((line) => {
        if (line.classification === 'no-task-exception') {
          return {
            partNumber: line.partNumber,
            serialNumber: line.serialNumber,
            station: line.stationCode,
            dateFound,
            issueType: 'No Task Assigned',
            details: `Line "${line.linkText}" has no assigned tasks on the default Assigned Tasks tab. Included in ` +
              `the eligible-lines file so batch-execute's existing 0/1/2+ candidate recovery can run on it.`,
            suggestedAction: NO_TASK_SUGGESTED_ACTION,
          };
        }
        return {
          partNumber: line.partNumber,
          serialNumber: line.serialNumber,
          station: line.stationCode,
          dateFound,
          issueType: 'Unrecognized Station',
          details: `Line "${line.linkText}" is at station "${line.stationCode}", which has no entry in the 12-station Aero Repair routing table.`,
          suggestedAction: UNRECOGNIZED_STATION_SUGGESTED_ACTION,
        };
      });

    const logResult = await appendDiscoveryLogRows(LOG_FILE_PATH, { exceptions: exceptionRows, completed: [] });
    log.info(
      { exceptionsAdded: logResult.exceptionsAdded, logFilePath: LOG_FILE_PATH },
      'Appended exception row(s) to discovery log (0 completed rows — this pass is read-only)',
    );

    // PART B FIX: no-task-exception lines used to be excluded here entirely
    // — the ad-hoc 0/1/2+ recovery logic in writeUp.ts only ever runs on
    // lines batch-execute actually processes, so excluding them made that
    // proven recovery path unreachable in the normal daily flow. Now
    // included alongside eligible-for-write-up lines: runAeroRepairWriteUp
    // re-derives the no-task state itself from a FRESH read (never trusts
    // this discovery snapshot), so passing these through is safe and lets
    // the existing recovery actually run. unrecognized-station-exception is
    // deliberately still excluded — genuinely "a human must handle this,"
    // no automated path.
    //
    // Addition 1 (Create Work Package) — 'no-work-package' lines are now
    // ALSO included here (previously deliberately excluded, back when
    // that classification was still a terminal exception). runAeroRepairWriteUp
    // re-derives the no-work-package state itself from a fresh read (via
    // findFirstRepairLineForPart's own recovery, never trusting this
    // discovery snapshot) and creates the work package for real, gated by
    // workPackageCreationProof.ts's one-time per-env proof requirement.
    const targetsForBatchExecute = lines
      .filter(
        (line) =>
          line.classification === 'eligible-for-write-up' ||
          line.classification === 'no-task-exception' ||
          line.classification === 'no-work-package',
      )
      .map((line) => ({ partNumber: line.partNumber, serialNumber: line.serialNumber }));
    await saveEligibleLines(env, targetsForBatchExecute);
    log.info(
      { lineCount: targetsForBatchExecute.length, eligibleLinesFilePath: ELIGIBLE_LINES_FILE_PATH, env },
      "Saved line(s) to eligible-lines file (eligible-for-write-up + no-task-exception + no-work-package, so batch-execute's existing 0/1/2+ no-task recovery and the new Create Work Package recovery can both actually run) — run `npm run aero-repair:batch-execute -- --env <env>` next to process all of them, no manual list needed.",
    );

    printSummary(lines);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ errorMessage }, 'Batch discovery failed');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

function printSummary(lines: DiscoveredLine[]): void {
  log.info('\n=== SUMMARY ===\n');

  for (const partNumber of AERO_REPAIR_PART_NUMBERS) {
    const partLines = lines.filter((l) => l.partNumber === partNumber);
    log.info({ partNumber, lineCount: partLines.length }, 'Eligible-candidate line(s) found for part');
    if (partLines.length === 0) {
      log.info('  (none)');
      continue;
    }
    for (const line of partLines) {
      const detail =
        line.classification === 'eligible-for-write-up'
          ? `routes to ${line.routingLocation}`
          : line.classification === 'no-task-exception'
            ? 'NO TASK ASSIGNED'
            : line.classification === 'no-work-package'
              ? 'NO WORK PACKAGE (will be created automatically)'
              : `UNRECOGNIZED STATION (${line.stationCode})`;
      log.info({ serialNumber: line.serialNumber, stationCode: line.stationCode, detail }, 'Eligible-candidate line');
    }
  }

  log.info('\n--- Totals ---');
  const eligible = lines.filter((l) => l.classification === 'eligible-for-write-up');
  const noTask = lines.filter((l) => l.classification === 'no-task-exception');
  const unrecognizedStation = lines.filter((l) => l.classification === 'unrecognized-station-exception');
  const noWorkPackage = lines.filter((l) => l.classification === 'no-work-package');

  log.info({ totalLines: lines.length }, 'Total lines found');
  log.info({ eligibleCount: eligible.length }, 'Eligible for write-up');
  log.info({ noTaskCount: noTask.length }, 'No Task Assigned exception');
  log.info({ unrecognizedStationCount: unrecognizedStation.length }, 'Unrecognized Station exception');
  log.info({ noWorkPackageCount: noWorkPackage.length }, 'No Work Package (will be created automatically — Addition 1)');

  log.info('\nEligible lines by routing destination:');
  const byDestination = new Map<string, DiscoveredLine[]>();
  for (const line of eligible) {
    const dest = line.routingLocation ?? '(unknown)';
    if (!byDestination.has(dest)) byDestination.set(dest, []);
    byDestination.get(dest)!.push(line);
  }
  if (byDestination.size === 0) {
    log.info('  (none)');
  } else {
    for (const [dest, destLines] of byDestination) {
      log.info({ destination: dest, lineCount: destLines.length }, 'Eligible lines for destination');
      for (const line of destLines) {
        log.info(
          { partNumber: line.partNumber, serialNumber: line.serialNumber, stationCode: line.stationCode },
          'Eligible line routed to destination',
        );
      }
    }
  }

  log.info('\nNo Task Assigned exceptions:');
  if (noTask.length === 0) {
    log.info('  (none)');
  } else {
    for (const line of noTask) {
      log.info(
        { partNumber: line.partNumber, serialNumber: line.serialNumber, stationCode: line.stationCode },
        'No Task Assigned exception line',
      );
    }
  }

  log.info('\nUnrecognized Station exceptions:');
  if (unrecognizedStation.length === 0) {
    log.info('  (none)');
  } else {
    for (const line of unrecognizedStation) {
      log.info(
        { partNumber: line.partNumber, serialNumber: line.serialNumber, stationCode: line.stationCode },
        'Unrecognized Station exception line',
      );
    }
  }

  log.info('\nNo Work Package lines (will create a work package automatically, then continue the write-up):');
  if (noWorkPackage.length === 0) {
    log.info('  (none)');
  } else {
    for (const line of noWorkPackage) {
      log.info(
        { partNumber: line.partNumber, serialNumber: line.serialNumber, stationCode: line.stationCode },
        'No Work Package line',
      );
    }
  }
}

main();
