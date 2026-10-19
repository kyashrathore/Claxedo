# Tasks and Documents as first-party plugins

Status: planned, not started. Base: `plan/a2ui-surfaces-and-mcp-apps`. Owner rulings 2026-10-18:
- **Tasks and Documents (pages) become 100% plugins**, backend and frontend. Each lives in its own first-party plugin package: frontend, backend routes, storage, agent tools and CLI. The hosts (local daemon, hosted worker, workspace runtime, session-core, MCP, CLI, app) gain only generic extension points. Core keeps no task or document code.
- **Where they run:** in-process on desktop, local web and hosted.
- **What is kept:** existing data and tables (SQLite, D1, R2), so every persisted contract holds.
- **Not used:** the sandboxed plugin backends (`claxedo-server/src/plugin-backends/`).
- **Tasks UI:** rebuilt as an A2UI surface page in the plugin, over a catalog extended with Board/`move`, `Image`, `FilePicker` and `Combobox`/`search`. It keeps board drag-and-drop, image attachments, the harness, model and preset pickers, detail, subtasks and Start.
- **Documents:** backend move only. Its backend, agent tools, CLI and runtime hydration move into the documents plugin package.

## Summary

**Slices (each keeps the system working and removes the path it replaces):**

| Slice | What lands | Removes |
|---|---|---|
| S0 | Fresh frame mirror sent with `surface.open` (host bug) | the stale-context open |
| S1 | Composer document leftovers deleted | `/docs` command, document AtOption, `documentNotice` |
| S2 | Catalog: `change`/`submit` events on inputs, `Image`, status glyphs | — |
| S3 | Catalog: `Board` with `move` (pointer + keyboard) | — |
| S4 | Catalog: `FilePicker`, `Combobox` with debounced `search` | `src/tasks/view/image-drafts.ts` (moved into the renderer) |
| S5 | Plugin API primitives: tab pages, param routes (`navigated`), surface settings sections + `settings.open`, `sessions.open` for an unlisted session, `workspaces.followStart`, binary `server.fetch` over the web frame, `AgentConfigurationPicker` | `tasks.locateSession`; the cloud pickers move to `src/composer/` |
| S6 | Server plugin contract (`LocalServerPlugin`, `HostedServerPlugin`) and bootstrap `deployment.capabilities` | `tasksGrants` option, `deployment.documents`, `queries.tasks.availability`, `PLUGIN_CAPABILITIES` |
| S7 | MCP tool group contribution and generic service grants; tasks tools move to `@claxedo/tasks/mcp` | `ClaxedoMcpClient.tasks/documents`, the `tasks` access code, the static tasks group, `@claxedo/tasks` in `@claxedo/mcp` |
| S8a | SQLite schema contributions (multi-journal plus repair); server-core `tasks-host` and the local composition move into `@claxedo/tasks` | `claxedo-server-core/src/tasks-host/**`, `claxedo-local-server/src/tasks/**`, task migration folders in server-core |
| S8b | Hosted Tasks plus the D1 schema fragment plus generic cloud-root grants plus the runtime host contribution move into `@claxedo/tasks` | `claxedo-server/src/tasks/**`, `tasks-contributions.ts`, `hosts/workspace-runtime/tasks-grant.ts`, `BUILTIN_TASKS_TOOL_GROUP` |
| S9 | Bundled first-party plugin path; Tasks app entry registers transcript tool-card templates | the task cases in `claxedo-tool-view.ts`; `src/plugins/README.md` "bundles no plugin" |
| S10a | Settings → Presets as a plugin surface section | `src/tasks/presets/**`, `presetsSettingsSection` |
| S10b | Tasks page as a plugin surface page (list, board, create, detail, subtasks, images, start, wake progress) | `src/tasks/**`, `src/server/tasks.ts`, the hard-coded rail row and page, check entries |
| S11a | `@claxedo/documents` with runtime hydration as a route contribution; session lifecycle hooks; `contribution_write` | `workspace-runtime/src/routes/document-hydration*`, `flushSessionDocuments`/`disposeSessionDocuments`, `document_write` |
| S11b | Documents server (core, local, hosted, storage, authority) in `@claxedo/documents` | `claxedo-server-core/src/documents/**`, `claxedo-server/src/documents/**`, `local-documents.ts`, the hosted `documents` option |
| S11c | Documents MCP group, CLI command, wire operations, helpers, tool cards | `claxedo-mcp/src/tools/documents.ts`, `cli/src/commands/documents.ts`, `documents.*` in `account-contract`, `helpers/claxedo-document.ts` |
| S12 | Docs, plan index, final ratchet lowering | — |

**Top risks** (details and recommendations in "Risks and open questions"):
- R1: hosted code depends on `claxedo-server` internals, so ports must be extracted first.
- R2: SQLite journal order and the bundled journal copies; the DB must not open before plugin journals register.
- R3: D1 baseline byte identity.
- R4: bootstrap `capabilities` version skew between the hosted worker and hosted web.
- R5: Tasks visual parity once `tasks.css` (1,256 lines) goes.
- R6: web-frame cost for large boards.
- R7: workerd tests in a plugin package.
- R8: runtime composition roots for document hydration (standalone `workspace-runtime` CLI).
- R9: transcript cards before the plugin activates.

## Today (observed in code)

**Plugin host**
- `packages/claxedo-plugin-api/src/manifest.ts`:
- `PLUGIN_CAPABILITIES = ["tasks","documents"]`;
- plugin ids match `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$` (`id.ts`, no dots);
- `server.routes` must start with `/api/claxedo/`.
- `packages/claxedo-app/src/plugins/`:
- `host.ts:40` refuses approval to a build without `builtAt`;
- `live/controller.ts:21-26` drops every host plugin the daemon's list does not name, so any second plugin source would be dropped;
- `provider.tsx:103-109` reads `tasks` from a probe of `/api/claxedo/tasks/presets` and `documents` from the bootstrap;
- `README.md:5` says "The app bundles no plugin of its own."
- Loaders:
- desktop: `live/load.ts` `loadLiveBuild` → `bundle.ts` `importBundle(code)` (blob URL, `permittedOpaqueImports`);
- web: `loadFrameBuild` → `frame/definition.tsx` (sandboxed control frame).
- `@claxedo/plugin-build` `buildPluginApp({rootDir})` returns `{manifest, code, hash}`.
- Plugin page registration (`plugins/bindings/regions.ts`):
- pages always get `sidebar: "main"`, no `tab`, and the `grid-plus` icon;
- settings sections are JSX only, group `app`;
- `props.params` are read once when the page opens (`surface-page/view.tsx`).
- `plugins/bindings/data.ts`: `sessions.open` throws for a session that is not in the list, and imports `encodeAttachmentData` from `@claxedo/tasks`.
- Frame bridge: `frame/protocol.ts` `FrameResponse.body` is a `string`, so binary bodies do not survive.
- Bug: `frame/host-surfaces.ts` `frameSurfacePage` invokes `surface.open` synchronously while the page mounts. The mirror is re-sent by a `createEffect` in `frame/host-link.ts:34`, which runs after that mount, so the frame's `surface()` sees the previous `currentProjectId`.

**Surface catalog and renderer**
- `packages/claxedo-plugin-api/src/surface/catalog.ts`: only `Button` carries an `action`. Inputs write their bound path locally and emit nothing.
- `Image` was left out for the network lock.
- `surfaceActionEventSchema` (`messages.ts`) carries `context: record<string, json>`.
- `src/surface/action.ts` resolves a Button's declared context only.

**App coupling to Tasks**
- `src/registry.ts:6-8,14,22` registers `tasksPage` and `presetsSettingsSection`.
- `rail/view/global-navigation.tsx:84-90` hard-codes the Tasks row (`sidebar-tasks-entry`); `rail/view/utility-pages.tsx` defines the page.
- `src/server/{tasks.ts,server.ts:18,95,queries.ts:24,55,api.ts:37,207,255,query-keys.ts:33-34,freshness.ts:58-59}` wire the tasks API.
- `transcript/claxedo-tool-view.ts:8-12,23-24,119-209,261-270` render task and document tool cards (`onTaskHref` is never passed).
- `marketplace/model.ts:10-18` holds the built-in group order.
- Checks: `scripts/checks/budget.ts:29`, `freshness.ts:17-20`, `css-invalidation.ts:15`.
- Desktop-renderer policy comments: `script/product-boundary/policies/desktop.ts:672-693`.

**Local daemon**
- `claxedo-local-server/src/app/local-app.ts:76-78,185-192,497,549-575`: Tasks grants per MCP session, `TASKS_OPERATIONS`, `BUILTIN_TASKS_TOOL_GROUP`, `/documents` mounted unconditionally.
- `claxedo-desktop/src/server/entry.ts:8-10,39-41,111-112` and `harness/e2e/harness/local-daemon-entry.ts:3,14-18` compose Tasks.
- `start-local-server.ts:48,336` registers `CLAXEDO_MCP_TOOL_GROUPS`.
- Bootstrap: `deployments/shared-routes/bootstrap.ts:81` declares `documents: true`.

**Hosted**
- Tasks are mounted only by `deployments/hosted-workerd/better-auth-d1-worker.agent-plugins.cf.ts:98-128` (`tasks-contributions.ts`).
- Documents: `core-worker.cf.ts:47-50,128-145` builds the R2 backend from a mandatory `CLAXEDO_DOCUMENTS` binding; `hosted-core-app.ts:443-461` mounts `/documents` and `/p`.
- `routes/hosted/shell.ts:580` bootstrap declares `documents: false`.
- `agent-plugins/hosted-composition.ts:63-68,106,205-212,354-362,457` mints and withdraws the Tasks root grant by name.

**Storage**
- SQLite: one journal dir (`claxedo-server-core/src/platform/db/claxedo-migration/`), self-configured in `platform/db/index.ts:18`, applied by name in timestamp order into `__claxedo_migrations` (`db.ts:160-188`).
- Builds copy that journal: `claxedo-desktop/scripts/bundle-claxedo-server.ts:111-123`, `claxedo-desktop/scripts/local-server.ts:80-97`, `claxedo-local-server/scripts/build.ts:49-51`.
- `repair.ts:16-75,143` holds `claxedo_document_index` DDL.
- D1 is baseline-only: `claxedo-server/migrations/control-plane/0001_baseline.sql` (task tables at 639-720, `document_shares` at 167), enforced by `scripts/control-plane-schema.ts:8-14` and rendered by `scripts/control-plane-baseline.ts`.

**Workspace runtime and session-core**
- `workspace-runtime/src/server.ts:524` mounts `RuntimeDocumentHydrationRoutes` for every runtime.
- `workspace/runtime.ts:31,540-541` passes `flushRuntimeSessionDocuments`/`disposeRuntimeSessionDocuments`, which session-core calls at:
- `routes/session.ts:65-66,321,363-364`;
- `session-prompt-admission.ts:73`;
- `session-delete.ts:67`;
- `session-route-composition.ts:20-21,63-64`;
- `session-route-options.ts:128-130`.
- `document_write` is a `SessionAccessOperation` (`session-access-policy.ts:107,438`). The remote authority receives only `writeClass` (`remote-session-authority.ts` `authorityRequestBody`), so the operation name is not on the wire.
- A runtime route-contribution seam already exists: `workspace-runtime/src/route-contribution.ts`.

**MCP, CLI and wire**
- `claxedo-mcp/src/tools/index.ts:43-53` holds the static groups.
- Tasks-specific grants: `client/contract.ts:28-48,106-108`, `client/index.ts:46-47,203-204`, `context.ts:46,58-65,95,128-133`.
- `cli/src/index.ts:4,18,40` registers the documents command.
- `account-contract/src/hosted-operations.ts:550-623,677-710` holds `documents.*` (no `tasks.*` operations exist; Tasks go through `server.fetch`).
- `claxedo-desktop/src/main/account/account-ipc.ts` generates channels from `HOSTED_OPERATIONS`; `account-service.ts:709` special-cases `documents.export`.
- Tool-name vocabulary: `agent-runtime-contract/src/tool-names.ts:46-85` and the header's whole-part set `tool-header.ts:76-93` name `task_*` and `documents_*`.
- Env names `WORKSPACE_RUNTIME_TASKS_*` are allowed in `process-ownership/src/spawn-env.ts:49-51`.

**Closures**
- A walk stops at a bare package unless the package is `followed`.
- Module ceilings count modules inside the policy roots: local-server 74/28, server-workerd 174/22, desktop-renderer 1481/36.
- `?worker&url` specifiers are followed to source (`script/product-boundary/closure.ts:282`).
- Every product closure today already counts `@claxedo/tasks` as a package edge.

## Design

### 1. Package layout

**Decision (recommended):** stay inside the `packages/*` workspace glob.
- `packages/claxedo-tasks` (`@claxedo/tasks`, already the host-agnostic Tasks kit) becomes the Tasks plugin package.
- A new `packages/claxedo-documents` (`@claxedo/documents`) is the Documents plugin package.
- Not `plugins/*`: root workspaces, turbo outputs, CI junit globs (`packages/*/.artifacts`), `script/ci-changes.mjs` path lists, `script/file-size` and `isolated-workspace.ts` all assume `packages/*`, and a second root buys nothing.
- Not a rename to `@claxedo/plugin-tasks`: it would touch every import for no behaviour.

