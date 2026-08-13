import 'dotenv/config';
import type { MxiClient } from '../mxiWriter/mxiClient.js';
import { createReadyMxiClient } from '../mxiWriter/cliMxiClient.js';
import { parseEnvFlag } from '../mxiWriter/parseEnvFlag.js';
import { findOrderByNumber, navigateToOrder, readEsdField, readNoteToReceiver } from '../mxiWriter/selectors.js';

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
    console.error('Usage: npm run mxi:read-esd -- <orderNumber> [--env production]');
    process.exitCode = 1;
    return;
  }

  console.log(`Target MXI environment: ${env.toUpperCase()}`);

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    const page = await client.getAuthenticatedPage();

    await findOrderByNumber(page, orderNumber, client.todoListUrl);
    const esd = await readEsdField(page);
    console.log(`Order ${orderNumber}: RO ESD = ${esd ?? '(blank)'}`);

    await navigateToOrder(page, orderNumber, client.todoListUrl);
    const note = await readNoteToReceiver(page);
    console.log(`Order ${orderNumber}: Notes to Receiver = ${note ?? '(blank)'}`);
  } catch (err) {
    console.error('Smoke test failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
