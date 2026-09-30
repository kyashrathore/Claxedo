# Harness contract

Everything a transport sees. The types say the shapes; this file says the rules the types can't.

## Requests

- **An answer is final once it is saved.**
  - An abort that lands before the save wins. The abort can be the turn's signal or the ask's own `signal`. The broker saves `cancelled`, the ask resolves `cancelled`, and a later answer is refused as `stale`.
  - An abort that lands after the save changes nothing: the ask resolves with the saved answer, and the turn's own cancel stops the turn.
  - So the saved answer is always the one the harness was given, which is what "saved before released" exists to guarantee under a store where the first write wins.
- **A cancel is never answered as an allow.** Each transport sends its protocol's own cancel answer.
- **A child's request is filed on the child's session.** A transport names the subagent that raised a request with `TurnRequest.child`, the correlation key the child's frames route by; it never names a session. The broker resolves the key through `BrokerPorts.childRoute`, the parent's own child bindings, and files, publishes and keys the request on that child, with `sessionID` rewritten from the parent to the child. The request is answered only on the child, and an "always allow" grant is saved on the parent under the parent's connection, so it scopes as a parent grant does.
  - Asked through a `TurnBroker`, the parent turn's authority owns it: that turn's end, signal or owner change cancels it. A key that names no bound child, or a child whose turn finished, files it on the parent with a `child_request_route_*` diagnostic.
  - Asked through `SessionBroker.ask`, the child's own open turn owns it, so a subagent can ask while its parent is idle. It is current only while that turn is open, the key still routes to that child and turn, and the parent's binding and owner generation are unchanged; the check runs again at every answer and listing. A parent turn that starts meanwhile neither owns nor re-files it. It is cancelled when the child's turn settles (`BrokerOwner.endChildTurn`), when its ask's signal aborts, and when the parent or child session closes. A key with no open child turn is refused with a `child_request_route_*` diagnostic.
- **A draft probe runs without a person.** A request raised during a probe is answered `cancelled` through the harness's protocol, is never shown, and the probe's process is retired.

## Sessions

- **`SessionBroker.rebind` commits the binding, and a `HarnessSession` never changes.** `rebind` returns the binding the store now holds, frozen. A transport builds its `HarnessSession` from that value and replaces the whole session object when the upstream id changes; it never assigns a binding field. The host reads the current binding from its store before every call, so a handle from before a rebind is refused as not attached. After a rebind:
  - the session's active turn and its later asks carry the new upstream id;
  - a request asked before the rebind stays answerable.

  A harness that reports its session id only inside the first turn can rebind at once, and a crash before the turn ends still leaves a durable binding.
- **A URL consent lives as long as its session.** An accepted URL elicitation stays outstanding until the transport calls `completeElicitation`, or until the host calls `RequestBroker.closeSession`; a harness that dies first cannot leave the `elicitationId` refused for the broker's lifetime.
- **`admitProviderTurn` resolves when the turn is admitted, not when it ends.** `settled` resolves when the run ends and never rejects. A provider turn asked for while another turn still holds the session, a prompted turn finishing or a provider turn settling, is handed the session the moment that turn releases it, so a transport never orders its own admissions; one still held after 30 s is refused as `busy`. The run receives the admitted turn's `TurnRef`, and the result carries the same one: a native goal turn translates and meters its events under that `assistantMessageId`, and answers a later `cancel` by that `turnId`. The host, not the transport, mints the identity.
  - The runtime owns cancelling a provider turn, as it does any turn: it aborts the turn's signal. A run that ends after that signal aborted settles `cancelled`, whether it returned or threw.
  - A transport's own stop of a native goal interrupts the harness. The runtime's goal-stop route then cancels the provider turn it admitted.
- **`SessionBroker.publish` carries session-level events that arrive with no turn active.** Examples are quota windows and command updates. Usage outside a turn goes through `meter`.
- **A child's events need no parent turn.** `SessionBroker.observeSubagent` and `associateChild` admit and bind a subagent as a turn's broker does, and `publishChild` delivers a child-routed event through the host's child resolver, so a background subagent's transcript moves while its parent is idle. `publishChild` refuses an event without a child route.

