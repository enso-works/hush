// Light, dark or the system's, remembered in localStorage and applied as the
// `dark` class on <html>. A few lines instead of next-themes, whose flash
// guard is an inline script the dashboard's CSP would refuse.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

export type Theme = 'light' | 'dark' | 'system'
type Resolved = 'light' | 'dark'

const KEY = 'hush.theme'
const media = window.matchMedia('(prefers-color-scheme: dark)')
const system = (): Resolved => (media.matches ? 'dark' : 'light')
const stored = (): Theme => {
  const v = localStorage.getItem(KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}
const apply = (t: Resolved) => document.documentElement.classList.toggle('dark', t === 'dark')

// Before React renders anything, so the first paint is already right.
apply(stored() === 'system' ? system() : (stored() as Resolved))

const Ctx = createContext<{ theme: Theme; systemTheme: Resolved; resolved: Resolved; setTheme: (t: Theme) => void } | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(stored)
  const [systemTheme, setSystem] = useState<Resolved>(system)
  useEffect(() => {
    const on = () => setSystem(system())
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [])
  const resolved = theme === 'system' ? systemTheme : theme
  useEffect(() => {
    apply(resolved)
  }, [resolved])
  const setTheme = (t: Theme) => {
    if (t === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, t)
    setThemeState(t)
  }
  return <Ctx.Provider value={{ theme, systemTheme, resolved, setTheme }}>{children}</Ctx.Provider>
}

export function useTheme() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useTheme outside ThemeProvider')
  return c
}
