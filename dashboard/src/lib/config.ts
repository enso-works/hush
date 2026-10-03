// Remote config on the client: the checks a form runs before it lets you
// save, the drafts the editor works on, and how values and rules read.
//
// The checks repeat the server's (src/config-schema.mjs) with the same
// messages, so a mistake shows next to its field before a request is made.
// The server stays the authority: whatever it answers is shown too.
import type { ConfigKeyView, ConfigRule, ConfigType, ConfigWhen } from './api'

export const LIMITS = { rules: 20, string_chars: 2000, json_bytes: 8192, json_depth: 32, note_chars: 200 }

export const MESSAGES = {
  bool: 'expected true or false',
  number: 'expected a number',
  string: 'expected text of up to 2000 characters',
  json: 'expected an object or an array, up to 8 KB as JSON and 32 levels deep',
  text: 'text may not contain a NUL character or a lone surrogate',
  range: 'expected a range such as ">=2.1.0 <3": >=, >, <=, < or = and a version, separated by spaces',
  empty: 'no version satisfies this range',
  rollout: 'a whole number from 0 to 100',
  note: 'up to 200 characters',
  platform: 'expected a list of 1 to 10 platforms, such as ios, android, web',
  channel: 'expected a list of 1 to 10 channels, such as app_store, testflight',
  language: 'expected a list of 1 to 50 languages, such as en, de, pt',
} as const

// Postgres refuses U+0000 and a lone surrogate, so the server does too.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/
const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/
const LABEL = /^[a-z][a-z0-9_]{0,23}$/
const LANGUAGE = /^[a-z]{2,3}$/
const COMPARATOR = /^(>=|<=|>|<|=)(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/
const PART_MAX = 999_999_999
const LIST_MAX = { platform: 10, channel: 10, language: 50 } as const
export type ListField = keyof typeof LIST_MAX

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string) => ({ ok: false, error }) as const
const pass = <T,>(value: T) => ({ ok: true, value }) as const

function depthOver(value: unknown, limit: number) {
  const walk = (v: unknown, d: number): boolean => {
    if (typeof v !== 'object' || v === null) return false
    if (d > limit) return true
    return (Array.isArray(v) ? v : Object.values(v)).some((x) => walk(x, d + 1))
  }
  return walk(value, 1)
}

function badJsonText(v: unknown): boolean {
  if (typeof v === 'string') return BAD_CHARS.test(v)
  if (typeof v !== 'object' || v === null) return false
  if (Array.isArray(v)) return v.some(badJsonText)
  return Object.entries(v).some(([k, x]) => BAD_CHARS.test(k) || badJsonText(x))
}

/** Whether a value already parsed is one of the type's (a stored override, a history entry). */
export function conforms(type: ConfigType, value: unknown): boolean {
  switch (type) {
    case 'bool':
      return typeof value === 'boolean'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'string':
      return typeof value === 'string' && value.length <= LIMITS.string_chars && !BAD_CHARS.test(value)
    case 'json':
      return (
        typeof value === 'object' &&
        value !== null &&
        !depthOver(value, LIMITS.json_depth) &&
        new TextEncoder().encode(JSON.stringify(value)).length <= LIMITS.json_bytes &&
        !badJsonText(value)
      )
  }
}

/** The text an editor holds for a value: bool "true"/"false", a number as written, a string as is, json indented. */
export function valueText(type: ConfigType, value: unknown) {
  if (type === 'string') return typeof value === 'string' ? value : ''
  if (type === 'json') return JSON.stringify(value, null, 2) ?? ''
  return String(value)
}

