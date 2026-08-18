import 'dotenv/config';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { findOrderByNumber, navigateToOrder, readEsdField, readNoteToReceiver } from '../mxiWriter/selectors.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('cli');

/**
 * Read-only connectivity smoke test: log in, look up one order, print its
 * current RO ESD and Notes to Receiver, and exit. Never fills, submits, or
 * edits anything. Shares no code path with writeEsdAndNotes()'s own
 * post-submit re-read, so this is a genuinely independent check — the same
 * role mxi:read-esd played verifying the ESD-only write path's fixes.
 *
 * Defaults to stage. Pass `--env production` to read from real live
 * Maintenix instead — reads its own MXI_STAGE_ or MXI_PROD_ credentials
 * from the environment (never from a discovery/codegen recording file),
 * fully decoupled from server.ts's MXI_USERNAME/MXI_PASSWORD config either way.
 *
 * Usage: npm run mxi:read-esd -- <orderNumber> [--env production]
 */
async function main(): Promise<void> {
  const { env, rest } = parseEnvFlag(process.argv.slice(2));
  const orderNumber = rest[0];
  if (!orderNumber) {
    log.error('Usage: npm run mxi:read-esd -- <orderNumber> [--env production]');
    process.exitCode = 1;
    return;
  }

  log.info({ env: env.toUpperCase() }, 'Target MXI environment');

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    const page = await client.getAuthenticatedPage();

    await findOrderByNumber(page, orderNumber, client.todoListUrl);
    const esd = await readEsdField(page);
    log.info({ orderNumber, esd: esd ?? null }, 'RO ESD');

    await navigateToOrder(page, orderNumber, client.todoListUrl);
    const note = await readNoteToReceiver(page);
    log.info({ orderNumber, note: note ?? null }, 'Notes to Receiver');
  } catch (err) {
    log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'Smoke test failed');
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
