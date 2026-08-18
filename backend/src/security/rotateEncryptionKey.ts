import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openAuthDb } from '../db/authDb.js';
import { decryptSecret, encryptSecret, getCiphertextVersion, parseEncryptionKeyHex } from '../auth/crypto.js';
import { getSecretProvider } from './secretProvider.js';
import { createLogger } from '../logging/logger.js';

const log = createLogger('security');

/**
 * CLAUDE_CODE_PROMPT (#6-hardening, key-rotation, Part B) — offline,
 * manual-only re-encryption tool. Never imported by, or called from, any
 * request path or any other file in this backend — run by hand
 * (`npm run rotate-encryption-key [-- --dry-run]`) when
 * CREDENTIAL_ENCRYPTION_KEY needs to change: a planned rotation, or
 * recovering from a suspected-compromised key per security.md §7.
 *
 * Given OLD_CREDENTIAL_ENCRYPTION_KEY and NEW_CREDENTIAL_ENCRYPTION_KEY
 * (both via SecretProvider, never hardcoded or logged — see
 * secretProvider.ts's KNOWN_SECRET_NAMES), re-encrypts every user's stored
 * MXI credential from the old key to the new one.
 *
 * Idempotent by construction, not by inspecting the version tag: each row
 * is checked against the NEW key first — if it already decrypts, the row
 * is already on the target key and is left untouched. This is what makes
 * re-running the exact same old/new pair a safe no-op (every row reports
 * "already on new key," zero writes) rather than a second attempt that
 * fails on every row. The version tag (crypto.ts's getCiphertextVersion)
 * is bumped for audit/visibility, not relied on as the safety mechanism —
 * a stale or missing tag can never cause an incorrect skip or an incorrect
 * rewrap, only the real cryptographic outcome can.
 *
 * `--dry-run`: read-only. Scans every row and reports every single one
 * that would be rewrapped / is already on the new key / fails BOTH keys —
 * one full pass, never aborting early (per explicit user direction: a dry
 * run should be a complete diagnostic, not stop at the first problem row).
 * No backup, no transaction, no writes.
 *
 * Real run: unconditional backup of auth.db first — a timestamped copy,
 * every time, no exceptions, same discipline this project already uses
 * for every other real-data write tool. Then the ENTIRE row loop runs
 * inside ONE better-sqlite3 `db.transaction()` — all rows succeed and
 * commit together, or the first row that fails both keys throws and
 * better-sqlite3 rolls back every write staged so far in this run, per the
 * "fail atomically" requirement. Never prints key material, ciphertext, or
 * decrypted plaintext — only row ids/usernames and outcome counts.
 */

type RowOutcome = 'rewrapped' | 'already_on_new_key' | 'failed_both_keys';

interface AuthUserRowSlim {
  id: number;
  username: string;
  mxi_password_encrypted: string;
}

interface RowReport {
  id: number;
  username: string;
  outcome: RowOutcome;
}

function parseArgs(): { dryRun: boolean } {
  return { dryRun: process.argv.includes('--dry-run') };
}

function resolveAuthDbPath(): string {
  return process.env.AUTH_DB_PATH || path.join('data', 'auth.db');
}

/**
 * Timestamped, unconditional, before any write — same "backup first, no
 * exceptions" convention this project already uses elsewhere.
 *
 * REAL BUG FOUND AND FIXED during live testing against a scratch copy of
 * the real auth.db: this originally used a plain `fs.copyFileSync`, which
 * silently produced an INCOMPLETE, stale backup — auth.db runs in WAL mode
 * (`authDb.ts`'s `journal_mode = WAL` pragma), so recent writes can live in
 * a separate `auth.db-wal` file rather than the main `.db` file yet, and a
 * raw file copy of just the main file misses them entirely. Reproduced
 * directly: a real row present via the live SQLite connection was
 * completely ABSENT when the plain-copied file was reopened. Fixed with
 * better-sqlite3's own Online Backup API (`db.backup()`), which produces a
 * single, consistent snapshot that correctly includes WAL data — the same
 * mechanism SQLite's own backup tooling uses. Re-verified after the fix:
 * the backed-up file's row count matches the live source exactly.
 */
async function backupAuthDb(dbPath: string): Promise<string> {
  const dir = path.join('data', 'auth-db-backups');
  fs.mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/:/g, '-');
  const backupPath = path.join(dir, `auth-${timestamp}.db`);

  const source = new Database(dbPath, { readonly: true });
  try {
    await source.backup(backupPath);
  } finally {
    source.close();
  }
  return backupPath;
}

/**
 * New-key-first, then old-key — matches the real run's own check order, so
 * a dry run predicts exactly what the real run would do to each row.
 * Never throws; a row failing both keys is a reportable OUTCOME here, not
 * an exception (the real run turns this same outcome into a throw itself,
 * at the call site below — see runRealRotation).
 */