/** An editor's text read as a value of the type, with the server's message when it is not one. */
export function parseValue(type: ConfigType, text: string): Checked<unknown> {
  switch (type) {
    case 'bool':
      return text === 'true' ? pass(true) : text === 'false' ? pass(false) : fail(MESSAGES.bool)
    case 'number': {
      const t = text.trim()
      if (!NUMBER.test(t) || !Number.isFinite(Number(t))) return fail(MESSAGES.number)
      return pass(Number(t))
    }
    case 'string':
      if (text.length > LIMITS.string_chars) return fail(MESSAGES.string)
      if (BAD_CHARS.test(text)) return fail(MESSAGES.text)
      return pass(text)
    case 'json': {
      let v: unknown
      try {
        v = JSON.parse(text)
      } catch (err) {
        return fail(`not JSON: ${(err as Error).message}`)
      }
      if (typeof v !== 'object' || v === null || depthOver(v, LIMITS.json_depth)) return fail(MESSAGES.json)
      if (new TextEncoder().encode(JSON.stringify(v)).length > LIMITS.json_bytes) return fail(MESSAGES.json)
      if (badJsonText(v)) return fail(MESSAGES.text)
      return pass(v)
    }
  }
}

/** A list field's text split on commas and spaces, lowercased, duplicates dropped. */
export const splitList = (text: string) => [...new Set(text.toLowerCase().split(/[\s,]+/).filter(Boolean))]

export function parseList(field: ListField, text: string): Checked<string[] | undefined> {
  const items = splitList(text)
  if (!items.length) return pass(undefined)
  const pattern = field === 'language' ? LANGUAGE : LABEL
  if (items.length > LIST_MAX[field] || !items.every((x) => pattern.test(x))) return fail(MESSAGES[field])
  return pass(items)
}

type V = [number, number, number]
const cmp = (a: V, b: V) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
const next = ([a, b, c]: V): V | null => (c < PART_MAX ? [a, b, c + 1] : b < PART_MAX ? [a, b + 1, 0] : a < PART_MAX ? [a + 1, 0, 0] : null)
const prev = ([a, b, c]: V): V | null => (c > 0 ? [a, b, c - 1] : b > 0 ? [a, b - 1, PART_MAX] : a > 0 ? [a - 1, PART_MAX, PART_MAX] : null)

/**
 * A version range as the device reads it, minus the two the server refuses:
 * `=2.1` (2.1.0 only, which nobody means) and a range no version is in.
 * Empty text is no condition.
 */
export function parseRange(text: string): Checked<string | undefined> {
  const t = text.trim()
  if (!t) return pass(undefined)
  if (t.length > 64) return fail(MESSAGES.range)
  const parts = t.split(/\s+/).map((p) => COMPARATOR.exec(p))
  if (parts.some((m) => !m)) return fail(MESSAGES.range)
  const ms = parts as RegExpExecArray[]
  const short = ms.find((m) => m[1] === '=' && m[4] === undefined)
  if (short) {
    const [, , major, minor] = short
    return fail(
      minor === undefined
        ? `"=${major}" matches ${major}.0.0 only: write =${major}.0.0, or >=${major} <${Number(major) + 1} for every ${major}.x release`
        : `"=${major}.${minor}" matches ${major}.${minor}.0 only: write =${major}.${minor}.0, or >=${major}.${minor} <${major}.${Number(minor) + 1} for every ${major}.${minor} release`,
    )
  }
  let low: V = [0, 0, 0]
  let high: V = [PART_MAX, PART_MAX, PART_MAX]
  let empty = false
  for (const m of ms) {
    const v: V = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]
    const lo = m[1] === '>=' || m[1] === '=' ? v : m[1] === '>' ? next(v) : undefined
    const hi = m[1] === '<=' || m[1] === '=' ? v : m[1] === '<' ? prev(v) : undefined
    if (lo === null || hi === null) empty = true
    if (lo && cmp(lo, low) > 0) low = lo
    if (hi && cmp(hi, high) < 0) high = hi
  }
  if (empty || cmp(low, high) > 0) return fail(MESSAGES.empty)
  return pass(t)
}

export function parseRollout(text: string): Checked<number> {
  const t = text.trim()
  if (!/^\d{1,3}$/.test(t) || Number(t) > 100) return fail(MESSAGES.rollout)
  return pass(Number(t))
}

