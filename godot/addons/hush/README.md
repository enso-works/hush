# hush for Godot

Anonymous usage tracking and in-app feedback for Godot 4 games, sent to your
own [hush](https://github.com/enso-works/hush) server. The same events,
sessions and tickets as hush's JavaScript and Swift SDKs, so the dashboard
reads them alike. Pure GDScript: no native code, no GDExtension, so it runs
wherever Godot does (iOS, Android, desktop, the web). Godot 4.3 and later;
every change is tested on 4.3 and 4.7.

## Install

Any one of these puts the add-on at `res://addons/hush/`:

- **The release zip.** Download `hush-godot-<version>.zip` from the
  [releases](https://github.com/enso-works/hush/releases) and unzip it into
  your project's root (it holds `addons/hush/`).
- **A copy.** Copy `godot/addons/hush/` from the hush repository into your
  project's `addons/`.

Then enable it: Project > Project Settings > Plugins > hush. That adds the
`Hush` autoload; the plugin itself sends nothing.

## Configure

Once, as the game starts (a main scene's `_ready()`, or an autoload of your
own):

```gdscript
func _ready() -> void:
	Hush.configure({
		"url": "https://hush.example.com",
		"key": "hush_mygame_dev_…" if OS.is_debug_build() else "hush_mygame_prod_…",
	})
```

Mint the keys on the server (`keys:create mygame prod` and `keys:create
mygame dev`). The write key ships inside the game, so it is not a secret: it
identifies the game, can be revoked, and can read nothing but this install's
own feedback. The key decides prod or dev; dev data shows under the
dashboard's dev switch. An empty key keeps hush off. Every call returns at
once, never raises, and never breaks the game.

## Events

```gdscript
Hush.screen("main_menu")
Hush.track("level_completed", {"level": 3, "stars": 2, "time_s": 41.5})
Hush.track("tutorial_finished", {}, true)            # at most once per install
Hush.track("level_unlocked", {"level": 4}, "4")      # once per install and key
Hush.set_global_props({"difficulty": "hard"})        # joins every event; an event's own props win
Hush.identify({"pro": true})                         # a paid player; also rc_id, RevenueCat's anonymous id
```

- Event names are snake_case, 2 to 64 characters; props are one flat level of
  strings, numbers, booleans or `null`, up to 40. An invalid name or prop
  drops the event on the device, with a warning at `log_level: "error"`.
- `app_first_opened` and `session_started` are sent for you. A session ends
  after 30 minutes away; each `session_started` carries its number `n` and the
  last session's seconds in the foreground, `prev_fg_s`.
- Events queue on the device (500, up to 7 days, in `user://hush/`) and go
  out in batches of 20, every 30 seconds, a few seconds after something
  happens, and as the game leaves the foreground or quits. Without a network
  they wait, and retries back off up to five minutes.
- hush keeps running while the game's tree is paused.
- Leave out of `screen()` the screens the catalog lists in `private_screens`,
  such as the feedback form.

## Feedback

Drop the form into a scene: instance `res://addons/hush/feedback_panel.tscn`
(`HushFeedbackPanel`). It has a kind (a problem, an idea, kind words), the
message, an optional email and a send button, and shows sent and error
states. It takes your theme like any Control, and its texts are exported, so
they can be translated in the inspector. It emits `sent(ticket_id)` and
`failed(error)`.

Or call it yourself:

```gdscript
var result: Dictionary = await Hush.send_feedback({"kind": "issue", "message": text, "email": email})
if result.ok:
	print("ticket ", result.id)
else:
	print(result.error)                                # offline, too_many, failed, unavailable

var tickets: Array = await Hush.list_tickets()        # newest first, with replies and `unread`
await Hush.reply_to_ticket(tickets[0].id, "Thanks!")  # {ok: false, error: "closed"} once support closed it
```

`kind` is `issue`, `feature` or `love`; `subject` is optional. A player can
send five a day. Your replies from the dashboard show in `list_tickets()`
(fetching marks them read), and by email when they left an address.

A ticket sent with an email is kept apart from the install: it goes without
the install id, and the server answers with a key to that one ticket, kept on
the device. No request carries the install id and such a key together.

## The player's choices

```gdscript
Hush.opt_out(true)                # remembered: nothing is queued or sent until opt_out(false); feedback still works
Hush.is_opted_out()
var result: Dictionary = await Hush.forget()  # "delete my data": the email tickets by key, then the install; a new install id after
```

`Hush.get_installation_id()` gives the id to paste into the dashboard's
Installs page, for a debug screen.

## Options

| `configure({…})` | |
|---|---|
| `url`, `key` | the server and a write key; either empty leaves hush off |
| `channel` | where this build came from, snake_case, up to 24 characters. Default: `dev` in a debug build, none in a release build |
| `version`, `build` | default: Project Settings > Application > Config > Version, and no build number |
| `debug` | `true` prints every send; or `log_level`: `"silent"` (default), `"error"`, `"debug"` |
| `storage_dir` | where hush keeps its files, default `user://hush`. Changing it gives every player a new install id |

GDScript cannot tell a TestFlight build from an App Store one. Add a custom
feature to each export preset (Export > Features > Custom: `testflight`,
`app_store`, `play`) and pass it:

```gdscript
var channel = null
for c in ["app_store", "testflight", "play"]:
	if OS.has_feature(c):
		channel = c
Hush.configure({"url": url, "key": key, "channel": channel if channel else ("dev" if OS.is_debug_build() else null)})
```

Batches report the platform and OS from `OS.get_name()` and
`OS.get_version()` (`ios 18.6`), the device from `OS.get_model_name()`
(`iPhone15,2` on iOS) and the locale from `OS.get_locale()`.

Signals: `flushed(result)` after every send to the server (`status`,
`accepted`, `duplicate`, `rejected`, `will_retry`), and
`feedback_sent(result)`. `await Hush.flush()` sends what is queued now, for a
debug screen; `pause_sending()` and `resume_sending()` hold sends (not events).

Not in this version, and in the JavaScript SDK: remote config, Apple's ad
attribution, and `entry()` for the link or notification that opened the app.

## Versions

Every batch carries `sdk: "godot-<version>"`, stored on the install. This is
0.1.0 (`plugin.cfg`).

## Tests

From the hush repository, with its test Postgres running:

```sh
node --test test/godot.test.mjs
```

It starts a hush server, runs `godot/tests/run_tests.gd` headless against it,
then checks what the server stored.

MIT
