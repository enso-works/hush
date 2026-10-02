// Every change to one key, newest first: who changed what is not recorded
// (the admin token has no identity), what and when is.
import { useState } from 'react'
import { History as HistoryIcon, Upload } from 'lucide-react'

import { ValueText } from '@/components/ConfigValue'
import { Button } from '@/components/ui/button'
import { api, AuthError, type ConfigChange, type ConfigHistory, type ConfigType } from '@/lib/api'
import { partsFit, same, type Parts } from '@/lib/config'
import { useApi } from '@/lib/data'
import { stamp } from '@/lib/format'
import { useSession } from '@/lib/session'

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
      <pre className="max-h-64 overflow-auto rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">
        {value == null ? 'none' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

function Entry({ c, type, onLoad }: { c: ConfigChange; type: ConfigType; onLoad?: (parts: Parts) => void }) {
  const before = c.effective_before
  const after = c.effective_after
  const defaultChanged = !same(before?.default, after?.default)
  const rulesChanged = !same(before?.rules, after?.rules)
  const fits = partsFit(type, c.override_after)
  return (
    <li className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-sm font-medium">{c.action === 'set' ? 'Override set' : 'Reverted to the catalog'}</span>
          <time className="shrink-0 text-[11px] text-muted-foreground tabular-nums" dateTime={c.at}>
            {stamp(c.at)}
          </time>
        </div>
        {onLoad && c.action === 'set' && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={!fits}
            title={fits ? 'Fill the form with this version; nothing is saved until you save' : "This version does not fit the key's type now"}
            onClick={() => c.override_after && onLoad(c.override_after)}
          >
            <Upload /> Load into the editor
          </Button>
        )}
      </div>
      {c.note && <p className="text-sm">{c.note}</p>}
      {(defaultChanged || rulesChanged) && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {defaultChanged && (
            <span className="flex min-w-0 flex-wrap items-baseline gap-1">
              Default: <ValueText value={before?.default} className="text-foreground" /> → <ValueText value={after?.default} className="text-foreground" />
            </span>
          )}
          {rulesChanged && (
            <span className="tabular-nums">
              Rules: {before?.rules.length ?? 0} → {after?.rules.length ?? 0}
            </span>
          )}
        </div>
      )}
      <details className="group text-xs">
        <summary className="cursor-pointer text-muted-foreground select-none hover:text-foreground">Show</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Json title="Served before" value={before} />
          <Json title="Served after" value={after} />
          <Json title="Override before" value={c.override_before} />
          <Json title="Override after" value={c.override_after} />
        </div>
      </details>
    </li>
  )
}

export function History({ slug, keyName, type, onLoad }: { slug: string; keyName: string; type: ConfigType; onLoad: (parts: Parts) => void }) {
  const { demo, signOut } = useSession()
  const path = `/admin/apps/${encodeURIComponent(slug)}/config/history?key=${encodeURIComponent(keyName)}&limit=20`
  const first = useApi<ConfigHistory>(path)
  // Pages after the first, appended as "Older" asks for them.
  const [older, setOlder] = useState<ConfigHistory | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (first.error || error) return <p role="alert" className="text-sm text-destructive">Could not load the history: {first.error ?? error}</p>
  if (!first.data) return <div className="h-24" />
  const changes = [...first.data.changes, ...(older?.changes ?? [])]
  const more = older ? older.more : first.data.more
  const loadOlder = async () => {
    setBusy(true)
    try {
      const page = await api<ConfigHistory>(`${path}&before=${changes[changes.length - 1].id}`)
      setOlder((o) => ({ changes: [...(o?.changes ?? []), ...page.changes], more: page.more }))
    } catch (err) {
      if (err instanceof AuthError) return signOut('That token was not accepted.')
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (!changes.length)
    return (
      <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
        <HistoryIcon className="size-5" aria-hidden />
        No changes yet: the catalog's entry has always been served.
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col divide-y" aria-label="Changes">
        {changes.map((c) => (
          <Entry key={c.id} c={c} type={type} onLoad={demo ? undefined : onLoad} />
        ))}
      </ol>
      {more && (
        <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void loadOlder()}>
          Older
        </Button>
      )}
    </div>
  )
}
