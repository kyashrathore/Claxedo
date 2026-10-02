# Harnesses and sessions

Claxedo owns session identity, turn admission, durable readback, requests and
presentation. Each harness owns its model conversation, agent loop, tools and
compaction. The two meet at
[`HarnessTransport`](../../packages/harness/src/contract/transport.ts) and
[`BrokerPorts`](../../packages/harness/src/broker/ports.ts), whose rules live in
the [contract README](../../packages/harness/src/contract/README.md). This
document traces the flow across packages; protocol and format details live in
the README beside each owner.

## Sending a message

1. The session message route in
   [`session-core.ts`](../../packages/session-core/src/routes/session-core.ts)
   parses the body with `parseSessionPromptBody`.
   [`session-prompt-admission.ts`](../../packages/session-core/src/routes/session-prompt-admission.ts)
   admits or queues the delivery and calls `runRuntimePromptTurn` in
   [`session/service.ts`](../../packages/session-core/src/session/service.ts),
   which builds the turn input and calls the runtime's `turns.start`.
2. [`createAgentRuntime`](../../packages/session-core/src/host/runtime.ts)
   admits the turn. A busy session takes a steer or a queued delivery, chosen in
   [`turn-admission.ts`](../../packages/session-core/src/host/turn-admission.ts);
   [`steered-inputs.ts`](../../packages/session-core/src/host/steered-inputs.ts)
   tracks when the harness reports a steer entering its conversation.
3. [`SessionAttachments`](../../packages/session-core/src/host/attachments.ts)
   attaches the transport named by the session's stored execution binding.
   [`createWorkspaceHost`](../../packages/workspace-runtime/src/workspace/runtime.ts)
   builds it with [`createHarnessComposer`](../../packages/harness/src/compose.ts).
4. [`turnPrompt`](../../packages/session-core/src/host/turn-record.ts)
   resolves model, effort and system values; `runTurn` in
   [`turn-runner.ts`](../../packages/session-core/src/host/turn-runner.ts)
   iterates the transport's `send` with the admitted turn identity and its
   broker, and records the outcome through
   [`turn-outcome.ts`](../../packages/session-core/src/host/turn-outcome.ts).
   A transport failure is a thrown `TransportError`; a provider-reported error
   is an event.
5. [`createSessionEventWriter`](../../packages/session-core/src/projection/session-event-writer.ts)
   commits each presentation event to
   [`RuntimeStore`](../../packages/session-core/src/store.ts) before
   [`RuntimeEventHub`](../../packages/session-core/src/projection/runtime-event-hub.ts)
   publishes it. The SQLite journal is the durable readback source; the runtime
   [architecture](../../packages/workspace-runtime/docs/architecture.md) owns
   the journal and its views.

## Transport selection

A request selects a built-in with `nativeHarness` or a configured agent with
`connectionId`, validated in
[`routes/config.ts`](../../packages/workspace-runtime/src/routes/config.ts).
[`registry/table.ts`](../../packages/harness/src/registry/table.ts) maps
built-in IDs to transports and names ACP and Pi RPC as custom connection
providers;
[`host/composition.ts`](../../packages/workspace-runtime/src/host/composition.ts)
supplies executables and state roots.

| Selection | Transport |
|---|---|
| Claude | [`ClaudeSdkTransport`](../../packages/harness/src/transports/claude-sdk/index.ts), Claude Agent SDK |
| Codex | [`CodexAppServerTransport`](../../packages/harness/src/transports/codex-app-server/index.ts), `codex app-server` |
| Cursor | [`CursorSdkTransport`](../../packages/harness/src/transports/cursor-sdk/index.ts), `@cursor/sdk` in a host process |
| Pi | [`PiRpcTransport`](../../packages/harness/src/transports/pi-rpc/index.ts), Pi in RPC mode |
| OpenCode | [`OpenCodeSdkTransport`](../../packages/harness/src/transports/opencode-sdk/transport.ts), the embedded engine |
| Custom ACP | [`AcpTransport`](../../packages/harness/src/transports/acp/index.ts), a local process or remote peer |

Permission modes and each harness's `defaultModeId` are declared in
[`harness-permission-modes.ts`](../../packages/agent-runtime-contract/src/harness-permission-modes.ts).
Public capabilities come from each transport's declared facts and operation
groups through [`capabilities/wire.ts`](../../packages/harness/src/capabilities/wire.ts),
never from a harness name ([capabilities](../../packages/harness/src/capabilities/README.md)).

Goal mutations go through
[`createRuntimeGoalController`](../../packages/session-core/src/host/goal-controller.ts).
Claude, Codex and Cursor expose native goal operations, Pi and OpenCode declare
none, and ACP derives them from its extensions. A provider-originated run is
admitted through
[`admitProviderTurn`](../../packages/harness/src/broker/goals/index.ts), so the
host supplies its turn identity.

## Credentials, conversation stores and plugins

[`sessionCredentials`](../../packages/session-core/src/host/launch.ts)
selects credentials for the stored session owner; `TurnInput.origin` names the
caller for authorization and audit and never selects the spending account.
`selectSessionCredentials` in
[`registry/credentials.ts`](../../packages/harness/src/registry/credentials.ts)
applies the machine-login policy declared in
[`contract/credentials.ts`](../../packages/harness/src/contract/credentials.ts).

