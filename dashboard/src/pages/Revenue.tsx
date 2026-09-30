// Money, from the RevenueCat cache the server keeps. The browser never holds a
// RevenueCat key; the refresh button asks the server to ask RevenueCat again.
import { useState } from 'react'
import { ExternalLink, RefreshCw } from 'lucide-react'
import { Bar, BarChart, XAxis } from 'recharts'

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import type { Revenue, RevenueSeries } from '@/lib/api'
import { useApi } from '@/lib/data'
import { when, shortDay } from '@/lib/format'
import { freshness, metricValue, money, periodLabel } from '@/lib/money'
import { usePrefs } from '@/lib/session'
import { Panel } from '@/pages/AppPage'

const bars: ChartConfig = { value: { label: 'Value', color: 'var(--chart-2)' } }

function SeriesChart({ s, currency, days }: { s: RevenueSeries; currency: string | null; days: number }) {
  const total = s.points.reduce((n, p) => n + p.value, 0)
  const fmt = (n: number) => money(n, s.unit, currency)
  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/50 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-muted-foreground">
          {s.name} · {days}d
        </span>
        {s.unit !== '%' && <span className="text-sm font-semibold tabular-nums">{fmt(total)}</span>}
      </div>
      <ChartContainer config={bars} className="aspect-auto h-24 w-full">
        <BarChart data={s.points} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <XAxis dataKey="day" hide />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideIndicator labelFormatter={(d) => shortDay(String(d))} formatter={(v) => fmt(Number(v))} />}
          />
          <Bar dataKey="value" fill="var(--color-value)" radius={2} />
        </BarChart>
      </ChartContainer>
    </div>
  )
}

export function RevenuePanel({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  // Each press is a new path, so it is fetched even if nothing else changed.
  const [asked, setAsked] = useState(0)
  const { data, loading } = useApi<Revenue>(
    `/admin/revenue?app=${encodeURIComponent(slug)}&days=${prefs.days}${asked ? `&refresh=1&n=${asked}` : ''}`,
  )
  if (!data?.configured) return null
  const project = data.apps.find((a) => a.app === slug)
  if (!project)
    return (
      <Panel title="Revenue">
        <p className="text-sm text-muted-foreground">
          No RevenueCat project is linked to this app. <code className="rounded bg-muted px-1 py-0.5 text-xs">node src/cli.mjs rc:projects</code> lists
          what the key can read, <code className="rounded bg-muted px-1 py-0.5 text-xs">rc:link</code> pins one.
        </p>
      </Panel>
    )

  const f = freshness(project)
  const series = data.series.filter((s) => s.points.length > 0 && s.points.some((p) => p.value !== 0))
  return (
    <Panel
      title="Revenue"
      sub={
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
          <span>RevenueCat's own numbers, the truth for money. Checked {when(project.last_polled_at)}</span>
          {f.failedLast && <span className="text-destructive">· that try failed, these are from {when(project.last_success_at)}</span>}
          {f.stale && !f.failedLast && <span className="text-chart-4">· no answer in over an hour</span>}
          <span>·</span>
          <a
            className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline"
            href={`https://app.revenuecat.com/projects/${project.project_id}/overview`}
            target="_blank"
            rel="noreferrer"
          >
            Open in RevenueCat <ExternalLink className="size-3" aria-hidden />
          </a>
          <button
            type="button"
            disabled={loading}
            onClick={() => setAsked((n) => n + 1)}
            className="inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs text-foreground hover:bg-muted disabled:opacity-60"
          >
            <RefreshCw className={`size-3 ${loading ? 'animate-spin' : ''}`} aria-hidden /> {loading ? 'Asking RevenueCat' : 'Refresh'}
          </button>
        </span>
      }
    >
      {project.last_error && <p className="mb-3 text-sm text-destructive">RevenueCat said: {project.last_error}</p>}
      {(project.metrics ?? []).length === 0 && !project.last_error && <p className="text-sm text-muted-foreground">Linked, waiting for the first answer.</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {(project.metrics ?? []).map((m) => (
          <div key={m.id} className="rounded-lg bg-muted/50 p-3" title={m.description ?? ''}>
            <div className="truncate text-xs text-muted-foreground">{m.name}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">{metricValue(m, project.currency)}</div>
            <div className="text-[11px] text-muted-foreground">{periodLabel(m.period)}</div>
          </div>
        ))}
      </div>
      {series.length > 0 && (
        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {series.map((s) => (
            <SeriesChart key={`${s.chart} ${s.measure}`} s={s} currency={project.currency} days={prefs.days} />
          ))}
        </div>
      )}
      {data.series.length > 0 && series.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">Every chart RevenueCat answered for is flat at zero over these {prefs.days} days.</p>
      )}
    </Panel>
  )
}

/** Every linked app's money for the overview cards, keyed by app. */
export function useRevenueByApp() {
  const { prefs } = usePrefs()
  const { data } = useApi<Revenue>(`/admin/revenue?days=${prefs.days}`)
  return data?.configured ? new Map(data.apps.map((a) => [a.app, a])) : null
}
