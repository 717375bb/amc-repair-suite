import type { Database } from 'better-sqlite3';
import { getUserByUsername, getUserById, insertUser, updateUserPassword, type AuthUserRow } from '../db/authDb.js';
import { decryptSecret, encryptSecret, hashPassword, verifyPassword } from './crypto.js';

export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`An account with username "${username}" already exists.`);
    this.name = 'UsernameTakenError';
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super('Username or password is incorrect.');
    this.name = 'InvalidCredentialsError';
  }
}

/**
 * CLAUDE_CODE_PROMPT (#6, login/account system) — username doubles as the
 * literal MXI username and password doubles as the literal MXI password
 * (explicit user direction: one identity, not a separate app-only
 * credential). Registration therefore does BOTH a one-way hash (for future
 * login checks) and a reversible encryption of the SAME password value
 * (for MXI injection) in one step. Throws UsernameTakenError rather than
 * silently overwriting — enforced at the DB level too (UNIQUE), this is
 * just a friendlier error before that constraint fires.
 */
export function registerUser(db: Database, username: string, password: string): AuthUserRow {
  const trimmed = username.trim();
  if (getUserByUsername(db, trimmed)) {
    throw new UsernameTakenError(trimmed);
  }
  const passwordHash = hashPassword(password);
  const mxiPasswordEncrypted = encryptSecret(password);
  const id = insertUser(db, { username: trimmed, passwordHash, mxiPasswordEncrypted });
  const created = getUserById(db, id);
  if (!created) {
    throw new Error(`Failed to read back newly-created user "${trimmed}" (id ${id}) — insert may not have committed.`);
  }
  return created;
}

/** Throws InvalidCredentialsError on either a wrong username OR a wrong password — never reveals which, so a login form can't be used to enumerate real usernames. */
export function authenticateUser(db: Database, username: string, password: string): AuthUserRow {
  const user = getUserByUsername(db, username.trim());
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new InvalidCredentialsError();
  }
  return user;
}

/**
 * Requires the CURRENT password (not a token-based reset — no email
 * infrastructure exists, and per explicit user direction this is a
 * "type old password, new password, confirm" flow) before allowing a
 * change. Re-derives both stored values from the new password, same as
 * registration — keeps password_hash and mxi_password_encrypted from ever
 * drifting to different underlying passwords.
 */
export function changePassword(db: Database, userId: number, oldPassword: string, newPassword: string): void {
  const user = getUserById(db, userId);
  if (!user || !verifyPassword(oldPassword, user.password_hash)) {
    throw new InvalidCredentialsError();
  }
  const passwordHash = hashPassword(newPassword);
  const mxiPasswordEncrypted = encryptSecret(newPassword);
  updateUserPassword(db, userId, { passwordHash, mxiPasswordEncrypted });
}

export interface MxiCredential {
  username: string;
  password: string;
}

/** Decrypts on demand — the plaintext MXI password is never held in memory longer than one call needs it. */
export function getMxiCredentialForUser(db: Database, userId: number): MxiCredential {
  const user = getUserById(db, userId);
  if (!user) {
    throw new Error(`No user found for id ${userId} — session referenced a user that no longer exists.`);
  }
  return { username: user.username, password: decryptSecret(user.mxi_password_encrypted) };
}
