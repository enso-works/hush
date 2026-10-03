// The override editor of one config key: the default and the rules, each
// from the catalog or overridden, and the rules one card each. Every field
// runs the server's check as you type, so Save stays off until the server
// would take it; whatever the server still refuses is shown at its field.
import { useId } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'

import { Field, ValueText } from '@/components/ConfigValue'
import { Segmented } from '@/components/Segmented'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ConfigKeyView, ConfigRule, ConfigType } from '@/lib/api'
import { draftSummary, LIMITS, nextId, ruleSummary, splitList, valueText, type Errors, type Form, type RuleDraft, type Source } from '@/lib/config'
import { useSession } from '@/lib/session'
import { cn } from '@/lib/utils'

/** The editor for one value of the key's type. `label` is its accessible name. */
export function ValueEditor({
  type,
  value,
  onChange,
  label,
  error,
  visibleLabel,
}: {
  type: ConfigType
  value: string
  onChange: (v: string) => void
  label: string
  error?: string
  visibleLabel: string
}) {
  const id = useId()
  if (type === 'bool') {
    return (
      <Field label={visibleLabel} error={error}>
        <Segmented
          label={label}
          value={value}
          onChange={onChange}
          options={[
            { value: 'true', label: 'True' },
            { value: 'false', label: 'False' },
          ]}
          className="self-start"
        />
      </Field>
    )
  }
  return (
    <Field label={visibleLabel} htmlFor={id} error={error}>
      {type === 'number' ? (
        <Input id={id} aria-label={label} inputMode="decimal" value={value} onChange={(e) => onChange(e.target.value)} aria-invalid={!!error} className="max-w-48" spellCheck={false} />
      ) : (
        <Textarea
          id={id}
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          spellCheck={type === 'string'}
          className={cn('max-h-80 min-h-9 resize-y', type === 'json' && 'font-mono text-xs md:text-xs')}
        />
      )}
    </Field>
  )
}

function SourceSwitch({ label, value, onChange }: { label: string; value: Source; onChange: (s: Source) => void }) {
  return (
    <Segmented
      label={label}
      value={value}
      onChange={onChange}
      options={[
        { value: 'catalog', label: 'Catalog' },
        { value: 'override', label: 'Override' },
      ]}
    />
  )
}

