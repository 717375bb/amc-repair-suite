import { randomBytes, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

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
 * Reads CREDENTIAL_ENCRYPTION_KEY once per call rather than caching at
 * module load — this module can be imported before dotenv/config has run
 * in some entry points, and a stale empty read would silently make every
 * encrypt/decrypt call fail confusingly later instead of failing loudly here.
 */
function loadEncryptionKey(): Buffer {
  const hex = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" ` +
        'and add it to backend/.env — never commit the real value.',
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(`CREDENTIAL_ENCRYPTION_KEY must be exactly 32 bytes (64 hex characters) — got ${key.length} byte(s).`);
  }
  return key;
}

/** `iv:authTag:ciphertext`, all hex. A fresh random IV every call, per AES-GCM's own requirement (never reuse an IV under the same key). */
export function encryptSecret(plaintext: string): string {
  const key = loadEncryptionKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(stored: string): string {
  const key = loadEncryptionKey();
  const [ivHex, authTagHex, encryptedHex] = stored.split(':');
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error('Stored encrypted value is not in the expected "iv:authTag:ciphertext" shape — refusing to guess.');
  }
  const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()]);
  return decrypted.toString('utf8');
}
