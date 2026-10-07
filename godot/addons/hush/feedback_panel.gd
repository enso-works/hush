class_name HushFeedbackPanel
extends PanelContainer
## A feedback form to drop into a game: a kind, a message, an optional email,
## and a send button. It takes the game's theme like any Control; the texts
## are exported, so they can be translated or replaced in the inspector.
##
## It sends through the Hush autoload, or through `client` when set.

## The ticket was created.
signal sent(ticket_id: String)
## It was not: "offline", "too_many", "failed" or "unavailable".
signal failed(error: String)

## The node that sends: the Hush autoload when left empty.
@export var client: Node
@export var title_text := "Send feedback"
## The kinds, in the server's order: issue, feature, love.
@export var kind_texts: PackedStringArray = ["Something is wrong", "An idea", "Kind words"]
@export var message_placeholder := "What would you like to tell us?"
## With an email, the reply also goes by mail.
@export var show_email := true
@export var email_placeholder := "Email, if you would like a reply by mail (optional)"
@export var send_text := "Send"
@export var sending_text := "Sending..."
@export var sent_text := "Sent. Thank you."
@export var offline_text := "Could not reach the server. Try again later."
@export var too_many_text := "You have sent a lot today. Try again tomorrow."
@export var failed_text := "Something went wrong. Try again later."

const KINDS := ["issue", "feature", "love"]

@onready var _title: Label = %Title
@onready var _kind: OptionButton = %Kind
@onready var _message: TextEdit = %Message
@onready var _email: LineEdit = %Email
@onready var _send: Button = %Send
@onready var _status: Label = %Status

var _busy := false


func _ready() -> void:
	_title.text = title_text
	_kind.clear()
	for i in KINDS.size():
		_kind.add_item(kind_texts[i] if i < kind_texts.size() else KINDS[i], i)
	_message.placeholder_text = message_placeholder
	_email.placeholder_text = email_placeholder
	_email.visible = show_email
	_email.virtual_keyboard_type = LineEdit.KEYBOARD_TYPE_EMAIL_ADDRESS
	_send.text = send_text
	_status.visible = false
	_message.text_changed.connect(_update)
	_send.pressed.connect(submit)
	_update()


func _update() -> void:
	_send.disabled = _busy or _message.text.strip_edges() == ""


func _client() -> Node:
	return client if client != null else get_node_or_null("/root/Hush")


## Sends what the form holds, as the send button does. Returns send_feedback's result.
func submit() -> Dictionary:
	var hush := _client()
	if _busy or _message.text.strip_edges() == "":
		return {"ok": false, "error": "failed"}
	if hush == null:
		_show(failed_text)
		failed.emit("unavailable")
		return {"ok": false, "error": "unavailable"}
	_busy = true
	_update()
	_show(sending_text)
	var input := {"kind": KINDS[maxi(_kind.selected, 0)], "message": _message.text}
	if show_email and _email.text.strip_edges() != "":
		input["email"] = _email.text.strip_edges()
	var result: Dictionary = await hush.send_feedback(input)
	_busy = false
	if result.get("ok", false):
		_message.text = ""
		_show(sent_text)
		sent.emit(str(result.get("id", "")))
	else:
		var error := str(result.get("error", "failed"))
		_show({"offline": offline_text, "too_many": too_many_text}.get(error, failed_text))
		failed.emit(error)
	_update()
	return result


func _show(text: String) -> void:
	_status.text = text
	_status.visible = true
