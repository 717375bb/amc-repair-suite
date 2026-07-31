import 'dotenv/config';
import type { MxiClient } from './mxiClient.js';
import { createReadyMxiClient } from './cliMxiClient.js';
import { parseEnvFlag } from './parseEnvFlag.js';

/**
 * One-off diagnostic: logs in via the same login() mxiClient.ts uses, saves
 * the authenticated browser context to disk, then exits. The saved file
 * lets a `playwright codegen --load-storage=...` session start already
 * logged in, so recordings only capture the flow being investigated (e.g.
 * edit + submit) rather than re-recording the login every time — real
 * production credentials are never typed or recorded during that codegen
 * session, since the session is already authenticated before it starts.
 *
 * Env-aware, same `--env` pattern as mxi:read-esd/mxi:write-esd
 * (parseEnvFlag.ts) — defaults to stage, production is an explicit
 * per-invocation opt-in. Output filename is env-suffixed
 * (data/mxi-stage-storage-state.json / data/mxi-production-storage-state.json)
 * so a stage session can never be mistaken for or accidentally loaded as a
 * production one, or vice versa.
 *
 * Usage:
 *   npm run mxi:save-storage-state -- [--env production]
 */
async function main(): Promise<void> {
  const { env } = parseEnvFlag(process.argv.slice(2));
  const outputPath = `data/mxi-${env}-storage-state.json`;

  let client: MxiClient | undefined;
  try {
    client = await createReadyMxiClient(env);
    await client.saveStorageState(outputPath);
    console.log(`Saved authenticated ${env} session to ${outputPath}`);
    console.log(
      `Load it in codegen with: npx playwright codegen --load-storage=${outputPath} <url>`,
    );
  } catch (err) {
    console.error('Failed to save storage state:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await client?.shutdown();
  }
}

main();
