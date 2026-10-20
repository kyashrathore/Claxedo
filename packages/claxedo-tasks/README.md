# @claxedo/tasks

The Tasks plugin, a first-party plugin with its id, `claxedo-tasks`, reserved in `FIRST_PARTY_PLUGIN_IDS`. It holds everything Tasks is: the rules, the store ports and their SQLite and D1 stores, the HTTP routes and their client, the agent tools, the host code each server composes, and the app entry the app ships as a bundled plugin. The hosts (the desktop's local server, the hosted Worker, the sandbox's workspace runtime, the app) gain only generic extension points and keep no Tasks code. Every product entry that serves Tasks composes this package; one that does not composes nothing of it.

## What Tasks is

- **Task**: a project's unit of work, with a title, a Markdown description, a status (`backlog`, `todo`, `doing`, `needs_you`, `done`), up to `TASKS_BOUNDS.taskAttachmentsMax` images, and archived or not. A task is created only as `backlog` or `todo` (`TASK_CREATE_STATUSES`); the other statuses are reached by working on it. Children go one level deep: a child of a child is refused. Every write is a command (`commands.ts`) carrying a client request id, which replays its committed answer once and refuses a different command under the same id, and a write names the revision the caller last read, so a stale write is refused with `stale_revision` rather than lost.
- **Preset**: a person's reusable how and where for an agent: a name, Local or Cloud, instructions, whether agents may start it, and up to four configuration slots (`primary`, `planning`, `implementation`, `review`), each a harness, model and effort; a Cloud preset also names Marketplace plugins and skills. A Cloud preset naming a harness that runs in its own session host is refused (`cloudPresetHarnessRefusal`).
- **Session link**: one session a task's Start created, by slot and attempt. Its liveness (`live`, `archived`, `deleted`, `unavailable`) and handoff (`sent`, `pending`, `unknown`) are read from the host at detail time, never stored as truth.
- **Start** (`start.ts`): a preview resolves what a (task, preset, slot, attempt) would start and its `digest`; the start recomputes it and refuses a digest that moved. A Cloud start creates the task's own cloud workspace and answers `preparing` until it runs, and the same request is sent again to create the session.

## Subpaths, by host role

| Subpath | What | Composed by |
| --- | --- | --- |
| `.` | The host-agnostic kit: contracts, bounds, commands, decoders, paging, the store, authorization, clock, id and session-bridge ports, the task and preset services | every subpath below |
| `./http` | `createTasksRoutes`, mounted at `/api/claxedo/tasks` | `./local`, `./hosted` |
| `./client` | `TasksClient` over a fetch, as the app entry and the agent tools call the routes | `./app`, `./mcp` |
| `./mcp` | `TASKS_MCP_TOOL_GROUP`: `task_list`, `task_get`, `task_create`, `task_edit`, `task_start`, reached through the `tasks` MCP service grant | every server plugin |
| `./host/*` | Host code the local and hosted compositions share, one specifier per module: authorization, the capability and its operations, agent-start gates, the session bridge core, session grants, the runtime environment names (`WORKSPACE_RUNTIME_TASKS_*`) | `./local`, `./hosted`, `./runtime-host` |
| `./storage/sqlite` | `sqliteTasksStore` and `TASKS_SQLITE_SCHEMA`, whose journal is `src/storage/sqlite/claxedo-tasks-migration/` | `./local`, the desktop's build scripts |
| `./storage/d1`, `./storage/d1/schema` | `createD1TasksStore`, and `TASKS_D1_SCHEMA_DIR`, this package's part of the control plane's D1 baseline | `./hosted`, `claxedo-server/scripts/control-plane-schema.ts` |
| `./local` | `createLocalTasksPlugin({ enabledGroups })`: a `LocalServerPlugin` with the routes, the SQLite schema, the MCP group and the `tasks` service grant | `claxedo-desktop/src/server/entry.ts`, the e2e daemon entry |
| `./hosted` | `createHostedTasksPlugin(ports)`: a `HostedServerPlugin` with the routes, the MCP group and the cloud-root grant (`rootGrants`, group `tasks`) | the Agent Plugins Worker entry, through `claxedo-server/src/deployments/hosted-workerd/tasks-plugin/compose.ts` |
| `./runtime-host` | `tasksRuntimeHostPlugin`: the sandbox runtime's `tasks` service grant from its environment | `claxedo-server/src/hosts/workspace-runtime/host-entry*.ts` |
| `./conformance`, `./test-support` | The store conformance suite and test doubles | tests |

The app entry is not an export: `src/app/index.ts` is named by the `claxedo` manifest block in `package.json`, and only `claxedo-app/vite.plugin-bundles.ts` reads it, so no app source imports it. `src/app/README.md` describes it: the transcript cards, Settings → Presets and the Tasks page, all drawn as A2UI surfaces through the plugin API.

## Rules the code keeps

- **Dependency direction.** This package imports only the host contracts (`@claxedo/plugin-api`, `@claxedo/server-core`, `@claxedo/mcp/tool-group`, `@claxedo/helpers`, `@claxedo/agent-runtime-contract`), never a server, the app or a CLI, and no core package imports it. `script/first-party-plugins.test.ts` enforces both, with the exact list of composition roots and host adapters that do import it.
- **Persisted contracts.** The SQLite migration names and their global order, the D1 tables, the MCP group id `tasks`, the tool names and the `WORKSPACE_RUNTIME_TASKS_*` names are unchanged from when this code lived in the hosts. `src/storage/sqlite/claxedo-schema.test.ts` pins the applied names and the `sqlite_master` rows; `claxedo-server/src/authority/adapters/d1/control-plane-schema.test.ts` pins the combined D1 baseline.
- **Bundle closure.** The app entry is measured by the product-boundary policy `tasks-app` (`script/product-boundary/policies/tasks.ts`, `bun run verify:closure` here): it may not reach the app, a server, `@claxedo/server-core`, `@claxedo/mcp`, `hono`, `drizzle-orm`, `better-sqlite3`, or this package's routes, tools and stores.

## Tests

`bun run test` runs the kit, store, host, route, tool and app-entry tests under Bun. Tests that drive a real host stay with that host: `claxedo-local-server/src/app/tasks-plugin.test.ts` and `tasks-session-bridge.test.ts`, and the workerd and composition tests in `claxedo-server/src/deployments/hosted-workerd/tasks-plugin/`. Flows 12, 36, `63-tasks-board` and `63-tasks-presets` cover the app entry end to end.
