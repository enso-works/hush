// The apps list, fetched once per period and environment and shared by the
// sidebar and the overview.
import { createContext, useContext, type ReactNode } from 'react'

import type { AppSummary } from './api'
import { useApi } from './data'
import { usePrefs } from './session'

type AppsAnswer = {
  apps: AppSummary[]
  /** The server deletes an install that has sent nothing for this many days; null keeps them all (absent before 2026-10). */
  install_retention_days?: number | null
}
type Apps = ReturnType<typeof useApi<AppsAnswer>>
const Ctx = createContext<Apps | null>(null)

export function AppsProvider({ children }: { children: ReactNode }) {
  const { prefs } = usePrefs()
  const apps = useApi<AppsAnswer>(`/admin/apps?days=${prefs.days}&env=${prefs.env}`)
  return <Ctx.Provider value={apps}>{children}</Ctx.Provider>
}

export function useApps() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApps outside AppsProvider')
  return c
}
