// Preview as: what a device with this platform, version, channel, language
// and paid state gets, or what one install gets, worked out by the server
// with the same evaluator the SDK runs. Every bucket is evaluated, so a
// rollout shows as the share of installs that get each value.
import { useId, useState } from 'react'
import { Eye } from 'lucide-react'

import { Field, ValueText } from '@/components/ConfigValue'
import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ConfigPreview, ConfigOutcome } from '@/lib/api'
import { UUID } from '@/lib/config'
import { useApi } from '@/lib/data'
import { cn } from '@/lib/utils'

// The server reads a draft from the URL; past this it may not.
const MAX_URL = 12_000

/** What the key page has to preview besides what is stored. */
export type PreviewDraft = { state: 'none' } | { state: 'invalid' } | { state: 'draft'; json: string }

type Context = { install: string; platform: string; version: string; channel: string; language: string; pro: 'unknown' | 'pro' | 'free' }
const EMPTY: Context = { install: '', platform: '', version: '', channel: '', language: '', pro: 'unknown' }

const ruleName = (rule: number) => (rule === -1 ? 'Default' : `Rule ${rule + 1}`)
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

function query(c: Context) {
  const q = new URLSearchParams()
  if (c.install.trim()) q.set('install', c.install.trim().toLowerCase())
  for (const f of ['platform', 'version', 'channel', 'language'] as const) if (c[f].trim()) q.set(f, c[f].trim())
  if (c.pro !== 'unknown') q.set('pro', String(c.pro === 'pro'))
  return q
}

function Outcomes({ outcomes }: { outcomes: ConfigOutcome[] }) {
  return (
    <ul className="flex flex-col gap-1">
      {outcomes.map((o) => (
        <li key={o.rule} className="relative flex h-8 items-center justify-between gap-3 overflow-hidden rounded-md px-2.5 text-sm">
          <div aria-hidden className="absolute inset-y-0 left-0 rounded-md bg-brand/10 dark:bg-brand/15" style={{ width: `${Math.max(2, o.share)}%` }} />
          <span className="relative flex min-w-0 items-center gap-1.5 truncate">
            {has(o, 'value') ? <ValueText value={o.value} /> : <span className="text-muted-foreground">No value: the app's fallback</span>}{' '}
            <span className="shrink-0 tabular-nums">· {o.share}%</span>
          </span>
          <span className="relative shrink-0 text-xs text-muted-foreground">{ruleName(o.rule)}</span>
        </li>
      ))}
    </ul>
  )
}

export function PreviewAs({ slug, keyName, draft }: { slug: string; keyName?: string; draft?: PreviewDraft }) {
  const id = useId()
  const [form, setForm] = useState<Context>(EMPTY)
  // What was last asked for. A device that knows nothing to begin with: it
  // gets what every install gets before the rules learn anything about it.
  const [asked, setAsked] = useState<Context>(EMPTY)
  const set = (patch: Partial<Context>) => setForm((f) => ({ ...f, ...patch }))
  const badInstall = form.install.trim() !== '' && !UUID.test(form.install.trim())

  const q = query(asked)
  if (keyName) q.set('key', keyName)
  const base = `/admin/apps/${encodeURIComponent(slug)}/config/preview`
  let tooLarge = false
  if (keyName && draft?.state === 'draft') {
    const withDraft = new URLSearchParams(q)
    withDraft.set('draft', draft.json)
    if (`${base}?${withDraft}`.length > MAX_URL) tooLarge = true
    else q.set('draft', draft.json)
  }
  const { data, error, loading } = useApi<ConfigPreview>(`${base}?${q}`)

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (!badInstall) setAsked(form)
        }}
      >
        <div className={cn('grid gap-3', keyName ? 'grid-cols-2' : 'grid-cols-2 md:grid-cols-4')}>
          <Field label="Install id" htmlFor={`${id}-install`} error={badInstall ? 'Not an install id' : undefined} className={cn('col-span-2', !keyName && 'md:col-span-4')}>
            <Input
              id={`${id}-install`}
              placeholder="Optional, e.g. 3f2c…"
              value={form.install}
              onChange={(e) => set({ install: e.target.value })}
              aria-invalid={badInstall}
              className="font-mono text-xs md:text-xs"
              spellCheck={false}
            />
          </Field>
          <Field label="Platform" htmlFor={`${id}-platform`}>
            <Input id={`${id}-platform`} placeholder="e.g. ios" value={form.platform} onChange={(e) => set({ platform: e.target.value })} spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="App version" htmlFor={`${id}-version`}>
            <Input id={`${id}-version`} placeholder="e.g. 2.1.0" value={form.version} onChange={(e) => set({ version: e.target.value })} spellCheck={false} />
          </Field>
          <Field label="Channel" htmlFor={`${id}-channel`}>
            <Input id={`${id}-channel`} placeholder="e.g. app_store" value={form.channel} onChange={(e) => set({ channel: e.target.value })} spellCheck={false} autoCapitalize="off" />
          </Field>
          <Field label="Language" htmlFor={`${id}-language`}>
            <Input id={`${id}-language`} placeholder="e.g. de" value={form.language} onChange={(e) => set({ language: e.target.value })} spellCheck={false} autoCapitalize="off" />
          </Field>
        </div>
        <p className="-mt-1 text-xs text-muted-foreground">
          The language the app reports: its own when it passes one to the SDK, otherwise the phone's.
        </p>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Field label="Paid" hint="Unknown is how a device sees an install before its first identify()." className="max-w-sm">
            <Segmented
              label="Paid"
              value={form.pro}
              onChange={(pro) => set({ pro })}
              className="self-start"
              options={[
                { value: 'unknown', label: 'Unknown' },
                { value: 'pro', label: 'Pro' },
                { value: 'free', label: 'Free' },
              ]}
            />
          </Field>
          <Button type="submit" disabled={badInstall}>
            <Eye /> Preview
          </Button>
        </div>
        {keyName && draft && draft.state !== 'none' && (
          <p className="text-xs text-muted-foreground">
            {draft.state === 'invalid'
              ? 'Fix the form to preview it.'
              : tooLarge
                ? 'Too large to preview before saving.'
                : 'Previewing your unsaved changes'}
          </p>
        )}
      </form>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          Could not preview: {error}
        </p>
      )}
      {data && (
        <div className={cn('flex flex-col gap-4 transition-opacity', loading && 'opacity-60')} aria-live="polite">
          {data.from_install.length > 0 && <p className="text-xs text-muted-foreground">From the install: {data.from_install.join(', ')}</p>}
          {data.warnings.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs text-chart-4">
              {data.warnings.map((w) => (
                <li key={w}>{w[0].toUpperCase() + w.slice(1)}.</li>
              ))}
            </ul>
          )}
          {data.keys.map((k) => (
            <div key={k.key} className="flex flex-col gap-1.5" data-key={k.key}>
              {!keyName && <h3 className="font-mono text-xs font-medium">{k.key}</h3>}
              <Outcomes outcomes={k.outcomes} />
              {data.install && k.rule !== undefined && (
                <p className="text-xs text-muted-foreground">
                  This install gets {has(k, 'value') ? <ValueText value={k.value} className="text-foreground" /> : "no value: the app's fallback"} (
                  {ruleName(k.rule)}, bucket {k.bucket}).
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
