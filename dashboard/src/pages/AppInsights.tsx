// The parts of the app page that SDK 2 feeds: session engagement, how
// sessions start and which campaigns bring people, build channels, and a
// breakdown of any event by any of its props.
import { useEffect, useState } from 'react'

import { BarList } from '@/components/BarList'
import { Segmented } from '@/components/Segmented'
import type { AppDetail, BreakdownRow } from '@/lib/api'
import { useApi } from '@/lib/data'
import { duration, humanize, num, plural } from '@/lib/format'
import { usePrefs } from '@/lib/session'
import { cn } from '@/lib/utils'

const qs = (o: Record<string, string | number | null | undefined>) =>
  Object.entries(o)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&')

export function useBreakdown(slug: string, event: string | null, prop: string | null) {
  const { prefs } = usePrefs()
  const path =
    event && prop
      ? `/admin/apps/${encodeURIComponent(slug)}/breakdown?${qs({ event, prop, days: prefs.days, env: prefs.env, channel: prefs.channel })}`
      : null
  return useApi<{ rows: BreakdownRow[] }>(path)
}

/** Filter the whole page to one build channel; shown when an app has more than one. */
export function ChannelFilter({ channels }: { channels: { channel: string; installs: number }[] }) {
  const { prefs, setPrefs } = usePrefs()
  if (channels.length < 2 && !prefs.channel) return null
  return (
    <Segmented
      label="Build channel"
      value={prefs.channel ?? 'all'}
      onChange={(c) => setPrefs({ channel: c === 'all' ? null : c })}
      options={[{ value: 'all', label: 'All channels' }, ...channels.map((c) => ({ value: c.channel, label: humanize(c.channel) }))]}
    />
  )
}

const BUCKETS = ['1', '2', '3–5', '6–10', '11+']

export function Engagement({ e }: { e: NonNullable<AppDetail['engagement']> }) {
  const hist = e.sessions_histogram ?? []
  const max = Math.max(1, ...hist)
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-3 gap-3">
        {(
          [
            ['Median session', e.measured ? duration(e.median_s) : '–'],
            ['Longer sessions (p75)', e.measured ? duration(e.p75_s) : '–'],
            ['Sessions per install', e.sessions_per_install != null ? String(e.sessions_per_install) : '–'],
          ] as const
        ).map(([k, v]) => (
          <div key={k} className="rounded-lg bg-muted/50 p-3">
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="mt-1 text-lg font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-2 text-xs text-muted-foreground">Installs by sessions this period</div>
        <div className="flex h-28 items-end gap-2">
          {hist.map((n, i) => (
            <div key={BUCKETS[i]} className="flex flex-1 flex-col items-center gap-1">
              <span className="text-xs tabular-nums text-muted-foreground">{num(n)}</span>
              <div className="w-full rounded-t-md bg-brand/80" style={{ height: `${Math.max(2, (n / max) * 72)}px` }} />
              <span className="text-xs text-muted-foreground">{BUCKETS[i]}</span>
            </div>
          ))}
        </div>
      </div>
      {!e.measured && (
        <p className="text-xs text-muted-foreground">Session length arrives with SDK 2, which reports each session's time in the foreground.</p>
      )}
    </div>
  )
}

/** One event sliced by one prop, as bars. */
export function BreakdownBars({
  slug,
  event,
  prop,
  empty,
  taggedOnly,
  count = 'events',
}: {
  slug: string
  event: string
  prop: string
  empty: string
  taggedOnly?: boolean
  /** installs: one vote per install, for an answer that can change later. */
  count?: 'events' | 'installs'
}) {
  const { data } = useBreakdown(slug, event, prop)
  // taggedOnly: leave out the events without the prop (untagged sessions, say).
  const rows = (data?.rows ?? []).filter((r) => !taggedOnly || r.value !== 'unset')
  if (data && rows.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  return (
    <BarList
      rows={rows.map((r) => ({
        key: r.value,
        label: <span className={cn('truncate', r.value === 'unset' && 'text-muted-foreground italic')}>{r.value === 'unset' ? 'none' : humanize(r.value)}</span>,
        value: count === 'installs' ? r.installs : r.n,
        extra: <span className="text-xs text-muted-foreground">{count === 'installs' ? plural(r.n, 'event') : plural(r.installs, 'install')}</span>,
      }))}
    />
  )
}

const selectClass =
  'h-8 min-w-0 rounded-md border bg-card px-2 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

/** Any event by any of its props: variants, sources, products. */
export function Explore({ slug, events }: { slug: string; events: AppDetail['events'] }) {
  const { prefs } = usePrefs()
  const names = events.map((e) => e.name)
  const [event, setEvent] = useState<string>(() => (names.includes('paywall_viewed') ? 'paywall_viewed' : (names[0] ?? '')))
  const keys = useApi<{ keys: { key: string; n: number }[] }>(
    event ? `/admin/apps/${encodeURIComponent(slug)}/props?${qs({ event, days: prefs.days, env: prefs.env })}` : null,
  )
  const [prop, setProp] = useState<string>('')
  const available = keys.data?.keys ?? []
  useEffect(() => {
    if (available.length && !available.some((k) => k.key === prop)) setProp(available[0].key)
    if (keys.data && !available.length) setProp('')
  }, [available, prop, keys.data])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Event</span>
          <select className={cn(selectClass, 'font-mono text-xs')} value={event} onChange={(e) => setEvent(e.target.value)}>
            {names.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">by</span>
          <select className={cn(selectClass, 'font-mono text-xs')} value={prop} onChange={(e) => setProp(e.target.value)} disabled={!available.length}>
            {available.length === 0 && <option value="">no props</option>}
            {available.map((k) => (
              <option key={k.key} value={k.key}>
                {k.key}
              </option>
            ))}
          </select>
        </label>
      </div>
      {event && prop ? (
        <BreakdownBars slug={slug} event={event} prop={prop} empty="Nothing in this period." />
      ) : (
        <p className="py-6 text-center text-sm text-muted-foreground">{keys.data ? 'This event carries no props.' : ' '}</p>
      )}
    </div>
  )
}
