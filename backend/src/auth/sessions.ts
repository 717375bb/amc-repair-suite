import { randomBytes } from 'node:crypto';

/**
 * CLAUDE_CODE_PROMPT (#6, login/account system) — in-memory, same
 * accepted-tradeoff as jobManager.ts's own job registry ("acceptable for
 * v1 (localhost, single analyst)"): a server restart logs everyone out,
 * which is fine for a local tool and avoids a second DB table for
 * something this ephemeral. A real, unguessable random token (32 bytes),
 * never a predictable id — this is what a session-hijacking attempt would
 * have to guess.
 */

export interface Session {
  token: string;
  userId: number;
  username: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const sessions = new Map<string, Session>();

export function createSession(userId: number, username: string): Session {
  const token = randomBytes(32).toString('hex');
  const session: Session = { token, userId, username, expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(token, session);
  return session;
}

/** Returns undefined (and evicts) for a missing or expired token — never trusts a stale entry. */
export function getSession(token: string): Session | undefined {
  const session = sessions.get(token);
  if (!session) return undefined;
  if (Date.now() > session.expiresAt) {
    sessions.delete(token);
    return undefined;
  }
  return session;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

/**
 * Called when a password change invalidates every OTHER session for this
 * user too (e.g. a compromised session that isn't the one making the
 * change) — not currently wired to changePassword automatically (the
 * calling session is the one that just proved it knows the new
 * credentials and should stay logged in), but exported for that future use.
 */
export function destroyAllSessionsForUser(userId: number): void {
  for (const [token, session] of sessions) {
    if (session.userId === userId) sessions.delete(token);
  }
}

const COOKIE_NAME = 'session_token';

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function readSessionTokenFromRequest(cookieHeader: string | undefined): string | undefined {
  return parseCookies(cookieHeader)[COOKIE_NAME];
}

/**
 * No `Secure` attribute — this server is 127.0.0.1-only plain HTTP by
 * design (see server.ts's own CORS comment), and a `Secure` cookie is
 * silently dropped by the browser over plain HTTP, which would make login
 * appear to succeed and then immediately fail on the very next request.
 * `SameSite=Lax` + `HttpOnly` still block the two realistic threats here
 * (JS-readable-cookie theft via XSS, and cross-site POST forgery).
 */
export function buildSessionCookieHeader(token: string): string {
  const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function buildClearSessionCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
