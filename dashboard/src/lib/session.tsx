import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

import { token } from './api'

type Session = {
  demo: boolean
  signedIn: boolean
  message: string | null
  signIn: (t: string) => void
  signOut: (message?: string) => void
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ demo, children }: { demo: boolean; children: ReactNode }) {
  const [signedIn, setSignedIn] = useState(() => demo || !!token.get())
  const [message, setMessage] = useState<string | null>(null)
  const signIn = useCallback((t: string) => {
    token.set(t.trim())
    setMessage(null)
    setSignedIn(true)
  }, [])
  const signOut = useCallback(
    (m?: string) => {
      token.clear()
      setMessage(m ?? null)
      setSignedIn(demo)
    },
    [demo],
  )
  return <Ctx.Provider value={{ demo, signedIn, message, signIn, signOut }}>{children}</Ctx.Provider>
}

export function useSession() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useSession outside SessionProvider')
  return c
}

/** Period and environment, shared by every page and kept for the tab. */
export type Prefs = { days: number; env: 'prod' | 'dev' }
const PrefsCtx = createContext<{ prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void } | null>(null)

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [prefs, set] = useState<Prefs>(() => ({
    days: Number(sessionStorage.getItem('hush.days')) || 30,
    env: sessionStorage.getItem('hush.env') === 'dev' ? 'dev' : 'prod',
  }))
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    set((old) => {
      const next = { ...old, ...p }
      sessionStorage.setItem('hush.days', String(next.days))
      sessionStorage.setItem('hush.env', next.env)
      return next
    })
  }, [])
  return <PrefsCtx.Provider value={{ prefs, setPrefs }}>{children}</PrefsCtx.Provider>
}

export function usePrefs() {
  const c = useContext(PrefsCtx)
  if (!c) throw new Error('usePrefs outside PrefsProvider')
  return c
}
