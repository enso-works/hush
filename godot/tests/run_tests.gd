extends SceneTree
## Runs the add-on against a real hush server, headless:
##
##   HUSH_URL=http://127.0.0.1:3000 HUSH_KEY=hush_… HUSH_STORAGE=/tmp/hush-godot \
##     godot --headless --path godot -s tests/run_tests.gd
##
## Prints one line per check, then `HUSH_RESULT {json}` with the install ids
## and ticket ids it made, for test/godot.test.mjs to look up in the database.
## Exits 1 when a check fails. HUSH_STORAGE must be an empty directory.

const HushScript := preload("res://addons/hush/hush.gd")
const FeedbackPanel := preload("res://addons/hush/feedback_panel.tscn")
# Nothing listens there: connections are refused at once.
const DEAD_URL := "http://127.0.0.1:9"

var failures := 0
var result := {}
var url := OS.get_environment("HUSH_URL")
var key := OS.get_environment("HUSH_KEY")
var storage := OS.get_environment("HUSH_STORAGE")


func _initialize() -> void:
	_main.call_deferred()


func _main() -> void:
	if url == "" or key == "" or storage == "":
		printerr("HUSH_URL, HUSH_KEY and HUSH_STORAGE are required")
		quit(2)
		return
	var guard := create_timer(110.0)
	guard.timeout.connect(func() -> void:
		printerr("timed out")
		quit(3))
	await _offline_then_online()
	await _feedback()
	await _opt_out()
	await _forget()
	print("HUSH_RESULT " + JSON.stringify(result))
	print("%d failed" % failures)
	quit(1 if failures > 0 else 0)


func check(name: String, ok: bool, detail: Variant = "") -> void:
	if ok:
		print("ok - " + name)
	else:
		failures += 1
		print("not ok - %s %s" % [name, detail])


func client(dir: String, server: String, options := {}) -> Node:
	var c: Node = HushScript.new()
	c.name = "Hush_" + dir
	root.add_child(c)
	var config := {"url": server, "key": key, "storage_dir": storage.path_join(dir)}
	config.merge(options, true)
	c.configure(config)
	return c


func names(c: Node) -> Array:
	return c._queue.map(func(e: Dictionary) -> String: return e["name"])


# Sends everything, the send in flight included, and adds up what the server said.
func flush_all(c: Node) -> Dictionary:
	var total := {"accepted": 0, "duplicate": 0, "rejected": 0, "sends": 0}
	var on_flush := func(r: Dictionary) -> void:
		for k in ["accepted", "duplicate", "rejected"]:
			total[k] += r[k]
		total["sends"] += 1
		total["status"] = r["status"]
		total["will_retry"] = r["will_retry"]
	c.flushed.connect(on_flush)
	await c.flush()
	c.flushed.disconnect(on_flush)
	return total


