export const num = (n: number | null | undefined) => (n == null ? '–' : Number(n).toLocaleString())

export const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')

export function when(iso: string | null | undefined) {
  if (!iso) return 'never'
  const d = new Date(iso)
  const s = (Date.now() - d.getTime()) / 1000
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)} min ago`
  if (s < 172800) return `${Math.round(s / 3600)} h ago`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export const stamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Percent change against the prior period, or null when there was nothing before. */
export const change = (now: number, before: number) => (before ? Math.round(((now - before) / before) * 100) : null)

export const humanize = (s: string) => s.replace(/_/g, ' ')

/** Seconds as "45 s", "3 min 20 s", "1 h 5 min". */
export function duration(s: number | null | undefined) {
  if (s == null) return '–'
  if (s < 60) return `${Math.round(s)} s`
  if (s < 3600) {
    const m = Math.floor(s / 60)
    const rest = Math.round(s % 60)
    return rest ? `${m} min ${rest} s` : `${m} min`
  }
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

/** A country code as its flag (regional indicator letters); nothing for "other"/"unknown". */
export function flag(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return ''
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65))
}

const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(undefined, { type: 'region' }) : null
export function countryName(code: string) {
  if (!/^[A-Z]{2}$/.test(code)) return code === 'other' ? 'Other (under 10 each)' : code
  try {
    return regionNames?.of(code) ?? code
  } catch {
    return code
  }
}
