import 'dotenv/config';
import path from 'node:path';
import { insertWriteUpAction, openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { findCandidateLinesForVendorCode } from '../writeUps/shared/vendorCodeWriteUp.js';
import { VENDOR_REGISTRY } from '../writeUps/shared/vendorRegistry.js';
import {
  saveVendorCodeEligibleLines,
  VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH,
  type VendorCodeEligibleLineTarget,
} from '../writeUps/shared/vendorCodeEligibleLinesFile.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Read-only batch discovery across EVERY vendor registered in
 * shared/vendorRegistry.ts (0T1Y4 and onward — not Aero Repair, which has
 * its own separate two-command flow). Finds every real candidate line per
 * vendor via findCandidateLinesForVendorCode — pure grid reads, no
 * clicking into any individual line, no writes of any kind.
 *
 * REAL BUG FOUND AND FIXED, per CLAUDE_CODE_PROMPT_GRID_WAIT_FIX.md: this
 * previously had NO per-vendor failure isolation — a single vendor's grid
 * read throwing (e.g. an indeterminate grid state) propagated straight to
 * the outer catch and aborted the ENTIRE batch, silently skipping every
 * vendor after the failing one. Standing project discipline is the
 * opposite: session/login loss halts the whole run; a per-item failure
 * logs and continues (same pattern as aeroRepairBatchExecuteCli.ts's own
 * batch loop). Fixed: each vendor's discovery now runs in its own
 * try/catch, logs a 'grid_state_indeterminate' exception row (append-only,
 * distinct from a genuine 'no_candidate_lines' zero — one means "MXI
 * answered and the answer was zero," the other means "we could not
 * determine the answer," and collapsing them would recreate the exact bug
 * class the content-aware wait was built to prevent), and continues to the
 * next vendor.
 *
 * Session-loss detection: `client.getAuthenticatedPage()` is now called
 * fresh at the START of every vendor's own processing (previously fetched
 * once outside the loop) — same fix, same reasoning, as Aero Repair's own
 * discoverEligibleLines() (see batchDiscovery.ts's docstring): this gives
 * a session that went stale mid-scan a real chance to self-heal via the
 * client's own one-time re-auth, AND gives a genuinely dead session
 * (re-auth itself failing) a real, distinguishable error
 * ("MXI session not established" / "Re-authentication failed...") to
 * re-throw as a real batch-level abort, instead of guessing from a grid
 * timeout's error text.
 *
 * Saves every candidate found (across all vendors) to
 * data/vendor-code-eligible-lines.json — same two-command handoff pattern
 * as Aero Repair's own daily workflow.
 *
 * Usage: npm run vendor:batch-discovery -- [--env production]
 */
async function main(): Promise<void> {
  const { env } = parseEnvFlag(process.argv.slice(2));
  log.info({ env: env.toUpperCase() }, 'Target MXI environment');
  log.info('Read-only batch discovery across every registered vendor — no writes, no order creation.');

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    client = await createReadyMxiClient(env);

    const allLines: VendorCodeEligibleLineTarget[] = [];
    const vendorCodes = Object.keys(VENDOR_REGISTRY);
    let indeterminateCount = 0;
    let zeroCount = 0;
    let withCandidatesCount = 0;

    for (const vendorCode of vendorCodes) {
      try {
        // Fetched fresh per vendor, not cached outside the loop — see
        // docstring above for why (session-loss self-heal + detection).
        const page = await client.getAuthenticatedPage();
        const candidates = await findCandidateLinesForVendorCode(page, client.todoListUrl, vendorCode);
        log.info({ vendorCode, candidateCount: candidates.length }, 'Real candidate line(s) found');
        if (candidates.length > 0) withCandidatesCount++;
        else zeroCount++;
        for (const c of candidates) {
          allLines.push({ vendorCode, partNumber: c.partNumber, serialNumber: c.serialNumber });
        }
      } catch (err) {
        // Session/login loss is the one failure that should abort the
        // whole batch — MxiClient.getAuthenticatedPage() throws these two
        // specific, real messages when re-authentication itself fails or
        // was never established; anything else is a per-vendor page-state
        // failure (e.g. an indeterminate grid) and should not take down
        // the rest of the run.
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('MXI session not established') || message.includes('Re-authentication failed')) {
          throw err;
        }

        indeterminateCount++;
        log.error({ vendorCode, errorMessage: message }, 'FAILED (grid state indeterminate)');
        insertWriteUpAction(db, {
          vendor: vendorCode.toLowerCase(),
          partNumber: '(unknown)',
          targetEnv: env,
          outcome: 'grid_state_indeterminate',
          stationCode: null,
          routedLocation: null,
          filledFieldsJson: null,
          errorMessage: message,
          orderNumber: null,
        });
        // Continue to the next vendor — never abort the batch over one
        // vendor's indeterminate grid state.
      }
    }

    await saveVendorCodeEligibleLines(env, allLines);

    const summaryLines = ['=== SUMMARY ==='];
    summaryLines.push(
      `${vendorCodes.length} vendor(s) processed: ${withCandidatesCount} with real candidates, ${zeroCount} genuine ` +
        `zero, ${indeterminateCount} indeterminate (grid state could not be confirmed — see log output above ` +
        `and data/diagnostics/ for captured evidence on each).`,
    );
    summaryLines.push(`Total real candidate lines across all vendors: ${allLines.length}`);
    for (const line of allLines) {
      summaryLines.push(`  [${line.vendorCode}] ${line.partNumber} / SN "${line.serialNumber}"`);
    }
    summaryLines.push(
      `Saved to ${VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH}. Run this next to process everything found: ` +
        `npm run vendor:batch-execute -- --env ${env}`,
    );
    if (indeterminateCount > 0) {
      summaryLines.push(
        `${indeterminateCount} vendor(s) had an indeterminate grid state and were skipped this run — review the ` +
          `captured evidence in data/diagnostics/ and re-run discovery for those vendor codes specifically once ` +
          `the cause is understood.`,
      );
    }

    log.info(
      {
        vendorCount: vendorCodes.length,
        withCandidatesCount,
        zeroCount,
        indeterminateCount,
        totalCandidateLines: allLines.length,
        candidateLines: allLines,
        savedTo: VENDOR_CODE_ELIGIBLE_LINES_FILE_PATH,
        nextCommand: `npm run vendor:batch-execute -- --env ${env}`,
      },
      summaryLines.join('\n'),
    );
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ errorMessage }, 'Vendor batch discovery halted (likely session/login loss)');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
