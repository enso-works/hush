// A website's page (catalog kind "website"): visitors and visits, not installs
// and sessions; where they came from and what they landed on; and how many
// visits reached the site's goal, a store click unless the catalog names
// another. Phones apart from desktops: only a phone installs from a store link.
import type { ReactNode } from 'react'
import { ArrowRight, Globe, TriangleAlert } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, Line, XAxis, YAxis } from 'recharts'

import { BarList } from '@/components/BarList'
import { InactiveBadge } from '@/components/InactiveBadge'
import { AppMark } from '@/components/Logo'
import { PageHeader, PeriodControls } from '@/components/PageHeader'
import { Stat } from '@/components/Stat'
import { BlurFade } from '@/components/ui/blur-fade'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { Skeleton } from '@/components/ui/skeleton'
import type { WebReport, WebSplit, WebsitesForApp } from '@/lib/api'
import { isInactive, useApps } from '@/lib/apps'
import { useApi } from '@/lib/data'
import { countryName, flag, goalName, humanize, num, pct, plural, shortDay, when } from '@/lib/format'
import { href } from '@/lib/route'
import { usePrefs } from '@/lib/session'
import { Panel } from '@/pages/AppPage'
import { ErrorNote } from '@/pages/ErrorNote'

const DEVICE: Record<string, string> = { phone: 'Phone', tablet: 'Tablet', desktop: 'Desktop' }

const chart: ChartConfig = {
  visitors: { label: 'Visitors', color: 'var(--chart-1)' },
  new_visitors: { label: 'New visitors', color: 'var(--chart-3)' },
  goal_visits: { label: 'Reached the goal', color: 'var(--chart-2)' },
}

function Visitors({ daily }: { daily: WebReport['daily'] }) {
  return (
    <ChartContainer config={chart} className="aspect-auto h-64 w-full">
      <AreaChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -12 }}>
        <defs>
          <linearGradient id="fill-visitors" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-visitors)" stopOpacity={0.3} />
            <stop offset="100%" stopColor="var(--color-visitors)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid vertical={false} strokeDasharray="3 3" />
        <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={32} tickFormatter={shortDay} />
        <YAxis tickLine={false} axisLine={false} width={40} allowDecimals={false} />
        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="dot" labelFormatter={(d) => shortDay(String(d))} />} />
        <Area dataKey="visitors" type="monotone" stroke="var(--color-visitors)" strokeWidth={2} fill="url(#fill-visitors)" />
        <Line dataKey="new_visitors" type="monotone" stroke="var(--color-new_visitors)" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
        <Line dataKey="goal_visits" type="monotone" stroke="var(--color-goal_visits)" strokeWidth={1.5} dot={false} />
      </AreaChart>
    </ChartContainer>
  )
}

/**
 * Rows of visits with a bar for their share, how many of them were engaged
 * (more than a glance) and how many reached the goal: the rate is the column
 * that says which source, campaign or page is worth more of.
 */