**What makes a package a first-party plugin:**
- a `claxedo` manifest block in `package.json` (`pluginPackageSchema`) when it has an app entry;
- its id in `FIRST_PARTY_PLUGIN_IDS` (`@claxedo/plugin-api/manifest`): `["claxedo-tasks", "claxedo-documents"]`;
- the daemon's live registry (`claxedo-local-server/src/plugins/registry.ts`) refuses those ids.

**Tasks manifest:**

```json
"claxedo": { "id": "claxedo-tasks", "name": "Tasks", "version": "1.0.0", "app": "./src/app/index.ts",
           "requires": ["tasks"], "server": { "routes": ["/api/claxedo/tasks", "/api/claxedo/plugins"], "operations": [] } }
```

**Dependency direction** (enforced by `script/first-party-plugins.test.ts`, added to `test:architecture-ratchets`):
- Plugins may import:
- `@claxedo/plugin-api`;
- `@claxedo/server-core` (host kit and plugin contracts);
- `@claxedo/session-core`;
- `@claxedo/workspace-runtime/route-contribution`;
- `@claxedo/mcp/tool-group`;
- `@claxedo/account-contract/operation-definition`;
- `@claxedo/helpers`;
- `@claxedo/agent-runtime-contract`.
- Plugins never import `@claxedo/server`, `@claxedo/local-server`, `@claxedo/app`, `@claxedo/desktop`, `@claxedo/cli` or `@claxedo/host-serving`.
- No core package (server-core, session-core, workspace-runtime, mcp, account-contract, agent-runtime-contract, plugin-api, app `src/**` except `src/plugins/first-party/bundles.ts` and `src/server/operations.ts`) imports a plugin.
- Composition roots that may import plugins:
- `claxedo-desktop/src/server/entry.ts`;
- `claxedo-desktop/src/main/account/account-ipc.ts`;
- `harness/e2e/harness/local-daemon-entry.ts`;
- `claxedo-server/src/deployments/hosted-workerd/*.cf.ts`;
- `claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts`;
- `claxedo-host-serving/src/runtime.ts`;
- `cli/src/index.ts`;
- `claxedo-server/scripts/control-plane-schema.ts`;
- the three journal-copying build scripts.

**Subpath exports per host role**

