import 'dotenv/config';
import path from 'node:path';
import { insertWriteUpAction, openDb } from '../db/db.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import {
  PIN_PART_NUMBER,
  confirmPinAvailabilitySelection,
  isPinBackShop,
  navigateToPinAvailabilityTab,
  openPinLineByBn,
  readPinAvailabilityTable,
  resolvePinCurrentBase,
  runPinCorrectBaseFlow,
  runPinWrongBaseShipmentFlow,
} from '../backShop/pinRouting.js';
import { resolvePinDestination } from '../backShop/pinAvailability.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Standalone tool for routing a pin (PN 4114T06P03) to back-shop repair,
 * per explicit user direction (2026-09-10) that this runs independently
 * of the vendor-code write-up pipeline rather than as a step inside it.
 *
 * `npm run pins:route -- <BN> [--env production]`
 *
 * If the pin is already at one of the four shops that repair it (CAK,
 * DAY, GSP, ORF — discovery-pins-correct-base-recording.ts), runs the
 * full correct-base flow live: Create New Task, Schedule Work Package,
 * Create Transfer.
 *
 * If it's NOT at one of those: reads the part Availability tab
 * (discovery-availability-table-recording.ts) to compute the transfer
 * destination (lowest U/S + In Repair total — see pinAvailability.ts for
 * the evidence), confirms that selection there, re-opens the pin's own
 * BN line (the availability tab is reached via an independent Part
 * Search, not assumed to share page state with the repair line), and
 * runs Create Shipment: Ship To "<base>/DOCK", Ship By today, Estimated
 * Arrival tomorrow, Reason REPAIR — business rules confirmed directly by
 * the user (2026-09-10), then Move to Dock.
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const bn = rest[0];

  if (!bn) {
    log.error('Usage: npm run pins:route -- <BN> [--env production]');
    process.exitCode = 1;
    return;
  }

  log.info({ env: env.toUpperCase(), bn, partNumber: PIN_PART_NUMBER }, 'Starting pin routing');

  const db = openDb(path.join('data', 'audit.db'));
  const client = await createReadyMxiClient(env);

  try {
    const page = await client.getAuthenticatedPage();
    const linkText = await openPinLineByBn(page, client.todoListUrl, bn);
    const { currentLocation, base, isBackShop } = await resolvePinCurrentBase(page, linkText);
    log.info({ bn, currentLocation, base, isBackShop }, 'Resolved current base');

    if (isBackShop && isPinBackShop(base)) {
      const result = await runPinCorrectBaseFlow(page, base);
      insertWriteUpAction(db, {
        // Pins aren't vendor-coded — 'PINS' is a free-text marker for this
        // column, same append-only table every other write-up flow logs to.
        vendor: 'PINS',
        partNumber: PIN_PART_NUMBER,
        targetEnv: env,
        outcome: result.status === 'success' ? 'filled' : 'error',
        stationCode: base,
        routedLocation: result.locationUsed,
        filledFieldsJson: JSON.stringify({ bn, result }),
        errorMessage: result.errorMessage,
        orderNumber: null,
      });
      if (result.status === 'success') {
        log.info({ bn, base, locationUsed: result.locationUsed }, 'Correct-base pin flow complete');
      } else {
        log.error({ bn, base, errorMessage: result.errorMessage }, 'Correct-base pin flow failed');
        process.exitCode = 1;
      }
      return;
    }

    log.warn(
      { bn, currentLocation },
      'Pin is not at CAK/DAY/GSP/ORF — reading the part availability table to compute the transfer destination',
    );
    await navigateToPinAvailabilityTab(page, client.todoListUrl);
    const rows = await readPinAvailabilityTable(page);
    const resolved = resolvePinDestination(rows);

    if (resolved.tied || !resolved.destination) {
      insertWriteUpAction(db, {
        vendor: 'PINS',
        partNumber: PIN_PART_NUMBER,
        targetEnv: env,
        outcome: 'pending_manual',
        stationCode: base,
        routedLocation: null,
        filledFieldsJson: JSON.stringify({ bn, currentLocation, rows, resolved }),
        errorMessage: 'Two or more back shops tied for the lowest total — not guessing a destination.',
        orderNumber: null,
      });
      log.error({ bn, totals: resolved.totals }, 'Two or more back shops are tied for the lowest total — not guessing a destination');
      process.exitCode = 1;
      return;
    }

    const destinationRow = rows.find((r) => r.base === resolved.destination);
    if (!destinationRow || !destinationRow.rowLabelText) {
      insertWriteUpAction(db, {
        vendor: 'PINS',
        partNumber: PIN_PART_NUMBER,
        targetEnv: env,
        outcome: 'pending_manual',
        stationCode: base,
        routedLocation: resolved.destination,
        filledFieldsJson: JSON.stringify({ bn, currentLocation, rows, resolved }),
        errorMessage: `Computed destination ${resolved.destination}, but its row was never found/read on the Availability tab — cannot confirm the selection there.`,
        orderNumber: null,
      });
      log.error({ bn, destination: resolved.destination }, 'Destination row not found on the Availability tab');
      process.exitCode = 1;
      return;
    }

    log.info({ bn, totals: resolved.totals, destination: resolved.destination }, 'Confirming destination on the Availability tab');
    await confirmPinAvailabilitySelection(page, destinationRow.rowLabelText);

    // The Availability tab was reached via an independent Part Search
    // (navigateToPinAvailabilityTab's own docblock) — re-opening this BN's
    // own line explicitly rather than assuming that navigation returns to
    // it, matching this project's established "never assume page state
    // carried across a detour" discipline.
    await openPinLineByBn(page, client.todoListUrl, bn);
    const shipmentResult = await runPinWrongBaseShipmentFlow(page, resolved.destination);

    insertWriteUpAction(db, {
      vendor: 'PINS',
      partNumber: PIN_PART_NUMBER,
      targetEnv: env,
      outcome: shipmentResult.status === 'success' ? 'filled' : 'error',
      stationCode: base,
      routedLocation: shipmentResult.shipTo,
      filledFieldsJson: JSON.stringify({ bn, currentLocation, rows, resolved, shipmentResult }),
      errorMessage: shipmentResult.errorMessage,
      orderNumber: null,
    });

    if (shipmentResult.status === 'success') {
      log.info({ bn, shipTo: shipmentResult.shipTo }, 'Wrong-base pin transfer complete');
    } else {
      log.error({ bn, errorMessage: shipmentResult.errorMessage }, 'Wrong-base pin transfer failed');
      process.exitCode = 1;
    }
  } finally {
    await client.shutdown();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
