# Plan 003 (OpenCode v2 on workerd) versus Project Think: architecture, layer by layer

Date: 2026-09-05. Sources: `anomalyco/opencode` branch `v2` and the published `@opencode-ai/sdk@dev` build; `cloudflare/agents` at `main` and `@cloudflare/think` 0.17.0; the evaluations of [OpenCode v2 workerd](./opencode-v2-workerd-evaluation-2026-09-05.md) and [Project Think](./project-think-evaluation-2026-09-05.md). Owner ruling recorded in the Think evaluation: Claxedo is a layer over harnesses and does not own harness internals. This document is the architectural record behind that ruling, not a reopening of it.

## 1. Two answers to the same job

Both put an agent in a Cloudflare Durable Object with SQLite, hibernate it between events, and reach a machine only when needed. They differ in who the agent is.

- **OpenCode v2 workerd** is a complete coding harness whose upstream added a runtime profile that runs inside a Durable Object. The agent, its tools, its session model, its compaction and its recovery are upstream code. The adopter composes a host and supplies bindings.
- **Project Think** is a base class for writing an agent on Cloudflare's Agents SDK. Sessions, memory, durable execution, workspace and sub-agents are upstream primitives. The agent is the adopter's subclass.

## 2. Component by component

| Layer | OpenCode v2 workerd | Project Think |
|---|---|---|
| Object model | One `OpenCodeWorkerd` host per Durable Object, many sessions inside, created once under `blockConcurrencyWhile`. Object per tenant is the documented shape. | One Durable Object per agent instance, routed by name through `routeAgentRequest`. An agent is a conversation. |
| Client protocol | HTTP API under `/api/...` served by the object's in-process fetch; `@opencode-ai/client` speaks it; events over `/api/event` with `after` cursors on a durable event history. | WebSocket chat protocol with stream resumption; `useAgentChat` from the React package; RPC for sub-agents; HTTP `onRequest` for everything else. |
| Session store | Drizzle over DO SQLite. Sessions, messages, parts, durable events, durable inbox rows, workspaces. Event-sourced: a projector materializes read models from committed events. | `cf_agents_session_messages` with `parent_id` and `seq` (a tree with one active leaf), `cf_agents_session_compactions` as overlays, `cf_agents_session_config`, an FTS5 virtual table, attachment chunks. |
| Turn execution | `SessionInbox` admits input as a durable row. `SessionExecution.resume` starts or joins the session's execution through `SessionRunCoordinator`: one fiber per session that drains until idle, with a doorbell so work recorded mid-drain restarts the drain instead of racing the idle transition. The runner calls the model through the Vercel AI SDK provider set and tools through `Environment`. | `chat()` assigns a request id and abort signal, then runs the turn inside `runFiber`. The loop is `streamText` with `prepareStep` (`beforeStep`), `maxSteps` default 10, `stopWhen`. Tools are AI SDK tools; actions are a typed superset with permissions, approval and idempotency. |
| Write-ahead and recovery | An execution claim is written in the same transaction as the started event. Terminals release it; shutdown preserves it on purpose. `SessionRestart.resumeSuspendedSessions` runs at boot, forked so it never delays the handler, replays the drain from durable history, and terminalizes after ten attempts per turn. At-least-once by design. | `stash()` writes a snapshot to SQLite synchronously during the turn; `keepAlive` holds off eviction while working. On wake the SDK evaluates recovery budgets before `onStart`, may seal an interrupted turn, and calls `onChatRecovery` or `onFiberRecovered` with the snapshot. The original lambda is not replayed; the handler decides. |
| Side-effect safety | Recovery is at-least-once; the shell tool and subagent jobs are the places that can repeat. Nothing at the tool layer deduplicates. | Action ledger: each action call is claimed with an idempotency key; claims resolve as replay, pending, reclaimed or conflict; settled results are replayed without re-running the side effect; a sweep ages out rows. Approval can pause an action or a codemode execution until `approveExecution`. |
| Compaction | Upstream `session/compaction.ts` with config and events. | Non-destructive overlays keyed by message range; the adopter registers the summarizer through `onCompaction`; `compactAfter(tokens)` gates it. |
| Memory | None built in. A plugin's `session.context` hook plus an external store. | Context blocks: writable, skill and search providers; model-facing `set_context`, `load_context`, `search_context` tools generated from block types; token limits per block. |
| Tools without a machine | Upstream `read`, `edit`, `write`, `grep`, `glob`, `shell`, `patch`, `webfetch`, `websearch`, `question`, `skill`, `subagent` over `makeMemoryDriver`; `shell` fails until a workspace is attached. | Workspace tools over `@cloudflare/shell`: `read`, `write`, `edit`, `list`, `glob`, `grep`, `delete` on a durable SQLite plus R2 filesystem; `just-bash` virtual shell; `isomorphic-git` clone, commit and push. |
| Reaching a machine | `WorkspaceDriver`: `create`, `connect`, `suspendForIdle`, `destroy`; `connect` returns a spawner and `execDefaults` runs file operations over it; the session's tools execute on the machine with no file sync. Adopter implements the driver. | `createSandboxTools` is an unimplemented stub. The post's bidirectional sync between Workspace and sandbox is not in code. Adopter builds the whole machine path. |
| Code execution without a machine | None. | Dynamic Worker executor for model-written JavaScript with npm resolution; closed beta. |
| Sub-agents | `SubagentJob` runner with completion delivery to the parent; child sessions in the same host. | Facets: co-located child objects with isolated SQLite and typed RPC; `runAgentTool` and detached runs with milestones. |
| Extensibility | Precompiled `Plugin.define` plugins in process; skills; remote MCP. | Adopter code in the subclass; LLM-authored extensions loaded through Dynamic Workers, closed beta; skills; MCP client and server in the Agents SDK. |
| Channels and scheduling | None in the harness. | Messengers over the Chat SDK with Telegram shipped, email, schedules, workflows. |
| Model access | Provider `baseURL` and key in OpenCode config; any Vercel AI SDK provider. | `getModel` returns a Workers AI slug via AI Gateway or any AI SDK `LanguageModel`. |
| Portability | The same core runs on Node and Bun; workerd is one profile. | Agents SDK base class; workerd only. |
| Evidence under workerd | Bundle probe upstream; no execution test found. | Recovery e2e tests in the repository: chat, tool rollback, stall, context overflow, submission, action ledger, workflow, messenger. |
| Maturity | Beta on the `dev` dist-tag, Effect 4 release candidate, continuous builds. | 0.17.0, experimental, "will continue to evolve in the coming days and weeks." |

