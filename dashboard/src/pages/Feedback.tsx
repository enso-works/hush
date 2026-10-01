import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bug, Heart, Inbox, Lightbulb, Mail, MessageSquare, RotateCcw, Send, Trash2, X } from 'lucide-react'

import { AppMark } from '@/components/Logo'
import { PageHeader } from '@/components/PageHeader'
import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { api, type Ticket, type TicketKind, type TicketStatus, type TicketSummary } from '@/lib/api'
import { useApps } from '@/lib/apps'
import { useApi } from '@/lib/data'
import { stamp, when } from '@/lib/format'
import { href } from '@/lib/route'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { ErrorNote } from '@/pages/ErrorNote'

const KIND: Record<TicketKind, { label: string; icon: typeof Bug; tone: string }> = {
  issue: { label: 'Issue', icon: Bug, tone: 'bg-bad/10 text-bad' },
  feature: { label: 'Idea', icon: Lightbulb, tone: 'bg-chart-4/15 text-chart-4' },
  love: { label: 'Love', icon: Heart, tone: 'bg-chart-5/15 text-chart-5' },
}

const STATUS: Record<TicketStatus, string> = {
  open: 'bg-brand text-brand-foreground',
  answered: 'bg-good/15 text-good',
  closed: 'bg-muted text-muted-foreground',
}

function KindIcon({ kind, className }: { kind: TicketKind; className?: string }) {
  const k = KIND[kind] ?? KIND.issue
  const Icon = k.icon
  return (
    <span className={cn('grid size-7 shrink-0 place-items-center rounded-lg', k.tone, className)} title={k.label}>
      <Icon className="size-3.5" aria-hidden />
    </span>
  )
}

function StatusPill({ status }: { status: TicketStatus }) {
  return <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize', STATUS[status])}>{status}</span>
}

