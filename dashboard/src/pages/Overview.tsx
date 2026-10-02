import { ArrowRight, MessageSquare } from 'lucide-react'

import { AppMark } from '@/components/Logo'
import { PageHeader, PeriodControls } from '@/components/PageHeader'
import { Sparkline } from '@/components/Sparkline'
import { Stat } from '@/components/Stat'
import { BlurFade } from '@/components/ui/blur-fade'
import { MagicCard } from '@/components/ui/magic-card'
import { Skeleton } from '@/components/ui/skeleton'
import { useApps } from '@/lib/apps'
import { num, when } from '@/lib/format'
import { href } from '@/lib/route'
import { usePrefs } from '@/lib/session'
import { findMetric, metricValue } from '@/lib/money'
import { ErrorNote } from '@/pages/ErrorNote'
import { useRevenueByApp } from '@/pages/Revenue'

export function Overview() {
  const { data, error, loading } = useApps()
  const { prefs } = usePrefs()
  const apps = data?.apps ?? []
  const money = useRevenueByApp()
  // Installs that sent nothing for that long are deleted, so the total is
  // the installs seen in that window, not every install there ever was.
  const kept = data?.install_retention_days ?? null
  const sum = (k: 'total_installs' | 'new_installs' | 'dau' | 'sessions' | 'open_tickets') => apps.reduce((n, a) => n + a[k], 0)

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Overview"
        sub={data ? `${apps.length} app${apps.length === 1 ? '' : 's'} · ${prefs.env} · last ${prefs.days} days` : ' '}
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
              <Stat label={`New in ${prefs.days} days`} value={sum('new_installs')} />
              <Stat label="Active in the last day" value={sum('dau')} />
              <Stat label="Open feedback" value={sum('open_tickets')} />
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
        {apps.map((a, i) => (
          <BlurFade key={a.app} delay={0.05 + i * 0.05} duration={0.35}>
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
                      <span className="text-xs text-muted-foreground tabular-nums">{prefs.days}d</span>
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
                        const p = money?.get(a.app)
                        const m = findMetric(p, /^revenue/)
                        return m && p ? (
                          <>
                            {' · '}
                            <span className="font-medium text-foreground">{metricValue(m, p.currency)}</span> revenue
                          </>
                        ) : null
                      })()}
                    </span>
                    <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
                  </div>
                </div>
              </MagicCard>
            </a>
          </BlurFade>
        ))}
      </div>
    </div>
  )
}
