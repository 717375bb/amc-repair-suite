import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { getSecretProvider } from '../security/secretProvider.js';

/**
 * CLAUDE_CODE_PROMPT (#6, login/account system) — two DIFFERENT primitives
 * for two genuinely different jobs, per explicit user confirmation
 * (scrypt for hashing, confirmed) plus the reasoning that made a second
 * primitive necessary: scrypt is a one-way KDF — perfect for "does this
 * password match," structurally incapable of "give me the real password
 * back." The MXI writer needs the real plaintext password to type into
 * MXI's login form, so the SAME password value also gets a REVERSIBLE
 * AES-256-GCM encryption, under a separate master key. Both are Node's
 * built-in `crypto` module — zero new dependencies, per explicit user
 * preference over adding bcrypt/argon2.
 */

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** `salt:hash`, both hex. A fresh random salt every call — never reused across users or across a password change. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/** Timing-safe comparison — never a plain `===` on secret material. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

/**
 * CLAUDE_CODE_PROMPT (#6-hardening, key-rotation, Part A) — factored out of
 * loadEncryptionKey() below (same 32-byte check, same message shape) so
 * rotateEncryptionKey.ts can validate an explicit OLD/NEW key the same way,
 * without duplicating this logic.
 */
export function parseEncryptionKeyHex(hex: string, varNameForError: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`${varNameForError} must be exactly 32 bytes (64 hex characters) — got ${key.length} byte(s).`);
  }
  return key;
}

/**
 * Reads CREDENTIAL_ENCRYPTION_KEY once per call rather than caching at
 * module load — this module can be imported before dotenv/config has run
 * in some entry points, and a stale empty read would silently make every
 * encrypt/decrypt call fail confusingly later instead of failing loudly here.
 */
function loadEncryptionKey(): Buffer {
  // CLAUDE_CODE_PROMPT (#6-hardening, secrets-seam) — routed through
  // SecretProvider; secretProvider.get() throws its own clear error if this
  // is missing, same timing (first actual use) as the check this replaced.
  const hex = getSecretProvider().get('CREDENTIAL_ENCRYPTION_KEY');
  return parseEncryptionKeyHex(hex, 'CREDENTIAL_ENCRYPTION_KEY');
}

/**
 * CLAUDE_CODE_PROMPT (#6-hardening, key-rotation, Part A) — version tag
 * format: "v<N>:iv:authTag:ciphertext", hex throughout. N=1 is implicit (no
 * tag at all) — every row created before this seam, and every row written
 * by the normal encryptSecret() call below, stays in that original
 * untagged shape; only rotateEncryptionKey.ts ever writes a tagged value,
 * bumping N each time it successfully re-wraps a row. A "v" character can
 * never appear as the first byte of a real hex-encoded IV (hex is 0-9a-f
 * only), so a tagged value can never be mistaken for an untagged one or
 * vice versa — no ambiguity, no forced migration of existing rows.
 */
const VERSION_TAG_PATTERN = /^v(\d+):(.+)$/;

interface ParsedCiphertext {
  version: number;
  ivHex: string;
  authTagHex: string;
  encryptedHex: string;
}

function parseStoredCiphertext(stored: string): ParsedCiphertext {
  const tagMatch = stored.match(VERSION_TAG_PATTERN);
  const rest = tagMatch ? tagMatch[2] : stored;
  const version = tagMatch ? Number(tagMatch[1]) : 1;

  const [ivHex, authTagHex, encryptedHex] = rest.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Stored encrypted value is not in the expected "[vN:]iv:authTag:ciphertext" shape — refusing to guess.');
  }
  return { version, ivHex, authTagHex, encryptedHex };
}

/**
 * CLAUDE_CODE_PROMPT (#6-hardening, key-rotation, Part A) — exported for
 * rotateEncryptionKey.ts's own bookkeeping (it needs a row's CURRENT
 * version to compute the next one when re-wrapping); not used by any
 * normal signup/login/change-password call site.
 */
export function getCiphertextVersion(stored: string): number {
  return parseStoredCiphertext(stored).version;
}

/**
 * `iv:authTag:ciphertext`, all hex. A fresh random IV every call, per
 * AES-GCM's own requirement (never reuse an IV under the same key).
 *
 * `options.keyOverride`/`options.version` are ONLY ever passed by
 * rotateEncryptionKey.ts — every existing call site (authService.ts's
 * register/changePassword) keeps calling this with just `plaintext`, which
 * reproduces today's exact output byte-for-byte: current active key, no
 * version tag. NOTE: new writes stay untagged until Seam 3 tags
 * register/changePassword with an explicit v1 marker; we'll make new
 * signups precisely tagged at Seam 3, where authService.ts is already
 * being modified.
 */
export function encryptSecret(plaintext: string, options?: { keyOverride?: Buffer; version?: number }): string {
  const key = options?.keyOverride ?? loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const body = `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  return options?.version ? `v${options.version}:${body}` : body;
}

/**
 * `keyOverride` is ONLY ever passed by rotateEncryptionKey.ts, to decrypt
 * with an explicit OLD or NEW key rather than whatever's currently
 * configured. Every existing call site (authService.ts's
 * getMxiCredentialForUser) keeps calling this with just `stored`, which
 * behaves exactly as before — reads the one active key, decrypts either
 * ciphertext shape (tagged or untagged) transparently.
 */
export function decryptSecret(stored: string, keyOverride?: Buffer): string {
  const key = keyOverride ?? loadEncryptionKey();
  const { ivHex, authTagHex, encryptedHex } = parseStoredCiphertext(stored);
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
