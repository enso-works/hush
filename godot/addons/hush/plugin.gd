@tool
extends EditorPlugin
## Adds the Hush autoload when the plugin is enabled, and removes it when it is
## disabled. The game calls Hush.configure() itself: the plugin sends nothing.

const AUTOLOAD := "Hush"


func _enable_plugin() -> void:
	# Next to this script, wherever the add-on was copied to.
	add_autoload_singleton(AUTOLOAD, get_script().resource_path.get_base_dir().path_join("hush.gd"))


func _disable_plugin() -> void:
	remove_autoload_singleton(AUTOLOAD)
