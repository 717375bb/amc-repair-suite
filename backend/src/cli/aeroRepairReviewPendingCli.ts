import 'dotenv/config';
import path from 'node:path';
import {
  getOrdersAwaitingDockMove,
  getPendingIssueOrders,
  insertWriteUpDockMove,
  openDb,
  type WriteUpIssueDecisionDbRow,
} from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { readOutboundShipmentDockState } from '../writeUps/aeroRepair/issueOrder.js';
import type { AeroRepairWriteUpFields } from '../writeUps/aeroRepair/writeUp.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Lists every real order awaiting the second phase of the two-phase review
 * gate: it cleared Auth Flow confirmation (phase one, `aero-repair:write-up`)
 * but Issue Order has not been decided yet. Read-only — never touches MXI.
 *
 * Required for every production run until each routing destination has an
 * established production track record, per this task's explicit
 * requirement (NH and Georgia included, despite being proven in stage).
 *
 * Also lists every order that IS genuinely issued but has no recorded Move
 * to Dock outcome yet — per the user's process, an issued order is not
 * actually done until physical stores has been signaled to prep it for
 * outbound shipment. Surfaced here so this final step can't be silently
 * skipped and mistaken for complete just because Issue Order succeeded.
 *
 * REAL FINDING this section is built around: `write_up_dock_moves` cannot
 * be trusted as sole source of truth for whether an order has actually
 * been docked in the real world — only for whether THIS automation did
 * it. A real order (`P000BAL4`) was moved to dock (and shipped, and
 * received by the vendor) by someone else entirely, outside this
 * automation, between sessions, and the DB's last-known state had no way
 * of knowing that on its own. So before listing anything here as
 * genuinely "awaiting," this does a live, read-only re-check
 * (`readOutboundShipmentDockState`) against real MXI for each candidate
 * order — grouped by `targetEnv`, one `MxiClient` per distinct environment
 * actually present in the candidate list, so both a stage and a production
 * order can be checked in the same run without requiring an `--env` flag.
 * Anything found already at-or-past dock gets a corrective
 * `write_up_dock_moves` row backfilled on the spot (`already_docked_externally`)
 * and is excluded from the printed list; only genuinely `not_yet_docked`
 * orders are shown. If the live check itself can't be completed (login
 * failure, unexpected page shape), the order is still shown — with an
 * explicit warning that live confirmation wasn't possible — rather than
 * silently hidden or silently trusted from stale DB state alone.
 *
 * Usage: npm run aero-repair:review-pending
 */
async function main(): Promise<void> {
  const db = openDb(path.join('data', 'audit.db'));
  try {
    const pending = getPendingIssueOrders(db);

    if (pending.length === 0) {
      log.info('No orders pending issue review.');
    } else {
      log.info({ count: pending.length }, 'Order(s) pending issue review');

      for (const row of pending) {
        let fields: AeroRepairWriteUpFields | null = null;
        try {
          fields = row.filledFieldsJson ? JSON.parse(row.filledFieldsJson) : null;
        } catch {
          fields = null;
        }

        const envFlag = row.targetEnv === 'production' ? ' --env production' : '';
        log.info(
          {
            orderNumber: row.orderNumber,
            partNumber: row.partNumber,
            targetEnv: row.targetEnv,
            routedLocation: row.routedLocation ?? '(unknown)',
            selectedVendor: fields?.routing.status === 'routed' ? fields.routing.location : '(unknown)',
            chargeToAccountBefore: fields?.chargeToAccountBefore ?? '?',
            chargeToAccountAfter: fields?.chargeToAccountAfter ?? '?',
            returnToLocation: fields?.returnToLocation ?? '(unknown)',
            notesText: fields?.notesText ?? '(unknown)',
            filledAt: row.createdAt,
            approveCommand: `npm run aero-repair:approve-issue -- ${row.orderNumber}${envFlag}`,
            rejectCommand: `npm run aero-repair:reject-issue -- ${row.orderNumber} "<reason>"${envFlag}`,
          },
          'Pending issue review item',
        );
      }
    }

    const dbAwaitingDock = getOrdersAwaitingDockMove(db);
    const genuinelyAwaiting = await liveCheckAwaitingDock(db, dbAwaitingDock);

    if (genuinelyAwaiting.length === 0) {
      log.info('No issued orders awaiting Move to Dock (live-confirmed).');
    } else {
      log.info(
        { count: genuinelyAwaiting.length },
        'Issued order(s) NOT YET moved to dock — not actually complete',
      );
      for (const { row, liveCheckFailed } of genuinelyAwaiting) {
        log.info(
          {
            orderNumber: row.orderNumber,
            targetEnv: row.targetEnv,
            issuedAt: row.createdAt,
            liveCheckFailed,
            moveToDockCommand: `npm run aero-repair:move-to-dock -- ${row.orderNumber}${row.targetEnv === 'production' ? ' --env production' : ''}`,
          },
          liveCheckFailed
            ? 'Issued order awaiting Move to Dock — live re-check failed, this is the last-known DB state only, not freshly confirmed'
            : 'Issued order awaiting Move to Dock',
        );
      }
    }
  } finally {
    db.close();
  }
}

