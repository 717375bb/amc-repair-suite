import { readHeadlessFlag, type MxiEnv } from './config.js';
import { MxiClient } from './mxiClient.js';
import { getSecretProvider } from '../security/secretProvider.js';

/**
 * Shared bootstrap for the mxi:read-esd, mxi:write-esd, and
 * approve-and-write CLI tools. Supersedes the old stage-only
 * createReadyStageMxiClient() — env is now an explicit argument (defaults
 * to 'production', per explicit user instruction 2026-08-19 — stage was
 * confusing as a default since it doesn't mirror production data).
 *
 * Stage and production each read their own fully separate
 * MXI_{STAGE,PROD}_BASE_URL / MXI_{STAGE,PROD}_USERNAME /
 * MXI_{STAGE,PROD}_PASSWORD triple — deliberately never the
 * MXI_USERNAME/MXI_PASSWORD pair server.ts's /approve endpoint uses, so
 * these CLI tools stay decoupled from that config exactly as before (per
 * the original mxiReadEsd.ts design intent: this diagnostic/writer path
 * never depends on the HTTP server's credential config).
 */
export async function createReadyMxiClient(env: MxiEnv = 'production'): Promise<MxiClient> {
  // CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — this is the one
  // chokepoint every CLI tool and job runner in this backend goes through
  // for MXI credentials (confirmed by grep across src/cli/ and
  // src/api/jobRunners/), so init() lives here rather than being repeated
  // at every individual entry point. Idempotent — safe even if a process
  // somehow calls this twice.
  const provider = getSecretProvider();
  await provider.init();

  const prefix = env === 'production' ? 'MXI_PROD' : 'MXI_STAGE';
  // Base URL is not a secret (same public MXI login page for every PSA
  // analyst, per .env.example's own comment) — left as a plain env read.
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  if (!baseUrl) {
    throw new Error(`${prefix}_BASE_URL must be set (in backend/.env or the environment).`);
  }
  const username = provider.get(`${prefix}_USERNAME`);
  const password = provider.get(`${prefix}_PASSWORD`);

  const client = new MxiClient({ env, baseUrl, username, password, headless: readHeadlessFlag() });
  await client.initialize();

  const state = client.getState();
  if (state.status !== 'ready') {
    const reason = state.status === 'failed' ? state.reason : 'client was never initialized';
    await client.shutdown();
    throw new Error(`MXI login did not succeed: ${reason}`);
  }

  return client;
}
