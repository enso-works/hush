// One install: its facts, its tickets and its latest events, refreshing
// while you watch. For checking that a build sends what it should (the app
// shows getInstallationId() in a debug screen; paste it here) and for
// answering a "delete my data" request that arrived by email.
import { useEffect, useState } from 'react'
import { Fingerprint, Radio, Search, Trash2 } from 'lucide-react'

import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, type InstallDetail } from '@/lib/api'
import { useApi } from '@/lib/data'
import { countryName, flag, plural, stamp, when } from '@/lib/format'
import { href } from '@/lib/route'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { ErrorNote } from '@/pages/ErrorNote'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function Lookup({ initial }: { initial?: string }) {
  const [value, setValue] = useState(initial ?? '')
  const valid = UUID.test(value.trim())
  return (
    <form
      className="flex w-full max-w-xl gap-2"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid) location.hash = href.installs(value.trim().toLowerCase())
      }}
    >
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          aria-label="Install id"
          placeholder="Install id, e.g. 3f2c…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-9 pl-9 font-mono text-xs"
          spellCheck={false}
        />
      </div>
      <Button type="submit" disabled={!valid}>
        Look up
      </Button>
    </form>
  )
}

function Props({ props }: { props: Record<string, unknown> }) {
  const entries = Object.entries(props)
  if (!entries.length) return null
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
          {k}=<span className="text-foreground">{String(v)}</span>
        </span>
      ))}
    </div>
  )
}

function Detail({ id }: { id: string }) {
  const { demo } = useSession()
  const [live, setLive] = useState(true)
  const { data, error, reload } = useApi<InstallDetail>(`/admin/installs/${encodeURIComponent(id)}?limit=100`)
  const [note, setNote] = useState<string | null>(null)

  // Live: refetch every few seconds while the tab is visible.
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload()
    }, 4000)
    return () => clearInterval(t)
  }, [live, reload])

  if (error === 'not found')
    return (
      <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
        {note ? <p role="status" className="mb-2 font-medium text-foreground">{note}</p> : null}
        Nothing is stored for this install: it never sent anything, it was forgotten, or it sent nothing for longer than the server keeps an install.
      </div>
    )
  if (error) return <ErrorNote message={error} />
  if (!data)
    return (
      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    )

  const i = data.install
  const forget = async () => {
    if (!confirm('Delete everything stored about this install: its events, feedback and replies? This cannot be undone.')) return
    try {
      const r = await api<{ deleted: { events: number; tickets: number } }>(`/admin/installs/${encodeURIComponent(id)}/forget`, { method: 'POST' })
      setNote(`Forgotten: ${plural(r.deleted.events, 'event')} and ${plural(r.deleted.tickets, 'ticket')} deleted.`)
      setLive(false)
      reload()
    } catch (err) {
      setNote(`Not deleted: ${(err as Error).message}`)
    }
  }
  const facts: [string, string][] = i
    ? [
        ['App', i.app],
        ['First seen', stamp(i.first_seen)],
        ['Last seen', when(i.last_seen)],
        ['Channel', i.channel ?? '–'],
        ['Version', [i.version, i.build && `(${i.build})`].filter(Boolean).join(' ') || '–'],
        ['Device', [i.device, i.os].filter(Boolean).join(', ') || '–'],
        ['Locale', i.locale ?? '–'],
        ['Country', i.country ? `${flag(i.country)} ${countryName(i.country)}` : '–'],
        ['Plan', i.pro ? 'Pro' : 'Free'],
        ['Customer', i.rc_id ?? '–'],
        ['SDK', i.sdk ?? '–'],
      ]
    : []

  return (
    <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
      <div className="flex flex-col gap-4">
        <section className="rounded-xl border bg-card p-5">
          <h2 className="mb-3 text-sm font-semibold">Install</h2>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-sm">
            {facts.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="truncate">{v}</dd>
              </div>
            ))}
          </dl>
          {!i && <p className="text-sm text-muted-foreground">No install row: only feedback is stored.</p>}
        </section>
        {data.tickets.length > 0 && (
          <section className="rounded-xl border bg-card p-5">
            <h2 className="mb-3 text-sm font-semibold">Feedback</h2>
            <ul className="flex flex-col gap-1 text-sm">
              {data.tickets.map((t) => (
                <li key={t.id}>
                  <a className="flex justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted" href={href.feedback({ id: Number(t.id), status: 'all' })}>
                    <span className="truncate">{t.subject || `${t.kind} #${t.id}`}</span>
                    <span className="shrink-0 text-xs text-muted-foreground capitalize">{t.status}</span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!demo && (
          <section className="rounded-xl border border-destructive/30 bg-card p-5">
            <h2 className="text-sm font-semibold">Forget this install</h2>
            <p className="mt-1 mb-3 text-xs text-muted-foreground">
              For a "delete my data" request by email. Apps can offer the same with the SDK's forget(). Messages sent with an email are not linked
              to an install: delete those on the Feedback page.
            </p>
            <Button variant="destructive" size="sm" onClick={forget}>
              <Trash2 className="size-3.5" /> Forget install
            </Button>
          </section>
        )}
        {note && (
          <p role="status" className="text-sm text-muted-foreground">
            {note}
          </p>
        )}
      </div>

      <section className="flex min-w-0 flex-col rounded-xl border bg-card">
        <header className="flex items-center justify-between gap-2 border-b px-5 py-3">
          <h2 className="text-sm font-semibold">Latest events</h2>
          <button
            type="button"
            onClick={() => setLive((v) => !v)}
            aria-pressed={live}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              live ? 'bg-good/15 text-good' : 'bg-muted text-muted-foreground',
            )}
          >
            <Radio className={cn('size-3', live && 'animate-pulse')} aria-hidden /> {live ? 'Live' : 'Paused'}
          </button>
        </header>
        {data.events.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">No events.</p>
        ) : (
          <ol className="divide-y">
            {data.events.map((e) => (
              <li key={e.id} className="px-5 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono text-xs font-medium">{e.name}</span>
                    {!e.known && <span className="rounded-full bg-chart-4/15 px-1.5 text-[10px] font-semibold text-chart-4 uppercase">unknown</span>}
                  </span>
                  <time className="shrink-0 text-[11px] text-muted-foreground tabular-nums" dateTime={e.at} title={`received ${stamp(e.received_at)}`}>
                    {stamp(e.at)}
                  </time>
                </div>
                <Props props={e.props} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}

export function Installs({ id }: { id?: string }) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={
          <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground">
            <Fingerprint className="size-5" aria-hidden />
          </span>
        }
        title="Installs"
        sub="One install's events as they arrive, its feedback, and forgetting it"
        actions={<Lookup key={id} initial={id} />}
      />
      {id ? (
        <Detail key={id} id={id} />
      ) : (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          Paste an install id. Apps get theirs from the SDK's <code className="rounded bg-muted px-1 py-0.5 text-xs">getInstallationId()</code>, e.g. for a debug screen; a
          feedback thread sent without an email shows its install too.
        </div>
      )}
    </div>
  )
}