function SplitTable<T extends WebSplit>({
  rows,
  label,
  head,
  goal,
  empty,
}: {
  rows: T[]
  label: (r: T) => ReactNode
  head: string
  goal: string
  empty: string
}) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>
  const max = Math.max(1, ...rows.map((r) => r.visits))
  const th = 'px-2 py-2 text-right font-medium'
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-2 pl-1 font-medium">{head}</th>
            <th className={th}>Visits</th>
            <th className={th} title="More than a glance: a second page, a click, or ten seconds in view">
              Engaged
            </th>
            <th className={th} title={`Visits with a ${goal}`}>
              {goal.charAt(0).toUpperCase() + goal.slice(1)} rate
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-0">
              <td className="relative py-2 pr-2 pl-1">
                <div aria-hidden className="absolute inset-y-1 left-0 rounded bg-brand/10 dark:bg-brand/15" style={{ width: `${Math.max(2, (r.visits / max) * 100)}%` }} />
                <span className="relative flex min-w-0 items-center gap-2 truncate">{label(r)}</span>
              </td>
              <td className="px-2 py-2 text-right tabular-nums">{num(r.visits)}</td>
              <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{pct(r.engaged, r.visits)}</td>
              <td className="px-2 py-2 text-right font-medium tabular-nums">
                {pct(r.goal_visits, r.visits)}
                <span className="ml-1.5 text-xs font-normal text-muted-foreground">{num(r.goal_visits)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const code = (s: string) => <span className="truncate font-mono text-xs">{s}</span>

export function WebsitePage({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data: d, error, loading } = useApi<WebReport>(
    `/admin/apps/${encodeURIComponent(slug)}/web?days=${prefs.days}&env=${prefs.env}${prefs.channel ? `&channel=${encodeURIComponent(prefs.channel)}` : ''}`,
  )
  const apps = useApps().data?.apps ?? []
  const summary = apps.find((a) => a.app === slug)
  const name = summary?.name ?? slug
  const sells = (summary?.promotes ?? []).map((s) => apps.find((a) => a.app === s) ?? { app: s, name: s })
  const c = d?.current
  const p = d?.prior
  const goal = d ? goalName(d.goal.event) : 'store click'

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<AppMark slug={slug} name={name} website className="size-10 text-base" />}
        title={
          <>
            {name}
            {summary && isInactive(summary) && <InactiveBadge className="ml-2" />}
          </>
        }
        sub={
          <span className="inline-flex flex-wrap items-center gap-x-1.5">
            <Globe className="size-3.5" aria-hidden /> Website
            {sells.length > 0 && (
              <>
                {' · sells '}
                {sells.map((a, i) => (
                  <span key={a.app}>
                    {i > 0 && ', '}
                    <a className="text-foreground underline-offset-2 hover:underline" href={href.app(a.app)}>
                      {a.name}
                    </a>
                  </span>
                ))}
              </>
            )}
            {summary && <> · Last visit {when(summary.last_event)}</>}
          </span>
        }
        actions={<PeriodControls />}
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
              <Stat label="Visitors" value={c.visitors} before={p.visitors} />
              <Stat label="New visitors" value={c.new_visitors} before={p.new_visitors} />
              <Stat label="Visits" value={c.visits} before={p.visits} />
              <Stat label="Engaged visits" value={c.engaged} text={pct(c.engaged, c.visits)} hint={`${num(c.engaged)} of ${num(c.visits)}`} />
              <Stat label={`Visits with a ${goal}`} value={c.goal_visits} before={p.goal_visits} />
              <Stat label={`${goal} rate`} value={c.goal_visits} text={pct(c.goal_visits, c.visits)} hint={`${plural(c.goal_visitors, 'visitor')}`} />
            </div>
          </BlurFade>

          {prefs.env === 'prod' && c.visits === 0 && (
            <div className="flex items-start gap-2 rounded-lg border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-chart-4" aria-hidden />
              <span>
                No visits in this period. The site needs the <span className="font-mono text-xs">/hush.js</span> tag (or SDK 2.5 with{' '}
                <span className="font-mono text-xs">autoTrack</span>) with this site's write key; a headless browser or a crawler is never counted.
              </span>
            </div>
          )}

          <BlurFade delay={0.05} duration={0.3}>
            <Panel
              title="Visitors"
              sub={
                <span className="inline-flex flex-wrap gap-x-4 gap-y-1">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-chart-1" /> Visitors per day
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-3 bg-chart-3" /> New visitors
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-0.5 w-3 bg-chart-2" /> Visits with a {goal}
                  </span>
                </span>
              }
            >
              <Visitors daily={d.daily} />
            </Panel>
          </BlurFade>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Sources" sub="A link's utm_source, else the site that sent the visit, else direct">
              <SplitTable
                rows={d.sources}
                head="Source"
                goal={goal}
                empty="No visits in this period."
                label={(r) => (
                  <>
                    {r.kind === 'referrer' ? code(r.source) : <span className="truncate">{r.source === 'direct' ? 'Direct' : humanize(r.source)}</span>}
                    {r.kind === 'tag' && <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">tagged</span>}
                  </>
                )}
              />
            </Panel>
            <Panel title="Campaigns" sub="Tagged links (utm_campaign): an ad, a newsletter, a post">
              <SplitTable
                rows={d.campaigns}
                head="Campaign"
                goal={goal}
                empty="No tagged visits in this period. Add utm_source and utm_campaign to the links you share."
                label={(r) => (
                  <>
                    <span className="truncate">{humanize(r.campaign)}</span>
                    <span className="truncate text-xs text-muted-foreground">{humanize(r.source)}</span>
                  </>
                )}
              />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Landing pages" sub="The page each visit began on">
              <SplitTable rows={d.landing} head="Page" goal={goal} empty="No pages in this period." label={(r) => code(r.page)} />
            </Panel>
            <Panel title="Devices" sub={`A store link leads to an app only on a phone or tablet: compare the ${goal} rate there`}>
              <SplitTable rows={d.devices} head="Device" goal={goal} empty="No visits in this period." label={(r) => <span>{DEVICE[r.device] ?? r.device}</span>} />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Pages" sub="Views this period, and how many visitors saw each">
              <BarList
                empty="No pages in this period."
                rows={d.pages.map((x) => ({ key: x.page, label: code(x.page), value: x.views, extra: <span className="text-xs text-muted-foreground">{plural(x.visitors, 'visitor')}</span> }))}
              />
            </Panel>
            <Panel title="Countries" sub="Visitors this period; fewer than ten are folded into other">
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
                  value: x.visitors,
                }))}
              />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Panel title="Store clicks" sub="Links to the App Store, Google Play and TestFlight">
              <BarList
                empty="No store clicks in this period."
                rows={d.stores.map((x) => ({ key: x.value, label: <span className="truncate">{humanize(x.value)}</span>, value: x.clicks }))}
              />
            </Panel>
            <Panel title="Links out" sub="Clicks to other sites, by host">
              <BarList empty="No links out in this period." rows={d.links.map((x) => ({ key: x.value, label: code(x.value), value: x.clicks }))} />
            </Panel>
            <Panel title="The site's events" sub="What the page tracks itself, beyond pages and clicks">
              <BarList
                empty="None: the site sends only what the tag tracks by itself."
                rows={d.events.map((e) => ({
                  key: e.name,
                  label: (
                    <>
                      {code(e.name)}
                      {!e.known && (
                        <span className="rounded-full bg-chart-4/15 px-1.5 text-[10px] font-semibold tracking-wide text-chart-4 uppercase" title="Not in this site's catalog">
                          unknown
                        </span>
                      )}
                    </>
                  ),
                  value: e.n,
                }))}
              />
            </Panel>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * On an app's page: the websites that sell it, and their App Store clicks by
 * campaign beside what App Store Connect counted for the same campaign. Two
 * counts side by side, never the same people: a click is not an install.
 */
