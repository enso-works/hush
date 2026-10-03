import type { ReactNode } from 'react'
import { MessageSquare, SlidersHorizontal, TriangleAlert } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from 'recharts'

import { BarList } from '@/components/BarList'
import { AppMark } from '@/components/Logo'
import { PageHeader, PeriodControls } from '@/components/PageHeader'
import { Stat } from '@/components/Stat'
import { BlurFade } from '@/components/ui/blur-fade'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { AppDetail } from '@/lib/api'
import { useApps } from '@/lib/apps'
import { useApi } from '@/lib/data'
import { countryName, flag, humanize, num, pct, plural, shortDay, when } from '@/lib/format'
import { href } from '@/lib/route'
import { usePrefs } from '@/lib/session'
import { BreakdownBars, ChannelFilter, Engagement, Explore } from '@/pages/AppInsights'
import { CatalogFunnels, Cohorts, FunnelBuilder } from '@/pages/Funnels'
import { ErrorNote } from '@/pages/ErrorNote'
import { AttributionPanel } from '@/pages/Attribution'
import { Campaigns } from '@/pages/Campaigns'
import { RevenuePanel } from '@/pages/Revenue'

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

export function AppPage({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data: d, error, loading } = useApi<AppDetail>(
    `/admin/apps/${encodeURIComponent(slug)}?days=${prefs.days}&env=${prefs.env}${prefs.channel ? `&channel=${encodeURIComponent(prefs.channel)}` : ''}`,
  )
  // The server deletes an install that sent nothing for that long, so the
  // country counts are the installs seen in that window. New installs and
  // retention count only the installs first seen inside it (src/admin.mjs):
  // a longer period is cut to it, and has no earlier one to compare with.
  const kept = useApps().data?.install_retention_days ?? null
  const cut = kept !== null && kept < prefs.days ? kept : null
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
              </a>{' '}
              ·{' '}
              <a className="inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline" href={href.config(slug)}>
                <SlidersHorizontal className="size-3.5" aria-hidden /> Remote config
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
              <Stat
                label={cut ? `New installs, last ${cut} days` : 'New installs'}
                value={c.new_installs}
                before={cut ? undefined : p.new_installs}
              />
              <Stat label="Sessions" value={c.sessions} before={p.sessions} />
              <Stat label="Active today" value={d.todayActive} />
              {d.highlight && <Stat label={humanize(d.highlight.event)} value={c.highlight} before={p.highlight} />}
              {d.highlight?.done_prop && (
                <Stat label="Completion rate" value={c.highlight_done} text={pct(c.highlight_done, c.highlight)} />
              )}
            </div>
          </BlurFade>

          {prefs.env === 'prod' && d.lastEvent && Date.now() - Date.parse(d.lastEvent) > 2 * 86400000 && (
            <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <span>
                Nothing has arrived since {when(d.lastEvent)}. A quiet week, or a revoked key, a wrong URL or an SDK that stopped sending: the
                Installs page shows one device's events live.
              </span>
            </div>
          )}

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
                    <span className="h-0.5 w-3 bg-chart-3" /> New installs{cut ? `, last ${cut} days` : ''}
                  </span>
                </span>
              }
            >
              <Activity daily={d.daily} />
            </Panel>
          </BlurFade>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Funnels" sub="Installs through each step in order, and how long each step took">
              <CatalogFunnels slug={slug} />
            </Panel>
            <Panel
              title="Retention"
              sub={`Came back at least N days after the first open${cut ? `; installs first seen in the last ${cut} days` : ''}`}
            >
              <Retention r={d.retention} />
            </Panel>
          </div>

          <Panel title="Cohorts" sub="Each week's new installs, and how many were still around in the weeks after">
            <Cohorts slug={slug} />
          </Panel>

          <Panel title="Campaigns" sub="Tagged links, an ad or a newsletter: who they brought, and how far those installs got">
            <Campaigns slug={slug} />
          </Panel>

          <Panel title="Attribution" sub="New installs from ads and campaign links, as Apple reports them: aggregate, never one install">
            <AttributionPanel slug={slug} />
          </Panel>

          {d.breakdowns.length > 0 && (
            <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {d.breakdowns.map((b) => (
                <Panel
                  key={`${b.event}.${b.prop}`}
                  title={b.title}
                  sub={
                    <>
                      <span className="font-mono">
                        {b.event}.{b.prop}
                      </span>{' '}
                      · {b.count === 'installs' ? 'one per install' : 'every event'}
                    </>
                  }
                >
                  <BreakdownBars slug={slug} event={b.event} prop={b.prop} count={b.count} empty="Nothing in this period." />
                </Panel>
              ))}
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Versions" sub="Installs seen on each version, this period">
              <BarList rows={d.versions.map((v) => ({ key: v.version, label: <span className="font-mono text-xs">{v.version}</span>, value: v.installs }))} />
            </Panel>
            <Panel title="Countries" sub={`${kept ? `Installs seen in ${kept} days` : 'All installs'}; fewer than ten are folded into other`}>
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
            {d.channels && d.channels.length > 0 && (
              <Panel title="Build channels" sub="Installs seen this period, by where their build came from">
                <BarList rows={d.channels.map((c) => ({ key: c.channel, label: <span className="truncate">{humanize(c.channel)}</span>, value: c.installs }))} />
              </Panel>
            )}
          </div>

          <Panel title="Build a funnel" sub="Any events in order, optionally with a prop condition">
            <FunnelBuilder slug={slug} events={d.events} />
          </Panel>

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
                extra: <span className="text-xs text-muted-foreground">{plural(e.installs, 'install')}</span>,
              }))}
            />
          </Panel>

          <RevenuePanel slug={slug} />
        </>
      )}
    </div>
  )
}
