# P3 cutover design, review before code

**Direct answer.** P3 should keep `workspace-runtime` as the sole owner of session admission, recovery, durable writes, and the existing presentation wire, while replacing its adapter acquisition with one `HarnessTransport` per binding and one request broker per store. It moves the host and projection into `workspace-runtime`, removes the old adapter implementations in the same integration slice, and leaves package retirement and app-facing type relocation to P4. This is a proposal, not implemented behavior. The following traces describe code at `5ca6872ac1`; the proposed change point is explicit in each row. The atom is the **last P3 commit**, not a promise that each intermediate commit is a runnable cutover.

## Current user-to-harness path

The browser or control-plane client calls a workspace-runtime session route. `createSessionRoutes` receives an adapter resolver and a runtime resolver from `createWorkspaceHost` (`packages/workspace-runtime/src/workspace/runtime.ts:1967`, `packages/workspace-runtime/src/routes/session-core.ts:1515`). The host selects a runner from the accepted runtime snapshot, validates a connection descriptor, caches an adapter by binding key, and serializes `applyConfig` around active turns (`packages/workspace-runtime/src/workspace/runtime.ts:771`, `:847`, `:930`, `:1053`). Built-in constructors live in `defaultWorkspaceHarnessRegistry` (`:520`); custom descriptors use `createConnectionProviderRegistry` (`:771`). `createAgentRuntime` then owns turn admission, storage, recovery, goals, and subscription around those adapters (`packages/agent-sdk-runtime/src/runtime.ts:81`, `:94`, `:611`). Session state is authoritative in `RuntimeStore` (`packages/workspace-runtime/src/store.ts:826`); the provider's upstream id is a binding, not the public session id.

For a send, `runRuntimePromptTurn` parses the body and calls `runtime.turns.start` (`packages/workspace-runtime/src/session/service.ts:432`, `:475`). The host claims a turn before `store.startTurn`, calls `adapter.executeTurn`, and projects each result (`packages/agent-sdk-runtime/src/runtime.ts:629`, `:661`, `:384`). An aborted or superseded producer is fenced before every write (`:227`, `:386`). The result returns through `runtime.events.subscribe` and the route's SSE fanout; replay reads committed store rows (`packages/agent-sdk-runtime/src/runtime.ts:696`, `packages/workspace-runtime/src/routes/events.ts:496`, `packages/workspace-runtime/src/projection/sse.ts:112`). A failure is finalized into the recovery record before the admission is released (`packages/agent-sdk-runtime/src/runtime.ts:437`, `:448`). **P3 change point:** the adapter lookup becomes a registry lookup for `HarnessTransport`; `executeTurn` becomes `send(session, turn, createTurnBroker(...))`. Admission, fencing, finalization, and the HTTP/SSE shapes remain owned by the moved host.

### Operation-by-operation call map

`R` means observed route or host call; `T` is the proposed transport or broker operation. Lines refer to the present branch. A capability absence is a typed `unsupported_operation` at the route before a harness is launched. Local history always comes from `RuntimeStore`; `history` is only for a harness whose own history is authoritative.

| User action or event; current call chain | P3 call and result path |
| --- | --- |
| Start or draft: `POST /session` resolves adapter, applies model/instructions and child mode, then `adapter.createSession`; `runtime.sessions.create` binds config and emits creation (`routes/session-core.ts:1763`, `:1860`, `:1864`; `packages/agent-sdk-runtime/src/runtime.ts:506`, `:537`). A draft config read uses `adapter.probeConfigOptions` (`routes/session-core.ts:2113`). | Resolve `HarnessRecord` plus connection descriptor; select credentials for **session owner**, construct `StartInput`, use `transport.capabilities` and `transport.start(input, sessionBroker)`. Draft reads use `config.options({draft}, "probe")` or `permissionModes({draft})`, with a bounded retired probe. Persist binding, then return the same session JSON. |
| Send/steer/queue: the route's prompt service calls `runtime.turns.start`; `deliverToBusySession` tries `adapter.steerTurn` or retains a queued delivery, otherwise claims and calls `executeTurn` (`session/service.ts:432`, `:475`; `packages/agent-sdk-runtime/src/runtime.ts:633`, `:644`, `:661`, `:384`). | Keep the host's admission and `session/delivery-owner.ts`; call `transport.steer.steer` for a live turn or `send` for a new one. Yielded `RoutedEvent`s feed the same projector. Preserve `unknown` steering as provider-owned; never resend it. |
| Cancel/Stop: recovery routes call `recovery.inspect/submit/read` (`routes/session-core.ts:1586`, `:1595`, `:1616`), then the host's recovery operation drives the adapter's `cancelTurn` and verifies cleanup (`runtime/recovery-operations.ts:71`). | Keep the recovery engine and receipt schema; its harness edge calls `transport.cancel(session, turnRef, deadline)`. A remote protocol cancel is not proof of process retirement; `needs_action` remains possible. |
| Permission, question, elicitation: routes list pending adapter requests and call `respondPermission`, `replyQuestion`, `rejectQuestion` or start-question variants (`routes/session-core.ts:2858`, `:2878`, `:2905`, `:2926`; `packages/agent-sdk-runtime/src/runtime.ts:708`, `:723`). | Routes retain caller authorization, then call `RequestBroker.list/answer`; transport requests call `TurnBroker.ask` or `SessionBroker.ask`. `persistAnswer` precedes release (`packages/harness/src/broker/requests/table.ts:148`). Publish returned events through the existing projection. Duplicate, foreign, stale and persistence refusals retain typed wire responses. |
| Config read/write: session route reads `adapter.getSessionConfig` and writes `updateSessionConfig`; permission modes and options call separate add-ons (`routes/session-core.ts:2124`, `:2180`, `:2419`, `:2478`; `packages/agent-sdk-runtime/src/runtime.ts:460`). | Runtime-owned config stays in store; harness-owned state calls `config.read/update`, `permissionModes`, `setPermissionMode`, `options`. Snapshot changes call `configure(session, update)` once per affected live session and respect `ConfigApplied` timing. See gap G1 for the current route's options response. |
| Commands and agents: draft `/command` calls `adapter.listCommands`; `/agent` calls `listAgents` (`routes/session-core.ts:2939`, `:2794`), while `runtime.commands.execute` calls `executeCommand` (`packages/agent-sdk-runtime/src/runtime.ts:756`). | `commands.list({draft|session})` and `agents.list({draft|session})`; declared commands run as ordinary `TurnInput` prompts, subject to admission and response publication. The legacy command route retains its 501. See gap G2 for `/compact`. |
| Fork/naming: fork route calls `adapter.forkSession`; rename calls `updateSession`; title owner calls `generateTitle` after a completed turn (`routes/session-core.ts:2528`, `:2140`; `packages/agent-sdk-runtime/src/runtime.ts:443`; `runtime/session-titles.ts:42`). | `fork.fork` returns upstream id for a new public binding; `naming.rename` and optional `naming.generateTitle` are transport effects. The host still decides when to title and persists `session.updated`. |
| History/message pages/todos: routes prefer the runtime store's page and messages and fall through to adapter history (`routes/session-core.ts:2358`, `:2380`, `:2398`, `:2635`; `packages/agent-sdk-runtime/src/runtime.ts:696`). | `RuntimeStore.getMessagePage/getMessages` and turn coverage remain authoritative for local sessions; `history.messages/todos` only if capabilities say harness-owned. Check `todos` capability before returning an empty replay (H-16). Preserve cursor/page and restart readback. |
| Handoff: config update enters `executeHandoffTransaction`, which prepares a target native session, binds it, and keeps the source until a successful turn; deletion currently bypasses source release (`runtime/handoff-transaction.ts:138`, `:252`, `:287`; `routes/session-core.ts:2197`). | Host uses `start/attach/close` for both sides of the same transaction, `SessionBroker.persistHandoff` for restoration, and invokes source release on deletion as well. Preserve pending and rollback semantics (H35). |
| Goals/provider turns: goal routes call `runtime.goals.*`; controller selects native adapter goals or an evaluated loop (`routes/session-core.ts:2063`, `:2077`; `runtime/goal-controller.ts:36`, `:155`). Codex can initiate its own turn through driver host plumbing. | Native `goals.read/start/pause/resume/stop/delete`; evaluated loop stays in host. `SessionBroker.admitProviderTurn` returns admission before `settled`; broker drains its `RoutedEvent`s and host retains cancellation/finalization. |
| Subagents: a driver observes or associates a child, current `createSubagentAdmissionBoundary` and store admit it, then child routing projects its events (`routes/session-children.ts:102`; `subagent-admission.ts:41`, `:74`; `harnesses/shared/child-event-routing.ts:130`). | `TurnBroker.observeSubagent/associateChild` owns validation, correlation and publication through `SubagentBroker`; `BrokerPorts` persists rows only. The host remains responsible for public child routes and parent-scoped SSE. Gap G3 is the current port's policy-bearing `store.admit`. |
| Usage: driver emits `usage`; parent/child projector writes `session.usage`, with outside-turn usage via driver callbacks (`packages/agent-sdk-runtime/src/runtime.ts:304`, `:325`; `harnesses/shared/outside-turn-usage.ts:1`). | In-turn `RoutedEvent.event` carries `usage`; late usage calls `SessionBroker.meter`. Fold tokens into the named assistant message and preserve session totals/quota windows (H-13). |
| Recovery/restart: boot reconciles launch ownership, marks busy sessions recovering, refuses unresolved launches, and later `attach` is currently a lazy adapter reattachment (`workspace/runtime.ts:717`, `:1090`; `runtime/recovery.ts:1`). | Reconciliation precedes transport acquisition; `transport.attach` receives the durable binding. Keep recovery inspection, receipts, `needs_action`, and 503 gating; do not replay a submitted prompt merely because attach failed. |
| Dispose: `createWorkspaceHost` drains active turns, pending requests, adapter retirement and runtime/store work (`workspace/runtime.ts:2384`); runtime disposes adapters and subscribers (`packages/agent-sdk-runtime/src/runtime.ts:789`). | Abort broker asks, cancel/close sessions, `transport.dispose`, retire owned processes, close subscribers and store in the same order. A failed retirement remains inspectable, not silently marked stopped. |

## Event path and the byte-for-byte boundary

**Observed today.** Each driver translates vendor messages with `createAgentEventRuntime`/a harness translator into `AgentRuntimeEvent` (`packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:2`, `packages/agent-sdk-runtime/src/harnesses/pi/driver.ts:17`). `runtime-event-hub` has separate global compat and raw runtime subscribers (`packages/agent-sdk-runtime/src/runtime-event-hub.ts:29`, `:60`). `createAgentRuntime.runTurn` normalizes message ids, suppresses the duplicated opening user row, and sends raw events through `createChildEventRouter` and `createTurnEventProjector` (`packages/agent-sdk-runtime/src/runtime.ts:247`, `:325`, `:346`, `:384`). The projector's input type is **`AgentRuntimeEvent`**; it calls `createClientPresentationProjection.ingest`, appends committed `CompatEvent`s to the store, and publishes raw runtime events (`packages/agent-sdk-runtime/src/harnesses/shared/turn-projection.ts:53`, `:67`, `:86`). `routes/events.ts` turns runtime envelopes into presentation events for SSE, while `projection/sse.ts` handles fanout/replay (`packages/workspace-runtime/src/routes/events.ts:496`, `packages/workspace-runtime/src/projection/sse.ts:112`). `RuntimeStore.appendEvent` is the durable order authority (`packages/workspace-runtime/src/store.ts:3655`).

**Proposed P3.** Each transport's existing translator yields `RoutedEvent {event: AgentRuntimeEvent, route?, source?}` (`packages/harness/src/contract/session.ts:69`). `createSessionBroker`/`createTurnBroker` supply request, subagent, usage, and provider-turn channels (`packages/harness/src/broker/index.ts:18`, `:29`). The moved host unwraps **`RoutedEvent.event` into `AgentRuntimeEvent` before** calling the unchanged `createChildEventRouter`/`createTurnEventProjector`. `route.kind` selects the child target; `source` supplies append provenance. `SessionBroker.publish` and `.meter` enter that same host-owned projection through `BrokerPorts.publishSessionEvent/meterUsage` (`packages/harness/src/broker/ports.ts:71`). `RequestBroker.answer`'s returned runtime events join it too (`packages/harness/src/contract/broker.ts:131`). No second converter may format presentation frames. Preserve assistant aliases, terminal order, author, session id, source and journal sequence. Compare **live SSE, stored page, replay, child ids, and recovery replies** in the wire corpus; translator corpus still compares provider inputs to `AgentRuntimeEvent` before projection.

## Workspace composition and ownership

The current host owns a stable adapter registry, accepted snapshot, descriptor map, launch generation, store, and active-turn drain (`workspace/runtime.ts:771`, `:785`, `:800`, `:862`, `:892`). P3 replaces `defaultWorkspaceHarnessRegistry`'s constructor table (`:520`) with one registry selection. `packages/harness/src/registry/table.ts:13` maps built-in identity to transport kind; the proposed composition adds native Pi and OpenCode entries there only once their transport constructors are ready. Connection descriptors keep `connectionId`, provider key, config revision, enabled state and secret references (`packages/harness/src/registry/providers/types.ts:5`). The five `CustomHarnessProvider` hooks validate immutable identity, project public metadata, resolve secrets, and construct a transport (`:16`). At this base, both ACP and Pi providers still throw `transport_not_built` from `createTransport` (`providers/acp.ts:65`, `providers/pi-rpc.ts:36`); this wiring is part of the atomic slice or its P2 prerequisites. Remote ACP is filtered at every new/load/resume/fork launch, and cannot receive first-party or stdio MCP.

The **real** `BrokerPorts` from the `p3-ports` lane must wrap the *same* `RuntimeStore` that the moved host uses. One `createRequestBroker(ports)` lives per durable store, never one per transport or request; a second broker could retire the first one's pending asks (`packages/harness/README.md`, `packages/harness/src/broker/index.ts:13`). It reads turn/start authority, pending and terminal answers, goals and config from the store; `persistAnswer` commits the answer before `publish` releases a harness waiter; provider-turn admission uses host turn fencing; routed events enter the shared projector. The store persists subagent facts while `SubagentBroker` decides admission (see G3).

`HarnessServices.spawn` is already implemented by `createSpawnService(launchOwnership)` over `process-ownership` (`packages/workspace-runtime/src/spawn-service.ts:5`); the caller supplies this mount's `launchOwner`, including its generation (`workspace/runtime.ts:794`). Compose `transcripts` from `WorkspaceHostOptions.transcripts.resolver` with workspace id (`workspace/runtime.ts:534`), `clock` from the host's clock, `log` from its logger, `patternEvaluator` from the bounded elicitation worker, and `firstPartyMcp` from `firstPartyMcpServerFor` only for local sessions (`workspace/runtime.ts:62`). The accepted runtime snapshot is the projection generation: a new `PluginProjection` belongs to that generation, and `configure` is applied to every affected session by owner for credentials and by workspace for tools. `selectSessionCredentials` uses the persisted **session owner**, not `TurnInput.origin` (`packages/harness/src/registry/credentials.ts:52`, `packages/harness/src/contract/session.ts:29`). OpenCode's process-wide provider overlay requires an owner-scoped engine and a typed refusal for a different owner (plan decision 2); the current host's injected `opencodeRuntime` is still a process owner (`workspace/runtime.ts:214`).

### Contract gaps requiring a ruling before implementation

1. **G1 — config-options wire shape.** The route returns `probeConfigOptions`'s `{options, resolvedModel?}` (`routes/session-core.ts:2113`; `packages/agent-sdk-runtime/src/adapter-contract.ts:330`), while `ConfigOperations.options` returns only `readonly AgentConfigOption[]` (`packages/harness/src/contract/transport.ts:61`). The runtime could infer the model from options, but the plan says no synthesized adapter result. Ruling: preserve the wire object through a host derivation from canonical `config.read`, or amend the contract's return type in the contract lane.
2. **G2 — command execution and `/compact`.** The plan removes `executeCommand` and leaves `POST /session/:id/command` at 501 (`docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md:776`, `docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md:1073`), yet H-12 requires the app's `/compact` to run a harness command or disappear. `CommandOperations` offers only `list` (`contract/transport.ts:76`), while the route still calls `executeCommand` (`routes/session-core.ts:2572`). Ruling: choose the command-as-`send` wire behavior and adjust the app in its lane, or explicitly suppress `/compact` when unsupported. The legacy 501 may remain.
3. **G3 — subagent policy is still in the port/store.** `SubagentBroker.observe` delegates admission to `subagentAdmissionStore.admit` (`packages/harness/src/broker/subagents/index.ts:25`); the old store implementation contains correlation/identity rules (`packages/agent-sdk-runtime/src/subagent-admission.ts:102`, `:295`). P3 requires rules in the broker and persistence only in the store. The current `BrokerPorts` type cannot enforce that separation (`packages/harness/src/broker/ports.ts:44`). The broker and `p3-ports` lane must agree on a narrower persistence port before cutover.
4. **G4 — provider/registry composition is unfinished on this base.** Native Pi/OpenCode are absent from `BUILT_IN_TRANSPORTS` (`packages/harness/src/registry/table.ts:13`); custom ACP/Pi factories are stubs (`providers/acp.ts:65`, `providers/pi-rpc.ts:36`); Claude/Cursor transports and OpenCode's `HarnessTransport` wrapper are not present under `src/transports/`. These are integration gaps, not license to keep old adapters. The atomic cutover waits for their conformance and merged code.
5. **G5 — route capability response mapping.** The route returns `HarnessCapabilities` and uses `hasAdapterCapability` to gate pages, todos, fork, agents and command execution (`routes/session-core.ts:1082`, `:2033`, `:2398`, `:2528`), while `TransportCapabilities` is a different shape (`packages/harness/src/contract/capabilities.ts:21`). The host must project contract capabilities to the existing public wire without identity guesses. If any public field lacks a contract source, amend the contract before P3.
6. **G6 — model and effort draft probes.** `probeConfigOptions(directory, binding, model?)` accepts a requested model and returns its resolved selection (`routes/session-core.ts:2114`); `config.options(target, mode)` has no explicit requested-model argument (`contract/transport.ts:61`). `DraftLaunch` has `model`, but a session target does not. A live session's query-model preview needs an expressible input or an approved route rule. Do not ignore the query.

These six are the **gap count** for this design. G4 describes missing concurrent implementation; G1, G2, G3, G5 and G6 affect contract or boundary expression. No contract is changed in this run.

### Reproducible production import inventory

This includes static imports, `import()` type queries and re-exports from the three packages. It excludes `*.test.*`, `*.spec.*`, `*.vitest.*` and fixture files, but includes e2e contract helpers, production scripts and perf-harness sources. The command is run from the repository root. Each output row is a declaration; symbols imported under more than one subpath appear more than once.

```sh
python3 - <<'PY'
from pathlib import Path
import re
import subprocess
roots = [Path("packages"), Path("script"), Path("scripts")]
module = r"@claxedo/(?:agent-sdk-runtime|agent-event-runtime|opencode-server-adapter)(?:/[^\"']*)?"
static = re.compile(r"import\s+(?:type\s+)?(\{[^}]*\}|[A-Za-z_$][\w$]*(?:\s*,\s*\{[^}]*\})?|\*\s+as\s+[\w$]+)\s+from\s+[\"'](" + module + r")[\"']", re.S)
dynamic = re.compile(r"import\s*\(\s*[\"'](" + module + r")[\"']\s*\)(?:\.([A-Za-z_$][\w$]*))?")
reexport = re.compile(r"export\s+(?:type\s+)?(\*|\{[^}]*\})\s+from\s+[\"'](" + module + r")[\"']", re.S)
rows = []
for root in roots:
    if not root.exists(): continue
    for file in (Path(name) for name in subprocess.check_output(["rg", "--files", str(root)], text=True).splitlines()):
        if file.suffix not in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"): continue
        if any(tag in file.name for tag in (".test.", ".spec.", ".vitest.")) or "fixtures" in file.parts: continue
        source = file.read_text(errors="replace")
        for match in static.finditer(source):
            names = ", ".join(re.sub(r"^type\s+", "", part.strip()).split(" as ")[0] for part in re.split(r",\s*", match.group(1).strip("{} \n")))
            rows.append((str(file), source.count("\n", 0, match.start()) + 1, "import", match.group(2), names))
        for match in dynamic.finditer(source): rows.append((str(file), source.count("\n", 0, match.start()) + 1, "import()", match.group(1), match.group(2) or "module"))
        for match in reexport.finditer(source):
            names = match.group(1).strip("{} \n").replace("type ", "")
            rows.append((str(file), source.count("\n", 0, match.start()) + 1, "re-export", match.group(2), names))
print(f"{len(rows)} imports/re-exports in {len(set(row[0] for row in rows))} production files")
for file, line, kind, module, names in sorted(rows): print(f"{file}:{line} | {kind} | {module} | {names.rstrip()}")
PY
```