export function parseNote(text: string): Checked<string | undefined> {
  const t = text.trim()
  if (t.length > LIMITS.note_chars) return fail(MESSAGES.note)
  if (BAD_CHARS.test(t)) return fail(MESSAGES.text)
  return pass(t || undefined)
}

// --- Drafts: what the editor holds, as text, until it is saved.

export type Paid = 'any' | 'pro' | 'free'
export type RuleDraft = {
  /** Stable across moves, for React's keys. */
  id: number
  platform: string
  version: string
  channel: string
  language: string
  pro: Paid
  rollout: string
  value: string
  note: string
}
export type Source = 'catalog' | 'override'
export type Form = { defaultSource: Source; default: string; rulesSource: Source; rules: RuleDraft[]; note: string }

let ids = 0
export const nextId = () => ++ids

export function ruleDraft(type: ConfigType, r: ConfigRule): RuleDraft {
  return {
    id: nextId(),
    platform: (r.when.platform ?? []).join(', '),
    version: r.when.version ?? '',
    channel: (r.when.channel ?? []).join(', '),
    language: (r.when.language ?? []).join(', '),
    pro: r.when.pro === true ? 'pro' : r.when.pro === false ? 'free' : 'any',
    rollout: String(r.rollout),
    value: valueText(type, r.value),
    note: r.note ?? '',
  }
}

/** The parts of an override, as a history entry or the stored one has them. */
export type Parts = { default?: unknown; rules?: ConfigRule[] }
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)

/** A form that starts from `parts` (sources follow its parts), the rest from what is served. */
export function formFrom(k: ConfigKeyView, parts: Parts | null): Form {
  const d = parts && has(parts, 'default')
  const r = parts && has(parts, 'rules')
  return {
    defaultSource: d ? 'override' : 'catalog',
    default: valueText(k.type, d ? parts.default : k.effective.default),
    rulesSource: r ? 'override' : 'catalog',
    rules: (r ? parts.rules! : k.effective.rules).map((x) => ruleDraft(k.type, x)),
    note: '',
  }
}

/**
 * The form a key page opens with. An override that no longer fits the
 * key's type never reaches a type's editor: both sources start on the
 * catalog. One that fits (served, or stale) starts as stored.
 */
export function initialForm(k: ConfigKeyView): Form {
  if (!k.fits) return formFrom(k, null)
  return formFrom(k, k.override)
}

/** Whether every part of an override's value fits the key's type (the client checks), for "Load into the editor". */
export function partsFit(type: ConfigType, parts: Parts | null) {
  if (!parts) return false
  if (has(parts, 'default') && !conforms(type, parts.default)) return false
  if (has(parts, 'rules') && !(Array.isArray(parts.rules) && parts.rules.every((r) => conforms(type, r.value)))) return false
  return true
}

/** Every field's message, keyed by the path the server would name it with. */
export type Errors = Record<string, string>

export type FormRead = { errors: Errors; override: Parts | null }

/** The form read as an override ({ default?, rules? } with notes; null when both sources are the catalog), and every field's error. */
export function readForm(type: ConfigType, f: Form): FormRead {
  const errors: Errors = {}
  const out: Parts = {}
  if (f.defaultSource === 'override') {
    const v = parseValue(type, f.default)
    if (v.ok) out.default = v.value
    else errors.default = v.error
  }
  if (f.rulesSource === 'override') {
    if (f.rules.length > LIMITS.rules) errors.rules = `expected a list of up to ${LIMITS.rules} rules`
    out.rules = f.rules.map((r, i) => {
      const p = `rules[${i}]`
      const when: ConfigWhen = {}
      const platform = parseList('platform', r.platform)
      if (!platform.ok) errors[`${p}.when.platform`] = platform.error
      else if (platform.value) when.platform = platform.value
      const version = parseRange(r.version)
      if (!version.ok) errors[`${p}.when.version`] = version.error
      else if (version.value) when.version = version.value
      const channel = parseList('channel', r.channel)
      if (!channel.ok) errors[`${p}.when.channel`] = channel.error
      else if (channel.value) when.channel = channel.value
      const language = parseList('language', r.language)
      if (!language.ok) errors[`${p}.when.language`] = language.error
      else if (language.value) when.language = language.value
      if (r.pro !== 'any') when.pro = r.pro === 'pro'
      const rollout = parseRollout(r.rollout)
      if (!rollout.ok) errors[`${p}.rollout`] = rollout.error
      const value = parseValue(type, r.value)
      if (!value.ok) errors[`${p}.value`] = value.error
      const note = parseNote(r.note)
      if (!note.ok) errors[`${p}.note`] = note.error
      return {
        when,
        rollout: rollout.ok ? rollout.value : 100,
        value: value.ok ? value.value : null,
        ...(note.ok && note.value !== undefined ? { note: note.value } : {}),
      }
    })
  }
  const note = parseNote(f.note)
  if (!note.ok) errors.note = note.error
  const override = f.defaultSource === 'catalog' && f.rulesSource === 'catalog' ? null : out
  return { errors, override }
}

