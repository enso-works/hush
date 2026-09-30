// RevenueCat's numbers as it formats them. The metric list is whatever
// RevenueCat returned, so a metric added upstream shows without a change here.
import type { RevenueMetric, RevenueProject } from './api'

/** Money by metric id too, so a count never gets a currency symbol and the other way round. */
const isMoney = (m: RevenueMetric) => /revenue|mrr|arr|ltv|proceed/i.test(m.id) || m.unit === '$' || /^[A-Z]{3}$/.test(m.unit ?? '')

/** $18, not $18.00; 12.5%; 1,204. */
export function money(n: number, unit: string | undefined, currency: string | null) {
  if (!Number.isFinite(n)) return '–'
  if (unit === '$') {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currency || 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: Math.abs(n) < 1000 ? 2 : 0,
    }).format(n)
  }
  if (unit === '%') return `${n.toFixed(1)}%`
  return new Intl.NumberFormat().format(n)
}

export const metricValue = (m: RevenueMetric, currency: string | null) => money(Number(m.value), isMoney(m) ? '$' : m.unit, currency)

/** ISO 8601 periods as RevenueCat sends them: P0D is a live count, P28D a trailing window. */
export function periodLabel(period?: string) {
  if (!period || period === 'P0D') return 'right now'
  const d = /^P(\d+)D$/.exec(period)
  return d ? `last ${d[1]} days` : period
}

export const findMetric = (p: RevenueProject | undefined, pattern: RegExp) => p?.metrics?.find((m) => pattern.test(m.id)) ?? null

/**
 * How much to trust the numbers. Age counts from when data last landed, not
 * from the last try: a failing key is asked again every few minutes, and
 * counting those tries would dress hour-old money as current.
 */
export function freshness(p: RevenueProject) {
  const ok = p.last_success_at ? Date.parse(p.last_success_at) : null
  const failedLast = ok !== null && p.last_polled_at !== null && Date.parse(p.last_polled_at) - ok > 1000
  const stale = ok !== null && Date.now() - ok > 60 * 60 * 1000
  return { failedLast, stale, never: ok === null }
}
