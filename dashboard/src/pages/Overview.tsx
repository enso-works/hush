import { ArrowRight, MessageSquare } from 'lucide-react'

import { InactiveBadge } from '@/components/InactiveBadge'
import { AppMark } from '@/components/Logo'
import { PageHeader, PeriodControls } from '@/components/PageHeader'
import { Sparkline } from '@/components/Sparkline'
import { Stat } from '@/components/Stat'
import { BlurFade } from '@/components/ui/blur-fade'
import { MagicCard } from '@/components/ui/magic-card'
import { Skeleton } from '@/components/ui/skeleton'
import { isWebsite, type AppSummary } from '@/lib/api'
import { INACTIVE_DAYS, isInactive, useApps } from '@/lib/apps'
import { goalName, num, pct, when } from '@/lib/format'
import { href } from '@/lib/route'
import { usePrefs } from '@/lib/session'
import { findMetric, metricValue } from '@/lib/money'
import { ErrorNote } from '@/pages/ErrorNote'
import { useRevenueByApp } from '@/pages/Revenue'

export function Overview() {
  const { data, error, loading } = useApps()
  const { prefs } = usePrefs()
  const all = data?.apps ?? []
  // Websites apart from apps: their installs are visitors, and never count
  // towards an app's totals.
  const apps = all.filter((a) => !isWebsite(a))
  const sites = all.filter(isWebsite)
  const active = apps.filter((a) => !isInactive(a))
  const activeSites = sites.filter((a) => !isInactive(a))
  const inactive = all.filter(isInactive)
  const money = useRevenueByApp()
  // Installs that sent nothing for that long are deleted, so the total is
  // the installs seen in that window, not every install there ever was, and
  // new installs are counted inside that window only (src/admin.mjs).
  const kept = data?.install_retention_days ?? null
  const newDays = kept ? Math.min(prefs.days, kept) : prefs.days
  const sum = (k: 'total_installs' | 'new_installs' | 'dau' | 'sessions' | 'open_tickets', list = apps) => list.reduce((n, a) => n + a[k], 0)
  const nameOf = (slug: string) => all.find((a) => a.app === slug)?.name ?? slug

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Overview"
        sub={
          data
            ? [
                `${apps.length} app${apps.length === 1 ? '' : 's'}`,
                sites.length ? `${sites.length} website${sites.length === 1 ? '' : 's'}` : null,
                inactive.length ? `${inactive.length} inactive` : null,
                prefs.env,
                `last ${prefs.days} days`,
              ]
                .filter(Boolean)
                .join(' · ')
            : ' '
        }
        actions={<PeriodControls />}
      />
      {error && <ErrorNote message={error} />}

      {!data && loading ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-xl" />
          ))}
        </div>
      ) : (
        apps.length > 0 && (
          <BlurFade delay={0.02} duration={0.3}>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label={kept ? `Installs seen in ${kept} days` : 'Installs, all time'} value={sum('total_installs')} />
              <Stat label={`New in ${newDays} days`} value={sum('new_installs')} />
              <Stat label="Active in the last day" value={sum('dau')} />
              <Stat label="Open feedback" value={sum('open_tickets', all)} />
            </div>
          </BlurFade>
        )
      )}

      {data && apps.length === 0 && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <h2 className="font-semibold">No apps yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Register one with <code className="rounded bg-muted px-1 py-0.5 text-xs">APPS=myapp=My App</code> or{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">node src/cli.mjs apps:add myapp "My App"</code>, then mint a write key with{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">keys:create</code>.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {!data && loading && Array.from({ length: 3 }, (_, i) => <Skeleton key={i} className="h-64 rounded-2xl" />)}
        {active.map((a, i) => (
          <BlurFade key={a.app} delay={0.05 + i * 0.05} duration={0.35}>
            <AppCard app={a} days={prefs.days} revenue={money?.get(a.app)} />
          </BlurFade>
        ))}
      </div>

      {activeSites.length > 0 && (
        <section aria-labelledby="websites" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2 id="websites" className="text-sm font-semibold">
                Websites
              </h2>
              <p className="text-xs text-muted-foreground">Visitors and visits, counted apart from the apps: a visitor is a browser, not an install.</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Visitors in the last day" value={sum('dau', sites)} />
            <Stat label={`New visitors in ${newDays} days`} value={sum('new_installs', sites)} />
            <Stat label={`Visits in ${prefs.days} days`} value={sum('sessions', sites)} />
            <Stat label="Visits that reached the goal" value={sites.reduce((n, a) => n + (a.goal?.visits ?? 0), 0)} />
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {activeSites.map((a, i) => (
              <BlurFade key={a.app} delay={0.05 + (active.length + i) * 0.05} duration={0.35}>
                <WebsiteCard site={a} days={prefs.days} sells={(a.promotes ?? []).map(nameOf)} />
              </BlurFade>
            ))}
          </div>
        </section>
      )}

      {inactive.length > 0 && (
        <section aria-labelledby="inactive-apps" className="flex flex-col gap-3">
          <div>
            <h2 id="inactive-apps" className="text-sm font-semibold">
              Inactive
            </h2>
            <p className="text-xs text-muted-foreground">
              No events in {prefs.env} for {INACTIVE_DAYS} days. They come back up with their next event.
            </p>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {inactive.map((a, i) => (
              <BlurFade key={a.app} delay={0.05 + (active.length + i) * 0.05} duration={0.35}>
                <InactiveCard app={a} />
              </BlurFade>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function AppCard({ app: a, days, revenue }: { app: AppSummary; days: number; revenue: Parameters<typeof findMetric>[0] }) {
  return (
    <a href={href.app(a.app)} className="group block rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <MagicCard
        className="rounded-2xl"
        gradientSize={260}
        gradientColor="color-mix(in oklch, var(--brand) 9%, transparent)"
        gradientOpacity={1}
        gradientFrom="var(--brand)"
        gradientTo="var(--chart-2)"
      >
        <div className="flex flex-col gap-4 p-5">
          <div className="flex items-center gap-3">
            <AppMark slug={a.app} name={a.name} className="size-9 rounded-lg text-sm" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-semibold">{a.name}</div>
              <div className="text-xs text-muted-foreground">Last event {when(a.last_event)}</div>
            </div>
            {a.open_tickets > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
                <MessageSquare className="size-3" aria-hidden /> {a.open_tickets}
              </span>
            )}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">Active installs per day</span>
              <span className="text-xs text-muted-foreground tabular-nums">{days}d</span>
            </div>
            {a.trend && a.trend.some(Boolean) ? (
              <Sparkline values={a.trend} className="mt-1 h-14 w-full" />
            ) : (
              <div className="mt-1 grid h-14 place-items-center rounded-md bg-muted/50 text-xs text-muted-foreground">No activity</div>
            )}
          </div>

          <dl className="grid grid-cols-4 gap-2 border-t pt-4 text-center">
            {(
              [
                ['Installs', a.total_installs],
                ['DAU', a.dau],
                ['WAU', a.wau],
                ['MAU', a.mau],
              ] as const
            ).map(([k, v]) => (
              <div key={k}>
                <dt className="text-[11px] text-muted-foreground">{k}</dt>
                <dd className="text-sm font-semibold tabular-nums">{num(v)}</dd>
              </div>
            ))}
          </dl>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="tabular-nums">
              {num(a.sessions)} sessions · {num(a.new_installs)} new
              {a.ad_installs > 0 && <> · {num(a.ad_installs)} from ads</>}
              {(() => {
                const m = findMetric(revenue, /^revenue/)
                return m && revenue ? (
                  <>
                    {' · '}
                    <span className="font-medium text-foreground">{metricValue(m, revenue.currency)}</span> revenue
                  </>
                ) : null
              })()}
            </span>
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </div>
        </div>
      </MagicCard>
    </a>
  )
}

/**
 * A website's card: round, with a globe, and visitors rather than installs.
 * Its goal (a store click unless the catalog names another) is the number
 * that says whether the site does its job.
 */
function WebsiteCard({ site: a, days, sells }: { site: AppSummary; days: number; sells: string[] }) {
  const goal = a.goal ? goalName(a.goal.event) : 'store click'
  return (
    <a href={href.app(a.app)} className="group block rounded-2xl focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <div className="flex flex-col gap-4 rounded-2xl border border-dashed bg-card p-5 transition-colors group-hover:border-solid">
        <div className="flex items-center gap-3">
          <AppMark slug={a.app} name={a.name} website className="size-9 text-sm" />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{a.name}</div>
            <div className="truncate text-xs text-muted-foreground">
              {sells.length ? `Sells ${sells.join(', ')}` : 'Website'} · last visit {when(a.last_event)}
            </div>
          </div>
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-muted-foreground">Visitors per day</span>
            <span className="text-xs text-muted-foreground tabular-nums">{days}d</span>
          </div>
          {a.trend && a.trend.some(Boolean) ? (
            <Sparkline values={a.trend} className="mt-1 h-14 w-full" />
          ) : (
            <div className="mt-1 grid h-14 place-items-center rounded-md bg-muted/50 text-xs text-muted-foreground">No visits</div>
          )}
        </div>
        <dl className="grid grid-cols-4 gap-2 border-t pt-4 text-center">
          {(
            [
              ['Visits', num(a.sessions)],
              ['New', num(a.new_installs)],
              [`${goal}s`, num(a.goal?.visits ?? 0)],
              ['Rate', pct(a.goal?.visits ?? 0, a.sessions)],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <dt className="truncate text-[11px] text-muted-foreground first-letter:uppercase">{k}</dt>
              <dd className="text-sm font-semibold tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="tabular-nums">{num(a.wau)} visitors in 7 days</span>
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
        </div>
      </div>
    </a>
  )
}

// An inactive app takes a row, not a full card: its sparkline and numbers
// would be zeros, and its feedback still shows.
function InactiveCard({ app: a }: { app: AppSummary }) {
  return (
    <a
      href={href.app(a.app)}
      className="group flex items-center gap-3 rounded-xl border border-dashed bg-card/40 p-3 transition-colors hover:bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <AppMark slug={a.app} name={a.name} website={isWebsite(a)} className="size-8 rounded-lg text-sm opacity-50 grayscale" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-muted-foreground group-hover:text-foreground">{a.name}</span>
          <InactiveBadge />
        </div>
        <div className="text-xs text-muted-foreground">{a.last_event ? `Last event ${when(a.last_event)}` : 'No events yet'}</div>
      </div>
      {a.open_tickets > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">
          <MessageSquare className="size-3" aria-hidden /> {a.open_tickets}
        </span>
      )}
      <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
    </a>
  )
}
