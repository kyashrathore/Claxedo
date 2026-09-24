# notifications

Owns: the alert sound and the system notification a session raises when it needs the reader. Settings owns the choices (`preferences.tsx` `alerts`: per kind, a system notification on or off and a sound or None); the app root mounts `AttentionAlerts` with them.

## When an alert fires

`createAlertDetector` reads the server's event stream:

- **agent:** a session's status goes idle after working, retrying or recovering. A status that arrives idle with nothing before it is a reconnect, not a finished turn, and raises nothing; `session.idle` and `session.status` both report idle, and the transition fires once.
- **errors:** a session's status turns failed.
- **permissions:** a permission request opens (a question does not).

A subagent's session never alerts, and neither does a session the list store does not hold. The sound plays when the session is not the one on screen; the system notification needs the browser's permission, which only a Notifications switch turned on asks for, and it is skipped while the window is visible and focused. Clicking it opens the session.

## Flows

15 (a background session's finished turn plays the sound and shows the notification; Sounds set to None stays silent).
