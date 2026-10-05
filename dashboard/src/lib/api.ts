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

/** A non-2xx answer: its status and body, for callers that read more than `error` (a 400's path, a 409's current version). */
export class ApiError extends Error {
  status: number
  data: Record<string, unknown>
  constructor(status: number, data: Record<string, unknown>) {
    super(typeof data.error === 'string' ? data.error : `HTTP ${status}`)
    this.status = status
    this.data = data
  }
}

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
      // Every write is JSON, even an empty one: the server refuses anything
      // else, so another site cannot post a form to it.
      ...(init.method && init.method !== 'GET' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.method && init.method !== 'GET' ? JSON.stringify(init.body ?? {}) : undefined,
  })
  if (res.status === 401) {
    token.clear()
    throw new AuthError()
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data)
  return data as T
}

/**
 * How this dashboard is signed in, asked once before the first render:
 * `token` when the server wants one (the sign-in page), `demo` for the
 * read-only showcase, `proxy` when a proxy in front adds the token itself.
 */
export type Access = 'token' | 'demo' | 'proxy'
export async function detectAccess(): Promise<Access> {
  try {
    const r = await fetch(`${BASE}/admin/session`)
    if (!r.ok) return 'token'
    const { demo } = (await r.json()) as { demo?: boolean }
    return demo ? 'demo' : 'proxy'
  } catch {
    return 'token'
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
  /** Installs Apple attributed to an ad this period (verified postbacks). */
  ad_installs: number
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
  /** Charts the catalog pins to this app's page. */
  breakdowns: { event: string; prop: string; title: string; count: 'events' | 'installs' }[]
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
  /** Null for a ticket with an email: it is not linked to an install, and neither is a customer id. */
  install: string | null
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

/** A phone signed in with a token of its own (src/devices.mjs). */
export type Device = { id: string; name: string; created_at: string; last_seen_at: string | null }
/** A single-use code for the QR code that pairs a phone. */
export type Pairing = { code: string; expires_at: string }

export type BreakdownRow = { value: string; n: number; installs: number }

export type FunnelStep = { event: string; where: Record<string, string> | null; label: string; installs: number; median_s: number | null }
export type Funnel = { name: string; window_days: number; steps: FunnelStep[] }
/** Installs by first week; active[k]: how many sent anything k weeks later (null: not yet). */
export type Cohort = { week: string; installs: number; active: (number | null)[] }

/** One RevenueCat overview number; `unit` is RevenueCat's own ("$", "#", "%"), `period` ISO 8601 (P0D is right now). */
export type RevenueMetric = { id: string; name: string; description?: string; unit?: string; period?: string; value: number }
export type RevenueProject = {
  app: string
  name: string | null
  project_id: string
  last_polled_at: string | null
  /** When data last landed; older than last_polled_at means the last try failed. */
  last_success_at: string | null
  last_error: string | null
  currency: string | null
  metrics: RevenueMetric[] | null
  fetched_at: string | null
}
export type RevenueSeries = { chart: string; chartName: string; measure: string; name: string; unit: string; points: { day: string; value: number }[] }
export type Revenue = { configured: boolean; apps: RevenueProject[]; series: RevenueSeries[] }

// Remote config (/admin/apps/:app/config). Keys live in the catalog; the
// dashboard overrides a key's default, its rules or both.
export type ConfigType = 'bool' | 'number' | 'string' | 'json'
export type ConfigWhen = { platform?: string[]; version?: string; channel?: string[]; language?: string[]; pro?: boolean }
export type ConfigRule = { when: ConfigWhen; rollout: number; value: unknown; note?: string }
/** A stored override: `default` only when the default is overridden, `rules` only when the rules are. */
export type ConfigOverride = { default?: unknown; rules?: ConfigRule[]; note: string | null; updated_at: string }
export type ConfigKeyView = {
  key: string
  type: ConfigType
  description: string
  catalog: { default: unknown; rules: ConfigRule[] }
  override: ConfigOverride | null
  /** What /v1/config serves for the key. */
  effective: { default: unknown; rules: ConfigRule[] }
  source: { default: 'catalog' | 'override'; rules: 'catalog' | 'override' }
  /** Why a stored override is not served, or null. */
  problem: string | null
  /** False only when the stored override does not validate against the key's current type. */
  fits: boolean
  /** The latest change id for the key, 0 for none: what a write names as its base. */
  change: number
}
export type ConfigLimits = { keys: number; rules: number; string_chars: number; json_bytes: number; total_bytes: number; note_chars: number }
export type ConfigAnswer = {
  app: string
  revision: string
  size_bytes: number
  limits: ConfigLimits
  keys: ConfigKeyView[]
  /** Overrides for keys the catalog no longer has. Never served. */
  orphans: { key: string; override: ConfigOverride; change: number }[]
}
type ConfigParts = { default?: unknown; rules?: ConfigRule[] }
export type ConfigChange = {
  id: number
  key: string
  at: string
  action: 'set' | 'revert'
  override_before: ConfigParts | null
  override_after: ConfigParts | null
  effective_before: { default: unknown; rules: ConfigRule[] } | null
  effective_after: { default: unknown; rules: ConfigRule[] } | null
  note: string | null
}
export type ConfigHistory = { changes: ConfigChange[]; more: boolean }
export type ConfigOutcome = { rule: number; value?: unknown; share: number }
export type ConfigPreview = {
  install: string | null
  context: { platform: string | null; version: string | null; channel: string | null; language: string | null; pro: boolean | null }
  from_install: string[]
  warnings: string[]
  keys: { key: string; type: ConfigType; draft: boolean; outcomes: ConfigOutcome[]; value?: unknown; rule?: number; bucket?: number }[]
}
