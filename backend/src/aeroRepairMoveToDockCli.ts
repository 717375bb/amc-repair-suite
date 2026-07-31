import 'dotenv/config';
import path from 'node:path';
import { getIssuedDecisionForOrder, insertWriteUpDockMove, openDb } from './db/db.js';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { moveOutboundShipmentToDock } from './writeUps/aeroRepair/issueOrder.js';

/**
 * Real last step of writing up an order, after Issue Order: moves the
 * part's outbound shipment to dock, signaling physical stores to prep it
 * for shipping to the vendor. Per the user's process, an issued order is
 * NOT actually done until this step happens — recorded here as its own
 * append-only write_up_dock_moves row (schema.sql) so an issued-but-not-
 * docked order can never be silently mistaken for complete.
 *
 * Explicit, separate CLI — same discipline as issueGeneratedOrder()/
 * approve-issue: never auto-chained onto issuing.
 *
 * Requires the order to have a genuinely-issued (approved_issue/success)
 * write_up_issue_decisions row — refuses to move-to-dock an order this
 * project never itself confirmed was issued. Same environment-mismatch
 * guard as approve-issue/reject-issue, for the same reason: order numbers
 * are not unique across stage/production.
 *
 * Does not self-verify beyond the click sequence completing — check the
 * order's Receipt & Returns tab independently afterward.
 *
 * Usage: npm run aero-repair:move-to-dock -- <orderNumber> [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const orderNumber = rest[0];

  if (!orderNumber) {
    console.error('Usage: npm run aero-repair:move-to-dock -- <orderNumber> [--env production]');
    process.exitCode = 1;
    return;
  }

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    const issuedDecision = getIssuedDecisionForOrder(db, orderNumber);
    if (!issuedDecision) {
      console.error(
        `Order ${orderNumber} has no confirmed-issued (approved_issue/success) write_up_issue_decisions row — refusing to move to dock an order this project never itself confirmed was issued.`,
      );
      process.exitCode = 1;
      return;
    }

    // Same guard as approve-issue/reject-issue: order numbers are NOT
    // unique across stage vs production.
    if (issuedDecision.targetEnv !== env) {
      console.error(
        `Order ${orderNumber} was issued under target_env "${issuedDecision.targetEnv}", but --env "${env}" was requested. ` +
          `Order numbers are not unique across environments — refusing to act against the wrong one. ` +
          `Re-run with --env ${issuedDecision.targetEnv} if that's what you meant.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`Target MXI environment: ${env.toUpperCase()}`);
    console.log(`Moving order ${orderNumber}'s outbound shipment to dock...`);

    client = await createReadyMxiClient(env);
    const result = await moveOutboundShipmentToDock(client, orderNumber);

    insertWriteUpDockMove(db, {
      writeUpIssueDecisionId: issuedDecision.id,
      orderNumber,
      targetEnv: env,
      shipmentId: result.shipmentId,
      moveStatus: result.status,
      errorMessage: result.status === 'success' ? null : result.errorMessage,
    });

    if (result.status === 'success') {
      console.log(`Moved shipment ${result.shipmentId} to dock for order ${orderNumber}.`);
      console.log('This is NOT independent verification — check the shipment state separately.');
    } else if (result.status === 'already_docked_externally') {
      console.log(
        `Order ${orderNumber}'s outbound shipment (${result.shipmentId}) is ALREADY at dock or further along — nothing to do. ` +
          `This was done by someone/something outside this automation (a person, or an untracked earlier run); recorded as-is, not as an error.`,
      );
    } else if (result.status === 'no_outbound_shipment_found') {
      console.error(`No outbound shipment (with a "Ship From: <STATION>/DOCK" pattern) found for order ${orderNumber}.`);
      process.exitCode = 1;
    } else {
      console.error(`Move to Dock failed for order ${orderNumber}: ${result.errorMessage}`);
      process.exitCode = 1;
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error('Move-to-dock failed:', errorMessage);
    const issuedDecision = getIssuedDecisionForOrder(db, orderNumber);
    if (issuedDecision) {
      insertWriteUpDockMove(db, {
        writeUpIssueDecisionId: issuedDecision.id,
        orderNumber,
        targetEnv: env,
        shipmentId: null,
        moveStatus: 'failed',
        errorMessage,
      });
    }
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
