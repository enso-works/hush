extends Node
## hush for Godot: anonymous usage and in-app feedback, sent to your own hush
## server. The same events, sessions and tickets as the JavaScript SDK
## (@bavrk/hush) and the Swift one, so the dashboard reads all of them alike.
##
##     Hush.configure({"url": "https://hush.example.com", "key": "hush_mygame_prod_…"})
##     Hush.screen("main_menu")
##     Hush.track("level_completed", {"level": 3, "stars": 2})
##     var result = await Hush.send_feedback({"kind": "issue", "message": text})
##
## Every call returns at once (or, awaited, with a result), never raises, and
## never breaks the game: with no key, or no server, it does nothing.
##
## The rules are the JavaScript core's (sdk/src/core.ts in the hush
## repository): a queue of up to 500 events kept for 7 days, batches of 20
## every 30 seconds and shortly after something happens, a numbered session
## per return after 30 minutes away, once-per-install events, the player's
## opt-out and forget, and feedback, where a ticket with an email never carries
## the install id.

## After every send to /v1/events: {status, accepted, duplicate, rejected,
## will_retry}. status is null when no answer came (offline).
signal flushed(result: Dictionary)
## After every send_feedback(): {ok, id, error}, as send_feedback returns it.
signal feedback_sent(result: Dictionary)

## Sent with every batch as "godot-<version>", and stored on the install.
const SDK_VERSION := "0.1.0"

# Limits, as the JavaScript core has them.
const MAX_QUEUE := 500
const BATCH_SIZE := 20
const FLUSH_INTERVAL := 30.0
const FLUSH_SOON_DELAY := 3.0
const MAX_AGE := 7 * 24 * 3600
const SESSION_GAP := 30 * 60
const MAX_ONCE := 200
const MAX_THREADS := 50
const MAX_PROPS := 40
const KINDS := ["issue", "feature", "love"]

enum LogLevel { SILENT, ERROR, DEBUG }

var _url := ""
var _key := ""
var _channel: Variant = null
var _log_level := LogLevel.SILENT
var _dir := "user://hush"
var _version := ""
var _build := ""

var _started := false
var _created_at := 0.0
var _install_id := ""
var _session_id := ""
var _queue: Array = []
var _sending := false
var _forgetting := false
var _paused := false
var _retry_after := 0.0
var _failures := 0
var _rc_id: Variant = null
var _is_pro: Variant = null
var _globals := {}
var _once_keys: Array = []
var _opted_out := false
var _choice_before_start: Variant = null
var _session_count := 0
var _foreground_time := 0.0
var _active_since := -1.0
var _backgrounded_at := -1.0
var _away := false
var _persist_scheduled := false
var _flush_soon_scheduled := false
var _unsaved_threads := {}
var _timer: Timer
# Tests move the clock forward with this; a game never touches it.
var _time_offset := 0.0