```text
209 imports/re-exports in 132 production files
packages/agent-sdk-runtime/src/adapter-contract.ts:12 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/compat-events.ts:16 | import | @claxedo/agent-event-runtime/client-presentation | withClaxedoMessageAuthor
packages/agent-sdk-runtime/src/harnesses/acp/goal-response.ts:1 | import | @claxedo/agent-event-runtime | isRuntimeGoalStatus, RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/acp/goals.ts:2 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/acp/helpers.ts:2 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/agent-sdk-runtime/src/harnesses/acp/process.ts:46 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/acp/subagent-runtime.ts:2 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/agent-sdk-runtime/src/harnesses/acp/subagent-runtime.ts:3 | import | @claxedo/agent-event-runtime/harnesses/acp | createAcpEventTranslator
packages/agent-sdk-runtime/src/harnesses/acp/turn-runner.ts:8 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/agent-sdk-runtime/src/harnesses/acp/turn-runner.ts:9 | import | @claxedo/agent-event-runtime/client-presentation | projectSessionCommands
packages/agent-sdk-runtime/src/harnesses/acp/turn-runner.ts:10 | import | @claxedo/agent-event-runtime/harnesses/acp | createAcpEventTranslator, translateStopReason
packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:2 | import | @claxedo/agent-event-runtime | createAgentEventRuntime, AgentEventRuntime, RuntimeGoalSnapshot,
packages/agent-sdk-runtime/src/harnesses/claude/driver.ts:7 | import | @claxedo/agent-event-runtime/harnesses/claude | CLAUDE_QUESTION_DISMISSED, CLAUDE_SUBAGENT_USAGE_METHOD, claudeChildCorrelationKey, claudeSdkAdapter, claudeSubagentObservations, createClaudeTaskLedger, foldNestedSubagentFrame, ClaudeTaskLedger,
packages/agent-sdk-runtime/src/harnesses/claude/subagent-usage.ts:1 | import | @claxedo/agent-event-runtime/harnesses/claude | claudeChildCorrelationKey, ClaudeSubagentUsage
packages/agent-sdk-runtime/src/harnesses/codex/driver.ts:4 | import | @claxedo/agent-event-runtime | createAgentEventRuntime, AgentEventRuntime,
packages/agent-sdk-runtime/src/harnesses/codex/driver.ts:8 | import | @claxedo/agent-event-runtime/harnesses/codex | codexAppServerAdapter,
packages/agent-sdk-runtime/src/harnesses/codex/goal.ts:2 | import | @claxedo/agent-event-runtime | RawHarnessEvent, RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/codex/host-subagent.ts:2 | import | @claxedo/agent-event-runtime | hostSubagentBinding, hostSubagentObservation, isHostSubagentTool
packages/agent-sdk-runtime/src/harnesses/codex/protocol.ts:2 | import | @claxedo/agent-event-runtime | isRuntimeGoalStatus, RawHarnessEvent, RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/codex/server-request.ts:3 | import | @claxedo/agent-event-runtime/harnesses/codex | codexMcpApproval
packages/agent-sdk-runtime/src/harnesses/codex/thread-projection.ts:1 | import | @claxedo/agent-event-runtime/harnesses/codex | CODEX_DESCENDANT_ERROR_METHOD
packages/agent-sdk-runtime/src/harnesses/codex/thread-projection.ts:2 | import | @claxedo/agent-event-runtime/harnesses/codex | codexCollabAgentCall, codexSubagentActivity, codexStartedSubagent,
packages/agent-sdk-runtime/src/harnesses/codex/thread-registry.ts:1 | import | @claxedo/agent-event-runtime | AgentRuntimeEventOf
packages/agent-sdk-runtime/src/harnesses/codex/thread-registry.ts:2 | import | @claxedo/agent-event-runtime/harnesses/codex | codexCollabAgentCall, codexReportedModel, codexStartedSubagent, codexSubagentActivity, codexUsageGrowth,
packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts:3 | import | @claxedo/agent-event-runtime | createAgentEventRuntime, AgentEventRuntime, RuntimeGoalSnapshot,
packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts:8 | import | @claxedo/agent-event-runtime/harnesses/cursor | cursorRuntimeMessage, cursorSdkAdapter, cursorSubagentObservations,
packages/agent-sdk-runtime/src/harnesses/pi/driver.ts:17 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/agent-sdk-runtime/src/harnesses/pi/driver.ts:18 | import | @claxedo/agent-event-runtime/harnesses/pi | piRpcAdapter
packages/agent-sdk-runtime/src/harnesses/shared/child-event-routing.ts:1 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeUsageObservation
packages/agent-sdk-runtime/src/harnesses/shared/evaluated-goal-resource.ts:2 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/goal-publisher.ts:1 | import | @claxedo/agent-event-runtime | agentRuntimeEvent, RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/goal-stop-order.ts:4 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/native-goal-resource.ts:3 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/native-goal-store.ts:1 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/outside-turn-usage.ts:1 | import | @claxedo/agent-event-runtime | AgentRuntimeEventOf
packages/agent-sdk-runtime/src/harnesses/shared/outside-turn-usage.ts:2 | import | @claxedo/agent-event-runtime/client-presentation | createClientPresentationProjection
packages/agent-sdk-runtime/src/harnesses/shared/runtime-store.ts:12 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-adapter.ts:9 | import | @claxedo/agent-event-runtime | RawHarnessEvent
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-driver.ts:2 | import | @claxedo/agent-event-runtime | AgentEventRuntime, RawHarnessEvent, RuntimeGoalSnapshot, SubagentUpdatedEvent
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-goals.ts:3 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/harnesses/shared/subagent-lifecycle.ts:3 | import | @claxedo/agent-event-runtime | SubagentMode, SubagentStatus, SubagentUpdatedEvent
packages/agent-sdk-runtime/src/harnesses/shared/turn-projection.ts:1 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/agent-sdk-runtime/src/harnesses/shared/turn-projection.ts:2 | import | @claxedo/agent-event-runtime/client-presentation | createClientPresentationProjection
packages/agent-sdk-runtime/src/index.ts:19 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/agent-sdk-runtime/src/index.ts:78 | re-export | @claxedo/agent-event-runtime | isRuntimeGoalStatus, RUNTIME_GOAL_STATUSES
packages/agent-sdk-runtime/src/index.ts:79 | re-export | @claxedo/agent-event-runtime | RuntimeGoalSnapshot, RuntimeGoalStatus
packages/agent-sdk-runtime/src/runtime-event-hub.ts:2 | import | @claxedo/agent-event-runtime | AGENT_RUNTIME_EVENT_CONTRACT_VERSION, AgentRuntimeEvent,
packages/agent-sdk-runtime/src/runtime.ts:8 | import | @claxedo/agent-event-runtime | assistantMessageIdForTurn, AgentRuntimeEvent
packages/agent-sdk-runtime/src/runtime/goal-controller.ts:2 | import | @claxedo/agent-event-runtime | agentRuntimeEvent, RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/runtime/handoff-transaction.ts:2 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/agent-sdk-runtime/src/stores/memory.ts:20 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/agent-sdk-runtime/src/subagent-admission.ts:3 | import | @claxedo/agent-event-runtime | RuntimeDiagnostic, SubagentUpdatedEvent
packages/claxedo-app/e2e/helpers/contracts/session-config.ts:2 | import | @claxedo/agent-sdk-runtime | SessionConfigRequestUpdate
packages/claxedo-app/e2e/helpers/contracts/session-create.ts:28 | import | @claxedo/agent-sdk-runtime | SessionConfigRequestUpdate
packages/claxedo-app/e2e/helpers/contracts/session-interactions.ts:47 | import | @claxedo/agent-sdk-runtime | AgentRuntimePermissionDecision
packages/claxedo-app/e2e/helpers/contracts/session-prompt.ts:49 | import | @claxedo/agent-event-runtime/contracts | assistantMessageIdForTurn
packages/claxedo-app/e2e/helpers/contracts/session-status.ts:73 | import | @claxedo/agent-sdk-runtime | StatusCompat
packages/claxedo-app/perf-harness/src/browser/mock-streams.ts:1 | import | @claxedo/agent-event-runtime/contracts | EVENT_STREAM_HEARTBEAT_MS
packages/claxedo-app/perf-harness/src/opencode-corpus.ts:3 | import | @claxedo/agent-event-runtime/client-presentation | EventMessagePartUpdated, EventMessageUpdated
packages/claxedo-app/perf-harness/src/production-modules.ts:21 | import | @claxedo/agent-event-runtime/client-presentation | ClientPresentationEvent
packages/claxedo-app/src/app/providers/global-sdk/goal-events.ts:1 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent
packages/claxedo-app/src/features/session/composer/prompt-input-props.ts:10 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/claxedo-app/src/features/session/composer/ui/submit-goal.ts:1 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/claxedo-app/src/features/session/conversation/agent-conversation.ts:2 | import | @claxedo/agent-event-runtime/contracts | assistantMessageIdForTurn
packages/claxedo-app/src/features/session/data/session-types.ts:1 | import | @claxedo/agent-event-runtime/contracts | assistantMessageIdForTurn
packages/claxedo-app/src/features/session/store/session-goal-cache.ts:1 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/claxedo-app/src/features/session/store/session-goal-query.ts:2 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/claxedo-app/src/features/session/subagents/subagent-presentation.ts:1 | import | @claxedo/agent-event-runtime | SubagentMode, SubagentStatus, SubagentToolCallRole, SubagentTranscript, SubagentUpdatedEvent,
packages/claxedo-app/src/features/session/subagents/subagent-registry.ts:1 | import | @claxedo/agent-event-runtime | SubagentMode, SubagentStatus, SubagentToolCallRole, SubagentTranscript, SubagentUpdatedEvent,
packages/claxedo-app/src/features/session/ui/composer/session-composer-region.tsx:22 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/claxedo-app/src/features/session/ui/composer/session-goal-dock.tsx:2 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot, RuntimeGoalStatus
packages/claxedo-app/src/features/session/ui/message-author.tsx:2 | import | @claxedo/agent-event-runtime/client-presentation | ClaxedoMessageAuthor
packages/claxedo-app/src/platform/runtime/agent/agent-runtime-goal-client.ts:1 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot
packages/claxedo-local-server/src/app/daemon-operation-store.ts:25 | import | @claxedo/agent-sdk-runtime/adapters | recoveryScopeKey
packages/claxedo-local-server/src/app/start-local-server.ts:33 | import | @claxedo/agent-sdk-runtime | createAcpConnectionProvider, CompatEnvelope
packages/claxedo-local-server/src/app/start-local-server.ts:34 | import | @claxedo/opencode-server-adapter | createOpenCodeServerConnectionProvider
packages/claxedo-local-server/src/credentials/broker.ts:32 | import | @claxedo/agent-sdk-runtime | projectionRenewalDue, projectionRenewalDueAt
packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:37 | import | @claxedo/agent-sdk-runtime | createAcpConnectionProvider, projectionRenewalDue, projectionRenewalDueAt, AgentTurnOutcome, CompatEnvelope, ConnectionProvider, ConnectionSecretResolver,
packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:46 | import | @claxedo/opencode-server-adapter | createOpenCodeServerConnectionProvider
packages/claxedo-server-core/src/agent-config/connection-secrets.ts:1 | import | @claxedo/agent-sdk-runtime | ConnectionSecretLease, ConnectionSecretResolver, HarnessConnectionDescriptor,
packages/claxedo-server-core/src/agent-config/connections.ts:2 | import | @claxedo/agent-sdk-runtime | AGENT_HARNESS_IDS, ConnectionProviderError, createAcpConnectionProvider, createConnectionProviderRegistry, HarnessConnectionDescriptor, HarnessConnectionRef,
packages/claxedo-server-core/src/agent-config/connections.ts:16 | re-export | @claxedo/agent-sdk-runtime | HarnessConnectionDescriptor,
  HarnessConnectionRef,
packages/claxedo-server-core/src/agent-config/index.ts:33 | import | @claxedo/agent-sdk-runtime | ConnectionProvider, HarnessConnectionDescriptor, HarnessConnectionRef,
packages/claxedo-server-core/src/agent-config/index.ts:38 | import | @claxedo/agent-sdk-runtime | createAcpConnectionProvider, createConnectionProviderRegistry
packages/claxedo-server-core/src/agent-config/index.ts:41 | re-export | @claxedo/agent-sdk-runtime | ConnectionReadiness,
  HarnessConnectionCapabilities,
  HarnessConnectionDescriptor,
  HarnessConnectionRef,
packages/claxedo-server-core/src/agent-config/index.ts:68 | re-export | @claxedo/agent-sdk-runtime | ConnectionSecretLease,
  ConnectionSecretResolver,
packages/claxedo-server-core/src/authority/adapters/sqlite/private-session-authority.ts:5 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageError
packages/claxedo-server-core/src/authority/session-projection.ts:1 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageInput
packages/claxedo-server-core/src/credentials/host-provider-config.ts:19 | import | @claxedo/agent-sdk-runtime/provider-projection | providerProjectionRecord
packages/claxedo-server-core/src/opencode/sdk-credential-bridge.ts:5 | import | @claxedo/agent-sdk-runtime | projectionRenewalDue, projectionRenewalDueAt, providerProjectionRecord,
packages/claxedo-server-core/src/session/harness/index.ts:4 | import | @claxedo/agent-sdk-runtime | SessionHarness, harnessKey, normalizeHarnessIdentity
packages/claxedo-server-core/src/session/harness/index.ts:5 | import | @claxedo/agent-sdk-runtime | AGENT_HARNESS_ACCESSES
packages/claxedo-server-core/src/session/message-replay.ts:11 | import | @claxedo/agent-sdk-runtime/compat-events | readRecordedPart
packages/claxedo-server-core/src/session/message-replay.ts:12 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageError, projectLatestSurfaceMessages, AgentMessagePageInput
packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:6 | import | @claxedo/agent-sdk-runtime | isAgentMessage, renderSessionHandoff, AgentMessage, SessionHarness,
packages/claxedo-server-core/src/usage/contracts.ts:1 | import | @claxedo/agent-event-runtime | RuntimeTokenUsage
packages/claxedo-server-core/src/usage/turn-meter-state.ts:1 | import | @claxedo/agent-event-runtime | RuntimeTokenUsage
packages/claxedo-server-core/src/usage/turn-meter.ts:1 | import | @claxedo/agent-event-runtime | RuntimeTokenUsage, RuntimeUsageObservation
packages/claxedo-server-core/src/usage/turn-meter.ts:2 | import | @claxedo/agent-sdk-runtime | CompatEnvelope
packages/claxedo-server-core/src/usage/turn-meter.ts:3 | import | @claxedo/agent-sdk-runtime/compat-events | eventSessionId
packages/claxedo-server/src/authority/adapters/d1/session-authority.ts:2 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageError
packages/claxedo-server/src/deployments/hosted-shared/hosted-core-app.ts:54 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageError
packages/claxedo-server/src/deployments/self-hosted-node/app.ts:60 | import | @claxedo/agent-sdk-runtime | createAcpConnectionProvider
packages/claxedo-server/src/deployments/self-hosted-node/app.ts:61 | import | @claxedo/opencode-server-adapter | createOpenCodeServerConnectionProvider
packages/claxedo-server/src/deployments/self-hosted-node/app.ts:62 | import | @claxedo/agent-sdk-runtime/compat-events | toCompatEvent
packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts:12 | import | @claxedo/agent-sdk-runtime | createAcpConnectionProvider
packages/claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts:13 | import | @claxedo/opencode-server-adapter | createOpenCodeServerConnectionProvider
packages/claxedo-server/src/routes/hosted/host-enrollment.ts:51 | import | @claxedo/agent-sdk-runtime/provider-projection | providerProjectionRecord
packages/claxedo-server/src/session/machine-dispatch.ts:5 | import | @claxedo/agent-sdk-runtime/compat-events | eventSessionId
packages/claxedo-server/src/session/machine-dispatch.ts:8 | import | @claxedo/agent-sdk-runtime | SessionHarness
packages/claxedo-server/src/session/message-page.ts:1 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageError, AgentMessagePageInput,
packages/claxedo-server/src/session/routes/control-plane-session.ts:3 | import | @claxedo/agent-sdk-runtime | AGENT_HARNESS_IDS
packages/claxedo-server/src/session/routes/control-plane-session.ts:5 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessagePageError, AgentMessagePageInput
packages/harness/src/broker/ports.ts:11 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent, RuntimeDiagnostic, SubagentUpdatedEvent
packages/harness/src/broker/subagents/admission.ts:3 | import | @claxedo/agent-event-runtime/contracts | SubagentUpdatedEvent
packages/harness/src/conformance/test-support/memory-ports.ts:2 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent, SubagentUpdatedEvent
packages/harness/src/contract/broker.ts:12 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent, AgentRuntimeEventOf
packages/harness/src/contract/session.ts:8 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent
packages/harness/src/translate/unrecognized.ts:1 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEventOf
packages/harness/src/transports/acp/events.ts:1 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/harness/src/transports/acp/events.ts:2 | import | @claxedo/agent-event-runtime/harnesses/acp | createAcpEventTranslator
packages/harness/src/transports/acp/index.ts:1 | import | @claxedo/agent-event-runtime/harnesses/acp | translateStopReason
packages/harness/src/transports/claude-sdk/translate.ts:2 | import | @claxedo/agent-event-runtime | createAgentEventRuntime, AgentEventRuntime
packages/harness/src/transports/claude-sdk/translate.ts:3 | import | @claxedo/agent-event-runtime/harnesses/claude | claudeChildCorrelationKey, claudeSdkAdapter, claudeSubagentObservations, createClaudeTaskLedger, foldNestedSubagentFrame, ClaudeSdkAdapterState, ClaudeTaskLedger
packages/harness/src/transports/codex-app-server/configuration.ts:1 | import | @claxedo/agent-event-runtime/harnesses/codex | JsonValue
packages/harness/src/transports/codex-app-server/events.ts:1 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/harness/src/transports/codex-app-server/events.ts:2 | import | @claxedo/agent-event-runtime/harnesses/codex | codexAppServerAdapter
packages/harness/src/transports/codex-app-server/index.ts:12 | import | @claxedo/agent-event-runtime/harnesses/codex | v2
packages/harness/src/transports/codex-app-server/input.ts:1 | import | @claxedo/agent-event-runtime/harnesses/codex | v2
packages/harness/src/transports/codex-app-server/models.ts:3 | import | @claxedo/agent-event-runtime/harnesses/codex | v2
packages/harness/src/transports/codex-app-server/recovery.ts:1 | import | @claxedo/agent-event-runtime/harnesses/codex | v2
packages/harness/src/transports/codex-app-server/requests.ts:2 | import | @claxedo/agent-event-runtime/harnesses/codex | codexMcpApproval
packages/harness/src/transports/cursor-sdk/index.ts:1 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/harness/src/transports/cursor-sdk/index.ts:2 | import | @claxedo/agent-event-runtime/harnesses/cursor | cursorRuntimeMessage, cursorSdkAdapter
packages/harness/src/transports/opencode-sdk/translate/event.ts:1 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/harness/src/transports/opencode-sdk/translate/turn-usage.ts:1 | import | @claxedo/agent-event-runtime | RuntimeTokenUsage
packages/harness/src/transports/opencode-sdk/translate/turn-usage.ts:2 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/harness/src/transports/pi-rpc/events.ts:1 | import | @claxedo/agent-event-runtime | createAgentEventRuntime
packages/harness/src/transports/pi-rpc/events.ts:2 | import | @claxedo/agent-event-runtime/harnesses/pi | piRpcAdapter
packages/opencode-server-adapter/src/adapter.ts:5 | import | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapter
packages/opencode-server-adapter/src/adapter.ts:6 | import | @claxedo/agent-sdk-runtime/capabilities | harnessCapabilities
packages/opencode-server-adapter/src/adapter.ts:7 | import | @claxedo/agent-sdk-runtime | HarnessCapabilities
packages/opencode-server-adapter/src/adapter.ts:8 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/opencode-server-adapter/src/config.ts:1 | import | @claxedo/agent-sdk-runtime | HarnessConnectionCapabilities
packages/opencode-server-adapter/src/provider.ts:1 | import | @claxedo/agent-sdk-runtime | ConnectionProvider
packages/opencode-server-adapter/src/translate.ts:1 | import | @claxedo/agent-event-runtime | agentRuntimeEvent
packages/opencode-server-adapter/src/translate.ts:2 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/opencode-server-adapter/src/turn.ts:1 | import | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/workspace-runtime/src/broker-ports/delivery.ts:2 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent
packages/workspace-runtime/src/broker-ports/request-rows.ts:2 | import | @claxedo/agent-event-runtime/contracts | AgentRuntimeEvent
packages/workspace-runtime/src/broker-ports/session-events.ts:1 | import | @claxedo/agent-event-runtime/client-presentation | createClientPresentationProjection
packages/workspace-runtime/src/broker-ports/session-events.ts:2 | import | @claxedo/agent-event-runtime/client-presentation | projectSessionCommands
packages/workspace-runtime/src/broker-ports/session-events.ts:3 | import | @claxedo/agent-event-runtime/contracts | RuntimeDiagnostic, SubagentUpdatedEvent
packages/workspace-runtime/src/client/session.ts:17 | import | @claxedo/agent-sdk-runtime | AgentConfigOptions, AgentRuntimeRecoveryInspection, HarnessCapabilities, RuntimeGoalSnapshot
packages/workspace-runtime/src/client/session.ts:18 | import | @claxedo/agent-sdk-runtime/message-page | AgentTurnCoveragePage
packages/workspace-runtime/src/compat-events.ts:1 | re-export | @claxedo/agent-sdk-runtime/compat-events | *
packages/workspace-runtime/src/host.ts:55 | re-export | @claxedo/agent-event-runtime | AgentRuntimeEvent
packages/workspace-runtime/src/host.ts:56 | re-export | @claxedo/agent-sdk-runtime | AgentRuntimeStreamEvent, HarnessCapabilities
packages/workspace-runtime/src/host.ts:57 | re-export | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapter
packages/workspace-runtime/src/mcp-resolver.ts:3 | import | @claxedo/agent-sdk-runtime/mcp-resolver | MANAGED_MCP_SERVERS, ManagedMcpOverrides, ManagedMcpServer, ManagedMcpState, McpCapableAgent,
packages/workspace-runtime/src/mcp-resolver.ts:13 | re-export | @claxedo/agent-sdk-runtime/mcp-resolver | *
packages/workspace-runtime/src/opencode/harness-adapter.ts:5 | import | @claxedo/agent-sdk-runtime | AgentAgent, AgentCommand, AgentContentPart, AgentMessage, AgentPermission, AgentQuestion, AgentRuntimeStreamEvent, AgentSession, PromptInput
packages/workspace-runtime/src/opencode/harness-adapter.ts:6 | import | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapter, AgentMessagePage, AgentMessagePageInput
packages/workspace-runtime/src/opencode/harness-adapter.ts:7 | import | @claxedo/agent-sdk-runtime/capabilities | harnessCapabilities
packages/workspace-runtime/src/opencode/harness-adapter.ts:8 | import | @claxedo/agent-sdk-runtime | NO_HARNESS_EFFORT, ProviderCredentialUnavailableError
packages/workspace-runtime/src/routes/config.ts:5 | import | @claxedo/agent-sdk-runtime | isAgentHarnessId, providerProjectionRecord, HarnessConnectionDescriptor, SessionHarness
packages/workspace-runtime/src/routes/events.ts:3 | import | @claxedo/agent-sdk-runtime/compat-events | isRetainedCompatEvent, CompatEnvelope, EventSessionDeleted
packages/workspace-runtime/src/routes/events.ts:4 | import | @claxedo/agent-event-runtime/projections/client-presentation | presentationEventsFromRuntimeEnvelope
packages/workspace-runtime/src/routes/events.ts:5 | import | @claxedo/agent-event-runtime | EVENT_STREAM_HEARTBEAT_MS
packages/workspace-runtime/src/routes/health.ts:1 | import | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapterHealth
packages/workspace-runtime/src/routes/session-children.ts:3 | import | @claxedo/agent-sdk-runtime | createSubagentAdmissionBoundary, SubagentAdmissionStore
packages/workspace-runtime/src/routes/session-children.ts:4 | import | @claxedo/agent-sdk-runtime | AgentMessage, AgentSession, RuntimeDirectory
packages/workspace-runtime/src/routes/session-children.ts:5 | import | @claxedo/agent-event-runtime | SubagentStatus, SubagentWake
packages/workspace-runtime/src/routes/session-children.ts:391 | re-export | @claxedo/agent-event-runtime | SubagentUpdatedEvent
packages/workspace-runtime/src/routes/session-core.ts:7 | import | @claxedo/agent-sdk-runtime | AgentMessage, AgentPermission, AgentQuestion, AgentRuntime, AgentRuntimeRecovery, AgentSession, RuntimeDirectory, SessionConfigRequestUpdate, SessionModelGroup, HarnessCapabilities, RecoveryCaller
packages/workspace-runtime/src/routes/session-core.ts:20 | import | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapter, AgentInteractionResult, AgentMessagePage, AgentMessagePageInput,
packages/workspace-runtime/src/routes/session-core.ts:26 | import | @claxedo/agent-sdk-runtime/message-page | AgentMessageReadInput, AgentTurnCoveragePage
packages/workspace-runtime/src/routes/session-core.ts:27 | import | @claxedo/agent-sdk-runtime/adapters | AgentMessagePageError, hasAdapterCapability
packages/workspace-runtime/src/routes/session-core.ts:29 | import | @claxedo/agent-sdk-runtime | admitSessionInstructions, IMMUTABLE_SESSION_CONFIG_FIELDS, ImmutableSessionConfigField,
packages/workspace-runtime/src/routes/session-core.ts:34 | import | @claxedo/agent-sdk-runtime | AGENT_RUNTIME_TURN_CONFLICT_CODE, isAgentRuntimeTurnConflictError,
packages/workspace-runtime/src/routes/session-core.ts:50 | import | @claxedo/agent-sdk-runtime | isAgentRuntimeGoalError
packages/workspace-runtime/src/routes/session-core.ts:73 | import | @claxedo/agent-sdk-runtime | narrowerPermissionLevel, permissionCeilingAdmits, permissionModeLevel, widestPermissionModeUnder
packages/workspace-runtime/src/routes/session-status-snapshot.ts:1 | import | @claxedo/agent-sdk-runtime/status | live, StatusCompat
packages/workspace-runtime/src/routes/session-status-snapshot.ts:2 | import | @claxedo/agent-sdk-runtime/adapters | ACP_RECOVER
packages/workspace-runtime/src/routes/session.ts:8 | import | @claxedo/agent-sdk-runtime | isAgentRuntimeTurnConflictError, SubagentAdmissionStore
packages/workspace-runtime/src/routes/session.ts:10 | import | @claxedo/agent-sdk-runtime | AgentRuntime, AgentRuntimeRecovery, AgentMessage, AgentMessageAuthor, AgentPermission, AgentQuestion, SessionHarness, AgentSession, PromptDelivery, SessionConfigRequestUpdate, SessionModelGroup
packages/workspace-runtime/src/routes/session.ts:11 | import | @claxedo/agent-sdk-runtime/adapters | AgentMessagePage, AgentMessagePageInput, AgentHarnessAdapter,
packages/workspace-runtime/src/routes/session.ts:16 | import | @claxedo/agent-sdk-runtime/message-page | AgentTurnCoveragePage
packages/workspace-runtime/src/runtime-event-hub.ts:1 | re-export | @claxedo/agent-sdk-runtime/runtime-event-hub | createRuntimeEventHub,
  RuntimeEventEnvelope,
  RuntimeEventEnvelopeInput,
  RuntimeEventHub,
  RuntimeEventPublishers,
packages/workspace-runtime/src/session-config.ts:2 | import | @claxedo/agent-sdk-runtime | isAutoLevel, normalizeHarnessIdentity, parseSessionModelGroup, PromptModel, SessionConfigRequestUpdate, SessionHarness, SessionModelGroup, SessionModelGroupParse
packages/workspace-runtime/src/session/delivery-owner.ts:2 | import | @claxedo/agent-sdk-runtime | PromptDelivery
packages/workspace-runtime/src/session/delivery-owner.ts:9 | import() | @claxedo/agent-sdk-runtime | AgentRuntime
packages/workspace-runtime/src/session/service.ts:2 | import | @claxedo/agent-event-runtime/contracts | assistantMessageIdForTurn
packages/workspace-runtime/src/session/service.ts:3 | import | @claxedo/agent-event-runtime/projections/client-presentation | createClientPresentationProjection
packages/workspace-runtime/src/session/service.ts:4 | import | @claxedo/agent-sdk-runtime | defaultSessionModel, firstTurnErrorData, isAgentRuntimeTurnConflictError, resolveTurnSystem
packages/workspace-runtime/src/session/service.ts:12 | import | @claxedo/agent-sdk-runtime | AgentMessage, AgentRuntime, AgentRuntimeStreamEvent, AgentRuntimeTurnStartInput, PromptDelivery, PromptDeliveryRequest, PromptInput, RuntimeDirectory
packages/workspace-runtime/src/session/service.ts:13 | import | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapter
packages/workspace-runtime/src/store.ts:7 | import | @claxedo/agent-sdk-runtime/adapters | ACP_RECOVER, AgentRuntimeStaleTurnError, recoveryScopeKey, recoveryTargetSessionId, AgentMessagePageError, AgentMessagePage, AgentMessagePageInput,
packages/workspace-runtime/src/store.ts:16 | import | @claxedo/agent-sdk-runtime/message-page | projectLatestSurfaceMessages, AgentTurnCoverage, AgentTurnCoveragePage,
packages/workspace-runtime/src/store.ts:21 | import | @claxedo/agent-sdk-runtime | acceptsSessionTitle, boundSessionTitleSource, firstTurnErrorData, normalizeHarnessIdentity, parseStoredSessionModelGroup, sessionModelGroupJson,
packages/workspace-runtime/src/store.ts:30 | import | @claxedo/agent-sdk-runtime/stores/session-start | sqliteSessionStarts
packages/workspace-runtime/src/store.ts:31 | import | @claxedo/agent-sdk-runtime | AgentMessage, AgentMessageAuthor, AgentPermission, AgentQuestion, AgentTurnOutcome, PromptFormat, PromptInput, SessionHarness, SessionModelGroup
packages/workspace-runtime/src/store.ts:36 | import | @claxedo/agent-event-runtime | RuntimeGoalSnapshot, SubagentUpdatedEvent
packages/workspace-runtime/src/workspace/host.ts:7 | import | @claxedo/agent-sdk-runtime/adapters | AgentHarnessAdapterHealth
packages/workspace-runtime/src/workspace/runtime.ts:7 | import | @claxedo/agent-sdk-runtime | connectionIdForHarness, createAcpConnectionProvider, createAgentRuntime, createConnectionProviderRegistry, AgentRuntime, AgentSession, AgentMessage, SessionHarness, ConnectionProvider, ConnectionSecretResolver, HarnessConnectionDescriptor, AgentTurnOutcome, AgentRuntimeRecovery,
packages/workspace-runtime/src/workspace/runtime.ts:22 | import | @claxedo/agent-sdk-runtime/adapters | ClaudeHarnessAdapter, CodexHarnessAdapter, CursorHarnessAdapter, PiHarnessAdapter, hasAdapterCapability, AgentHarnessAdapter, AgentHarnessAdapterHealth, AgentMessagePage, AgentMessagePageInput, AgentRuntimeStoreWithRecovery,
packages/workspace-runtime/src/workspace/runtime.ts:34 | import | @claxedo/agent-sdk-runtime/message-page | AgentTurnCoveragePage
packages/workspace-runtime/src/workspace/runtime.ts:36 | import | @claxedo/agent-sdk-runtime/compat-events | CompatEnvelope
packages/workspace-runtime/src/workspace/runtime.ts:37 | import | @claxedo/agent-sdk-runtime/subagent-admission | SubagentAdmissionStore
```

