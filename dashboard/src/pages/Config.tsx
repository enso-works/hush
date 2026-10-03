// Remote config: an app's keys as the catalog declares them and as the
// dashboard overrides them, and one key's editor, preview and history.
// Keys exist only in the catalog; here a key's default and rules are
// overridden live, and apps get the change on their next fetch.
import { useRef, useState } from 'react'
import { ArrowLeft, SlidersHorizontal, Trash2, TriangleAlert } from 'lucide-react'

import { Field, ValueText } from '@/components/ConfigValue'
import { AppMark } from '@/components/Logo'
import { PageHeader } from '@/components/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { api, ApiError, type ConfigAnswer, type ConfigKeyView, type ConfigOverride } from '@/lib/api'
import { useApps } from '@/lib/apps'
import {
  canonical,
  formFrom,
  initialForm,
  LIMITS,
  normalized,
  readForm,
  ruleSummary,
  same,
  storedParts,
  type Form,
  type Parts,
} from '@/lib/config'
import { useApi } from '@/lib/data'
import { plural, when } from '@/lib/format'
import { href } from '@/lib/route'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'
import { Panel } from '@/pages/AppPage'
import { OverrideFields } from '@/pages/ConfigEditor'
import { History } from '@/pages/ConfigHistory'
import { PreviewAs, type PreviewDraft } from '@/pages/ConfigPreview'
import { ErrorNote } from '@/pages/ErrorNote'

const configPath = (slug: string) => `/admin/apps/${encodeURIComponent(slug)}/config`

function sourceLabel(k: ConfigKeyView) {
  const d = k.source.default === 'override'
  const r = k.source.rules === 'override'
  return d && r ? 'Override' : d ? 'Override: default' : r ? 'Override: rules' : 'Catalog'
}

/** A stored override in a line: what it sets. */
function OverrideLine({ o }: { o: ConfigOverride }) {
  return (
    <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
      {'default' in o && (
        <span className="inline-flex min-w-0 items-baseline gap-1">
          <span className="text-muted-foreground">Default</span> <ValueText value={o.default} />
        </span>
      )}
      {o.rules && <span className="text-muted-foreground">{plural(o.rules.length, 'rule')}</span>}
    </span>
  )
}

function BackLink({ to, children }: { to: string; children: string }) {
  return (
    <a href={to} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      <ArrowLeft /> {children}
    </a>
  )
}

function Loading() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-48 rounded-xl" />
    </div>
  )
}

