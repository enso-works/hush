// The apps list, fetched once per period and environment and shared by the
// sidebar and the overview.
import { createContext, useContext, useMemo, type ReactNode } from 'react'

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

/** Days without an event after which an app counts as inactive: MAU's window, so an inactive app is one with no MAU. */
export const INACTIVE_DAYS = 30

/** No event in this environment for INACTIVE_DAYS, or none ever. */
export function isInactive(a: AppSummary) {
  return !a.last_event || Date.now() - Date.parse(a.last_event) > INACTIVE_DAYS * 86_400_000
}

// Active apps first, then inactive ones, by name within each: the apps in
// use stay where the eye lands, and an abandoned one does not push them down.
function activeFirst(apps: AppSummary[]) {
  return [...apps].sort((a, b) => Number(isInactive(a)) - Number(isInactive(b)) || a.name.localeCompare(b.name))
}

export function AppsProvider({ children }: { children: ReactNode }) {
  const { prefs } = usePrefs()
  const apps = useApi<AppsAnswer>(`/admin/apps?days=${prefs.days}&env=${prefs.env}`)
  const data = useMemo(() => apps.data && { ...apps.data, apps: activeFirst(apps.data.apps) }, [apps.data])
  return <Ctx.Provider value={{ ...apps, data }}>{children}</Ctx.Provider>
}

export function useApps() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useApps outside AppsProvider')
  return c
}