## P3 and P4 deletion and relocation boundary

### Imported-symbol disposition

The inventory below includes every static production import from the three retiring packages, including the perf harness, e2e contract helpers, scripts, server, and both sides of the retiring packages themselves. Its rows give the exact importer, line, module, and imported symbol. These disposition groups cover each symbol in that inventory; a symbol listed under more than one old subpath has one destination. “P4 contract” includes the symbols already defined in `agent-runtime-contract` but re-exported by `agent-sdk-runtime/src/index.ts:31` and `:114`: the importer changes in P4 without copying the implementation.

| Imported symbols and present responsibility | Destination |
| --- | --- |
| `AgentAgent`, `AgentCommand`, `AgentContentPart`, `AgentMessage`, `AgentMessageAuthor`, `AgentPermission`, `AgentQuestion`, `AgentSession`, `AgentTurnOutcome`, `PromptDelivery`, `PromptDeliveryRequest`, `PromptFormat`, `PromptInput`, `PromptModel`, `SessionHarness`, `SessionModelGroup`, `SessionModelGroupParse`, `NO_HARNESS_EFFORT`, `AGENT_HARNESS_ACCESSES`, `AGENT_HARNESS_IDS`, `harnessKey`, `isAgentHarnessId`, `isAgentMessage`, `isAutoLevel`, `normalizeHarnessIdentity`, `parseSessionModelGroup`, `parseStoredSessionModelGroup`, `sessionModelGroupJson`, `connectionIdForHarness`: public session/prompt/harness identity data or functions already re-exported from `agent-runtime-contract` (`agent-sdk-runtime/src/index.ts:44`, `:114`). | Direct `@claxedo/agent-runtime-contract` imports in P4; registry becomes the only transport-kind table in P3. |
| `AgentRuntime`, `AgentRuntimeRecovery`, `AgentRuntimeRecoveryInspection`, `AgentRuntimeTurnStartInput`, `AgentRuntimePermissionDecision`, `RecoveryCaller`, `AGENT_RUNTIME_TURN_CONFLICT_CODE`, `isAgentRuntimeTurnConflictError`, `isAgentRuntimeGoalError`, `AgentRuntimeStreamEvent`, `RuntimeDirectory`, `CompatEnvelope`, `StatusCompat`, `live`, `ACP_RECOVER`: runtime/recovery and presentation boundary types/helpers. | `workspace-runtime/src/host/` or `src/projection/` in P3; public pure recovery/status data that server/app imports need goes to `agent-runtime-contract` in P4. `ACP_RECOVER` remains a recovery operation constant, not an ACP adapter import. |
| `AgentConfigOptions`, `HarnessCapabilities`, `SessionConfigRequestUpdate`, `IMMUTABLE_SESSION_CONFIG_FIELDS`, `ImmutableSessionConfigField`, `AgentMessagePage`, `AgentMessagePageInput`, `AgentMessageReadInput`, `AgentMessagePageError`, `AgentTurnCoverage`, `AgentTurnCoveragePage`, `projectLatestSurfaceMessages`, `SessionModelGroup`, `StatusCompat`: public route read/write/page shapes and validation. | Move the public types/error/validators to `agent-runtime-contract` in P4; route orchestration and page projection live in `workspace-runtime/src/host/` or `src/projection/` in P3. `HarnessCapabilities` is projected from `TransportCapabilities` (G5). |
| `AgentHarnessAdapter`, `AgentHarnessAdapterHealth`, `AgentInteractionResult`, `AgentRuntimeStoreWithRecovery`, `ClaudeHarnessAdapter`, `CodexHarnessAdapter`, `CursorHarnessAdapter`, `PiHarnessAdapter`, `harnessCapabilities`, `hasAdapterCapability`: old adapter interface, constructors and capability gate. | Delete in P3. Call `HarnessTransport` and `TransportCapabilities`; keep store implementation behind `BrokerPorts`. |
| `ConnectionProvider`, `ConnectionProviderError`, `ConnectionReadiness`, `ConnectionSecretLease`, `ConnectionSecretResolver`, `HarnessConnectionCapabilities`, `HarnessConnectionDescriptor`, `HarnessConnectionRef`, `createAcpConnectionProvider`, `createConnectionProviderRegistry`, `createOpenCodeServerConnectionProvider`: descriptor validation, secret resolution and adapter construction. | `harness/src/registry/providers/` and contract descriptor in P3. Delete the OpenCode server provider; remote OpenCode is ACP. Public descriptor/ref shapes move to `agent-runtime-contract` in P4. |
| `projectionRenewalDue`, `projectionRenewalDueAt`, `providerProjectionRecord`, `ProviderCredentialUnavailableError`: credential placeholder lifetime, projection and refusal. | Owner-scoped credential selection and projection in `harness/src/registry/credentials.ts` plus `workspace-runtime` config composition in P3. Preserve typed refusal; direct importer moves with its owner. |
| `createAgentRuntime`, `createMemorySubagentAdmissionStore`, `createSubagentAdmissionBoundary`, `AdmittedSubagentObservation`, `SubagentAdmissionStore`: runtime composition and old subagent admission. | Host in `workspace-runtime/src/host/`; subagent rules in `harness/src/broker/subagents/`, persistence in `BrokerPorts` (G3). Delete old admission facade. |
| `acceptsSessionTitle`, `boundSessionTitleSource`, `admitSessionInstructions`, `defaultSessionModel`, `firstTurnErrorData`, `renderSessionHandoff`, `resolveTurnSystem`, `narrowerPermissionLevel`, `permissionCeilingAdmits`, `permissionModeLevel`, `widestPermissionModeUnder`: host admission/title/error/handoff/permission policy. | `workspace-runtime/src/host/` for orchestration; permission/grant decision belongs to broker. Pure request/response types go to `agent-runtime-contract` in P4. |
| `MANAGED_MCP_SERVERS`, `ManagedMcpOverrides`, `ManagedMcpServer`, `ManagedMcpState`, `McpCapableAgent`: MCP selection/projection. | `workspace-runtime` composition plus `harness/src/capabilities/` remote filter in P3. |
| `CompatEnvelope`, `EventSessionDeleted`, `eventSessionId`, `isRetainedCompatEvent`, `readRecordedPart`, `toCompatEvent`, `recoveryScopeKey`, `recoveryTargetSessionId`, `AgentRuntimeStaleTurnError`, `sqliteSessionStarts`: compat journal, replay, recovery identity and startup rows. | Compat/journal/page logic to `workspace-runtime/src/projection/` and host/store in P3; public pure recovery contracts to `agent-runtime-contract` in P4; test-only session-start store to test support in P4. |
| `AgentRuntimeEvent`, `AgentRuntimeEventOf`, `RuntimeDiagnostic`, `RuntimeGoalSnapshot`, `RuntimeGoalStatus`, `RUNTIME_GOAL_STATUSES`, `RuntimeTokenUsage`, `RuntimeUsageObservation`, `SubagentMode`, `SubagentStatus`, `SubagentToolCallRole`, `SubagentTranscript`, `SubagentUpdatedEvent`, `SubagentWake`, `RawHarnessEvent`, `AGENT_RUNTIME_EVENT_CONTRACT_VERSION`, `EVENT_STREAM_HEARTBEAT_MS`, `assistantMessageIdForTurn`, `agentRuntimeEvent`, `isRuntimeGoalStatus`: runtime event/goal/usage/wire contracts and constructors. | `agent-runtime-contract` in P4; same shapes feed `workspace-runtime/src/projection/` at P3. `RawHarnessEvent` remains an internal translator input under `harness/src/translate/` if no public consumer remains. |
| `AgentEventRuntime`, `createAgentEventRuntime`, `createRuntimeEventHub`, `hostSubagentBinding`, `hostSubagentObservation`, `isHostSubagentTool`: translator runner, event hub and host-child decoding. | Translator runner to `harness/src/translate/`; event hub to `workspace-runtime/src/projection/`; child ownership to broker/subagents in P3. |
| `export *` re-exports in `workspace-runtime/src/{mcp-resolver,compat-events}.ts` and focused type re-exports in `workspace-runtime/src/{host,routes/session-children}.ts`: public forwarding paths. | Point to the new canonical owner in the same P3/P4 import change; remove forwarding-only files if no public subpath requires them. |
| `ClaxedoMessageAuthor`, `ClientPresentationEvent`, `EventMessagePartUpdated`, `EventMessageUpdated`, `createClientPresentationProjection`, `presentationEventsFromRuntimeEnvelope`, `projectSessionCommands`, `withClaxedoMessageAuthor`: frame projection and author decoration. | `workspace-runtime/src/projection/` in P3; only app-read types/constants move to `agent-runtime-contract` in P4. |
| `CLAUDE_QUESTION_DISMISSED`, `CLAUDE_SUBAGENT_USAGE_METHOD`, `ClaudeSubagentUsage`, `ClaudeTaskLedger`, `claudeChildCorrelationKey`, `claudeSdkAdapter`, `claudeSubagentObservations`, `createClaudeTaskLedger`, `foldNestedSubagentFrame`; `cursorRuntimeMessage`, `cursorSdkAdapter`, `cursorSubagentObservations`; `piRpcAdapter`: vendor translation/child correlation. | Respective `harness/src/transports/{claude-sdk,cursor-sdk,pi-rpc}/translate/` in P3; old adapter consumer deleted. |
| `createAcpEventTranslator`, `translateStopReason`; `CODEX_DESCENDANT_ERROR_METHOD`, `JsonValue`, `codexAppServerAdapter`, `codexCollabAgentCall`, `codexMcpApproval`, `codexReportedModel`, `codexStartedSubagent`, `codexSubagentActivity`, `codexUsageGrowth`, `v2`: ACP/Codex protocol translation and generated protocol types. | Respective `harness/src/transports/{acp,codex-app-server}/translate/` or its protocol types in P3. Preserve translator corpus bytes. |