interface AwaitingDockCheckResult {
  row: WriteUpIssueDecisionDbRow;
  liveCheckFailed: boolean;
}

/**
 * Live re-checks every DB-candidate "awaiting dock" order against real
 * MXI before trusting the label, grouped by target_env so both stage and
 * production orders can be checked in one run. Backfills a corrective
 * write_up_dock_moves row for anything found already at-or-past dock
 * (so the next run doesn't need to re-check it), and returns only the
 * orders that are still genuinely pending — plus any whose live check
 * itself failed, marked as such rather than silently dropped or silently
 * trusted.
 */
async function liveCheckAwaitingDock(
  db: ReturnType<typeof openDb>,
  candidates: WriteUpIssueDecisionDbRow[],
): Promise<AwaitingDockCheckResult[]> {
  if (candidates.length === 0) return [];

  const envs = Array.from(new Set(candidates.map((row) => row.targetEnv)));
  const results: AwaitingDockCheckResult[] = [];

  for (const env of envs) {
    if (env !== 'stage' && env !== 'production') {
      // Unknown env value — can't create a client for it; surface as-is.
      for (const row of candidates.filter((r) => r.targetEnv === env)) {
        results.push({ row, liveCheckFailed: true });
      }
      continue;
    }

    let client: MxiClient | undefined;
    try {
      client = await createReadyMxiClient(env);
    } catch {
      // Login itself failed — can't live-check any order in this env.
      for (const row of candidates.filter((r) => r.targetEnv === env)) {
        results.push({ row, liveCheckFailed: true });
      }
      continue;
    }

    try {
      // Fetched once per client, reused for every order in this env's
      // loop — never call client.getAuthenticatedPage() again mid-flow
      // (see readOutboundShipmentDockState's docstring for the real bug
      // that caused, found via the batch-execute proof run).
      const page = await client.getAuthenticatedPage();
      for (const row of candidates.filter((r) => r.targetEnv === env)) {
        try {
          const dockState = await readOutboundShipmentDockState(page, client.todoListUrl, row.orderNumber);
          if (dockState.status === 'already_docked_or_further') {
            insertWriteUpDockMove(db, {
              writeUpIssueDecisionId: row.id,
              orderNumber: row.orderNumber,
              targetEnv: row.targetEnv,
              shipmentId: dockState.shipmentId,
              moveStatus: 'already_docked_externally',
              errorMessage:
                'Backfilled by review-pending\'s live pre-check — found already at or past dock, not recorded by this automation.',
            });
            // Genuinely done — excluded from the returned "still pending" list.
          } else {
            // 'not_yet_docked' or 'no_outbound_shipment_found' — still show
            // it; a missing outbound shipment is unexpected for an issued
            // order and worth a human's attention, not silent exclusion.
            results.push({ row, liveCheckFailed: false });
          }
        } catch {
          results.push({ row, liveCheckFailed: true });
        }
      }
    } finally {
      await client.shutdown();
    }
  }

  return results;
}

main();
