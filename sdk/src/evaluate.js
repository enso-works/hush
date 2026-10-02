// @ts-check
/**
 * hush remote config: which value a device gets for a key. The one
 * implementation, run on the device by the SDK and on the server by the
 * dashboard's "preview as". The server's copy, src/evaluate.mjs, is this file
 * byte for byte (test/config-eval.test.mjs checks), so the two can never
 * disagree; edit this one and copy it over.
 *
 * Plain JavaScript with JSDoc types, no imports: the server runs it as it is,
 * and the SDK's TypeScript build checks and compiles it with the rest.
 *
 * The input is untrusted JSON (a cache on the device, a newer server's
 * answer), so nothing here assumes a shape: a rule this version cannot read
 * never matches, and the next rule or the default decides. A newer server may
 * send a condition an older SDK does not know; skipping that rule is the only
 * safe reading of it.
 */

/** @typedef {'bool' | 'number' | 'string' | 'json'} ConfigType */

/**
 * What a rule may ask about the device. Lists match any of their entries;
 * every condition present must hold.
 * @typedef {{ platform?: string[], version?: string, channel?: string[], language?: string[], pro?: boolean }} ConfigWhen
 */

/** @typedef {{ when?: ConfigWhen, rollout?: number, value: unknown }} ConfigRule */

/** @typedef {{ type: ConfigType, default: unknown, rules?: ConfigRule[] }} ConfigEntry */

/**
 * What the device knows about itself. A field that is missing, empty or of
 * the wrong type is unknown, and a condition on an unknown field does not
 * hold. `language` is a language ("de") or a locale ("de-AT", "pt_BR").
 * @typedef {{ platform?: string | null, version?: string | null, channel?: string | null, language?: string | null, pro?: boolean | null }} ConfigContext
 */

/**
 * The outcome for one key: the index of the rule that decided it, or -1 for
 * the default. `value` is missing when nothing usable decided it (an unknown
 * type, a default of the wrong type and no rule that matched).
 * @typedef {{ rule: number, value?: unknown }} ConfigEvaluation
 */

/** The conditions this version understands. */
export const WHEN_FIELDS = ['platform', 'version', 'channel', 'language', 'pro'];

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether a value is one of the type's: no coercion, ever. A "1" is not a
 * number and a 0 is not false; json is an object or an array.
 * @param {unknown} type
 * @param {unknown} value
 * @returns {boolean}
 */
export function conforms(type, value) {
  switch (type) {
    case 'bool':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'json':
      return typeof value === 'object' && value !== null;
    default:
      return false;
  }
}

/** @param {string} s @returns {number[]} */
function utf8(s) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    // A lone surrogate becomes U+FFFD, as TextEncoder writes it.
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

/**
 * The install's place in a key's rollouts, 0 to 99: FNV-1a over the UTF-8 of
 * `<install>:<key>`, then murmur3's finalizer so the low digits are as mixed
 * as the high ones. Stable for an install and a key; different keys put the
 * same install in unrelated places. Raising a rollout from 10 to 20 keeps the
 * first 10 in it.
 * @param {string} install
 * @param {string} key
 * @returns {number}
 */
export function bucket(install, key) {
  let h = 0x811c9dc5;
  for (const b of utf8(`${install}:${key}`)) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) % 100;
}

const VERSION = /^(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:[-+].*)?$/;
const COMPARATOR = /^(>=|<=|>|<|=)(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?$/;

/**
 * An app version as three numbers, missing parts 0, or null. A pre-release
 * or build suffix ("2.1.0-beta.1", "2.1.0+45") is ignored: 2.1.0-beta.1 is
 * 2.1.0 here.
 * @param {unknown} version
 * @returns {number[] | null}
 */
export function parseVersion(version) {
  if (typeof version !== 'string') return null;
  const m = VERSION.exec(version.trim());
  return m ? [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)] : null;
}

/**
 * A range: comparators separated by spaces, all of which must hold. Each is
 * an operator (>=, >, <=, <, =) and a version of one to three numbers, the
 * missing ones 0 (`<3` is `<3.0.0`, `=2.1` is `=2.1.0`). Null when any part
 * is not one.
 * @param {unknown} range
 * @returns {{ op: string, v: number[] }[] | null}
 */
export function parseRange(range) {
  if (typeof range !== 'string' || !range.trim()) return null;
  /** @type {{ op: string, v: number[] }[]} */
  const out = [];
  for (const part of range.trim().split(/\s+/)) {
    const m = COMPARATOR.exec(part);
    if (!m) return null;
    out.push({ op: m[1], v: [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)] });
  }
  return out;
}