P3 moves `runtime.ts`, all `runtime/*` production modules, `runtime-event-hub.ts`, `compat-events.ts`, `harnesses/shared/turn-projection.ts` and `child-event-routing.ts` to `workspace-runtime/src/host/` or `src/projection/`, preserving behavior before changing the harness edge. P3 deletes all old production adapter/driver files under `agent-sdk-runtime/src/harnesses/{acp,claude,codex,cursor,pi}` and obsolete shared adapter files after their new transport owners are wired. `workspace-runtime/src/opencode/harness-adapter.ts` is deleted; the embedded engine has already moved to `harness/transports/opencode-sdk`. `agent-event-runtime/src/projections/client-presentation/*` moves into `workspace-runtime/src/projection/`; vendor translators, their `core/*` runner and `value.ts` move under `harness/src/transports/*/translate/` and `harness/src/translate/` with their tests. `agent-event-runtime` retains event contracts, debug trace, and public entrypoints until P4. The exact source-path manifest below is authoritative for this base and makes each P3 removal reviewable.

P4 moves `agent-event-runtime/src/contracts/*` to `agent-runtime-contract`, repoints both apps and the server/perf/scripts importers shown in the inventory, moves `agent-sdk-runtime/src/stores/{memory,sqlite,persisted-rows,session-start}` to test support where appropriate, and removes `adapters.ts`, `log.ts`, `target.ts`, `paths.ts` with their last importer. It then deletes the remaining `agent-sdk-runtime`, `agent-event-runtime`, and `opencode-server-adapter` package files and updates `isolation.buildPackages` and exact closure budgets. P3 does **not** delete contract types while app and service imports still use them. The P4 package-file manifest below includes package metadata and tests, not only TypeScript.

Each `KEEP(...)` row in the invariant-map TSV has a composite id `source file > describe > test`. The appendix below assigns every kept case guarding a P3-removed owner to a destination test file. Move the assertion unchanged with the owning behavior, then run it against the real broker/transport/host. The `KEEP` set from unaffected `agent-runtime-contract`, `process-ownership`, and the P4 test stores stays with those owners. A kept row cannot be dropped merely because a flow passed; the map's `FLOW`, corpus and `OBSOLETE` rows have different replacements.

## Commit sequence inside one branch

1. **Composition without redirect:** bring in the completed P2 transport and `p3-ports` commits, finish registry factories, services and store-backed ports in `workspace-runtime`; build and typecheck. No production session chooses the new path yet.
2. **Package-local preparation:** move translator code and its tests into `harness` while changing every live transport importer in that same commit; prepare host-only services and port adapters in `workspace-runtime` without an import from the old SDK into the new host. Build and typecheck, run the translator corpus and conformance suite.
3. **Atomic edge switch and host move:** relocate `runtime.ts`, `runtime/*`, event hub, compat and client presentation projection, repoint routes/server importers, convert start/attach/send/config/replies/goals/children/dispose, and remove every old adapter file in **one commit**. This avoids the package cycle that a host-only move would create while old drivers still import its projection. There is no flag, bridge, fallback, or dual-write. The same commit removes what step 2 left in place for the old drivers: the `agent-sdk-runtime → @claxedo/harness` dependency and the six `./translate` and `./<kind>/translate` subpath exports that only they import, and the `isMovedTranslator` exemption in `scripts/check.ts` (with its fixtures and README paragraph), so the moved translators answer the no-comments, size and no-policy rules from step 3 on or carry a P6 trim row per finding. Build and typecheck; run the wire corpus and moved focused tests.
4. **Acceptance fixes in the same P3 slice:** H-9 archive/cancel, H-12 `/compact` decision, H-13 token fold, H-14 ownership, H-15 typed refusals, H-16 todos, H-17 pending-handoff deletion, and H-18 Pi RPC matching. Every fix has its red-on-base evidence and green focused/flow result. Re-run every eligible flow twice, including its targeted red boundary, and the entire P3 gate after the last fix. If a gap ruling changes the contract, it lands before step 3 and all intermediate commits still build and typecheck.

**Eligible flow gate at the last P3 commit:** H0–H18, H20–H27 and H35–H37 where their scripted peers, providers and platform lanes are available; H19 and H28–H33 turn green when the P2 cloud sandbox/hosted driver exists, H34 belongs to app v2. In particular H12/H13/H35/H37 close the route and projection defects above, H18 closes Pi's mismatched reply, H16/H24 close remote ACP behavior, and H25 closes two Cursor bindings. For each eligible flow, two consecutive green runs and its targeted red run must exercise the named boundary, not fail at setup. Translator and wire corpora compare to recorded baselines without an approved update; all moved `KEEP` cases pass; `bun run --cwd packages/harness check` reports zero; budgets and architecture ratchets pass without a raised ceiling. `bun run build:packages` precedes cross-package typecheck. Every test, flow and closure command runs via `_control/isolated-test.sh` with `CLAXEDO_E2E_PORT_RANGE=48100-48199`. Before workspace-runtime/process-ownership tests, verify the process-start-time safety commit with `git log`; signal only processes the command started.

### Kept invariant case relocation

The id is the map filename plus its `file > test` key, because the TSV has no numeric id column. The target is the proposed test file, next to the new rule owner; a transport-specific test may exercise the real broker through conformance. This is an exhaustive join against the P3 source-path set above. `KEEP` cases on source files retained until P4 are intentionally absent here.

```sh
python3 - <<'PY'
from pathlib import Path
import csv
sdk = Path("packages/agent-sdk-runtime/src")
event = Path("packages/agent-event-runtime/src")
p3 = set((sdk / "harnesses").rglob("*")) | set((sdk / "runtime").rglob("*")) | set((event / "projections/client-presentation").rglob("*")) | set((event / "harnesses").rglob("*")) | set((event / "core").rglob("*"))
p3 |= {sdk / name for name in ("runtime.test.ts", "runtime-event-hub.test.ts", "compat-events.parts.test.ts", "compat-events.session-id.test.ts", "adapter-contract.test.ts", "subagent-admission.test.ts")}
p3 |= {event / "value.ts", event / "value.test.ts"}
p3 = {path for path in p3 if path.is_file()}
def source(map_name, name):
    if name.startswith("packages/"): return Path(name)
    if map_name == "event-runtime": return event / name
    if map_name == "contract-opencode": return Path("packages/opencode-server-adapter/src") / name
    if map_name == "sdk-core": return sdk / name
    return sdk / "harnesses" / name
def destination(path):
    rel = path.relative_to(sdk) if path.is_relative_to(sdk) else path.relative_to(event)
    text = str(rel)
    if text.startswith("core/") or text.startswith("harnesses/") or text.startswith("value"):
        if text.startswith("harnesses/") and len(rel.parts) > 2 and rel.parts[1] in ("acp", "claude", "codex", "cursor", "pi"):
            kind = {"claude":"claude-sdk", "codex":"codex-app-server", "cursor":"cursor-sdk", "pi":"pi-rpc"}.get(rel.parts[1], rel.parts[1])
            return "harness/transport/translate", Path("packages/harness/src/transports") / kind / "translate" / rel.name
        return "harness/translate", Path("packages/harness/src/translate") / rel.name
    if text.startswith("projections/client-presentation/"): return "workspace-runtime/projection", Path("packages/workspace-runtime/src/projection/client-presentation") / rel.name
    if text.startswith("harnesses/"):
        bits = rel.parts[1:]
        family = bits[0]
        name = bits[-1]
        if family in ("acp", "claude", "codex", "cursor", "pi"):
            kind = {"claude":"claude-sdk", "codex":"codex-app-server", "cursor":"cursor-sdk", "pi":"pi-rpc"}.get(family, family)
            if name in ("permission-grants.test.ts", "pattern-validation.test.ts"):
                return "harness/broker/requests", Path("packages/harness/src/broker/requests") / name
            return "harness/transport", Path("packages/harness/src/transports") / kind / name
        if family == "shared":
            if name in ("process-lifecycle.test.ts", "spawn-env.secrets.test.ts"):
                return "process-ownership", Path("packages/process-ownership/src") / name
            if name in ("sdk-runtime-interactions.test.ts", "subagent-lifecycle.test.ts"):
                owner = "broker/requests" if "interactions" in name else "broker/subagents"
                return owner, Path("packages/harness/src") / owner / name
            if name in ("turn-projection.test.ts", "child-event-routing.test.ts"):
                return "workspace-runtime/projection", Path("packages/workspace-runtime/src/projection") / name
            if name in ("goal-publisher.test.ts", "goal-stop-order.test.ts"):
                return "workspace-runtime/host", Path("packages/workspace-runtime/src/host") / name
            if name == "store-lifecycle.test.ts": return "workspace-runtime/store", Path("packages/workspace-runtime/src") / name
            return "workspace-runtime/host", Path("packages/workspace-runtime/src/host") / name
    if text == "subagent-admission.test.ts": return "harness/broker/subagents", Path("packages/harness/src/broker/subagents/admission.test.ts")
    if text.startswith("compat-events") or text == "runtime-event-hub.test.ts": return "workspace-runtime/projection", Path("packages/workspace-runtime/src/projection") / rel.name
    if text == "adapter-contract.test.ts": return "harness/contract", Path("packages/harness/src/contract/transport.test.ts")
    if text.startswith("runtime/"): return "workspace-runtime/host", Path("packages/workspace-runtime/src/host") / Path(text).relative_to("runtime")
    return "workspace-runtime/host", Path("packages/workspace-runtime/src/host") / rel.name
rows = []
for mapping in sorted(Path("docs/harness-v2/invariant-map").glob("*.tsv")):
    if "-fixes" in mapping.name: continue
    for row in csv.DictReader(mapping.open(), delimiter="\t"):
        if not row["replacement"].startswith("KEEP("): continue
        src = source(mapping.stem, row["file"])
        if src not in p3: continue
        owner, target = destination(src)
        test = row.get("test (describe > name)", row.get("test", ""))
        rows.append((mapping.name, row["file"], test, owner, str(target)))
print(f"{len(rows)} kept invariant cases from {len(set((r[0],r[1]) for r in rows))} P3-removed test files")
for mapping, src, test, owner, target in rows:
    print(f"{mapping} | {src} > {test} | {owner} | {target}")
PY
```

