import os

/// The app's log, in Console under the subsystem com.bavrk.hush. Messages
/// never carry a token, an email or what a user wrote.
let log = Logger(subsystem: "com.bavrk.hush", category: "app")
