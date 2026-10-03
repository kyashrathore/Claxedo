# notifications

Owns: the alert sound and the system notification a session raises when it needs the reader. Settings owns the choices (`preferences.tsx` `alerts`: per kind, a system notification on or off and a sound or None); the app root mounts `AttentionAlerts` with them.

## When an alert fires

`createAlertDetector` reads canonical `attentionRaised` events from the server adapter:

- **agent:** a completed outcome is published with its runtime journal identity.
- **errors:** a failed outcome is published with its runtime journal identity.
- **permissions:** a question or permission request opens.

A cancelled outcome, a subagent, and replayed history stay silent. The server event owner deduplicates identities across local, hosted and recovery sources, so notifications need no status history or session-row cache. An unloaded or settled session can alert; its authorized notice carries the title and navigation reference. The sound plays when the session is not the one on screen. System notifications require the browser's permission and are skipped while the window is visible and focused. Clicking one opens its session.

## Unseen outcomes

Unseen outcomes belong to the session list's server-owned reader state. Notifications do not acknowledge or mutate them. Reading the displayed outcome sends a reader acknowledgement from the visible session; reloading, switching sidebar views or recovering attention history leaves that decision to the visible-result owner.

## Flows

15 (a session never opened by the app and older than its initial sidebar window still plays one sound and shows a notification; Sounds set to None stays silent), 10 (server-owned seen/settled state), and 38 (signed background sources and reconnect).
