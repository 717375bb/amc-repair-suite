import type { Database } from 'better-sqlite3';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  buildClearSessionCookieHeader,
  buildSessionCookieHeader,
  createSession,
  destroySession,
  getSession,
  readSessionTokenFromRequest,
  type Session,
} from '../auth/sessions.js';
import { authenticateUser, changePassword, InvalidCredentialsError, registerUser, UsernameTakenError } from '../auth/authService.js';

/** Attached by requireSession once a valid session is confirmed — route handlers read req.session, never re-derive it. */
export interface AuthedRequest extends Request {
  session?: Session;
}

/**
 * CLAUDE_CODE_PROMPT (#6, login/account system) — gates every browser-UI
 * route (Order Write-Ups, ESD Finder), replacing requireAutomationKey for
 * those. Deliberately does NOT touch the Power-Automate-facing endpoints
 * (/pending-esd-updates, /esd-updates/:orderNumber/{approve,reject}) — per
 * explicit user direction those stay on AUTOMATION_API_KEY, a genuinely
 * different (machine-to-machine, not human-login) trust boundary.
 */
export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const token = readSessionTokenFromRequest(req.header('Cookie'));
  const session = token ? getSession(token) : undefined;
  if (!session) {
    res.status(401).json({ error: 'Not logged in.' });
    return;
  }
  (req as AuthedRequest).session = session;
  next();
}

function readCredentials(req: Request, res: Response): { username: string; password: string } | null {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) {
    res.status(400).json({ error: 'username and password are both required.' });
    return null;
  }
  return { username, password };
}

export function registerAuthRoutes(app: Express, authDb: Database): void {
  app.post('/api/auth/register', (req, res) => {
    const creds = readCredentials(req, res);
    if (!creds) return;
    try {
      const user = registerUser(authDb, creds.username, creds.password);
      const session = createSession(user.id, user.username);
      res.setHeader('Set-Cookie', buildSessionCookieHeader(session.token));
      res.status(201).json({ username: user.username });
    } catch (err) {
      if (err instanceof UsernameTakenError) {
        res.status(409).json({ error: err.message });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  app.post('/api/auth/login', (req, res) => {
    const creds = readCredentials(req, res);
    if (!creds) return;
    try {
      const user = authenticateUser(authDb, creds.username, creds.password);
      const session = createSession(user.id, user.username);
      res.setHeader('Set-Cookie', buildSessionCookieHeader(session.token));
      res.status(200).json({ username: user.username });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        res.status(401).json({ error: err.message });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readSessionTokenFromRequest(req.header('Cookie'));
    if (token) destroySession(token);
    res.setHeader('Set-Cookie', buildClearSessionCookieHeader());
    res.status(200).json({ ok: true });
  });

  app.get('/api/auth/me', requireSession, (req, res) => {
    const session = (req as AuthedRequest).session!;
    res.json({ username: session.username });
  });

  app.post('/api/auth/change-password', requireSession, (req, res) => {
    const session = (req as AuthedRequest).session!;
    const { oldPassword, newPassword } = req.body ?? {};
    if (typeof oldPassword !== 'string' || !oldPassword || typeof newPassword !== 'string' || !newPassword) {
      res.status(400).json({ error: 'oldPassword and newPassword are both required.' });
      return;
    }
    try {
      changePassword(authDb, session.userId, oldPassword, newPassword);
      res.status(200).json({ ok: true });
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        res.status(401).json({ error: 'Current password is incorrect.' });
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  });
}