/** @param {number[]} a @param {number[]} b @returns {number} */
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * True when the version is in the range; false when either cannot be read.
 * @param {unknown} version
 * @param {unknown} range
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const v = parseVersion(version);
  const r = parseRange(range);
  if (!v || !r) return false;
  return r.every(({ op, v: w }) => {
    const c = compare(v, w);
    return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0;
  });
}

/**
 * The language of a language or locale tag, lowercase: "pt" of "pt-BR" or
 * "pt_BR". Null for anything that does not start with two or three letters.
 * @param {unknown} tag
 * @returns {string | null}
 */
export function languageOf(tag) {
  if (typeof tag !== 'string') return null;
  const m = /^([A-Za-z]{2,3})(?:[-_]|$)/.exec(tag.trim());
  return m ? m[1].toLowerCase() : null;
}

/** @param {unknown} v @returns {string | null} */
const known = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

/**
 * A list condition: the device's value is one of the list's. An empty list,
 * a list with anything but strings, or an unknown value: false.
 * @param {unknown} list
 * @param {string | null} value
 * @returns {boolean}
 */
function inList(list, value) {
  if (!Array.isArray(list) || list.length === 0 || !list.every((x) => typeof x === 'string')) return false;
  return value !== null && list.includes(value);
}

/**
 * Whether one rule's conditions and rollout hold for this device. `place` is
 * the install's bucket for the key, or null when there is no install (then
 * only a rollout of 100 holds).
 * @param {unknown} rule
 * @param {ConfigContext} context
 * @param {number | null} place
 * @returns {boolean}
 */
export function ruleMatches(rule, context, place) {
  if (!isObject(rule) || !Object.prototype.hasOwnProperty.call(rule, 'value')) return false;
  const rollout = rule.rollout === undefined ? 100 : rule.rollout;
  if (typeof rollout !== 'number' || !Number.isInteger(rollout) || rollout < 0 || rollout > 100) return false;
  const when = rule.when === undefined ? {} : rule.when;
  if (!isObject(when)) return false;
  /** @type {ConfigContext} */
  const ctx = isObject(context) ? context : {};
  for (const [field, condition] of Object.entries(when)) {
    let holds = false;
    if (field === 'platform') holds = inList(condition, known(ctx.platform));
    else if (field === 'channel') holds = inList(condition, known(ctx.channel));
    else if (field === 'language') holds = inList(condition, languageOf(ctx.language));
    else if (field === 'version') holds = satisfies(ctx.version, condition);
    else if (field === 'pro') holds = typeof condition === 'boolean' && typeof ctx.pro === 'boolean' && ctx.pro === condition;
    // Anything else is a condition from a later version: unreadable, so the rule is skipped.
    if (!holds) return false;
  }
  if (rollout === 100) return true;
  return place !== null && Number.isInteger(place) && place >= 0 && place < rollout;
}

/**
 * One key for one device: the first rule that matches, with a value of the
 * key's type, decides; otherwise the default. A rule whose value is of
 * another type is skipped like one that does not match.
 * @param {unknown} entry
 * @param {ConfigContext} context
 * @param {number | null} place
 * @returns {ConfigEvaluation}
 */
export function evaluate(entry, context, place) {
  if (!isObject(entry) || !['bool', 'number', 'string', 'json'].includes(/** @type {string} */ (entry.type))) return { rule: -1 };
  const rules = Array.isArray(entry.rules) ? entry.rules : [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (ruleMatches(rule, context, place) && conforms(entry.type, /** @type {{ value: unknown }} */ (rule).value)) {
      return { rule: i, value: /** @type {{ value: unknown }} */ (rule).value };
    }
  }
  return conforms(entry.type, entry.default) ? { rule: -1, value: entry.default } : { rule: -1 };
}

/**
 * Every key of a config's `keys` for one device, each with its own bucket.
 * `install` null: no buckets, so only rollouts of 100 hold.
 * @param {unknown} keys
 * @param {ConfigContext} context
 * @param {string | null} install
 * @returns {Record<string, ConfigEvaluation>}
 */
export function evaluateAll(keys, context, install) {
  /** @type {Record<string, ConfigEvaluation>} */
  const out = {};
  if (!isObject(keys)) return out;
  for (const [key, entry] of Object.entries(keys)) {
    out[key] = evaluate(entry, context, typeof install === 'string' && install ? bucket(install, key) : null);
  }
  return out;
}