function Thread({ id, onChanged }: { id: number; onChanged: () => void }) {
  const { demo } = useSession()
  const { apps } = useApps().data ?? { apps: [] }
  const { data: t, error, reload } = useApi<Ticket>(`/admin/tickets/${id}`)
  const [body, setBody] = useState('')
  const [close, setClose] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setBody('')
    setClose(false)
    setNote(null)
  }, [id])
  // Braces matter: scrollIntoView returns a promise in current browsers, and
  // an effect may return nothing but its cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [t?.replies.length, id])

  if (error) return <ErrorNote message={error} />
  // Ticket ids are Postgres bigints, which arrive as strings.
  if (!t || Number(t.id) !== id)
    return (
      <div className="flex flex-col gap-3 p-6">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24 w-4/5" />
        <Skeleton className="ml-auto h-16 w-3/5" />
      </div>
    )

  const appName = apps.find((a) => a.app === t.app)?.name ?? t.app
  const done = () => {
    reload()
    onChanged()
  }
  const setStatus = async (status: TicketStatus) => {
    setBusy(true)
    try {
      await api(`/admin/tickets/${t.id}/status`, { method: 'POST', body: { status } })
      done()
    } catch (err) {
      setNote(`Not changed: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  // For "please delete my message" by email: a ticket with an email is not
  // linked to an install, so forgetting an install does not reach it.
  const remove = async () => {
    if (!confirm('Delete this message and every reply on it? The app no longer lists it. This cannot be undone.')) return
    setBusy(true)
    try {
      await api(`/admin/tickets/${t.id}`, { method: 'DELETE' })
      onChanged()
      location.hash = href.feedback({ status: 'all' })
    } catch (err) {
      setNote(`Not deleted: ${(err as Error).message}`)
      setBusy(false)
    }
  }
  const send = async () => {
    if (!body.trim() || busy) return
    setBusy(true)
    setNote(null)
    try {
      await api(`/admin/tickets/${t.id}/reply`, { method: 'POST', body: { body, close } })
      setBody('')
      done()
    } catch (err) {
      setNote(`Not sent: ${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const diag = Object.entries(t.diag ?? {})
  const messages = [{ id: 0, author: 'user' as const, body: t.message, at: t.created_at, emailed: false }, ...t.replies]

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4 md:p-5">
        <div className="flex min-w-0 items-start gap-3">
          <a href={href.feedback()} className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-muted lg:hidden" aria-label="Back to the list">
            <ArrowLeft className="size-4" />
          </a>
          <KindIcon kind={t.kind} className="size-9" />
          <div className="min-w-0">
            <h2 className="font-semibold text-balance">{t.subject || `${KIND[t.kind]?.label ?? 'Message'} #${t.id}`}</h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5">
                <AppMark slug={t.app} name={appName} className="size-4 text-[9px]" />
                {appName}
              </span>
              <span>·</span>
              <StatusPill status={t.status} />
              <span>·</span>
              <span>opened {when(t.created_at)}</span>
            </div>
          </div>
        </div>
        {!demo && (
          <div className="flex items-center gap-2">
            {t.status === 'closed' ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus('open')}>
                <RotateCcw className="size-3.5" /> Reopen
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled={busy} onClick={() => setStatus('closed')}>
                <X className="size-3.5" /> Close
              </Button>
            )}
            <Button variant="destructive" size="sm" disabled={busy} onClick={remove}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </div>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
        <div className="mx-auto flex max-w-2xl flex-col gap-4">
          {messages.map((m) => (
            <div key={m.id} className={cn('flex flex-col gap-1', m.author === 'support' ? 'items-end' : 'items-start')}>
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
                  m.author === 'support' ? 'rounded-br-md bg-brand text-brand-foreground' : 'rounded-bl-md bg-muted',
                )}
              >
                {m.body}
              </div>
              <div className="flex items-center gap-1 px-1 text-[11px] text-muted-foreground">
                {m.author === 'support' ? 'Support' : 'User'} · {stamp(m.at)}
                {m.emailed && <Mail className="size-3" aria-label="also emailed" />}
              </div>
            </div>
          ))}
          <div ref={end} />

          <details className="group rounded-lg border bg-card text-sm">
            <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground select-none group-open:border-b">
              Details: install, email, device
            </summary>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 px-3 py-3 text-xs">
              {/* A ticket with an email is not linked to the install's usage
                  data, so nothing here leads from it to an install page. */}
              <dt className="text-muted-foreground">Install</dt>
              {t.install ? (
                <dd className="truncate font-mono">
                  <a className="underline-offset-2 hover:underline" href={href.installs(t.install)}>
                    {t.install}
                  </a>
                </dd>
              ) : (
                <dd>{t.email ? 'Not linked to an install (email given)' : '–'}</dd>
              )}
              <dt className="text-muted-foreground">Email</dt>
              <dd>{t.email ?? 'none given'}</dd>
              {!t.email && (
                <>
                  <dt className="text-muted-foreground">Customer</dt>
                  <dd className="truncate font-mono">{t.rc_id ?? '–'}</dd>
                </>
              )}
              {diag.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate">{String(v)}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </div>

      <footer className="border-t p-4 md:p-5">
        <div className="mx-auto max-w-2xl">
          {demo ? (
            <p className="rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
              Replying is switched off in the demo. On your own instance you answer here; the user reads it in the app, and by email if they left one.
            </p>
          ) : t.status === 'closed' ? (
            <p className="text-sm text-muted-foreground">Closed: the app offers a new message instead of a reply.</p>
          ) : (
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault()
                send()
              }}
            >
              <Label htmlFor="reply" className="sr-only">
                Reply
              </Label>
              <Textarea
                id="reply"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={t.email ? `Reply (also emailed to ${t.email})` : 'Reply (shown in the app; no email was given)'}
                className="min-h-24 resize-y"
                maxLength={4000}
              />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox checked={close} onCheckedChange={(v) => setClose(v === true)} />
                  Close after replying
                </label>
                <div className="flex items-center gap-2">
                  <span className="hidden text-xs text-muted-foreground sm:inline">⌘ Enter</span>
                  <Button type="submit" disabled={busy || !body.trim()}>
                    <Send className="size-3.5" /> Send reply
                  </Button>
                </div>
              </div>
              {note && (
                <p role="status" className="text-sm text-destructive">
                  {note}
                </p>
              )}
            </form>
          )}
        </div>
      </footer>
    </div>
  )
}

