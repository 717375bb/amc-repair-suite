import 'dotenv/config';
import path from 'node:path';
import { getActionableWriteUpAction, insertWriteUpIssueDecision, openDb } from './db/db.js';
import type { MxiClient } from './mxiWriter/mxiClient.js';
import { createReadyMxiClient } from './mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from './mxiWriter/parseEnvFlag.js';
import { readOrderRealState } from './writeUps/aeroRepair/issueOrder.js';

/**
 * Reject/skip path for the two-phase review gate — same shape as the ESD
 * approval flow's reject: records a decision, never calls
 * issueGeneratedOrder. `reviewedBy` is just a label recorded in the audit
 * trail (same convention as the ESD flow's `approvedBy`).
 *
 * REAL BUG FOUND AND FIXED: this originally recorded 'rejected' + 'skipped'
 * unconditionally, without checking the order's actual current state —
 * true "never touches MXI" only for a genuinely still-pending order. If
 * the order had already been issued by the time reject-issue runs (e.g. a
 * prior approve-issue already ran, or two reviewers act on the same order),
 * recording plain 'rejected' would misrepresent what happened: the reject
 * decision had no effect, the order was already issued beforehand. Now
 * reads the order's real state FIRST (one read-only navigation — this is
 * the one case reject-issue does touch MXI, to look, never to act) and
 * records 'rejected_but_already_issued' instead when that's what's real.
 *
 * Usage: npm run aero-repair:reject-issue -- <orderNumber> [reviewedBy] [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const orderNumber = rest[0];
  const reviewedBy = rest[1] ?? null;

  if (!orderNumber) {
    console.error('Usage: npm run aero-repair:reject-issue -- <orderNumber> [reviewedBy] [--env production]');
    process.exitCode = 1;
    return;
  }

  const db = openDb(path.join('data', 'audit.db'));
  let client: MxiClient | undefined;

  try {
    const actionable = getActionableWriteUpAction(db, orderNumber);
    if (!actionable) {
      console.error(
        `Order ${orderNumber} has no actionable 'pending_issue' write_up_actions row — nothing to reject. Run npm run aero-repair:review-pending to see what's actually pending.`,
      );
      process.exitCode = 1;
      return;
    }

    // REAL BUG FOUND AND FIXED: order numbers are NOT unique across
    // environments — confirmed live: a stage order number (P000B5NR)
    // coincidentally matched a completely unrelated, real, already-received
    // production order. Without this check, reject-issue would silently
    // read and record a decision against whatever that other environment's
    // order happens to be, mischaracterizing something this project has no
    // business touching. Refuse rather than guess which environment was
    // meant.
    if (actionable.targetEnv !== env) {
      console.error(
        `Order ${orderNumber} was recorded under target_env "${actionable.targetEnv}", but --env "${env}" was requested. ` +
          `Order numbers are not unique across environments — refusing to act against the wrong one. ` +
          `Re-run with --env ${actionable.targetEnv} if that's what you meant.`,
      );
      process.exitCode = 1;
      return;
    }

    console.log(`Target MXI environment: ${env.toUpperCase()}`);
    console.log(`Checking order ${orderNumber}'s real current state before rejecting...`);

    client = await createReadyMxiClient(env);
    const page = await client.getAuthenticatedPage();
    const { orderStatus: realStatus, issuedCount: realIssuedCount } = await readOrderRealState(
      page,
      orderNumber,
      client.todoListUrl,
    );
    console.log(`Real Order Status: ${realStatus ?? '(not found)'}, Issued: ${realIssuedCount ?? '(not found)'}`);

    const alreadyIssued = realStatus === 'ISSUED';

    insertWriteUpIssueDecision(db, {
      writeUpActionId: actionable.id,
      orderNumber,
      targetEnv: env,
      action: alreadyIssued ? 'rejected_but_already_issued' : 'rejected',
      issueStatus: 'skipped',
      errorMessage: null,
      reviewedBy,
    });

    if (alreadyIssued) {
      console.warn(
        `Order ${orderNumber} is ALREADY ISSUED — this reject decision had no effect on that. Recorded as 'rejected_but_already_issued', not plain 'rejected'.`,
      );
    } else {
      console.log(`Order ${orderNumber} rejected — genuinely still pending, never touched by an issue action.`);
    }
  } finally {
    await client?.shutdown();
    db.close();
  }
}

main();
