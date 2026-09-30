import type { ReactNode } from 'react'
import { ExternalLink, Fingerprint, LayoutGrid, LogOut, MessageSquare, Monitor, Moon, Sun } from 'lucide-react'

import { AppMark, Logo } from '@/components/Logo'
import { useApps } from '@/lib/apps'
import { href, type Route } from '@/lib/route'
import { useSession } from '@/lib/session'
import { useTheme, type Theme } from '@/lib/theme'
import { cn } from '@/lib/utils'

function NavLink({ to, active, icon, children, badge }: { to: string; active: boolean; icon?: ReactNode; children: ReactNode; badge?: number }) {
  return (
    <a
      href={to}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-md px-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
        active && 'bg-accent text-accent-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {!!badge && (
        <span className="rounded-full bg-brand px-1.5 text-[11px] leading-[18px] font-semibold text-brand-foreground tabular-nums">{badge}</span>
      )}
    </a>
  )
}

function ThemeSwitch() {
  const { theme, setTheme } = useTheme()
  const options: { value: Theme; icon: typeof Sun; label: string }[] = [
    { value: 'light', icon: Sun, label: 'Light' },
    { value: 'dark', icon: Moon, label: 'Dark' },
    { value: 'system', icon: Monitor, label: 'System' },
  ]
  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex rounded-lg bg-muted p-0.5">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          onClick={() => setTheme(value)}
          className={cn(
            'grid size-7 place-items-center rounded-md text-muted-foreground hover:text-foreground',
            theme === value && 'bg-card text-foreground shadow-sm ring-1 ring-border',
          )}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  )
}

export function DemoBanner() {
  return (
    <div role="note" className="flex items-center justify-center gap-2 bg-brand px-4 py-1.5 text-center text-xs font-medium text-brand-foreground">
      Demo: invented apps and data, read-only.
      <a href="https://github.com/enso-works/hush" className="inline-flex items-center gap-1 underline underline-offset-2">
        Run your own <ExternalLink className="size-3" aria-hidden />
      </a>
    </div>
  )
}

export function Shell({ route, children }: { route: Route; children: ReactNode }) {
  const { demo, signOut } = useSession()
  const { data } = useApps()
  const apps = data?.apps ?? []
  const open = apps.reduce((n, a) => n + a.open_tickets, 0)

  const nav = (
    <>
      <NavLink to={href.overview()} active={route.page === 'overview'} icon={<LayoutGrid className="size-4" />}>
        Overview
      </NavLink>
      <NavLink to={href.feedback()} active={route.page === 'feedback'} icon={<MessageSquare className="size-4" />} badge={open}>
        Feedback
      </NavLink>
      <NavLink to={href.installs()} active={route.page === 'installs'} icon={<Fingerprint className="size-4" />}>
        Installs
      </NavLink>
    </>
  )

  return (
    // A fixed frame: the sidebar stays put and only the page column scrolls.
    <div className="flex h-dvh flex-col">
      {demo && <DemoBanner />}
      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col border-r bg-card/50 px-3 py-4 md:flex">
          <a href={href.overview()} className="mb-6 flex items-center gap-2 px-2">
            <Logo className="size-7" />
            <span className="text-lg font-semibold tracking-tight">hush</span>
          </a>
          <nav className="flex flex-col gap-0.5" aria-label="Main">
            {nav}
          </nav>
          {apps.length > 0 && (
            <>
              <div className="mt-6 mb-1.5 px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">Apps</div>
              <nav className="flex min-h-0 flex-col gap-0.5 overflow-y-auto" aria-label="Apps">
                {apps.map((a) => (
                  <NavLink
                    key={a.app}
                    to={href.app(a.app)}
                    active={route.page === 'app' && route.slug === a.app}
                    icon={<AppMark slug={a.app} name={a.name} className="size-5 text-[10px]" />}
                  >
                    {a.name}
                  </NavLink>
                ))}
              </nav>
            </>
          )}
          <div className="mt-auto flex items-center justify-between gap-2 px-1 pt-4">
            <ThemeSwitch />
            {!demo && (
              <button
                type="button"
                onClick={() => signOut()}
                className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <LogOut className="size-3.5" aria-hidden /> Sign out
              </button>
            )}
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <header className="sticky top-0 z-20 flex items-center gap-3 border-b bg-background/85 px-4 py-2.5 backdrop-blur md:hidden">
            <a href={href.overview()} className="flex items-center gap-2" aria-label="hush">
              <Logo className="size-7" />
            </a>
            <nav className="flex flex-1 gap-1 overflow-x-auto" aria-label="Main">
              {nav}
            </nav>
          </header>
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
        </div>
      </div>
    </div>
  )
}
