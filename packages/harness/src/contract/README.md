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

- **`SessionBroker.rebind` commits the binding, and a `HarnessSession` never changes.** `rebind` returns the binding the store now holds, frozen. A transport builds its `HarnessSession` from that value and replaces the whole session object when the upstream id changes; it never assigns a binding field. The host reads the current binding from its store before every call, so a handle from before a rebind is refused as not attached. After a rebind:
  - the session's active turn and its later asks carry the new upstream id;
  - a request asked before the rebind stays answerable.

  A harness that reports its session id only inside the first turn can rebind at once, and a crash before the turn ends still leaves a durable binding.
- **A URL consent lives as long as its session.** An accepted URL elicitation stays outstanding until the transport calls `completeElicitation`, or until the host calls `RequestBroker.closeSession`; a harness that dies first cannot leave the `elicitationId` refused for the broker's lifetime.
- **`admitProviderTurn` resolves when the turn is admitted, not when it ends.** `settled` resolves when the run ends and never rejects. The run receives the admitted turn's `TurnRef`, and the result carries the same one: a native goal turn translates and meters its events under that `assistantMessageId`, and answers a later `cancel` by that `turnId`. The host, not the transport, mints the identity.
  - The runtime owns cancelling a provider turn, as it does any turn: it aborts the turn's signal. A run that ends after that signal aborted settles `cancelled`, whether it returned or threw.
  - A transport's own stop of a native goal interrupts the harness. The runtime's goal-stop route then cancels the provider turn it admitted.
- **`SessionBroker.publish` carries session-level events that arrive with no turn active.** Examples are quota windows and command updates. Usage outside a turn goes through `meter`.

## Turns

- **`TurnInput` carries resolved values.** The host resolves `model`, `effort` and `system` once, from the turn's own choices and the session's stored config, before `send`. A transport reads only those fields; `prompt` carries the parts, agent, attachments and delivery, never a second model, variant or system block. A turn with no `model` runs the harness's own current model.
- **A turn the transport cannot run or finish throws from `send`'s iterator.** A refused launch, an undeliverable prompt, a dead process, a protocol failure or an engine error rejects the iteration with the transport's typed error. It is never yielded as an `error` event. An `error` event is only the harness's own reported outcome, translated from its protocol by the corpus-proven translator.
- **`services.spawn` takes the caller's `signal`.** A spawn whose signal is already aborted, or aborts before the process is handed back, rejects and leaves nothing running. A process that was handed back is the caller's to retire; the signal does not retire it.

## Configuration

- **`config.options` previews one model.** `ConfigPreviewTarget` is a session with an optional requested `model`, or a draft. A draft previews its own `model`; a session previews the requested `model` when given and its current model otherwise. The result is `{ options, resolvedModel? }` in the route's own shape, and `resolvedModel` is derived from the model select's current value and the label the harness published for it, through `configOptionsPreview`; it is absent when the harness named no current model or no label for it.

- **A listed command runs as a normal turn.** `commands.list` returns a name only when a turn whose text prompt is `/name [args]` executes it. A transport that needs a native call translates that prompt inside `send`; otherwise it does not list the command. The legacy command route remains unsupported.
- **`configure(session, update)` is called once for each live session a change affects.**
  - For credentials, those are the owner's sessions. For projection, they are the workspace's sessions.
  - `after-active-turns` means that session's own turn, so a change in one workspace never waits on another's.
  - A transport that shares one process across sessions applies an update once and answers each session.
- **Credentials follow the session's owner (`StartInput.owner`).** `TurnInput.origin` is for authorization and audit only.
- **Command and agent listing name their target.** A session target reads that session's process. A draft target uses its launch context, cancels requests without a person, bounds discovery, and retires the probe.

## Events

A protocol event a transport doesn't recognize becomes a `diagnostic` event with the code `unrecognized-event`, through `src/translate/unrecognized.ts`. Its payload is capped at 4 KB.