```text
361 kept invariant cases from 62 P3-removed test files
event-runtime.tsv | packages/agent-event-runtime/src/harnesses/codex/protocol-pin.test.ts > codex protocol pin > the protocol generator pins the Codex the sandbox runs | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/protocol-pin.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/harnesses/acp/event-translator.test.ts > createAcpEventTranslator > does not write ACP diagnostics to console | harness/transport/translate | packages/harness/src/transports/acp/translate/event-translator.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/harnesses/acp/event-translator.test.ts > createAcpEventTranslator > does not leak ACP diagnostics across runtime instances | harness/transport/translate | packages/harness/src/transports/acp/translate/event-translator.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/projections/client-presentation/projection.test.ts > createClientPresentationProjection > rolls back state when projection translation throws | workspace-runtime/projection | packages/workspace-runtime/src/projection/client-presentation/projection.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/projections/client-presentation/projection.test.ts > createClientPresentationProjection > returns projection snapshots that do not mutate after later tool updates | workspace-runtime/projection | packages/workspace-runtime/src/projection/client-presentation/projection.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/projections/client-presentation/projection.test.ts > createClientPresentationProjection > clones restored projection snapshots so projections are independent | workspace-runtime/projection | packages/workspace-runtime/src/projection/client-presentation/projection.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > returns snapshots that do not mutate after later ingests | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > clones restored adapter snapshots so runtimes are independent | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > clones structured-clone-safe snapshot values | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > falls back to JSON-safe snapshot values when structured cloning fails | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > sanitizes JSON fallback values that would otherwise throw | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > rejects older snapshot versions clearly | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > turns adapter throws into diagnostic events | harness/translate | packages/harness/src/translate/runtime.test.ts
event-runtime.tsv | packages/agent-event-runtime/src/core/runtime.test.ts > createAgentEventRuntime > documents default id factory restore boundary | harness/translate | packages/harness/src/translate/runtime.test.ts
sdk-acp.tsv | acp/permission-grants.test.ts > ACP permission grants > an absent kind is remembered as 'other', never as a wildcard | harness/transport/translate | packages/harness/src/transports/acp/translate/permission-grants.test.ts
sdk-acp.tsv | acp/permission-grants.test.ts > ACP permission grants > an untitled request yields no grant, so it can never be answered on the user's behalf | harness/transport/translate | packages/harness/src/transports/acp/translate/permission-grants.test.ts
sdk-acp.tsv | acp/permission-grants.test.ts > ACP permission grants > a grant matches only the same kind and the same title | harness/transport/translate | packages/harness/src/transports/acp/translate/permission-grants.test.ts
sdk-acp.tsv | acp/permission-grants.test.ts > ACP permission grants > saving keeps the rest of the permission state and never duplicates | harness/transport/translate | packages/harness/src/transports/acp/translate/permission-grants.test.ts
sdk-acp.tsv | acp/permission-grants.test.ts > ACP permission grants > malformed persisted rows are ignored rather than trusted | harness/transport/translate | packages/harness/src/transports/acp/translate/permission-grants.test.ts
sdk-acp.tsv | acp/pattern-validation.test.ts > Node and Bun terminate catastrophic native regex under an external watchdog | harness/transport/translate | packages/harness/src/transports/acp/translate/pattern-validation.test.ts
sdk-acp.tsv | acp/pattern-validation.test.ts > timeout and cancellation release the bounded worker slot | harness/transport/translate | packages/harness/src/transports/acp/translate/pattern-validation.test.ts
sdk-acp.tsv | acp/transport-retirement.test.ts > immediate adapter recreation waits for the old wrapper's resistant writer child | harness/transport/translate | packages/harness/src/transports/acp/translate/transport-retirement.test.ts
sdk-acp.tsv | acp/lifecycle-regressions.test.ts > synchronous onError preserves launch failure and retires its transport | harness/transport/translate | packages/harness/src/transports/acp/translate/lifecycle-regressions.test.ts
sdk-acp.tsv | acp/lifecycle-regressions.test.ts > synchronous onExit preserves launch failure and retires its transport | harness/transport/translate | packages/harness/src/transports/acp/translate/lifecycle-regressions.test.ts
sdk-acp.tsv | acp/lifecycle-regressions.test.ts > cancelling an intermediate child settles only its descendant interactions | harness/transport/translate | packages/harness/src/transports/acp/translate/lifecycle-regressions.test.ts
sdk-acp.tsv | acp/lifecycle-regressions.test.ts > a synchronous error followed by constructor failure does not schedule death callbacks | harness/transport/translate | packages/harness/src/transports/acp/translate/lifecycle-regressions.test.ts
sdk-acp.tsv | acp/probe-options.test.ts > AcpHarnessAdapter.probeConfigOptions > uses the session boot timeout when no probe timeout override is set | harness/transport/translate | packages/harness/src/transports/acp/translate/probe-options.test.ts
sdk-acp.tsv | acp/probe-options.test.ts > AcpHarnessAdapter.probeConfigOptions > rejects when shared process startup hangs | harness/transport/translate | packages/harness/src/transports/acp/translate/probe-options.test.ts
sdk-acp.tsv | acp/goal-projection.test.ts > a Goal terminal the store refuses still leaves the session admissible | harness/transport/translate | packages/harness/src/transports/acp/translate/goal-projection.test.ts
sdk-acp.tsv | acp/goal-projection.test.ts > a Goal projection whose turn could not start does not keep the session's lease | harness/transport/translate | packages/harness/src/transports/acp/translate/goal-projection.test.ts
sdk-acp.tsv | acp/elicitation.test.ts > question cancellation defeats an in-flight validation and duplicate acceptance | harness/transport/translate | packages/harness/src/transports/acp/translate/elicitation.test.ts
sdk-acp.tsv | acp/elicitation.test.ts > ACP shared question settlement retains its live resolver after a failed durable reply | harness/transport/translate | packages/harness/src/transports/acp/translate/elicitation.test.ts
sdk-acp.tsv | acp/elicitation-wire.test.ts > a sibling adapter cannot retire a live question, but disposal clears the pending row | harness/transport/translate | packages/harness/src/transports/acp/translate/elicitation-wire.test.ts
sdk-acp.tsv | acp/connection-state.test.ts > observations fence old generations, isolate directories, and never promote discovery readiness | harness/transport/translate | packages/harness/src/transports/acp/translate/connection-state.test.ts
sdk-acp.tsv | acp/process.test.ts > ACPProcess.prompt quiet countdown > a turn longer than the countdown survives while the agent keeps streaming | harness/transport/translate | packages/harness/src/transports/acp/translate/process.test.ts
sdk-acp.tsv | acp/process.test.ts > ACPProcess.prompt quiet countdown > a permission left with the human holds the countdown open | harness/transport/translate | packages/harness/src/transports/acp/translate/process.test.ts
sdk-acp.tsv | acp/process.test.ts > ACPProcess.prompt quiet countdown > a session waiting for permission does not block another session or accept a second prompt of its own | harness/transport/translate | packages/harness/src/transports/acp/translate/process.test.ts
sdk-acp.tsv | acp/process.test.ts > ACPProcess.prompt quiet countdown > a pusher that answers on the spot releases the hold, so silence afterwards still times out | harness/transport/translate | packages/harness/src/transports/acp/translate/process.test.ts
sdk-acp.tsv | acp/process.test.ts > ACPProcess.prompt quiet countdown > silence requests cancellation while preserving the unresolved turn | harness/transport/translate | packages/harness/src/transports/acp/translate/process.test.ts
sdk-acp.tsv | acp/process.test.ts > ACPProcess.prompt quiet countdown > a disposal reason reaches the prompt still in flight | harness/transport/translate | packages/harness/src/transports/acp/translate/process.test.ts
sdk-acp.tsv | acp/create-session.test.ts > AcpHarnessAdapter.createSession > fails promptly when ACP newSession hangs | harness/transport/translate | packages/harness/src/transports/acp/translate/create-session.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > concurrent session/new requests own isolated durable questions before upstream IDs exist | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > newSession countdown pauses while the human considers startup elicitation | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > process loss retires startup questions and never revives their resolvers | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > unattended startup still times out without inventing an executable session | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > startup process idle lifetime survives human wait and releases after final creation | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > initialize questions use the reserved creation owner and suspend its deadline | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/startup-elicitation.test.ts > disposing initialization cancels its question without fabricating a session | harness/transport/translate | packages/harness/src/transports/acp/translate/startup-elicitation.test.ts
sdk-acp.tsv | acp/session-isolation.test.ts > simultaneous session options and prompt share one authoritative restoration | harness/transport/translate | packages/harness/src/transports/acp/translate/session-isolation.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter permissions > requires a workspace directory at cwd-dependent boundaries | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter active turn cleanup > registers direct ACP harness, probe, and MCP lifecycles without launch secrets | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter active turn cleanup > initialization timeout disposes the process | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter active turn cleanup > session creation timeout disposes the process before storing a session | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter active turn cleanup > resume timeout quarantines its session without disposing the process | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter active turn cleanup > a prompt failure leaves the shared process intact | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > AcpHarnessAdapter active turn cleanup > config apply defers restart while a turn is active | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > concurrent draft discovery shares one session creation (failure=false) | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/index.test.ts > concurrent draft discovery shares one session creation (failure=true) | harness/transport/translate | packages/harness/src/transports/acp/translate/index.test.ts
sdk-acp.tsv | acp/workspace-behavior.test.ts > AcpHarnessAdapter > fails the turn instead of hanging forever when cold-start resume stalls | harness/transport/translate | packages/harness/src/transports/acp/translate/workspace-behavior.test.ts
sdk-acp.tsv | acp/workspace-behavior.test.ts > AcpHarnessAdapter > fails the turn instead of hanging forever when cold-start sync stalls | harness/transport/translate | packages/harness/src/transports/acp/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > claudeAuthEnv > an api-key projection sends the placeholder in the API-key variable | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > claudeAuthEnv > a bearer projection sends the placeholder in the auth-token variable | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > claudeAuthEnv > a api-key projection leaves the placeholder as the only credential a populated parent hands down | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > claudeAuthEnv > a bearer projection leaves the placeholder as the only credential a populated parent hands down | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > claudeAuthEnv > no projection sets no variables, so the CLI uses its own login | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > harnessProjection > prefers the native SDK binding over a bare vendor provider id | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > harnessProjection > a stored vendor account binds the harness that answers to it | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/auth.test.ts > harnessProjection > another harness's binding decides nothing | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/auth.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude SDK driver > accepts a mid-turn steer only once the CLI replays it | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude SDK driver > declines a steer the CLI took from stdin but never replayed before the query ended | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude SDK driver > scrubs the local document installation secret from the child environment | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude SDK driver > offers no model until a live probe answers | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude SDK driver > marks the SDK's default row, so the picker shows the model an unset session runs | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude SDK driver > sends the default row rather than letting the CLI resolve a model of its own | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude spawns against the broker, never a credential > the spawn env carries the base URL and the placeholder | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude spawns against the broker, never a credential > an operator's own credentials in this process do not reach the spawned harness | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude spawns against the broker, never a credential > an auth map that is not projections is refused rather than run on nothing | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > a brokered turn withholds the operator's Claude account > the mirrored config dir carries configuration and no account | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > a brokered turn withholds the operator's Claude account > an entry Claxedo does not name stays out of the brokered dir | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > a brokered turn withholds the operator's Claude account > state Claude Code wrote into the dir survives, a stale mirror does not | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > a brokered turn withholds the operator's Claude account > an operator's later settings edit reaches the next brokered launch | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > a brokered turn withholds the operator's Claude account > the spawn env points at it only while a projection is held | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude turn effort is never dropped silently > a cold model list is loaded, so the first turn still sends its effort | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude turn effort is never dropped silently > a session saved under the full model id finds its alias row | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/driver.test.ts > Claude turn effort is never dropped silently > a level the model does not take fails the turn instead of vanishing | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/driver.test.ts
sdk-claude-codex.tsv | claude/executable.test.ts > resolveClaudeExecutable > finds `claude` on PATH | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/executable.test.ts
sdk-claude-codex.tsv | claude/executable.test.ts > resolveClaudeExecutable > uses the native-installer location when PATH misses it | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/executable.test.ts
sdk-claude-codex.tsv | claude/executable.test.ts > resolveClaudeExecutable > an explicit override wins over PATH | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/executable.test.ts
sdk-claude-codex.tsv | claude/executable.test.ts > resolveClaudeExecutable > a broken explicit override resolves to undefined | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/executable.test.ts
sdk-claude-codex.tsv | claude/executable.test.ts > resolveClaudeExecutable > requireClaudeExecutable throws an actionable error when absent | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/executable.test.ts
sdk-claude-codex.tsv | claude/first-party-mcp.test.ts > Claude first-party MCP injection > keeps the bearer out of the harness child environment | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/first-party-mcp.test.ts
sdk-claude-codex.tsv | claude/goal-lifecycle.test.ts > Claude native Goal lifecycle > drains cancellation before clearing the native hook and rejects late Goal updates | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/goal-lifecycle.test.ts
sdk-claude-codex.tsv | claude/goal-lifecycle.test.ts > Claude native Goal lifecycle > does not accept a model response as confirmation that the native hook was cleared | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/goal-lifecycle.test.ts
sdk-claude-codex.tsv | claude/goal-lifecycle.test.ts > Claude native Goal lifecycle > hands every Goal turn an empty mirror so the CLI resumes from its own transcript | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/goal-lifecycle.test.ts
sdk-claude-codex.tsv | claude/goal-lifecycle.test.ts > Claude native Goal lifecycle > settles the Goal as blocked when the Goal query dies instead of leaving it active | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/goal-lifecycle.test.ts
sdk-claude-codex.tsv | claude/launch.test.ts > - > a launch whose pid was recycled records no identity, so its retirement signals nothing | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/launch.test.ts
sdk-claude-codex.tsv | claude/launch.test.ts > - > a launch whose identity matches the spawn is recorded and retirable | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/launch.test.ts
sdk-claude-codex.tsv | claude/permission-mode-parity.test.ts > Claude SDK PermissionMode parity > the parity assertions are present and hold | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permission-mode-parity.test.ts
sdk-claude-codex.tsv | claude/permission-mode-parity.test.ts > Claude SDK PermissionMode parity > documents the SDK's current mode set | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permission-mode-parity.test.ts
sdk-claude-codex.tsv | claude/permission-mode-parity.test.ts > Claude SDK PermissionMode parity > mode ids are unique | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permission-mode-parity.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > allow_always carries only accepted grants into a recreated driver and isolates other sessions | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > allow_once carries only accepted grants into a recreated driver and isolates other sessions | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > deny carries only accepted grants into a recreated driver and isolates other sessions | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > storage-failure carries only accepted grants into a recreated driver and isolates other sessions | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > native rule replacements and removals remain scoped to their behavior and preserve exact rule contents | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > allow_always only reuses the exact accepted Bash request after driver reconstruction | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > allow_once only reuses the exact accepted Bash request after driver reconstruction | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > deny only reuses the exact accepted Bash request after driver reconstruction | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/permissions.test.ts > - > reject_always only reuses the exact accepted Bash request after driver reconstruction | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/permissions.test.ts
sdk-claude-codex.tsv | claude/projection-expiry.test.ts > - > a live placeholder is the token the spawn carries | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/projection-expiry.test.ts
sdk-claude-codex.tsv | claude/turn-input.test.ts > the Claude turn input > a steer resolves only when the CLI replays its uuid | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/turn-input.test.ts
sdk-claude-codex.tsv | claude/turn-input.test.ts > the Claude turn input > ignores user messages that are not replays | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/turn-input.test.ts
sdk-claude-codex.tsv | claude/turn-input.test.ts > the Claude turn input > an unreplayed steer is declined when the query ends and unknown when it fails | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/turn-input.test.ts
sdk-claude-codex.tsv | claude/turn-input.test.ts > the Claude turn input > refuses a steer once stdin is closed, and still delivers one written before | harness/transport/translate | packages/harness/src/transports/claude-sdk/translate/turn-input.test.ts
sdk-claude-codex.tsv | codex/driver-env.test.ts > Codex app-server environment > scrubs the local document installation secret from the child environment | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/driver-env.test.ts
sdk-claude-codex.tsv | codex/driver-env.test.ts > Codex app-server environment > registers the app-server PID and safe MCP identities | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/driver-env.test.ts
sdk-claude-codex.tsv | codex/executable.test.ts > Codex executable resolution > resolves the executable from PATH on Posix | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/executable.test.ts
sdk-claude-codex.tsv | codex/executable.test.ts > Codex executable resolution > follows a Windows npm cmd shim to the official native binary | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/executable.test.ts
sdk-claude-codex.tsv | codex/executable.test.ts > Codex executable resolution > uses a native codex.exe directly on Windows | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/executable.test.ts
sdk-claude-codex.tsv | codex/executable.test.ts > Codex executable resolution > throws an actionable error when Codex is absent | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/executable.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > failed approval requests receive a valid JSON-RPC error and the transport remains usable | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > dispose stops a descendant that outlives the app-server | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > a request that never answers rejects at its deadline and the transport survives | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > a launch is refused when ownership cannot be recorded | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > a request to an app-server that already exited is refused, not left to its deadline | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > a retained unresolved launch stops refusing once its recorded pid is no longer that launch | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/app-server-process.test.ts > - > a request during the TERM grace is still sent, because a signalled process can still answer | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/app-server-process.test.ts
sdk-claude-codex.tsv | codex/auth-file.test.ts > Codex auth file > writes auth.json owner-only and readable back | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/auth-file.test.ts
sdk-claude-codex.tsv | codex/auth-file.test.ts > Codex auth file > repairs the mode on a pre-existing permissive auth file | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/auth-file.test.ts
sdk-claude-codex.tsv | codex/auth-file.test.ts > Codex auth file > narrows a permissive home directory | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/auth-file.test.ts
sdk-claude-codex.tsv | codex/auth-file.test.ts > Codex auth file > refuses a symlinked home instead of writing through it | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/auth-file.test.ts
sdk-claude-codex.tsv | codex/auth-file.test.ts > Codex auth file > replaces a symlink at auth.json instead of writing through it | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/auth-file.test.ts
sdk-claude-codex.tsv | codex/auth-file.test.ts > Codex auth file > answers undefined for a missing auth file | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/auth-file.test.ts
sdk-claude-codex.tsv | codex/dynamic-agent.test.ts > spawnDynamicCodexAgent > removes the child listener after turn-start failure | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/dynamic-agent.test.ts
sdk-claude-codex.tsv | codex/goal-lifecycle.test.ts > Codex Goal lifecycle > deletes a session without spawning an app-server when the Codex binary is broken | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/goal-lifecycle.test.ts
sdk-claude-codex.tsv | codex/idle-reaping.test.ts > Codex app-server idle reaping > reaps the app-server after a quiet period and respawns for the next turn | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/idle-reaping.test.ts
sdk-claude-codex.tsv | codex/idle-reaping.test.ts > Codex app-server idle reaping > does not reap a turn that is still inside a long silent tool call | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/idle-reaping.test.ts
sdk-claude-codex.tsv | codex/idle-reaping.test.ts > Codex app-server idle reaping > a turn whose app-server never starts leaves no lease behind | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/idle-reaping.test.ts
sdk-claude-codex.tsv | codex/permission-state.test.ts > - > a failed durable grant write never returns approval to Codex | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/permission-state.test.ts
sdk-claude-codex.tsv | codex/permission-state.test.ts > - > allow_always survives native callback replacement only when explicitly persistent | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/permission-state.test.ts
sdk-claude-codex.tsv | codex/permission-state.test.ts > - > allow_once survives native callback replacement only when explicitly persistent | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/permission-state.test.ts
sdk-claude-codex.tsv | codex/permission-state.test.ts > - > deny survives native callback replacement only when explicitly persistent | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/permission-state.test.ts
sdk-claude-codex.tsv | codex/permission-state.test.ts > - > reject_always survives native callback replacement only when explicitly persistent | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/permission-state.test.ts
sdk-claude-codex.tsv | codex/protocol.test.ts > - > every inventory read carries its own budget, so a paged stop cannot expire partway through | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/protocol.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > command approval can be answered during publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > command approval cleans up a failed publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > question can be answered during publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > question cleans up a failed publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > MCP form can be answered during publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > MCP form cleans up a failed publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > MCP approval can be answered during publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > MCP approval cleans up a failed publication | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > separate native processes reusing RPC id zero receive distinct canonical question IDs | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/server-request.test.ts > - > separate native processes reusing RPC id zero receive distinct canonical permission IDs | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/server-request.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > isThreadNotFound > matches the app-server's message | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > isThreadNotFound > does not match unrelated failures | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > startTurnWithThreadRecovery > does not resume when the turn starts cleanly | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > startTurnWithThreadRecovery > never retries a failure that is not a missing thread | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > startTurnWithThreadRecovery > surfaces a resume failure instead of hiding it | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > startTurnWithThreadRecovery > recovers on the second resume cycle when the first retry still misses | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/thread-recovery.test.ts > startTurnWithThreadRecovery > goes terminal with a classified session error once recovery is exhausted | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/thread-recovery.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > shares one app-server startup across concurrent session creation and model discovery | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a projection for another harness leaves Codex on the operator's own login | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a bound Codex account launches on a Claxedo home carrying the placeholder | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > disposes an app-server whose startup is still pending | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > omits Codex app-server default model from provider requests | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > passes explicit Codex app-server models through to provider requests | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > uses prompt session model before workspace-global model for Codex app-server turns | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > exposes each Codex model's supported reasoning efforts as a config option | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > options describe the model they are asked for, never the last-created session's | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > passes the selected reasoning effort to Codex turn/start | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a turn that arrives before any options probe still names its effort and tier | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > every turn names a concrete model and effort, so nothing carries over from the last one | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a hidden model still has its effort confirmed | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > refuses a level the model does not offer instead of running without it | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > exposes the selected Codex model's fast tier as a service_tier option | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a requested tier "priority" reaches turn/start as "priority" | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a requested tier null reaches turn/start as null | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > a requested tier "flex" reaches turn/start as null | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-claude-codex.tsv | codex/workspace-behavior.test.ts > CodexHarnessAdapter > an approval storage failure replies to the provider and does not strand the public turn | harness/transport/translate | packages/harness/src/transports/codex-app-server/translate/workspace-behavior.test.ts
sdk-core.tsv | compat-events.session-id.test.ts > eventSessionId > returns undefined for partial/malformed frames instead of throwing | workspace-runtime/projection | packages/workspace-runtime/src/projection/compat-events.session-id.test.ts
sdk-core.tsv | compat-events.session-id.test.ts > eventSessionId > reads the session off a type it does not name, so a new kind is never workspace-wide by omission | workspace-runtime/projection | packages/workspace-runtime/src/projection/compat-events.session-id.test.ts
sdk-core.tsv | runtime-event-hub.test.ts > createRuntimeEventHub > isolates subscriber failures from later global subscribers | workspace-runtime/projection | packages/workspace-runtime/src/projection/runtime-event-hub.test.ts
sdk-core.tsv | runtime-event-hub.test.ts > createRuntimeEventHub > rejects explicit runtime envelopes from another contract version | workspace-runtime/projection | packages/workspace-runtime/src/projection/runtime-event-hub.test.ts
sdk-core.tsv | runtime.test.ts > (top level) > disposing a runtime leaves its injected store open for its owner | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > disposal initiates owned adapter teardown to unblock a pending create | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > disposal initiates owned adapter teardown to unblock a pending turn | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > borrowed adapters survive disposal after lazy handoff resolution | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > disposal waits for admitted producer finalization and refuses later work | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > serializes concurrent Goal starts per session | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > resolves one lazy adapter for concurrent callers | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > ends a slow subscription with an explicit overflow notice | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > rejects a bound session whose canonical runtime config is missing | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > never derives a runtime config for a session the store has not bound | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > rejects session operations when no adapter can be named for the session | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > holds the session against new turns until a harness switch lands | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > refuses a harness switch while a turn holds the session | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > rejects a turn without an execution binding before recording it as busy | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > applies the selected runtime model before creating a session | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > a create that names no model clears the previous create's model | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > event subscriptions close immediately when returned while idle | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > publishes the authoritative busy status before a slow native harness yields | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > rejects a concurrent turn before persisting any part of it | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > publishes completion only after adapter cleanup releases next-turn admission | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > rejects a committing adapter terminal write after a durable fence takeover | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > a failed cancellation (error) keeps admission until the executing turn finishes | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > a failed cancellation (not_found) keeps admission until the executing turn finishes | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > a persisted unfinished turn is inspectable but cannot be cancelled by an owner that never admitted it | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > keeps a cancelled outcome when a late stream completion arrives | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime.test.ts > createAgentRuntime > memory store starts the same active assistant turn exactly once | workspace-runtime/host | packages/workspace-runtime/src/host/runtime.test.ts
sdk-core.tsv | runtime/subscription.test.ts > createRuntimeSubscription > an event buffered before the subscriber closes still drains to its reader | workspace-runtime/host | packages/workspace-runtime/src/host/subscription.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > (top level) > committed turn events publish once without an HTTP request subscription | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > (top level) > steering after the target ended does not silently start a new turn | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > (top level) > a steer suspended in adapter resolution cannot attach to a replacement turn | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > (top level) > a failed host admission hook releases the runtime turn claim | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > prompts for a session that is already running a turn > prompts queued for one session start in the order they were queued | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > prompts for a session that is already running a turn > a prompt queued while an earlier queued one runs still starts behind it | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > prompts for a session that is already running a turn > a session with nothing running is idle at once, so a queued prompt starts immediately | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > prompts for a session that is already running a turn > a prompt with no delivery still takes the admission conflict | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > a prompt that starts waiting after the turn ended still waits behind the queue | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > a woken prompt that cannot start hands the session to the next waiter | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > giving the session up after it was claimed hands nothing on | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > a session handed to a waiter is still busy to a prompt that arrives before it claims | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > a session whose last waiter has run is idle again to the next prompt | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > a release from a generation that no longer owns the session wakes nobody | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > handing an idle session to the prompts waiting for it > disposal releases every prompt still waiting | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/turn-admission.test.ts > scoping a cancellation to the turn the caller was looking at > a cancellation naming a turn that already ended leaves the running one alone | workspace-runtime/host | packages/workspace-runtime/src/host/turn-admission.test.ts
sdk-core.tsv | runtime/recovery.test.ts > cancelling a turn across an asynchronous boundary > a cancellation that settles after its turn was replaced cannot finalize or release the replacement | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > cancelling a turn across an asynchronous boundary > a harness that ends the turn's stream before answering the cancellation reports the turn saved | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > cancelling a turn across an asynchronous boundary > a cancellation naming the turn a lease loss was observed for is refused once that turn ended | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > cancelling a turn across an asynchronous boundary > a harness that never answers yields a bounded operation whose error is inspectable | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > cancelling a turn across an asynchronous boundary > evidence arriving after the deadline corrects the facts without rewriting the attempt | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > a finalization the store refused > a reconciliation that names a different generation is refused | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > finalizing a turn this owner did not admit > a capture with no generation cannot end a turn the runtime has since admitted | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > reading an owner that is shutting down > inspection still answers while disposal drains a turn that has not ended | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > one operation per intent > the same request id twice reads one operation, and a different intent under it conflicts | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > one operation per intent > two callers asking for the same action on the same turn share one operation | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the queue a recovery operation holds > a recovering session neither wakes its own waiters nor touches another session | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the queue a recovery operation holds > a waiter whose lease acquisition fails hands the session to the next one | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the queue a recovery operation holds > shutdown settles parked prompts as unavailable instead of handing out a token | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > disposal > reports an immediately failing teardown without waiting for a task that never drains | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > disposal > a clean teardown drains first and then cleans up | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the authority a finalization must hold > a capture whose generation was replaced is refused as superseded, not as a lost lease | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the authority a finalization must hold > a store turn this owner holds no lease for is refused rather than written unfenced | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the authority a finalization must hold > a store turn this owner does hold the lease for is finalized and the lease released | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the authority a finalization must hold > a finalization the store accepted but recorded nothing for does not claim a commit | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > a lease that moved to another owner > is terminal for this owner: the admission is given up and no retry is advertised | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > an operation that throws > answers its caller, closes, and does not capture the next request for that turn | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > receipts the store already holds > an operation another owner already accepted is adopted instead of run again | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > receipts the store already holds > a stored receipt under the same request id but a different intent conflicts | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > who may read and act > an operation is only readable by a caller it was accepted for | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > who may read and act > a session-scoped caller cannot act on a machine | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > what a session's inspection lists > operations this owner never recorded, and a store that cannot answer | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > a Goal mutation that outlives the turn it stops > finalizes the turn it was asked about across the harness await | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > a Goal mutation that outlives the turn it stops > finalizes the turn it was asked about across the provider await | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > two callers naming one turn > meet on the same operation even when their write authority differs | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > an operation that outlives the owner that issued it > is read back by the callers holding its receipt, and by nobody else | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > an operation that outlives the owner that issued it > an unreadable store answers nothing and reports why, rather than throwing | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > the lease a finalization must carry > an admission that still owns the session cannot finalize without the lease behind it | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > a containment attempt that never became an operation > is retained against the session, and finishing that turn does not clear it | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > a containment attempt that never became an operation > a caller that could not act on the target reports nothing | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | runtime/recovery.test.ts > how long a settled operation stays readable > for the contract's retention, not for whatever this caller's deadlines were | workspace-runtime/host | packages/workspace-runtime/src/host/recovery.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > keeps one Cursor synthetic key whether provider identity arrives late or never | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > keeps one Claude host key when provider kind precedes the late agent id | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > retries both sides of publication with the same persisted key and revision | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > exact replay is idempotent and conflicting observation-id reuse fails closed | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > allows immutable bindings once and rejects later conflicts for an explicit host key | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > rejects partial role-bearing tool-call edges before persistence | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > a harness tool edge naming a claxedo key the host never minted is refused as unknown and leaves no row | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > the host's own create mints the claxedo row; the harness tool edge then attaches to it | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > a harness tool edge naming the host's key with a different child is the immutable-binding conflict | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > child identity is the strongest correlator: an observation naming an owned child resolves to the owning row | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > an observation matching two rows joins the stronger key instead of opening a third | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > admission allocates the child once and reuses the binding for later child-less observations | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-core.tsv | subagent-admission.test.ts > subagent host admission > a duplicate delivery lacking the allocated child dedupes instead of conflicting | harness/broker/subagents | packages/harness/src/broker/subagents/admission.test.ts
sdk-cursor-pi-shared.tsv | cursor/backend-url-freeze.test.ts > the value in force at the import is what the SDK keeps | harness/transport/translate | packages/harness/src/transports/cursor-sdk/translate/backend-url-freeze.test.ts
sdk-cursor-pi-shared.tsv | cursor/backend-url-freeze.test.ts > a process that never imported the SDK freezes nothing and refuses nothing | harness/transport/translate | packages/harness/src/transports/cursor-sdk/translate/backend-url-freeze.test.ts
sdk-cursor-pi-shared.tsv | cursor/backend-url-freeze.test.ts > the driver's own load is what freezes the value, with nobody calling the freeze | harness/transport/translate | packages/harness/src/transports/cursor-sdk/translate/backend-url-freeze.test.ts
sdk-cursor-pi-shared.tsv | cursor/backend-url-freeze.test.ts > an injected agent module freezes the value exactly as the real import does | harness/transport/translate | packages/harness/src/transports/cursor-sdk/translate/backend-url-freeze.test.ts
sdk-cursor-pi-shared.tsv | pi/auth.test.ts > a profile reacquired during cleanup serializes its new credential write after removal | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/auth.test.ts
sdk-cursor-pi-shared.tsv | pi/auth.test.ts > a shared managed profile survives until its final adapter is disposed | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/auth.test.ts
sdk-cursor-pi-shared.tsv | pi/auth.test.ts > an idle reap on a live adapter leaves the account overlay for its next launch | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/auth.test.ts
sdk-cursor-pi-shared.tsv | pi/driver.test.ts > an idle RPC check cannot dispose a new turn after a stale resolve | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/driver.test.ts
sdk-cursor-pi-shared.tsv | pi/driver.test.ts > an idle RPC check cannot dispose a new turn after a stale reject | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/driver.test.ts
sdk-cursor-pi-shared.tsv | pi/driver.test.ts > the goal evaluator receives its request on stdin, keeping prompt material out of argv | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/driver.test.ts
sdk-cursor-pi-shared.tsv | pi/driver.test.ts > a deferred auth release is retried by the retirement that settles the launch blocking it | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/driver.test.ts
sdk-cursor-pi-shared.tsv | pi/rpc-process.test.ts > dispose retires the owned group, including a descendant that ignores TERM | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/rpc-process.test.ts
sdk-cursor-pi-shared.tsv | pi/rpc-process.test.ts > exit is published when the OS reports it, not when disposal starts | harness/transport/translate | packages/harness/src/transports/pi-rpc/translate/rpc-process.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-authority.test.ts > a domain that cannot claim the session's lease gets no authority to write with | harness/translate | packages/harness/src/translate/turn-authority.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-authority.test.ts > a finalization releases the lease so the session is admissible again | harness/translate | packages/harness/src/translate/turn-authority.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-authority.test.ts > a finalization the store refuses still releases the lease | harness/translate | packages/harness/src/translate/turn-authority.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-authority.test.ts > a terminal presenting a lease the session has moved past is refused | harness/translate | packages/harness/src/translate/turn-authority.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-publisher.test.ts > createGoalPublisher > dedupes an unchanged snapshot and republishes once it changes | harness/translate | packages/harness/src/translate/goal-publisher.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-publisher.test.ts > createGoalPublisher > dedupes per session, so equal snapshots from two sessions both publish | harness/translate | packages/harness/src/translate/goal-publisher.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-publisher.test.ts > createGoalPublisher > runs applyState only on an accepted change, before the event goes out | harness/translate | packages/harness/src/translate/goal-publisher.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-publisher.test.ts > createGoalPublisher > mirrors adapter state even when no event hub is wired | harness/translate | packages/harness/src/translate/goal-publisher.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-publisher.test.ts > createGoalPublisher > forget retires the dedup entry so a re-created session republishes | harness/translate | packages/harness/src/translate/goal-publisher.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-stop-order.test.ts > goal stop ordering > continuation is disabled, the turn interrupted, and only then settled | harness/translate | packages/harness/src/translate/goal-stop-order.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-stop-order.test.ts > goal stop ordering > a failed disable interrupts nothing and is returned untouched | harness/translate | packages/harness/src/translate/goal-stop-order.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-stop-order.test.ts > goal stop ordering > without a settle step the disabling result is the answer | harness/translate | packages/harness/src/translate/goal-stop-order.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-stop-order.test.ts > goal stop ordering > a session with no registered turn has nothing to wait for | harness/translate | packages/harness/src/translate/goal-stop-order.test.ts
sdk-cursor-pi-shared.tsv | shared/goal-stop-order.test.ts > a Goal stop whose turn never leaves its producer is bounded by the caller's deadline | harness/translate | packages/harness/src/translate/goal-stop-order.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question replies remain retryable when persistence fails | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > permission cancellation remains retryable when persistence fails | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > permission replies from other-session in <work> cannot consume another pending request | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > permission replies from session-1 in <other-workspace> cannot consume another pending request | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > permission approval remains pending when the reply cannot be committed | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question cancellation commits rejection and only consumes the stopped session | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question cancellation preserves a pending request when persistence fails | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question reply from other-session in <work> preserves another owner's request | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question reply from session-1 in <other-workspace> preserves another owner's request | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question reject from other-session in <work> preserves another owner's request | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > question reject from session-1 in <other-workspace> preserves another owner's request | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-interactions.test.ts > all-question shutdown keeps an uncommitted rejection live | harness/translate | packages/harness/src/translate/sdk-runtime-interactions.test.ts
sdk-cursor-pi-shared.tsv | shared/store-lifecycle.test.ts > adapter store lifecycle > AcpHarnessAdapter closes adapter-created stores once | harness/translate | packages/harness/src/translate/store-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/store-lifecycle.test.ts > adapter store lifecycle > AcpHarnessAdapter leaves caller-owned stores open | harness/translate | packages/harness/src/translate/store-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/store-lifecycle.test.ts > adapter store lifecycle > CodexHarnessAdapter closes adapter-created stores once | harness/translate | packages/harness/src/translate/store-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/store-lifecycle.test.ts > adapter store lifecycle > CodexHarnessAdapter leaves caller-owned stores open | harness/translate | packages/harness/src/translate/store-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/subagent-lifecycle.test.ts > a child's turn claims the child session's own lease, not the parent's | harness/translate | packages/harness/src/translate/subagent-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/subagent-lifecycle.test.ts > settling a child releases its lease, and a repeated terminal is a replay | harness/translate | packages/harness/src/translate/subagent-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/subagent-lifecycle.test.ts > a late settle against a replacement child generation is refused by the store fence | harness/translate | packages/harness/src/translate/subagent-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/subagent-lifecycle.test.ts > settleOpen interrupts a foreground child this turn still owns, and skips a background one | harness/translate | packages/harness/src/translate/subagent-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/subagent-lifecycle.test.ts > a child whose turn could not start does not keep the session's lease | harness/translate | packages/harness/src/translate/subagent-lifecycle.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-projection.test.ts > createTurnEventProjector > does not publish runtime events when compat append fails | harness/translate | packages/harness/src/translate/turn-projection.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-projection.test.ts > createTurnEventProjector > does not publish live events when compat append does not return committed output | harness/translate | packages/harness/src/translate/turn-projection.test.ts
sdk-cursor-pi-shared.tsv | shared/turn-projection.test.ts > createTurnEventProjector > does not publish terminalized tool errors when append fails | harness/translate | packages/harness/src/translate/turn-projection.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > flushes content received across a live reconnect in source order after association | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > expires the offending correlation at the 257th unresolved event | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > expires an unresolved correlation that exceeds one MiB | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > expires unresolved content after thirty seconds without a journal write | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > keeps unrelated buffered correlations when one correlation overflows | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > drops unmeasurable child events without poisoning later serializable content | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > createChildEventRouter > dispose clears timers and drops unresolved content diagnostically | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > reaches the parent turn when its correlation expires, as each scope's latest cumulative and every delta | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > reaches the parent turn when the turn ends before its correlation binds | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > reaches the parent turn when its correlation overflows the count or byte limit, the overflowing event included | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > reaches the parent turn after its correlation is poisoned, while the child's transcript stays dropped | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > keeps metering on the parent once a rolled-up correlation binds, so its cumulative is counted once | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > reaches the parent turn without a correlation key, and other uncorrelated events are still dropped | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/child-event-routing.test.ts > usage a dropped child would lose > keeps two uncorrelated children apart by the provider session each reports from | harness/translate | packages/harness/src/translate/child-event-routing.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter > disposal awaits the full committing prompt producer after its driver stops | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter > disposal awaits the full committing goal producer after its driver stops | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter > forgets a deleted session's Goal publication so a reused id is not deduped away | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > usage of a child that never bound, rolled up after the turn stops reading > reaches the hub once, not the consumer | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > usage of a child that never bound, rolled up after the turn stops reading > reaches the hub when the consumer returns before the turn ends | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter > Codex drops a provisional autonomous Goal queue when provider-turn admission is busy | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter > does not acknowledge an abort until the adapter busy lock is retired | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter > dispose aborts and closes active turns | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter busy lock > releases the lock at the terminal event, before the generator finishes | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter busy lock > a second prompt is accepted once the turn has settled | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter busy lock > double release is a no-op, so the finally backstop cannot strand a session | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | shared/sdk-runtime-adapter.test.ts > SdkRuntimeAdapter busy lock > a stale release cannot unlock a replacement turn generation | harness/translate | packages/harness/src/translate/sdk-runtime-adapter.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > a provider that never answers the interrupt is bounded, and is never reported terminal | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > a cancel that rejects while the stream is still open reports the provider's error, not a stopped turn | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > a producer that left after a cancel the provider refused is unknown, never terminal | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > an ACP prompt that never settles after the acknowledgement is bounded | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > a transient cancellation failure does not poison the retry | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > a concurrent second stop joins the attempt in flight rather than starting another | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > a late answer from an old turn is refused and reported to the session's owner | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > an interaction the store could not project reaches the session's owner, not only its caller | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
sdk-cursor-pi-shared.tsv | recovery-contract.test.ts > per-harness recovery capability matrix > the loser of a deadline race releases its timer and its listener | harness/translate | packages/harness/src/translate/recovery-contract.test.ts
```

