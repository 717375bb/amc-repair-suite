import { getOptionalSecret } from '../security/secretProvider.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('mxi');

export type MxiEnv = 'stage' | 'production';

export interface MxiConfig {
  env: MxiEnv;
  baseUrl: string;
  username: string;
  password: string;
  /** Playwright launch mode. Headless by default; only headed when HEADLESS is the literal string "false". */
  headless: boolean;
}

/**
 * MXI_ENV defaults to 'production' (per explicit user instruction,
 * 2026-08-19 — 'stage' as the default was confusing since stage doesn't
 * mirror production data). Reading stage still requires the env var to be
 * set to the literal string "stage" — no shorthand, no fuzzy match.
 * Anything other than exactly "stage" or "production" is a hard failure, so
 * a typo can never accidentally resolve to either.
 */
export function loadMxiConfig(): MxiConfig {
  const rawEnv = (process.env.MXI_ENV ?? 'production').trim();

  let env: MxiEnv;
  if (rawEnv === 'production') {
    env = 'production';
  } else if (rawEnv === 'stage') {
    env = 'stage';
  } else {
    throw new Error(
      `MXI_ENV must be the literal string "stage" or "production" (case-sensitive, no shorthand). Got: "${rawEnv}"`,
    );
  }

  const baseUrl =
    (env === 'production' ? process.env.MXI_PROD_BASE_URL : process.env.MXI_STAGE_BASE_URL) ?? '';

  // CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — routed through
  // SecretProvider via getOptionalSecret, which preserves the exact old
  // `?? ''` behavior (empty string, never a throw) rather than get()'s
  // throw-if-missing — these two are genuinely optional at this call site
  // today (the shared boot-time client these feed is only actually used by
  // the two Power-Automate-facing endpoints; every browser-UI action uses a
  // per-user credential instead, see jobManager.ts).
  return {
    env,
    baseUrl,
    username: getOptionalSecret('MXI_USERNAME'),
    password: getOptionalSecret('MXI_PASSWORD'),
    headless: readHeadlessFlag(),
  };
}

/**
 * Shared by loadMxiConfig() and cliMxiClient.ts's own separate MxiConfig
 * construction, so the two credential paths can't drift on what HEADLESS
 * means. Defaults headless. Only the exact literal "false" runs headed —
 * unset, "False", "0", or a typo all stay headless, since headless is the
 * safe default to fall back to, not the one that needs guarding against.
 */
export function readHeadlessFlag(): boolean {
  return process.env.HEADLESS !== 'false';
}

/**
 * Derives the To Do List URL (used for order search/navigation) from the
 * configured login URL — both MXI_STAGE_BASE_URL and MXI_PROD_BASE_URL end
 * in /security/login.jsp, so this reuses that same already-configured host
 * rather than needing its own separate, independently-guessed constant.
 * Throws rather than silently producing a wrong URL if the base URL doesn't
 * match the expected shape — this feeds every order navigation, so a wrong
 * value here should fail loudly, not land on the wrong environment quietly.
 */
export function deriveTodoListUrl(loginUrl: string): string {
  const match = loginUrl.match(/^(.*)\/security\/login\.jsp$/);
  if (!match) {
    throw new Error(
      `Could not derive the To Do List URL from baseUrl "${loginUrl}" — expected it to end with /security/login.jsp.`,
    );
  }
  return `${match[1]}/ToDoList.jsp`;
}

/** Loud, unmissable — this should never be the environment someone is in by accident. */
export function printProductionWarningIfNeeded(config: MxiConfig): void {
  if (config.env !== 'production') return;
  const banner = '!'.repeat(78);
  log.warn(
    [
      '',
      banner,
      '!!  MXI_ENV=production — writes from this server will hit REAL Maintenix data.  !!',
      '!!  This is not the default. Confirm this is intentional before approving.        !!',
      banner,
      '',
    ].join('\n'),
  );
}
