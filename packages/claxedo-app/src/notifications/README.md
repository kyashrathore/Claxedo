# notifications

Owns: the alert sound and the system notification a session raises when it needs the reader, and the reader's unseen failures (`unseen-failures.ts`). Settings owns the choices (`preferences.tsx` `alerts`: per kind, a system notification on or off and a sound or None); the app root mounts `AttentionAlerts` with them.

## When an alert fires

`createAlertDetector` reads the server's event stream:

- **agent:** a session stops being in progress: its status goes idle after working, retrying or recovering with no background work left, or its background work settles while its status is idle. A turn that ends while background work runs raises nothing, because the session is still in progress. A status that arrives idle with nothing before it is a reconnect, not a finished turn, and raises nothing; `session.idle` and `session.status` both report idle, and the transition fires once.
- **errors:** a session's status turns failed.
- **permissions:** a permission request opens (a question does not).

A subagent's session never alerts, and neither does a session the list store does not hold. The sound plays when the session is not the one on screen; the system notification needs the browser's permission, which only a Notifications switch turned on asks for, and it is skipped while the window is visible and focused. Clicking it opens the session.

## Unseen failures

An `errors` alert for a session that is not on screen marks its failure unseen, and the rail draws the failed session's dot only while it is. Opening the session (the route names it) marks it seen. A read that finds the last turn failed, on open, reload or reconnect, marks nothing: the reader is looking at it, or the failure happened while the app was not running. The marks live for the app's run; `AttentionAlerts` provides them to the shell it wraps (`useUnseenFailures()`).

## Flows

15 (a background session's finished turn plays the sound and shows the notification; Sounds set to None stays silent) and 10 (a failed turn's dot clears once the session is opened, stays cleared after a reload, and returns for the next failure).
