# Harness contract

Everything a transport sees. The types say the shapes; this file says the rules the types can't.

## Requests

- **An answer is final once it is saved.**
  - An abort that lands before the save wins. The abort can be the turn's signal or the ask's own `signal`. The broker saves `cancelled`, the ask resolves `cancelled`, and a later answer is refused as `stale`.
  - An abort that lands after the save changes nothing: the ask resolves with the saved answer, and the turn's own cancel stops the turn.
  - So the saved answer is always the one the harness was given, which is what "saved before released" exists to guarantee under a store where the first write wins.
- **A cancel is never answered as an allow.** Each transport sends its protocol's own cancel answer.
- **A draft probe runs without a person.** A request raised during a probe is answered `cancelled` through the harness's protocol, is never shown, and the probe's process is retired.

## Sessions

- **`SessionBroker.rebind` moves the live turn.** After it:
  - the session's active turn and its later asks carry the new upstream id;
  - a request asked before the rebind stays answerable.

  A harness that reports its session id only inside the first turn can rebind at once, and a crash before the turn ends still leaves a durable binding.
- **`admitProviderTurn` resolves when the turn is admitted, not when it ends.** `settled` resolves when the run ends and never rejects.
- **`SessionBroker.publish` carries session-level events that arrive with no turn active.** Examples are quota windows and command updates. Usage outside a turn goes through `meter`.

## Configuration

- **`configure(session, update)` is called once for each live session a change affects.**
  - For credentials, those are the owner's sessions. For projection, they are the workspace's sessions.
  - `after-active-turns` means that session's own turn, so a change in one workspace never waits on another's.
  - A transport that shares one process across sessions applies an update once and answers each session.
- **Credentials follow the session's owner (`StartInput.owner`).** `TurnInput.origin` is for authorization and audit only.
- **Command and agent listing name their target.** A session target reads that session's process. A draft target uses its launch context, cancels requests without a person, bounds discovery, and retires the probe.

## Events

A protocol event a transport doesn't recognize becomes a `diagnostic` event with the code `unrecognized-event`, through `src/translate/unrecognized.ts`. Its payload is capped at 4 KB.