### Source-path deletion manifest at this base

These are path removals, including moves and replaced tests, rather than a claim that their behavior disappears. P3 is the old host, projection and adapter tree plus the OpenCode adapter; P4 is every remaining file in the three retiring packages. The set difference prevents the same path being assigned to both phases. Recompute it after merging the concurrent lanes.

```sh
python3 - <<'PY'
from pathlib import Path
import subprocess
def files(path):
    return {Path(name) for name in subprocess.check_output(["rg", "--files", "--hidden", "-g", "!**/node_modules/**", "-g", "!**/dist/**", "-g", "!**/.turbo/**", str(path)], text=True).splitlines()}
sdk = Path("packages/agent-sdk-runtime/src")
event = Path("packages/agent-event-runtime/src")
workspace = Path("packages/workspace-runtime/src")
p3 = files(sdk / "harnesses") | files(sdk / "runtime") | files(event / "projections/client-presentation") | files(event / "harnesses") | files(event / "core")
p3 |= {sdk / name for name in ("runtime.ts", "runtime.test.ts", "runtime-event-hub.ts", "runtime-event-hub.test.ts", "compat-events.ts", "compat-events.parts.test.ts", "compat-events.session-id.test.ts", "adapter-contract.ts", "adapter-contract.test.ts", "subagent-admission.ts", "subagent-admission.test.ts")}
p3 |= {event / "value.ts", event / "value.test.ts"}
p3 |= {workspace / "opencode/harness-adapter.ts", workspace / "opencode/harness-adapter.test.ts"}
p3 = {path for path in p3 if path.is_file()}
packages = [Path("packages/agent-sdk-runtime"), Path("packages/agent-event-runtime"), Path("packages/opencode-server-adapter")]
p4 = set().union(*(files(package) for package in packages)) - p3
print(f"P3 source paths: {len(p3)}")
for path in sorted(p3): print(path)
print(f"P4 residual package paths: {len(p4)}")
for path in sorted(p4): print(path)
PY
```