var _event_name := RegEx.create_from_string("^[a-z][a-z0-9_]{1,63}$")
var _channel_re := RegEx.create_from_string("^[a-z][a-z0-9_]{0,23}$")
var _thread_re := RegEx.create_from_string("^[A-Za-z0-9_-]{43}$")
var _digits_re := RegEx.create_from_string("^[0-9]+$")
var _uuid_re := RegEx.create_from_string("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

signal _send_done


func _init() -> void:
	_created_at = _now()
	_session_id = _uuid()
	# The game pausing its tree must not hold events back or stop a send.
	process_mode = Node.PROCESS_MODE_ALWAYS


# --- Configure

## Call once, as the game starts. Options:
## url, key: the server and a write key (`keys:create <app> <env>`); either
##   empty leaves hush off. The key decides prod or dev.
## channel: where this build came from, snake_case, up to 24 characters
##   (app_store, testflight, play, steam...). Default: "dev" in a debug
##   build, none in a release build.
## debug: true logs every send; log_level: "silent" (default), "error", "debug".
## version, build: override the version (default: Project Settings >
##   Application > Config > Version) and the build number (default: none).
## storage_dir: where hush keeps its files, default "user://hush". Changing it
##   in a shipped game gives every player a new install id.
## Calling it again replaces the configuration.
func configure(options: Dictionary) -> void:
	var url := _option(options, "url")
	while url.ends_with("/"):
		url = url.left(-1)
	_url = url
	_key = _option(options, "key")
	if options.has("log_level"):
		_log_level = ({"error": LogLevel.ERROR, "debug": LogLevel.DEBUG} as Dictionary).get(str(options["log_level"]), LogLevel.SILENT)
	elif options.get("debug", false):
		_log_level = LogLevel.DEBUG
	else:
		_log_level = LogLevel.SILENT
	var chosen: Variant = options.get("channel", "dev" if OS.is_debug_build() else null)
	_channel = null
	if chosen != null:
		if _channel_re.search(str(chosen)):
			_channel = str(chosen)
		else:
			_log_error("channel \"%s\" is not a short snake_case label; not sent" % chosen)
	_version = _option(options, "version")
	if _version == "":
		_version = str(ProjectSettings.get_setting("application/config/version", ""))
	_build = _option(options, "build")
	if not _started:
		var dir := _option(options, "storage_dir")
		_dir = dir if dir != "" else "user://hush"
	if _url == "" and _key != "":
		_log_error("url is empty: hush is off")
	_start()


func _enabled() -> bool:
	return _url != "" and _key != ""


# Reads what earlier launches stored, starts the session and the timer.
func _start() -> void:
	if not _enabled() or _started:
		return
	var stored := _read("install")
	var first := _read("first")
	var stored_opt_out := _read("optout") == "1"
	var stored_queue: Variant = _read_json("queue.json")
	var stored_once: Variant = _read_json("once.json")
	var stored_sessions: Variant = _read_json("sessions.json")
	_install_id = stored if _is_uuid(stored) else _uuid()
	if _install_id != stored:
		_write("install", _install_id)
	_opted_out = _choice_before_start if _choice_before_start != null else stored_opt_out
	if _choice_before_start != null:
		_write("optout", "1" if _opted_out else null)
	_choice_before_start = null
	_once_keys = []
	if stored_once is Array:
		for k: Variant in stored_once:
			if k is String:
				_once_keys.append(k)
	_once_keys = _once_keys.slice(-MAX_ONCE)
	if stored_sessions is Dictionary:
		_session_count = int(stored_sessions.get("n", 0))
		_foreground_time = float(stored_sessions.get("fg", 0)) / 1000.0
	_active_since = -1.0
	_queue = []
	if stored_queue is Array and not _opted_out:
		var cutoff := _now() - MAX_AGE
		for e: Variant in stored_queue:
			if e is Dictionary and _valid_stored(e) and _parse_time(e["at"]) > cutoff:
				_queue.append(e)
		_queue = _queue.slice(-MAX_QUEUE)
	_started = true
	if _opted_out:
		_write("queue.json", null)
	_persist_queue()
	if first == "":
		_enqueue("app_first_opened", {})
		_write("first", _stamp(_now()))
	_start_session(true)
	_start_timer()
	_log_debug("ready: install %s, sdk godot-%s, channel %s" % [_install_id, SDK_VERSION, _channel if _channel != null else "(none)"])
	flush()


func _valid_stored(e: Dictionary) -> bool:
	return e.get("id") is String and e.get("name") is String and e.get("at") is String \
		and e.get("session") is String and e.get("props") is Dictionary


func _start_timer() -> void:
	if _timer != null:
		return
	_timer = Timer.new()
	_timer.wait_time = FLUSH_INTERVAL
	_timer.timeout.connect(_on_tick)
	add_child(_timer)
	_timer.start()


func _on_tick() -> void:
	# Also keeps the foreground time on disk for a game killed mid-session.
	_persist_sessions()
	_flush_once()


# --- Events

## Records an event: snake_case, 2-64 characters; props one flat level of
## strings, numbers, booleans or null, up to 40. once: true sends it at most
## once per install, ever; a String sends it once per install and that key.
func track(event_name: String, props: Dictionary = {}, once: Variant = false) -> void:
	if not _event_name.search(event_name):
		_log_error("event \"%s\" is not snake_case (a-z, 0-9, _; 2-64 chars): dropped" % event_name)
		return
	var clean: Variant = _flat(event_name, props)
	if clean == null:
		return
	if once == null or (once is bool and not once) or (once is String and once == ""):
		_enqueue(event_name, clean)
		return
	var key := event_name if once is bool else "%s:%s" % [event_name, once]
	if _once_keys.has(key):
		_log_debug("\"%s\" was already sent once: skipped" % key)
		return
	if _enqueue(event_name, clean, key).is_empty():
		return
	_once_keys.append(key)
	_once_keys = _once_keys.slice(-MAX_ONCE)
	_persist_once()


## A screen the player sees. Leave out the screens the app's catalog keeps
## private (private_screens), such as feedback.
func screen(screen_name: String) -> void:
	_enqueue("screen_viewed", {"screen": screen_name})


## Props added to every event from now on; an event's own props win. Kept in
## memory: set them each launch.
func set_global_props(props: Dictionary) -> void:
	for k: Variant in props:
		var v: Variant = _flat_value(props[k])
		if v is Object:
			_log_error("global prop \"%s\" is not a string, number, boolean or null: not set" % k)
		else:
			_globals[str(k)] = v


func remove_global_prop(key: String) -> void:
	_globals.erase(key)


## Whether the install is on a paid plan ({"pro": true}), and RevenueCat's
## anonymous customer id ({"rc_id": "…"}). Until pro is given, batches carry no flag.
func identify(info: Dictionary) -> void:
	if info.get("pro") is bool:
		_is_pro = info["pro"]
	if info.get("rc_id") is String and info["rc_id"] != "":
		_rc_id = info["rc_id"]


## The install id, for a debug screen: paste it into the dashboard's Installs
## page. "" before configure().
func get_installation_id() -> String:
	return _install_id


# A prop value as JSON sends it, or an Object (this node) for one that is not
# flat: no prop value can be an Object, so it marks the refusal.
func _flat_value(v: Variant) -> Variant:
	match typeof(v):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_STRING:
			return v
		TYPE_STRING_NAME:
			return str(v)
		TYPE_FLOAT:
			# JSON has no NaN or infinity: such a number goes as null rather than sink the batch.
			return v if is_finite(v) else null
	return self


func _flat(event_name: String, props: Dictionary) -> Variant:
	if props.size() > MAX_PROPS:
		_log_error("event \"%s\" has %d props; the server keeps at most %d" % [event_name, props.size(), MAX_PROPS])
	var out := {}
	for k: Variant in props:
		var v: Variant = _flat_value(props[k])
		if v is Object:
			_log_error("event \"%s\" prop \"%s\" is not a string, number, boolean or null (props are one flat level): dropped" % [event_name, k])
			return null
		out[str(k)] = v
	return out


func _enqueue(event_name: String, props: Dictionary, once: String = "") -> Dictionary:
	if not _enabled() or not _started or _opted_out:
		return {}
	var merged := _globals.duplicate()
	merged.merge(props, true)
	var event := {"id": _uuid(), "name": event_name, "at": _stamp(_now()), "session": _session_id, "props": merged}
	if once != "":
		event["once"] = once
	_push(event)
	return event


func _push(event: Dictionary) -> void:
	_queue.append(event)
	if _queue.size() > MAX_QUEUE:
		_queue = _queue.slice(-MAX_QUEUE)
	_persist_soon()
	if _queue.size() >= BATCH_SIZE:
		_flush_once()
	else:
		_flush_soon()


# --- Sessions

func _start_session(first: bool) -> void:
	var started := _now()
	if not first:
		_session_id = _uuid()
	# The session that just ended reports its foreground time with the next
	# start: an explicit "session ended" dies with the process whenever the OS
	# kills the game.
	var since := started - _active_since if _active_since >= 0.0 else 0.0
	var previous := roundi(_foreground_time + since)
	_foreground_time = 0.0
	_active_since = started
	if not _enabled() or _opted_out:
		_persist_sessions()
		return
	_session_count += 1
	var props := {"entry": "launch", "n": _session_count}
	if _session_count > 1 and previous > 0:
		props["prev_fg_s"] = previous
	var merged := _globals.duplicate()
	merged.merge(props, true)
	_push({"id": _uuid(), "name": "session_started", "at": _stamp(_created_at if first else started), "session": _session_id, "props": merged})
	_persist_sessions()


func _notification(what: int) -> void:
	match what:
		NOTIFICATION_APPLICATION_PAUSED, NOTIFICATION_APPLICATION_FOCUS_OUT:
			_app_state(false)
		NOTIFICATION_APPLICATION_RESUMED, NOTIFICATION_APPLICATION_FOCUS_IN:
			_app_state(true)
		NOTIFICATION_WM_CLOSE_REQUEST:
			# Quitting may not leave time for the send: the queue is on disk first.
			_app_state(false)
		NOTIFICATION_PREDELETE:
			if _started:
				_persist_queue()


# Mobile sends both focus and pause; only the change counts.
func _app_state(active: bool) -> void:
	if not _started or active == not _away:
		return
	var at := _now()
	_away = not active
	if not active:
		_backgrounded_at = at
		if _active_since >= 0.0:
			_foreground_time += at - _active_since
			_active_since = -1.0
		_persist_sessions()
		_persist_queue()
		flush()
		return
	if _backgrounded_at >= 0.0 and at - _backgrounded_at > SESSION_GAP:
		_start_session(false)
	elif _active_since < 0.0:
		_active_since = at


# --- Persistence

func _persist_sessions() -> void:
	if not _started:
		return
	var running := _now() - _active_since if _active_since >= 0.0 else 0.0
	_write("sessions.json", JSON.stringify({"n": _session_count, "fg": (_foreground_time + running) * 1000.0}))


func _persist_once() -> void:
	if _started:
		_write("once.json", JSON.stringify(_once_keys.slice(-MAX_ONCE)))


func _persist_queue() -> void:
	_persist_scheduled = false
	if _started and not _opted_out:
		_write("queue.json", JSON.stringify(_queue.slice(-MAX_QUEUE)))


func _persist_soon() -> void:
	if _persist_scheduled or not is_inside_tree():
		return
	_persist_scheduled = true
	get_tree().create_timer(1.0).timeout.connect(_persist_queue)


func _flush_soon() -> void:
	if _flush_soon_scheduled or not is_inside_tree():
		return
	_flush_soon_scheduled = true
	get_tree().create_timer(FLUSH_SOON_DELAY).timeout.connect(_on_flush_soon)


func _on_flush_soon() -> void:
	_flush_soon_scheduled = false
	_flush_once()


# --- Sending

## Sends what is queued now, in batches of 20, and returns when done: for a
## debug screen, or before the game quits. hush sends on its own otherwise.
func flush() -> void:
	if _sending:
		await _send_done
	for i in ceili(float(MAX_QUEUE) / BATCH_SIZE):
		var before := _queue.size()
		await _flush_once()
		if _queue.is_empty() or _queue.size() >= before:
			return


# One batch, or a wait for the send in flight.
func _flush_once() -> void:
	if _sending:
		await _send_done
		return
	if not _enabled() or _opted_out or _paused or _forgetting or not _started or _queue.is_empty() or _now() < _retry_after:
		return
	_sending = true
	await _send()
	_sending = false
	_send_done.emit()


func _context() -> Dictionary:
	var d := _device()
	var ctx := {"version": d["version"], "build": d["build"], "platform": d["platform"], "os": d["os"],
		"device": d["device"], "locale": d["locale"]}
	if _rc_id != null:
		ctx["rc_id"] = _rc_id
	if _is_pro != null:
		ctx["pro"] = _is_pro
	if _channel != null:
		ctx["channel"] = _channel
	return ctx


func _send() -> void:
	var batch := _queue.slice(0, BATCH_SIZE)
	var events := []
	for e: Dictionary in batch:
		events.append({"id": e["id"], "name": e["name"], "at": e["at"], "session": e["session"], "props": e["props"], "install": _install_id})
	var answer: Dictionary = await _post("/v1/events", {"sent_at": _stamp(_now()), "sdk": "godot-" + SDK_VERSION, "context": _context(), "events": events})
	var status: int = answer["status"]
	var ok := status >= 200 and status < 300
	# 2xx is stored; a 4xx other than a rate limit will never be accepted, so it goes too.
	var done := ok or (status >= 400 and status < 500 and status != 429)
	if done:
		# By id, not position: opt-out, forget or the cap may have replaced the queue meanwhile.
		var sent := {}
		for e: Dictionary in batch:
			sent[e["id"]] = true
		_queue = _queue.filter(func(e: Dictionary) -> bool: return not sent.has(e["id"]))
		_failures = 0
		_persist_queue()
	else:
		_failures += 1
		_retry_after = _now() + minf(5.0 * pow(2.0, _failures - 1), 300.0)
	var counts: Variant = answer["json"] if ok and answer["json"] is Dictionary else {}
	var result := {
		"status": status if status != 0 else null,
		"accepted": int(counts.get("accepted", 0)),
		"duplicate": int(counts.get("duplicate", 0)),
		"rejected": int(counts.get("rejected", batch.size() if done and not ok else 0)),
		"will_retry": not done,
	}
	if ok:
		_log_debug("sent %d: %s" % [batch.size(), result])
	else:
		_log_error("sent %d: %s" % [batch.size(), result])
	flushed.emit(result)


# The answer as {status, json}: status 0 when none came.
func _post(path: String, body: Dictionary) -> Dictionary:
	if not is_inside_tree():
		_log_error("the Hush node is not in the scene tree: nothing can be sent")
		return {"status": 0, "json": null}
	var http := HTTPRequest.new()
	http.timeout = 30.0
	add_child(http)
	var headers := PackedStringArray(["Authorization: Key " + _key, "Content-Type: application/json"])
	if http.request(_url + path, headers, HTTPClient.METHOD_POST, JSON.stringify(body)) != OK:
		http.queue_free()
		return {"status": 0, "json": null}
	var r: Array = await http.request_completed
	http.queue_free()
	if r[0] != HTTPRequest.RESULT_SUCCESS:
		return {"status": 0, "json": null}
	var parsed: Variant = null
	var text: String = (r[3] as PackedByteArray).get_string_from_utf8()
	var json := JSON.new()
	if text != "" and json.parse(text) == OK:
		parsed = json.data
	return {"status": int(r[1]), "json": parsed}


## Holds sends (not events) until resume_sending(), for a moment the game
## needs the network to itself. Not remembered across launches.
func pause_sending() -> void:
	_paused = true


func resume_sending() -> void:
	_paused = false
	flush()


# --- The player's choices

func is_opted_out() -> bool:
	return _opted_out


## The player's "don't share anonymous usage", remembered across launches:
## opt_out(true) drops what is queued and queues nothing until opt_out(false).
## Feedback still works: a player sends that on purpose.
func opt_out(value: bool = true) -> void:
	if not value:
		_opt_in()
		return
	if not _started:
		_choice_before_start = true
	_opted_out = true
	_queue = []
	if _started:
		_write("optout", "1")
		_write("queue.json", null)
	_log_debug("opted out")


func _opt_in() -> void:
	if not _started:
		_choice_before_start = false
		_opted_out = false
		return
	if not _opted_out:
		return
	_opted_out = false
	_write("optout", null)
	_log_debug("opted in")
	_start_session(false)


## The player's "delete my data": the tickets sent with an email whose keys
## this device holds, then everything stored about this install, and hush
## starts over with a new install id, without counting a new install.
## Returns {ok, error}. Offline or refused: nothing is lost, and calling it
## again finishes the rest.
func forget() -> Dictionary:
	if not _enabled() or not _started:
		return {"ok": false, "error": "unavailable"}
	# Nothing of this install may land after its delete: a send already out lands first, no new one starts.
	_forgetting = true
	if _sending:
		await _send_done
	var result: Dictionary = await _forget()
	_forgetting = false
	return result


func _forget() -> Dictionary:
	var map := _threads()
	var ids := map.keys()
	for start in range(0, ids.size(), MAX_THREADS):
		var chunk := ids.slice(start, start + MAX_THREADS)
		var keys := chunk.map(func(id: String) -> String: return map[id])
		var answer: Dictionary = await _post("/v1/forget", {"threads": keys})
		if answer["status"] == 0:
			return {"ok": false, "error": "offline"}
		if answer["status"] < 200 or answer["status"] >= 300:
			return {"ok": false, "error": "failed"}
		for id: String in chunk:
			_unsaved_threads.erase(id)
		var drop := func(stored: Dictionary) -> void:
			for id: String in chunk:
				stored.erase(id)
		_save_threads(drop)
	var answer: Dictionary = await _post("/v1/forget", {"install": _install_id})
	if answer["status"] == 0:
		return {"ok": false, "error": "offline"}
	if answer["status"] < 200 or answer["status"] >= 300:
		return {"ok": false, "error": "failed"}
	_queue = []
	_install_id = _uuid()
	_once_keys = []
	_session_count = 0
	_foreground_time = 0.0
	_write("install", _install_id)
	for f in ["queue.json", "once.json", "sessions.json"]:
		_write(f, null)
	_log_debug("forgotten; new install %s" % _install_id)
	_start_session(false)
	return {"ok": true}


# --- Feedback
#
# A ticket sent with an email is contact info, so it must not be joinable to
# this install's usage data: it goes without the install id and RevenueCat's
# id, no ticket_opened marks the moment, and the server answers with a key to
# that one ticket, kept on the device. No request ever carries the install id
# and a thread key together.

## Sends feedback: {kind: "issue" | "feature" | "love", message, email?,
## subject?}. With an email, replies also go by mail, and the ticket is kept
## apart from this install. Five a day. Returns {ok, id, error}; error is
## "unavailable", "offline", "too_many" or "failed". Also emits feedback_sent.
func send_feedback(input: Dictionary) -> Dictionary:
	var result: Dictionary = await _create_ticket(input)
	feedback_sent.emit(result)
	return result


func _create_ticket(input: Dictionary) -> Dictionary:
	if not _enabled() or not _started:
		return {"ok": false, "error": "unavailable"}
	# A plain message is a problem report, as the server reads one without a kind.
	var kind := _option(input, "kind") if _option(input, "kind") != "" else "issue"
	var message := _option(input, "message")
	if not KINDS.has(kind) or message == "":
		_log_error("feedback needs a kind (issue, feature, love) and a message: not sent")
		return {"ok": false, "error": "failed"}
	var d := _device()
	# Version, build, OS, device and the paid flag describe the build, not the person.
	var diag := {}
	for k in ["version", "build", "os", "device"]:
		if d[k] != "":
			diag[k] = d[k]
	if _is_pro != null:
		diag["pro"] = _is_pro
	var body := {"kind": kind, "message": message, "diag": diag}
	var subject := _option(input, "subject")
	if subject != "":
		body["subject"] = subject
	var email := _option(input, "email")
	if email != "":
		body["email"] = email
	else:
		body["install"] = _install_id
		if _rc_id != null:
			body["rc_id"] = _rc_id
	var answer: Dictionary = await _post("/v1/tickets", body)
	if answer["status"] == 0:
		return {"ok": false, "error": "offline"}
	if answer["status"] == 429:
		return {"ok": false, "error": "too_many"}
	if answer["status"] < 200 or answer["status"] >= 300:
		return {"ok": false, "error": "failed"}
	var created: Dictionary = answer["json"] if answer["json"] is Dictionary else {}
	var id := _id_string(created.get("id"))
	if email != "":
		var thread: Variant = created.get("thread")
		if id != "" and thread is String and _thread_re.search(thread):
			_unsaved_threads[id] = thread
			_save_threads(func(_stored: Dictionary) -> void: pass)
	else:
		_enqueue("ticket_opened", {"kind": kind})
	return {"ok": true, "id": id}


## This device's feedback, newest first, with support's replies: an Array of
## {id, kind, subject, message, status, created_at, unread, replies}. Fetching
## marks replies read on the server. Two requests, never one: the install's by
## its id, the ones sent with an email by their keys.
func list_tickets() -> Array:
	if not _enabled() or not _started:
		return []
	var map := _threads()
	var ids := map.keys()
	ids.sort_custom(func(a: String, b: String) -> bool: return a.length() > b.length() if a.length() != b.length() else a > b)
	var keys := ids.slice(0, MAX_THREADS).map(func(id: String) -> String: return map[id])
	var out: Array = await _fetch_tickets("/v1/tickets/list", {"install": _install_id})
	if not keys.is_empty():
		out.append_array(await _fetch_tickets("/v1/tickets/threads", {"threads": keys}))
	var seen := {}
	var tickets := []
	for t: Dictionary in out:
		if not seen.has(t["id"]):
			seen[t["id"]] = true
			tickets.append(t)
	tickets.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a.get("created_at", "")) > str(b.get("created_at", "")))
	return tickets


