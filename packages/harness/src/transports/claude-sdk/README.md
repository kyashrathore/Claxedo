# Claude Agent SDK transport

The native transport carries local plugin folders through the SDK `plugins` option, per query effort, replay confirmed streaming steering, and the SDK's per turn usage events. These surfaces are absent from standard ACP. Claude over ACP can receive plugin folders only through its wrapper's version specific `_meta.claudeCode.options` extension.

The SDK's `spawnClaudeCodeProcess` callback returns synchronously. `HarnessServices.spawn` returns a promise. `ClaudeProcess` gives the SDK streams immediately, forwards them to the process once `services.spawn` returns, and delegates retirement to that exact `OwnedProcess`. The callback never starts a process directly.

Brokered credentials are selected in `StartInput` by the session owner. `TurnInput.origin` is not used for credential choice. The Claude Code home for a brokered session is a Claxedo owned directory containing scrubbed copies of supported settings files. A machine owner session without brokered credentials uses their own Claude login. Permission requests are answered by `TurnBroker`; the broker persists an answer before the callback releases the tool. The SDK's suggested permission updates are not applied to the person's settings.

The SDK reports `session_id` after a query has begun. The transport delays `SessionBroker.rebind` until that query settles because the current broker keeps the turn's original upstream binding in its immutable request authority. This leaves a recovery gap if the process dies before the first turn settles. The broker needs an atomic live turn rebind to close it.

Native goals remain unavailable until the contract can acknowledge a provider turn's admission before waiting for its completion. The transport reports `actions: []` and `available: false` meanwhile. Per turn usage is yielded from the existing Claude translator; the frozen `TurnBroker` has no `meter` method.