# A first launch with no server, then a second that sends what the first queued.
func _offline_then_online() -> void:
	var first := client("main", DEAD_URL)
	var install: String = first.get_installation_id()
	check("an install id is a v4 uuid", RegEx.create_from_string("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$").search(install) != null, install)
	check("the first launch queues app_first_opened and session_started", names(first) == ["app_first_opened", "session_started"], names(first))
	var at: String = first._queue[0]["at"]
	check("events are stamped in UTC with milliseconds", RegEx.create_from_string("^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$").search(at) != null, at)

	first.track("Bad Name")
	first.track("x")
	first.track("nested_prop", {"list": [1, 2]})
	check("invalid names and props are dropped", first._queue.size() == 2, names(first))
	first.track("tutorial_finished", {"step": &"done", "ratio": NAN}, true)
	first.track("tutorial_finished", {}, true)
	first.track("level_unlocked", {"level": 2}, "2")
	first.track("level_unlocked", {"level": 2}, "2")
	first.track("level_unlocked", {"level": 3}, "3")
	check("once events go once", names(first).count("tutorial_finished") == 1 and names(first).count("level_unlocked") == 2, names(first))
	var tutorial: Dictionary = first._queue[2]["props"]
	check("a StringName goes as a string, NaN as null", tutorial == {"step": "done", "ratio": null}, tutorial)

	# The send configure() started fails first; then one more, on demand.
	if first._sending:
		await first._send_done
	first._retry_after = 0.0
	var offline := await flush_all(first)
	check("offline: the batch stays and will retry", offline.get("status", 0) == null and offline.get("will_retry") == true and first._queue.size() == 5, offline)
	check("offline: the next try waits", first._retry_after > first._now(), first._retry_after)
	DirAccess.remove_absolute(storage.path_join("main/queue.json"))
	first.notification(Node.NOTIFICATION_WM_CLOSE_REQUEST)
	check("the queue is on disk when the game quits", FileAccess.file_exists(storage.path_join("main/queue.json")))
	first.queue_free()
	await process_frame

	# The autoload, as a game has it: the second launch.
	var second: Node = root.get_node("Hush")
	second.configure({"url": url, "key": key, "storage_dir": storage.path_join("main"), "channel": "dev"})
	check("the next launch keeps the install id", second.get_installation_id() == install, second.get_installation_id())
	check("the next launch keeps the queue and starts session 2",
		names(second) == ["app_first_opened", "session_started", "tutorial_finished", "level_unlocked", "level_unlocked", "session_started"]
		and second._queue[5]["props"]["n"] == 2, names(second))
	second.track("tutorial_finished", {}, true)
	check("once is remembered across launches", names(second).count("tutorial_finished") == 1, names(second))

	var sent := await flush_all(second)
	check("the server accepts the batch", sent.get("status") == 200 and sent.get("accepted") == 6 and second._queue.is_empty(), sent)

	second.pause_sending()
	second.set_global_props({"difficulty": "hard"})
	second.identify({"pro": true})
	second.screen("main_menu")
	second.track("level_completed", {"level": 3, "stars": 2, "time_s": 41.5, "perfect": false})
	# 5 seconds in the foreground, then 31 minutes away: a new session.
	second._time_offset += 5.0
	second._app_state(false)
	second._time_offset += 31 * 60
	second._app_state(true)
	var session: Dictionary = second._queue.back()
	check("a return after 30 minutes starts session 3 with the last one's time",
		session["name"] == "session_started" and session["props"]["n"] == 3 and session["props"]["prev_fg_s"] >= 5
		and session["props"]["difficulty"] == "hard", session)
	second.resume_sending()
	sent = await flush_all(second)
	check("the server accepts the rest", sent.get("accepted") == 3 and second._queue.is_empty(), sent)
	result["install"] = install
	result["platform"] = OS.get_name().to_lower()


