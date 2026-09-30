// The /admin API, as the dashboard reads it. The token lives in
// sessionStorage (gone with the tab, never a cookie, so another site has
// nothing to ride on). Text from users is only ever rendered by React as
// text, never as HTML.

const TOKEN_KEY = 'hush.token'

// Where the API lives: wherever the dashboard is served from, minus
// /dashboard/. Usually the root; `/demo` or `/hush` when a proxy mounts it
// under a prefix.
export const BASE = location.pathname.replace(/\/dashboard(\/.*)?$/, '').replace(/\/$/, '')

export class AuthError extends Error {}

export const token = {
  get: () => sessionStorage.getItem(TOKEN_KEY),
  set: (t: string) => sessionStorage.setItem(TOKEN_KEY, t),
  clear: () => sessionStorage.removeItem(TOKEN_KEY),
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const t = token.get()
  const res = await fetch(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(t ? { Authorization: `Bearer ${t}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  })
  if (res.status === 401) {
    token.clear()
    throw new AuthError()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data as T
}

/** A demo answers /admin reads without a token; a real server says 401. */
export async function detectDemo(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/admin/apps?days=1`)
    return r.ok
  } catch {
    return false
  }
}

export type Env = 'prod' | 'dev'

export type AppSummary = {
  app: string
  name: string
  new_installs: number
  total_installs: number
  dau: number
  wau: number
  mau: number
  sessions: number
  events: number
  open_tickets: number
  last_event: string | null
  /** Active installs per day over the period (added in 2026-09; absent on older servers). */
  trend?: number[]
}

export type Period = { new_installs: number; sessions: number; active: number; highlight: number; highlight_done: number }

export type AppDetail = {
  app: string
  name?: string
  /** The channel this detail is filtered to (added with SDK 2), or null for all. */
  channel?: string | null
  channels?: { channel: string; installs: number }[]
  engagement?: {
    measured: number
    median_s: number | null
    p75_s: number | null
    sessions_per_install: number | null
    /** Installs by sessions this period: 1, 2, 3-5, 6-10, more than 10. */
    sessions_histogram: number[]
  }
  highlight: { event: string; done_prop: string | null } | null
  current: Period
  prior: Period
  retention: Record<'d1' | 'd7' | 'd30', { cohort: number; retained: number }>
  todayActive: number
  daily: { day: string; new_installs: number; active: number; sessions: number }[]
  versions: { version: string; installs: number }[]
  events: { name: string; known: boolean; n: number; installs: number }[]
  funnel: { name: string; installs: number }[]
  countries: { country: string; installs: number }[]
  unknown: { name: string; n: number }[]
  tickets: number
  lastEvent: string | null
}

export type TicketStatus = 'open' | 'answered' | 'closed'
export type TicketKind = 'issue' | 'feature' | 'love'

export type TicketSummary = {
  id: number
  app: string
  kind: TicketKind
  install: string
  rc_id: string | null
  email: string | null
  subject: string | null
  status: TicketStatus
  created_at: string
  updated_at: string
  preview: string
  replies: number
}

export type Ticket = Omit<TicketSummary, 'preview' | 'replies'> & {
  message: string
  diag: Record<string, unknown> | null
  replies: { id: number; author: 'user' | 'support'; body: string; at: string; emailed: boolean }[]
}

export type InstallDetail = {
  id: string
  install: {
    id: string
    app: string
    env: string
    first_seen: string
    last_seen: string
    platform: string | null
    os: string | null
    device: string | null
    locale: string | null
    country: string | null
    version: string | null
    build: string | null
    rc_id: string | null
    pro: boolean
    channel: string | null
    sdk: string | null
  } | null
  events: { id: string; name: string; known: boolean; at: string; received_at: string; session: string | null; version: string | null; channel: string | null; props: Record<string, unknown> }[]
  tickets: { id: number; app: string; kind: TicketKind; subject: string | null; status: TicketStatus; created_at: string }[]
}

export type BreakdownRow = { value: string; n: number; installs: number }

export type Revenue = {
  configured: boolean
  apps: { app: string; name: string; currency: string | null; metrics: Record<string, unknown> | null; fetched_at: string | null; last_error: string | null }[]
  series: { chart: string; chartName: string; measure: string; name: string; unit: string; points: { day: string; value: number }[] }[]
}