function classifyRow(
  row: AuthUserRowSlim,
  oldKey: Buffer,
  newKey: Buffer,
): { outcome: RowOutcome; plaintext: string | null } {
  try {
    decryptSecret(row.mxi_password_encrypted, newKey);
    return { outcome: 'already_on_new_key', plaintext: null };
  } catch {
    // Not decryptable with the new key — fall through and try the old one.
  }
  try {
    const plaintext = decryptSecret(row.mxi_password_encrypted, oldKey);
    return { outcome: 'rewrapped', plaintext };
  } catch {
    return { outcome: 'failed_both_keys', plaintext: null };
  }
}

function runDryRun(rows: AuthUserRowSlim[], oldKey: Buffer, newKey: Buffer): void {
  const reports: RowReport[] = rows.map((row) => {
    const { outcome } = classifyRow(row, oldKey, newKey);
    return { id: row.id, username: row.username, outcome };
  });
  printSummary(reports, true);
}

function runRealRotation(db: Database.Database, rows: AuthUserRowSlim[], oldKey: Buffer, newKey: Buffer): void {
  const reports: RowReport[] = [];
  const updateStmt = db.prepare('UPDATE users SET mxi_password_encrypted = ?, updated_at = ? WHERE id = ?');

  const runAllRows = db.transaction(() => {
    for (const row of rows) {
      const { outcome, plaintext } = classifyRow(row, oldKey, newKey);

      if (outcome === 'failed_both_keys') {
        // Thrown inside a better-sqlite3 transaction rolls back every
        // write already staged in THIS run — nothing changes, per the
        // "fail atomically" requirement. Never reaches printSummary below.
        throw new Error(
          `Row id=${row.id} username="${row.username}" could not be decrypted with either key. ` +
            `Rolled back — nothing was written.`,
        );
      }

      if (outcome === 'rewrapped' && plaintext !== null) {
        const nextVersion = getCiphertextVersion(row.mxi_password_encrypted) + 1;
        const reEncrypted = encryptSecret(plaintext, { keyOverride: newKey, version: nextVersion });
        updateStmt.run(reEncrypted, new Date().toISOString(), row.id);
      }

      reports.push({ id: row.id, username: row.username, outcome });
    }
  });

  runAllRows();
  printSummary(reports, false);
}

function printSummary(reports: RowReport[], dryRun: boolean): void {
  const rewrapped = reports.filter((r) => r.outcome === 'rewrapped');
  const alreadyOnNew = reports.filter((r) => r.outcome === 'already_on_new_key');
  const failed = reports.filter((r) => r.outcome === 'failed_both_keys');

  log.info(
    {
      dryRun,
      rowsProcessed: reports.length,
      rewrappedCount: rewrapped.length,
      alreadyOnNewKeyCount: alreadyOnNew.length,
      failedCount: failed.length,
      failedRows: failed.map((f) => ({ id: f.id, username: f.username })),
    },
    `${dryRun ? 'DRY RUN' : 'ROTATION'} SUMMARY`,
  );
}

async function main(): Promise<void> {
  const { dryRun } = parseArgs();

  const provider = getSecretProvider();
  await provider.init();

  const oldKey = parseEncryptionKeyHex(provider.get('OLD_CREDENTIAL_ENCRYPTION_KEY'), 'OLD_CREDENTIAL_ENCRYPTION_KEY');
  const newKey = parseEncryptionKeyHex(provider.get('NEW_CREDENTIAL_ENCRYPTION_KEY'), 'NEW_CREDENTIAL_ENCRYPTION_KEY');

  if (oldKey.equals(newKey)) {
    throw new Error(
      'OLD_CREDENTIAL_ENCRYPTION_KEY and NEW_CREDENTIAL_ENCRYPTION_KEY are identical — refusing a no-op ' +
        '"rotation" that could be masking a real misconfiguration.',
    );
  }

  const dbPath = resolveAuthDbPath();
  if (!fs.existsSync(dbPath)) {
    throw new Error(`No auth database found at "${dbPath}".`);
  }

  log.info(
    { dbPath, mode: dryRun ? 'DRY RUN — read-only, no backup, no writes' : 'REAL RUN — will back up, then write' },
    'Target auth database',
  );

  if (!dryRun) {
    const backupPath = await backupAuthDb(dbPath);
    log.info({ backupPath }, 'Backed up auth.db');
  }

  const db = openAuthDb(dbPath);
  try {
    const rows = db.prepare('SELECT id, username, mxi_password_encrypted FROM users').all() as AuthUserRowSlim[];

    if (dryRun) {
      runDryRun(rows, oldKey, newKey);
    } else {
      runRealRotation(db, rows, oldKey, newKey);
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  log.error({ errorMessage: err instanceof Error ? err.message : String(err) }, 'Rotation failed');
  process.exitCode = 1;
});
