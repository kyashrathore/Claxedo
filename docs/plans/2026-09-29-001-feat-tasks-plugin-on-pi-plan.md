# Tasks as a hosted plugin, with work runs on Pi

Status: planned, not started. Replaces the native Tasks feature (`@claxedo/tasks` and its hosts) in one migration; nothing of the native path survives it.

## 1. What it is

A task is **a request plus what has happened since**. You write what needs doing; it can sit untouched until you start it. Once started, runs happen: a Pi agent inside the Tasks backend for work that needs no machine, or Claude Code, Codex, OpenCode or Pi on one of your machines for work that does. Nothing stores a status or a type: what the list shows is computed from facts other owners already hold.

- **Hosted only.** Tasks exists when the app is signed in to the hosted control plane. A signed-in desktop reaches it through the hosted server; an unsigned app never activates it.
- **A plugin with a backend.** The UI is an app plugin; the backend is a Workers module the control plane loads as a Dynamic Worker, with its own Durable Object storage per organization.
- **Work runs on Pi.** A task's own agent is Pi's `AgentHarness` running in the task's Durable Object. Pi owns the loop, compaction, sessions and tools; Claxedo implements Pi's published `Storage`, `ExecutionEnv` and `CredentialStore` interfaces and nothing else of Pi.
- **Machine runs on real harnesses.** Code work, and work that must spend a Claude plan, starts a normal Claxedo session on any machine the user can reach: local, another enrolled machine, or a cloud sandbox.

## 2. Owner rulings this plan implements (2026-09-29)

| Ruling | Consequence here |
|---|---|
| Tasks works only on hosted; a signed-in desktop uses it through hosted | No local or self-hosted Tasks backend. Local-only projects have no tasks. |
| Tasks is a plugin whose backend runs as a dynamically loaded Worker | New plugin-backend platform (Phase 2); Tasks is its first consumer. |
| A task can start on every machine Claxedo can connect to | Machine runs use the platform's session-start call against any placement. |
| Agent access rides the user-scoped credential Claxedo MCP already carries | No Tasks-specific capability, grant renewal or withdrawal. |
| No stored status, no stored type; both follow from the request and its runs | Stored lifecycle is only `closed` (done, dropped, expired). |
| Drawer is tabbed: Status, About, Runs, Results | Matches the reviewed prototype `~/test/claxedo-prototypes/tasks-requests.html`. |
| Claude and Codex subscriptions must be supported | Codex plan on Pi work runs; the Claude plan is spent only through Claude Code on a machine (Anthropic bills third-party harness use of a Claude plan per token as extra usage). |
| No per-user always-on sandbox | Work runs live in Durable Objects; a sandbox exists only for a machine run that asks for one. |
| Build on Pi | Work runs use Pi's `AgentHarness`. OpenCode v2's workerd profile is not used: its Worker entry exposes no environment hook, so its file and shell tools fail without a sandbox. |

## 3. Grounding

Facts the design depends on, as of `dev` `f96b7945a2`:

- **Native Tasks today:** `packages/claxedo-tasks` (4,508 production lines), `claxedo-app/src/tasks` (5,855), `claxedo-server-core/src/tasks-host` (3,348), `claxedo-server/src/tasks` (1,878), `claxedo-local-server/src/tasks` (152), and Tasks-only files elsewhere (~820): about 16.5k production lines and ~13.7k test and test-support lines.
- **App plugins today** declare `claxedo.{id,name,app,requires,server.routes,server.operations}` (`claxedo-plugin-api/src/manifest.ts`); they have no backend. `PLUGIN_CAPABILITIES` includes `"tasks"`.
- **A signed desktop reaches hosted only through `HostedAccount.run(operation)`**, a closed operation set in `@claxedo/account-contract` crossed through Electron main.
- **Hosted has no Worker Loader binding and no Durable Object alarms.** `@claxedo/wakes` and its Durable Object lane were deleted on 2026-09-29.
- **Hosted credentials already store a Codex plan login** as an OAuth credential with no key (`claxedo-server/src/credentials/worker/pi.ts`).
- **Pi 0.85.1 is pinned** (`packages/harness/e2e/.artifacts/pi`); Pi 0.87.1 is published.

Measured in scratch Workers on local workerd (wrangler 4.114, `nodejs_compat`, compatibility date 2026-07-29), with Pi's scripted `faux` model and no network model call:

| Proof | Result |
|---|---|
| Pi `Agent` loop in a Durable Object | Tool call and final answer; 4 ms per turn excluding model time |
| Pi `AgentHarness` in a Durable Object | `status: "completed"`; session entries assistant → toolResult → assistant → user |
| Pi's `write` and `read` tools over `@cloudflare/shell` `Workspace` | File stored in the object's SQLite; read back in a later request; absent in another task's object |
| Bundle with Pi core, Anthropic and Codex providers, `@cloudflare/shell` | 1.85 MB, 340 KB gzipped |