func _feedback() -> void:
	var hush: Node = root.get_node("Hush")
	hush.pause_sending()
	var plain: Dictionary = await hush.send_feedback({"kind": "issue", "message": "The car falls through the bridge on level 3.", "subject": "Bridge"})
	check("feedback without an email is sent", plain.get("ok") == true and plain.get("id", "") != "", plain)
	check("ticket_opened is tracked for it", names(hush).has("ticket_opened"), names(hush))
	var emailed: Dictionary = await hush.send_feedback({"kind": "feature", "message": "A night mode, please.", "email": "player@example.com"})
	check("feedback with an email is sent", emailed.get("ok") == true and emailed.get("id", "") != "", emailed)
	var threads: Dictionary = hush._threads()
	check("its thread key is kept on the device", threads.has(emailed.get("id")), threads)
	check("no ticket_opened marks an email ticket", names(hush).count("ticket_opened") == 1, names(hush))
	var bad: Dictionary = await hush.send_feedback({"kind": "rant", "message": "x"})
	check("an unknown kind is refused on the device", bad == {"ok": false, "error": "failed"}, bad)

	var tickets: Array = await hush.list_tickets()
	var ids := tickets.map(func(t: Dictionary) -> String: return t["id"])
	check("list_tickets has both", ids.size() == 2 and ids.has(emailed.get("id")) and ids.has(plain.get("id")), ids)
	check("with what was sent", tickets.all(func(t: Dictionary) -> bool: return t["status"] == "open" and t["message"] != ""), tickets)
	var replied: Dictionary = await hush.reply_to_ticket(plain["id"], "It happens every time.")
	check("a reply by install", replied == {"ok": true}, replied)
	replied = await hush.reply_to_ticket(emailed["id"], "Or a dark theme.")
	check("a reply by thread key", replied == {"ok": true}, replied)
	check("ticket_replied only for the install's ticket", names(hush).count("ticket_replied") == 1, names(hush))

	var panel: Control = FeedbackPanel.instantiate()
	root.add_child(panel)
	panel.get_node("%Message").text = "Love the drifting."
	panel.get_node("%Kind").select(2)
	var sent_ids := []
	panel.sent.connect(func(id: String) -> void: sent_ids.append(id))
	var from_panel: Dictionary = await panel.submit()
	check("the feedback panel sends through the autoload", from_panel.get("ok") == true and sent_ids == [from_panel.get("id")], from_panel)
	check("the panel says it was sent", panel.get_node("%Status").text == panel.sent_text and panel.get_node("%Message").text == "", panel.get_node("%Status").text)
	panel.queue_free()

	hush.resume_sending()
	var sent := await flush_all(hush)
	check("ticket events reach the server", sent.get("status") == 200 and hush._queue.is_empty(), sent)
	result["plain_ticket"] = plain.get("id")
	result["email_ticket"] = emailed.get("id")
	result["panel_ticket"] = from_panel.get("id")


func _opt_out() -> void:
	var c: Node = HushScript.new()
	c.name = "Hush_optout"
	root.add_child(c)
	c.opt_out(true)
	c.configure({"url": url, "key": key, "storage_dir": storage.path_join("optout")})
	check("opted out before configure: nothing is queued", c.is_opted_out() and c._queue.is_empty(), names(c))
	c.track("ignored_event")
	check("opted out: track queues nothing", c._queue.is_empty(), names(c))
	check("the choice is on disk", FileAccess.get_file_as_string(storage.path_join("optout/optout")) == "1")
	c.opt_out(false)
	check("opting in starts a session", names(c) == ["session_started"], names(c))
	var sent := await flush_all(c)
	check("and sends it", sent.get("accepted") == 1, sent)
	c.opt_out(true)
	c.track("ignored_again")
	check("opted out again: nothing queued", c._queue.is_empty() and not FileAccess.file_exists(storage.path_join("optout/queue.json")), names(c))
	result["optout_install"] = c.get_installation_id()


func _forget() -> void:
	var c := client("forget", url)
	var before: String = c.get_installation_id()
	c.track("level_completed", {"level": 1})
	var sent := await flush_all(c)
	check("the install to forget has sent its events", sent.get("accepted") == 3, sent)
	var emailed: Dictionary = await c.send_feedback({"kind": "love", "message": "Great game.", "email": "fan@example.com"})
	check("and an email ticket", emailed.get("ok") == true, emailed)
	var forgotten: Dictionary = await c.forget()
	check("forget succeeds", forgotten == {"ok": true}, forgotten)
	check("a new install id after forget", c.get_installation_id() != before and c.get_installation_id() != "", c.get_installation_id())
	check("the thread keys are gone", c._threads().is_empty(), c._threads())
	check("the new install starts at session 1, without app_first_opened",
		names(c) == ["session_started"] and c._queue[0]["props"]["n"] == 1, c._queue)
	sent = await flush_all(c)
	check("the new install sends", sent.get("accepted") == 1, sent)
	result["forgotten_install"] = before
	result["forgotten_ticket"] = emailed.get("id")
	result["new_install"] = c.get_installation_id()