export function FromWebsites({ slug }: { slug: string }) {
  const { prefs } = usePrefs()
  const { data, error } = useApi<WebsitesForApp>(`/admin/apps/${encodeURIComponent(slug)}/websites?days=${prefs.days}&env=${prefs.env}`)
  if (error) return <ErrorNote message={error} />
  if (!data) return <Skeleton className="h-40 rounded-lg" />
  const th = 'px-2 py-2 text-right font-medium'
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {data.websites.map((w) => (
          <a
            key={w.app}
            href={href.app(w.app)}
            className="group flex items-center gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <AppMark slug={w.app} name={w.name} website className="size-8 text-sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{w.name}</div>
              <div className="text-xs text-muted-foreground tabular-nums">
                {plural(w.visitors, 'visitor')} · {num(w.store_clicks)} store clicks · {pct(w.store_visits, w.visits)} of visits
              </div>
            </div>
            <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
          </a>
        ))}
      </div>
      {data.campaigns.length > 0 && (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="py-2 pr-2 pl-1 font-medium">Campaign</th>
                <th className={th} title="App Store clicks on the websites, carrying this campaign as ct">
                  Store clicks
                </th>
                <th className={th} title="App Store Connect: product page views for ct">
                  Page views
                </th>
                <th className={th} title="App Store Connect: first-time downloads for ct">
                  First downloads
                </th>
              </tr>
            </thead>
            <tbody>
              {data.campaigns.map((c) => (
                <tr key={c.campaign} className="border-b last:border-0">
                  <td className="py-2 pr-2 pl-1">
                    {c.campaign ? <span className="font-mono text-xs">{c.campaign}</span> : <span className="text-muted-foreground italic">no campaign</span>}
                  </td>
                  <td className="px-2 py-2 text-right tabular-nums">{num(c.store_clicks)}</td>
                  <td className="px-2 py-2 text-right text-muted-foreground tabular-nums">{num(c.app_store?.page_views)}</td>
                  <td className="px-2 py-2 text-right font-medium tabular-nums">{num(c.app_store?.first_downloads)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            The store link carries the visit's campaign as <span className="font-mono">ct</span> (with the site's provider token), so App Store Connect counts
            the same campaign. Apple's numbers are its own: users who share analytics, under five hidden.
          </p>
        </div>
      )}
    </div>
  )
}