Sources: `~/test/pi-worker-spike/src/{index,harness,shell-task,workspace-env}.ts`.

## 4. Design

### 4.1 Concepts

| Concept | What it is | Owner |
|---|---|---|
| **Task** | Request text and attachments, owner, optional project, optional finish condition, headline, closed record, links to runs, child tasks | Tasks backend storage |
| **Run** | One execution for a task: a Pi work run in the task's object, or a machine session | Pi session in the task object; the session runtime for machine runs |
| **Wake** | When a task acts without you: a time, a schedule, a watched reply, a deadline | The task object's alarm schedule |
| **Check** | Agent-written JavaScript a wake runs before any agent: it reports a change or nothing | The task's files; executed in a Dynamic Worker |
| **Preset** | Reusable how and where: harness and model for machine runs, model for work runs, instructions, default machine | Tasks backend storage |
| **Files** | The task's folder: plans, reports, ledgers, check scripts | `@cloudflare/shell` `Workspace` in the task object (SQLite, R2 above its threshold) |

### 4.2 What the list shows

Computed on read, first match wins, never stored:

| Shown | Rule |
|---|---|
| Closed (done, dropped, expired) | The task has a closed record |
| Needs you | A run has a pending question or permission, or a proposed plan awaits acceptance |
| Stuck | The latest run failed and no wake is set |
| Working | A run is mid-turn; **Unknown** when its machine is unreachable |
| Waiting | A wake is set |
| Not started | No run and no wake |

The kind of task shows as what it has: no wake (one-off), a watched reply on the same work (errand), a repeating wake with a finish condition (watch), a repeating wake without one (recurring), a repeating wake that creates tasks (detector).

### 4.3 Flows

**A. Capture.** New task saves the request. Nothing runs. The row shows Not started.

**B. Start.**
1. The user presses Start, choosing a preset and, for a machine run, a machine.
2. A work run: the task object opens a Pi lane with the request as its first message, the preset's instructions, the task's tools and the owner's credentials. A machine run: the backend asks the platform to start a session on that placement with the request as its first message, and links it.
3. The first run proposes the finish condition and any wakes through `task.propose_plan`. The proposal is a Needs-you item; nothing repeats until the user accepts it.

**C. Wakes.** An alarm fires in the task object. If the wake has a check, the check runs in a Dynamic Worker against the task's files; no change ends the wake. Otherwise, or on a change, the object starts a run as in B.2 and schedules the next alarm. A deadline closes the task as Expired.

**D. Changing a task.** A message to the task goes to its current run, where the agent edits the plan through `task.propose_plan`. Pause and Cancel on a wake act on the alarm directly and never go through an agent.

**E. Closing.** The agent calls `task.close` with evidence, the user presses Close as done or Drop, or a deadline expires. The user can reopen.

**F. Detectors.** A run calls `task.create` for each item it finds; each child is a task with its own runs and wakes, linked to its parent.

### 4.4 Components

**Tasks plugin (`plugins/tasks`, new first-party plugin package):**
- `app/`: the list, the tabbed drawer, New task and preset settings, on the plugin API.
- `backend/`: a Worker entry and two Durable Object classes, loaded by the platform:
  - `TasksIndex`, one per organization: task rows for listing, presets, the derived attention inputs pushed by task objects.
  - `TaskObject`, one per task: request, plan, closed record, links, alarms, the `Workspace`, and Pi.
- `tools/`: the task tools, declared once and served to Pi in-process and to machine sessions through Claxedo MCP: `task.get`, `task.note` (headline), `task.propose_plan`, `task.close`, `task.create`, `task.files.read`, `task.files.write`.

**Pi adapters (`plugins/tasks/backend/pi/`):**
- `storage.ts`: Pi `Storage` over the object's SQLite, passing Pi's `createStorageConformance` suite.
- `environment.ts`: Pi `ExecutionEnv`. Files over `@cloudflare/shell` `WorkspaceFileSystem`. `exec` answers `shell_unavailable`; code execution is the `execute` tool, below.
- `credentials.ts`: Pi `CredentialStore` that asks the platform for the task owner's access token per provider. The hosted credential store is the only party that refreshes OAuth tokens.
- `execute.ts`: an `execute` tool running model-written JavaScript through `@cloudflare/codemode`'s `DynamicWorkerExecutor` with `stateTools(workspace)` and `gitTools(workspace)`, outbound network blocked unless the preset allows hosts.