const WHEN_ORDER = ['platform', 'version', 'channel', 'language', 'pro'] as const

/** Parts in the server's normalized form, so two equal overrides compare equal whatever order their fields came in. */
export function normalized(parts: Parts | null): Parts | null {
  if (!parts) return null
  const out: Parts = {}
  if (has(parts, 'default')) out.default = parts.default
  if (has(parts, 'rules') && parts.rules) {
    out.rules = parts.rules.map((r) => ({
      when: Object.fromEntries(WHEN_ORDER.filter((f) => r.when && has(r.when, f)).map((f) => [f, r.when[f]])),
      rollout: r.rollout ?? 100,
      value: r.value,
      ...(r.note ? { note: r.note } : {}),
    }))
  }
  return out
}

/** JSON with every object's keys sorted: the same text for equal values. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (typeof v === 'object' && v !== null) {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'undefined'
}

export const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)

/** The stored override's parts (no note, no time), or null. */
export const storedParts = (k: ConfigKeyView): Parts | null => {
  if (!k.override) return null
  const { note: _n, updated_at: _u, ...parts } = k.override
  return parts
}

// --- How values and rules read (lists, summaries, history).

/** A value as one line: bool and number as is, a string in quotes, json compact. */
export function formatValue(value: unknown) {
  if (value === undefined) return '–'
  return typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value))
}

export const truncate = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** The conditions and rollout of a rule: `ios · >=1.4.0 · 50%`, or `everyone`. */
function conditions(when: ConfigWhen, rollout: number) {
  const parts: string[] = []
  if (when.platform?.length) parts.push(when.platform.join(', '))
  if (when.version) parts.push(when.version)
  if (when.channel?.length) parts.push(when.channel.join(', '))
  if (when.language?.length) parts.push(when.language.join(', '))
  if (when.pro !== undefined) parts.push(when.pro ? 'pro' : 'free')
  if (rollout < 100) parts.push(`${rollout}%`)
  return parts.length ? parts.join(' · ') : 'everyone'
}

/** `ios · >=1.4.0 · 50% → "b"`; no conditions at 100%: `everyone → "b"`. */
export const ruleSummary = (r: ConfigRule) => `${conditions(r.when, r.rollout)} → ${truncate(formatValue(r.value))}`

/** The summary of a rule being edited: what reads already, the rest as typed. */
export function draftSummary(type: ConfigType, r: RuleDraft) {
  const value = parseValue(type, r.value)
  const rollout = parseRollout(r.rollout)
  const when: ConfigWhen = {}
  const platform = splitList(r.platform)
  const channel = splitList(r.channel)
  const language = splitList(r.language)
  if (platform.length) when.platform = platform
  if (r.version.trim()) when.version = r.version.trim()
  if (channel.length) when.channel = channel
  if (language.length) when.language = language
  if (r.pro !== 'any') when.pro = r.pro === 'pro'
  return `${conditions(when, rollout.ok ? rollout.value : 100)} → ${value.ok ? truncate(formatValue(value.value)) : '…'}`
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