The runtime transcript and the harness conversation are separate stores. Each
profile README owns where its harness keeps conversations and configuration:

- [Codex](../../packages/harness/src/profiles/codex/README.md): one
  conversation store per owner, linked from every Claxedo-owned home of that
  owner.
- [Claude](../../packages/harness/src/profiles/claude-code/README.md): the
  machine owner's own Claude home for their own login, a Claxedo-owned config
  home for a brokered session.
- [Cursor](../../packages/harness/src/profiles/cursor/README.md): a
  Claxedo-owned home held by the SDK host.
- [Pi](../../packages/harness/src/profiles/pi/README.md): `selectPiProfile`
  chooses the owner's own agent directory or a brokered per-session profile;
  [`pi-rpc/launch.ts`](../../packages/harness/src/transports/pi-rpc/launch.ts)
  refuses a prompted session whose session file is gone.
- [OpenCode](../../packages/harness/src/profiles/opencode/README.md): MCP
  servers and skills through the embedded engine's per-location plugin hooks,
  with nothing written into the project.

[`host/projection.ts`](../../packages/session-core/src/host/projection.ts)
projects Agent Plugins into each transport's launch shape; an entry a transport
cannot take is reported as `notApplied`. For a remote ACP peer,
[`mcp-filter.ts`](../../packages/harness/src/capabilities/mcp-filter.ts)
drops first-party and plugin servers, stdio servers and any remote kind the
peer did not declare.

## Questions and permissions

A provider request goes through the turn or session broker. The
[request table](../../packages/harness/src/broker/requests/table.ts) owns its
live state and the
[store broker ports](../../packages/session-core/src/broker-ports/index.ts)
persist and publish it; the contract README defines answer, cancellation and
child-routing rules.

## Native subagents and background work

A provider spawn is bound to a Claxedo child session before its events are
delivered. [`child-turns.ts`](../../packages/session-core/src/host/child-turns.ts)
owns child turn lifetime and
[`child-routes.ts`](../../packages/session-core/src/projection/child-routes.ts)
resolves routes from durable bindings. A background child keeps its own open
turn, and
[`BrokerSessionEvents`](../../packages/session-core/src/broker-ports/session-events.ts)
routes its events while the parent is idle.

| Producer | Child activity source |
|---|---|
| Claude | [`subagent-observations.ts`](../../packages/harness/src/transports/claude-sdk/translate/subagent-observations.ts), [`live-query.ts`](../../packages/harness/src/transports/claude-sdk/live-query.ts) |
| Codex | [`native-children.ts`](../../packages/harness/src/transports/codex-app-server/native-children.ts), [`child-delivery.ts`](../../packages/harness/src/transports/codex-app-server/child-delivery.ts) |
| Cursor | [`host-deltas.ts`](../../packages/harness/src/transports/cursor-sdk/host-deltas.ts), [`deltas.ts`](../../packages/harness/src/transports/cursor-sdk/deltas.ts) |

Claxedo's first-party MCP `create_subagent` is the separate cross-harness path,
through [`session-children.ts`](../../packages/session-core/src/routes/session-children.ts).

[`BrokerBackgroundWork`](../../packages/session-core/src/broker-ports/background-work.ts)
publishes live counts of a session's agents, shells and other work as
`session.background-work`; it is not persisted and does not hold the next
prompt. `POST /session/:id/background-task/stop` with a `toolCallId` reaches
[`createBackgroundTaskStops`](../../packages/session-core/src/host/background-tasks.ts):
a transport without the operation answers `unsupported`, and a session with no
running harness process answers `not_found` without launching one.

## Provider events and versions

Each transport's README lists the provider events it maps and ignores; unknown
events become bounded diagnostics through
[`unrecognized.ts`](../../packages/harness/src/translate/unrecognized.ts).
[`HarnessVersionGate`](../../packages/harness/src/contract/harness-version.ts)
checks a CLI against the tested range its transport declares; library versions
are pinned in [`package.json`](../../packages/harness/package.json).

## Terminal-tab status

A CLI a person runs inside a terminal tab reports running, waiting and done
through hooks that post to `POST /api/wr/hook/agent-lifecycle`
([`AgentHookRoutes`](../../packages/workspace-runtime/src/routes/agent-hook.ts)).
These hooks set tab status only; they never produce a session transcript.

The nine first-party templates (Claude Code, Codex, Cursor, Gemini,
Antigravity, Droid, Mastra, Amp and Copilot) are data in the bundled
`@claxedo/status-hooks` package. The engine in
[`agent-hooks/`](../../packages/workspace-runtime/src/agent-hooks/README.md)
installs each as wrapper flags, a config merge or a project file, and maps its
events to tab status. Templates come only from that package: a template defines
shell wrappers and rewrites files in the person's home, so a plugin manifest
that declares `claxedo.statusHooks` is refused with
`PluginStatusHooksRefusedError` (`status_hooks_first_party_only`). The
[hook contract](../../packages/workspace-runtime/src/agent-hooks/README.md)
lists every write and refusal rule.

## Contributor entrypoints

The [package instructions](../../packages/harness/AGENTS.md) define import
boundaries, file sizes and checks. From `packages/harness`, run `bun run check`
and focused `bun test <file>`; the
[flows and wire corpus](../../packages/harness/e2e/README.md) and the
[translator corpus](../../packages/harness/src/translate/README.md) hold the
real-entrypoint and provider-boundary evidence.