**Plugin-backend platform (`claxedo-server`, new):**
- Manifest: `claxedo.backend` (entry module, Durable Object classes, allowed outbound hosts, MCP tools the plugin serves).
- Loader: a Worker Loader binding on the hosted Worker; loads a plugin backend by content hash.
- Supervisor Durable Object: authenticates the caller (signed user, or a session's user-scoped credential), checks the plugin manifest, and forwards to the plugin's objects.
- Storage: the plugin's Durable Object classes run as facets of the supervisor, keyed by organization.
- Platform API passed to the backend as RPC stubs: `sessions.start(placement, request)`, `sessions.status(ids)` and a status subscription, `placements.list(user)`, `credentials.access(owner, provider)`, `notify(user, message)`.
- Desktop path: one hosted operation, `plugin.request(pluginId, path, body)`, added to `@claxedo/account-contract` and Electron main.
- Claxedo MCP: plugin-declared tools, exposed to sessions whose owner has the plugin enabled, forwarded to the supervisor with the session's user-scoped credential.

### 4.5 Rules

- A work run spends the **task owner's** accounts, never the sender's.
- Model requests go directly from the task object to the provider; no Claxedo proxy sits in that path.
- The Claude plan is never spent by a work run. A preset whose model is a Claude plan is a machine-run preset.
- Pi's loop, compaction, session format and built-in tools are used as published; the plugin never patches or re-implements them.
- A wake never falls back to another placement. A due machine run whose machine is offline shows "Waiting for <machine>".
- Nothing about the old Tasks storage is migrated; the service is unreleased.

## 5. Decisions before Phase 3 (recommended defaults)

1. **Who closes:** the agent with evidence, or the user; the user can reopen. *Default: both.*
2. **Automation runs create tasks:** a detector's finds become child tasks. *Default: yes.*
3. **Presets vs named bots:** a preset stays "how and where to run"; a standing responsibility is a task with a repeating wake. *Default: no separate bot concept.*
4. **Memory:** a standing task's memory is its own files. *Default: no cross-task memory in the first release.*
5. **First-party plugin UI model:** the Tasks app runs on today's plugin API in the app's JavaScript, or on the declarative-UI model of `2026-09-25-001`. *Default: today's API, since first-party plugins run in-app; revisit when 2026-09-25-001 ships.*
6. **Default placement for a machine run:** the user's primary machine. *Default: ask on first Start, remember per preset.*

## 6. Phases

Each phase ends only when its criteria pass through real entry points. Tests exercise the implementation, never a fake that agrees with itself.

### Phase 1: Pi work run, production-shaped (no platform yet)

A standalone Worker in `plugins/tasks/backend` proves one task object end to end.

- [ ] `storage.ts` passes Pi's `createStorageConformance` against the object's SQLite under workerd. Progress:
- [ ] `environment.ts`: Pi's own `read`, `write`, `edit` tools pass a suite that writes, edits, reads back in a later request, and finds nothing from another task object. Progress:
- [ ] `execute.ts` runs in a Dynamic Worker with a Worker Loader binding: reads and writes task files through `state.*`; an outbound fetch to a non-allowed host is blocked; a script exceeding its time budget is stopped. Progress:
- [ ] `gitTools`: shallow-clones a public repository into the Workspace and lists files. Progress:
- [ ] A real Codex-plan turn from workerd with a stored login: the model is called, a tool runs, the answer streams; an expired access token is refreshed through the credential adapter without the object holding the refresh token. Progress:
- [ ] Eviction: killing the object mid-turn and waking it resumes or seals the turn through Pi's open operations, verified by the session entries. Progress:
- [ ] Measured and recorded in the plugin README: cold object start, first token, memory per object during a turn, bundle size.
- [ ] Exit gate: all of the above on local workerd **and** in a deployed staging Worker.

### Phase 2: Plugin-backend platform

- [ ] Manifest `claxedo.backend` with schema, validation and `app_plugin.check` coverage. Progress:
- [ ] Worker Loader binding on the hosted Worker; a backend is loaded by content hash and cached. Progress:
- [ ] Supervisor object: a request with no credential, another organization's credential, or a route outside the manifest is refused; a valid one reaches the plugin's object. Progress:
- [ ] Facets: a plugin's `TaskObject` class runs as a facet with its own SQLite and alarms, keyed by organization. **Gate: if facets cannot host a class with alarms, stop and bring the finding to the owner.** Progress:
- [ ] Platform API: `sessions.start` on a local machine, another enrolled machine and a cloud sandbox; `sessions.status` reports running, waiting for input, failed, idle and unreachable. Progress:
- [ ] `credentials.access` returns a current access token for the task owner; two concurrent refreshes produce one refresh and both callers get the new token. Progress:
- [ ] `plugin.request` hosted operation from a signed desktop through Electron main; an unsigned app has no route. Progress:
- [ ] Claxedo MCP serves plugin-declared tools to a machine session of the plugin's user and refuses another user's session. Progress:
- [ ] A trivial first plugin with a backend (a counter object) exercises every item above end to end. Progress:

### Phase 3: Tasks backend

- [ ] `TasksIndex` and `TaskObject` storage, commands and the derived attention of §4.2, with a state-machine test per row of the table. Progress:
- [ ] Flows A–F through the backend's HTTP routes and the task tools, each with a behavior test. Progress:
- [ ] Alarms: schedules with time zones, deadlines closing as Expired, pause and cancel without an agent, one alarm per object carrying the next due wake. Progress:
- [ ] Checks: a check reporting no change starts no run; a change starts one; a check that throws is shown on the task and retried at the next wake. Progress:
- [ ] Plan acceptance: no wake fires before the user accepts; rejecting keeps the task with no wakes. Progress:
- [ ] Machine runs: a started session is linked; its status drives Needs you, Working and Stuck; an unreachable machine shows Unknown. Progress:
- [ ] Owner's accounts: a work run started by another member of the organization spends the task owner's credential. Progress:

### Phase 4: Tasks app

- [ ] The list grouped by derived attention with the rules shown, the closed fold, and summary counts. Progress:
- [ ] The drawer with Status, About, Runs and Results; the chosen tab persists across tasks; Status opens by default except for Not started, which opens About. Progress:
- [ ] New task captures without running; Start now opens preset and machine choices. Progress:
- [ ] Every Needs-you item answers inline and matches the backend's state after reload. Progress:
- [ ] e2e flows: capture → start work run → propose plan → accept → wake → check → close; start a machine run on a local machine; a detector creating two children. Progress:

### Phase 5: Remove the native Tasks feature

- [ ] Deleted: `packages/claxedo-tasks`, `claxedo-app/src/tasks` and `src/server/tasks.ts`, `claxedo-server-core/src/tasks-host`, `claxedo-server/src/tasks`, `claxedo-local-server/src/tasks`, `claxedo-mcp/src/tools/tasks.ts`, `hosts/workspace-runtime/tasks-grant.ts`, `hosted-workerd/tasks-contributions.ts`, the Tasks SQLite and D1 migrations, and their tests. Progress:
- [ ] Removed from shared files: Tasks grants in `local-app.ts`, `self-hosted-node/start.ts`, `agent-plugins/hosted-composition.ts`, `cloud-root-environment.ts`, `workspace-runtime/env.ts`; the built-in `tasks` tool group; the desktop entry wiring; `registry.ts` and the rail page. Progress:
- [ ] `encodeAttachmentData`, still used by `plugins/bindings/data.ts`, moves to its remaining owner before the package goes. Progress:
- [ ] Repository search finds no `@claxedo/tasks`, `tasks-host`, `TASKS_CAPABILITY`, `BUILTIN_TASKS_TOOL_GROUP` or `WORKSPACE_RUNTIME_TASKS_` outside this plan. Progress:

## 7. Definition of done

- [ ] A signed-in user on the web and on the desktop captures, starts, watches, answers and closes tasks through the Tasks plugin; an unsigned desktop shows no Tasks.
- [ ] A work run on the owner's Codex plan completes in the task's object with files persisted; a Claude-plan preset starts Claude Code on a machine.
- [ ] Wakes, checks and deadlines run with every client closed.
- [ ] No status or type is stored anywhere in the Tasks backend.
- [ ] The native Tasks feature is gone (Phase 5) and `bun run test:architecture-ratchets`, typecheck, and the affected packages' tests pass on the merge tip.
- [ ] The plugin's README states the architecture in present tense, and this plan is deleted from `docs/plans`.

## 8. Execution

Run phases as parallel lanes with disjoint file ownership; each lane is an Opus agent in its own worktree, and the orchestrator reviews every lane's diff before merging.

| Lane | Owns | Starts |
|---|---|---|
| Pi runtime | `plugins/tasks/backend/pi/**` | Phase 1, immediately |
| Platform: loader, supervisor, facets | `claxedo-server/src/plugin-backends/**`, hosted Worker config | Phase 2, immediately |
| Platform: desktop and MCP | `account-contract`, `claxedo-desktop/src/main/account/**`, `claxedo-mcp/src/plugins/**` | Phase 2, immediately |
| Tasks backend | `plugins/tasks/backend/**` except `pi/` | After the Phase 1 exit gate |
| Tasks app | `plugins/tasks/app/**` | Against the backend's route contract, in parallel with the backend |
| Removal | the Phase 5 file list | After Phase 4's e2e flows pass |

The facet gate in Phase 2 and the Codex-plan turn in Phase 1 are the two findings that can change this plan; both are scheduled first in their lanes.