/** The catalog's rules, read only. */
function CatalogRules({ rules }: { rules: ConfigRule[] }) {
  if (!rules.length) return <p className="text-sm text-muted-foreground">No rules: every device gets the default.</p>
  return (
    <ol className="flex flex-col divide-y rounded-lg border">
      {rules.map((r, i) => (
        <li key={i} className="flex min-w-0 items-baseline gap-3 px-3 py-2 text-sm">
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
          <span className="min-w-0">
            <span className="block truncate font-mono text-xs">{ruleSummary(r)}</span>
            {r.note && <span className="block text-xs text-muted-foreground">{r.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}

const LISTS = [
  { field: 'platform', label: 'Platforms', name: 'platforms', placeholder: 'ios, android, web' },
  { field: 'version', label: 'Version', name: 'version', placeholder: '>=2.1.0 <3' },
  { field: 'channel', label: 'Channels', name: 'channels', placeholder: 'app_store, testflight' },
  { field: 'language', label: 'Languages', name: 'languages', placeholder: 'en, de' },
] as const

function RuleCard({
  type,
  rule,
  n,
  count,
  errors,
  onChange,
  onMove,
  onRemove,
}: {
  type: ConfigType
  rule: RuleDraft
  n: number
  count: number
  errors: Errors
  onChange: (patch: Partial<RuleDraft>) => void
  onMove: (by: -1 | 1) => void
  onRemove: () => void
}) {
  const id = useId()
  const p = `rules[${n - 1}]`
  // In the demo every field is disabled, and a greyed placeholder reads like a value.
  const { demo } = useSession()
  return (
    <li className="flex min-w-0 flex-col gap-3 rounded-lg border bg-background/60 p-3 dark:bg-background/30">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium">Rule {n}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{draftSummary(type, rule)}</span>
        </div>
        <div className="flex shrink-0 items-center">
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move rule ${n} up`} title="Move up" disabled={n === 1} onClick={() => onMove(-1)}>
            <ArrowUp />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Move rule ${n} down`} title="Move down" disabled={n === count} onClick={() => onMove(1)}>
            <ArrowDown />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove rule ${n}`} title="Remove" onClick={onRemove}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {LISTS.map((l) => {
          const path = `${p}.when.${l.field}`
          return (
            <Field key={l.field} label={l.label} htmlFor={`${id}-${l.field}`} error={errors[path]}>
              <Input
                id={`${id}-${l.field}`}
                aria-label={`Rule ${n} ${l.name}`}
                placeholder={demo ? undefined : l.placeholder}
                value={rule[l.field]}
                onChange={(e) => onChange({ [l.field]: e.target.value })}
                // Lists read lowercased and trimmed; show them that way once you leave the field.
                onBlur={(e) => l.field !== 'version' ? onChange({ [l.field]: splitList(e.target.value).join(', ') }) : onChange({ version: e.target.value.trim() })}
                aria-invalid={!!errors[path]}
                className="font-mono text-xs placeholder:text-muted-foreground/60 md:text-xs"
                spellCheck={false}
                autoCapitalize="off"
              />
            </Field>
          )
        })}
      </div>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
        <Field label="Paid">
          <Segmented
            label={`Rule ${n} paid`}
            value={rule.pro}
            onChange={(pro) => onChange({ pro })}
            options={[
              { value: 'any', label: 'Any' },
              { value: 'pro', label: 'Pro' },
              { value: 'free', label: 'Free' },
            ]}
          />
        </Field>
        <Field label="Rollout" htmlFor={`${id}-rollout`} error={errors[`${p}.rollout`]}>
          <div className="relative w-24">
            <Input
              id={`${id}-rollout`}
              aria-label={`Rule ${n} rollout`}
              inputMode="numeric"
              value={rule.rollout}
              onChange={(e) => onChange({ rollout: e.target.value })}
              aria-invalid={!!errors[`${p}.rollout`]}
              className="pr-7 tabular-nums"
            />
            <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-muted-foreground">%</span>
          </div>
        </Field>
      </div>
      <ValueEditor type={type} value={rule.value} onChange={(value) => onChange({ value })} label={`Rule ${n} value`} visibleLabel="Value" error={errors[`${p}.value`]} />
      <Field label="Note" htmlFor={`${id}-note`} error={errors[`${p}.note`]}>
        <Input
          id={`${id}-note`}
          aria-label={`Rule ${n} note`}
          placeholder={demo ? undefined : 'Optional: why this rule exists'}
          value={rule.note}
          onChange={(e) => onChange({ note: e.target.value })}
          aria-invalid={!!errors[`${p}.note`]}
          maxLength={LIMITS.note_chars + 50}
        />
      </Field>
    </li>
  )
}

/** The rules being edited, one card each, read from the top. */
function RulesEditor({
  type,
  rules,
  onChange,
  errors,
  newValue,
}: {
  type: ConfigType
  rules: RuleDraft[]
  onChange: (rules: RuleDraft[]) => void
  errors: Errors
  newValue: string
}) {
  const update = (i: number, patch: Partial<RuleDraft>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const move = (i: number, by: -1 | 1) => {
    const next = [...rules]
    ;[next[i], next[i + by]] = [next[i + by], next[i]]
    onChange(next)
  }
  return (
    <div className="flex flex-col gap-3">
      {rules.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {rules.map((r, i) => (
            <RuleCard
              key={r.id}
              type={type}
              rule={r}
              n={i + 1}
              count={rules.length}
              errors={errors}
              onChange={(patch) => update(i, patch)}
              onMove={(by) => move(i, by)}
              onRemove={() => onChange(rules.filter((_, j) => j !== i))}
            />
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">No rules: every device gets the default.</p>
      )}
      {errors.rules && (
        <p role="alert" className="text-xs text-destructive">
          {errors.rules}
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-start"
        disabled={rules.length >= LIMITS.rules}
        title={rules.length >= LIMITS.rules ? `Up to ${LIMITS.rules} rules` : undefined}
        onClick={() =>
          onChange([...rules, { id: nextId(), platform: '', version: '', channel: '', language: '', pro: 'any', rollout: '100', value: newValue, note: '' }])
        }
      >
        <Plus /> Add rule
      </Button>
    </div>
  )
}

/** The default and the rules, each from the catalog or overridden here. */
export function OverrideFields({ k, form, setForm, errors }: { k: ConfigKeyView; form: Form; setForm: (f: Form) => void; errors: Errors }) {
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch })
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Default</h3>
          <SourceSwitch label="Default source" value={form.defaultSource} onChange={(defaultSource) => set({ defaultSource })} />
        </div>
        {form.defaultSource === 'catalog' ? (
          <div className="rounded-lg border bg-muted/40 px-3 py-2">
            <ValueText value={k.catalog.default} />
          </div>
        ) : (
          <ValueEditor type={k.type} value={form.default} onChange={(v) => set({ default: v })} label="Default value" visibleLabel="Default value" error={errors.default} />
        )}
      </div>

      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">Rules</h3>
          <SourceSwitch label="Rules source" value={form.rulesSource} onChange={(rulesSource) => set({ rulesSource })} />
        </div>
        {form.rulesSource === 'catalog' ? (
          <CatalogRules rules={k.catalog.rules} />
        ) : (
          <RulesEditor
            type={k.type}
            rules={form.rules}
            onChange={(rules) => set({ rules })}
            errors={errors}
            newValue={form.defaultSource === 'override' ? form.default : valueText(k.type, k.catalog.default)}
          />
        )}
        <p className="text-xs text-muted-foreground">Rules are read from the top; the first that matches decides. A device that matches none gets the default.</p>
      </div>
    </div>
  )
}
