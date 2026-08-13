import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/**
 * CLAUDE_CODE_PROMPT (#6, login/account system) — deliberately a SEPARATE
 * database file from data/audit.db: credentials are a different sensitivity
 * class than the ESD/write-up audit trail, and keeping them apart makes the
 * user's own planned future migration (this table set to an Azure DB) a
 * focused, self-contained move rather than untangling it from the audit
 * schema first.
 *
 * One row per user. `username` doubles as the literal MXI username (per
 * explicit user direction: this app's login identity IS the MXI identity,
 * not a separate app-only credential) — enforced UNIQUE so two accounts can
 * never collide on the same username, per explicit "no repeat credentials"
 * requirement. `password_hash` is a one-way scrypt hash (login verification
 * only, never reversible). `mxi_password_encrypted` is a SEPARATE, reversible
 * AES-256-GCM encryption of the SAME password value — needed because the
 * Playwright writer has to inject the real plaintext password into MXI's
 * login form, which a one-way hash structurally cannot provide. See
 * ../auth/crypto.ts for both primitives. One credential per user, used for
 * BOTH stage and production (per explicit user direction) — no per-env
 * split, unlike the CLI tools' own MXI_STAGE_ / MXI_PROD_ credential pair.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  mxi_password_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export function openAuthDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

export interface AuthUserRow {
  id: number;
  username: string;
  password_hash: string;
  mxi_password_encrypted: string;
  created_at: string;
  updated_at: string;
}

export function getUserByUsername(db: Database.Database, username: string): AuthUserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as AuthUserRow | undefined;
}

export function getUserById(db: Database.Database, id: number): AuthUserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as AuthUserRow | undefined;
}

/** Throws (UNIQUE constraint) if the username already exists — never silently overwrites an existing account. */
export function insertUser(
  db: Database.Database,
  params: { username: string; passwordHash: string; mxiPasswordEncrypted: string },
): number {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, mxi_password_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  const result = stmt.run(params.username, params.passwordHash, params.mxiPasswordEncrypted, now, now);
  return Number(result.lastInsertRowid);
}

export function updateUserPassword(
  db: Database.Database,
  userId: number,
  params: { passwordHash: string; mxiPasswordEncrypted: string },
): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash = ?, mxi_password_encrypted = ?, updated_at = ? WHERE id = ?').run(
    params.passwordHash,
    params.mxiPasswordEncrypted,
    now,
    userId,
  );
}