```text
P3 source paths: 294
packages/agent-event-runtime/src/core/adapter.ts
packages/agent-event-runtime/src/core/index.ts
packages/agent-event-runtime/src/core/projection.ts
packages/agent-event-runtime/src/core/runtime.test.ts
packages/agent-event-runtime/src/core/runtime.ts
packages/agent-event-runtime/src/core/state.ts
packages/agent-event-runtime/src/harnesses/acp/classify-tool.ts
packages/agent-event-runtime/src/harnesses/acp/diagnostics.ts
packages/agent-event-runtime/src/harnesses/acp/event-translator.test.ts
packages/agent-event-runtime/src/harnesses/acp/event-translator.ts
packages/agent-event-runtime/src/harnesses/acp/golden-compat.test.ts
packages/agent-event-runtime/src/harnesses/acp/index.ts
packages/agent-event-runtime/src/harnesses/acp/state.ts
packages/agent-event-runtime/src/harnesses/acp/translate-session-update.ts
packages/agent-event-runtime/src/harnesses/acp/types.ts
packages/agent-event-runtime/src/harnesses/acp/validation.ts
packages/agent-event-runtime/src/harnesses/claude/adapter.test.ts
packages/agent-event-runtime/src/harnesses/claude/adapter.ts
packages/agent-event-runtime/src/harnesses/claude/index.ts
packages/agent-event-runtime/src/harnesses/claude/partial-json.test.ts
packages/agent-event-runtime/src/harnesses/claude/partial-json.ts
packages/agent-event-runtime/src/harnesses/claude/question-decline.test.ts
packages/agent-event-runtime/src/harnesses/claude/question-decline.ts
packages/agent-event-runtime/src/harnesses/claude/task-ledger.test.ts
packages/agent-event-runtime/src/harnesses/claude/task-ledger.ts
packages/agent-event-runtime/src/harnesses/claude/task-tracking.ts
packages/agent-event-runtime/src/harnesses/codex/adapter.test.ts
packages/agent-event-runtime/src/harnesses/codex/adapter.ts
packages/agent-event-runtime/src/harnesses/codex/fixtures/codex-subagent-parent-transcript.json
packages/agent-event-runtime/src/harnesses/codex/index.ts
packages/agent-event-runtime/src/harnesses/codex/mcp-elicitation.test.ts
packages/agent-event-runtime/src/harnesses/codex/mcp-elicitation.ts
packages/agent-event-runtime/src/harnesses/codex/protocol-pin.test.ts
packages/agent-event-runtime/src/harnesses/codex/subagent-parent-baseline.test.ts
packages/agent-event-runtime/src/harnesses/cursor/adapter.test.ts
packages/agent-event-runtime/src/harnesses/cursor/adapter.ts
packages/agent-event-runtime/src/harnesses/cursor/index.ts
packages/agent-event-runtime/src/harnesses/host-subagent.test.ts
packages/agent-event-runtime/src/harnesses/host-subagent.ts
packages/agent-event-runtime/src/harnesses/pi/adapter.test.ts
packages/agent-event-runtime/src/harnesses/pi/adapter.ts
packages/agent-event-runtime/src/harnesses/pi/index.ts
packages/agent-event-runtime/src/harnesses/plan-mode-projection.test.ts
packages/agent-event-runtime/src/harnesses/tool-attachments.test.ts
packages/agent-event-runtime/src/harnesses/tool-attachments.ts
packages/agent-event-runtime/src/harnesses/tool-display.ts
packages/agent-event-runtime/src/harnesses/tool-name-canonicalisation.test.ts
packages/agent-event-runtime/src/projections/client-presentation/author.test.ts
packages/agent-event-runtime/src/projections/client-presentation/author.ts
packages/agent-event-runtime/src/projections/client-presentation/index.ts
packages/agent-event-runtime/src/projections/client-presentation/normalize.ts
packages/agent-event-runtime/src/projections/client-presentation/projection.test.ts
packages/agent-event-runtime/src/projections/client-presentation/projection.ts
packages/agent-event-runtime/src/projections/client-presentation/runtime-envelope.test.ts
packages/agent-event-runtime/src/projections/client-presentation/runtime-envelope.ts
packages/agent-event-runtime/src/projections/client-presentation/state.ts
packages/agent-event-runtime/src/projections/client-presentation/types.ts
packages/agent-event-runtime/src/value.test.ts
packages/agent-event-runtime/src/value.ts
packages/agent-sdk-runtime/src/adapter-contract.test.ts
packages/agent-sdk-runtime/src/adapter-contract.ts
packages/agent-sdk-runtime/src/compat-events.parts.test.ts
packages/agent-sdk-runtime/src/compat-events.session-id.test.ts
packages/agent-sdk-runtime/src/compat-events.ts
packages/agent-sdk-runtime/src/harnesses/acp/cancellation.ts
packages/agent-sdk-runtime/src/harnesses/acp/capabilities.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/capabilities.ts
packages/agent-sdk-runtime/src/harnesses/acp/connection-provider.ts
packages/agent-sdk-runtime/src/harnesses/acp/connection-state.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/connection-state.ts
packages/agent-sdk-runtime/src/harnesses/acp/create-session.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/elicitation-request.ts
packages/agent-sdk-runtime/src/harnesses/acp/elicitation-wire.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/elicitation.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/elicitation.ts
packages/agent-sdk-runtime/src/harnesses/acp/first-party-mcp.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/goal-extension.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/goal-projection.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/goal-response.ts
packages/agent-sdk-runtime/src/harnesses/acp/goals.ts
packages/agent-sdk-runtime/src/harnesses/acp/health.ts
packages/agent-sdk-runtime/src/harnesses/acp/helpers.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/helpers.ts
packages/agent-sdk-runtime/src/harnesses/acp/index.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/index.ts
packages/agent-sdk-runtime/src/harnesses/acp/lifecycle-regressions.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/list-agents.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/pattern-validation.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/pattern-validation.ts
packages/agent-sdk-runtime/src/harnesses/acp/permission-grants.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/permission-grants.ts
packages/agent-sdk-runtime/src/harnesses/acp/permission-modes.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/permission-options.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/permission-options.ts
packages/agent-sdk-runtime/src/harnesses/acp/permission-reply.ts
packages/agent-sdk-runtime/src/harnesses/acp/probe-options.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/process-manager.ts
packages/agent-sdk-runtime/src/harnesses/acp/process-retirement.ts
packages/agent-sdk-runtime/src/harnesses/acp/process.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/process.ts
packages/agent-sdk-runtime/src/harnesses/acp/recovery.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/recovery.ts
packages/agent-sdk-runtime/src/harnesses/acp/resolved-model.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/session-isolation.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/session.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/session.ts
packages/agent-sdk-runtime/src/harnesses/acp/startup-elicitation.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/startup-request.ts
packages/agent-sdk-runtime/src/harnesses/acp/subagent-runtime.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/subagent-runtime.ts
packages/agent-sdk-runtime/src/harnesses/acp/subagents.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/subagents.ts
packages/agent-sdk-runtime/src/harnesses/acp/title.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/title.ts
packages/agent-sdk-runtime/src/harnesses/acp/transport-retirement.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/transport.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/transport.ts
packages/agent-sdk-runtime/src/harnesses/acp/transport.windows.test.ts
packages/agent-sdk-runtime/src/harnesses/acp/turn-runner.ts
packages/agent-sdk-runtime/src/harnesses/acp/workspace-behavior.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/auth.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/auth.ts
packages/agent-sdk-runtime/src/harnesses/claude/config-dir.ts
packages/agent-sdk-runtime/src/harnesses/claude/driver.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/driver.ts
packages/agent-sdk-runtime/src/harnesses/claude/executable.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/executable.ts
packages/agent-sdk-runtime/src/harnesses/claude/first-party-mcp.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/goal-lifecycle.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/index.ts
packages/agent-sdk-runtime/src/harnesses/claude/launch.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/launch.ts
packages/agent-sdk-runtime/src/harnesses/claude/permission-mode-parity.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/permission-mode-parity.ts
packages/agent-sdk-runtime/src/harnesses/claude/permission-state.ts
packages/agent-sdk-runtime/src/harnesses/claude/permissions.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/projection-expiry.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/runtime-identity.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/subagent-routing.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/subagent-usage.ts
packages/agent-sdk-runtime/src/harnesses/claude/turn-input.cli.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/turn-input.test.ts
packages/agent-sdk-runtime/src/harnesses/claude/turn-input.ts
packages/agent-sdk-runtime/src/harnesses/codex/active-thread.ts
packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.ts
packages/agent-sdk-runtime/src/harnesses/codex/app-server-process.windows.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/auth-file.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/auth-file.ts
packages/agent-sdk-runtime/src/harnesses/codex/broker.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/broker.ts
packages/agent-sdk-runtime/src/harnesses/codex/cancellation.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/driver-env.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/driver.ts
packages/agent-sdk-runtime/src/harnesses/codex/dynamic-agent.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/dynamic-agent.ts
packages/agent-sdk-runtime/src/harnesses/codex/executable.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/executable.ts
packages/agent-sdk-runtime/src/harnesses/codex/first-party-mcp.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/goal-lifecycle.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/goal.ts
packages/agent-sdk-runtime/src/harnesses/codex/host-subagent.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/host-subagent.ts
packages/agent-sdk-runtime/src/harnesses/codex/idle-reaping.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/index.ts
packages/agent-sdk-runtime/src/harnesses/codex/launch-retention.ts
packages/agent-sdk-runtime/src/harnesses/codex/model-options.ts
packages/agent-sdk-runtime/src/harnesses/codex/operator-login.ts
packages/agent-sdk-runtime/src/harnesses/codex/permission-state.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/permission-state.ts
packages/agent-sdk-runtime/src/harnesses/codex/plugin-launch.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/plugin-launch.ts
packages/agent-sdk-runtime/src/harnesses/codex/protocol.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/protocol.ts
packages/agent-sdk-runtime/src/harnesses/codex/server-request.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/server-request.ts
packages/agent-sdk-runtime/src/harnesses/codex/steering.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/thread-ownership.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/thread-projection.ts
packages/agent-sdk-runtime/src/harnesses/codex/thread-recovery.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/thread-registry.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/thread-registry.ts
packages/agent-sdk-runtime/src/harnesses/codex/title.test.ts
packages/agent-sdk-runtime/src/harnesses/codex/title.ts
packages/agent-sdk-runtime/src/harnesses/codex/workspace-behavior.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/auth.ts
packages/agent-sdk-runtime/src/harnesses/cursor/backend-url-freeze.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/driver.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/driver.ts
packages/agent-sdk-runtime/src/harnesses/cursor/first-party-mcp.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/goal-lifecycle.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/index.ts
packages/agent-sdk-runtime/src/harnesses/cursor/subagent-routing.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/title.test.ts
packages/agent-sdk-runtime/src/harnesses/cursor/title.ts
packages/agent-sdk-runtime/src/harnesses/goal-conformance.test.ts
packages/agent-sdk-runtime/src/harnesses/goal-recovery.test.ts
packages/agent-sdk-runtime/src/harnesses/harness-capabilities.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/agent-dir.ts
packages/agent-sdk-runtime/src/harnesses/pi/auth.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/auth.ts
packages/agent-sdk-runtime/src/harnesses/pi/catalog.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/catalog.ts
packages/agent-sdk-runtime/src/harnesses/pi/driver.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/driver.ts
packages/agent-sdk-runtime/src/harnesses/pi/executable.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/executable.ts
packages/agent-sdk-runtime/src/harnesses/pi/index.ts
packages/agent-sdk-runtime/src/harnesses/pi/native.integration.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/profile-isolation.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/rpc-process.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/rpc-process.ts
packages/agent-sdk-runtime/src/harnesses/pi/title-extension.test.ts
packages/agent-sdk-runtime/src/harnesses/pi/title-extension.ts
packages/agent-sdk-runtime/src/harnesses/recovery-contract.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/accepted-session-mutation.ts
packages/agent-sdk-runtime/src/harnesses/shared/agent-session-index.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/agent-session-index.ts
packages/agent-sdk-runtime/src/harnesses/shared/cancellation-facts.ts
packages/agent-sdk-runtime/src/harnesses/shared/child-event-routing.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/child-event-routing.ts
packages/agent-sdk-runtime/src/harnesses/shared/evaluated-goal-resource.ts
packages/agent-sdk-runtime/src/harnesses/shared/goal-protocol.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/goal-protocol.ts
packages/agent-sdk-runtime/src/harnesses/shared/goal-publisher.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/goal-publisher.ts
packages/agent-sdk-runtime/src/harnesses/shared/goal-stop-order.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/goal-stop-order.ts
packages/agent-sdk-runtime/src/harnesses/shared/mcp-elicitation.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/mcp-elicitation.ts
packages/agent-sdk-runtime/src/harnesses/shared/native-goal-resource.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/native-goal-resource.ts
packages/agent-sdk-runtime/src/harnesses/shared/native-goal-store.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/native-goal-store.ts
packages/agent-sdk-runtime/src/harnesses/shared/outside-turn-usage.ts
packages/agent-sdk-runtime/src/harnesses/shared/permission-modes.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/permission-modes.ts
packages/agent-sdk-runtime/src/harnesses/shared/prompt-attachments.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/prompt-attachments.ts
packages/agent-sdk-runtime/src/harnesses/shared/request-deadline.ts
packages/agent-sdk-runtime/src/harnesses/shared/runtime-store.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-adapter.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-adapter.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-cancellation.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-capabilities.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-driver.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-goals.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-interactions.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-interactions.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-producers.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-title.ts
packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-values.ts
packages/agent-sdk-runtime/src/harnesses/shared/store-lifecycle.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/subagent-lifecycle.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/subagent-lifecycle.ts
packages/agent-sdk-runtime/src/harnesses/shared/subagent-transcript.ts
packages/agent-sdk-runtime/src/harnesses/shared/test-temp-dir.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-authority.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-authority.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-lifecycle.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-projection.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-projection.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-steering.test.ts
packages/agent-sdk-runtime/src/harnesses/shared/turn-steering.ts
packages/agent-sdk-runtime/src/harnesses/steer-conformance.live.test.ts
packages/agent-sdk-runtime/src/runtime/contracts.ts
packages/agent-sdk-runtime/src/runtime/execution-binding.ts
packages/agent-sdk-runtime/src/runtime/goal-controller.ts
packages/agent-sdk-runtime/src/runtime/goal-start-admission.ts
packages/agent-sdk-runtime/src/runtime/handoff-transaction.ts
packages/agent-sdk-runtime/src/runtime/lifecycle.ts
packages/agent-sdk-runtime/src/runtime/machine-execution-binding.test.ts
packages/agent-sdk-runtime/src/runtime/recovery-capture.ts
packages/agent-sdk-runtime/src/runtime/recovery-facts.ts
packages/agent-sdk-runtime/src/runtime/recovery-operations.ts
packages/agent-sdk-runtime/src/runtime/recovery-wiring.ts
packages/agent-sdk-runtime/src/runtime/recovery.test.ts
packages/agent-sdk-runtime/src/runtime/recovery.ts
packages/agent-sdk-runtime/src/runtime/session-titles.ts
packages/agent-sdk-runtime/src/runtime/subscription.test.ts
packages/agent-sdk-runtime/src/runtime/subscription.ts
packages/agent-sdk-runtime/src/runtime/turn-admission.test.ts
packages/agent-sdk-runtime/src/runtime/turn-admission.ts
packages/agent-sdk-runtime/src/runtime/turn-outcome.ts
packages/agent-sdk-runtime/src/runtime/turn-publication.ts
packages/agent-sdk-runtime/src/runtime/turn-record.ts
packages/agent-sdk-runtime/src/runtime-event-hub.test.ts
packages/agent-sdk-runtime/src/runtime-event-hub.ts
packages/agent-sdk-runtime/src/runtime.test.ts
packages/agent-sdk-runtime/src/runtime.ts
packages/agent-sdk-runtime/src/subagent-admission.test.ts
packages/agent-sdk-runtime/src/subagent-admission.ts
packages/workspace-runtime/src/opencode/harness-adapter.test.ts
packages/workspace-runtime/src/opencode/harness-adapter.ts
P4 residual package paths: 142
packages/agent-event-runtime/.gitignore
packages/agent-event-runtime/LICENSE
packages/agent-event-runtime/README.md
packages/agent-event-runtime/docs/agent.md
packages/agent-event-runtime/docs/api-manifest.json
packages/agent-event-runtime/docs/api.md
packages/agent-event-runtime/docs/architecture.md
packages/agent-event-runtime/docs/boundaries.md
packages/agent-event-runtime/docs/concepts.md
packages/agent-event-runtime/docs/recipes.md
packages/agent-event-runtime/package.json
packages/agent-event-runtime/scripts/build.ts
packages/agent-event-runtime/scripts/generate-codex-protocol.ts
packages/agent-event-runtime/src/client-presentation.ts
packages/agent-event-runtime/src/contracts/agent-runtime-event.test.ts
packages/agent-event-runtime/src/contracts/agent-runtime-event.ts
packages/agent-event-runtime/src/contracts/diagnostics.ts
packages/agent-event-runtime/src/contracts/ids.ts
packages/agent-event-runtime/src/contracts/index.ts
packages/agent-event-runtime/src/contracts/raw-harness-event.ts
packages/agent-event-runtime/src/contracts/stream-heartbeat.ts
packages/agent-event-runtime/src/contracts/turn-message-ids.test.ts
packages/agent-event-runtime/src/contracts/turn-message-ids.ts
packages/agent-event-runtime/src/index.test.ts
packages/agent-event-runtime/src/index.ts
packages/agent-event-runtime/src/projections/debug-trace/index.ts
packages/agent-event-runtime/src/projections/debug-trace/projection.test.ts
packages/agent-event-runtime/src/projections/debug-trace/projection.ts
packages/agent-event-runtime/src/test-utils/replay.ts
packages/agent-event-runtime/tsconfig.build.json
packages/agent-event-runtime/tsconfig.json
packages/agent-sdk-runtime/CHANGELOG.md
packages/agent-sdk-runtime/LICENSE
packages/agent-sdk-runtime/README.md
packages/agent-sdk-runtime/bunfig.toml
packages/agent-sdk-runtime/docs/agent.md
packages/agent-sdk-runtime/docs/api-manifest.json
packages/agent-sdk-runtime/docs/api.md
packages/agent-sdk-runtime/docs/architecture.md
packages/agent-sdk-runtime/docs/boundaries.md
packages/agent-sdk-runtime/docs/concepts.md
packages/agent-sdk-runtime/docs/recipes.md
packages/agent-sdk-runtime/package.json
packages/agent-sdk-runtime/scripts/acp-claude-live-acceptance.ts
packages/agent-sdk-runtime/scripts/acp-live-acceptance.ts
packages/agent-sdk-runtime/scripts/acp-openclaw-live-acceptance.ts
packages/agent-sdk-runtime/scripts/build.ts
packages/agent-sdk-runtime/scripts/check-package.ts
packages/agent-sdk-runtime/scripts/check-source-shape.ts
packages/agent-sdk-runtime/scripts/install-pinned-pi.ts
packages/agent-sdk-runtime/scripts/manifest-files.ts
packages/agent-sdk-runtime/scripts/oxlint.json
packages/agent-sdk-runtime/scripts/pattern-validation-package.test.mjs
packages/agent-sdk-runtime/scripts/validate-api-manifest.ts
packages/agent-sdk-runtime/scripts/verify-publish.ts
packages/agent-sdk-runtime/src/adapters.ts
packages/agent-sdk-runtime/src/architecture-ratchets.test.ts
packages/agent-sdk-runtime/src/capabilities.ts
packages/agent-sdk-runtime/src/command-discovery.ts
packages/agent-sdk-runtime/src/compat-events.author.test.ts
packages/agent-sdk-runtime/src/connection-provider.test.ts
packages/agent-sdk-runtime/src/connection-provider.ts
packages/agent-sdk-runtime/src/engine-boundary.test.ts
packages/agent-sdk-runtime/src/first-party-mcp.secrets.test.ts
packages/agent-sdk-runtime/src/first-party-mcp.test.ts
packages/agent-sdk-runtime/src/first-party-mcp.ts
packages/agent-sdk-runtime/src/first-turn-error.test.ts
packages/agent-sdk-runtime/src/first-turn-error.ts
packages/agent-sdk-runtime/src/harness-effort.test.ts
packages/agent-sdk-runtime/src/harness-effort.ts
packages/agent-sdk-runtime/src/harness-projection.ts
packages/agent-sdk-runtime/src/index.ts
packages/agent-sdk-runtime/src/live-model-source.test.ts
packages/agent-sdk-runtime/src/live-model-source.ts
packages/agent-sdk-runtime/src/log.ts
packages/agent-sdk-runtime/src/mcp-resolver.test.ts
packages/agent-sdk-runtime/src/mcp-resolver.ts
packages/agent-sdk-runtime/src/message-page.test.ts
packages/agent-sdk-runtime/src/message-page.ts
packages/agent-sdk-runtime/src/paths.ts
packages/agent-sdk-runtime/src/permission-ceiling.test.ts
packages/agent-sdk-runtime/src/permission-ceiling.ts
packages/agent-sdk-runtime/src/provider-projection.test.ts
packages/agent-sdk-runtime/src/provider-projection.ts
packages/agent-sdk-runtime/src/public-api.test.ts
packages/agent-sdk-runtime/src/sdk-model-options.ts
packages/agent-sdk-runtime/src/session-handoff.test.ts
packages/agent-sdk-runtime/src/session-handoff.ts
packages/agent-sdk-runtime/src/session-instructions.test.ts
packages/agent-sdk-runtime/src/session-instructions.ts
packages/agent-sdk-runtime/src/session-model.test.ts
packages/agent-sdk-runtime/src/session-model.ts
packages/agent-sdk-runtime/src/session-start-store.ts
packages/agent-sdk-runtime/src/session-title.test.ts
packages/agent-sdk-runtime/src/session-title.ts
packages/agent-sdk-runtime/src/status.ts
packages/agent-sdk-runtime/src/stores/memory.test.ts
packages/agent-sdk-runtime/src/stores/memory.ts
packages/agent-sdk-runtime/src/stores/persisted-rows.ts
packages/agent-sdk-runtime/src/stores/session-start.test.ts
packages/agent-sdk-runtime/src/stores/session-start.ts
packages/agent-sdk-runtime/src/stores/sqlite.test.ts
packages/agent-sdk-runtime/src/stores/sqlite.ts
packages/agent-sdk-runtime/src/stores/subagent-store.test.ts
packages/agent-sdk-runtime/src/target.ts
packages/agent-sdk-runtime/src/test-utils/cancel-turn.ts
packages/agent-sdk-runtime/src/test-utils/class-internals.ts
packages/agent-sdk-runtime/src/test-utils/execution-binding.ts
packages/agent-sdk-runtime/src/test-utils/fake-codex-app-server.ts
packages/agent-sdk-runtime/src/test-utils/fake-pi-rpc.d.mts
packages/agent-sdk-runtime/src/test-utils/fake-pi-rpc.mjs
packages/agent-sdk-runtime/src/test-utils/fake-runtime-store.ts
packages/agent-sdk-runtime/src/test-utils/harness-state-env.mjs
packages/agent-sdk-runtime/src/test-utils/isolated-home.d.mts
packages/agent-sdk-runtime/src/test-utils/isolated-home.mjs
packages/agent-sdk-runtime/src/test-utils/isolated-home.test.ts
packages/agent-sdk-runtime/src/test-utils/pinned-pi.ts
packages/agent-sdk-runtime/src/test-utils/private-write-budget.ts
packages/agent-sdk-runtime/src/test-utils/stand-in-home.d.mts
packages/agent-sdk-runtime/src/test-utils/stand-in-home.mjs
packages/agent-sdk-runtime/src/test-utils/vendor-traffic.mjs
packages/agent-sdk-runtime/src/test-utils/windows-argv-recorder.ts
packages/agent-sdk-runtime/src/test-utils/workspace-directory.ts
packages/agent-sdk-runtime/src/thought-level-option.test.ts
packages/agent-sdk-runtime/src/title-generation.ts
packages/agent-sdk-runtime/tsconfig.build.json
packages/agent-sdk-runtime/tsconfig.json
packages/opencode-server-adapter/package.json
packages/opencode-server-adapter/src/adapter.test.ts
packages/opencode-server-adapter/src/adapter.ts
packages/opencode-server-adapter/src/config.ts
packages/opencode-server-adapter/src/errors.ts
packages/opencode-server-adapter/src/index.ts
packages/opencode-server-adapter/src/package-boundary.test.ts
packages/opencode-server-adapter/src/provider.ts
packages/opencode-server-adapter/src/sse.ts
packages/opencode-server-adapter/src/stream.test.ts
packages/opencode-server-adapter/src/translate.test.ts
packages/opencode-server-adapter/src/translate.ts
packages/opencode-server-adapter/src/turn.ts
packages/opencode-server-adapter/tsconfig.build.json
packages/opencode-server-adapter/tsconfig.json
```

