import type { MxiEnv } from './config.js';

/**
 * Pulls an optional `--env stage|production` flag out of argv (either
 * `--env production` or `--env=production`) and returns the resolved MxiEnv
 * plus the remaining positional args, unaffected order. Defaults to 'stage'
 * if the flag is absent — production is always an explicit, per-invocation
 * opt-in, never an ambient default, so a leftover setting from an earlier
 * session can never silently redirect a real write. Same case-sensitive,
 * no-shorthand strictness as config.ts's MXI_ENV guard.
 */
export function parseEnvFlag(argv: string[]): { env: MxiEnv; rest: string[] } {
  const rest: string[] = [];
  let env: MxiEnv = 'stage';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--env') {
      env = validateEnv(argv[++i]);
    } else if (arg.startsWith('--env=')) {
      env = validateEnv(arg.slice('--env='.length));
    } else {
      rest.push(arg);
    }
  }

  return { env, rest };
}

function validateEnv(value: string | undefined): MxiEnv {
  if (value === 'production') return 'production';
  if (value === 'stage') return 'stage';
  throw new Error(`--env must be exactly "stage" or "production" (case-sensitive, no shorthand). Got: "${value}"`);
}