## 3. One turn, traced

### OpenCode v2

1. The app posts to `/api/session/:id/message` on the tenant's object. The object's `fetch` forwards to the host's in-process handler; no network leaves the isolate.
2. `SessionInbox` admits the message as a durable pending row and rings `SessionExecution.wake`.
3. `SessionRunCoordinator` starts one execution fiber for the session key or joins the active one. The write-ahead claim and the started event commit in one transaction.
4. The runner promotes the inbox row into a projected user message, builds context from the session's messages and compaction entries, and streams the model through the provider. Steering input admitted mid-run is promoted at the next step boundary.
5. Tool calls resolve through `Environment`: the memory driver when the location has no workspace, the `WorkspaceDriver` spawner when it does. `shell` writes output to a file on the host filesystem and pages it back.
6. Every event is persisted; the projector materializes messages and parts; clients read `/api/event` with an `after` cursor.
7. On idle with no doorbell, the execution settles and the claim is released. If the isolate is evicted mid-turn, the claim stays; the next boot's sweep resumes the drain.

### Think

1. A WebSocket message or HTTP request reaches the agent's object through `routeAgentRequest`.
2. `chat()` mints a request id, links the abort signal, and runs the turn in `runFiber`. `keepAlive` holds the object while the turn works.
3. `beforeTurn` assembles the turn; `beforeStep` runs as `prepareStep`; `streamText` iterates up to `maxSteps`.
4. Tool calls run as AI SDK tools. An action first claims its ledger row by idempotency key; a settled row replays; a pending row from a previous life is reclaimed; approval policy can park the action and the turn until `approveExecution`.
5. Messages persist as `UIMessage`s in the session tree; `stash()` snapshots progress during streaming; the client stream resumes on reconnect.
6. Context blocks are re-rendered into the system prompt; a writable block may have been updated by the model.
7. On eviction, the next wake evaluates recovery budgets, calls `onChatRecovery` with the stash, or seals the turn and fires `onExhausted`.

## 4. Where each is stronger

**OpenCode v2**

- Complete harness behavior for free: tools, compaction, fork, transfer, subagents, skills, MCP, permissions.
- The only upstream seam that runs a session's tools on a machine, with idle suspension built in.
- One protocol and one event format across worker and sandbox placements.
- Runs on Node and Bun as well, so self-host is not tied to workerd.

**Think**

- Side-effect safety is a first-class contract: idempotent action claims, replayable settled results, durable approval pauses. OpenCode's recovery is at-least-once with no ledger.
- Memory, search and durable workspace with git are upstream.
- Recovery is exercised by tests on the target runtime.
- Sub-agents as isolated objects rather than co-hosted sessions.
- Channels and scheduling exist.

## 5. What Claxedo writes in each

| | OpenCode v2 | Think |
|---|---|---|
| The agent | Nothing. Configuration and first-party plugins. | The subclass: prompt, tools, actions, policy hooks, memory blocks, compaction function, model choice. |
| Machine path | `WorkspaceDriver` over the sandbox manager plus an exec channel with stdin. | A tool that leases through the sandbox manager and spawns a child session in OpenCode or Pi, and any workspace-to-machine sync. |
| Credentials | Gateway; provider `baseURL` in config. | Gateway; `getModel` returns a model bound to it. |
| Client | v2 transport in the runtime client. | WebSocket chat client or the React hook. |
| Ownership consequence | Layer over a harness. | Author of a harness built from primitives. |

This last row is the ruling. Everything Think does better is bought by writing the agent.

## 6. Ops shape

| | OpenCode v2 | Think |
|---|---|---|
| Script size | 12 MB minified, 2.8 MB gzipped | Not measured; `think.ts` is 16,000 lines plus the Agents SDK |
| Object keying | Per tenant with many sessions, to amortize boot | Per agent instance by name |
| Cold start | Seconds to build the Effect layer graph, unmeasured | Unmeasured |
| Beta dependencies | None from Cloudflare; the harness itself is beta | Dynamic Workers for code execution and extensions; facets for sub-agents |
| Limits that bind | 128 MB isolate, 30 s CPU per request reset by each request, 10 GB SQLite | Same |

## 7. Bottom line

OpenCode v2 workerd is a harness that happens to run in an object. Think is an object that lets you write a harness. Think's action ledger, memory blocks and tested recovery are the better primitives; they are also the exact surface the adopter has to author against. Under the rule that Claxedo does not own harness internals, OpenCode v2 is the only bootless option, and its weaknesses, no ledger, no memory, no channels, are the things a layer adds around a harness rather than inside one.