## Risks

An atom this large can compile yet misorder a store append and SSE publication; the wire corpus must compare all three read paths. A second broker over one store would retire live asks. Owner-scoped credentials and first-party MCP are security boundaries, especially for remote ACP and shared turns. Restart can recover a binding while an old process still owns its generation; launch reconciliation and fencing must complete before attach. P2 branches are concurrent, so the final exact deletion manifest and import inventory must be regenerated at the integration commit. The plan's `agent-runtime-contract` budget already has little room for P4's 458 contract lines (`docs/plans/2026-09-24-002-refactor-harness-rebuild-plan.md:1280`), so P4 must remove obsolete code or bring an exact measured budget ruling; it must not quietly raise a ceiling.

## Questions for the reviewer

1. **G1/G6 config preview:** approve a contract result `{options,resolvedModel?}` plus requested-model input (recommended), or a documented host derivation from `config.read`?
2. **G2 `/compact`:** send the harness compact command as a normal turn (recommended where listed), or hide `/compact` for every harness until a dedicated operation exists?
3. **G3 subagents:** approve a broker-owned admission API with persistence-only `BrokerPorts` (recommended), or retain the present policy-bearing store port and revise P3's requirement?
4. **G5 capabilities:** approve a checked host projection from `TransportCapabilities` to the current wire (recommended), with any missing source added to the contract, or change the public wire in a separate approved slice?

## Rulings

1. **G1 and G6, config preview.** Both routes, `GET /api/wr/harness-config-options` for a draft and `GET /session/:id/config-options` for a session, take `?model=` and return `{options, resolvedModel?}`. The contract carries both:
   - `options(target: ConfigPreviewTarget, mode): Promise<ConfigOptionsPreview>`;
   - `ConfigPreviewTarget` is `{ session: HarnessSession; model?: ModelRef }` or `{ draft: DraftLaunch }`. A draft previews its own `model`. A session previews `model` when given, and its current model otherwise;
   - `ConfigOptionsPreview` is `{ options: readonly AgentConfigOption[]; resolvedModel? }`, in the wire's own type;
   - `ConfigTarget` stays as it is for commands and agents.

   Every transport implements the new signature, and the routes return the result unchanged. It lands before step 3, once the P2 transports are merged.
2. **G2, commands.**
   - A listed command runs as an ordinary turn whose prompt is `/name [args]`.
   - A transport lists only the commands it executes that way. Where the harness needs a native call (Codex's compact, for example), the transport translates the prompt into it.
   - The app's `/compact` sends that turn when the session's command list includes `compact`, and isn't offered otherwise (H-12).
   - `POST /session/:id/command` stays 501.
   - The rule goes into `src/contract/README.md`.
3. **G3, subagents.** Approved as recommended, and already built on `hv2/p3-ports`: the rules live in `harness/src/broker/subagents/admission.ts`, and the store only persists. That branch is this slice's base, and step 3 deletes `agent-sdk-runtime/src/subagent-admission.ts`.
4. **G5, capabilities.** Approved as recommended.
   - One host function projects `TransportCapabilities` to the public `HarnessCapabilities`.
   - A test fails when a public field has no contract source.
   - A missing source is added to the contract before step 3.
   - The wire doesn't change.
5. **G4, composition.** Correct: step 1's merge of the P2 transports waits for their lanes. Composition work that doesn't depend on them starts now.

### Run 2 status on this branch

**Observed:** `createHarnessServices` is prepared in `packages/workspace-runtime/src/harness-services.ts:62`. It binds the host's launch ownership to `spawn`, the workspace transcript resolver to `transcripts`, the supplied host clock and logger, a two-worker bounded pattern evaluator, and a first-party MCP entry only when `locality` is `local` (`:67`–`:79`). No production caller selects it yet. The native Pi registry row is present (`packages/harness/src/registry/table.ts:13`–`:18`), and both custom providers validate the descriptor revision and enabled state before invoking an injected constructor (`packages/harness/src/registry/providers/types.ts:36`–`:46`). Their validation, projection and secret-binding hooks remain in the registry.

**Unfinished:** The constructor injection point has no production caller on this base. A real transport constructor must be composed from `workspace-runtime` after the registry and transport entrypoints are made public in an owned harness package manifest; a direct source import crosses `workspace-runtime`'s `rootDir` and fails typecheck. ACP's published `scripted` command and Pi's dynamic `get_commands` list have not yet been proven to execute by the `/name [args]` prompt rule; Codex lists no commands on this base (`packages/harness/src/transports/codex-app-server/capabilities.ts:14`). The Claude, Cursor, OpenCode wrapper and store-backed ports remain in their lanes. G4 stays open; this run has made no production redirection.

**Inventory and manifest rerun:** The three shell blocks above were rerun on this branch. They returned `199 imports/re-exports in 126 production files`, `361 kept invariant cases from 62 P3-removed test files`, `P3 source paths: 294` and `P4 residual package paths: 142`. The printed rows matched the inventories above exactly; this run changes no old-package import, invariant-map row or deletion candidate. The orchestrator must rerun them again at its integration commit after merging concurrent lanes.

### Run 3 status on this branch

**Observed:** `@claxedo/harness/compose` constructs the merged ACP, Pi and Codex transports through one exported entrypoint. The registry core still imports no transport. A `workspace-runtime` test imports that package export and starts each against a scripted peer; disabled and stale descriptors and an unresolved secret are refused. `createHarnessServices` now accepts the host's `patternEvaluator` as an input, preserving the single process-wide worker pool for the later host move. The shared command case runs `/scripted` through ACP and `/conformance-ui` through Pi; Pi omits the pinned package's inline `llama` command, which this case does not prove. Codex exposes no command list.

**Blocked on ownership:** The harness checker assigns the new `src/compose.ts` its own budget part, but `packages/harness/budget.json` is outside this lane's owned paths. `bun run --cwd packages/harness check` reports `src/compose.ts:1 budget: Add a reviewed budget for compose.ts to budget.json`. Importing `@claxedo/harness/compose` from the workspace test exposes an ACP `Readable.toWeb` cast error at `packages/harness/src/transports/acp/connection.ts:126` under workspace-runtime's DOM lib; that file is owned here only for command filtering. No production path selects the new composition, and G4 still awaits the Claude, Cursor and OpenCode lanes plus `p3-ports`.

**Inventory rerun:** The three shell blocks in this document each exited zero on the current worktree. Their complete outputs match the saved lists byte for byte: `199 imports/re-exports in 126 production files`, `361 kept invariant cases from 62 P3-removed test files`, `P3 source paths: 294`, and `P4 residual package paths: 142`. The rerun precedes the orchestrator's next commit and concurrent lane merges.

### Run 4 status on this branch

**Observed:** `createHarnessComposer` now constructs `ClaudeSdkTransport` and `CursorSdkTransport` for native registry records (`packages/harness/src/compose.ts:47`–`:51`). Its reviewed budget is the measured 58 lines (`packages/harness/budget.json`). The workspace composition test starts ACP, Pi and Codex against its scripted peer, starts Claude through the export, and constructs Cursor. This is a partial factory proof: Claude's `start` records the binding without launching a model process (`packages/harness/src/transports/claude-sdk/index.ts:69`–`:81`), and Cursor requires a scripted SDK HTTP backend to complete `start` (`packages/harness/src/transports/cursor-sdk/index.ts:91`–`:115`). No production path selects this composition. OpenCode remains outside the composer until its lane merges. G4 therefore remains open.

**G5 source audit:** `wireAgentCapabilities` and `wireConnectionCapabilities` are the existing projection owner (`packages/harness/src/capabilities/wire.ts:11`–`:33`). They copy `modelSelection`, requests, todos, commands, fork and subagents from `TransportCapabilities`. `harness` comes from the caller's selected session harness. The public `goals`, `effortLevels` and `instructionChannel` fields of `HarnessCapabilities` need direct copies from the contract when the host projection is completed. These fields still have no contract source and must fail closed until the P3 contract commit:

| Public field | Proposed contract source | Values observed in today's old adapter for Claude, Codex, Cursor, Pi, ACP | Current projection problem |
| --- | --- | --- | --- |
| `abort` | Per-session cancellation support, with child-session restriction | `true` for each root; ACP child `false` | `context.abort ?? true` invents a value. |
| `reconnect` | Lifecycle reconnect capability | `false` for each | Hard-coded `false`. |
| `replay` | History replay capability | `true` for each | Hard-coded `true`. |
| `revert`, `unrevert` | History mutation capabilities | `false`, `false` for each | Hard-coded `false`. |
| `configOptions` | Per-target config preview capability | `true` for each root; ACP child `false` | `configOwner === "harness"` is ownership, not availability; it reports `false` for Claude, Codex, Cursor and Pi even though their old adapter reports `true`. |

The values come from `packages/agent-sdk-runtime/src/harnesses/shared/sdk-runtime-capabilities.ts:15`–`:28` and `packages/agent-sdk-runtime/src/harnesses/acp/capabilities.ts:25`–`:39`; they are observed old-wire behavior, not a proposed default for the new transports. None of the six fields has a declared value in the ACP, Pi, Codex, Claude or Cursor `TransportCapabilities` today. Contract additions for these sources are explicitly deferred by the Run 4 ruling. The 195 transport and broker `KEEP` rows in the relocation appendix are not yet marked: porting them requires separate tests of the new implementation; an old test with the same title is not proof.

**Inventory rerun:** The three command blocks above exited zero. The import inventory now reports `209 imports/re-exports in 132 production files`; its full output above was replaced with this branch's actual rows. The kept invariant and deletion manifests remain byte-identical at `361 kept cases from 62 P3-removed test files`, `294 P3 source paths`, and `142 P4 residual package paths`. The inventory changed after merging `p3-ports` and the Claude/Cursor lanes; this composition edit does not import any retiring package.

### Run 6 status on this branch: the P3 contract commit

**Observed:** the contract now states, and every transport implements, the rulings and the review's contract findings. No production path switches; the old adapters and the host are untouched.

- **G1/G6:** `ConfigOperations.options(target: ConfigPreviewTarget, mode)` returns `ConfigOptionsPreview = { options, resolvedModel? }` (`packages/harness/src/contract/transport.ts`). `resolvedModel` is derived once, in `contract/config-options.ts` (`configOptionsPreview`), from the model select's `currentValue` and the label the harness published, which is the old adapter's `resolvedModelFromConfigOptions` rule. Claude and Codex preview a requested session model; ACP ignores a requested model as its old adapter did and now maps its select choices to `selectOptions` so a current model resolves; OpenCode's option carries no current value and previews without one. The routes' `{options, resolvedModel?}` shape is the contract's own type.
- **G5:** `capabilities/wire.ts` projects from `TransportCapabilities` plus the transport's operation groups through a `sources` table typed over the public keys, so a public field without a source fails to typecheck (`capabilities/README.md`). `abort` is the host's per-session fact and the projection throws without it; `configOptions`, `commands` and `fork` are the presence of the `config`, `commands` and `fork` groups; `replay` follows `history`; `reconnect`, `revert` and `unrevert` are false in one place because the contract has no such operation.
- **`spawn`'s signal:** `SpawnOptions.signal` is required. A spawn whose signal is already aborted, or aborts before the process is handed back, rejects and leaves nothing running (`workspace-runtime/src/spawn-service.ts`, the conformance test services). ACP passes its startup abort, Claude the SDK's spawn signal, Codex and Pi a transport-lifetime signal aborted by `dispose`, and the ACP draft probes the same.
- **Provider-turn identity:** `ProviderTurnResult` carries the admitted `turn: TurnRef` and the run receives it; the real port mints `turnId === assistantMessageId` and drains under it. Claude's native goal translates and meters under the admitted assistant message instead of the session id.
- **A:** `HarnessSession.binding` is `Readonly`, `SessionBroker.rebind` returns the frozen binding the store now holds, and every transport builds its session from that value; the runner reads the committed binding before each call, as the host will (`contract/README.md`, Sessions).
- **B:** `TurnInput.prompt` is `TurnPrompt = Omit<PromptInput, "model" | "variant" | "system">`; transports read only `model`, `effort` and `system`. Claude and Codex no longer fall back to the start or config model, OpenCode refuses a turn without a resolved model, and `flattenTurnPrompt` names whether the system block rides in the prompt (`prefix`) or in the harness's own channel (`channel`, Claude).
- **C:** `steer`, `fork`, `agents` and `commands` left `TransportCapabilities`; the operation groups are the fact. `goals` stays a `GoalCapabilities` and the conformance suite asserts `goals.implemented` equals the group's presence for every transport.
- **AA:** `contract/README.md` (Turns) states that a turn the transport cannot run or finish throws from `send`'s iterator, never as an `error` event, and that an `error` event is only the harness's own reported outcome. `runOpenCodeTurn` rethrows. Each conformance backend supplies an `unrunnableTurn`, and the shared case asserts the rejection and the absence of `error` events for all six transports.
- **H:** `RequestBroker.closeSession(sessionId)` clears the session's accepted URL consents (`broker/requests/url-consent.ts`, keyed by session).
- **V:** `registry/table.ts` maps every `AGENT_HARNESS_IDS` entry, so `opencode` is a native row with `opencode-sdk`, and `compose.ts` constructs `OpenCodeSdkTransport`; `workspace-runtime/src/harness-compose.test.ts` starts it in-process through `@claxedo/harness/compose`.

**Not in this run:** T, W, the translator move and the switch (the parity wave); the scripted backends' single home for `e2e/` and `./testing`.

**Inventory rerun:** unchanged from run 4; this run adds no import of a retiring package.

### Run 7 status on this branch: step 2, the translator move

**Observed:** the five vendor translators moved as they were from `agent-event-runtime/src/harnesses/{acp,claude,codex,cursor,pi}` into `packages/harness/src/transports/{acp,claude-sdk,codex-app-server,cursor-sdk,pi-rpc}/translate/`, with their tests and fixtures; the translation runner (`createAgentEventRuntime`, `translateRawHarnessEvent`), the adapter contract, `tool-attachments`, `tool-display` and `host-subagent` moved into `packages/harness/src/translate/`; the cross-translator tests and the translator corpus test live in `src/conformance/translate/` (the corpus recordings stay in `src/translate/corpus/`). `@claxedo/agent-event-runtime` keeps the event contracts, the snapshot helpers (`core/state`, `core/projection`), `value.ts` (now exported from its root, since the projection and the translators share it) and the projections; its `./harnesses/*` exports, build entries, the Codex protocol generator and its four vendor SDK dependencies are gone. The generator lives in `packages/harness/scripts/generate-codex-protocol.ts`, writes `src/transports/codex-app-server/translate/protocol/` (gitignored there), and the root `lint` and `typecheck` scripts and the turbo build output run it in the harness.

**Importers changed in the same commit:** every harness transport imports its translator relatively (`./translate`) and the runner from `../../translate/runtime`; Claude's transport module `translate.ts` became `events.ts`, the name its siblings use, so the folder name is unambiguous. The old drivers in `agent-sdk-runtime` and the app's `e2e/fixtures/generate-harness-fixtures.ts` import `@claxedo/harness/translate` and `@claxedo/harness/<kind>/translate` (new explicit subpath exports, kept until step 3 deletes the old drivers); `agent-sdk-runtime` gained the `@claxedo/harness` dependency and `claxedo-app` the dev dependency, and the app's e2e project aliases those subpaths to source like its other workspace entries.

**Checker:** `scripts/check.ts` holds the moved translator folders and `src/conformance/translate/` to the boundary, swallowed-error, polling, state and table rules, but not to no comments, size or no policy in transports, until P6 trims each translator (`README.md`); the three module-level constants and the one sequence they carry are named owners in `AGENTS.md`. Transport budgets are the measured totals after the move: acp 3013, claude-sdk 2753, codex-app-server 2791, cursor-sdk 1652, pi-rpc 864.

**Step 3 and later:** not started in this run. The tree builds, typechecks and runs the translator corpus green with no production path switched; the report names the stopping point.

**T-11, taken in the same run:** one Codex and one Claude Code for the repository. `e2e/harness/config.ts` pins `CODEX_VERSION` 0.156.1 and `CLAUDE_CODE_VERSION` 2.1.283 next to `PI_VERSION`; the harness `@openai/codex` dev dependency (the protocol generator's source) is the same 0.156.1, and `protocol-pin.test.ts` asserts the two agree with the sandbox `Dockerfile` and `vercel.ts`. 0.133.0 refused `thread/backgroundTerminals/list` and `terminate` as unknown methods; 0.156.1 routes both, which the transport's Stop and pause path needs, so the Codex conformance now asserts `verified_clear` cleanup with the list and terminate frames on the wire. The flows' daemon receives `CODEX_EXECUTABLE` and `CLAUDE_CODE_EXECUTABLE` from `isolated-env.ts` (the pinned packages' bins under `e2e/.artifacts`, installed by `pinned-codex.ts` and `pinned-claude.ts`), the fault fixtures wrap those bins and hand the wrapper to the daemon as `codexExecutable`, `claudeExecutable` or `piExecutable`, and no fixture resolves a harness through `which` or PATH order. The Claude conformance spawns `PINNED_CLAUDE`. The wire corpus normalizes `claude_code_version` and calendar dates, so the pins changed no recorded bytes.


### Run 8 status on this branch: step 3, the atomic switch

**Observed:** the runtime host lives in `workspace-runtime/src/host/` and drives every harness through one `HarnessTransport` from `@claxedo/harness/compose`. `workspace/transports.ts` composes a native harness by its registry row, OpenCode included, and a connection by its descriptor, directory and secret lease; nothing branches on a transport's class. Session tools are the contract's optional `sessionTools` operation group, which OpenCode implements; a harness without it gets the scoped-tool prompt. One request broker per store answers every ask; `endTurn`, `endStart` and `closeSession` run at turn end, start end and session delete. A superseded transport is disposed only once the turns admitted on it end, and cancel and steer reach the transport running the turn; shutdown disposes every transport first. A configuration push the harness refuses fails the apply, and a held push refused after its turn fails the apply status. An attach that finds its ACP session gone persists the `missing-session` handoff, the next turn carries it, and the host marks that turn with the context-rebuilt notice. An ACP turn failure carries `acpOutcome` (and `recovery` when uncertain) on the assistant error record through `TransportError.detail`, and a dead ACP peer is restored before the next turn.

**Removed:** every old adapter and driver under `agent-sdk-runtime/src/harnesses/`, `agent-sdk-runtime/src/subagent-admission.ts`, the OpenCode server adapter's adapter, SSE and translator, `workspace-runtime/src/opencode/harness-adapter.ts`, the `agent-sdk-runtime → @claxedo/harness` dependency, the translate subpath exports, the `isMovedTranslator` exemption with its fixture and README paragraph, every translator comment, the `CODEX_EXECUTABLE` override (the flows' daemon resolves the pinned Codex on a PATH its directory leads), `./opencode-sdk/*`, the duplicate `./testing` re-export of the OpenCode fixtures, the event-hub and MCP-resolver forwarding modules, and `FIRST_PARTY_MCP_CONFIG_KEY`.

**Open:** the harness check reports 34 translator findings (size and title conditions), each a P6 trim row in the plan. Custom OpenCode providers do not reach the transport's engine until T lands (`claxedo-local-server/src/credentials/opencode-custom-provider.test.ts`). The merge of integration waits for a commit of this diff.
