import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import * as authApi from './authApi'
import { AuthApiError } from './authApi'

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

type AuthContextValue = {
  status: AuthStatus
  username: string | null
  login: (username: string, password: string) => Promise<void>
  register: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [username, setUsername] = useState<string | null>(null)

  useEffect(() => {
    authApi
      .getCurrentUser()
      .then((r) => {
        setUsername(r.username)
        setStatus('authenticated')
      })
      .catch(() => {
        setStatus('unauthenticated')
      })
  }, [])

  const login = async (u: string, p: string) => {
    const r = await authApi.login(u, p)
    setUsername(r.username)
    setStatus('authenticated')
  }

  const register = async (u: string, p: string) => {
    const r = await authApi.register(u, p)
    setUsername(r.username)
    setStatus('authenticated')
  }

  const logout = async () => {
    // Clear local state regardless of whether the network call itself
    // succeeds — a logged-out UI is the correct outcome either way, and a
    // failed logout call shouldn't leave the user stuck looking logged in.
    try {
      await authApi.logout()
    } finally {
      setUsername(null)
      setStatus('unauthenticated')
    }
  }

  return (
    <AuthContext.Provider value={{ status, username, login, register, logout }}>{children}</AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export { AuthApiError }
