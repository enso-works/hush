// Remote config's shape: what a catalog may declare under an app's `config`,
// what a dashboard override may set, and the canonical JSON the revision is
// a hash of. Pure, no database: catalog.mjs checks the catalog with it at
// boot, remote-config.mjs checks every override with it, and demo.mjs may
// use it without an import cycle.
//
// The same rules hold for the catalog and for overrides, so an override can
// never serve something the catalog could not have declared. The device's
// evaluator (evaluate.mjs) reads far more loosely than this: it skips what
// it cannot read. These checks are what keeps a server from sending such a
// thing in the first place.
import { createHash } from 'node:crypto';

import { WHEN_FIELDS } from './evaluate.mjs';

export const CONFIG_LIMITS = {
  keys: 100,
  rules: 20,
  string_chars: 2000,
  json_bytes: 8192,
  total_bytes: 65536,
  note_chars: 200,
};
const JSON_DEPTH = 32;
const LIST_MAX = { platform: 10, channel: 10, language: 50 };
const RANGE_CHARS = 64;
// A version is three whole numbers, each up to nine digits (evaluate.mjs).
const PART_MAX = 999_999_999;

export const TYPES = ['bool', 'number', 'string', 'json'];
export const KEY_NAME = /^[a-z][a-z0-9_]{1,63}$/;
const LABEL = /^[a-z][a-z0-9_]{0,23}$/;
const LANGUAGE = /^[a-z]{2,3}$/;
const COMPARATOR = /^(>=|<=|>|<|=)(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/;

const KEY_FIELDS = ['type', 'default', 'description', 'rules'];
const RULE_FIELDS = ['when', 'rollout', 'value', 'note'];

const MESSAGES = {
  bool: 'expected true or false',
  number: 'expected a number',
  string: `expected text of up to ${CONFIG_LIMITS.string_chars} characters`,
  json: `expected an object or an array, up to ${CONFIG_LIMITS.json_bytes / 1024} KB as JSON and ${JSON_DEPTH} levels deep`,
};
const BAD_TEXT = 'text may not contain a NUL character or a lone surrogate';
const LIST_MESSAGES = {
  platform: 'expected a list of 1 to 10 platforms, such as ios, android, web',
  channel: 'expected a list of 1 to 10 channels, such as app_store, testflight',
  language: 'expected a list of 1 to 50 languages, such as en, de, pt',
};
const RANGE_MESSAGE = 'expected a range such as ">=2.1.0 <3": >=, >, <=, < or = and a version, separated by spaces';

/** A validation failure: where (relative to what was being checked) and why. */
export class ConfigError extends Error {
  constructor(path, message) {
    super(path ? `${path}: ${message}` : message);
    this.path = path;
    this.detail = message;
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const at = (base, seg) => (seg.startsWith('[') ? `${base}${seg}` : base ? `${base}.${seg}` : seg);

// Postgres refuses U+0000 in text and jsonb, and an unpaired surrogate in
// jsonb: a value holding one would make every history row for its key fail.
const BAD_CHARS = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const badString = (s) => BAD_CHARS.test(s);

/** Depth of a json value, the outer object or array being 1; stops counting past `limit`, so a hostile value never recurses deep. */
function depthOver(value, limit) {
  const walk = (v, d) => {
    if (typeof v !== 'object' || v === null) return false;
    if (d > limit) return true;
    for (const x of Array.isArray(v) ? v : Object.values(v)) if (walk(x, d + 1)) return true;
    return false;
  };
  return walk(value, 1);
}

/** True when any string in a json value, key or value, at any depth, is one Postgres would refuse. */
function badJsonText(v) {
  if (typeof v === 'string') return badString(v);
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return v.some(badJsonText);
  return Object.entries(v).some(([k, x]) => badString(k) || badJsonText(x));
}

/**
 * A value of the type, or a ConfigError at `path`. No coercion: "1" is not a
 * number, 0 is not false, null is no type's value, json is an object or an
 * array.
 */
export function checkValue(type, value, path) {
  switch (type) {
    case 'bool':
      if (typeof value !== 'boolean') throw new ConfigError(path, MESSAGES.bool);
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new ConfigError(path, MESSAGES.number);
      return value;
    case 'string':
      if (typeof value !== 'string' || value.length > CONFIG_LIMITS.string_chars) throw new ConfigError(path, MESSAGES.string);
      if (badString(value)) throw new ConfigError(path, BAD_TEXT);
      return value;
    case 'json':
      // Depth first: measuring the size of a value nested thousands deep
      // would overflow the stack before it could be refused.
      if (typeof value !== 'object' || value === null || depthOver(value, JSON_DEPTH)) throw new ConfigError(path, MESSAGES.json);
      if (Buffer.byteLength(JSON.stringify(value)) > CONFIG_LIMITS.json_bytes) throw new ConfigError(path, MESSAGES.json);
      if (badJsonText(value)) throw new ConfigError(path, BAD_TEXT);
      return value;
    default:
      throw new ConfigError(path, 'bool, number, string or json');
  }
}

/** Optional trimmed text up to 200 characters: undefined when missing or empty. */
function checkNote(value, path) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ConfigError(path, `up to ${CONFIG_LIMITS.note_chars} characters`);
  const t = value.trim();
  if (t.length > CONFIG_LIMITS.note_chars) throw new ConfigError(path, `up to ${CONFIG_LIMITS.note_chars} characters`);
  if (badString(t)) throw new ConfigError(path, BAD_TEXT);
  return t || undefined;
}

function checkList(field, value, path) {
  const ok = Array.isArray(value) && value.length >= 1 && value.length <= LIST_MAX[field]
    && value.every((x) => typeof x === 'string' && (field === 'language' ? LANGUAGE : LABEL).test(x));
  if (!ok) throw new ConfigError(path, LIST_MESSAGES[field]);
  return [...new Set(value)];
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const MAX = [PART_MAX, PART_MAX, PART_MAX];
// The next and previous versions, or null past either end.
const next = ([a, b, c]) => (c < PART_MAX ? [a, b, c + 1] : b < PART_MAX ? [a, b + 1, 0] : a < PART_MAX ? [a + 1, 0, 0] : null);
const prev = ([a, b, c]) => (c > 0 ? [a, b, c - 1] : b > 0 ? [a, b - 1, PART_MAX] : a > 0 ? [a - 1, PART_MAX, PART_MAX] : null);

/**
 * A version range the evaluator reads, minus two it reads but nobody means:
 * `=2.1` (2.1.0 only, not every 2.1 release) and a range no version is in.
 */
function checkRange(value, path) {
  if (typeof value !== 'string' || value.length > RANGE_CHARS || !value.trim()) throw new ConfigError(path, RANGE_MESSAGE);
  const parts = value.trim().split(/\s+/).map((p) => COMPARATOR.exec(p));
  if (parts.some((m) => !m)) throw new ConfigError(path, RANGE_MESSAGE);
  const short = parts.find((m) => m[1] === '=' && m[4] === undefined);
  if (short) {
    const [, , major, minor] = short;
    throw new ConfigError(path, minor === undefined
      ? `"=${major}" matches ${major}.0.0 only: write =${major}.0.0, or >=${major} <${Number(major) + 1} for every ${major}.x release`
      : `"=${major}.${minor}" matches ${major}.${minor}.0 only: write =${major}.${minor}.0, or >=${major}.${minor} <${major}.${Number(minor) + 1} for every ${major}.${minor} release`);
  }
  // The versions the range allows, as one interval [low, high].
  let low = [0, 0, 0];
  let high = MAX;
  let empty = false;
  for (const m of parts) {
    const v = [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)];
    const lo = m[1] === '>=' || m[1] === '=' ? v : m[1] === '>' ? next(v) : undefined;
    const hi = m[1] === '<=' || m[1] === '=' ? v : m[1] === '<' ? prev(v) : undefined;
    if (lo === null || hi === null) empty = true;
    if (lo && cmp(lo, low) > 0) low = lo;
    if (hi && cmp(hi, high) < 0) high = hi;
  }
  if (empty || cmp(low, high) > 0) throw new ConfigError(path, 'no version satisfies this range');
  return value.trim();
}

function checkWhen(raw, path) {
  if (raw === undefined) return {};
  if (!isObject(raw)) throw new ConfigError(path, 'expected an object of conditions');
  const unknown = Object.keys(raw).find((f) => !WHEN_FIELDS.includes(f));
  if (unknown !== undefined) throw new ConfigError(path, `unknown condition "${unknown}"; platform, version, channel, language or pro`);
  const out = {};
  // The field order of the normalized form, so equal rules canonicalize and
  // print alike.
  for (const field of WHEN_FIELDS) {
    if (!has(raw, field)) continue;
    const p = at(path, field);
    if (field === 'version') out.version = checkRange(raw.version, p);
    else if (field === 'pro') {
      if (typeof raw.pro !== 'boolean') throw new ConfigError(p, 'expected true or false');
      out.pro = raw.pro;
    } else out[field] = checkList(field, raw[field], p);
  }
  return out;
}

/** A key's rules in normalized form, notes kept: [{ when, rollout, value, note? }]. */
export function checkRules(type, raw, path) {
  if (!Array.isArray(raw) || raw.length > CONFIG_LIMITS.rules) throw new ConfigError(path, `expected a list of up to ${CONFIG_LIMITS.rules} rules`);
  return raw.map((rule, i) => {
    const p = at(path, `[${i}]`);
    if (!isObject(rule)) throw new ConfigError(p, 'expected an object with a value');
    const unknown = Object.keys(rule).find((f) => !RULE_FIELDS.includes(f));
    if (unknown !== undefined) throw new ConfigError(p, `unknown field "${unknown}"; a rule has when, rollout, value and note`);
    if (!has(rule, 'value') || rule.value === undefined) throw new ConfigError(at(p, 'value'), 'required');
    const value = checkValue(type, rule.value, at(p, 'value'));
    const when = checkWhen(rule.when, at(p, 'when'));
    const rollout = rule.rollout === undefined ? 100 : rule.rollout;
    if (!Number.isInteger(rollout) || rollout < 0 || rollout > 100) throw new ConfigError(at(p, 'rollout'), 'a whole number from 0 to 100');
    const note = checkNote(rule.note, at(p, 'note'));
    return { when, rollout, value, ...(note === undefined ? {} : { note }) };
  });
}

/** One catalog key: { type, default, description, rules }. */
function checkKey(raw, path) {
  if (!isObject(raw)) throw new ConfigError(path, 'expected an object with type, default and description');
  const unknown = Object.keys(raw).find((f) => !KEY_FIELDS.includes(f));
  if (unknown !== undefined) throw new ConfigError(path, `unknown field "${unknown}"; a key has type, default, description and rules`);
  if (!TYPES.includes(raw.type)) throw new ConfigError(at(path, 'type'), 'bool, number, string or json');
  if (!has(raw, 'default') || raw.default === undefined) throw new ConfigError(at(path, 'default'), 'required');
  const value = checkValue(raw.type, raw.default, at(path, 'default'));
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description || description.length > CONFIG_LIMITS.note_chars) throw new ConfigError(at(path, 'description'), `required, 1 to ${CONFIG_LIMITS.note_chars} characters`);
  if (badString(description)) throw new ConfigError(at(path, 'description'), BAD_TEXT);
  const rules = raw.rules === undefined ? [] : checkRules(raw.type, raw.rules, at(path, 'rules'));
  return { type: raw.type, default: value, description, rules };
}

/**
 * An app's catalog `config`, normalized and sorted by key, or a thrown
 * Error("<path>: <message>") that stops the boot. `path` is
 * `catalog.<app>.config`.
 */
export function parseConfig(raw, path) {
  if (raw == null) return {};
  try {
    if (!isObject(raw)) throw new ConfigError(path, 'expected an object keyed by config key');
    const names = Object.keys(raw);
    if (names.length > CONFIG_LIMITS.keys) throw new ConfigError(path, `up to ${CONFIG_LIMITS.keys} keys`);
    const bad = names.find((k) => !KEY_NAME.test(k));
    if (bad !== undefined) throw new ConfigError(`${path}[${JSON.stringify(bad)}]`, 'not a key name: a-z, 0-9 and _, starting with a letter, 2 to 64 characters');
    const out = {};
    for (const key of names.sort()) out[key] = checkKey(raw[key], `${path}.${key}`);
    const bytes = sizeOf(wireKeys(out));
    if (bytes > CONFIG_LIMITS.total_bytes) throw new ConfigError(path, `${Math.ceil(bytes / 1024)} KB as JSON; the limit is 64 KB`);
    return out;
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(err.message);
    throw err;
  }
}

/**
 * A dashboard override for a key of `type`: { default?, rules? } normalized,
 * or a thrown ConfigError with a path relative to the key (`default`,
 * `rules[1].when.version`). `prefix` goes before every path (`draft.`).
 */
export function parseOverride(body, type, prefix = '') {
  const out = {};
  if (has(body, 'default')) out.default = checkValue(type, body.default, `${prefix}default`);
  if (has(body, 'rules')) out.rules = checkRules(type, body.rules, `${prefix}rules`);
  return out;
}

/** The change note on a write: trimmed, or undefined when missing or empty. */
export const parseNote = (value) => checkNote(value, 'note');

/** Rules as served: no notes. */
export const wireRules = (rules) => rules.map(({ when, rollout, value }) => ({ when, rollout, value }));

/** Entries keyed by key ({ type, default, rules }, notes allowed) in wire form, sorted by key. */
export function wireKeys(entries) {
  const out = {};
  for (const key of Object.keys(entries).sort()) {
    const e = entries[key];
    out[key] = { type: e.type, default: e.default, rules: wireRules(e.rules) };
  }
  return out;
}

/** JSON with every object's keys sorted, no whitespace: the same text for equal values, whatever order their keys came in. */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (typeof v === 'object' && v !== null) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Bytes of a value's canonical JSON. */
export const sizeOf = (v) => Buffer.byteLength(canonical(v));

/** The revision of a /v1/config answer, given without config.revision: 16 hex characters of its canonical JSON's sha256. */
export const revisionOf = (answer) => createHash('sha256').update(canonical(answer)).digest('hex').slice(0, 16);
