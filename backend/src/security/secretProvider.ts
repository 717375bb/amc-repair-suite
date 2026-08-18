/**
 * CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — Seam 1 of N. Goal: make
 * the eventual Azure Key Vault swap a config change (`SECRET_PROVIDER=keyvault`
 * + a `KeyVaultSecretProvider` implementation), not a rewrite of every call
 * site that currently reads `process.env.X` directly. This file is the
 * abstraction only — behavior is unchanged today; `.env` stays the real
 * source, `LocalEnvSecretProvider` just centralizes how it's read.
 *
 * `init()` is async (Key Vault's own fetch is async); `get()` stays
 * synchronous so every existing call site barely changes — read the secret
 * once during `init()`, hand back the cached value instantly afterward.
 */
export interface SecretProvider {
  /** Idempotent — safe to call from multiple entry points/processes without re-fetching. */
  init(): Promise<void>;
  /** Throws if the named secret was never loaded (missing from the environment, or init() never ran). */
  get(name: string): string;
}

/**
 * The complete list of secret NAMES this codebase reads today, found by
 * grepping every `process.env.X` / `process.env[...]` call site across
 * `backend/src` (see CHANGELOG.md's [#6-hardening][secrets-seam] entry for
 * the full file:line inventory, including the ones deliberately left OUT of
 * this list — MXI_STAGE_BASE_URL/MXI_PROD_BASE_URL (same-for-every-analyst
 * public URLs, not secrets), MXI_ENV/HEADLESS (mode/feature flags),
 * DEFAULT_APPROVED_BY/MXI_DB_PATH/AUTH_DB_PATH/PORT (config, not
 * credentials), and KPI_DB_* (real secrets, but that module is dead code —
 * not wired into any running path yet, see kpiDb/config.ts's own TODO).
 *
 * CLAUDE_CODE_PROMPT (#6-hardening, key-rotation, Part B) — OLD_/NEW_
 * CREDENTIAL_ENCRYPTION_KEY added: one-time rotation inputs read by
 * rotateEncryptionKey.ts, routed through this same provider (rather than a
 * raw process.env read in that one file) specifically because this tool
 * becomes the Key-Vault-rewrap path later too — deliberately NOT added to
 * .env.example's standing var list, since these are a manual, temporary
 * operation input, not part of normal running config.
 */
const KNOWN_SECRET_NAMES: readonly string[] = [
  'CREDENTIAL_ENCRYPTION_KEY',
  'MXI_USERNAME',
  'MXI_PASSWORD',
  'MXI_STAGE_USERNAME',
  'MXI_STAGE_PASSWORD',
  'MXI_PROD_USERNAME',
  'MXI_PROD_PASSWORD',
  'AUTOMATION_API_KEY',
  'ANTHROPIC_API_KEY',
  'OLD_CREDENTIAL_ENCRYPTION_KEY',
  'NEW_CREDENTIAL_ENCRYPTION_KEY',
];

/**
 * Reads `process.env` once (in `init()`) into an in-memory cache and serves
 * `get()` from that cache. Deliberately does NOT throw in `init()` for a
 * secret that's absent — per explicit user direction (2026-08-14,
 * secrets-seam confirmation): several of these vars are legitimately
 * optional at process start today (MXI_USERNAME/MXI_PASSWORD silently
 * default to `''` via the old `?? ''` pattern; AUTOMATION_API_KEY is only
 * checked per-request, not at boot) — an eager throw here would make a
 * server that boots fine today fail to start, a real behavior change, not
 * just a refactor. `get()` throws instead, at the same moment a missing
 * secret would have caused a problem before (first actual use) — this
 * reproduces every existing call site's own current lazy-throw-on-use
 * behavior, just centralized in one place instead of duplicated per call
 * site. A future `strict` fail-fast mode (validate everything eagerly at
 * init()) is a good idea but a deliberate, separate, flagged change on top
 * of this one — not bundled in here.
 */
export class LocalEnvSecretProvider implements SecretProvider {
  private readonly cache = new Map<string, string>();
  private initialized = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    for (const name of KNOWN_SECRET_NAMES) {
      const value = process.env[name];
      if (value) this.cache.set(name, value);
    }
    this.initialized = true;
  }

  get(name: string): string {
    const value = this.cache.get(name);
    if (value === undefined) {
      throw new Error(
        `Secret "${name}" was not found. Set it in backend/.env (or the environment), and make sure ` +
          `secretProvider.init() has already run before this call.`,
      );
    }
    return value;
  }
}

let instance: SecretProvider | null = null;

/**
 * Singleton — every call site in one process shares the same cache, so
 * calling `init()` once (see cliMxiClient.ts / server.ts / esdCompareRunner.ts
 * for the 3 real call sites) is enough for every later `get()` anywhere else
 * in that same process to see the loaded values.
 */
export function getSecretProvider(): SecretProvider {
  if (!instance) {
    const kind = process.env.SECRET_PROVIDER ?? 'local';
    switch (kind) {
      case 'local':
        instance = new LocalEnvSecretProvider();
        break;
      // TODO: case 'keyvault': return new KeyVaultSecretProvider();
      //   Managed Identity pattern: authenticate via Azure's
      //   DefaultAzureCredential (no client secret to manage or rotate —
      //   the Azure host itself vouches for this process's identity via the
      //   platform's metadata endpoint). init() would call
      //   `new SecretClient(keyVaultUri, credential).getSecret(name)` once
      //   per name in KNOWN_SECRET_NAMES and cache the resolved value here,
      //   same contract as LocalEnvSecretProvider — get() stays synchronous
      //   either way, no call site outside this file needs to change again.
      //   NOTE: this project spawns real child processes for MXI/AI work
      //   (discoveryRunner.ts, executeRunner.ts, esdWriteRunner.ts,
      //   esdCompareRunner.ts, every CLI tool in src/cli/) — each child gets
      //   its OWN SecretProvider instance (this module-level singleton
      //   doesn't cross a process boundary) and would independently
      //   authenticate + fetch from Key Vault on its own init() call. Verify
      //   at actual Azure deployment time that the Managed Identity's
      //   ambient credential (whatever DefaultAzureCredential relies on —
      //   env vars, the instance metadata service, etc.) genuinely reaches
      //   spawned children the same way it reaches the parent process —
      //   that's an Azure-hosting-environment property, not something local
      //   testing today can confirm.
      default:
        throw new Error(`Unknown SECRET_PROVIDER "${kind}" — expected "local" (or "keyvault" once implemented).`);
    }
  }
  return instance;
}

/**
 * Sugar over get() for the handful of call sites that today tolerate a
 * missing secret rather than throwing (MXI_USERNAME/MXI_PASSWORD's old
 * `?? ''` default in mxiWriter/config.ts; AUTOMATION_API_KEY's per-request
 * "respond 500" instead of a crash in server.ts's requireAutomationKey).
 * Deliberately kept OUTSIDE the SecretProvider interface itself — this is a
 * convenience wrapper, not a second provider method every implementation
 * has to support.
 */
export function getOptionalSecret(name: string): string {
  try {
    return getSecretProvider().get(name);
  } catch {
    return '';
  }
}