export function Feedback({ id, status, kind }: { id?: number; status: string; kind: string }) {
  const { data, error, loading, reload } = useApi<{ tickets: TicketSummary[] }>('/admin/tickets?status=all')
  const apps = useApps()
  const names = new Map((apps.data?.apps ?? []).map((a) => [a.app, a.name]))
  // Ticket ids are Postgres bigints and arrive as strings; the route's are numbers.
  const all = useMemo(() => (data?.tickets ?? []).map((t) => ({ ...t, id: Number(t.id) })), [data])
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length, open: 0, answered: 0, closed: 0 }
    for (const t of all) c[t.status]++
    return c
  }, [all])
  const list = all.filter((t) => (status === 'all' || t.status === status) && (kind === 'all' || t.kind === kind))
  const selected = list.findIndex((t) => t.id === id)

  // j / k move through the list, as in most inboxes; not while typing.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el.closest('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key !== 'j' && e.key !== 'k') return
      const next = list[Math.min(list.length - 1, Math.max(0, selected + (e.key === 'j' ? 1 : -1)))]
      if (next) location.hash = href.feedback({ id: next.id, status, kind })
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [list, selected, status, kind])

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Feedback"
        sub="What users wrote from inside the apps, and your answers"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Status"
              value={status}
              onChange={(s) => (location.hash = href.feedback({ status: s, kind }))}
              options={(['open', 'answered', 'closed', 'all'] as const).map((s) => ({
                value: s,
                label: `${s[0].toUpperCase()}${s.slice(1)}${data ? ` ${counts[s]}` : ''}`,
              }))}
            />
            <Segmented
              label="Kind"
              value={kind}
              onChange={(k) => (location.hash = href.feedback({ status, kind: k }))}
              options={[
                { value: 'all', label: 'All' },
                { value: 'issue', label: 'Issues' },
                { value: 'feature', label: 'Ideas' },
                { value: 'love', label: 'Love' },
              ]}
            />
          </div>
        }
      />
      {error && <ErrorNote message={error} />}

      <div className="grid h-[calc(100dvh-13rem)] min-h-[520px] overflow-hidden rounded-xl border bg-card lg:grid-cols-[minmax(300px,380px)_1fr]">
        <div className={cn('min-h-0 overflow-y-auto border-r', id && 'hidden lg:block')}>
          {!data && loading && (
            <div className="flex flex-col gap-2 p-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-16 rounded-lg" />
              ))}
            </div>
          )}
          {data && list.length === 0 && (
            <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <Inbox className="size-6" aria-hidden />
                Nothing here.
              </div>
            </div>
          )}
          <ul className="flex flex-col p-1.5" aria-label="Feedback">
            {list.map((t) => (
              <li key={t.id}>
                <a
                  href={href.feedback({ id: t.id, status, kind })}
                  aria-current={t.id === id ? 'true' : undefined}
                  className={cn(
                    'flex gap-3 rounded-lg p-3 transition-colors hover:bg-muted/60',
                    t.id === id && 'bg-accent hover:bg-accent',
                  )}
                >
                  <KindIcon kind={t.kind} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className={cn('truncate text-sm', t.status === 'open' ? 'font-semibold' : 'font-medium')}>
                        {t.subject || t.preview}
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{when(t.created_at)}</span>
                    </div>
                    {t.subject && <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{t.preview}</p>}
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="truncate">{names.get(t.app) ?? t.app}</span>
                      {t.replies > 0 && (
                        <span className="inline-flex items-center gap-0.5 tabular-nums">
                          <MessageSquare className="size-3" aria-hidden />
                          {t.replies}
                        </span>
                      )}
                      {t.status !== 'open' && <StatusPill status={t.status} />}
                    </div>
                  </div>
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className={cn('min-h-0', !id && 'hidden lg:block')}>
          {id ? (
            <Thread id={id} onChanged={() => { reload(); apps.reload() }} />
          ) : (
            <div className="grid h-full place-items-center p-8 text-center text-sm text-muted-foreground">
              <div className="flex flex-col items-center gap-2">
                <MessageSquare className="size-6" aria-hidden />
                Pick a conversation. <span className="text-xs">j and k move through the list.</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