## Turns

- **`TurnInput` carries resolved values.** The host resolves `model`, `effort` and `system` once, from the turn's own choices and the session's stored config, before `send`. A transport reads only those fields; `prompt` carries the parts, agent, attachments and delivery, never a second model, variant or system block. A turn with no `model` runs the harness's own current model.
- **A turn the transport cannot run or finish throws from `send`'s iterator.** A refused launch, an undeliverable prompt, a dead process, a protocol failure or an engine error rejects the iteration with the transport's typed error. It is never yielded as an `error` event. An `error` event is only the harness's own reported outcome, translated from its protocol by the corpus-proven translator.
- **A native harness's own `error` event names the account the turn launched on.** Claude, Codex, Cursor and Pi pass their `send` stream through `withTurnAccount` with `selectedTurnAccount` over the same provider ids their launch selects: the stored credential's non-secret `account` from its binding, or this computer's login when no binding is selected. A binding from an authority that names no account names nothing. ACP and OpenCode report no account.
- **A thrown `TransportError` may carry `detail`:** facts the transport established about the failure, which the host puts on the turn's error record beside the message.
- **`backgroundTasks.stop` stops one piece of background work and nothing else.** A transport implements it only when its harness can stop a single background task while the session, its turn and its other tasks go on. The task is named by the `toolCallId` of the call that started it, which is what the subagent row the host shows carries; the transport maps that call to its harness's own task id. It resolves `{ ok: true }` once the harness accepted the stop; the task's end still arrives as the harness reports it. A call with no running task behind it resolves `not_found`.
- **`sessionTools` is optional.** A transport that dispatches host-scoped tools inside its engine implements it; the host hands every other harness the tools as a prompt.
- **`services.spawn` takes the caller's `signal`.** A spawn whose signal is already aborted, or aborts before the process is handed back, rejects and leaves nothing running. A process that was handed back is the caller's to retire; the signal does not retire it.

## Configuration

- **`config.options` previews one model.** `ConfigPreviewTarget` is a session with an optional requested `model`, or a draft. A draft previews its own `model`; a session previews the requested `model` when given and its current model otherwise. The result is `{ options, resolvedModel? }` in the route's own shape, and `resolvedModel` is derived from the model select's current value and the label the harness published for it, through `configOptionsPreview`; it is absent when the harness named no current model or no label for it. A model row that is an alias carries `resolvedModel`, the full model id it runs, so a session stored on that id reads the alias row as current.

- **A runtime-owned config has one reader.** A transport that declares `configOwner: "runtime"` reads every launch value from `SessionBroker.config()` and keeps no copy. Its `config.update` and `setPermissionMode` validate and return the config the runtime persists through `applySessionConfigUpdate`; the broker exposes no config write.
- **Grants are the broker's, keyed by the transport.** `persistAnswer` saves an `allow_always` grant under `namespacedGrantKey(connectionId, grantKey)` in `permissionState.brokerGrants`; a transport reads its own back through `connectionGrantKeys` and decides what its key means. The request identity inside a key goes through `grantIdentity` (`grant-identity.ts`), a SHA-256 digest, so a persisted or published grant never carries a command, patch or file; each transport decides which display-only fields to drop before hashing.
- **A listed command runs as a normal turn.** `commands.list` returns a name only when a turn whose text prompt is `/name [args]` executes it. A transport that needs a native call translates that prompt inside `send`; otherwise it does not list the command. The legacy command route remains unsupported.
- **`configure(session, update)` is called once for each live session a change affects.**
  - For credentials, those are the owner's sessions. For projection, they are the workspace's sessions.
  - `after-active-turns` means that session's own turn, so a change in one workspace never waits on another's.
  - A transport that shares one process across sessions applies an update once and answers each session.
