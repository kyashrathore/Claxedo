# notifications

Owns: the alert sound and the system notification a session raises when it needs the reader. Settings owns the choices (`preferences.tsx` `alerts`: per kind, a system notification on or off and a sound or None); the app root mounts `AttentionAlerts` with them.

## When an alert fires

`createAlertDetector` reads the server's event stream:

- **agent:** a session's status, with its background work (`sessionStatusWithBackgroundWork`), goes idle after working or retrying. A turn that ends while background work runs leaves the session running in background and raises nothing, and work that settles after that raises nothing either: Claude reports the work settled before it admits the turn that reports it, so the alert waits for that turn to end. Work that settles with no turn after it raises no alert. A status that arrives idle with nothing before it is a reconnect, not a finished turn, and raises nothing; `session.idle` and `session.status` both report idle, and the transition fires once.
- **errors:** a session's status turns failed.
- **permissions:** a permission request opens (a question does not).

A subagent's session never alerts, and neither does a session the list store does not hold. The sound plays when the session is not the one on screen; the system notification needs the browser's permission, which only a Notifications switch turned on asks for, and it is skipped while the window is visible and focused. Clicking it opens the session.

## Unseen outcomes

An `agent` or `errors` alert for a session that is not on screen marks its turn's outcome (`finished` or `failed`) unseen, and the rail draws the session's grey finished dot or blue failed dot only while it is; the later turn's outcome replaces an earlier one. Opening the session (the route names it) marks it seen. A read that finds the last turn ended, on open, reload or reconnect, marks nothing: the reader is looking at it, or the turn ended while the app was not running. The marks live in `SessionStores.unseenOutcomes` for the principal's server scope; both rail readers use the existing session context. `AttentionAlerts` raises and acknowledges them.

## Flows

15 (a background session's finished turn plays the sound and shows the notification; Sounds set to None stays silent) and 10 (a background turn's finished dot clears once the session is opened; a failed turn's dot clears once the session is opened, stays cleared after a reload, and returns for the next failure).
