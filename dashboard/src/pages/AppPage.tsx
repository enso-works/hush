import type { ReactNode } from 'react'
import { MessageSquare, TriangleAlert } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from 'recharts'

import { BarList } from '@/components/BarList'
import { AppMark } from '@/components/Logo'
import { PageHeader, PeriodControls } from '@/components/PageHeader'
import { Stat } from '@/components/Stat'
import { BlurFade } from '@/components/ui/blur-fade'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { AppDetail, Revenue } from '@/lib/api'
import { useApi } from '@/lib/data'
import { countryName, flag, humanize, num, pct, shortDay, when } from '@/lib/format'
import { href } from '@/lib/route'
import { usePrefs } from '@/lib/session'
import { BreakdownBars, ChannelFilter, Engagement, Explore } from '@/pages/AppInsights'
import { ErrorNote } from '@/pages/ErrorNote'

export function Panel({ title, sub, children, className }: { title: string; sub?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`flex min-w-0 flex-col rounded-xl border bg-card p-5 ${className ?? ''}`}>
      <header className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
      </header>
      {children}
    </section>
  )
}

const activity: ChartConfig = {
  active: { label: 'Active installs', color: 'var(--chart-1)' },
  sessions: { label: 'Sessions', color: 'var(--chart-2)' },
  new_installs: { label: 'New installs', color: 'var(--chart-3)' },
}

function Activity({ daily }: { daily: AppDetail['daily'] }) {
  return (
    <ChartContainer config={activity} className="aspect-auto h-64 w-full">
      <AreaChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="fill-active" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-active)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--color-active)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" labelFormatter={(d) => shortDay(String(d))} />} />
        <Area dataKey="active" type="monotone" stroke="var(--color-active)" strokeWidth={2} fill="url(#fill-active)" />
        <Line dataKey="new_installs" type="monotone" stroke="var(--color-new_installs)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
        <Area dataKey="sessions" type="monotone" stroke="none" fill="none" />
      </AreaChart>
    </ChartContainer>
  )
}