func _fetch_tickets(path: String, body: Dictionary) -> Array:
	var answer: Dictionary = await _post(path, body)
	if answer["status"] < 200 or answer["status"] >= 300 or not answer["json"] is Dictionary:
		return []
	var out := []
	for t: Variant in answer["json"].get("tickets", []):
		if t is Dictionary and t.has("id"):
			t["id"] = _id_string(t["id"])
			out.append(t)
	return out


## A reply on one of this device's tickets. Returns {ok, error}; error
## "closed" when support closed the thread: offer a new message instead.
func reply_to_ticket(id: String, body: String) -> Dictionary:
	if not _enabled() or not _started:
		return {"ok": false, "error": "unavailable"}
	var thread: Variant = _threads().get(id)
	var payload := {"body": body}
	if thread != null:
		payload["thread"] = thread
	else:
		payload["install"] = _install_id
	var answer: Dictionary = await _post("/v1/tickets/%s/reply" % id.uri_encode(), payload)
	match answer["status"]:
		0:
			return {"ok": false, "error": "offline"}
		409:
			return {"ok": false, "error": "closed"}
		429:
			return {"ok": false, "error": "too_many"}
	if answer["status"] < 200 or answer["status"] >= 300:
		return {"ok": false, "error": "failed"}
	if thread == null:
		_enqueue("ticket_replied", {})
	return {"ok": true}


