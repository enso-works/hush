# hush in a Godot game

The hush add-on for Godot 4 (4.3 and later), version 0.1.0: pure GDScript,
the same `/v1` requests, events, sessions and tickets as `@bavrk/hush`, so
the dashboard reads them alike. No npm package: a project with
`project.godot` at its root uses this instead of
[install.md](install.md). The rules in [../SKILL.md](../SKILL.md) on keys,
URLs, screen names and private screens apply.

## Install

1. Put the add-on at `res://addons/hush/`: unzip `hush-godot-<version>.zip`
   from https://github.com/enso-works/hush/releases into the project root, or
   copy `godot/addons/hush/` from the repository. Do not change anything in
   it.
2. Enable it: add `"res://addons/hush/plugin.cfg"` to
   `[editor_plugins] enabled` in `project.godot`, and the autoload line
   `Hush="*res://addons/hush/hush.gd"` under `[autoload]` (what enabling it
   in Project Settings > Plugins writes). Keep the game's other autoloads.
3. Set Project Settings > Application > Config > Version
   (`config/version` in `project.godot`) if it is empty: batches report it.

## Configure

Once, as the game starts: the main scene's `_ready()`, or an autoload of the
game's own that loads after `Hush`.

```gdscript
Hush.configure({
	"url": "https://<the server the user gave>",
	"key": "<dev key>" if OS.is_debug_build() else "<prod key>",
})
```

- The key decides prod or dev; there is no `env` option. An empty key keeps
  hush off: use it when the user has no prod key yet.
- `channel` defaults to `dev` in a debug build and to none in a release
  build. GDScript cannot detect TestFlight: for store channels, add custom
  features to the export presets (`app_store`, `testflight`, `play`) and pass
  the one `OS.has_feature()` finds.
- Other options: `version`, `build` (default: the project version, no build),
  `debug: true` or `log_level`, `storage_dir` (default `user://hush`; never
  change it in a shipped game).

## API

| Call | |
|---|---|
| `Hush.screen(name)` | `screen_viewed`. Name screens and scenes by kind (`level_select`), never with ids |
| `Hush.track(name, props := {}, once := false)` | snake_case, 2-64 chars; props flat, up to 40. `once`: `true`, or a String key |
| `Hush.set_global_props(props)`, `remove_global_prop(key)` | join every event; in memory, set each launch |
| `Hush.identify({"pro": bool, "rc_id": String})` | paid flag; RevenueCat's anonymous id |
| `await Hush.send_feedback({"kind", "message", "email"?, "subject"?})` | `{ok, id, error}`; kind `issue`, `feature`, `love`; error `offline`, `too_many`, `failed`, `unavailable` |
| `await Hush.list_tickets()`, `await Hush.reply_to_ticket(id, body)` | the inbox; listing marks replies read; reply error `closed` |
| `Hush.opt_out(bool)`, `Hush.is_opted_out()` | remembered; feedback still works |
| `await Hush.forget()` | `{ok, error}`; deletes the install's data and its email tickets, then a new install id |
| `Hush.get_installation_id()` | for a debug screen |
| `await Hush.flush()`, `pause_sending()`, `resume_sending()` | rarely needed: hush sends on its own |
| signals `flushed(result)`, `feedback_sent(result)` | |

`res://addons/hush/feedback_panel.tscn` (`HushFeedbackPanel`) is a ready
form: kind, message, optional email, send, sent and error states; themeable,
texts exported; signals `sent(ticket_id)` and `failed(error)`. Leave its
screen out of `screen()`, or list it in the catalog's `private_screens`.

Sent for the game: `app_first_opened`, `session_started` (`n`, `prev_fg_s`,
a new session after 30 minutes away), `ticket_opened` and `ticket_replied`
(not for a ticket sent with an email). Batches carry `sdk: godot-0.1.0`,
platform and OS from `OS.get_name()` and `OS.get_version()`, the device from
`OS.get_model_name()`, the locale from `OS.get_locale()`. It flushes as the
game leaves the foreground (`NOTIFICATION_APPLICATION_PAUSED`, focus out) and
on `NOTIFICATION_WM_CLOSE_REQUEST`, and keeps running while the tree is
paused.

Not in the add-on: remote config, Apple ad attribution, `entry()`.

## Verify

Run the game with the dev key and `"debug": true`: the output shows
`hush: ready: install …` and `hush: sent N: …` lines. Paste the install id
into the dashboard's Installs page (dev switch on). The add-on's guide:
https://github.com/enso-works/hush/blob/main/godot/addons/hush/README.md
