// Funnels (ordered, from the catalog or built here) and weekly cohorts.
import { useState } from 'react'
import { Plus, X } from 'lucide-react'

import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import type { AppDetail, Cohort, Funnel, FunnelStep } from '@/lib/api'
import { useApi } from '@/lib/data'
import { duration, num, pct, shortDay } from '@/lib/format'
import { usePrefs } from '@/lib/session'
import { cn } from '@/lib/utils'

const scope = (prefs: { days: number; env: string; channel: string | null }) =>
  `days=${prefs.days}&env=${prefs.env}${prefs.channel ? `&channel=${encodeURIComponent(prefs.channel)}` : ''}`

/** Steps as bars against the first, with the share kept from the step before and the time it took. */
export function FunnelSteps({ steps }: { steps: FunnelStep[] }) {
  const top = steps[0]?.installs ?? 0
  if (!top) return <p className="py-6 text-center text-sm text-muted-foreground">Nobody reached the first step in this period.</p>
  const last = steps[steps.length - 1]
  return (
    <div className="flex flex-col gap-4">
      <ol className="flex flex-col gap-3">
        {steps.map((s, i) => {
          const prev = i ? steps[i - 1].installs : 0
          return (
            <li key={`${s.event}-${i}`}>
              <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="truncate">{s.label}</span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  {i > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {pct(s.installs, prev)} of previous{s.median_s != null && ` · ${duration(s.median_s)}`}
                    </span>
                  )}
                  <span className="font-medium">{num(s.installs)}</span>
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(1, (s.installs / top) * 100)}%` }} />
              </div>
            </li>
          )
        })}
      </ol>
      <p className="text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{pct(last.installs, top)}</span> made it from the first step to the last.
      </p>
    </div>
  )
}

/** The catalog's funnels (or the default paywall one), one at a time. */
export function CatalogFunnels({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data } = useApi<{ funnels: Funnel[] }>(`/admin/apps/${encodeURIComponent(slug)}/funnels?${scope(prefs)}`)
  const [picked, setPicked] = useState(0)
  const funnels = data?.funnels ?? []
  const f = funnels[Math.min(picked, funnels.length - 1)]
  if (!data) return <div className="h-40" />
  if (!f) return <p className="py-6 text-center text-sm text-muted-foreground">No funnels.</p>
  return (
    <div className="flex flex-col gap-4">
      {funnels.length > 1 && (
        <Segmented label="Funnel" value={Math.min(picked, funnels.length - 1)} onChange={setPicked} options={funnels.map((x, i) => ({ value: i, label: x.name }))} className="self-start" />
      )}
      <FunnelSteps steps={f.steps} />
      <p className="text-xs text-muted-foreground">Each step within {f.window_days} day{f.window_days === 1 ? '' : 's'} of the first, in order.</p>
    </div>
  )
}

const selectClass =
  'h-8 min-w-0 rounded-md border bg-card px-2 font-mono text-xs text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

type Draft = { event: string; where: string }

/** Pick events in order (and optionally prop=value), see the funnel at once. */
export function FunnelBuilder({ slug, events }: { slug: string; events: AppDetail['events'] }) {
  const { prefs } = usePrefs()
  const names = events.map((e) => e.name)
  const initial = (['app_first_opened', 'paywall_viewed'].filter((n) => names.includes(n)) as string[]).concat(names).slice(0, 2)
  const [steps, setSteps] = useState<Draft[]>(() => initial.map((event) => ({ event, where: '' })))
  const [windowDays, setWindowDays] = useState(7)
  const valid = steps.filter((s) => s.event && (!s.where || /^[a-z][a-z0-9_]*=.+$/.test(s.where)))
  const query = valid.map((s) => `step=${encodeURIComponent(s.where ? `${s.event}:${s.where}` : s.event)}`).join('&')
  const { data, error } = useApi<{ steps: FunnelStep[] }>(
    valid.length >= 2 ? `/admin/apps/${encodeURIComponent(slug)}/funnel?${query}&window=${windowDays}&${scope(prefs)}` : null,
  )
  const update = (i: number, patch: Partial<Draft>) => setSteps((all) => all.map((s, j) => (j === i ? { ...s, ...patch } : s)))

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
            <select aria-label={`Step ${i + 1} event`} className={cn(selectClass, 'flex-1')} value={s.event} onChange={(e) => update(i, { event: e.target.value })}>
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              aria-label={`Step ${i + 1} condition`}
              placeholder="prop=value"
              value={s.where}
              onChange={(e) => update(i, { where: e.target.value.trim() })}
              className={cn(selectClass, 'w-32', s.where && !/^[a-z][a-z0-9_]*=.+$/.test(s.where) && 'border-destructive')}
              spellCheck={false}
            />
            <button
              type="button"
              aria-label={`Remove step ${i + 1}`}
              disabled={steps.length <= 2}
              onClick={() => setSteps((all) => all.filter((_, j) => j !== i))}
              className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-muted disabled:opacity-30"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="mt-1 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={steps.length >= 8} onClick={() => setSteps((all) => [...all, { event: names[0] ?? '', where: '' }])}>
            <Plus className="size-3.5" /> Add step
          </Button>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            within
            <select className={cn(selectClass, 'font-sans')} value={windowDays} onChange={(e) => setWindowDays(Number(e.target.value))}>
              {[1, 3, 7, 14, 30].map((d) => (
                <option key={d} value={d}>
                  {d} day{d === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Save one for good in the catalog's <code className="rounded bg-muted px-1">funnels</code> to see it above without building it again.
        </p>
      </div>
      <div>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : data ? (
          <FunnelSteps steps={data.steps} />
        ) : (
          <p className="py-6 text-center text-sm text-muted-foreground">Pick at least two steps.</p>
        )}
      </div>
    </div>
  )
}

/** Weekly cohorts as a heatmap: the share of each week's installs still active k weeks later. */
export function Cohorts({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data } = useApi<{ weeks: number; cohorts: Cohort[] }>(
    `/admin/apps/${encodeURIComponent(slug)}/cohorts?weeks=8&env=${prefs.env}${prefs.channel ? `&channel=${encodeURIComponent(prefs.channel)}` : ''}`,
  )
  if (!data) return <div className="h-64" />
  if (!data.cohorts.length) return <p className="py-6 text-center text-sm text-muted-foreground">No installs in the last {data.weeks} weeks.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-separate border-spacing-1 text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="px-2 py-1 text-left font-medium">First week</th>
            <th className="px-2 py-1 text-right font-medium">Installs</th>
            {Array.from({ length: data.weeks }, (_, k) => (
              <th key={k} className="px-1 py-1 text-center font-medium">
                {k === 0 ? 'Week 0' : `+${k}`}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.cohorts.map((c) => (
            <tr key={c.week}>
              <td className="px-2 py-1 whitespace-nowrap">{shortDay(c.week)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{num(c.installs)}</td>
              {c.active.map((n, k) => {
                if (n == null) return <td key={k} />
                const share = c.installs ? n / c.installs : 0
                return (
                  <td
                    key={k}
                    title={`${num(n)} of ${num(c.installs)} active in week ${k}`}
                    className={cn('min-w-12 rounded-md px-1 py-1.5 text-center tabular-nums', share > 0.45 ? 'text-brand-foreground' : 'text-foreground')}
                    style={{ background: `color-mix(in oklch, var(--brand) ${Math.round(8 + share * 92)}%, var(--muted))` }}
                  >
                    {Math.round(share * 100)}%
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-muted-foreground">Weeks run Monday to Sunday (UTC). A cell is the share of that week's new installs that sent anything k weeks later.</p>
    </div>
  )
}
