/**
 * CLAUDE_CODE_PROMPT (security.md hardening pass) — real gap closed: login
 * had zero brute-force protection (any number of password guesses, no
 * delay, no lockout). In-memory, same accepted v1 tradeoff as
 * auth/sessions.ts's own session store (a restart clears it — acceptable
 * for a local single-machine tool). Keyed by username, not IP: this is a
 * loopback-only server for one local analyst's own machine, so IP doesn't
 * usefully distinguish attackers from the real user the way it would on a
 * public-facing service — username is the actually-meaningful key here.
 */

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;

interface AttemptRecord {
  count: number;
  windowStart: number;
  lockedUntil: number | null;
}

const attempts = new Map<string, AttemptRecord>();

function normalizeKey(username: string): string {
  return username.trim().toLowerCase();
}

export interface LoginAllowedResult {
  allowed: boolean;
  /** Only present when allowed is false. */
  retryAfterMs?: number;
}

/** Call BEFORE attempting to verify a password — never spend the scrypt cost on an already-locked-out username. */
export function checkLoginAllowed(username: string): LoginAllowedResult {
  const record = attempts.get(normalizeKey(username));
  if (!record || !record.lockedUntil) return { allowed: true };

  const now = Date.now();
  if (now < record.lockedUntil) {
    return { allowed: false, retryAfterMs: record.lockedUntil - now };
  }
  // Lockout window has passed — clear it so this username gets a fresh count, not an immediate re-lock.
  attempts.delete(normalizeKey(username));
  return { allowed: true };
}

/** Returns true the moment this failure is what TRIGGERS a fresh lockout — callers use this to log 'login_locked_out' distinctly from a plain 'login_failure'. */
export function recordLoginFailure(username: string): boolean {
  const key = normalizeKey(username);
  const now = Date.now();
  const existing = attempts.get(key);

  if (!existing || now - existing.windowStart > WINDOW_MS) {
    attempts.set(key, { count: 1, windowStart: now, lockedUntil: null });
    return false;
  }

  existing.count += 1;
  if (existing.count >= MAX_ATTEMPTS && !existing.lockedUntil) {
    existing.lockedUntil = now + LOCKOUT_MS;
    return true;
  }
  return false;
}

export function recordLoginSuccess(username: string): void {
  attempts.delete(normalizeKey(username));
}