| Role | `@claxedo/tasks` | `@claxedo/documents` |
|---|---|---|
| Contracts (no IO) | `.` (today's kit), `./client`, `./conformance`, `./test-support` | `.` (port, index contract, errors, version, `claxedoDocumentReferenceId`) |
| HTTP routes | `./http` (`createTasksRoutes`, `TASKS_ROUTE_PATH`) | `./http` (`DocumentsRoutes`, `PublicDocumentRoutes`) |
| App surface module (bundle entry, never imported by app source) | `./app` (`definePlugin`, `dictionary`) | `./app` (tool cards only; see Q4) |
| SQLite storage | `./storage/sqlite` (`TASKS_SQLITE_SCHEMA`, tables, `sqliteTasksStore`) | `./storage/sqlite` (`DOCUMENTS_SQLITE_SCHEMA`, index store) |
| D1 storage | `./storage/d1` (`TASKS_D1_SCHEMA_DIR`, `d1TasksStore`) | `./storage/d1` (`DOCUMENTS_D1_SCHEMA_DIR`, document authority) |
| Shared host code | `./host` (today's `server-core/src/tasks-host/*`) | internal |
| Local server contribution | `./local` → `createLocalTasksPlugin(input): LocalServerPlugin` | `./local` → `createLocalDocumentsPlugin(): LocalServerPlugin` |
| Hosted contribution | `./hosted` → `createHostedTasksPlugin(ports): HostedServerPlugin` | `./hosted` → `createHostedDocumentsPlugin(ports): HostedServerPlugin` |
| Workspace-runtime contribution | `./runtime-host` → `tasksRuntimeHostPlugin: RuntimeHostPlugin` (sandbox grant) | `./runtime` → `documentHydrationContribution(input): WorkspaceRuntimeRouteContribution` |
| MCP tool group | `./mcp` → `TASKS_MCP_TOOL_GROUP` | `./mcp` → `DOCUMENTS_MCP_TOOL_GROUP` |
| CLI command | none (Tasks has none today) | `./cli` → `documentsCliCommand: CliCommand` |
| Wire operations | none (Tasks uses routes) | `./operations` → `DOCUMENTS_OPERATIONS` |

### 2. Generic host extension points

All new contract types live in `packages/claxedo-server-core/src/plugins/` unless stated. Their imports of `@claxedo/mcp/tool-group` and `@claxedo/workspace-runtime/route-contribution` are type-only (erased; the closure walk runs `runtimeOnly`).

#### (a) Server route contributions

`ControlPlaneRouteContribution` (`platform/http/route-contribution.ts`) generalises unchanged: it already takes any path, so `/documents` and `/p` fit. A plugin hands a host a bundle of contributions:

```ts
// packages/claxedo-server-core/src/plugins/server-plugin.ts
export type ServerPluginBase = {
id: string                                   // "claxedo-tasks"; unique per host, checked like contribution ids
capability?: string                          // reported in bootstrap `deployment.capabilities` ("tasks", "documents")
routeContributions: readonly ControlPlaneRouteContribution[]
mcp?: McpPluginContribution
}
export type McpPluginContribution = {
groups: readonly McpToolGroup[]
service?: McpServiceContribution
}
export type McpServiceContribution = {
id: string                                   // "tasks", "documents": the key a tool's access names
grant(input: McpServiceGrantInput): Promise<McpServiceGrant | undefined>
}
export type McpServiceGrantInput = {
workspaceId: string
sessionId?: string
enabledGroups: readonly string[]
/** A fetch that enters this process's own routes, with these headers added. */
inProcessFetch(headers: Readonly<Record<string, string>>): ClaxedoFetch
}
export type LocalServerPlugin = ServerPluginBase & {
sqliteSchema?: SqliteSchemaContribution
runtimeContributions?: readonly WorkspaceRuntimeRouteContribution[]
}
export type HostedServerPlugin = ServerPluginBase & {
rootGrants?: readonly CloudRootGrantContribution[]
}
export type CloudRootIdentity = { orgId: string; projectId: string; workspaceId: string; userId: string } // moved from claxedo-server
export type CloudRootGrantContribution = {
group: string                                // the MCP group whose consent this grant is ("tasks")
audience: string                             // TASKS_CAPABILITY_AUDIENCE
withdrawalReason: string                     // "tasks_group_disabled"
mint(root: CloudRootIdentity): Promise<Readonly<Record<string, string>>>  // env for the root
}
```

**Composition.**
- **Local:**
- `StartLocalServerOptions.plugins: readonly LocalServerPlugin[]` replaces `routeContributions`-for-Tasks, `tasksGrants`, and the `/documents` mount in `local-app.ts`.
- `mountLocalRouteFamilies` mounts `plugins.flatMap(p => p.routeContributions)` through `mountControlPlaneRouteContributions`.
- The MCP `createClient` builds `services` from `plugins.map(p => p.mcp?.service)`.
- `firstPartyMcp.registerTools` is `[...CLAXEDO_MCP_TOOL_GROUPS, ...plugins.flatMap(p => p.mcp?.groups ?? [])]`.
- `runtimeContributions` go to `configureEmbeddedWorkspaceRuntime`.
- Composition roots: `claxedo-desktop/src/server/entry.ts` passes `[createLocalTasksPlugin({ enabled }), createLocalDocumentsPlugin()]`; `harness/e2e/harness/local-daemon-entry.ts` passes the same.
- **Hosted:**
- `HostedCoreAppOptions.plugins: readonly HostedServerPlugin[]` replaces the `documents` option and the Tasks entries of `routeContributions`.
- `createHostedCoreApp` mounts them with `mountOwnedRoute` ownership (collision-checked).
- `core-worker.cf.ts` composes `createHostedDocumentsPlugin(...)` in every hosted profile, as today.
- `better-auth-d1-worker.agent-plugins.cf.ts` adds `createHostedTasksPlugin(...)`.
- `rootGrants` go into `createHostedAgentPluginsComposition`, which loses every Tasks name: `tasksGrant`, `tasksGroupEnabled`, `BUILTIN_TASKS_TOOL_GROUP` and the per-name withdrawal at :457 become a loop over `rootGrants`. The subagents owner grant stays core.
- **Bootstrap:** both bootstraps report `deployment.capabilities: string[]`, the sorted `capability` of each mounted plugin. The local one is `bootstrap.ts:81`. The hosted one, `shell.ts:580`, reads them from the plugins passed to shell routes.

#### (b) Storage

**SQLite (local).**

```ts
// packages/claxedo-server-core/src/platform/db/schema-contribution.ts
export type SqliteSchemaContribution = {
id: string                                   // "claxedo-tasks"
journal: string                              // absolute dir of `<yyyymmddhhmmss>_<name>/migration.sql`
repair?: { version: number; statements: readonly string[] }   // idempotent DDL, run inside `repair`
}
export function configureClaxedoSchema(input: { journals: readonly string[]; repairs: readonly SqliteSchemaContribution["repair"][] }): void
```

- `configureClaxedoMigrations(dir)` becomes `configureClaxedoSchema`.
- `migrations()` merges the entries of every journal and sorts globally by timestamp. Two entries with one name throw, so already-applied names and their global order stay byte-identical.
- `platform/db/index.ts:18` stops self-configuring. Each composition root calls `configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL, ...plugins.map(p => p.sqliteSchema.journal)] })` before anything opens the database.
- The desktop entry must call it above `createLocalAgentPluginsComposition()`, which opens `claxedo.db`.
- The repair fingerprint includes every contribution's `repair.version`.
- The bundled `CLAXEDO_MIGRATIONS` and the copied `claxedo-migration/` directory are produced from all journals by the three build scripts. A build-time name-uniqueness check throws.
- Folders move with `git mv`, names unchanged. To Tasks:
- `20260912100000_claxedo_tasks`, `20260914000200_task_preset_agent_startable`, `20260914000300_task_session_link_agent_start`, `20260914000400_task_session_link_started_by`, `20260914000500_task_attachments`, `20260915000100_task_child_number` → `packages/claxedo-tasks/src/storage/sqlite/migrations/`.
- To Documents:
- `20260716000100_documents_reset`, `20261001000100_document_creator` → `packages/claxedo-documents/src/storage/sqlite/migrations/`;
- plus any other document folder: verify with `rg -l "claxedo_document_index|claxedo_local_project|claxedo_page_status" packages/claxedo-server-core/src/platform/db/claxedo-migration`.
- Drizzle table files `tasks-host/tasks.sql.ts` and `documents/index.sql.ts` move with their plugin. Find any generator config that lists `*.sql.ts`, then repoint it: `rg -n "sql\.ts" packages/claxedo-server-core script`.

**D1 (hosted).** D1 stays baseline-only, and the deployed artifact stays one file.
- The source splits by owner:
- `claxedo-server/migrations/control-plane/0001_baseline.sql`: host tables only;
- `packages/claxedo-tasks/src/storage/d1/0001_baseline.sql`: `task_attachments`, `task_command_receipts`, `task_presets`, `task_session_links`, `task_write_guards`, `tasks`, their indexes;
- `packages/claxedo-documents/src/storage/d1/0001_baseline.sql`: `document_shares` and its indexes.
- `control-plane-schema.ts` gains `CONTROL_PLANE_SCHEMA_SOURCES = [host dir, TASKS_D1_SCHEMA_DIR, DOCUMENTS_D1_SCHEMA_DIR]`.
- `currentControlPlaneBaseline()` renders the combined baseline in memory: replay every source, order `sqlite_master` by type then name, exactly as `control-plane-baseline.ts` does.
- `d1:baseline:generate|check` fold and check per source.
- A test pins `sha256(currentControlPlaneBaseline())` to the hash of today's `0001_baseline.sql`, recorded at the split commit.
- The `CLAXEDO_DOCUMENTS` R2 binding name and object keys are unchanged (the code moves verbatim).

#### (c) MCP tool group contribution

- New subpath `@claxedo/mcp/tool-group` exports the group authoring kit:
- `McpToolGroup`, `McpToolGroupReach`, `ToolRegistrar`, `McpToolDefinition`, `McpToolHandler`;
- `declaredToolAccess`, `mcpToolRefusal`, `toolJson`, `toolTarget`, `targetScope`;
- `McpServiceGrant`, `ClaxedoFetch`.
- Generic service grants replace `ClaxedoMcpClient.tasks` and `.documents`:

```ts
export type McpServiceGrant = Readonly<{ fetch: ClaxedoFetch; operations: readonly string[]; projectId?: string }>
interface ClaxedoMcpClient { /* … */ readonly services: Readonly<Record<string, McpServiceGrant>> }
type McpToolAccess = { /* … */ service?: Readonly<{ id: string; label: string; operation?: string }> }
type McpToolGrants = Readonly<{ services: Readonly<Record<string, readonly string[]>>; appPlugins?: boolean; ownerDriven?: boolean }>
// McpAccessDenied code "tasks" → "service"; the message text stays:
// "<tool> needs the <label> service, which this Claxedo deployment does not serve"
// "<tool> needs the <operation> <label> operation, which this session was not granted"
```

- **Tool groups and inventory:**
- `CLAXEDO_MCP_TOOL_GROUPS` keeps only the core groups (app-plugins, attention, review, sessions, subagents, surfaces, workspaces).
- `claxedoMcpToolGroupInventory(groups)` and `claxedoMcpToolGroupsFor(groups, enabled)` take the composed list.
- **Every caller passes the composed list:**
- `start-local-server.ts:336`;
- `core-worker.cf.ts:157`;
- `hosts/workspace-runtime/first-party-mcp.ts:73`;
- `agent-plugins/hosted-composition.ts:236`;
- `local-server/agent-plugins/builtin-groups.ts`;
- the test planes (`claxedo-server/src/test-support/session-host-plane.ts`, `session-host/src/test-support/control-plane.ts`).
- **Unchanged:** group ids `tasks` and `documents`, so Marketplace activation rows `claxedo:tasks` and `claxedo:documents` are untouched; tool names; and the `reach` of each group.
- `@claxedo/mcp` drops its `@claxedo/tasks` dependency.

#### (d) Session lifecycle hooks

```ts
// packages/session-core/src/routes/session-lifecycle.ts
export type SessionLifecycleHooks = Readonly<{
/** After a turn delivered as "start" settles (routes/session.ts) and after an admitted prompt's turn (session-prompt-admission.ts). A failure is logged and never fails the turn. */
turnSettled?: (sessionId: string) => Promise<void>
/** Before a session is deleted (session-delete.ts). A failure keeps the session, as today. */
beforeSessionDelete?: (sessionId: string) => Promise<void>
}>
// SessionRoutesOptions: flushSessionDocuments / disposeSessionDocuments → sessionLifecycle?: readonly SessionLifecycleHooks[]
```

- Hooks run in contribution order.
- `WorkspaceRuntimeRouteContribution` gains `sessionLifecycle?: SessionLifecycleHooks`. `workspace/runtime.ts:540-541` passes `routeContributions.flatMap(c => c.sessionLifecycle ? [c.sessionLifecycle] : [])`.
- `document_write` becomes the generic `contribution_write` (write class `session_control`). It is internal: `remote-session-authority.ts` sends only `writeClass`.
- Verify the hosted D1 session authority never stores an operation name: `rg -n "document_write|operation" packages/claxedo-server/src/authority`.

#### (e) Workspace-runtime route contributions (document hydration)

- `WorkspaceRuntimeRouteContext` (`workspace-runtime/src/route-contribution.ts`) gains:

```ts
relayWorkspaceId?: string   // set only for relay exposure; hydration answers 404 without it (as `if (!workspaceId) return notFound()` does today)
authorizeSessionControl(c: Context, sessionId: string): Promise<Response | undefined>   // authorizeHostCapability(c, options, "contribution_write", …)
```

- `documentHydrationContribution({ controlPlaneOrigin, verifyJob? })` returns `{ id: "claxedo-documents", mount, sessionLifecycle }`. Its document map is created by the factory, not as module state, and keyed `${sessionId}:${documentId}` as today.
- `server.ts:524` loses the hard mount.
- Composition roots add the contribution:
- `claxedo-server/src/hosts/workspace-runtime/runtime-boot.ts` (sandbox);
- the local daemon through `LocalServerPlugin.runtimeContributions`;
- `claxedo-host-serving/src/runtime.ts`;
- `workspace-runtime/src/cli.ts`: see Q6.

#### (f) CLI command contribution

```ts
// packages/claxedo-plugin-api/src/cli.ts  (subpath "./cli"; types only, no solid import)
export type CliCommandContext = {
controlPlaneUrl(): string
url(base: string, path: string): string
requestJson(input: { url: string; method: string; token: string; body?: unknown }): Promise<unknown>
requireAccessToken(): Promise<string>
env: Readonly<Record<string, string | undefined>>
}
export type CliCommand = { name: string; usage: string; run(args: readonly string[], context: CliCommandContext): Promise<void> }
```

- `cli/src/index.ts` keeps `const PLUGIN_COMMANDS: readonly CliCommand[] = [documentsCliCommand]`.
- `help()` prints each `usage` in the position `documentsUsage` holds today, so the output is byte-identical.
- `main` dispatches by `name`.
- `@claxedo/documents` is a devDependency, bundled by `scripts/build.ts` like the other workspace packages (verify).

#### (g) App side

**Bundled first-party path.**
- `packages/claxedo-app/vite.plugin-bundles.ts` exports `claxedoPluginBundles()`, a Vite plugin:
- it resolves `<pkg>/app?claxedo-plugin-bundle`, runs `buildPluginApp({ rootDir })` from `@claxedo/plugin-build` on that package;
- it emits `export default { manifest, hash, code }` as its own lazily loaded chunk.
- It is added to `vite.cloud.config.ts` (web and daemon-served web) and `claxedo-desktop/vite.renderer.ts`.
- No `fetch`, which matters because the desktop renderer loads from `file://` (`main/windows.ts:232`).
- `src/plugins/first-party/bundles.ts`:

```ts
export const FIRST_PARTY_BUNDLES: readonly FirstPartyBundle[] = [
{ id: "claxedo-tasks", load: () => import("@claxedo/tasks/app?claxedo-plugin-bundle") },
{ id: "claxedo-documents", load: () => import("@claxedo/documents/app?claxedo-plugin-bundle") },
]
```

- `first-party/load.ts` uses the existing loaders: desktop `installPluginRuntime(); importBundle(code)`, web `frameDefinition({ ...frame, code })`.
- The closure walk records `@claxedo/tasks` as a package edge, already counted. A new policy `tasks-app` (entry `packages/claxedo-tasks/src/app/index.ts`) measures the bundle:
- forbidden: `@claxedo/app`, `@claxedo/server`, `@claxedo/local-server`, `@claxedo/server-core`, `hono`, `drizzle-orm`, `better-sqlite3`;
- exact measured ceilings;
- run by a new `verify:closure` script in `packages/claxedo-tasks`.
- **Origin and approval:** `PluginOrigin` becomes a union `{ kind: "live"; hash; directory; builtAt?; buildError? } | { kind: "bundled"; hash }`.
- `createBuildPolicy.approval` returns `{ kind: "approved" }` for `bundled`, because the host ships it. No approval record is written.
- `live/controller.ts` reconciles and drops only `origin.kind === "live"`.
- Settings → App plugins lists a bundled plugin as built in, with on/off and no remove or folder. Switched on by default, as all plugins are.
- Safe mode keeps bundled plugins on. Safe mode exists to stop third-party code (recommendation, Q8).
- **Requirements:** `manifest.requires` becomes open capability ids (`/^[a-z][a-z0-9-]*$/`), offered when `capabilities.has(id)` from bootstrap.
- The Tasks plugin requires `tasks`, so it loads only where the server mounts Tasks (not on a hosted core worker without the agent-plugins profile).
- Loaded on desktop (in-app), daemon-served web (frame) and hosted web (frame), independent of `features.livePlugins`.
- **Bootstrap flags:**
- `server/wire/placements.ts` reads `deployment.capabilities`;
- `Capabilities.features.documents` is removed and `Capabilities.plugins: ReadonlySet<string>` added;
- `server/capabilities.ts:44` and `plugins/provider.tsx:103-109` read it;
- `queries.tasks.availability`, `taskQueries`, `queryKeys.tasks` and `freshness.tasks` are deleted.
- **Transcript tool cards:** the generic Claxedo card renderer stays in the app; the task and document mappings move to their plugins as declarative templates (§4 table, `api.transcript.toolCards`).
- `claxedo-tool-view.ts` consults the registered templates for any tool name without a core case.
- With no plugin loaded, such a tool renders as the generic row.
- Task links become `{ kind: "page", pageId: "tasks", params: { taskId } }`, so task links work for the first time.
- **Composer leftovers to delete** (S1):
- `composer/view/prompt-options.ts:16,54-61`;
- `composer/suggestions.ts:28,68`;
- `composer/view/popover-bindings.ts:12,95`: plugin mention items become an AtOption of type `mention`;
- `composer/view/slash-popover.tsx:11-12,39-40,80,90`;
- `composer/view/at-option-row.tsx:29-39`: `DocumentOption` becomes `MentionOption`;
- `composer/view/frame.tsx:16,42,63-64,80-82`.

#### (h) Account-contract wire operations

- `documents.*` definitions (`hosted-operations.ts:550-623,677-710`) move verbatim to `@claxedo/documents/operations` as `DOCUMENTS_OPERATIONS`. They are built with `defineOperation` from a new subpath `@claxedo/account-contract/operation-definition`.
- `account-contract` exports `CORE_HOSTED_OPERATIONS` and `hostedOperationTable(...extra)`. The table throws on a duplicate name and preserves `HostedOperationName` typing through generics.
- Composition roots build the table:
- `claxedo-desktop/src/main/account/account-ipc.ts`: channels `claxedo.account.operation:documents.*` unchanged;
- `claxedo-app/src/server/operations.ts`: exposure checks.
- `documents.export`'s binary special case (`account-service.ts:709`) becomes a definition flag `response: "bytes"`, which main base64-envelopes for any operation.
- No `tasks.*` operations exist, and none are added.

### 3. A2UI catalog extensions

**Event model change (§3.0).**
- Today only `Button.action` fires. Event-bearing props on other components reuse `surfaceActionSchema` (`{ event: { name, context } }`).
- The renderer resolves the declared context as Button does (`action.ts`), then adds the component's supplied fields under fixed names.
- A declared context key that collides with a supplied field is a spec error (`checkSurfaceSpec` issue at the context key's pointer).
- `surfaceActionEventSchema` is unchanged (context stays `record<string, json>`). Plugins receive events through `SurfaceProgram.action`. The frame forwards them by `surface.action` as today.
- `surfaceActionEvent(action, source, data, now, supplied)` in `src/surface/action.ts` gains `supplied: Readonly<Record<string, JsonValue>>`.
- Supplied field names are declared once per component in `packages/claxedo-plugin-api/src/surface/events.ts` as `SURFACE_EVENT_FIELDS`.
- **Producer limits:** `Board.move`, `FilePicker` and `Combobox.search` are plugin-only.
- `checkSurfaceSpec(value, { producer: "agent" })` (used by `ui_show`) refuses them with a path.
- The renderer draws them inert when `source.kind === "agent"`.
- Each agent action would otherwise post a user message carrying bytes or every keystroke.

**S2: input events and `Image`**

```ts
// added to existing components (all optional)
TextField:    submit?: Action   // Enter (shortText/number/obscured); Mod+Enter or Mod+S (longText). supplied: { value: string }
ChoicePicker: change?: Action   // after the bound write. supplied: { value: string[] }
CheckBox:     change?: Action   // supplied: { value: boolean }
Switch:       change?: Action   // supplied: { value: boolean }
Tabs:         selected?: DataBinding /* number */, change?: Action   // supplied: { index: number }

catalogComponent("Image", {
url: dynamicString,
fit: z.enum(["contain", "cover", "fill", "none", "scaleDown"]).optional(),
variant: z.enum(["icon", "avatar", "smallFeature", "mediumFeature", "largeFeature", "header"]).optional(),
}) // refined: accessibility.label is required
```

- **URL rule** (`packages/claxedo-plugin-api/src/surface/image-url.ts`, used by the spec check for literals and by the renderer for bound values): `surfaceImageUrl(value): { ok: true; url } | { ok: false; reason: "scheme" | "mime" | "size" | "origin" }`.
- `data:` must match `^data:image/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$` and be at most `SURFACE_IMAGE_MAX_DATA_URL_LENGTH = 2_796_300` characters (2 MiB decoded).
- `blob:` is accepted only when `new URL(url).origin === location.origin` (renderer). A blob created in the opaque web frame is refused.
- Every other scheme is refused: `http(s)`, `file`, `javascript`, and `data:image/svg+xml` (no SVG).
- A refused image draws `data-slot="surface-image-refused"` with its label and logs once per component id.
- Status glyphs (for task status) join `SURFACE_ICON_NAMES` with surface-owned glyphs: `circle`, `circleDashed`, `circleHalf`, `checkCircle`, `alertCircle`. They follow `icon-names.test.ts`'s faithful-glyph rule.
- Renderer files: `view/image-view.tsx`, `view/field-views.tsx`, `view/choice-picker-view.tsx`, `view/container-views.tsx` (Tabs), `view/component-views.ts`, `README.md`, `surface-display.css`.

**S3: `Board` with `move`**

```ts
const boardColumn = z.object({
key: z.string().min(1).max(64),
title: dynamicString,
items: z.string().max(1024),                 // JSON Pointer to this column's item list
headerActions: componentIdList.optional(),   // e.g. a "+" Button
footer: componentId.optional(),              // e.g. "Load more"
}).strict()

catalogComponent("Board", {
columns: z.array(boardColumn).min(1).max(12),
item: componentId,                           // template; scope = the item's path
itemKey: z.string().min(1).max(64),          // field holding each item's stable id
movable: z.string().max(64).optional(),      // boolean field per item; absent = every item movable
move: surfaceActionSchema.optional(),        // absent = not sortable
layout: z.enum(["columns", "list"]).optional(), // "list" stacks columns as groups; one column = a sortable list
})
// supplied on move: { itemId, fromColumn, fromIndex, toColumn, toIndex }
```

- **Pointer:** HTML5 drag-and-drop as today's board. Touch has no drag; plugins offer another move control (Tasks uses the status picker).
- **Keyboard:** every movable item is focusable with `aria-roledescription` "movable item".
- Space or Enter grabs; ArrowUp/Down moves within the column; ArrowLeft/Right moves across columns; Space or Enter drops (fires `move`); Escape cancels.
- The grab machine is `src/surface/board-moves.ts` (`machine()`: `idle → grabbed → idle`).
- A polite live region inside the surface section announces "Moved to {column}, position {n}" (`surface/i18n.ts`).
- **Pending:** the renderer never writes the data model.
- A dropped item is drawn at its target until the next `updateDataModel` touching either column's `items` path.
- Plugin contract (in the design guide): every `move` is answered by a patch, the new lists on success or the old lists on refusal.
- `componentReferences` covers `item`, `headerActions`, `footer`.
- Files: `view/board-view.tsx`, `src/surface/board-moves.ts`, `src/surface/board-pending.ts`, `view/surface-board.css`.

**S4: `FilePicker` and `Combobox`**

```ts
catalogComponent("FilePicker", {
label: dynamicString,
accept: z.array(z.string().regex(/^(?:\.[a-z0-9]+|[a-z]+\/(?:[a-z0-9.+-]+|\*))$/)).min(1).max(16),
maxBytes: z.number().int().positive().max(SURFACE_FILE_MAX_BYTES),  // 8 MiB per file
maxFiles: z.number().int().min(1).max(16).optional(),               // default 1; >1 = multiple
fitImages: z.boolean().optional(),   // re-encode an image over maxBytes: WebP else JPEG, q 0.85, ×0.7 per round, ≤ 6 rounds
paste: z.enum(["self", "section"]).optional(), // also accept paste while focus is inside the nearest Section/Card
pick: surfaceActionSchema,
})
// supplied on pick: { files: [{ name, mimeType, size, dataBase64 }], refused: [{ name, reason: "type" | "size" | "count" }] }
// the host caps one event at SURFACE_FILE_EVENT_MAX_BYTES = 12 MiB decoded; files past it are refused "size"

const comboOption = z.object({ label: dynamicString, value: z.string().max(256), description: dynamicString.optional() }).strict()
catalogComponent("Combobox", {
label: dynamicString.optional(),
value: dataBindingSchema,                    // string, or string[] when multiple
multiple: z.boolean().optional(),
options: z.union([z.array(comboOption).max(200), dataBindingSchema]),
query: dataBindingSchema.optional(),         // where typed text is written locally
search: surfaceActionSchema.optional(),      // 250 ms after the last keystroke; supplied: { query }
change: surfaceActionSchema.optional(),      // supplied: { value }
placeholder: dynamicString.optional(),
emptyText: dynamicString.optional(),
})
```

- **FilePicker:**
- Bytes cross in the action context as base64. That is one channel that works in-app, over the frame's `MessagePort`, and in the planned worker sandbox; no Blob handles cross.
- Drop on the picker and paste (per `paste`) are read by the host. The plugin never sees file paths.
- The algorithm in today's `src/tasks/view/image-drafts.ts` moves to `src/surface/image-fit.ts`.
- **Combobox:**
- The plugin streams options back with `updateDataModel({ path: <options path>, value: [...] })`.
- The renderer shows a searching state from a fired `search` until the next write under the options path.
- Stale answers are the plugin's to drop: it knows the latest `query` it received.
- The debounce timer is owned by `src/surface/search-debounce.ts`, one named module per the no-polling rule.
- Files: `view/file-picker-view.tsx`, `src/surface/file-read.ts`, `src/surface/image-fit.ts`, `view/combobox-view.tsx`, `src/surface/search-debounce.ts`.

**S5 reference input: `AgentConfigurationPicker`** (needed by the preset editor)

```ts
catalogComponent("AgentConfigurationPicker", {
placement: z.union([z.enum(["local", "cloud"]), dataBindingSchema]),
value: dataBindingSchema,   // { harness: { id, access: "native" | "connection" } | null, model: { providerID, modelID } | null, effort: string | null }
disabled: dynamicBoolean.optional(),
change: surfaceActionSchema.optional(), // supplied: { value }
})
```

- The app draws it with `DraftHarnessPicker` (local, over the first placement) and `CloudConfigurationPicker`/`CloudCatalogModelPicker`. Those move from `src/tasks/presets/` to `src/composer/`, the owner of harness choice.
- It is a reference component (the viewer's catalogs, the viewer's access), like the planned `Diff`/`FileRef`/`SessionRef`.
- Plugin-only.

Every S2–S5 change updates `packages/claxedo-plugin-api/src/surface/design-guide.ts` (and its test), the `ui_guide` text, and `src/surface/README.md`. Design and screenshot verification follow the `a2ui-surface-design` repo skill.

### 4. Tasks UI as an A2UI page

**View mapping** (all under `packages/claxedo-app/src/tasks/`; the target files live in `packages/claxedo-tasks/src/app/`)

| Today | Surface composition in the plugin |
|---|---|
| `view/tasks-page.tsx`, `tasks-header.tsx` | `Header` (title, project subtitle, actions: New task `Button`) |
| `view/tasks-toolbar.tsx` | `Row`: `Tabs` collections Active/Backlog/All (`selected` + `change`, re-reads with `includeArchived` for All); `ChoicePicker` list/board, date field (`change`); `Switch` show subtasks, group by status (`change`); `Combobox` project (`change`) |
| `view/task-list.tsx`, `task-cells.tsx`, `load-more.tsx` | `List` template of `ListItem` (title = key + title; meta: status `Badge`/`Icon`, progress `Text`, live `Badge`, age `Text`; `primaryAction` Start/Open; `actions` archive/restore); grouped by status → `Board layout:"list"` (move = `task.set_status`); Load more `Button` |
| `view/task-board.tsx` | `Board` one column per collection status, `item` = card template, `movable` = not archived, `headerActions` "+" for Backlog/To do, `move` → `task.set_status` with the card's revision |
| `view/task-row-controls.tsx`, `status-control.tsx` | `ListItem` actions; status `ChoicePicker` (dropdown, `change`); start: `ChoicePicker` preset (dropdown) + Start `Button` |
| `view/create-task-dialog.tsx`, `task-create-form.tsx`, `image-queue.ts`, `image-drafts.ts` | No overlays in the catalog, so an inline `Section` "New task" at the top: `TextField` title, `TextField longText` description, `ChoicePicker` status (Backlog/To do), `Combobox` project, `FilePicker` (png/jpeg/gif/webp, 1.5 MiB, 6 files, `fitImages`, `paste: "section"`), `Grid` of `Image` previews with remove `Button`s, `Footer` Cancel/Create |
| `view/task-detail-page.tsx`, `task-detail.tsx`, `title-field.tsx`, `prose-field.tsx` | Same surface at `/tasks/:taskId` via `navigated`; `Header` (key, title, status `Badge`, back `Button`); `TextField` title and longText description (`submit` = Save incl. Mod+S); `Footer` Save/Discard while the draft differs; stale revision → `Callout` warning with the current title |
| `view/task-subtasks.tsx` | `Section` "Subtasks" (done/total `Text`), `List` of `ListItem`, add `TextField` (`submit`) disabled while done or archived |
| `view/task-attachments.tsx` | `Grid` of `Image` (data: URLs from `readAttachment` bytes via binary `server.fetch`) |
| `view/task-rail.tsx`, `task-slot.tsx` | `Column` (weighted) of `Section` per slot: `KeyValue` (attempt, liveness, handoff), Open session / Start / Start again / Continue / Send task `Button`s, preset `ChoicePicker`, progress `Text` + `Spinner`, refusal `Callout`; collapse = `Collapsible` |
| `view/task-commands.ts`, `data/*`, `store.ts`, `model.ts`, `links.ts` | Plugin program modules: `@claxedo/tasks/client` over `api.server.fetch`; `start-run.ts` progress machine moves as is |
| `presets/presets-section.tsx`, `preset-list.tsx`, `preset-editor.tsx`, `draft.ts`, `store.ts` | Settings surface: `List` of `ListItem` presets (archive/restore), editor `Section`: name `TextField`, placement `ChoicePicker` (Local/Cloud; an unoffered placement shows a `Callout`), per-slot `AgentConfigurationPicker`, instructions `TextField longText`, `Switch` agent-startable, `Footer` Save |
| `presets/capability-picker.tsx`, `capabilities.ts` | `Combobox multiple` over the Marketplace catalog read with `server.fetch("/api/claxedo/plugins")` |
| `presets/configuration-editor.tsx`, `cloud-*` | `AgentConfigurationPicker` (app-drawn) |
| `i18n.ts` | Plugin `dictionary` export |
| `view/tasks.css` | Deleted; the renderer's defaults draw everything (R5) |

**Missing plugin API primitives** (the primitive table AGENTS.md asks for; each lands in S5 with a fixture-plugin assertion in flow 61)

| Primitive | Interface | Host owner | Needed for |
|---|---|---|---|
| Tab pages and icon | `SurfacePageDefinition.tab?: true; icon?: IconName` → `PageEntry.tab/icon` | `plugins/bindings/regions.ts` | Tasks shares the page tab with Marketplace, never splits (flow 12) |
| Param routes without remount | `SurfaceProgram.navigated?(props: PageProps): void`; frame `surface.navigated { surfaceId, path, params }` | `plugins/surface-page/view.tsx`, `controller.ts`, `frame/host-surfaces.ts`, `frame/runtime/surfaces.ts` | `/tasks` ↔ `/tasks/:taskId` keeps page state |
| Settings section as a surface | `SurfaceSettingsSection { id; title; icon?; order?; group?: "workspace" \| "app"; surface(channel): SurfaceProgram \| void }`; `SettingsApi.open(sectionId): void`; frame `Registration { kind: "settings"; surface: true }` | `bindings/regions.ts`, `surface-page/settings-view.tsx` | Settings → Presets; "Open preset settings" |
| Open a session not listed yet | `SessionsApi.open(ref: SessionRef): Promise<void>` (re-reads the workspace catalog when the placement is unknown, then navigates) | `bindings/data.ts`; `locateSession` moves from `server/tasks.ts` to `server/workspaces.ts`, served as `placements.locateSession` | Start → open the new session; Open on a cloud task |
| Cloud wake progress | `WorkspacesApi.followStart(workspaceId: string, onProgress: (text: string \| undefined) => void): Promise<{ kind: "running" } \| { kind: "failed"; message: string }>`; frame host→frame `{ type: "progress", id, text }` | new `bindings/workspaces.ts` (over `useWakeProgress` and `cloud.followStart`, which `tasks.followRoot` became so Tasks and plugins share one follow) | Start on a Cloud preset |
| Binary `server.fetch` on the web | `FrameResponse` gains `encoding: "utf8" \| "base64"`; utf8 only for a JSON, XML, JavaScript or `text/*` type in UTF-8, base64 otherwise | `frame/protocol.ts`, `frame/host-calls.ts`, `frame/response-body.ts`, `plugins/base64.ts` | Attachment images on web |
| Transcript tool cards | `TranscriptApi.toolCards(templates: readonly ToolCardTemplate[]): Disposer` (below); frame `Registration { kind: "toolCards"; templates }` | shell registry `toolCards`, `transcript/claxedo-tool-view.ts` | Task and document cards outside the app |
| Session start with preset/harness/model | Not added: the server's Start creates the session; add only when a plugin needs it | — | — |

```ts
// packages/claxedo-plugin-api/src/transcript.ts
export type ToolCardText = string | { path: string } | { first: readonly (string | { path: string })[] }
| { count: { path: string; one: string; other: string } }               // paths are JSON Pointers into { args, result }
export type ToolCardLink =
| { kind: "page"; pageId: string; params: Readonly<Record<string, ToolCardText>>; label: ToolCardText }
| { kind: "session"; sessionId: ToolCardText; label?: ToolCardText }
export type ToolCardTemplate = {
tool: string
title: string                                      // already localized by the plugin
subject?: ToolCardText
status?: ToolCardText
link?: ToolCardLink
notes?: readonly { when: { path: string; equals: string | number | boolean }; text: string }[]
facts?: readonly { label: string; value: ToolCardText | ToolCardLink; mono?: boolean; when?: { path: string } }[]
rows?: { path: string; link?: ToolCardLink; status?: ToolCardText; max: number; more?: string }
}
```

**Behaviour kept and how:**
- **Boot reads nothing under `/api/claxedo/tasks/`:** `activate` registers only and reads on page open (flow 12).
- **Toasts and confirmations:** `api.ui.toast` and `api.ui.confirm`.
- **Project:** `api.projects.currentId()` and `list()`, reactive in-app and through the mirror (S0 makes the open fresh).
- **Plugin route access:** the manifest names `/api/claxedo/tasks` and `/api/claxedo/plugins` (see Q7 on breadth).

## Phases and acceptance

Commands use the package scripts:
- **app:** `bun run --cwd packages/claxedo-app test|typecheck|check|e2e <spec> --project web --project phone`;
- **plugin-api:** `bun run --cwd packages/claxedo-plugin-api test`;
- **mcp:** `bun run --cwd packages/claxedo-mcp test`;
- **local:** `bun run --cwd packages/claxedo-local-server test`;
- **server:** `bun run --cwd packages/claxedo-server test`;
- **core:** `bun run --cwd packages/claxedo-server-core test`;
- **session:** `bun run --cwd packages/session-core test`;
- **runtime:** `bun run --cwd packages/workspace-runtime test` (runtime suites only under the no-signal `sandbox-exec` profile);
- **tasks:** `bun run --cwd packages/claxedo-tasks test`;
- **cli:** `bun run --cwd packages/cli test`;
- **contract:** `bun run --cwd packages/account-contract test`;
- **ratchets:** `bun run test:architecture-ratchets`;
- **closures:** `bun run --cwd packages/<product> verify:closure`;
- **typecheck all:** `bun run typecheck`.

Every new or changed flow records a red run, at desktop width and in `phone`. Every ceiling change is the exact measured number with its owner named in the adjacent comment.

- [x] **S0. Fresh mirror on `surface.open`.**
- **Change:**
  - `frame/host-port.ts` `HostPortInput` gains `mirror: () => FrameMirror` and exposes `refreshMirror()`, which posts `{ type: "mirror", mirror: untrack(input.mirror) }`;
  - `frame/host-registrations.ts` `FrameEndpoints` gains `refreshMirror`;
  - `frame/host-surfaces.ts` `frameSurfacePage(registration, routes, invoke, refreshMirror)` calls it immediately before `invoke({ method: "surface.open" … })`, so port order guarantees the frame applies it first;
  - `frame/host-link.ts` passes `mirror: () => frameMirror(api, services)`.
- **Tests:**
  - `host-surfaces.test.ts`: the mirror is posted before `surface.open` and carries the current project;
  - `surface-round-trip.test.ts`: switch project, open, and `surface()` sees the new id.
- **Flow 61:** switch project, open the fixture page, and it names the new project. Red run: remove the `refreshMirror()` call.
- **Checks:** app test (`src/plugins`), typecheck, check, e2e 61. No ratchet change.
- Progress: done (app-plugin-host lane). A plugin page has a current project only when its route names one (`currentProjectId` reads the placement, else the page's `:projectId`), so the flow 61 fixture opens a second page, `/surface-fixture/projects/:projectId`, from a per-project Button; red run without `refreshMirror()` shows "No project". The app budget's "Web plugin frame" part (which counts its tests) rose to the measured 1337 and the total to 112850.
- [x] **S1. Composer document leftovers.**
- Delete or rename per §2(g); `slash-popover` keeps only file and mention options.
- **Checks:** app test (`src/composer`), typecheck, check (budget for Composer drops), e2e `06-composer.spec.ts`, `34-live-plugin-desktop.spec.ts`, `35-live-plugin-web.spec.ts` (plugin mentions).
- Progress: done (app-plugin-host lane). The `agent` AtOption had no producer and went with `document`; the mention row shows the source's group. Composer budget lowered to the measured 14031, total 112807. No new assertion: `/docs` was already filtered out of the slash list, so nothing a person sees changed. Flows 06 and 35 pass on web and phone, except 06's explicit-model case, which drives the machine's real `claude` CLI and read its label as "Haiku 4.5" where the spec expects "Haiku". Flow 34 is not verified (the desktop project cannot start Electron in this container; see S5).
- [x] **S2. Input events, `Image`, status glyphs.**
- Implement §3.0 and S2 in the catalog, spec check, renderer, design guide and `ui_guide`.
- **Tests:** plugin-api spec tests (collisions, Image URL rule, agent-only refusals); app `src/surface` tests (supplied fields, change fires after the write, Image refusals).
- **Flow 61 fixture:** an `Image` with a data: URL paints; an https URL shows the refused slot and makes no request; a `ChoicePicker.change` reaches the plugin.
- **Checks:** plugin-api test and typecheck; app test, typecheck and check (raise the surface budget in `budget.ts` to the measured lines with its owner, no headroom); mcp test (`surfaces`); ratchets plus `bun run --cwd packages/claxedo-desktop verify:closure` (desktop-renderer modules grow by the new view files; record the exact number).
- **As built:**
  - `Image` takes its required `accessibility` (`label` required) in its own shape instead of a refinement, so the `ui_show` JSON Schema states it;
  - `surfaceImageUrl(value, origin?)` refuses every `blob:` when the origin is absent or opaque (`"null"`), so the spec check refuses a literal blob and the desktop's `file:` renderer accepts none; Tasks images use `data:` (§4);
  - `checkSurfaceSpec`'s `producer` option lands with the first plugin-only prop in S3; S2 adds none;
  - the renderer adds `submit-key.ts` (Enter; Mod+Enter or Mod+S in `longText`) and `tab-strip.ts` `selectedTabIndex`;
  - flow 61's phone arrange opens the drawer until the fixture row is in view: the shell's `navigated` event closes the drawer once the home workspace is chosen, which failed the phone project at the base commit.
- Progress: done 2026-10-18 — input `change`/`submit` events, `Image` (data:/same-origin blob:) and the five status glyphs; desktop-renderer 1483 modules, surface budget 2430.
- [x] **S3. `Board` with `move`.**
- **Tests:** keyboard machine transitions, supplied move fields, the renderer never writes data, pending cleared by a patch to either column.
- **Flow 61 fixture:** drag a card to another column; keyboard Space, ArrowRight, Space; the plugin patches and the card stays.
- **Phone:** the board scrolls and the keyboard path works.
- **Checks:** as S2.
- **As built:**
  - `SURFACE_PLUGIN_ONLY_EVENTS` (`events.ts`) names the plugin-only events, and `checkSurfaceSpec(value, { producer: "agent" })` refuses them at the prop's pointer; `ui_show` checks as the agent producer;
  - the spec check also refuses a reused column key;
  - the pending move settles on the producer's patches only: `SurfaceState.watchPatches` reports each `updateDataModel` path from the store, so a local input write never settles it; while a move is pending no other move starts;
  - the view splits into `board-view.tsx`, `board-lane.tsx`, `board-interaction.ts` (lanes, pending, announcer) and `board-input.ts` (keyboard grab and pointer drop);
  - `move` reports `fromIndex` in the source list and `toIndex` in the target list with the item taken out.
- Progress: done 2026-10-19 — `Board` with pointer drag and the keyboard grab (Space/Enter, arrows, Escape), pending until the plugin's patch; desktop-renderer 1490 modules, surface budget 3073.
- [x] **S4. `FilePicker` and `Combobox`.**
- Move `image-drafts.ts` to `src/surface/image-fit.ts`; the Tasks create form imports it through `@/surface` until S10b.
- **Tests:** accept/size/count/event caps, `fitImages` rounds, paste scope, debounce timing (fake clock), searching state.
- **Flow 61 fixture:**
  - `setInputFiles` with a PNG: the plugin receives bytes and shows an `Image` preview;
  - an oversize file is refused;
  - typing in a `Combobox` streams options and selecting fires `change`.
- **Checks:** as S2 (the no-polling check lists `search-debounce.ts` as the timer owner).
- **As built:**
  - `image-fit.ts` holds only the generic fit (type from the declared type or the name, `shrinkInRounds`, `canvasShrink`, `fitImage`, `blobBase64`, `imageDataUrl`); the Tasks bounds, refusal kinds and their copy moved into `src/tasks/view/image-queue.ts`, and the create form draws previews with `imageDataUrl`;
  - `maxFiles` counts accepted files only; a file the browser cannot read is logged and refused as `type` (the plan's three reasons are kept);
  - the Combobox's listbox sits in flow under its input (no overlay), and "searching" ends on the producer's next patch overlapping the bound options path (`data-path.ts` `pathsOverlap`, shared with the Board);
  - an agent's FilePicker draws disabled and an agent's Combobox never searches; `checkSurfaceSpec(…, { producer: "agent" })` refuses `pick` and `search`;
  - no e2e flow covers the Tasks create form's images; the moved code is covered by `image-fit.test.ts` and `src/tasks` tests.
- Progress: done 2026-10-19 — `FilePicker` (choose, drop, paste; per-file, count and 12 MiB event caps; `fitImages`) and `Combobox` (local filter or 250 ms debounced `search`, `change`); `image-drafts.ts` moved to `src/surface/image-fit.ts`; desktop-renderer 1498 modules, surface budget 3957, Tasks 5014.
- [x] **S5. Plugin API primitives and `AgentConfigurationPicker`.**
- Implement the primitive table; move `cloud-configuration-picker.tsx`, `cloud-model.ts`, `cloud-catalog-*` to `src/composer/`.
- **Tests:** bindings (tab entry, `navigated` without remount, settings surface, `sessions.open` re-reads the catalog once and navigates, `followStart` progress), frame protocol round trips (navigated, settings surface, progress, base64 body).
- **Flow 61 fixture:**
  - the page opens in the page tab;
  - a param change keeps state;
  - a settings surface section draws and `settings.open` reaches it;
  - binary fetch returns exact bytes.
- **Checks:** app test, typecheck and check; plugin-api test; ratchets plus desktop `verify:closure`.
- Progress: done (app-plugin-host lane). Changes from the text above, from the code:
  - `tasks.followRoot` became `cloud.followStart` (`server/cloud.ts`); the Tasks start and `workspaces.followStart` both use it, and `TasksApi` lost `followRoot` with `locateSession`.
  - The frame's `surface.open` names its target, `{ kind: "page", pageId, path, params }` or `{ kind: "settings", sectionId }`; `surface.navigated` and settings `surface: true` are as planned. A `SurfaceSettingsSection` without `group` joins `app`.
  - The host keeps its own standard base64 (`plugins/base64.ts`; `@claxedo/helpers` offers only base64url), so `bindings/data.ts` no longer imports `@claxedo/tasks`.
  - `AgentConfigurationPicker` binds a value shaped by `surfaceAgentConfigurationSchema` (exported as `SurfaceAgentConfiguration`). The renderer draws it through a reference component the host passes in (`SurfaceReferencesProvider`): plugin surfaces get the composer's `AgentConfigurationPicker`, an agent reply gets none and draws a note, so it is inert there. Its `change` supplies `{ value }` through the §3.0 `supplied` argument of `surfaceActionEvent`. After the merge with S2–S4: `SURFACE_PLUGIN_ONLY_COMPONENTS` (`events.ts`) makes it plugin-only as a whole, since its `change` is optional, so `checkSurfaceSpec(…, { producer: "agent" })` refuses it at `/component`; the design guide (served by `ui_guide`) has an "Agent configuration" section, the `ui_show` description says it is refused there, and the transcript checks an agent's `ui_show` input as the agent producer (`surface-reply-spec.ts`).
  - The whole configuration editor moved, not just the cloud pickers: `presets/configuration-editor.tsx` is `composer/agent-configuration/agent-configuration-picker.tsx`, with `rebaseConfiguration` applied inside the picker; the composer's type is the catalog's `SurfaceAgentConfiguration`, because app code may not declare `providerID`/`modelID`.
  - Flow 61 adds a tab page with a param route, a surface settings section holding an `AgentConfigurationPicker`, and a byte fetch of a task attachment (fixture routes `/api/claxedo/tasks`). The phone opener now waits for the home redirect before opening the rail; a tap before it was closed by that navigation.
  - Desktop-renderer modules 1481 → 1491 (the ten new owners named in `desktop.ts`). Budgets: Composer 14376, Plugin host 2650, Web plugin frame 1618, Surface renderer 2359, Tasks 4754, total 113505. Merged with S2–S4: desktop-renderer 1508 (their 1498 plus these ten), Surface renderer 4057, Tasks 4658, total 115118 (115107 at the merge, plus the transcript's agent-producer test); the picker's `change` is declared in `SURFACE_EVENT_FIELDS` and fires through S2's `supplied`; flow 61 holds both lanes' cases on one fixture page (the per-project buttons became `project-links`, since S4's Combobox owns `project`).
  - Not verified here: flow 34 (desktop). This container runs as root and Electron exits with "Running as root without --no-sandbox is not supported"; `00-desktop-smoke` fails the same way at fixture setup.
- [x] **S6. Server plugin contract and bootstrap capabilities.**
- Add `server-core/src/plugins/server-plugin.ts`.
- Local: `StartLocalServerOptions.plugins`. Interim builders `createLocalTasksPlugin` (from `local-server/src/tasks/`) and `createLocalDocumentsPlugin` (from `app/local-documents.ts`) wrap today's code in place.
- Hosted: `HostedCoreAppOptions.plugins`; interim hosted builders wrap `tasks-contributions.ts` and the R2 backend in place.
- Bootstrap `capabilities`; app capability reads; manifest `requires` open ids.
- **Delete:** `tasksGrants`, `documents` option, `deployment.documents`, `PLUGIN_CAPABILITIES`, `queries.tasks.availability` and its key and freshness entries.
- **Tests:** local bootstrap and route mounting (`/api/claxedo/tasks`, `/documents` answer as before), hosted shell bootstrap per profile, app `server/capabilities.test.ts` and wire tests, plugin-api manifest tests, duplicate plugin id refused.
- **Checks:** local, server, app, plugin-api tests; typecheck all; ratchets; `verify:closure` for local-server and server; e2e 12 (boot reads nothing under Tasks), 34, 35, 53, 54.
- **As built (recorded where the code proved the interface wrong):**
  - `LocalServerPlugin.routeContributions(host: LocalServerPluginHost)` is a function of the host's `{ authConfig, verifier }`: the local `/documents` routes verify a signed caller with the host's own `services.auth`, which the composition root does not hold. `HostedServerPlugin.routeContributions` stays an array; `ServerPluginBase` carries `id`, `capability` and `mcp`.
  - Deleting `tasksGrants` needs the grant to come from the plugin, so `mcp.service` (`McpServiceContribution`) lands here; `TasksGrant` in `@claxedo/mcp` became `McpServiceGrant` (`operations: string[]`). Until S7 the local mount maps `services.tasks` and `services.documents` onto the client's existing fields.
  - The hosted bootstrap now reports `documents`: the core Worker mounts `/documents` in every profile, where it used to declare `documents: false`. No app plugin requires it yet.
  - Interim builders: `claxedo-server/src/deployments/hosted-workerd/tasks-plugin.ts` (renamed from `tasks-contributions.ts`) and `claxedo-server/src/documents/hosted-plugin.ts`, which resolves the authority from `services` at request time.
  - `PluginCapability` stays as `string` with `isPluginCapability` and `PLUGIN_CAPABILITY_PATTERN`; `PluginHost.required`, which only gated the probe, is gone.
- Progress: done (lane C). Ceilings: local-server 74→73 (`app/local-documents.ts` left the entry), server-workerd 174→175 and the deployment closures 174/233/245→175/234/246 (`documents/hosted-plugin.ts`), desktop-renderer 1481→1480 (`server/availability.ts`). Verified: local, server (+ `scripts/sandbox/cloudflare-worker`), plugin-api tests and app `src/server`, `src/plugins` tests, app `check` and `typecheck:e2e`; `bun turbo typecheck --concurrency=2`; ratchets; local-server and server `verify:closure`; e2e 12-workbench-shell and 35 on web and phone. OpenCode-backed suites need Node 24 (`patches/README.opencode-node.md`); they pass under 24.18.0. Not verified: e2e 53 and 54 (the hosted sandbox worker's local brokering driver runs only on macOS) and 34 (no Electron binary in this container).
- [x] **S7. MCP tool group contribution.**
- Add `@claxedo/mcp/tool-group`; generic `services` grants.
- Move `tools/tasks.ts` (+ test) to `packages/claxedo-tasks/src/mcp/`; the local and hosted `mcp` contributions supply `services.tasks` (`TASKS_OPERATIONS` stays the local operation set) and `services.documents`.
- The sandbox `first-party-mcp.ts` builds `services.tasks` from today's `tasks-grant.ts` (moved in S8b).
- Composition roots pass composed group lists.
- **Delete:** `ClaxedoMcpClient.tasks/documents`, `McpToolGrants.tasks`, the `"tasks"` denial code, the static tasks group, `@claxedo/tasks` from `claxedo-mcp/package.json`.
- **Tests:**
  - mcp (refusal texts unchanged, pinned tool lists unchanged per mount, inventory includes plugin groups in composition order);
  - local `test-support/first-party-mcp-live.ts` (a session reaches Tasks with its grant, a session whose group is off reaches as the machine user);
  - server (hosted MCP, agent-plugins catalog inventory);
  - tasks (moved tool tests).
- **Checks:** typecheck all; ratchets; e2e 40.
- **As built:**
  - `McpServiceGrantInput.workspaceId` is optional: the hosted mount grants services to an account credential, which belongs to no workspace. The hosted `/api/claxedo/mcp` asks each composed plugin's service for an account credential and enters the app with the caller's own authorization; a runtime credential there gets none, as before.
  - `mcpToolGroups(plugins)` in `server-core/src/plugins/server-plugin.ts` is the one composition of core plus plugin groups; the local start, the desktop and e2e entries, the core Worker root and the Agent Plugins entry use it. The hosted catalog (`createHostedAgentPluginsComposition({ toolGroups })`) is handed `mcpToolGroups([tasks])` by the Agent Plugins entry, which therefore builds the Tasks plugin first and reads the group switches through closures. The Documents plugin is composed by the core Worker root and contributes no group yet; S11c must give the catalog its group too.
  - `claxedoMcpToolGroupsFor` had no caller and is deleted.
  - Tasks tools declare `service: { id: "tasks", label: "Tasks", operation }`; Documents tools keep no service gate, so their listing per mount is unchanged and they refuse at the call where no `services.documents` was granted.
  - The hosted Tasks plugin contributes its group only: an account credential on the plane was never granted Tasks. The sandbox runtime composes `TASKS_MCP_TOOL_GROUP` and its `services.tasks` in `runtime-boot.ts` until S8b.
  - The transcript roster equality moved to `@claxedo/tasks` (`src/mcp/tools.test.ts`), the one package that sees the core and the Tasks groups; `@claxedo/mcp` asserts its core tools are in the roster.
- Progress: done (lane C). Verified: mcp (196) and tasks (303, with the moved tool tests) suites; local-server (844, Node 24) and server (2905 plus the sandbox worker's 118) suites; `bun turbo typecheck --concurrency=2`; ratchets (no ceiling moved); `docs:check-links`. e2e 40: pi passes on web; the claude, codex and opencode cases fail identically at the base commit 789ec97 in this container (no codex CLI; the claude and opencode turns never call the tool), so they are not evidence either way.
- [x] **S8a. SQLite schema contributions; Tasks shared host and local move.**
- `configureClaxedoSchema`; move the six task migration folders; `server-core/src/tasks-host/*` → `packages/claxedo-tasks/src/host/*` and `storage/sqlite/*`; `local-server/src/tasks/*` → `packages/claxedo-tasks/src/local/*`.
- Update the three journal-copying build scripts; the desktop and harness entries call `configureClaxedoSchema` first.
- **Tests:**
  - a DB with full history migrates to the same `__claxedo_migrations` rows and the same `sqlite_master` dump as before (golden dump recorded at the base commit);
  - a fresh DB matches;
  - a duplicate name throws;
  - moved tasks-host tests run in `claxedo-tasks`.
- **Checks:** core, local, tasks tests; `bun run --cwd packages/claxedo-desktop test:server-boot`; typecheck all; ratchets; local-server `verify:closure` (modules drop by the moved files; lower the ceiling to the measured number); `rg -n "tasks-host" packages` returns nothing.
- **As built:**
  - `configureClaxedoSchema({ journals })` lives in `platform/db/db.ts` and takes journals only; `repair` contributions arrive with the first plugin that needs one (Documents, S11b). `SqliteSchemaContribution` and `claxedoSchemaJournals(plugins)` live in `server-core/src/plugins/server-plugin.ts` beside `LocalServerPlugin.sqliteSchema`. Entries sort by timestamp, then name.
  - The Tasks journal directory is `packages/claxedo-tasks/src/storage/sqlite/claxedo-tasks-migration/`, not `migrations/`: a bundled server copies every journal beside its chunks under the directory name its module resolves, so the name must be unique. `TASKS_SQLITE_SCHEMA` (`@claxedo/tasks/storage/sqlite`) names it.
  - `@claxedo/tasks/host/*` publishes each former `tasks-host` module under its own name, so hosted callers keep importing one module each; `./storage/sqlite` and `./local` are single entries. The `WORKSPACE_RUNTIME_TASKS_*` names and `workspaceRuntimeTasksCapabilityEnv` moved from `server-core/src/hosts/workspace-runtime/env.ts` to `@claxedo/tasks/host/runtime-env`, so `@claxedo/server-core` no longer depends on `@claxedo/tasks`.
  - Tests that drive the real desktop-local app stay in `@claxedo/local-server` as host tests (`src/app/tasks-plugin.test.ts`, `src/app/tasks-session-bridge.test.ts`); the moved `tasks-host` tests run under `bun test` in `@claxedo/tasks`. Each server package's vitest setup names the journals its tests open (`src/test-support/claxedo-schema.ts`, `src/app/test-support/claxedo-schema.ts`), because the engine no longer configures itself.
  - Build scripts: `claxedo-desktop/scripts/local-server.ts` `resolveServerMigrationJournals` resolves the host and Tasks journals and refuses a name in two of them; `bundle-claxedo-server.ts` copies both. `claxedo-local-server/scripts/build.ts` still copies the host journal only: its `self-hosted-execution` entry composes no plugin.
  - The golden test is `packages/claxedo-tasks/src/storage/sqlite/claxedo-schema.test.ts`: the 66 applied names in order and the sha256 of the 607 `sqlite_master` rows, recorded at 789ec97.
- Progress: done (lane C). Verified: tasks (381, incl. the moved host and store tests and the golden schema), server-core (1213), local-server (844, Node 24) and server (2906) suites; desktop `scripts/local-server.test.ts` and `build-compile-cache.test.ts`; `predev` then `test:server-boot` (the bundle carries `claxedo-migration` and `claxedo-tasks-migration` beside the entry and in `chunks/`; the darwin-only cases skip); `bun turbo typecheck --concurrency=2`; ratchets; local-server `verify:closure`. The product entry stays 73/28 (`src/tasks/` was never reached from `self-hosted-execution.ts`); the package-wide walk in `local-closure.test.ts` is now 96/28, set exactly. `tasks-host` appears nowhere under `packages`.
- [x] **S8b. Hosted Tasks, D1 fragment, cloud-root grants, runtime host.**
- `claxedo-server/src/tasks/*` → `packages/claxedo-tasks/src/hosted/*` behind `HostedTasksPorts`: authority, runtime client factory, `sandboxStart`, `sandboxUsage`, `cloudCreateAdmission` (stays in `claxedo-server/src/workspace/`), signing env, passes, D1. `d1-host-reads.ts`: see Q5.
- `tasks-contributions.ts` → `createHostedTasksPlugin`.
- `rootGrants` replace every Tasks name in `agent-plugins/hosted-composition.ts`.
- `hosts/workspace-runtime/tasks-grant.ts` → `@claxedo/tasks/runtime-host`, composed by `runtime-boot.ts` through `RuntimeHostPlugin`:

  ```ts
  // packages/claxedo-server-core/src/plugins/runtime-host.ts
  export type RuntimeHostPlugin = {
    id: string
    start(env: NodeJS.ProcessEnv, input: { ownerGrant?: unknown }): RuntimeHostPluginInstance | undefined
  }
  export type RuntimeHostPluginInstance = {
    mcpServices?: Readonly<Record<string, McpServiceGrant>>
    routeContributions?: readonly WorkspaceRuntimeRouteContribution[]
    dispose(): void
  }
  ```

- Env names are unchanged and declared by the plugin; `process-ownership/src/spawn-env.ts:49-51`: see Q9.
- Split the D1 baseline per §2(b).
- **Tests:**
  - unit tests move with code;
  - workerd and composition tests stay in `claxedo-server` as host tests (`src/deployments/hosted-workerd/tasks-plugin.workerd.test.ts` from `hosted-task-start.workerd.test.ts` and `hosted-composition.test.ts`);
  - the baseline hash test.
- **Checks:** server and tasks tests; `bun run --cwd packages/claxedo-server d1:baseline:check`; typecheck all (incl. `typecheck:auth-d1`); ratchets; server `verify:closure` (lower to measured); `rg -n "BUILTIN_TASKS_TOOL_GROUP|tasksGrant|claxedo-server/src/tasks" packages` returns nothing.
- **As built:**
  - `@claxedo/tasks/hosted` holds the composition, the session bridge and reservation, the capability, the root capability and its renewal route, and the D1 host reads; `createHostedTasksPlugin(ports: HostedTasksPorts)` returns the `HostedServerPlugin` with its routes, MCP group and one `rootGrants` entry (`group: "tasks"`, `TASKS_CAPABILITY_AUDIENCE`, `tasks_group_disabled`). `@claxedo/tasks/storage/d1` holds `createD1TasksStore` and `TASKS_D1_SCHEMA_DIR`; `./storage/d1/schema` exports only the directory, for the baseline scripts.
  - `HostedTasksPorts`: `authority` (`WorkspaceAuthority`), `database`, `signed` (the deployment's signed-request reader), `reads`, `runtimeClient`, `registrations` (`reservation` and `compensation`, the two halves of `PrivateSessionAuthority` the bridge uses), `cloudRoots`, `cloudPlacement`, `cloudSelectedCapabilities`, and `grants?` (`signingEnv`, `passes`, `groupEnabled(group, root)`, `ownerGrant?`). `sandboxStart`, `sandboxUsage` and `cloudCreateAdmission` are not ports: the cloud-root allocation that uses them (admission, `allocateOriginCloudWorkspace`, `startCloudWorkspace`, the creator's authority door) is host code, `claxedo-server/src/deployments/hosted-workerd/tasks-plugin/cloud-roots.ts`, behind the plugin's `TasksCloudRoots` port (`refusal(root)`, `allocate(root, creator, capabilities)`). The plugin keeps what is Tasks': the origin key, the root's display name, which identity creates it, and how a Start dispatches.
  - `claxedo-server/src/deployments/hosted-workerd/tasks-plugin/compose.ts` (`composeHostedTasksPlugin`) implements the ports from `ControlPlaneServices`; `hostedTasksIdentityPorts` and `hostedTasksBridgePorts` are also what the host tests compose with.
  - The sandbox pass family (`sandbox-pass.ts`, `sandbox-pass-register.ts`, `runtime-token-keys.ts`) moved to `server-core/src/platform/auth/`, and `half-life-renewal.ts` plus `controlPlaneOrigin` (`control-plane-origin.ts`) to `server-core/src/hosts/workspace-runtime/`: the Tasks capability and its runtime renewal are passes and renewals of that family, and a plugin cannot import `@claxedo/server`. The D1 register and its tests stay in the server.
  - Q5: `d1-host-reads.ts` moved into the plugin, because it anti-joins the plugin's `task_session_links`; it takes the sandbox workspace directory as `cloudWorkspaceDirectory` rather than depending on `@claxedo/sandbox-manager`. Its host contract test is `tasks-plugin/host-reads.test.ts`, against the deployed baseline.
  - `CloudRootIdentity` and `CloudRootGrantContribution` live in `server-core/src/plugins/server-plugin.ts`. `createHostedAgentPluginsComposition` takes `rootGrants` and lists the core owner grant as one more entry (`subagents`, `OWNER_GRANT_AUDIENCE`, `subagents_group_disabled`), so the launch environment, the switch's withdrawal and the renewal reads are one loop over grants; it exposes `groupEnabled(group, root)` instead of `tasksGroupEnabled`/`subagentsGroupEnabled`. `grant-withdrawal.ts` moved to `agent-plugins/runtime/`.
  - `RuntimeHostPlugin` (`server-core/src/plugins/runtime-host.ts`) carries `mcp.groups`, and its instance answers `mcpServices()` per MCP session (a grant can lapse) and `dispose()`, which `runtime-boot.ts` calls on drain. There is no `routeContributions` on it yet: Tasks contributes no runtime route. `ownerGrant` is typed `{ swap(token) }`. Both host entries pass `tasksRuntimeHostPlugin`.
  - `BUILTIN_TASKS_TOOL_GROUP` is gone: the local plugin takes `enabledGroups: () => readonly string[]` and checks its own group id, and the hosted plugin names `TASKS_MCP_TOOL_GROUP.id`. The renewal route is `tasksCapabilityRenewalContribution` (its id is still `claxedo-tasks-grant`).
  - Q9: `process-ownership/src/spawn-env.ts` keeps the `WORKSPACE_RUNTIME_TASKS_*` names literal; they are `@claxedo/tasks/host/runtime-env`'s and unchanged.
  - Fixed on the way: `claxedoSchemaJournals` moved from `plugins/server-plugin.ts` to `plugins/sqlite-schema.ts`. S8a had made `server-plugin.ts` import the host journal, whose `path.join(import.meta.dirname, …)` throws when a Workers isolate loads the hosted entries (the `smoke:workerd-boundary` gate). Three HLD links S8a left pointing at moved files are repointed.
  - The acceptance search still matches one line outside code: a recorded tool output in `packages/claxedo-app/e2e/corpus/seeds/transcript-lab-fixture.json` that names the old `claxedo-server/src/tasks/session-bridge.ts`. It is a transcript fixture, so it stays as recorded.
- Progress: done (lane C). Verified: tasks (405, incl. the moved capability, root capability and runtime grant tests), server-core (1224), server (2871 passing, 1 skipped; `core-resource-closure.test.ts` now asserts the artifact's host Tasks adapters and the staged Tasks tables, and `control-plane-baseline.test.ts` the per-source path in the check's message) and the sandbox worker's 118, local-server (844, Node 24); desktop `scripts/local-server.test.ts` and `build-compile-cache.test.ts`; `bun turbo typecheck --concurrency=2` (30/30) and `typecheck:auth-d1`; `d1:baseline:check` (both sources current; the combined render keeps sha256 `9d0bb00c…` and `control-plane-schema.test.ts` pins it); ratchets; server `verify:closure`, including the workerd boundary smoke. Ceilings, exact: server-workerd 175→173; deployment closures 175/234/246→173/225/237 (−2 for the sandbox pass family, −8 for `src/tasks/`, +1 for `tasks-plugin/cloud-roots.ts`). `oxlint` clean on the changed packages; `docs:check-links` clean.
- [x] **S9. Bundled first-party path and Tasks tool cards.**
- `vite.plugin-bundles.ts`; `src/plugins/first-party/`; origin union, bundled approval, live-only reconcile, Settings built-in row; reserved ids in the daemon registry.
- `packages/claxedo-tasks` gains the `claxedo` manifest and `src/app/index.ts`, which registers the five task card templates and the dictionary.
- `claxedo-tool-view.ts` drops the task cases and `CLAXEDO_TOOL_TITLE_KEYS` task entries (title keys move to the plugin dictionary); see Q2 for the vocabulary.
- New policy `tasks-app` and `verify:closure` in `packages/claxedo-tasks`.
- `plugins/README.md` rewritten from code.
- **Tests:**
  - app plugin host (bundled is approved without a record, survives a daemon list without it, switch off/on);
  - transcript card tests (template evaluation, task link opens the page);
  - daemon refuses a live plugin named `claxedo-tasks`.
- **Flows:** 30 corpus snapshots unchanged once the plugin registered (the transcript upgrades the generic row reactively; R9); 34, 35 unchanged; 12 unchanged.
- **Checks:** app test, typecheck and check; local test; ratchets plus desktop and tasks `verify:closure`.
- **As built (recorded where the code proved the text wrong):**
  - `vite.plugin-bundles.ts` runs `@claxedo/plugin-build` under Bun as a child process (`@claxedo/plugin-build/app-bundle-cli`) instead of importing it: Vite's config loader leaves workspace packages external, and Node cannot load their extensionless TypeScript source. The desktop renderer extends `cloudConfig`, so it gets the plugin without its own entry. The chunk holds the bundle as a string; the bundle resolves `@claxedo/plugin-api` from the runtime global, so `tasks-app` measures 3 modules and 1 package.
  - `@claxedo/tasks` gains no `./app` export, so no app source can import the entry statically; the specifier is resolved by the Vite plugin from the manifest's `claxedo.app`. The manifest declares `requires: ["tasks"]` and no routes yet (the cards fetch nothing; S10 adds `/api/claxedo/tasks` and `/api/claxedo/plugins`).
  - `FIRST_PARTY_PLUGIN_IDS` is `["claxedo-tasks"]`; S11c adds `claxedo-documents` with its entry. The daemon refuses a live plugin with a first-party id (`409 live_plugin_id_reserved`) and does not load one already in its registry (logged).
  - `TranscriptApi.toolCards` landed here (S5 had not added it). `ToolCardText` gained `{ path, max }` (a clamp) and `{ format }` (placeholders `{/pointer}`, resolved only when every one does), which the task labels (`#key title`, else `#key`, else title, else a short id) need. `ToolCardStatus` is `{ value, states: { [value]: { label, icon, tone } } }`, so status words, catalog glyphs and tones are the plugin's; the pill styles by `data-tone`. A `rows.link` is required; `rows.continued` is the "more available" line. Notes show the first that holds. Templates are checked with `readToolCardTemplates` in the host binding, so a frame's and a desktop plugin's are checked alike, and a tool that already has a card is refused. The task numeric-id label (`#12` for a bare number) was dropped: task ids are `tsk_…`.
  - Card templates are evaluated in `transcript/tool-card-template.ts` only for a tool with no core case. A page link resolves to the plugin's own page first, then an app page of that id (shared with `pages.open`, `bindings/services.ts` `pageEntryFor`), so the Tasks card links reach today's app Tasks page at `/tasks/:taskId?` until S10b registers the plugin's.
  - Task links did not work even with an href: the timeline's file-link capture (`session/view/timeline/timeline-file-paths.ts`) took every root-relative anchor as a file path. It now skips anchors carrying `data-link-kind`, which fixes the card's session links too.
  - The JSON Pointer parser moved from `surface/data-path.ts` to `lib/json-pointer.ts`, shared by the surface and the transcript (the helper-divergence ratchet).
  - Titles are localized at activation (the plugin dictionary has `en` only, as the old task keys did); a later locale change keeps the activation's words.
  - The bundled plugin is listed in Settings → App plugins wherever the app runs, and says it needs `tasks` where the server does not mount Tasks.
  - The roster tests that read `CLAXEDO_TOOL_TITLE_KEYS` by text (`claxedo-mcp/src/tools/inventory.test.ts`, `claxedo-tasks/src/mcp/tools.test.ts`) follow its new declaration; the Tasks one asserts core titles plus the Tasks entry's cards equal the composed inventory.
  - Flow 12 asserts the status pill's words and `data-tone`; flows 34 and 35 assert the built-in Tasks row remains after the fixture is removed, and 35 that safe mode keeps it on. New flow 36 (web and phone). `tasks` verify:closure runs in `test:architecture-ratchets` (source) and by hand; no CI step was added (CI selects closure steps through `script/ci-changes.mjs` outputs).
- Progress: done (first-party-plugin-bundling lane). desktop-renderer 1507 → 1513 (the six owners named in `desktop.ts`); `tasks-app` 3 modules, 1 package. Budgets: Plugin host 3050, Web plugin frame 1626, Shell and platform 7406, Surface renderer 4040, total 115711; file-size ceiling of `transcript/message-part.tsx` lowered to the measured 2057. Not verified: flow 34 (no Electron in this container), hosted web (flows 53 and 54 need the macOS sandbox driver).
- [x] **S10a. Presets as a plugin settings surface.**
- Plugin `src/app/presets/*`.
- **Delete:** `src/tasks/presets/*` and `presetsSettingsSection` from `registry.ts`.
- The app's Tasks page "Open preset settings" goes to the new section id until S10b (done: the plugin's page opens it).
- **New flow `63-tasks-presets.spec.ts`:** create a Local preset (harness and model via `AgentConfigurationPicker`), edit, archive and restore; a Cloud preset refuses Pi with the kit's reason. Assert one fact read back from `/api/claxedo/tasks/presets`.
- **Checks:** app test, typecheck and check (Tasks budget lowered to measured); tasks test; ratchets plus desktop `verify:closure`; e2e 63 and 15-settings.
- **As built:**
  - The section is `api.settings.section({ id: "presets", group: "workspace", order: 30, surface })` in `packages/claxedo-tasks/src/app/presets/`; its URL is `/settings/claxedo-tasks%2Fpresets` (Q3). The app's "Open preset settings" links there until S10b.
  - Every surface the plugin draws is a pure frame of its state sent through `app/surface/sync.ts` (first frame whole, then changed components and per-path data patches, compared order-free). Inputs tell the plugin nothing until an event, so each editor event carries the whole draft (`/draft`) and the sync is told what the app holds (`observe`); a redraw never overwrites typed text.
  - The capability picker reads `/api/claxedo/plugins` through `server.fetch` (`presets/catalog.ts`); an unavailable plugin or skill is offered only while already chosen. The Cloud Pi refusal is the kit's `cloudPresetHarnessRefusal`, shown at the top of the slot's section. Archive and restore are one row toggle with a bound icon (`visibilityOff`/`visibility`), per the design guide's toggle rule.
  - Host fixes the editor needed: two `AgentConfigurationPicker`s with different models looped forever (the composer's `model-names.ts` `remember` read its LRU store inside the trigger's effect; now untracked, with `model-names.test.ts`), and the surface draws the picker's trigger as a left-aligned field (`surface/view/agent-configuration-view.tsx` wrapper `surface-agent-configuration`, `surface-pickers.css`) instead of the composer's centred ghost button.
  - The manifest names `server.routes` `/api/claxedo/tasks` and `/api/claxedo/plugins`. `tasks-app` uses `@claxedo/helpers` and `@claxedo/agent-runtime-contract` besides the plugin API.
- Progress: done (Tasks-UI lane). Ceilings, exact: `tasks-app` 3/1 → 27/3 (owners named in `policies/tasks.ts`); desktop-renderer 1513 → 1506 (`tasks/presets/*` left the app). Budgets: Tasks 4658 → 3665, Composer 14376 → 14401 (`composer/harness/model-names.test.ts`), Surface renderer 4040 → 4042 (the picker wrapper), total 115711 → 114744. Verified: tasks suite (418) with `src/app/presets/program.test.ts` against the real routes; app `test` (1164), `typecheck`, `typecheck:e2e`, `check`; root `bun run typecheck`; `oxlint`; ratchets; desktop and tasks `verify:closure`; e2e 63 on web and phone, red run with the cloud refusal switched off fails at "Pi cannot run a cloud preset". Flow 15 fails on web and phone at its egress guard (CONNECT api.anthropic.com from the container's real `claude` CLI at `/opt/node22/bin/claude`, during the draft composer and Models steps; it visits no Presets section), so it is not evidence either way.
- [x] **S10b. Tasks page as a plugin surface page.**
- Plugin `src/app/page/*`: sidebar item, `tab: true` page `/tasks/:taskId?`, all views per §4.
- **Delete:**
  - `packages/claxedo-app/src/tasks/**`;
  - `src/server/tasks.ts` (+ test) and its wiring in `server.ts`, `api.ts`, `queries.ts`, `query-keys.ts`, `freshness.ts`;
  - `rail/view/utility-pages.tsx` `tasksPage` and `TASKS_PATH`, `rail/i18n.ts` Tasks keys, the `global-navigation.tsx` Tasks row;
  - `registry.ts` entries;
  - `budget.ts:29`, `freshness.ts:17-20`, `css-invalidation.ts:15`;
  - `desktop.ts:672-693` comments.
- `@claxedo/tasks` becomes an app devDependency (bundle input only).
- `plugins/bindings/data.ts` takes base64 from `@claxedo/helpers`.
- **Flows:**
  - 12 updated to select by role and name;
  - new `63-tasks-board.spec.ts`: create with a pasted image and a picked image; board move by drag and by keyboard (assert status read back); detail edit and stale-revision conflict; add a subtask; Start a Local preset opens the session (scripted ACP harness);
  - new `63-tasks-cloud-start.spec.ts`: Start on a Cloud preset shows wake progress and opens the session (local sandbox driver, as flow 24).
- **Checks:** app test, typecheck and check; tasks test; ratchets plus desktop `verify:closure` (lower desktop-renderer modules by the measured drop); e2e 12, 63-*, 33-phone.
- As built:
  - The page is `api.pages.register({ id: "tasks", path: "/tasks/:taskId?", tab: true, icon: "checklist", surface })` with `api.sidebar.item`, in `packages/claxedo-tasks/src/app/page/`; the plugin README names its machines. The project Combobox follows the host's project list through a Solid effect, so `solid-js` is a peer dependency of `@claxedo/tasks` (provided by the plugin runtime; bun.lock +4 lines).
  - Deleted as listed, plus the surface index's `fitImage`/`imageDataUrl` re-exports the old create form used; `freshness.ts` and `query-keys.ts` lost `tasksAll`. The rail's Tasks row is the plugin's sidebar row, so it now follows Marketplace (plugin rows come after app rows).
  - A row moves on touch through its previous and next arrow tools (the Board has no touch drag), not a per-row status picker; the detail has a status dropdown. Buttons have no `disabled`, so the detail always shows Discard changes and Save changes. Presets are reread on every navigation, so a preset made in Settings is offered on return.
  - Host fixes found on the way: a deep link to `/tasks/<id>` at a cold load lost its param because the plugin page registers late (`plugins/surface-page/page-params.ts` now compares with the params the page opened with); the messages of one `send` now land as one Solid update (`plugins/surface-page/controller.ts`), so an `AgentConfigurationPicker` mounted by a frame reads the value sent with it; and the composer's `DraftHarnessPicker` seeds the saved model with the harness switch. Before these two, opening a saved preset in the editor and saving it replaced its model with the harness's default.
  - Not done: `plugins/bindings/data.ts` keeps the plugin host's `plugins/base64.ts`, because `@claxedo/helpers` deliberately offers only base64url (see `packages/claxedo-tasks/src/attachments.ts`); `63-tasks-cloud-start.spec.ts` is not written, because the local sandbox driver needs macOS here (flow 24 fails at "local brokering test driver requires macOS sandbox-exec network policy"); the cloud start's progress, second start and failure are covered by `page/program.test.ts`.
- Progress: done (Tasks-UI lane). Ceilings, exact: `tasks-app` 27/3 → 50/4 (owners in `policies/tasks.ts`); desktop-renderer 1506 → 1473 (`tasks/**` and `server/tasks.ts` left the app). Budgets: Tasks part removed; Plugin host 3050 → 3088 (the page-params and send-batching fixes with their tests), Composer 14401 → 14400, Surface renderer 4042 → 4037, total 114744 → 110938. Verified: tasks suite (425) and typecheck; app `test` (1155), `typecheck`, `typecheck:e2e`, `check`; root `bun run typecheck`; `oxlint`; ratchets; tasks and desktop `verify:closure`; e2e 12, 33, 36, 61, 63-tasks-board and 63-tasks-presets on web and phone (33 passed, 17 skipped by project). Red runs: 63-tasks-board with paste switched off fails at the pasted preview, with the board move switched off at the In progress lane; 63-tasks-presets without the picker seed fix fails at the edited row's model, and without the send batching at the same row; the controller's batching unit test fails without the batch. Not verified: flow 34 (no Electron here) and a cloud Start end to end (above).
- [ ] **S11a. Documents plugin: runtime hydration and lifecycle hooks.**
- Create `packages/claxedo-documents` with `./runtime`.
- Move `workspace-runtime/src/routes/document-hydration*.ts` and `document-job-capability.ts` (+ tests).
- Session-core `sessionLifecycle` and `contribution_write`; context additions; composition roots per §2(e).
- **Tests:** moved hydration and auth tests; session-core lifecycle order and failure semantics (turn-settled failure logged, delete aborted on failure); hosted runtime broker asks `contribution_write`.
- **Checks:** session, runtime, documents, server, local tests; typecheck all; ratchets (`session-core-node-free`); `rg -n "document_write|flushSessionDocuments|disposeSessionDocuments" packages` returns nothing.
- Progress:
- [ ] **S11b. Documents server.**
- `server-core/src/documents/**` → `@claxedo/documents` (`.`, `./http`, `./local`, `./storage/sqlite`); `local-server/src/app/local-documents.ts` → `./local`.
- `claxedo-server/src/documents/**` and `authority/adapters/d1/document-authority.ts` → `./hosted` behind `HostedDocumentsPorts` (authority, session resolution, runtime broker relay client, env, rate limit).
- `core-worker.cf.ts` binding check moves into the plugin builder.
- Two or more SQLite folders and `repair.ts` document DDL move into the plugin's `SqliteSchemaContribution`; the D1 `document_shares` fragment moves.
- The legacy-surface and legacy-revision guards move.
- **Tests:** moved unit tests; workerd and miniflare tests stay host-side as composition tests; migration golden dump unchanged; baseline hash unchanged.
- **Checks:** core, local, server, documents tests; `d1:baseline:check`; typecheck all; ratchets; local-server and server `verify:closure` (lower to measured; update `local-server.ts:97` and `server.ts:62-66` comments); e2e 34, 35.
- Progress:
- [ ] **S11c. Documents MCP, CLI, operations, tool cards.**
- `claxedo-mcp/src/tools/documents.ts` → `./mcp`; `cli/src/commands/documents.ts` → `./cli` via `CliCommand`; `helpers/src/claxedo-document.ts` → `@claxedo/documents`.
- `documents.*` operations → `./operations` with `hostedOperationTable`; `response: "bytes"` replaces the main special case.
- Documents app entry registers its two card templates (Q4).
- **Tests:** mcp pinned lists; cli `documents.test.ts` and `claxedo help` snapshot; account-contract table tests (duplicate refused, exposure); desktop `test:broad` (IPC channel inventory equals the composed table, `documents.export` envelope).
- **Checks:** typecheck all; ratchets; desktop `verify:closure` (desktop-main-composition gains the operations module: record exactly); e2e 34, 35, 30.
- Progress:
- [ ] **S12. Docs and final ratchets.**
- Move `src/tasks/README.md` content into `packages/claxedo-tasks/README.md`; write `packages/claxedo-documents/README.md`.
- Update `src/plugins/README.md`, `src/surface/README.md`, the plugin plan's catalog notes, and the `docs/plans/README.md` entry.
- `script/first-party-plugins.test.ts` final allowlist.
- Run every product `verify:closure` and lower the ceilings.
- **Checks:**
  - full app `check`, `typecheck` and `test`;
  - `bun run typecheck`;
  - ratchets;
  - `bun run docs:check-links`;
  - the affected e2e flows once: 12, 30, 33, 34, 35, 40, 60, 61, 63-*.
- Progress:

## Risks and open questions

- **R1. Hosted code reaches `claxedo-server` internals.**
- Problem: `tasks/session-bridge.ts`, `d1-host-reads.ts`, `documents/backends/hosted/*` and the document authority use `services`, `requireAuthority`, D1 helpers and relay clients.
- Recommendation: define narrow ports per plugin (`HostedTasksPorts`, `HostedDocumentsPorts`) in the plugin's `./hosted`, implemented by the worker entry from existing owners. Move one file family at a time inside S8b and S11b, keeping each test green. Never let a plugin import `@claxedo/server`: the ratchet fails.
- **R2. Journal order and early DB open.**
- Recommendation: global timestamp sort plus a unique-name check; the golden `sqlite_master` and `__claxedo_migrations` test; `configureClaxedoSchema` as the first statement of each composition root.
- The desktop entry comment at `entry.ts:24-38` already records that Agent Plugins opens `claxedo.db` early.
- **R3. D1 byte identity.**
- Recommendation: render the combined baseline in memory and pin its sha256 to today's file in the split commit. Deploys stage the combined render only.
- **R4. Bootstrap `capabilities` version skew.**
- Problem: desktop and daemon ship together, but hosted web and the hosted worker deploy separately.
- Recommendation: deploy the worker before the web app. A new app against an old worker shows no Tasks until the worker updates. No compatibility read is added (repo rule).
- **R5. Visual parity.**
- Problem: `tasks.css` and custom status icons give way to surface defaults, status glyphs and Badges. The live pulse animation goes.
- Recommendation: accept the surface look; verify every screen by screenshot per the `a2ui-surface-design` skill. Ask the owner before adding any Tasks-specific style hook to the catalog.
- **R6. Web-frame cost.**
- Problem: every data patch crosses `postMessage`.
- Recommendation: keep server paging (Load more) and per-item patches. Measure a 200-task board (patch-to-paint, keystroke-to-paint) in S10b only if the owner asks for benchmarks.
- **R7. Workerd tests in a plugin package.**
- Recommendation: keep workerd and miniflare tests in `claxedo-server` as host composition tests; move plain unit tests.
- **R8. Runtime composition roots.** See Q6.
- **R9. Transcript cards before the plugin activates.**
- Problem: a task card renders as the generic row until templates register.
- Recommendation: the registry is reactive, so the row upgrades in place. The corpus flow waits on the upgraded card.
- **Q1. Package home.** Recommendation: `packages/claxedo-tasks` (`@claxedo/tasks`) and `packages/claxedo-documents` (`@claxedo/documents`), not `plugins/*` (reasons in §1). Owner may prefer `plugins/*`; that needs workspaces, CI globs and `ci-changes.mjs` updates.
- **Q2. Tool-name vocabulary.**
- Problem: `task_*` and `documents_*` stay in `agent-runtime-contract/src/tool-names.ts` and `tool-header.ts` `CLAXEDO_RESULT_ROWS`, because they are stored in every transcript that called them and the header projection reads them server-side.
- Recommendation: keep them as persisted vocabulary (like table names), with a guard test that each name is registered by exactly one MCP group, core or plugin.
- Alternative: a size-bounded header rule for all `claxedo` tools, which changes first-page payloads.
- **Q3. Settings URL.** The Presets section id becomes plugin-scoped (`claxedo-tasks/presets`), changing `/settings/tasks-presets`. Recommendation: accept; links go through `api.settings.open`.
- **Q4. Documents app entry.** Recommendation: a minimal app entry that only registers the two `documents_*` card templates. Without it those cards regress to generic rows. The user said "no UI for now"; confirm that tool cards are acceptable.
- **Q5. `d1-host-reads.ts`.** It joins host tables. Recommendation: replace its joins with `WorkspaceAuthority` reads where they exist. Otherwise move it into the plugin with a contract test naming the host columns it reads.
- **Q6. Standalone `workspace-runtime` CLI.**
- Problem: `cli.ts` serves relay exposure but cannot import `@claxedo/documents` (dependency cycle).
- Recommendation: find which deployments run the bare CLI (`rg -n "workspace-runtime/dist/cli|\"workspace-runtime\"" packages script .github`). Move document-serving composition to a host package (`claxedo-host-serving` or the sandbox `runtime-boot.ts`). If nothing runs the bare CLI with relay exposure, it serves no documents.
- **Q7. Route breadth.** `server.routes` prefixes allow every method. The Tasks plugin needs `/api/claxedo/plugins` only for a GET. Recommendation: accept for the first-party plugin; later, method-scoped manifest routes.
- **Q8. Safe mode.** Recommendation: safe mode stops live plugins only, since bundled plugins are product code. Owner to confirm.
- **Q9. Env allowlist.** `process-ownership/src/spawn-env.ts:49-51` names `WORKSPACE_RUNTIME_TASKS_*`. The names are a contract between the control plane and sandbox images, so they stay. Recommendation: the list takes contributed names from the spawn composition. If the security review prefers literal lists, it stays literal with the plugin as named owner.
- **Q10. Status change on touch.** Board drag has no touch path today either. Recommendation: the status `ChoicePicker` on cards and rows covers phone.

## Execution

- **Lanes after S0 and S1, in separate worktrees:**
- catalog and renderer: S2 → S3 → S4 (`packages/claxedo-plugin-api/src/surface/`, `packages/claxedo-app/src/surface/`);
- plugin API host: S5 (`packages/claxedo-app/src/plugins/`, `src/composer/` moves);
- backend: S6 → S7 → S8a → S8b (server-core, local-server, server, mcp, tasks).
- S9 needs S5 and S6. S10a and S10b need S2–S5 and S9. S11a–c follow S6 and S7 and can run beside S10.
- One e2e stack at a time on one machine; at most two lanes run tests at once.
- Runtime test suites run only under the no-signal `sandbox-exec` profile.
- Each slice claims itself in this plan's Progress line, edits only its lane's files, and reports the exact commands run and their outcomes.

### Critical Files for Implementation
- `/home/user/Claxedo/packages/claxedo-plugin-api/src/surface/catalog.ts`
- `/home/user/Claxedo/packages/claxedo-app/src/plugins/frame/host-surfaces.ts`
- `/home/user/Claxedo/packages/claxedo-local-server/src/app/local-app.ts`
- `/home/user/Claxedo/packages/claxedo-server-core/src/platform/db/db.ts`
- `/home/user/Claxedo/packages/claxedo-mcp/src/tools/index.ts`