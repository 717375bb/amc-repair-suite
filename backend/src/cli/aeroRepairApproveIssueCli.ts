import 'dotenv/config';
import path from 'node:path';
import { getActionableWriteUpAction, insertWriteUpIssueDecision, openDb } from '../db/db.js';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { issueGeneratedOrder, readOrderRealState } from '../writeUps/aeroRepair/issueOrder.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Second phase of the two-phase review gate: explicitly approves and
 * issues ONE order that `aero-repair:review-pending` listed. Calls
 * issueGeneratedOrder() exactly as built/tested in isolation — unchanged
 * here — then independently re-reads the order's real Order Status
 * afterward (same discipline this whole project has learned the hard way:
 * a reported success is not the same fact as a verified one; the ESD
 * module's reissueOrder() anomaly is exactly this class of bug).
 *
 * Requires the order to have an actionable 'pending_issue' write_up_actions
 * row — refuses to issue an order this project never itself put in that
 * state. Records exactly one write_up_issue_decisions row regardless of
 * outcome, same as the ESD approval flow's mxi_writes discipline.
 *
 * Usage: npm run aero-repair:approve-issue -- <orderNumber> [reviewedBy] [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const orderNumber = rest[0];
  const reviewedBy = rest[1] ?? null;

  if (!orderNumber) {
    log.error('Usage: npm run aero-repair:approve-issue -- <orderNumber> [reviewedBy] [--env production]');
    process.exitCode = 1;
    return;
  }

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    const actionable = getActionableWriteUpAction(db, orderNumber);
    if (!actionable) {
      log.error(
        { orderNumber },
        "Order has no actionable 'pending_issue' write_up_actions row — refusing to issue an order this project didn't itself put in that state. Run npm run aero-repair:review-pending to see what's actually pending.",
      );
      process.exitCode = 1;
      return;
    }

    // REAL BUG FOUND AND FIXED (found via reject-issue, same gap applies
    // here): order numbers are NOT unique across environments — a stage
    // order number can coincidentally match a real, unrelated production
    // order. Without this check, approve-issue could click "Issue Order"
    // on whatever that other environment's order happens to be. Refuse
    // rather than guess which environment was meant.
    if (actionable.targetEnv !== env) {
      log.error(
        { orderNumber, recordedTargetEnv: actionable.targetEnv, requestedEnv: env },
        'Order was recorded under a different target_env than requested — Order numbers are not unique across environments — refusing to act against the wrong one.',
      );
      process.exitCode = 1;
      return;
    }

    log.info({ env: env.toUpperCase(), orderNumber }, 'Target MXI environment — approving and issuing order.');

    client = await createReadyMxiClient(env);
    const issueResult = await issueGeneratedOrder(client, orderNumber);

    if (issueResult.status !== 'success') {
      log.error({ errorMessage: issueResult.errorMessage }, 'issueGeneratedOrder reported failure');
    } else {
      log.info('issueGeneratedOrder reported success — independently re-verifying real order state...');
    }

    // Independent re-verification, regardless of what issueGeneratedOrder
    // itself reported — a fresh navigation/read, not trusting the
    // function's own return value alone.
    const page = await client.getAuthenticatedPage();
    const { orderStatus: realStatus, issuedCount: realIssuedCount } = await readOrderRealState(
      page,
      orderNumber,
      client.todoListUrl,
    );

    log.info({ realStatus: realStatus ?? null, realIssuedCount: realIssuedCount ?? null }, 'Real Order Status');

    const genuinelyIssued = realStatus === 'ISSUED';
    const issueStatus: 'success' | 'failed' = genuinelyIssued ? 'success' : 'failed';

    if (genuinelyIssued) {
      log.info({ orderNumber }, 'Order independently confirmed ISSUED.');
    } else {
      log.error(
        { orderNumber },
        'Order does NOT show real status ISSUED after issueGeneratedOrder — treating as failed regardless of what the function itself reported.',
      );
      process.exitCode = 1;
    }

    insertWriteUpIssueDecision(db, {
      writeUpActionId: actionable.id,
      orderNumber,
      targetEnv: env,
      action: 'approved_issue',
      issueStatus,
      errorMessage: issueResult.status === 'success' ? null : issueResult.errorMessage,
      reviewedBy,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error({ errorMessage }, 'Approve-issue failed');
    const actionable = getActionableWriteUpAction(db, orderNumber);
    if (actionable) {
      insertWriteUpIssueDecision(db, {
        writeUpActionId: actionable.id,
        orderNumber,
        targetEnv: env,
        action: 'approved_issue',
        issueStatus: 'failed',
        errorMessage,
        reviewedBy,
      });
    }
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
