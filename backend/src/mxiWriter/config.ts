export type MxiEnv = 'stage' | 'production';

export interface MxiConfig {
  env: MxiEnv;
  baseUrl: string;
  username: string;
  password: string;
}

/**
 * MXI_ENV defaults to 'stage'. Reading production requires the env var to be
 * set to the literal string "production" — no shorthand, no fuzzy match, no
 * silent default. Anything other than exactly "stage" or "production" is a
 * hard failure, so a typo can never accidentally resolve to either.
 */
export function loadMxiConfig(): MxiConfig {
  const rawEnv = (process.env.MXI_ENV ?? 'stage').trim();

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

  return {
    env,
    baseUrl,
    username: process.env.MXI_USERNAME ?? '',
    password: process.env.MXI_PASSWORD ?? '',
  };
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
  console.warn('');
  console.warn(banner);
  console.warn('!!  MXI_ENV=production — writes from this server will hit REAL Maintenix data.  !!');
  console.warn('!!  This is not the default. Confirm this is intentional before approving.        !!');
  console.warn(banner);
  console.warn('');
}
