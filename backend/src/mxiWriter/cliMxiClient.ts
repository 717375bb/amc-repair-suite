import type { MxiEnv } from './config.js';
import { MxiClient } from './mxiClient.js';

/**
 * Shared bootstrap for the mxi:read-esd, mxi:write-esd, and
 * approve-and-write CLI tools. Supersedes the old stage-only
 * createReadyStageMxiClient() — env is now an explicit argument (defaults
 * to 'stage'), not hardcoded.
 *
 * Stage and production each read their own fully separate
 * MXI_{STAGE,PROD}_BASE_URL / MXI_{STAGE,PROD}_USERNAME /
 * MXI_{STAGE,PROD}_PASSWORD triple — deliberately never the
 * MXI_USERNAME/MXI_PASSWORD pair server.ts's /approve endpoint uses, so
 * these CLI tools stay decoupled from that config exactly as before (per
 * the original mxiReadEsd.ts design intent: this diagnostic/writer path
 * never depends on the HTTP server's credential config).
 */
export async function createReadyMxiClient(env: MxiEnv = 'stage'): Promise<MxiClient> {
  const prefix = env === 'production' ? 'MXI_PROD' : 'MXI_STAGE';
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const username = process.env[`${prefix}_USERNAME`];
  const password = process.env[`${prefix}_PASSWORD`];

  if (!baseUrl || !username || !password) {
    throw new Error(
      `${prefix}_BASE_URL, ${prefix}_USERNAME, and ${prefix}_PASSWORD must all be set (in backend/.env or the environment).`,
    );
  }

  const client = new MxiClient({ env, baseUrl, username, password });
  await client.initialize();

  const state = client.getState();
  if (state.status !== 'ready') {
    const reason = state.status === 'failed' ? state.reason : 'client was never initialized';
    await client.shutdown();
    throw new Error(`MXI login did not succeed: ${reason}`);
  }

  return client;
}
