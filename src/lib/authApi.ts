/**
 * Auth API client — separate from lib/api.ts's ApiError/request helpers
 * because this is the one part of the app that must work BEFORE any
 * session exists (register/login can't themselves require a session).
 * Every call uses `credentials: 'include'` so the browser sends/receives
 * the httpOnly session cookie — no bundled shared secret involved, unlike
 * the old VITE_AUTOMATION_API_KEY approach this replaces for the browser UI.
 */

// See lib/api.ts's docstring — same #6 real-bug fix, same reason: '' (a
// same-origin relative path) proxied through Vite's dev server, not a
// direct cross-origin request that silently drops the session cookie.
const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

export class AuthApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface ErrorBody {
  error?: string
}

async function authRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = (await res.json()) as ErrorBody
      message = body.error ?? message
    } catch {
      // response body wasn't JSON — fall back to statusText
    }
    throw new AuthApiError(res.status, message)
  }
  return res.json() as Promise<T>
}

export function register(username: string, password: string): Promise<{ username: string }> {
  return authRequest('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function login(username: string, password: string): Promise<{ username: string }> {
  return authRequest('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) })
}

export function logout(): Promise<{ ok: true }> {
  return authRequest('/api/auth/logout', { method: 'POST' })
}

export function getCurrentUser(): Promise<{ username: string }> {
  return authRequest('/api/auth/me')
}

export function changePassword(oldPassword: string, newPassword: string): Promise<{ ok: true }> {
  return authRequest('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) })
}
