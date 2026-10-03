# notifications

Owns: the alert sound and the system notification a session raises when it needs the reader. Settings owns the choices (`preferences.tsx` `alerts`: per kind, a system notification on or off and a sound or None); the app root mounts `AttentionAlerts` with them.

## When an alert fires

Alerts are derived from a session's state, not from its transitions. The session stores (`session/store/attention.ts`) compare each live event with the row the list held before it, and `AttentionAlerts` turns what they raise into a sound and a system notification:

- **agent:** the event's last turn completed after the one the row holds (`lastTurn.completedAt` moved forward), and no background work runs (the event's own count when it carries one, otherwise the list's). A turn that ends while background work runs raises nothing, and work that settles after it raises nothing either: the next turn's end is what alerts.
- **errors:** a session that did not already show a failure turns failed: its last turn failed after the one the row holds, or the runtime reports a failure with no recorded turn (a prompt refused before its turn, a stream that threw, a harness error chunk). A failure the stream reported and the turn's end reports again alerts once. A cancelled turn raises nothing.
- **permissions:** the session starts waiting on the reader where the row did not: a permission or a question opens, or a hosted status notice says it waits. A notice that ends a turn and starts a wait raises both alerts.

Any row the list holds alerts, open or not: a session that is not open reaches the app as a hosted `session.status.changed` notice, the same `statusChanged` a runtime frame becomes. Nothing alerts that the row already held: a list read or re-read, on open, reload or reconnect, never passes through the derivation, a turn the row already shows is not newer, and a notice the live-sync room replays to a reconnecting reader is marked replayed and raises nothing.

A subagent's session never alerts, and neither does a session the list store does not hold. The sound plays when the session is not the one on screen; the system notification needs the browser's permission, which only a Notifications switch turned on asks for, and it is skipped while the window is visible and focused. Clicking it opens the session.

## Unseen outcomes

An `agent` or `errors` alert for a session that is not on screen marks its turn's outcome (`finished` or `failed`) unseen, and the rail draws the session's grey finished dot or blue failed dot only while it is; the later turn's outcome replaces an earlier one. Opening the session (the route names it) marks it seen. A read that finds the last turn ended, on open, reload or reconnect, marks nothing: the reader is looking at it, or the turn ended while the app was not running. The marks live in `SessionStores.unseenOutcomes` for the principal's server scope; both rail readers use the existing session context. `AttentionAlerts` raises and acknowledges them.

## Flows

15 (a background session's finished turn plays the sound and shows the notification; Sounds set to None stays silent) and 10 (a background turn's finished dot clears once the session is opened; a failed turn's dot clears once the session is opened, stays cleared after a reload, and returns for the next failure).