function Orphans({ slug, orphans, onChanged }: { slug: string; orphans: ConfigAnswer['orphans']; onChanged: () => void }) {
  const { demo } = useSession()
  const [note, setNote] = useState<string | null>(null)
  const remove = async (o: ConfigAnswer['orphans'][number]) => {
    if (!confirm(`Delete the override for "${o.key}"? The history keeps it.`)) return
    try {
      await api(`${configPath(slug)}/${encodeURIComponent(o.key)}`, { method: 'DELETE', body: { base: o.change } })
      setNote(null)
      onChanged()
    } catch (err) {
      setNote(`Not deleted: ${(err as Error).message}`)
    }
  }
  return (
    <Panel
      title="Not in the catalog"
      sub="Overrides for keys the catalog no longer has. Not served, and not served either if the key comes back, until it is saved again."
    >
      <ul className="flex flex-col divide-y">
        {orphans.map((o) => (
          <li key={o.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-mono text-sm font-medium">{o.key}</span>
              <OverrideLine o={o.override} />
              {o.override.note && <span className="text-xs text-muted-foreground">{o.override.note}</span>}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground">Updated {when(o.override.updated_at)}</span>
              {!demo && (
                <Button variant="destructive" size="sm" onClick={() => remove(o)}>
                  <Trash2 /> Delete
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {note && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {note}
        </p>
      )}
    </Panel>
  )
}

function KeysTable({ slug, keys }: { slug: string; keys: ConfigKeyView[] }) {
  return (
    <div className="-mx-5 overflow-x-auto px-5">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Key</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">Type</th>
            <th className="hidden px-3 py-2 font-medium sm:table-cell">Default</th>
            <th className="hidden px-3 py-2 font-medium lg:table-cell">Rules</th>
            <th className="py-2 pl-3 font-medium">Source</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr
              key={k.key}
              className="cursor-pointer border-b align-top transition-colors last:border-0 hover:bg-muted/50"
              onClick={(e) => {
                if (!(e.target as HTMLElement).closest('a')) location.hash = href.config(slug, k.key)
              }}
            >
              <td className="max-w-[22rem] py-2.5 pr-3">
                <a href={href.config(slug, k.key)} className="font-mono text-sm font-medium underline-offset-2 hover:underline">
                  {k.key}
                </a>
                <Badge variant="secondary" className="ml-2 font-mono sm:hidden">
                  {k.type}
                </Badge>
                <p className="mt-0.5 text-xs text-muted-foreground">{k.description}</p>
                {k.problem && (
                  <p className="mt-1 flex items-start gap-1.5 text-xs text-chart-4">
                    <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> Not served: {k.problem}
                  </p>
                )}
              </td>
              <td className="hidden px-3 py-2.5 sm:table-cell">
                <Badge variant="secondary" className="font-mono">
                  {k.type}
                </Badge>
              </td>
              <td className="hidden max-w-[14rem] truncate px-3 py-2.5 sm:table-cell">
                <ValueText value={k.effective.default} />
              </td>
              <td className="hidden max-w-[20rem] px-3 py-2.5 lg:table-cell">
                {k.effective.rules.length ? (
                  <span className="flex min-w-0 items-baseline gap-2">
                    <span className="shrink-0 tabular-nums">{k.effective.rules.length}</span>
                    <span className="truncate font-mono text-xs text-muted-foreground" title={ruleSummary(k.effective.rules[0])}>
                      {ruleSummary(k.effective.rules[0])}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">None</span>
                )}
              </td>
              <td className="py-2.5 pl-3 sm:whitespace-nowrap">
                <span className={cn(k.source.default === 'catalog' && k.source.rules === 'catalog' && 'text-muted-foreground')}>{sourceLabel(k)}</span>
                {k.override && sourceLabel(k) !== 'Catalog' && <span className="block text-xs text-muted-foreground">{when(k.override.updated_at)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** #/app/<slug>/config: every key of the app, the overrides the catalog lost, and a preview of them all. */
export function ConfigList({ slug }: { slug: string }) {
  const { data, error, loading, reload } = useApi<ConfigAnswer>(configPath(slug))
  const name = useApps().data?.apps.find((a) => a.app === slug)?.name ?? slug
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={<AppMark slug={slug} name={name} className="size-10 rounded-xl text-base" />}
        title={name}
        sub={data ? `Remote config · ${plural(data.keys.length, 'key')} · revision ${data.revision.slice(0, 8)}` : 'Remote config'}
        actions={<BackLink to={href.app(slug)}>App page</BackLink>}
      />
      {error && <ErrorNote message={error} />}
      {!data && loading && <Loading />}
      {data && (
        <>
          {data.size_bytes > data.limits.total_bytes && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
              <span>
                This app's config is {Math.ceil(data.size_bytes / 1024)} KB, over the 64 KB a write allows. Shorten values in the catalog.
              </span>
            </div>
          )}
          <Panel title="Keys" sub="Declared in the catalog; a key's default and rules can be overridden here">
            {data.keys.length ? (
              <KeysTable slug={slug} keys={data.keys} />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No keys. Declare them under config in this app's catalog (CATALOG_FILE) and restart the server.
              </p>
            )}
          </Panel>
          {data.orphans.length > 0 && <Orphans slug={slug} orphans={data.orphans} onChanged={reload} />}
          {data.keys.length > 0 && (
            <Panel title="Preview as" sub="What a device gets, worked out with the evaluator the SDK runs">
              <PreviewAs slug={slug} />
            </Panel>
          )}
        </>
      )}
    </div>
  )
}

type Outcome = { kind: 'saved' } | { kind: 'reverted' } | { kind: 'conflict' } | { kind: 'error'; message: string; path?: string }

/** What the form would send, with every field's error. */
function useRead(k: ConfigKeyView, form: Form) {
  const read = readForm(k.type, form)
  const valid = Object.keys(read.errors).length === 0
  const stored = normalized(storedParts(k))
  const changed = !same(normalized(read.override), stored)
  return { ...read, valid, changed }
}

/**
 * Everything under a key page's header. Mounted afresh for each version of
 * the key (its change id), so a save, or loading the current version after
 * a conflict, starts the form over from what is stored.
 */
function KeyWorkspace({
  slug,
  k,
  outcome,
  setOutcome,
  reload,
}: {
  slug: string
  k: ConfigKeyView
  outcome: Outcome | null
  setOutcome: (o: Outcome | null) => void
  reload: (fresh?: boolean) => void
}) {
  const { demo } = useSession()
  const initial = useState(() => initialForm(k))[0]
  const [form, setFormState] = useState<Form>(initial)
  const [busy, setBusy] = useState(false)
  const editor = useRef<HTMLElement>(null)
  const { errors, override, valid, changed } = useRead(k, form)
  const serverError = outcome?.kind === 'error' && outcome.path ? { [outcome.path]: outcome.message } : {}
  const shown = { ...serverError, ...errors }
  const reverting = override === null && k.override !== null
  // A stale override (from before its key left the catalog) is served again
  // only once it is saved again, so saving it as it is counts as a change.
  const stale = k.problem !== null && k.fits
  const canSave = valid && !busy && (changed || (stale && override !== null))
  const dirty = canonical(strip(form)) !== canonical(strip(initial))

  const setForm = (f: Form) => {
    setFormState(f)
    if (outcome?.kind === 'error' || outcome?.kind === 'saved' || outcome?.kind === 'reverted') setOutcome(null)
  }

  const write = async (revert: boolean) => {
    if (revert && !confirm(`Revert "${k.key}" to the catalog? Apps get the catalog's default and rules on their next fetch.`)) return
    setBusy(true)
    const note = form.note.trim() || undefined
    try {
      if (revert) await api(`${configPath(slug)}/${encodeURIComponent(k.key)}`, { method: 'DELETE', body: { base: k.change, note } })
      else await api(`${configPath(slug)}/${encodeURIComponent(k.key)}`, { method: 'POST', body: { base: k.change, ...override, note } })
      setOutcome({ kind: revert ? 'reverted' : 'saved' })
      reload()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setOutcome({ kind: 'conflict' })
      else if (err instanceof ApiError) setOutcome({ kind: 'error', message: err.message, path: typeof err.data.path === 'string' && err.data.path ? err.data.path : undefined })
      else setOutcome({ kind: 'error', message: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  // What Save would serve: a stale override counts as a draft, as for canSave.
  const draft: PreviewDraft = !(changed || (stale && override !== null))
    ? { state: 'none' }
    : !valid
      ? { state: 'invalid' }
      : // Notes change nothing a device gets; leaving them out keeps the URL short.
        { state: 'draft', json: JSON.stringify(withoutNotes(override ?? {})) }

  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
      <section ref={editor} className="flex min-w-0 flex-col rounded-xl border bg-card p-5" aria-labelledby="value-heading">
        <header className="mb-4">
          <h2 id="value-heading" className="text-sm font-semibold">
            Value
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">What apps get for this key; overridden here, it replaces the catalog's until reverted</p>
        </header>
        {demo && (
          <p className="mb-4 rounded-lg bg-muted px-3 py-2.5 text-sm text-muted-foreground">
            Editing is switched off in the demo. On your own instance a change reaches apps on their next fetch.
          </p>
        )}
        {!k.fits && (
          <p className="mb-4 rounded-lg border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-sm">
            The stored override does not fit this key's type; saving writes a new one, reverting deletes it.
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSave) void write(reverting)
          }}
        >
          <fieldset disabled={demo} className="m-0 flex min-w-0 flex-col gap-6 border-0 p-0">
            <OverrideFields k={k} form={form} setForm={setForm} errors={shown} />
            <Field label="Change note" htmlFor="change-note" error={shown.note}>
              <Input
                id="change-note"
                placeholder={demo ? undefined : 'Optional: why, for the history'}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                aria-invalid={!!shown.note}
                maxLength={LIMITS.note_chars + 50}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!canSave}>
                {reverting ? 'Revert to the catalog' : 'Save'}
              </Button>
              <Button type="button" variant="outline" disabled={!dirty || busy} onClick={() => setForm(initial)}>
                Discard changes
              </Button>
              {k.override && !reverting && (
                <Button type="button" variant="ghost" className="sm:ml-auto" disabled={busy} onClick={() => void write(true)}>
                  Revert to the catalog
                </Button>
              )}
            </div>
          </fieldset>
        </form>
        {outcome && (
          <div className="mt-4">
            {outcome.kind === 'saved' || outcome.kind === 'reverted' ? (
              <p role="status" className="text-sm text-good">
                {outcome.kind === 'saved' ? 'Saved.' : 'Reverted to the catalog.'} Apps get it on their next fetch.
              </p>
            ) : outcome.kind === 'conflict' ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
                Not saved: changed since you opened it.
                <Button type="button" variant="outline" size="sm" onClick={() => reload(true)}>
                  Load the current version
                </Button>
              </div>
            ) : (
              <p role="alert" className="text-sm text-destructive">
                Not saved: {outcome.message}
              </p>
            )}
          </div>
        )}
      </section>

      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="Preview as" sub="What a device gets, worked out with the evaluator the SDK runs">
          <PreviewAs slug={slug} keyName={k.key} draft={draft} />
        </Panel>
        <Panel title="History" sub="Every change to this key, newest first">
          <History
            slug={slug}
            keyName={k.key}
            type={k.type}
            onLoad={(parts: Parts) => {
              setForm({ ...formFrom(k, parts), note: form.note })
              editor.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }}
          />
        </Panel>
      </div>
    </div>
  )
}

// The form without the ids React keys its rule cards by, for comparing two forms.
const strip = (f: Form) => ({ ...f, rules: f.rules.map(({ id: _id, ...r }) => r) })
const withoutNotes = (p: Parts): Parts => ({ ...p, ...(p.rules ? { rules: p.rules.map(({ note: _n, ...r }) => r) } : {}) })

/** #/app/<slug>/config/<key>: one key's override editor, its preview and its history. */
export function ConfigKey({ slug, keyName }: { slug: string; keyName: string }) {
  const { data, error, loading, reload } = useApi<ConfigAnswer>(configPath(slug))
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [fresh, setFresh] = useState(0)
  const k = data?.keys.find((x) => x.key === keyName)

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        icon={
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent text-accent-foreground">
            <SlidersHorizontal className="size-5" aria-hidden />
          </span>
        }
        title={<span className="font-mono">{keyName}</span>}
        sub={
          k ? (
            <>
              {k.description} · <span className="font-mono">{k.type}</span> · {k.override ? `Overridden ${when(k.override.updated_at)}` : 'From the catalog'}
            </>
          ) : (
            'Remote config'
          )
        }
        actions={<BackLink to={href.config(slug)}>All keys</BackLink>}
      />
      {error && <ErrorNote message={error} />}
      {!data && loading && <Loading />}
      {data && !k && (
        <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">
          No key "{keyName}" in this app's catalog.{' '}
          <a href={href.config(slug)} className="text-foreground underline underline-offset-2">
            See its keys
          </a>
        </div>
      )}
      {k?.problem && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-chart-4/40 bg-chart-4/10 px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-chart-4" aria-hidden />
          <span>
            This override is not served: {k.problem}. The catalog's value is served until it is fixed or reverted.
          </span>
        </div>
      )}
      {k && (
        <KeyWorkspace
          key={`${k.change}:${fresh}`}
          slug={slug}
          k={k}
          outcome={outcome}
          setOutcome={setOutcome}
          reload={(again) => {
            if (again) {
              setOutcome(null)
              setFresh((n) => n + 1)
            }
            reload()
          }}
        />
      )}
    </div>
  )
}