# Ticket id -> thread key, read fresh on every use, plus keys handed out in
# this process whose write failed.
func _threads() -> Dictionary:
	var out := {}
	var stored: Variant = _read_json("threads.json")
	if stored is Dictionary:
		for id: Variant in stored:
			var key: Variant = stored[id]
			if id is String and _digits_re.search(id) and key is String and _thread_re.search(key):
				out[id] = key
	out.merge(_unsaved_threads, true)
	return out


func _save_threads(change: Callable) -> void:
	var map := _threads()
	change.call(map)
	if _write("threads.json", JSON.stringify(map)):
		for id: Variant in _unsaved_threads.keys():
			if map.get(id) == _unsaved_threads[id]:
				_unsaved_threads.erase(id)


func _id_string(v: Variant) -> String:
	match typeof(v):
		TYPE_STRING:
			return v
		TYPE_INT:
			return str(v)
		TYPE_FLOAT:
			return str(int(v))
	return ""


# --- The device

# What a batch says about where it came from, as the other SDKs say it.
func _device() -> Dictionary:
	var platform := OS.get_name().to_lower()
	return {
		"version": _version.left(32),
		"build": _build.left(32),
		"platform": platform.left(16),
		"os": ("%s %s" % [platform, OS.get_version()]).strip_edges().left(32),
		# On iOS the model identifier (iPhone15,2), as the other SDKs send.
		"device": OS.get_model_name().left(64),
		"locale": OS.get_locale().replace("_", "-").left(16),
	}