- **Credentials follow the session's owner (`StartInput.owner`).** `TurnInput.origin` is for authorization and audit only.
- **A harness that moves its own permission mode reports it.** `StartInput.permissionModeKept({ modeId, label })` stores the mode the harness keeps (with the harness's own name for a mode it lists itself) and publishes the session's row when it moved. A transport calls it with each report: ACP on create, on resume and whenever the agent moves its mode; Claude when an always-allow answer carries a `setMode`. A probe launch belongs to no session and carries none.
- **A draft probe's answer is kept only while the files it read are unchanged.** `DraftProbeCache.read(key, inputs, probe)` takes the files the caller's probe reads and stamps each (inode, mtime, size, or absent) before and after the probe; an answer is kept only when both stamps agree and is dropped at the first read that sees a change. Concurrent reads share one probe, a failed probe is never kept, and `peek` never starts one. A caller names every input it can in `ProbeInputs.files`: Pi its owner profile files and extensions and the `.pi` folders on the workspace's path, Codex the owner's `config.toml` and `auth.json` and the project `.codex/config.toml`, Claude its settings files, `.credentials.json` and the `.claude.json` account. A file Claxedo rewrites on every launch is never named, or nothing would be kept. `ProbeInputs.maxAge` also expires an answer that long after its probe started; only ACP sets it (30 seconds), because an ACP agent's own state is not a file Claxedo can name. Every other answer changes only with its files, the key (workspace, directory, locality, owner, harness, model, projection and credential lease generations) or a new transport.
- **Command and agent listing name their target.** A session target reads that session's process. A draft target uses its launch context, cancels requests without a person, bounds discovery, and retires the probe.

## MCP projection

- **An entry a harness cannot represent is reported, never altered.** `harnessSupportsMcpServer` is the one rule: a stdio `cwd` is representable for Codex (`mcp_servers.<name>.cwd`), Cursor (SDK `McpServerConfig.cwd`) and OpenCode (`LocalConfig.cwd` in `@opencode-ai/schema`), and not for ACP (`McpServerStdio` has no `cwd`) or the Claude Agent SDK (`McpStdioServerConfig` has no `cwd`); Codex takes no SSE server (`codex-app-server/configuration.ts` refuses it); Pi has no MCP. An entry that fails it is left out, the rest launch, and the skip is recorded as `notApplied: unsupported-by-harness` under the server's flat name. The host applies it to every projected server (`projectMcpForHarness`, snapshot servers and OpenCode's launch row, ACP connections included); the server-core `pluginMcpProjection` applies it to the plugin servers Claude, Codex and Cursor read from plugin roots, which never reach the host. A transport encodes the servers it receives and reports `projection.notApplied`.
- **Plugin provenance survives the projection.** A snapshot MCP entry's `source` must be exactly `plugin`, `managed` or `user`, and becomes the `plugin`, `first-party` or `configured` origin the remote filter decides on. Any other value is refused.

## Events

A protocol event a transport doesn't recognize becomes a `diagnostic` event with the code `unrecognized-event`, through `src/translate/unrecognized.ts`. Its payload is capped at 4 KB.

## Health

- **`services.healthChanged()` is called whenever a fact `health.runtime` or `health.connection` answers from changes.** A process lost under a session, its replacement, an ACP connection observation, and an ACP cancel the agent acknowledged but did not act on (and that prompt's end) each call it once. It carries nothing: the host reads both answers again for the sessions it watches and publishes only a changed one, so a transport never publishes health itself.
- **A lost process is `degraded` with reason `harness_process_lost` until a replacement for that session starts** (`ProcessLosses`). A deliberate retirement is not a loss. An ACP agent that acknowledged a cancel whose prompt is still open at the cancel deadline reads the same until that prompt settles or the session closes.

## Harness versions

- **A transport that launches a program the person installed declares the versions it supports as a `HarnessVersionRange`, and the range is the tested range.** `min` and `max` are exactly the two versions the flows and conformance run (`bun run --cwd packages/harness flows:versions`). The transport reads the version the program reports about itself, from a frame it receives anyway, and passes it to its one `HarnessVersionGate`.
  - Below `min` the turn fails with the transport's `configuration` error, not retryable, naming the installed and minimum versions and asking the person to update.
  - A missing or unreadable version is a `protocol` error, never a pass.
  - Above `max` the turn runs: frames a newer program adds must be ignorable by the translator. The first such report in the process publishes one `<transport>.untested_version` diagnostic through the session broker.
