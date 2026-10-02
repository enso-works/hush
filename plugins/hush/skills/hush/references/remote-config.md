# Remote config

Values an app reads at runtime and the operator changes without a release: a
feature flag, a kill switch, a number, copy per language, a staged rollout.
Values and targeting only: no experiments, no exposure events, no variant
statistics. Needs `@bavrk/hush` 2.4.0 and a hush server with migration 009.

## Contents

1. [How it fits together](#1-how-it-fits-together)
2. [The catalog: config](#2-the-catalog-config)
3. [How a device gets its value](#3-how-a-device-gets-its-value)
4. [In the app](#4-in-the-app)
5. [Patterns](#5-patterns)
6. [The dashboard](#6-the-dashboard)
7. [Privacy](#7-privacy)
8. [Troubleshooting](#8-troubleshooting)

## 1. How it fits together

- **The catalog** (git, `CATALOG_FILE`) declares every key: type, default,
  description, optional rules. Keys exist only there.
- **The dashboard** overrides a key's default, its rules or both, live. The
  overrides are in Postgres with a history. It cannot create, rename or
  delete keys, or change a type or a description.
- **`GET /v1/config`** serves every key of the app, the catalog merged with
  its valid overrides, with a revision. The same answer for every install of
  the app, prod and dev keys alike.
- **The SDK** caches the answer on the device and works out each value there,
  from what it already knows about the device.

## 2. The catalog: config

An optional `config` object in the app's catalog entry, keyed by config key:

```json
{
  "myapp": {
    "events": ["onboarding_completed"],
    "config": {
      "new_home": {
        "type": "bool",
        "default": false,
        "description": "The redesigned home screen.",
        "rules": [
          { "when": { "channel": ["testflight", "dev"] }, "value": true, "note": "Testers see it first" },
          { "when": { "platform": ["ios"], "version": ">=2.1.0" }, "rollout": 20, "value": true }
        ]
      },
      "paywall_copy": {
        "type": "string",
        "default": "Start your free week",
        "description": "The paywall headline.",
        "rules": [{ "when": { "language": ["de"] }, "value": "Eine Woche gratis" }]
      },
      "review_prompt_after": { "type": "number", "default": 3, "description": "Sessions before the app asks for a review." },
      "session_presets": { "type": "json", "default": [3, 5, 10], "description": "Session lengths on the start screen, in minutes." }
    }
  }
}
```

| Field | Rule |
|---|---|
| key name | `^[a-z][a-z0-9_]{1,63}$` (the event-name rule). Up to 100 keys. |
| `type` | Required: `bool`, `number`, `string` or `json`. |
| `default` | Required, a value of the type (below). |
| `description` | Required, trimmed, 1 to 200 characters. Dashboard only, never on the wire. |
| `rules` | Optional list of up to 20 rules, read in order. |
| rule `when` | Optional object of conditions, all of which must hold. `{}` or missing: none. |
| rule `rollout` | Optional whole number 0 to 100, default 100. |
| rule `value` | Required, a value of the key's type. |
| rule `note` | Optional, trimmed, up to 200 characters. Dashboard only, never on the wire. Empty after trimming: dropped. |
| `when.platform` | 1 to 10 names matching `^[a-z][a-z0-9_]{0,23}$` (`ios`, `android`, `web`, `macos`, `windows`, ...). |
| `when.version` | A range string up to 64 characters: `>=`, `>`, `<=`, `<` or `=`, each followed by one to three numbers, parts separated by spaces (all must hold): `>=2.1.0 <3`. Refused: `=` with fewer than three numbers (`=2.1` matches 2.1.0 only, which nobody means: write `=2.1.0`, or `>=2.1 <2.2` for every 2.1 release), and a range no version satisfies (`>=3 <2`). |
| `when.channel` | 1 to 10 labels matching `^[a-z][a-z0-9_]{0,23}$` (`app_store`, `testflight`, `play`, `internal`, `dev`). |
| `when.language` | 1 to 50 codes matching `^[a-z]{2,3}$`. |
| `when.pro` | `true` or `false`. |

Any other field in a key, a rule or a `when` is an error: a misspelt `rule`
would otherwise drop every rule unseen. Duplicates in a list are dropped,
keeping the first.

Values by type, with no coercion anywhere:

| Type | Accepted | Not accepted |
|---|---|---|
| `bool` | `true`, `false` | `0`, `"true"`, `null` |
| `number` | any finite JSON number (`3`, `-0.25`, `1e3`) | `"3"`, `null` |
| `string` | a string of up to 2000 UTF-16 characters (`""` included) | numbers, `null` |
| `json` | an object or an array, up to 8192 bytes as `JSON.stringify` UTF-8, at most 32 levels deep (the outer object or array is level 1) | strings, numbers, booleans, `null`; deeper nesting |

No string anywhere (values, json keys and values, notes, descriptions) may
hold U+0000 or a lone surrogate: Postgres refuses both. Everything an app
serves (its `keys`, as canonical JSON) is at most 64 KB.

A mistake stops the boot with its path and message, like the rest of the
catalog: `catalog.myapp.config.new_home.rules[1].when.version: expected a
range such as ">=2.1.0 <3": >=, >, <=, < or = and a version, separated by
spaces`. Validate before restarting ([server.md](server.md#6-validate-a-catalog)).
The dashboard checks its overrides with the same rules.

Check by eye what validation does not: a `json` value's shape is never
checked, so the app's fallback and the catalog's default should have the
same shape; and the app reads each key with the getter of its type.

## 3. How a device gets its value

- **Context.** The SDK knows the platform, the app version, the build
  channel, the language and the paid flag. The language is the one the app
  passes (`identify({ language })`, then `remoteConfig.language`), otherwise
  the phone's first locale, reduced to its primary subtag (`pt` of
  `pt-BR`). The paid flag is what
  `identify({ pro })` gave, in this process or stored from an earlier one.
- **A rule matches** when every condition in its `when` holds and the
  install's bucket is inside its rollout. Lists match when they contain the
  device's value (platform and channel compared in lowercase).
- **Missing context never matches.** A condition on something the device
  does not know (no channel, an unreadable version, `pro` before any
  `identify()`) does not hold. `pro: false` does not match an install whose
  paid state is unknown.
- **Versions.** Compared part by part as numbers: `2.10.0` is above `2.9.0`;
  `<1` does not match `1.0.0`; missing parts are 0 (`<3` is `<3.0.0`). A
  `-beta.1` or `+42` suffix on the device's version is ignored, so
  `2.1.0-beta.1` satisfies `>=2.1.0`. `v2.1.0`, `~2.1`, `>=2.x` and a part
  without an operator are not read, and never match.
- **Rollouts.** The bucket is a hash of the install id and the key, 0 to
  99. A rule with rollout 20 takes buckets 0 to 19. Every rule of a key reads
  the same bucket, so raising 10 to 20 keeps the first 10 in, and a later
  rule's rollout overlaps an earlier one's. Different keys bucket
  independently. Rollout 0 never matches, 100 always does.
- **The first rule that matches decides**, otherwise the default.
- **Unreadable rules are skipped.** A rule with a condition this SDK does not
  know, a bad rollout, or a value of the wrong type never matches; the next
  rule or the default decides. That is how an older SDK reads a newer server.
- `forget()` gives a new install id, so rollouts re-bucket as for a new
  install.
- **When values are worked out.** When a stored config loads, a fetch brings
  a new revision, `identify()` changes the paid flag or the language,
  `forget()` gives a new install id, or `configure()` runs again. Not on a
  304, a 200 with the revision the device already has, or a getter call.
  `onChange` hears the keys whose value changed each time.

## 4. In the app

`config` is on every entry: `hush.config` from `@bavrk/hush`, and on the
object `createWebHush()` or `createHush()` returns.

```ts
import * as hush from '@/lib/hush'; // the app's hush module

hush.config.bool('new_home', false);
hush.config.number('review_prompt_after', 3);
hush.config.string('paywall_copy', 'Start your free week');
hush.config.json<number[]>('session_presets', [3, 5, 10]);
```

- **The getters never throw.** The fallback comes back when the key is not
  in the server's config, has another type, has no usable value, or nothing
  is loaded yet (remote config off, an older server, before `init()` has read
  storage). With `logLevel: 'error'`, a key not in the server's config, one
  of another type and one with no usable value log once per key and reason
  (`config "new_home" is a bool, read as string: using the fallback`);
  nothing loaded yet logs nothing.
- **Not on the first render.** Getters return their fallbacks until `init()`
  has read storage, one AsyncStorage round trip. An app that must not show a
  fallback first holds its splash screen:

  ```ts
  SplashScreen.preventAutoHideAsync(); // at module load
  hush.config.ready().then(() => SplashScreen.hideAsync());
  ```

  `ready(timeoutMs = 3000)` calls `init()` and resolves once values are
  usable: at once from the cache, and on a first launch when the first fetch
  answers or fails. It never rejects and gives up after its timeout.
- **Values that must hold for a screen or a session.** A fetch can change a
  value while a screen shows it. Read it once it is loaded, not at the first
  render: a screen mounted at launch (a root or tab screen, which Expo
  Router keeps mounted) renders before `init()` has read storage, even
  behind a held splash, so `useState(() => config.bool('new_home', false))`
  there keeps the fallback for good. Render no screen until `config.ready()`
  resolves (the root layout returns `null` until then), or latch the value
  when it is ready:

  ```tsx
  const [newHome, setNewHome] = useState<boolean | null>(null);
  useEffect(() => {
    void hush.config.ready().then(() => setNewHome(hush.config.bool('new_home', false)));
  }, []);
  if (newHome === null) return null; // a moment at most: ready() gives up after 3 s
  ```
- **In a component**, `useConfig()` (React Native entry) re-renders on any
  change. It returns a frozen object with `config`'s methods, new after each
  change and the same in between, so what a component derives from it (in
  `useMemo`, or by the React Compiler) follows a change. Read from it, not from `hush.config`: a compiled component that
  reads `hush.config` directly, or calls a helper that does, keeps its first
  values; pass the object to the helper instead.

  ```tsx
  const config = hush.useConfig();
  return config.bool('new_home', false) ? <NewHome /> : <ClassicHome />;
  ```

- **`json()`** returns an object or an array, its shape unchecked. The value
  is frozen: copy it before changing it (`[...presets].sort()`). In a
  development build the fallback is frozen too. An equal value from a later
  fetch keeps the same reference.
- **The rest:** `config.onChange((keys) => …)` whenever values are worked
  out again and some changed ([section 3](#3-how-a-device-gets-its-value);
  returns an unsubscribe);
  `config.refresh()` fetches now (`{ status, changed }`); `config.revision()`;
  `config.snapshot()` lists every key with its value, the rule that decided it
  (-1 for the default) and this install's bucket, for a debug screen.
- **Options:** `remoteConfig: false` turns it off (no config request, no
  cache, every getter returns its fallback; with an attribution bridge,
  attribution still asks `/v1/config` for its milestones on its own, as in
  2.3: at `init()` when its copy is over 12 hours old, never for an
  opted-out user). The config code stays in the bundle either way (3.5 to
  3.7 KB gzip). `{ refreshMinutes }` (default 15, 1 to 1440).
  `{ language: () => locale }`: the language the app shows, when it is not
  always the phone's first, such as the locale the i18n module resolved;
  otherwise a phone set to Catalan, then Spanish, gets the Spanish UI and the
  default copy. Read when values are worked out, which a language switch
  does not cause: after an in-app switch call `identify({ language })`,
  which works them out at once and wins over the function (`''` hands back
  to it). Neither leaves the device.
- **The web entry** takes the platform from the user agent, so an iPhone
  browser is `ios` and matches rules meant for the native app. A browser
  build that shares an app with the native one passes
  `createWebHush({ platform: 'web' })`.

**Timing and the cache.** The SDK fetches `/v1/config` at `init()`, then on
returning to the foreground and while in it, at most every `refreshMinutes`.
A request is limited to 15 s; one that fails (offline, 429, 5xx) is tried
again after 1, 2, 4 ... minutes, up to `refreshMinutes`. The answer is kept
under `<prefix>.config.v1` with the last paid flag, so the next launch starts
from it, pro rules included; a failed fetch keeps it. The SDK sends the
revision it holds as `If-None-Match`, and the server answers 304 when nothing
changed. With an attribution bridge, one request serves the conversion-value
milestones and the config. A change on the dashboard reaches a device in the
foreground within `refreshMinutes`. A device coming back to the foreground
fetches only if a fetch is due by then (`refreshMinutes` since the last);
otherwise within `refreshMinutes` of its last fetch. The cache names the
server and key it came from: another app on the same web origin with the
default prefix, or a `configure()` with another url or key, starts without
it. When `init()` cannot read the install id, the rest of the SDK stays off
for that launch, but config still loads its cache and fetches (no rollout
below 100 matches without the install id), and `refresh()` tries `init()`
again.

**An older server** answers without `config`: every getter returns its
fallback, and nothing is logged. A server rolled back to such a build keeps
the device's cached values (a kill switch set on the dashboard stays set)
until it serves config again.

**`optOut()` and `forget()`** do not stop config: the request carries nothing
the SDK adds about the user ([section 7](#7-privacy)), and an app's features
should not depend on its analytics choice. `forget()` keeps the cache, drops the stored paid flag, and gives a
new install id.

## 5. Patterns

**A feature flag.** A `bool` that defaults off, on for testers first:

```json
"new_home": { "type": "bool", "default": false, "description": "The redesigned home screen.",
  "rules": [{ "when": { "channel": ["testflight", "dev"] }, "value": true, "note": "Testers see it first" }] }
```

```ts
const showNewHome = hush.config.bool('new_home', false);
```

**A kill switch.** A `bool` that defaults on, read with a fallback of `true`
so a device that never reached the server keeps the feature. To turn it off,
override the default to `false` on the dashboard; to turn it off only for a
broken version, add a rule instead: `{ "when": { "version": ">=2.3.0
<2.3.1" }, "value": false }`. Devices pick it up on their next fetch.

```ts
if (hush.config.bool('sync_enabled', true)) startSync();
```

**A staged rollout.** One rule with a `rollout`, raised on the dashboard:
20, then 50, then 100. Raising it keeps everyone already in. Keep testers in
with a rule before it:

```json
"rules": [
  { "when": { "channel": ["testflight"] }, "value": true },
  { "when": { "platform": ["ios"], "version": ">=2.1.0" }, "rollout": 20, "value": true }
]
```

**Copy by language.** A `string` per language, with the app's language passed
in so the rules match the UI, not the phone's first locale:

```json
"paywall_copy": { "type": "string", "default": "Start your free week", "description": "The paywall headline.",
  "rules": [{ "when": { "language": ["de"] }, "value": "Eine Woche gratis" }] }
```

```ts
hush.configure({ url, key, remoteConfig: { language: () => i18n.locale } });
i18n.on('languageChanged', (lng) => hush.identify({ language: lng })); // an in-app switch
```

**Measuring a variant.** The SDK reports nothing about config. To compare,
the app puts the value in a global prop and the dashboard splits funnels and
breakdowns by it. Use a key whose values are short names, not the copy
itself: an event's props, global ones included, are capped at 2 KB, and a
string value can be 2000 characters.

```json
"paywall_variant": { "type": "string", "default": "a", "description": "The paywall variant on show.",
  "rules": [{ "rollout": 50, "value": "b", "note": "Half see b" }] }
```

```ts
const tagVariant = () => hush.setGlobalProps({ paywall_variant: hush.config.string('paywall_variant', 'a') });
hush.config.ready().then(tagVariant);
hush.config.onChange((keys) => keys.includes('paywall_variant') && tagVariant());
```

Set it once the value is usable (after `config.ready()`) and again from
`onChange`. That prop is sent like any other: keep it to the variant's name.

## 6. The dashboard

The app page links to its Remote config page.

- **The list.** Every key with its type, its value and rules as served, and
  whether each comes from the catalog or an override. Overrides the catalog
  no longer fits are listed apart: an orphan (its key left the catalog) or
  one that no longer validates (its type changed). They are kept, not
  served, and logged at boot; fix or delete them there. An orphan whose key
  comes back stays unserved until someone saves or reverts it.
- **One key.** Override the default, the rules or both, with the server's
  checks as you type, and an optional note. A save replaces the whole
  override; whatever it does not set comes from the catalog, so a later
  catalog change to that part still applies. Revert to the catalog removes
  the override. A save made from a page someone else changed since is
  refused (409); reload and redo it.
- **Preview as.** What a device with a given platform, version, channel,
  language and paid flag gets, as shares of the 100 buckets per outcome, or
  what one install gets (paste its id from `getInstallationId()`), worked
  out with the SDK's evaluator. It previews an unsaved draft too. From an
  install the language is the phone's locale and the paid flag is known only
  when its last batch said `true`; it warns about both.
- **History.** Every save and revert of the key, newest first, with what it
  served before and after and the note. Load an old version into the editor
  to restore it. Kept with the app; it holds no user data.
- The demo shows all of this read-only.

CLI on the server, read-only: `node src/cli.mjs config:show <app>` prints the
`/v1/config` answer; `config:history <app> [key]` lists the latest 50
changes. `config:show` builds its answer in the CLI, from the catalog file as
it is on disk now and the stored overrides: run it in the server's container
(its `CATALOG_FILE` and `DATABASE_URL`). After a catalog edit it shows the new
catalog while the server still serves the old one, until the server
restarts.

## 7. Privacy

Remote config sends nothing new. The SDK asks for `/v1/config` with the
app's write key and the revision it already has, and adds nothing about the
device: no install id, no device details, no events. Like any request, it
arrives with the device's IP address and the platform's User-Agent; hush
keeps neither (the address is only hashed, salted, for in-memory rate
limits), but a TLS proxy in front of it may keep both in its access log.
Every install of an app gets the same answer. Targeting and rollouts are
worked out on the device from what the SDK already knows (platform, app
version, build channel, the language the app shows or the phone's, the paid
flag the app passed to `identify()`, and the install id for the rollout).
The device never reports which value it got. The server learns nothing new:
for an install that sends events, it could work the value out from what
those events already carry (platform, version, channel, locale, paid flag,
install id), which is what the dashboard's Preview as does. A user who opted
out still gets config. An app that promises nothing leaves the device after
an opt-out should say in its privacy policy that this request does, or use
`remoteConfig: false`. The App Privacy answers do not change. An app that
reports a config value in an event, say as a global prop, sends it like any
other prop.

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| A getter always returns the fallback | The key is not in the catalog or misspelt in the app; the getter is not the key's type; the server has no migration 009 (no `config` in `/v1/config`); `remoteConfig: false`; the SDK is off (no url or key); or the read happens before `init()` has read storage. | `logLevel: 'error'` logs a key not in the server's config, one of another type and one with no usable value, once per key; the other causes log nothing. `curl -H 'Authorization: Key …' https://<server>/v1/config` shows what is served. Wait for `config.ready()`. |
| A value does not change after a dashboard save | The device fetches at most every `refreshMinutes` (15), in the foreground; a device coming back from the background fetches only once a fetch is due. A screen that kept the value shows it until it mounts again. A compiled component that reads `hush.config` instead of `useConfig()`'s object keeps its first value. | Wait, or call `config.refresh()` from a debug screen. Read through `useConfig()` in components. |
| A rule never matches | Missing context: no channel sent, `pro` before any `identify()` (and none stored from an earlier launch), an unreadable version. The language rule reads the phone's first locale when the app passes no `language`, and an in-app switch takes effect only through `identify({ language })`. The rollout bucket is outside it. | `config.snapshot()` shows the rule and bucket; the dashboard's Preview as with the install id shows what the server works out. |
| The revision does not move after a catalog edit | The server was not restarted: the catalog is read at boot. Or the edit changed only a description or a note, which are not served. | Restart. |
| `/v1/config` answers 304 every time | Nothing in the answer changed since the revision the device holds. Expected. | None. |
| An override is listed as not served | Its key left the catalog (an orphan), its type changed, or its key came back after being orphaned. | Save it again, or revert it, on the dashboard. |
| The dashboard says "changed since you opened it" | Someone saved or reverted the key after the page loaded. | Reload, then redo the change. |
| The server does not start after adding `config` | A catalog error; the log names the path. | Fix it ([server.md](server.md#6-validate-a-catalog)). |

More, with the rest of the SDK: [troubleshooting.md](troubleshooting.md#9-remote-config).