# --- Storage: one file per value under storage_dir.

func _path(file: String) -> String:
	return _dir.path_join(file)


func _read(file: String) -> String:
	var path := _path(file)
	if not FileAccess.file_exists(path):
		return ""
	return FileAccess.get_file_as_string(path).strip_edges()


func _read_json(file: String) -> Variant:
	var text := _read(file)
	if text == "":
		return null
	var json := JSON.new()
	if json.parse(text) != OK:
		_log_error("%s could not be read: starting it empty" % file)
		return null
	return json.data


# Writes the value, or removes the file for null. Through a temporary file,
# so a game killed mid-write keeps the last whole copy.
func _write(file: String, text: Variant) -> bool:
	var path := _path(file)
	if text == null:
		if FileAccess.file_exists(path):
			DirAccess.remove_absolute(path)
		return true
	DirAccess.make_dir_recursive_absolute(_dir)
	var tmp := path + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		_log_error("could not write %s: %s" % [path, error_string(FileAccess.get_open_error())])
		return false
	f.store_string(text)
	f.close()
	if DirAccess.rename_absolute(tmp, path) != OK:
		DirAccess.remove_absolute(path)
		return DirAccess.rename_absolute(tmp, path) == OK
	return true


# --- Helpers

func _now() -> float:
	return Time.get_unix_time_from_system() + _time_offset


# ISO 8601 in UTC with milliseconds, as the other SDKs stamp events.
func _stamp(t: float) -> String:
	var whole := floori(t)
	return "%s.%03dZ" % [Time.get_datetime_string_from_unix_time(whole), clampi(floori((t - whole) * 1000.0), 0, 999)]


func _parse_time(s: String) -> float:
	if s.length() < 19:
		return 0.0
	return float(Time.get_unix_time_from_datetime_string(s.left(19)))


func _uuid() -> String:
	var b := Crypto.new().generate_random_bytes(16)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var h := b.hex_encode()
	return "%s-%s-%s-%s-%s" % [h.substr(0, 8), h.substr(8, 4), h.substr(12, 4), h.substr(16, 4), h.substr(20, 12)]


func _is_uuid(s: String) -> bool:
	return _uuid_re.search(s) != null


# A string option, trimmed; "" for a missing or null one.
func _option(options: Dictionary, key: String) -> String:
	var v: Variant = options.get(key)
	return "" if v == null else str(v).strip_edges()


func _log_error(message: String) -> void:
	if _log_level >= LogLevel.ERROR:
		push_warning("hush: " + message)


func _log_debug(message: String) -> void:
	if _log_level >= LogLevel.DEBUG:
		print("hush: " + message)