function Funnel({ steps }: { steps: AppDetail['funnel'] }) {
  const top = steps[0]?.installs ?? 0
  if (!steps.some((s) => s.installs)) return <p className="py-6 text-center text-sm text-muted-foreground">No paywall events in this period.</p>
  return (
    <ol className="flex flex-col gap-3">
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].installs : 0
        return (
          <li key={s.name}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="truncate first-letter:uppercase">{humanize(s.name)}</span>
              <span className="flex items-baseline gap-2 tabular-nums">
                {i > 0 && <span className="text-xs text-muted-foreground">{pct(s.installs, prev)} of previous</span>}
                <span className="font-medium">{num(s.installs)}</span>
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-brand" style={{ width: `${top ? Math.max(1, (s.installs / top) * 100) : 0}%` }} />
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function Retention({ r }: { r: AppDetail['retention'] }) {
  const rows = [
    ['Day 1', r.d1],
    ['Day 7', r.d7],
    ['Day 30', r.d30],
  ] as const
  return (
    <div className="grid grid-cols-3 gap-3">
      {rows.map(([label, x]) => {
        const p = x.cohort ? x.retained / x.cohort : 0
        return (
          <div key={label} className="flex flex-col items-center gap-2 rounded-lg bg-muted/50 p-3 text-center">
            <div className="relative size-20">
              <svg viewBox="0 0 36 36" className="size-20 -rotate-90" aria-hidden>
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="3.5" className="stroke-muted" />
                {p > 0 && (
                  <circle
                    cx="18"
                    cy="18"
                    r="15.5"
                    fill="none"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    className="stroke-brand"
                    strokeDasharray={`${p * 97.4} 97.4`}
                  />
                )}
              </svg>
              <span className="absolute inset-0 grid place-items-center text-base font-semibold tabular-nums">{x.cohort ? pct(x.retained, x.cohort) : '–'}</span>
            </div>
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {num(x.retained)} of {num(x.cohort)}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function RevenuePanel({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data } = useApi<Revenue>(`/admin/revenue?app=${encodeURIComponent(slug)}&days=${prefs.days}`)
  if (!data?.configured) return null
  const project = data.apps.find((a) => a.app === slug)
  if (!project)
    return (
      <Panel title="Revenue">
        <p className="text-sm text-muted-foreground">No RevenueCat project is linked to this app (see rc:projects and rc:link).</p>
      </Panel>
    )
  const metrics = Object.entries(project.metrics ?? {})
  return (
    <Panel title="Revenue" sub={`RevenueCat · ${project.currency ?? ''} · as of ${when(project.fetched_at)}`}>
      {project.last_error && <p className="mb-3 text-sm text-destructive">Last refresh failed: {project.last_error}</p>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {metrics.map(([k, v]) => (
          <div key={k} className="rounded-lg bg-muted/50 p-3">
            <div className="truncate text-xs text-muted-foreground first-letter:uppercase">{humanize(k)}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {num(typeof v === 'object' && v !== null ? Number((v as { value?: number }).value) : Number(v))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

export function AppPage({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data: d, error, loading } = useApi<AppDetail>(
    `/admin/apps/${encodeURIComponent(slug)}?days=${prefs.days}&env=${prefs.env}${prefs.channel ? `&channel=${encodeURIComponent(prefs.channel)}` : ''}`,
  )
  const name = d?.name ?? slug
  const c = d?.current
  const p = d?.prior

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<AppMark slug={slug} name={name} className="size-10 rounded-xl text-base" />}
        title={name}
        sub={
          d ? (
            <>
              Last event {when(d.lastEvent)} ·{' '}
              <a className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline" href={href.feedback({ status: 'open' })}>
                <MessageSquare className="size-3.5" aria-hidden /> {d.tickets} open
              </a>
            </>
          ) : (
            ' '
          )
        }
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {d?.channels && <ChannelFilter channels={d.channels} />}
            <PeriodControls />
          </div>
        }
      />
      {error && <ErrorNote message={error} />}

      {!d && loading && (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[92px] rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-80 rounded-xl" />
        </div>
      )}

      {d && c && p && (
        <>
          <BlurFade duration={0.3}>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Active installs" value={c.active} before={p.active} />
              <Stat label="New installs" value={c.new_installs} before={p.new_installs} />
              <Stat label="Sessions" value={c.sessions} before={p.sessions} />
              <Stat label="Active today" value={d.todayActive} />
              {d.highlight && <Stat label={humanize(d.highlight.event)} value={c.highlight} before={p.highlight} />}
              {d.highlight?.done_prop && (
                <Stat label="Completion rate" value={c.highlight_done} text={pct(c.highlight_done, c.highlight)} />
              )}
            </div>
          </BlurFade>

          {d.unknown.length > 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-chart-4" aria-hidden />
              <span>
                {d.unknown.length} event name{d.unknown.length === 1 ? ' is' : 's are'} not in this app's catalog:{' '}
                <span className="font-mono text-xs">{d.unknown.map((u) => u.name).join(', ')}</span>. A typo in the app, or a name to add to CATALOG_FILE.
              </span>
            </div>
          )}

          <BlurFade delay={0.05} duration={0.3}>
            <Panel
              title="Activity"
              sub={
                <span className="inline-flex flex-wrap gap-x-4 gap-y-1">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-chart-1" /> Active installs per day
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-3 bg-chart-3" /> New installs
                  </span>
                </span>
              }
            >
              <Activity daily={d.daily} />
            </Panel>
          </BlurFade>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Paywall funnel" sub="Installs reaching each step, this period">
              <Funnel steps={d.funnel} />
            </Panel>
            <Panel title="Retention" sub="Came back at least N days after the first open">
              <Retention r={d.retention} />
            </Panel>
            <Panel title="Versions" sub="Installs seen on each version, this period">
              <BarList rows={d.versions.map((v) => ({ key: v.version, label: <span className="font-mono text-xs">{v.version}</span>, value: v.installs }))} />
            </Panel>
            <Panel title="Countries" sub="All installs; fewer than ten are folded into other">
              <BarList
                empty="No countries: COUNTRY_HEADER is not set, or nothing has arrived yet."
                rows={d.countries.map((x) => ({
                  key: x.country,
                  label: (
                    <>
                      <span aria-hidden>{flag(x.country)}</span>
                      <span className="truncate">{countryName(x.country)}</span>
                    </>
                  ),
                  value: x.installs,
                }))}
              />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            {d.engagement && (
              <Panel title="Engagement" sub="Time in the app per session, and how often installs come back">
                <Engagement e={d.engagement} />
              </Panel>
            )}
            <Panel title="How sessions start" sub="The app's doors: launch, widget, notification, link...">
              <BreakdownBars slug={slug} event="session_started" prop="entry" empty="No sessions in this period." />
            </Panel>
            <Panel title="Campaigns" sub="Sessions opened from a link, by its utm_source">
              <BreakdownBars
                slug={slug}
                event="session_started"
                prop="utm_source"
                taggedOnly
                empty="No tagged links yet. SDK 2 keeps utm_* and ref from a link passed to entry('link', { url })."
              />
            </Panel>
            {d.channels && d.channels.length > 0 && (
              <Panel title="Build channels" sub="Installs seen this period, by where their build came from">
                <BarList rows={d.channels.map((c) => ({ key: c.channel, label: <span className="truncate">{humanize(c.channel)}</span>, value: c.installs }))} />
              </Panel>
            )}
          </div>

          <Panel title="Explore" sub="Any event by any of its props: a paywall variant, a source, a product">
            <Explore slug={slug} events={d.events} />
          </Panel>

          <Panel title="Events" sub="Count this period, and how many installs sent each">
            <BarList
              rows={d.events.map((e) => ({
                key: `${e.name}:${e.known}`,
                label: (
                  <>
                    <span className="truncate font-mono text-xs">{e.name}</span>
                    {!e.known && (
                      <span
                        className="rounded-full bg-chart-4/15 px-1.5 text-[10px] font-semibold tracking-wide text-chart-4 uppercase"
                        title="Not in this app's catalog: a typo, or a name to add to CATALOG_FILE"
                      >
                        unknown
                      </span>
                    )}
                  </>
                ),
                value: e.n,
                extra: <span className="text-xs text-muted-foreground">{num(e.installs)} installs</span>,
              }))}
            />
          </Panel>

          <RevenuePanel slug={slug} />
        </>
      )}
    </div>
  )
}
