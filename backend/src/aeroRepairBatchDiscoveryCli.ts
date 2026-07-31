import 'dotenv/config';
import path from 'node:path';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { discoverEligibleLines, type DiscoveredLine } from './writeUps/aeroRepair/batchDiscovery.js';
import { appendDiscoveryLogRows, type ExceptionRow } from './writeUps/aeroRepair/discoveryLog.js';
import { saveEligibleLines, ELIGIBLE_LINES_FILE_PATH } from './writeUps/aeroRepair/eligibleLinesFile.js';
import { AERO_REPAIR_PART_NUMBERS } from './writeUps/aeroRepair/constants.js';

const NO_TASK_SUGGESTED_ACTION =
  'Manually assign a task to this work package before a write-up can be created, or confirm no repair is needed.';
const UNRECOGNIZED_STATION_SUGGESTED_ACTION =
  "This part's current station isn't in the automated routing table — manually determine the correct Aero Repair location.";
const NO_WORK_PACKAGE_SUGGESTED_ACTION =
  'A CRA must handle this line manually — do NOT attempt an automated write-up.';

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
  console.log(`Target MXI environment: ${env.toUpperCase()}`);
  console.log('Read-only batch discovery — no writes, no order creation, no edit mode.');

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    const lines = await discoverEligibleLines(client);

    const dateFound = new Date().toISOString();
    const exceptionRows: ExceptionRow[] = lines
      .filter((line) => line.classification !== 'eligible-for-write-up')
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
        if (line.classification === 'no-work-package-exception') {
          return {
            partNumber: line.partNumber,
            serialNumber: line.serialNumber,
            station: line.stationCode,
            dateFound,
            issueType: 'No Work Package (Bad From Stock)',
            details:
              `Real USSTG inventory row with a BLANK Work Package column — no "Repair ..." link exists for this ` +
              `line, so no automated write-up can be attempted. Raw row text: ${line.note ?? '(not captured)'}`,
            suggestedAction: NO_WORK_PACKAGE_SUGGESTED_ACTION,
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
    console.log(
      `\nAppended ${logResult.exceptionsAdded} exception row(s) to ${LOG_FILE_PATH} (0 completed rows — this pass is read-only).`,
    );

    // PART B FIX: no-task-exception lines used to be excluded here entirely
    // — the ad-hoc 0/1/2+ recovery logic in writeUp.ts only ever runs on
    // lines batch-execute actually processes, so excluding them made that
    // proven recovery path unreachable in the normal daily flow. Now
    // included alongside eligible-for-write-up lines: runAeroRepairWriteUp
    // re-derives the no-task state itself from a FRESH read (never trusts
    // this discovery snapshot), so passing these through is safe and lets
    // the existing recovery actually run. unrecognized-station-exception
    // and no-work-package-exception are deliberately still excluded — both
    // are genuine "a human must handle this" cases with no automated path.
    const targetsForBatchExecute = lines
      .filter((line) => line.classification === 'eligible-for-write-up' || line.classification === 'no-task-exception')
      .map((line) => ({ partNumber: line.partNumber, serialNumber: line.serialNumber }));
    await saveEligibleLines(env, targetsForBatchExecute);
    console.log(
      `Saved ${targetsForBatchExecute.length} line(s) to ${ELIGIBLE_LINES_FILE_PATH} (eligible-for-write-up + ` +
        `no-task-exception, so batch-execute's existing 0/1/2+ no-task recovery can actually run) — run ` +
        `\`npm run aero-repair:batch-execute -- --env ${env}\` next to process all of them, no manual list needed.`,
    );

    printSummary(lines);
  } catch (err) {
    console.error('Batch discovery failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

function printSummary(lines: DiscoveredLine[]): void {
  console.log('\n=== SUMMARY ===\n');

  for (const partNumber of AERO_REPAIR_PART_NUMBERS) {
    const partLines = lines.filter((l) => l.partNumber === partNumber);
    console.log(`--- ${partNumber}: ${partLines.length} eligible-candidate line(s) found ---`);
    if (partLines.length === 0) {
      console.log('  (none)');
      continue;
    }
    for (const line of partLines) {
      const detail =
        line.classification === 'eligible-for-write-up'
          ? `routes to ${line.routingLocation}`
          : line.classification === 'no-task-exception'
            ? 'NO TASK ASSIGNED'
            : line.classification === 'no-work-package-exception'
              ? 'NO WORK PACKAGE (BAD FROM STOCK)'
              : `UNRECOGNIZED STATION (${line.stationCode})`;
      console.log(`  SN ${line.serialNumber} (station ${line.stationCode}) -> ${detail}`);
    }
  }

  console.log('\n--- Totals ---');
  const eligible = lines.filter((l) => l.classification === 'eligible-for-write-up');
  const noTask = lines.filter((l) => l.classification === 'no-task-exception');
  const unrecognizedStation = lines.filter((l) => l.classification === 'unrecognized-station-exception');
  const noWorkPackage = lines.filter((l) => l.classification === 'no-work-package-exception');

  console.log(`Total lines found: ${lines.length}`);
  console.log(`  Eligible for write-up: ${eligible.length}`);
  console.log(`  No Task Assigned exception: ${noTask.length}`);
  console.log(`  Unrecognized Station exception: ${unrecognizedStation.length}`);
  console.log(`  No Work Package (Bad From Stock) exception: ${noWorkPackage.length}`);

  console.log('\nEligible lines by routing destination:');
  const byDestination = new Map<string, DiscoveredLine[]>();
  for (const line of eligible) {
    const dest = line.routingLocation ?? '(unknown)';
    if (!byDestination.has(dest)) byDestination.set(dest, []);
    byDestination.get(dest)!.push(line);
  }
  if (byDestination.size === 0) {
    console.log('  (none)');
  } else {
    for (const [dest, destLines] of byDestination) {
      console.log(`  ${dest}: ${destLines.length}`);
      for (const line of destLines) {
        console.log(`    ${line.partNumber} / SN ${line.serialNumber} (station ${line.stationCode})`);
      }
    }
  }

  console.log('\nNo Task Assigned exceptions:');
  if (noTask.length === 0) {
    console.log('  (none)');
  } else {
    for (const line of noTask) {
      console.log(`  ${line.partNumber} / SN ${line.serialNumber} (station ${line.stationCode})`);
    }
  }

  console.log('\nUnrecognized Station exceptions:');
  if (unrecognizedStation.length === 0) {
    console.log('  (none)');
  } else {
    for (const line of unrecognizedStation) {
      console.log(`  ${line.partNumber} / SN ${line.serialNumber} (station ${line.stationCode})`);
    }
  }

  console.log('\nNo Work Package (Bad From Stock) exceptions:');
  if (noWorkPackage.length === 0) {
    console.log('  (none)');
  } else {
    for (const line of noWorkPackage) {
      console.log(`  ${line.partNumber} / SN ${line.serialNumber} (station ${line.stationCode})`);
    }
  }
}

main();
