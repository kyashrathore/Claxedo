# Opt-in plugins: Tasks and Documents installed from the Marketplace

Status: plan, not started. Base: `plan/a2ui-surfaces-and-mcp-apps` at `dfc295f`. It replaces the "first-party plugin" design of `docs/plans/2026-10-18-feat-first-party-plugins-plan.md` (S0–S12).

The user's rulings:
- **2026-10-20, true opt-in plugins.** A plugin is not shipped by default. It is installed from the Marketplace and loaded only when enabled. Its backend runs in a per-organization Cloudflare Dynamic Worker. Someone who does not use it gets no code, routes, tables, agent tools, rail rows or settings sections.
- **2026-10-20, wipe the data.** "We have no users, we can wipe the db and start." So there is no data migration for Tasks or Documents, and no byte-compatibility constraint on their tables, migrations, D1 baseline, routes or MCP tool names.

- **2026-10-20, plugins only when signed in.** "Only support plugin on signin." App plugins, installed or live, exist only for a signed-in account: on the web, or on a desktop with an account. An unsigned desktop or a self-hosted daemon without accounts has no app plugins. There is no local plugin backend runtime and no `workerd` in the desktop. A signed desktop's plugin backends run in the org's hosted Dynamic Worker, reached through `plugin.request` over the account bridge.

## Summary

1. A plugin is a signed release in a Claxedo registry: a static, public, content-addressed bucket of an index, signed releases and blobs. It has a manifest, an app bundle and a backend bundle.
2. Hosted: an org admin installs it, which copies it into the deployment's R2 and writes an `app_plugin_installs` row. Each user then enables it for themselves; until then they download nothing and reach nothing.
3. Signed-in only (owner ruling). An unsigned desktop or a self-hosted daemon has no app plugins.
4. The app lists only the plugins installed and enabled for the caller. It fetches each bundle lazily from `/api/claxedo/app-plugins/:id/bundles/:sha256/app.js`, checks the sha256, and runs it in the sandboxed frame on web and on desktop.
5. Hosted backends finish `plugin-backends/`. Its code moves to a new `@claxedo/plugin-runtime` package with a host port. The supervisor becomes one Durable Object per (org, plugin). This adds an install route, a caller handle that replaces the plain user-id header, and the app binding `api.server.backend()`.
6. There is no local backend runtime. A signed desktop reaches the org's hosted backend through `plugin.request`.
7. A backend reaches the host only through `env.PLATFORM`. Every call is checked against the manifest's `permissions` and a caller handle the supervisor minted. The calls cover identity, project read and authorization, sessions, cloud workspaces, blobs, events, schedule, public links, session files, and the plugin's declared agent tools.
8. Agent tools are declared in the manifest. The core MCP mounts (daemon, hosted `/api/claxedo/mcp`, sandbox runtime) register proxy groups per caller, and only for plugins the caller has installed and enabled.
9. Core loses every Tasks and Documents name:
 - the bundled chunks, `FIRST_PARTY_PLUGIN_IDS`, the in-process server plugins, and the SQLite and D1 schema;
 - the MCP groups, the CLI documents command and the `documents.*` operations;
 - the runtime hydration contribution, the tool-name vocabulary and the `WORKSPACE_RUNTIME_TASKS_*` names.
10. What stays in core is generic platform code: the supervisor, installs, the registry client, the proxy MCP groups, session files projection (hydration made generic), plugin-origin sessions and public links.
11. Tasks and Documents are rebuilt as installable plugins. They get clean facet SQLite schemas, blobs for attachments and content, and A2UI pages built from the catalog's shared building blocks, including a Tiptap `RichTextEditor` (owner ruling: every user may have the building blocks).
12. Reset: hosted, delete and recreate the staging control-plane D1 (the baseline changes) and empty the Documents R2 bucket. Local, one `DROP TABLE IF EXISTS` migration, or a fresh data dir.
13. Slices P0–P10 each leave the system working. The old in-process Tasks and Documents are deleted only at their cutover slices (P7b, P8b).
14. Gate P0 must prove Worker Loader and facets on the production Cloudflare account. If production refuses, a deployment offers no backend plugins: there is no in-process fallback.
15. Ratchets end with `@claxedo/tasks` and `@claxedo/documents` in `forbiddenPackages` of every product closure, plus a check that no built app chunk comes from either package.

## Today (observed in code)

**Shipped to everyone**
- `packages/claxedo-app/src/plugins/first-party/bundles.ts:3-6`: `FIRST_PARTY_BUNDLES` imports `@claxedo/tasks/app?claxedo-plugin-bundle` and `@claxedo/documents/app?claxedo-plugin-bundle`, built by `vite.plugin-bundles.ts` (used at `vite.cloud.config.ts:7,111`).
- `provider.tsx:17-18,74-77,124` loads them at host start. `host.ts:39` approves a `bundled` origin without a record. Safe mode stops only `live` plugins (`host.ts:43`).
- `@claxedo/plugin-api` `manifest.ts:9-16`: `FIRST_PARTY_PLUGIN_IDS = ["claxedo-tasks","claxedo-documents"]`. `claxedo-local-server/src/plugins/service.ts:166,191-192` refuses those ids (`live_plugin_id_reserved`).
- Server plugins (`claxedo-server-core/src/plugins/server-plugin.ts:11-116`: `LocalServerPlugin`, `HostedServerPlugin`, `rootGrants`, `mcpToolGroups`, `serverPluginCapabilities`) are composed by:
- `claxedo-desktop/src/server/entry.ts:42-51`;
- `harness/e2e/harness/local-daemon-entry.ts:3-4,15-16`;
- `better-auth-d1-worker.agent-plugins.cf.ts:76-121` (Tasks);
- `core-worker.cf.ts:42-55,137,145-165` (Documents in every hosted profile, with the `CLAXEDO_DOCUMENTS` R2 binding required);
- the sandbox runtime: `hosts/workspace-runtime/runtime-boot.ts:32-33,280,289`, `host-entry.ts:14,24`, `host-entry.agent-plugins.ts:6,16`;
- `claxedo-host-serving/src/runtime.ts:32,133`.
- Bootstrap `deployment.capabilities` comes from `serverPluginCapabilities` (`local-app.ts:453`, `hosted-core-app.ts:342`).
- Storage:
- the Tasks SQLite journal is `packages/claxedo-tasks/src/storage/sqlite/claxedo-tasks-migration/` (six folders);
- the Documents SQLite migrations sit in the host journal: `20260612000000_pages_org_project`, `20260713000100_docs_v2_additive`, `20260714000100_page_docs_v2_binding`, `20260716000100_documents_reset` (which also creates the host table `claxedo_local_project`) and `20261001000100_document_creator`, plus `server-core/src/documents/index.sql.ts` and the document DDL in `platform/db/repair.ts`;
- D1: `claxedo-tasks/src/storage/d1/0001_baseline.sql` (six `task_*` tables) is folded into the control-plane baseline by `claxedo-server/scripts/control-plane-schema.ts:4,10`, and `document_shares` is at `migrations/control-plane/0001_baseline.sql:167,798-802`.
- The migrator skips applied names and ignores applied names missing from the journal (`platform/db/db.ts` `applyMigrations`), so deleting folders is safe.
- Agent tools, CLI and operations:
- MCP groups `tasks` and `documents` are composed per host;
- the vocabulary is in `agent-runtime-contract/src/tool-names.ts:47-51,62-63`;
- the env names are in `process-ownership/src/spawn-env.ts:49-51`;
- `cli/src/plugin-commands.ts:1,7` holds the documents CLI command;
- `documents.*` operations are composed at `claxedo-app/src/server/operations.ts:2,10` and `claxedo-desktop/src/main/account/hosted-operations.ts:2,5`;
- the Marketplace orders `documents` and `tasks` among the built-in groups (`claxedo-app/src/marketplace/model.ts:10-18`).
- The hosted owner grant is typed by Tasks: `claxedo-server/src/session/owner-grant.ts:2` and `session-rows-pass.ts:3` import `@claxedo/tasks/host/capability`.

**The unused sandboxed runtime (`claxedo-server/src/plugin-backends/`)**
- **Route.** `routes.ts:43-85` serves `ALL /api/plugins/:pluginId/*`. It is signed-only, resolves the org through `resolveOrgId` (`:58`), and forwards only the body and `content-type`, answering under `nosniff` and `CSP: sandbox`. It is mounted only by the Agent Plugins entry (`agent-plugins.cf.ts:67-75,145`).
- **Supervisor.** One per org, named `org:<orgId>` (`supervisor.cf.ts:37-39`). It forwards the caller as a plain `x-claxedo-user-id` header (`:41,94`) and loads the backend with `PLUGIN_LOADER.get(<org>/<plugin>/<generation>/<epoch>)`, whose env is only `PLATFORM` and whose outbound is `PluginOutbound` (`:144-159`). Facets are named `[pluginId, className, name]` and are tracked in memory only.
- **Capabilities.** `entrypoints.cf.ts:13-21` gives `PLATFORM.object` and `active`; `:24-38` is `PluginOutbound`, https to the manifest's hosts only.
- **Activation.** `activations.ts` keeps one D1 row per (org, plugin) in `plugin_backend_activations` (`0001_baseline.sql:378-388`), whose epoch rises on every change. `lifecycle.ts:12-26` (activate, deactivate) and `bundles.ts:27,38` (`plugin-backends/<sha256>.js` in `CLAXEDO_AGENT_PLUGINS`) have no production caller.
- **Deployment.** `wrangler-config.ts:59-77` binds `[[worker_loaders]] PLUGIN_LOADER` and `PluginSupervisor` (migration v2) in Agent Plugins artifacts only.
- **README gate findings.** The local workerd works; facet alarms do not fire there. Production Worker Loader and facets are not verified (beta), and neither is the 50-facet memory gate.
- **Manifest.** `@claxedo/plugin-api` `manifest-schema.ts:37-44` is `backend: { entry, objects, outbound, routes }`, and `server.routes` must start with `/api/claxedo/` (`:28`). `PluginApi.server` is `fetch` plus `operation` only (`host.ts:40-43`, `bindings/server.ts:23-35`).
- **`plugin.request`.** Defined at `account-contract/src/hosted-operations.ts:603-610` with `exposure: { renderer: true, app: false }`.

**App plugin host**
- Choices (switches and approvals) live in localStorage per principal scope (`preferences.ts:58-60`). The live list comes from the daemon only (`provider.tsx:79-87`), so hosted web without a daemon has no app plugins.
- **Web frame.** `sandbox="allow-scripts"` with `srcdoc` (`frame/definition.tsx:18-22`, `frame/slot.tsx:31`). CSP: `connect-src 'none'`, `img-src data: blob:`, scripts `'unsafe-inline' blob:` (`frame/document.ts:21-35`).
- **Rendered targets.** A rendered page, settings section or overlay renders plugin-owned DOM in its own slot frame (`src/plugins/README.md`, "The web frame").
- **Runtime.** The frame runtime installs Solid, the plugin API and the kit (`@claxedo/app/ui`) (`live/runtime.ts:8-16`, `frame/runtime/index.ts`). It is fetched same-origin (`frame/runtime-source.ts:15`), which is why the desktop's `file:` renderer runs plugins in-app instead (`first-party/load.ts`).

**MCP.** Groups are fixed per mount (`claxedo-mcp/src/server.ts:75,95`) and filtered per MCP session by `enabledToolGroups` (`:231-233`), so a per-caller list can be added at that one point.

**Persisted data in production.** None to keep (owner ruling). Staging's D1 is resettable and the deploy refuses a D1 that does not hold exactly the current baseline (`docs/deploy/staging-branch.md:138-151`).

## Design

### 1. Distribution and registry

**1.1 Registry (where packages are published)**
- One Claxedo-operated registry: a public R2 bucket behind `https://plugins.claxedo.dev` (the name is a proposal), served read-only.
- `index.json`: a signed list of `{ id, name, description, publisher, icon, latest, versions[] }`.
- `releases/<id>/<version>.json`: a signed `PluginRelease` (below).
- `blobs/<sha256>`: the app bundle and the backend bundle, immutable.
- Published by a new workflow `.github/workflows/publish-app-plugins.yml` on tags `plugin-<id>-v<semver>`. It runs `bun run --cwd packages/<plugin> release` (new script, §5), signs, and uploads.
- Self-hosted user deployments read the same registry. `CLAXEDO_APP_PLUGIN_REGISTRY_URL` overrides it; e2e and dev point it at a `file://` directory built by the harness.

**1.2 Release format** (`@claxedo/plugin-api/release`, new)

```ts
export type PluginRelease = {
id: string; version: string                     // semver
manifest: PluginManifest                        // as validated at build (§5.1)
app: { sha256: string; size: number }           // full 64-hex sha256
backend?: { sha256: string; size: number }
storage: number                                 // forward-only storage generation; downgrade below it refused
tools?: readonly PluginToolDeclaration[]        // extracted at build for the MCP proxy (§3.4)
builtAt: string
}
export type SignedPluginRelease = { release: PluginRelease; signature: string /* base64 Ed25519 over canonical JSON */; keyId: string }
```

**1.3 Signing and integrity**
- **Keys.** Ed25519 keys are pinned in source as `PLUGIN_REGISTRY_KEYS: Record<keyId, publicKeyBase64>` (`@claxedo/plugin-api/release`). The private key is a GitHub Actions secret. A test key is accepted only when `CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY` is set, and a product-boundary authoritative check forbids that reader in production entries.
- **Who verifies.** The hosted Worker only (WebCrypto Ed25519; verify it in P0). Each checks the signature, then each blob's sha256 and size before storing it.
- **Re-check at load.**
- The supervisor already re-hashes a bundle (`bundles.ts:38`).
- The app re-hashes the app bundle it fetched against the sha256 its own server listed before loading it (`crypto.subtle.digest`). A mismatch is a load failure shown in Settings.
- **Ids.** `PLUGIN_BUNDLE_HASH_LENGTH = 16` stays for live builds. Installed builds use the full sha256.

**1.4 Install scopes**

| Context | Installed by | Where | Enabled by |
|---|---|---|---|
| Hosted, signed (web, or desktop with an account) | an org owner or admin; the owner, for a personal org (`orgs.kind = 'personal'`) | `app_plugin_installs` (D1) plus blobs in `CLAXEDO_AGENT_PLUGINS` R2 | each member for themselves (`app_plugin_enablements`); an admin may set a positive org default, and a user can still turn it off |

- A signed desktop uses the org scope. Its backend calls go through `plugin.request` over the account bridge, and hosted Tasks reaches the machine's workspaces through the relay, as hosted Tasks does today. It does not also list machine installs (Q3).
- Hosted deployments without the Agent Plugins profile have no `PLUGIN_LOADER`. Their catalog shows backend plugins as "not available on this deployment", and install is refused (`app_plugin_platform_unavailable`).

**1.5 Lifecycle**

| Action | Who | Effect |
|---|---|---|
| Install | admin / owner | Verify the release; copy the blobs into the deployment's store; write the install row (`active=1`, epoch +1); `activatePluginBackend`. The admin sees a permission prompt naming each `permissions` entry in plain words, plus `outbound` hosts and `server.routes`. |
| Enable (per user) | the member | Write the enablement. The app re-lists, then fetches and activates. The prompt shows the same list (the member consents to what the plugin may do as them). |
| Disable (per user) | the member | Remove the enablement. The app drops the plugin, `/api/plugins/:id/*` answers 404 `plugin_not_enabled` for that user, and the MCP proxy groups vanish at the next MCP session. Data is untouched. |
| Disable (org) | admin | `active=0`, epoch +1, `deactivatePluginBackend`: every user loses it at once, and storage is kept. |
| Update | admin | Explicit (as Agent Plugins Update). A new release means a new epoch; downgrade below `storage` is refused. |
| Uninstall | admin, after a confirm that names data deletion | Deactivate; delete the plugin's whole supervisor storage (facets included; verify in P0), the blob prefix `plugin-data/<org>/<plugin>/`, enablements, public links and plugin-origin session rows; withdraw the root grants. The bundle blobs stay (content-addressed and possibly shared). |

**1.6 Lazy frontend fetch**
- **Routes.** New core routes under `/api/claxedo/app-plugins` on both servers:
- `GET /` gives the caller's installed and enabled list `[{ id, version, manifest, app: { sha256 }, permissions }]`;
- `GET /:id/bundles/:sha256/app.js` is immutable, and answers 404 unless the caller has it installed and enabled;
- `POST /:id/enable`, `DELETE /:id/enable`, plus the admin `POST /` (install `{ id, version }`), `POST /:id/update`, `POST /:id/disable` and `DELETE /:id` (uninstall);
- `GET /catalog` (§1.7).
- **App.** `src/plugins/installed/` replaces `first-party/`:
- a query on the list, re-read on a `plugins.changed` doorbell, which the control bus (local, `bus.ts:178`) and the live-sync room (hosted) already carry;
- fetch through `server.request`, or through the account bridge on a signed desktop;
- verify the sha256, then load through the frame loader;
- `PluginOrigin` gains `{ kind: "installed"; hash; version }` and loses `bundled` (`model.ts:8`). The approval is the server-side consent, so `createBuildPolicy.approval` answers `approved` for `installed`, and safe mode stops installed plugins too (they are no longer product code).
- **Desktop.** Installed plugins run in the sandboxed frame too, not in-app (§5.4). The frame runtime must load from the `file:` renderer: inline it as a string chunk (`?raw` of the worker build) instead of `fetch(frameRuntimeUrl)` (`runtime-source.ts:15`). Verify in P4.

**1.7 Marketplace listing**
- `/api/claxedo/app-plugins/catalog` reads the registry `index.json` (edge-cached, as `agent-plugins/edge-cached-fetch.ts`). It answers per entry `{ id, name, description, icon, latest, installed?: { version, active, enabledForMe, orgDefault }, permissions, available }`.
- The app's Marketplace (`src/marketplace/`) gains an "App plugins" section above the agent-plugin sources.
- The card and Details show what the plugin adds (pages, settings and agent tools named from `release.tools`) and its permissions.
- The actions are Install (admins), Enable or Disable for me, Update, Disable for organization, and Uninstall.
- The directory query key and pending state are shared with agent plugins. Activation and revision logic stays separate, because app-plugin installs are not harness activations.
- `BUILT_IN_TOOL_GROUP_ORDER` loses `documents` and `tasks` (`model.ts:10-18`).

**1.8 Versioning**
- The release's `version` is semver; the install row pins one version. A frontend and backend are always the pair from one release (one row), so they never skew within an org.
- An open tab holding the previous frontend gets `plugins.changed` and reloads the plugin (the host already swaps builds: `lifecycle.ts`).
- Facet schema migrations are the plugin's own (forward-only, `PRAGMA user_version` per facet).

### 2. Backend runtime

**2.1 Shared code: new package `packages/plugin-runtime` (`@claxedo/plugin-runtime`)**
- Moved from `claxedo-server/src/plugin-backends/`: `supervisor.cf.ts`, `runs.ts` (+ test), `entrypoints.cf.ts`, `refusal.ts`.
- New, the host port:

```ts
export type PluginHostPort = {
readState(orgId: string, pluginId: string): Promise<PluginBackendState>           // hosted: D1 installs; local: daemon
readBundle(sha256: string): Promise<string | undefined>                          // hosted: R2; local: daemon blob store
platform(call: PlatformCall, scope: PluginRunScope, caller?: CallerRecord): Promise<PlatformAnswer>  // §3
scheduler: PluginSchedulerPort                                                   // §3.7
}
```

- **Supervisor naming.** `pluginSupervisor(namespace, orgId, pluginId)` names `org:<orgId>:plugin:<pluginId>` (replacing `org:<orgId>`, `supervisor.cf.ts:37-39`). One plugin's CPU or memory then never blocks another, uninstall is one `deleteAll`, and the 50-facet gate is per plugin. The DO class and migration v2 are unchanged; old `org:*` objects hold nothing (never activated).
- **Persistent facet registry.** The supervisor's own SQLite gets `facets(name primary key, class, created_at)`, replacing in-memory `track` for deletion, plus `wakes` (§3.7) and `caller_handles` (in memory only, §3.1).
- **Caller handles.** These replace `x-claxedo-user-id` (`:41,94`): the plugin receives `x-claxedo-caller: <handle>` and never a raw user id it could replay.

**2.2 Hosted completion** (`claxedo-server/src/plugin-backends/`, which keeps only the host adapter)
- `host/installs.ts`: D1 `app_plugin_installs`, which replaces `plugin_backend_activations`, and `app_plugin_enablements`.
- `host/registry.ts`: fetch and verify the release, then copy blobs to R2 (`putPluginBackendBundle`, plus a new `plugin-apps/<sha256>.js` sibling).
- `host/platform.ts`: platform calls over `ControlPlaneServices` (§3).
- `routes/app-plugins.ts`: §1.6.
- `routes.ts` (`/api/plugins/:id/*`) adds the enablement check, caller-handle minting and the reserved `/_tools/*` and `/_files/*` prefixes, which only the platform may call.
- Mounted in both Agent Plugins entries. The entry exports `PluginSupervisor`, `PluginPlatform` and `PluginOutbound` from `@claxedo/plugin-runtime` (as at `agent-plugins.cf.ts:24`).
- **App binding**, new in `PluginApi`:

```ts
// @claxedo/plugin-api host.ts
export interface ServerApi {
fetch(path: string, init?: RequestInit): Promise<Response>      // core routes the manifest names (unchanged)
operation(name: string, input?: unknown): Promise<unknown>
backend(): PluginBackendClient                                   // throws PluginAccessError when the manifest declares no backend
}
export interface PluginBackendClient {
fetch(path: string, init?: RequestInit): Promise<Response>      // → /api/plugins/<id><path>
events(topic: string, listener: (data: unknown) => void): () => void
}
```

- Web (hosted or daemon-served): `services.calls.backendFetch(id, path, init)` maps to `server.request("/api/plugins/<id><path>")`. Binary bodies are already safe over the frame (`frame/response-body.ts`).
- Signed desktop: the `plugin.request` operation. Its exposure becomes `{ renderer: true, app: true }` and the app's operation table offers it.
- Unsigned desktop: no app plugins (owner ruling).

**2.3 Local and desktop runtime: none (owner ruling, 2026-10-20)**

App plugins exist only for signed-in accounts, so there is no local backend runtime. The comparison of local runtimes (embedded `workerd`, Node `--permission`, Bun Worker, Electron `utilityProcess`, QuickJS) is no longer needed.
- **Signed desktop:** installed plugins come from the org's installs. Frames run them, and their backends are the org's hosted Dynamic Workers, reached through `plugin.request` over the account bridge. Hosted Tasks reaches the machine's workspaces through the relay, as it does today.
- **Unsigned desktop and self-hosted daemon:** no app plugins. The live-plugin registry, `/api/claxedo/live-plugins` and the daemon's plugin routes are removed, or gated behind a signed account if the authoring tools (`app_plugin_*`) stay. Live developer plugins exist only on a signed desktop, frontend only; a developer who wants a backend publishes a private release to their org.

### 3. The platform API a backend gets

The contract types live in `@claxedo/plugin-api/backend` (new subpath) with `definePluginBackend`. The bundle carries a thin typed client over `env.PLATFORM` RPC.

**Path of a call.** Plugin code calls `env.PLATFORM.<call>` (the `PluginPlatform` entrypoint, bound to the org, plugin and epoch). That goes to `supervisor.platform(scope, call, handle)`, which checks:
1. the epoch is current (`409 plugin_backend_replaced`);
2. the manifest's `permissions` include the call's permission (`403 plugin_permission_not_declared`);
3. the handle is live and belongs to this run (`401 plugin_caller_invalid`).

Then `PluginHostPort.platform(...)` runs it as the caller, through the host authority. Hosted, that is in-process in the Worker's `ctx.exports`. Locally, it is `HOST` → daemon `/api/plugin-host/call`.

**3.1 Identity and org** (permission: none; always available)
- `identity.caller(handle)` answers `{ userId, orgId, displayName, origin: "person" | "agent" | "link" | "system", session?: SessionRef, projectId?, workspaceId?, ownerDriven? }`.
- The supervisor mints a handle per inbound request: 128-bit random, kept in memory under its epoch, expiring 10 minutes after the request ends or at epoch end.
- Scheduled wakes get `origin: "system"`, with no user and no session, project or workspace capability (§3.7).
- Lives in: `@claxedo/plugin-runtime` (handles) and the host port (`displayName` from the authority).

**3.2 Projects** (`projects.read`)
- `projects.list(caller)` and `projects.authorize(caller, projectId, "read" | "write")`.
- Hosted: `WorkspaceAuthority` project reads and membership checks, the same rules `@claxedo/tasks/host/authorization.ts` applies today (that module's generic half moves to `server-core/src/plugin-platform/projects.ts`). Local: the workspace store, where the owner holds every project.

**3.3 Sessions** (`sessions.start`, `sessions.read`)
This generalizes `TasksSessionBridgePort` (`claxedo-tasks/src/ports/session-bridge.ts:157`) with a plugin origin in place of task, slot and attempt:

```ts
type PluginSessionOrigin = { scope: string; key: string }          // e.g. { scope: projectId, key: "tsk_…:primary:2" }
sessions.harnesses(caller, { projectId, placement: "local" | "cloud" }) → HarnessDescriptor[]
sessions.preview(caller, StartSpec) → { digest, blockers[] }
sessions.start(caller, StartSpec & { digest, requestId }) → { session: SessionRef } | { preparing: { workspaceId } }
sessions.handoff(caller, { origin, session, text, attachments: BlobRef[] }) → { sent: boolean }   // message id derived from origin
sessions.abandon(caller, { origin, session }) → { removed: boolean }
sessions.state(caller, origins[]) → { session, state: SessionLiveness, handoff }[]
sessions.authorizeOpen(caller, SessionRef) → boolean
type StartSpec = { origin; projectId; placement; configuration: { harness, model, effort }; instructions?: string;
                 selection?: { plugins: PluginReference[]; skills: SkillReference[] }; continueFrom?: SessionRef; title?: string }
```

- **Authorization.** Project write for the caller. An `origin: "agent"` caller from a member-driven session is refused detached root creation, as `session_create` and `task_start` are today (`claxedo-local-server/src/plugins/README.md`, "Who gets it"). `continueFrom` needs `authorizeOpen` at the transcript read.
- **Lives in:**
- `claxedo-server-core/src/plugin-platform/sessions/`: the generic core moved from `@claxedo/tasks/host/{session-bridge-core,registered-sessions,session-runtime-answers,origin-ids,configuration-blockers}.ts`;
- hosted: `claxedo-server/src/plugin-backends/host/sessions.ts`, moved from `@claxedo/tasks/hosted/{session-bridge,session-reservation}.ts` and `tasks-plugin/cloud-roots.ts`;
- local: `claxedo-local-server/src/app-plugins/sessions.ts`, moved from `@claxedo/tasks/local/session-bridge.ts`.
- **Origin rows.** The platform records origins in a generic table: D1 `plugin_session_origins(org_id, plugin_id, scope, key, session_id, workspace_id, created_at)`, and the same in `claxedo.db` locally. This replaces the anti-join `tasks/hosted/d1-host-reads.ts` makes against plugin tables, which facets make impossible.

**3.4 Agent tool registration** (`tools`)
- Declared, not registered at runtime: the manifest's `backend.tools = { group: { id, label }, definitions: [{ name, title, description, inputSchema, access: "read" | "write" }] }` is copied into `release.tools` at build.
- Names must match `^[a-z][a-z0-9_]{1,47}$`, and P6's check refuses any core tool name or another installed plugin's. There is no compatibility list (owner ruling): `task_list`, `task_get`, `task_create`, `task_edit`, `task_start`, `documents_list` and `documents_open` stay as Tasks' and Documents' own names.
- **MCP.** `FirstPartyMcpOptions` and `ClaxedoMcpMountOptions` gain `pluginToolGroups?: (credential) => Promise<readonly McpToolGroup[]>`, concatenated after `registerTools` when an MCP session is created (`server.ts:231`).
- A proxy group (`@claxedo/mcp/plugin-proxy.ts`, new) registers each declared tool. Its handler `POST`s `{ arguments }` to the backend's `/_tools/<name>` through the same route machinery, with a caller handle `{ origin: "agent", session, projectId, workspaceId, ownerDriven }`.
- The result must be a `McpToolResult`-shaped JSON (≤ 256 KiB).
- **Consent.** A plugin's group is served only when the plugin is installed and enabled for the session's user and the plugin's group id is on in `enabledToolGroups`. The activation subject is `app-plugin:<pluginId>`, with a positive Claxedo default. The Marketplace switch sits on the plugin's card.
- **Where it is wired:**
- local daemon MCP (`start-local-server.ts:337`, `local-app.ts:580`);
- hosted `/api/claxedo/mcp` (`core-worker.cf.ts:165`; only where `PLUGIN_SUPERVISOR` exists);
- sandbox runtime MCP (`hosts/workspace-runtime/first-party-mcp.ts`). A root launches with a generic `CloudRootGrantContribution` `{ group: "app-plugin-tools", audience: "plugin-tools", withdrawalReason: "app_plugin_disabled" }` whose JWT names `{ org, project, workspace, user, plugins[] }`. The runtime reads its declarations once per MCP session from `GET /api/claxedo/app-plugins/tools` and calls `/api/plugins/:id/_tools/:name` with that bearer.
- Env `WORKSPACE_RUNTIME_PLUGIN_TOOLS_GRANT` replaces the three `WORKSPACE_RUNTIME_TASKS_*` names (`spawn-env.ts:49-51`).

**3.5 Blobs** (`blobs`)
- `blobs.put(key, bytes, { contentType })`, `get(key)`, `head`, `delete` and `list(prefix, cursor)`.
- Keys are `^[A-Za-z0-9._/-]{1,512}$` and scoped by the host: hosted R2 `plugin-data/<org>/<plugin>/<key>` in `CLAXEDO_AGENT_PLUGINS`; local `<dataDir>/plugin-runtime/blobs/<org>/<plugin>/<key>`.
- Limits: 16 MiB per object and 1 GiB per (org, plugin) by default (`PLUGIN_BLOB_LIMITS`). These cover Tasks' 1.5 MiB attachments (`TASKS_BOUNDS.taskAttachmentMaxBytes`) and Documents' content.
- `BlobRef = { key, sha256, size, contentType }` is what `sessions.handoff` and `sessions.files` accept, so bytes never cross the facet twice.

**3.6 Events to the frontend** (`events`)
- `events.publish({ audience: "caller" | "project" | "org", topic, data? })`: `data` ≤ 8 KiB JSON, at most 10 per second per (org, plugin).
- Hosted: `nudgeLiveSyncRoom` (`platform/http/live-sync-publish.ts:61`) to the audience's rooms with `{ type: "plugin.event", pluginId, topic, data }`. Local: the control bus. Neither delivers to users who have not enabled the plugin.
- The app routes these to `backend().events(topic, …)` in the frame.

**3.7 Scheduled wakes** (`schedule`)
- `schedule.at(name, whenMs, payload ≤ 4 KiB)`, `cancel(name)`, `list()`: at most 100 wakes per (org, plugin), and at least 30 s ahead.
- At the time, the platform calls the backend's `POST /_wake/<name>` with an `origin: "system"` handle.
- Hosted: the supervisor's `wakes` table plus its own DO alarm. The supervisor is platform code, so this is not the facet-alarm risk the README records. Local: the daemon's timer reads the same wakes through `PluginSchedulerPort`.
- Facet `setAlarm` stays unsupported (README residual risk). Plugins are documented not to call it.

**3.8 Public links** (`links`)
- `links.create(caller, { path, expiresAt? })` gives `{ token, url: "/p/<token>" }`; there is also `links.revoke(token)`.
- The platform table `app_plugin_links(token_hash, org_id, plugin_id, path, created_by, expires_at, revoked_at)` lets `GET /p/:token` resolve to the plugin's `GET <path>` with `origin: "link"`, under the existing request limiter.
- This replaces Documents' own `/p` route.

**3.9 Session files** (`sessions.files`, the generic form of Documents hydration)
- `sessions.files.mount(caller, session, { files: [{ path, blob: BlobRef, version }], writeback: boolean })`.
- The host pushes to the runtime's generic route `POST /api/wr/plugin-files/hydrate`. That route lives in `workspace-runtime` core, moved from `claxedo-documents/src/runtime/{hydration,files,job-capability}.ts` with every Documents name removed, mounted for every runtime and inert until a mount arrives.
- On `turnSettled` and before deletion (`session-core/src/routes/session-lifecycle.ts`, unchanged), the runtime posts changed files to the host. The host stores the bytes as blobs and calls the backend's `POST /_files/changed` with `{ session, files: [{ path, blob, baseVersion }] }`.
- Files live under `.claxedo/plugins/<pluginId>/` in the workspace. `authorizeSessionControl` and `contribution_write` stay as built in S11a.

**3.10 Storage** (`object`, existing)
- `PLATFORM.object(className, name, request)` is unchanged (`entrypoints.cf.ts:14`), and runs facets in the plugin's own supervisor.
- New refusals: at most 10,000 facet names per (org, plugin).

**3.11 Permissions vocabulary** (`manifest.permissions`)
- The values are `projects.read`, `sessions.read`, `sessions.start`, `workspaces.cloud`, `tools`, `blobs`, `events`, `schedule`, `links` and `session-files`.
- Each has a one-line prompt string in the app's Marketplace dictionary.
- `workspaces.cloud` gates `placement: "cloud"` in `sessions.start`.

### 4. Removing everything a non-user would see

| Item | Action | What stays generic |
|---|---|---|
| `claxedo-app/src/plugins/first-party/**`, `vite.plugin-bundles.ts`, its use at `vite.cloud.config.ts:7,111`, the `e2e/harness/app.ts:9` entry, `@claxedo/tasks`/`@claxedo/documents` in the app's `package.json` | delete | `src/plugins/installed/` (lazy list and fetch) |
| `FIRST_PARTY_PLUGIN_IDS`, `FirstPartyPluginId`, `isFirstPartyPluginId` (`manifest.ts:9-16`); `BundledOrigin`; bundled approval and safe-mode exemption (`host.ts:39,43`) | delete | `installed` origin |
| `requires`, `PLUGIN_CAPABILITY_*`, `isPluginCapability`, `deployment.capabilities`, `serverPluginCapabilities`, `Capabilities.plugins` (`provider.tsx:109-111`) | delete (they only ever reported first-party server plugins); verify with `rg -n "capabilities\.plugins\|PLUGIN_CAPABILITY\|serverPluginCapabilities\|requires" packages` | install-time platform checks (§1.4) |
| `LocalServerPlugin`, `HostedServerPlugin`, `ServerPluginBase`, `McpPluginContribution`, `McpServiceContribution`, `assertDistinctServerPlugins`, `mcpToolGroups(plugins)`, `plugins` options (`local-app.ts:184,240-241,534,556`, `hosted-core-app.ts:153,239-240,648,675`), `sqlite-schema.ts`, `runtime-host.ts` | delete in P7b/P8b | `CloudRootGrantContribution` and `CloudRootIdentity` move to `claxedo-server/src/agent-plugins/runtime/` (the subagents owner grant and the plugin-tools grant use them); `configureClaxedoSchema` keeps one journal |
| Tasks and Documents composition: desktop `entry.ts:8-9,42-45`, e2e daemon entry, `agent-plugins.cf.ts:11,76-112`, `core-worker.cf.ts:42-55,137,145-152`, `runtime-boot.ts:32-33,280,289`, `host-entry*.ts`, `host-serving/runtime.ts:32,133` | delete | — |
| `claxedo-server/src/deployments/hosted-workerd/tasks-plugin/**`, `src/documents/{compose,runtime-broker,relay-http}.ts`, `authority/adapters/d1/document-authority.ts`, `CLAXEDO_DOCUMENTS` (`core-worker` required binding, `wrangler-config.ts:145`, `public-docs/user-deployed-cloudflare.md:146`) | delete; the generic halves of cloud-roots and session-bridge move per §3.3 | `workspace/origin-cloud-workspace.ts`, `cloud-create-admission.ts`, `cloud-workspace-start.ts` |
| `owner-grant.ts:2`, `session-rows-pass.ts:3` Tasks types | retype on `server-core/src/platform/auth/` owner-grant types (its own key name; owner ruling allows a new one) | owner grant |
| Schema: `claxedo-tasks/src/storage/**`; host journal doc folders `20260612000000_pages_org_project`, `20260713000100_docs_v2_additive`, `20260714000100_page_docs_v2_binding`, `20261001000100_document_creator`; strip `20260716000100_documents_reset` to the `claxedo_local_project` DDL only (check it first with `rg -n "claxedo_local_project" packages/claxedo-server-core/src/platform/db/claxedo-migration`); `server-core/src/documents/index.sql.ts`; document DDL in `repair.ts` (bump `REPAIR_VERSION`); D1 `TASKS_D1_SCHEMA_DIR` source (`control-plane-schema.ts:4,10`) and `document_shares` (`0001_baseline.sql:167,798-802`) | delete, plus one host migration `<ts>_drop_retired_tasks_documents` (`DROP TABLE IF EXISTS` every `task_*`, `tasks`, `claxedo_document_index`, `claxedo_page_status`, `claxedo_document*` table) | journal and baseline machinery |
| MCP groups `tasks`/`documents`, `hostedMcpToolGroups`, `TASKS_MCP_TOOL_GROUP`/`DOCUMENTS_MCP_TOOL_GROUP` at core mounts, tool-name vocabulary (`tool-names.ts:47-51,62-63`) and the matching `tool-header.ts` rows, env names (`spawn-env.ts:49-51`) | delete | MCP `services` grants (used by `app-plugins`), proxy groups (§3.4) |
| CLI documents command: `cli/src/plugin-commands.ts`, `PLUGIN_COMMANDS`, `cli/src/help.ts` entries, `@claxedo/plugin-api/cli` | delete (no generic CLI plugin command until asked, Q8) | — |
| Account contract: `DOCUMENTS_OPERATIONS` in `app/src/server/operations.ts:2,10` and `desktop/main/account/hosted-operations.ts:2,5`; the `...extra` parameter of `hostedOperationTable` and `@claxedo/account-contract/operation-definition` if unused; `response: "bytes"` if only `documents.export` used it (`rg -n 'response: "bytes"' packages`) | delete | `plugin.request` (exposure `app: true`) |
| Session lifecycle hooks | keep (`session-core/src/routes/session-lifecycle.ts`), now fed only by the generic session-files contribution | `sessionLifecycle`, `contribution_write`, `relayWorkspaceId`, `authorizeSessionControl` |
| Workspace-runtime hydration contribution (`documentHydrationContribution`) | delete; becomes core `workspace-runtime/src/routes/plugin-files*.ts` mounted by `server.ts` for every runtime | §3.9 |
| Marketplace `BUILT_IN_TOOL_GROUP_ORDER` `documents`, `tasks` | delete | — |
| `script/first-party-plugins.test.ts` | replace with `script/app-plugin-isolation.test.ts` (§7, P9) | — |

**Persisted contracts this plan changes** (allowed by the 2026-10-20 ruling):
- D1 baseline: drop `task_*`, `tasks` and `document_shares`. Replace `plugin_backend_activations` with `app_plugin_installs(org_id, plugin_id, version, epoch, active, app_sha256, backend_sha256, manifest_json, release_json, signature, installed_by, changed_by, changed_at)`. Add `app_plugin_enablements(org_id, user_id, plugin_id, enabled, changed_at)`, `app_plugin_org_defaults(org_id, plugin_id, enabled)`, `app_plugin_links` and `plugin_session_origins`.
- The local `claxedo.db` gets `plugin_session_origins`.
- The DO name scheme `org:<org>:plugin:<plugin>`.
- R2 prefixes `plugin-apps/` and `plugin-data/` beside the existing `plugin-backends/`.
- The env name `WORKSPACE_RUNTIME_PLUGIN_TOOLS_GRANT`.
- The Marketplace activation subject family `app-plugin:<id>`, which replaces `claxedo:tasks` and `claxedo:documents`.

**Persisted contracts kept:** every other host table and journal entry, the auth DB, Agent Plugins artifacts and activations, the `CLAXEDO_AGENT_PLUGINS` binding, the `PluginSupervisor` class and migration v2, the live-plugin store layout, and the IPC channel names for core operations.

**Reset steps**
- **Hosted staging.** After the P2 and P7b/P8b baseline changes merge:
1. `bunx wrangler d1 delete <CLAXEDO_STAGING_CONTROL_PLANE_D1_DATABASE_NAME>`.
2. Rerun the `control-plane` job, which recreates the database and applies the baseline (`staging-branch.md:138-151`).
3. Claim the owner again (`deploy:user-cloudflare:claim-owner`).
4. Empty and delete the Documents bucket: `bunx wrangler r2 object delete` per key, or the dashboard, then `bunx wrangler r2 bucket delete <worker>-documents`.
5. `AUTH_DB` is untouched.
- **Local.** The drop migration converges existing dev databases without a wipe. A fresh `claxedo.db` runs it as a no-op. The alternative is deleting the desktop profile's data directory (the `onboarding-desktop` skill does this for a throwaway profile). The Tasks journal folders vanish with the package's storage, and their applied names in `__claxedo_migrations` are harmless.

### 5. Tasks and Documents as installable plugins

**5.1 Packages**
- Keep `packages/claxedo-tasks` (`@claxedo/tasks`) and `packages/claxedo-documents` (`@claxedo/documents`). No product imports them after cutover. They are build inputs for releases only.
- New layout per package:
- `src/app/` (frontend);
- `src/backend/` (`definePluginBackend`, object classes, routes, `_tools`, `_files`, `_wake`);
- `src/domain/` (the host-agnostic kit that exists today: `commands.ts`, `contracts.ts`, `start.ts`, `validation.ts`, the services);
- `src/storage/facet.ts` (the one store).
- Deleted: `./http` as a host export, `./local`, `./hosted`, `./runtime-host`, `./mcp`, `./host/*`, `./storage/sqlite`, `./storage/d1`, `./cli` and `./operations`.
- The backend may import only `@claxedo/plugin-api{,/backend}`, pure `@claxedo/helpers` subpaths, `@claxedo/agent-runtime-contract` types, `hono` and `zod`; never `@claxedo/server-core`, `node:*` or `drizzle-orm` (P9 ratchet).
- A new `release` script runs `buildPluginApp`, `buildPluginBackend` and tools extraction, writing `dist/release/{release.json, <sha256> blobs}`. `@claxedo/plugin-build` gains `buildPluginRelease({ rootDir })` with full sha256.

**5.2 Manifests**

```jsonc
// packages/claxedo-tasks/package.json
"claxedo": {
"id": "claxedo-tasks", "name": "Tasks", "version": "2.0.0",
"app": "./src/app/index.tsx",
"server": { "routes": ["/api/claxedo/plugins"], "operations": [] },   // Marketplace catalog read for preset pickers (GET only, Q7)
"permissions": ["projects.read", "sessions.read", "sessions.start", "workspaces.cloud", "tools", "blobs", "events"],
"backend": {
  "entry": "./src/backend/index.ts",
  "objects": ["TasksProject", "TasksPresets"],
  "outbound": [],
  "routes": ["GET /projects/:projectId/tasks", "GET /projects/:projectId/tasks/:taskId", "POST /projects/:projectId/commands",
             "GET /projects/:projectId/attachments/:attachmentId", "POST /projects/:projectId/tasks/:taskId/start/preview",
             "POST /projects/:projectId/tasks/:taskId/start", "GET /presets", "POST /presets/commands", "POST /_tools/*"],
  "tools": { "group": { "id": "claxedo-tasks", "label": "Tasks" },
             "definitions": "./src/backend/tools.ts" }      // task_list, task_get, task_create, task_edit, task_start
}
}
// packages/claxedo-documents/package.json
"claxedo": {
"id": "claxedo-documents", "name": "Documents", "version": "2.0.0", "app": "./src/app/index.tsx",
"permissions": ["projects.read", "sessions.read", "session-files", "tools", "blobs", "links", "events"],
"backend": { "entry": "./src/backend/index.ts", "objects": ["DocumentsProject"], "outbound": [],
             "routes": ["GET /projects/:projectId/documents", "GET /projects/:projectId/documents/:id", "POST /projects/:projectId/commands",
                        "GET /projects/:projectId/documents/:id/versions/:version", "GET /public/*", "POST /_tools/*", "POST /_files/changed"],
             "tools": { "group": { "id": "claxedo-documents", "label": "Documents" }, "definitions": "./src/backend/tools.ts" } }
}
```

**5.3 Storage on facets** (clean schemas; each facet migrates itself through `PRAGMA user_version`)
- `TasksProject`, one facet per project (`name = projectId`). The project is the authorization unit and natural shard:
- `tasks(id text pk, number integer not null unique, parent_id text references tasks(id), title text not null, description_md text not null default '', status text not null check (status in ('backlog','todo','doing','needs_you','done')), rank text not null, archived_at integer, created_by text not null, created_at integer not null, updated_at integer not null, revision integer not null)`;
- `task_attachments(id text pk, task_id text not null references tasks(id) on delete cascade, name text not null, mime text not null, size integer not null check (size <= 1572864), sha256 text not null, blob_key text not null, created_at integer not null)`, with bytes in `PLATFORM.blobs` at `tasks/<projectId>/<taskId>/<attachmentId>`;
- `task_session_links(task_id, slot, attempt, session_json, started_by, started_from_json, continued_from_json, created_at, primary key (task_id, slot, attempt))`;
- `command_receipts(request_id text pk, actor text, kind text, answer_json text, created_at integer)`.
- `TasksPresets`, one facet per user (`name = userId`):
- `presets(id pk, name, placement, instructions, agent_startable, configurations_json, selection_json, archived_at, created_at, updated_at, revision)`;
- its own `command_receipts`.
- `DocumentsProject`, per project:
- `documents(id pk, title, status, created_by, created_at, updated_at, head_version integer, archived_at)`;
- `document_versions(document_id, version, sha256, size, blob_key, author, source: 'person' | 'session', session_json, created_at, primary key (document_id, version))`;
- `shares(id pk, document_id, target: 'user' | 'team' | 'link', target_id, role: 'read' | 'edit', link_token_hash, created_by, created_at, revoked_at)`;
- content in blobs at `documents/<projectId>/<id>/<version>.md`.
- `TasksStorePort` (`claxedo-tasks/src/ports/store.ts:165`) is implemented once by `src/storage/facet.ts` over `ctx.storage.sql`. The SQLite and D1 stores and their conformance doubles are deleted, and `./conformance` runs against the facet store under Miniflare.
- No data migration (owner ruling).

**5.4 UI decision: A2UI surfaces with shared building blocks (owner ruling, 2026-10-20)**

The owner ruled that every user may download the catalog's building blocks: "every user need to have those building block components, that's fine". Tasks and Documents pages stay A2UI surface pages. The renderer gains generic components any plugin or agent reply can use: `RichTextEditor` (Tiptap, Markdown in and out, slash menu, lazily loaded chunk), `Dialog`, a borderless title `TextField` variant, clickable `ListItem` and Board cards, and property chips. These are built by the Tasks redesign lane. No `@claxedo/plugin-editor` package and no rendered frame pages. What stays plugin-only is each plugin's own code: its program, backend, tools and data.
- **Tasks UI.** A Linear and Notion-like board and list with inline-editable titles, a `RichTextEditor` description (Markdown canonical, so `task_get` and `task_edit` stay agent-friendly), drag between columns (pointer and keyboard), image paste and drop into the editor (stored as attachments), subtasks as a checklist, and the preset and Start bar. The preset settings section uses the same components.
- **Documents UI** (new A2UI page; the first-party plan had none): document list per project, the `RichTextEditor`, version history, a share dialog (people, teams and public link), and "Open in session" (`documents_open` hydrates through §3.9).
- **Verification.** Design checks follow the design guide and the `a2ui-surface-design` skill (screenshots at desktop width and in `phone`, light and dark).

### 6. Security

- **Isolation per org and per plugin.**
- The caller never names an org (`routes.ts:58`). There is one supervisor per (org, plugin) (§2.1), so facets, blob prefixes, wakes and handles are scoped by construction.
- The Worker Loader id includes org, plugin, generation and epoch (`supervisor.cf.ts:152`).
- Outbound is limited to manifest hosts over https on the default port while the epoch is live (`entrypoints.cf.ts:24-38`); Tasks and Documents declare none.
- The plugin frame has an opaque origin and no network (`frame/document.ts:21-35`).
- **Identity.** Caller handles replace the forgeable user-id header (§3.1). Platform calls refuse undeclared permissions and dead epochs, and system wakes carry no user authority.
- **Install prompts.** The admin's install prompt and each member's enable prompt list the permissions, outbound hosts and core routes. A permission change in an update shows the diff and needs a new consent before the new epoch serves that user; the app's `accessChange` logic moves server-side.
- **Data deletion.** Uninstall deletes the supervisor storage, blob prefix, enablements, links, origin rows and grants (§1.5). Org disable keeps data.
- **Abuse limits:**
- bundle ≤ 10 MiB (`bundles.ts:4`);
- request body ≤ 12 MiB and answer ≤ 16 MiB at `/api/plugins/*`;
- per-(org, plugin) request rate through `CLAXEDO_REQUEST_LIMITER`;
- blob quota (§3.5), event rate (§3.6), wakes (§3.7), facet count (§3.10);
- tool result ≤ 256 KiB;
- Worker Loader CPU and memory limits where the API offers them (verify in P0); otherwise the platform's per-invocation limits apply.
- Installs need a valid signature, so only Claxedo-published code runs hosted.
- **Beta Worker Loader and facets.** P0 must pass on the staging Cloudflare account before P2 merges.
- If production refuses either, backend plugins are unavailable on that deployment: the catalog says so and install is refused. There is no in-process fallback, because that would re-ship plugin code to every user and is what the owner rejected.
- The fallback I would offer the owner (Q1): per-plugin static backend Workers bound by service binding. The same bundle is deployed as a Worker with a DO namespace keyed by (org, plugin) behind the same `PluginHostPort`. Server code would be deployed for everyone, but no client downloads it and no route answers a non-user.

### 7. Migration order (slices)

Commands used below (from repository and package scripts):
- **root:** `bun run lint`, `bun run typecheck`, `bun run test:ci-policy`, `bun run test:architecture-ratchets`, `bun run docs:check-links`;
- **app:** `bun run --cwd packages/claxedo-app test|typecheck|typecheck:e2e|check`, and `bun run --cwd packages/claxedo-app e2e e2e/flows/<spec> --project web --project phone`;
- **server:** `bun run --cwd packages/claxedo-server test|d1:baseline:check|typecheck:auth-d1|smoke:workerd-boundary|verify:closure`;
- **local:** `bun run --cwd packages/claxedo-local-server test|verify:closure`;
- **desktop:** `bun run --cwd packages/claxedo-desktop test:broad|test:server-boot|verify:closure`;
- **packages:** `bun run --cwd packages/{plugin-runtime,claxedo-plugin-api,claxedo-plugin-build,claxedo-mcp,claxedo-tasks,claxedo-documents,session-core,workspace-runtime,account-contract,cli} test`.

Every ceiling change is the exact measured number, with its owner named in the adjacent comment (AGENTS.md "Architecture ratchets").

- [ ] **P0. Gates (no product change).**
- Prove on the staging Cloudflare account, with a throwaway Worker: Worker Loader and facets; facet deletion through supervisor `deleteAll` and/or `ctx.facets.delete`; a supervisor (non-facet) alarm; Worker Loader limits; Ed25519 verify in workerd.
- Record the results in `plugin-backends/README.md` "Gate finding".
- Checks: the existing `plugin-backends.workerd.test.ts`. No ratchet change.
- [x] **P1. `@claxedo/plugin-runtime`.**
- Move the supervisor, runs and entrypoints; add `PluginHostPort`, per-(org, plugin) naming, the persistent facet registry and caller handles (removing `x-claxedo-user-id`). `claxedo-server/src/plugin-backends/` keeps the hosted port adapter.
- Tests: `runs.test.ts` moves; the workerd suite (all current cases, plus a forged user-id header has no effect, an expired handle is refused, and two plugins in one org are isolated).
- Checks: plugin-runtime and server tests; typecheck; ratchets; server `verify:closure`. The Agent Plugins deployment closures (230/242) move by the measured count.
- **As built.**
  - `packages/plugin-runtime` exports `.` (the port and state types, `pluginSupervisor`, `pluginRefusal`, the caller header), `./supervisor` (`pluginSupervisorClass(hostPort)`) and `./entrypoints` (`PluginPlatform`, `PluginOutbound`). The hosted entry exports `class PluginSupervisor extends pluginSupervisorClass(hostedPluginHostPort)`.
  - `PluginHostPort` is `readState(orgId, pluginId)` and `readBundle(sha256)` only; `platform` and `scheduler` arrive with the calls that need them (P3). The runtime, not the host, verifies a bundle's digest and computes the Worker Loader generation. No local entry (owner ruling).
  - The supervisor is `org:<orgId>:plugin:<pluginId>`, so `PluginBackendRuns` holds one plugin's run. Facets are named `[className, name]` and recorded in the supervisor's `plugin_facets(name, class_name, created_at)`.
  - Caller handles: the backend gets `x-claxedo-caller` and resolves it with `env.PLATFORM.caller(handle)`, which answers `{ userId, orgId }` or null. A handle lives while its request is open and 10 minutes after, only under its epoch, only in its plugin's supervisor. §3.1's `identity.caller` builds on it in P3. Expiry is tested over a controlled clock in `caller-handles.test.ts`; the workerd suite covers the forged headers, a handle outliving its request, another plugin, and a reactivation.
  - Closures: Agent Plugins 227 modules and 27 packages, full-hosted 239 and 28 (`cloudflare:workers` moved into the runtime with the supervisor; the full-hosted provisioner still imports it). `@claxedo/plugin-runtime` joins `SERVER_DEPENDENCY_PREFIXES` in `script/ci-changes.mjs`.
- [x] **P2. Hosted installs and registry.**
- D1 tables (§4, replacing `plugin_backend_activations`); `host/registry.ts`, signature verify and copy; `/api/claxedo/app-plugins/*`; the enablement gate on `/api/plugins/:id/*`; uninstall deletion; `PLUGIN_REGISTRY_KEYS` plus the test key; the fixture `counter` plugin (`plugin-backends/fixtures/counter`) published to a test registry by a harness script.
- Tests (workerd): install, then enable per user, then route; non-enabled member gets 404; non-admin install gets 403; tampered blob or signature refused; uninstall deletes facets and blobs; update raises the epoch.
- Checks: server test; `d1:baseline:generate` then `d1:baseline:check`; `typecheck:auth-d1`; `smoke:workerd-boundary`; ratchets; server `verify:closure`.
- **Staging D1 reset after merge** (§4).
- **As built.** The adapter stays flat in `claxedo-server/src/plugin-backends/`: `installs.ts`, `registry.ts`, `lifecycle.ts`, `app-plugin-routes.ts`, `routes.ts` (with the gate), `org-caller.ts`, `bundles.ts` and `compose.ts`. `packages/claxedo-server/src/plugin-backends/README.md` documents the routes and their answers. The choices where this plan was open, or where the build differs from it:
  - **The epoch is its own table.** `app_plugin_epochs(org_id, plugin_id, epoch)` holds the fence, and an uninstall never deletes it. `app_plugin_installs` (`version, active, app_sha256, backend_sha256, manifest_json, release_json, signature, key_id, installed_by, changed_by, changed_at`) has no epoch column. A deleted install row would restart the epoch at 1, and a supervisor that still remembered the uninstalled run would read the reinstall as stale. Every install, update, disable, re-enable and uninstall raises the epoch in the same D1 batch as its change.
  - **Org defaults are positive only.** `app_plugin_org_defaults.enabled` is constrained to 1. Enablement resolves in order: the member's row, then the default, then off.
  - **Routes the plan did not name.**
    - The org switch back on is `DELETE /:id/disable`.
    - The org default is `POST` and `DELETE /:id/default`.
    - Members discover installed but not enabled plugins through `GET /installed`, which answers each install with `enabledForMe` and `orgDefault`.
    - `GET /catalog` (§1.7) is left to P4: it merges the registry's signed `index.json`, and P2 publishes no index format.
    - `POST /` refuses an installed plugin with 409 `app_plugin_installed`; a new version goes through `/:id/update`.
  - **Refusal codes.**
    - 403 `app_plugin_admin_required`.
    - 404: `app_plugin_not_installed` and `app_plugin_bundle_not_found`.
    - 409: `app_plugin_storage_downgrade` and `app_plugin_platform_unavailable`.
    - 422 `app_plugin_release_invalid`; 502 `app_plugin_release_unavailable`.
    - On `/api/plugins/:id/*`: 404 `plugin_not_activated` when the plugin is not installed or is disabled, and 404 `plugin_not_enabled` when the caller has not enabled it.
  - **Registry.**
    - `CLAXEDO_APP_PLUGIN_REGISTRY_URL` overrides the default `https://plugins.claxedo.dev`. Reads are not edge-cached, and a Worker cannot read `file://`.
    - `PLUGIN_REGISTRY_KEYS` is empty: a deployed Worker installs nothing until the registry's production key is issued and its public key pinned (owner action).
    - `registry-test-key.ts` reads `CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY`. Only the fixture Worker imports it, and `deployment-closures.test.ts` fails any deployed entry that reaches it. The hosted e2e harness boots the production entry, so P4's flow 64 needs a test composition of its own.
  - **Release format.** `@claxedo/plugin-api/release` has no `tools` and the manifest has no `permissions`; both arrive with P3.
    - The signature covers `canonicalJsonText(release)` as published, before manifest defaults are filled.
    - `@claxedo/plugin-build` adds `buildPluginRelease`, `signPluginRelease` and `release-cli.ts`, which writes a signed registry tree. The workerd suite signs its releases in process with a generated key; it does not shell out to the CLI.
  - **Bundles.** `plugin-apps/<sha256>.js` and `plugin-backends/<sha256>.js` in `CLAXEDO_AGENT_PLUGINS`, both stored before the row names them.
  - **Uninstall.**
    - It deletes the install, every enablement and the default, then calls `supervisor.purge`. The purge refuses while the host still answers an active backend, ends the run, `ctx.facets.delete`s every facet `plugin_facets` names, and only then runs `deleteAll` (the P0 finding). It runs even when no install was found, so a failed uninstall completes on retry.
    - Locally, `deleteAll` alone also passes the workerd test, because the run's facets are aborted first. So the order is pinned by `plugin-runtime/src/supervisor-purge.test.ts` over a recording `ctx`, red-checked without the per-facet loop.
    - Blob prefixes, links, origin rows and grants do not exist yet (P3, P6).
  - **Facet ids.** Every facet shares the supervisor's `ctx.id` (P0), so each request a facet receives carries `x-claxedo-object-name`.
  - **Where it runs.** Only the Agent Plugins entries mount the routes; they always have `PLUGIN_SUPERVISOR`, so `app_plugin_platform_unavailable` is reachable only from a composition without one. The base artifact serves no app-plugin route, and the app reads that 404 as "no app plugins" (R3).
  - **Cost.** The gate adds one D1 read to each backend request, beside the supervisor's own state read.
  - **Closures.** Agent Plugins is 232 modules and 27 packages, full-hosted 244 and 28. The base Worker is unchanged at 177 and 23.
- [x] **P3. Platform API v1 (hosted):** identity, projects, blobs, events, schedule, links; `@claxedo/plugin-api/backend` and `definePluginBackend`; manifest `permissions` and `tools` schema (`manifest-schema.ts`).
- Tests: per call, the undeclared-permission refusal, the dead-epoch refusal and the caller-scoped authorization; a wake fires once with a system handle; a link resolves anonymously and stops after revoke; the blob quota.
- Checks: plugin-api, plugin-runtime and server tests; typecheck; ratchets.
- **As built.** The contract is `@claxedo/plugin-api/backend`; its call schema is `@claxedo/plugin-api/backend-schema`, a separate module that keeps zod out of a backend's bundle. The README tables in `packages/claxedo-plugin-api`, `packages/plugin-runtime` and `claxedo-server/src/plugin-backends` list every call, its permission, its limits and its refusals. The choices where this plan was open, or where the build differs from it:
  - **One generic call.** `env.PLATFORM` is `object`, `active` and one generic `call(call, handle)`, which the supervisor admits. `PluginHostPort.platform(call, scope, caller)` answers what the runtime does not.
    - The runtime answers `identity.caller` and the schedule itself. It holds the blob size and quota, the event size and rate, and the wake limits.
    - No `scheduler` port: with no local runtime, wakes live wholly in the supervisor (`plugin_wakes` and its own alarm), and `plugin_scope` names the plugin to an alarm.
    - P1's `env.PLATFORM.caller(handle)` is gone; `identity.caller` replaces it.
  - **Caller origins.** A handle's caller is `{ orgId, origin, userId? }`: `person` for a signed request, `link` for a public link, `system` for a wake. `agent` arrives with tools (P6).
    - Calls that act as a person refuse a caller without one (403 `plugin_caller_not_a_person`): projects, `links.create`, and an event to the caller or to a project.
    - `identity.caller` has no `displayName`: the control-plane D1 stores no person's name, and Better Auth's database is not the supervisor's. This is a follow-up if a plugin needs it.
  - **Projects.** `projects.list` answers `{ id, repoKey }`; the D1 schema has no project name. Both project calls use `may` and `maySql` with the authority's project rule, so an org member is a project viewer and owners and admins rank higher.
  - **Blobs.**
    - Stored in R2 at `plugin-data/<org>/<plugin>/<key>`. The supervisor's `plugin_blob_usage` reserves a put's size before the host stores it.
    - The 1 GiB default can be overridden with `CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES`; the suite runs at 64 bytes.
    - `blobs.list` pages 1,000 at a time.
  - **Events.**
    - A new `plugin.event` `ControlPlaneEvent` (server-core) carries `recipientUserId`, and `eventVisibleTo` delivers it to that subscriber only.
    - The host nudges the org's live-sync room with one copy per enabled member of the audience. A `project` event needs the publisher to read the project.
    - Plugin events are not retained for replay.
    - The app does not decode them yet: routing them to a frame's `backend().events(...)` is P6 (P4 left it).
  - **Links.**
    - Served at `GET /api/claxedo/app-plugins/links/:token`, not `/p/<token>`, because Documents mounts `/p` in every hosted profile until P8b. The URL `links.create` answers names that path, so moving it later changes only the constant (`plugin-backends/paths.ts`).
    - Tokens are 32 random bytes, stored as their SHA-256 in `app_plugin_links`, at most 1,000 live per plugin. A link only `GET`s its declared path.
  - **Reserved paths.**
    - A manifest route under `/_` is refused by the schema.
    - The supervisor refuses any forwarded request under `/_` (404 `plugin_route_reserved`), so only the platform reaches `/_wake/<name>`.
    - `definePluginBackend` sends `/_wake/*` to `wake`.
  - **Wakes due while inactive.** A wake that comes due while the plugin is disabled or replaced is taken off the table and dropped.
  - **Tools and permissions.**
    - The manifest's `backend.tools` and the release's `tools` declarations are schema only.
    - `buildPluginRelease` refuses a manifest that declares tools until P6 extracts them.
    - `permissions` is optional in the type, an empty list when absent, so existing manifests need no change.
  - **Uninstall** also deletes the plugin's links (in the D1 batch), its wakes and blob accounting (with the supervisor's storage), and its `plugin-data/` prefix.
  - **Tests.**
    - The workerd suite exercises every call through `definePluginBackend` in the counter fixture. Its live-sync room is a recording stand-in (`RecordingRoom`), and the wake test delivers through the supervisor's `wakeDue` at a chosen time rather than waiting on the alarm.
    - `supervisor.test.ts` pins the alarm arming over a real SQLite database.
    - Not verified: a real alarm firing a wake in workerd or on Cloudflare (P0 measured a supervisor alarm firing once).
  - **Closures.** Agent Plugins is 235 modules and 27 packages, full-hosted 247 and 28; the base Worker is unchanged.
- [x] **P4. App: installed plugins and Marketplace.**
- `src/plugins/installed/`; `server.backend()` binding (web, desktop-signed `plugin.request` with `app: true`); events into frames (left for P6); desktop runs installed plugins in frames; the Marketplace "App plugins" section with install, enable, disable and uninstall, and permission dialogs. The bundled first-party path stays until P7b and P8b.
- Tests: app `src/plugins` (hash mismatch fails the load; a disabled plugin is never fetched; safe mode stops installed plugins) and `src/marketplace`.
- New flow `64-app-plugin-install.spec.ts` (web and phone, hosted fixture): the counter plugin is absent, then the admin installs it, the member enables it, its page counts, and disable removes the row and the route. Red run: skip the enablement gate.
- Checks: app test, typecheck, `typecheck:e2e`, check; ratchets; desktop `verify:closure` (renderer modules +N measured).
- **As built.** `packages/claxedo-app/src/plugins/README.md` (Installed plugins), `src/marketplace/README.md` (App plugins) and `e2e/README.md` (the registry option) describe the result. The choices where this plan was open, or where the build differs from it:
  - **The catalog.** `GET /api/claxedo/app-plugins/catalog` answers `{ canManage, registry: "listed" | "unavailable", plugins }`, each entry `{ id, name, description?, latest, versions, manifest, available }`, from a signed `index.json` (`@claxedo/plugin-api/registry-index`) that the release CLI re-signs with each release it publishes. The installs stay `GET /installed`'s, so the catalog carries no `installed` block and the app joins them (`appPluginEntries`). `icon` is not in the index; the card draws the name's initial. `available` is false for a backend where no supervisor runs. An index that is missing or does not verify answers `registry: "unavailable"` and the installs still list.
  - **No edge cache.** The catalog reads the index on each request; the app reads it once per start and after every Marketplace write. Caching is a measured follow-up.
  - **Permissions shown.** The install and turn-on drawer lists the frame, the backend, each `permissions` entry in plain words, and each outside host, route and operation. An install of an older version shows the latest version's manifest, the only one the index carries.
  - **`canManage`** is the server's `administer` answer; the app asks `can("appPlugins.manage")` with it.
  - **The backend binding.** `api.server.backend().fetch(path, init)` exists only for a manifest with `backend` and reaches only the plugin's own id. Web: `/api/plugins/<id><path>`. Signed desktop: the account operation `plugin.request`, now exposed to the app (`{ renderer: true, app: true }`); it carries a JSON object body or none and no query string, a limit of the operation's contract. Frame: the host call `server.backend.fetch`. `server.operation("plugin.request")` is refused. There is no daemon binding: there is no local runtime.
  - **Desktop frames (Q5).** Installed plugins run in the sandboxed frame on the desktop too. The frame runtime is a string chunk (`virtual:claxedo-frame-runtime`, `vite.frame-runtime.ts`), taken from Vite's own inline worker bundle. Not verified: an installed plugin running in an Electron frame on the `file:` renderer; the desktop production build carries it.
  - **Events (left for P6).** P3's `plugin.event` reaches the app's live-sync stream, but the app neither decodes it nor routes it to a frame; `backend().events(...)` is not in the API. The hosted Worker sends no `plugins.changed` on an install or enablement, so another tab or device sees a change at its next start.
  - **Live plugins (P5's gate).** The app reads the daemon's live list only on a signed desktop with `features.livePlugins`; a live plugin is frontend-only. The web and the unsigned app run none. The gate is the app's: the daemon still serves its registry to the machine's owner, so flow 35 checks that an unsigned web app runs a plugin the daemon serves nowhere. Removing the daemon's routes is left to the live-plugin owner.
  - **Safe mode** stops installed plugins and skips the installed list. An installed plugin has no local switch; the Marketplace is where a member turns it on or off.
  - **Flows.**
    - 64 (web, phone) is new. Its red run removed the enablement gate: the member's backend read answered 200 `{ value: 0 }` instead of 404 `plugin_not_enabled`.
    - 35's web test is an installed plugin on a signed account; its second test is the unsigned app running none. Red run: with the unsigned gate removed the approval dialog for the daemon's plugin appeared.
    - 61 and 37's web test run installed plugins on the signed stack. Red run: with the member's enablement withdrawn, 61 found no rail item and 37 no server answer.
    - 34 and 37's desktop test sign in first (`signedCloud`, `signedDesktop`). Not run here: the desktop project.
    - 40 ends asserting the unsigned web app lists no app plugin. Not run here: it needs the real Claude CLI.
  - **Test composition.** `fixtures/full-hosted.fixture.cf.ts` is the full-hosted Worker over `registryKeysWithTestKey`; `composeBetterAuthD1AgentPlugins` takes `registryKeys`. The e2e harness runs it only when a flow asks for `signedAppPluginRegistry`.
  - **Closures.** Agent Plugins is 236 modules and 27 packages, full-hosted 248 and 28 (the catalog). The desktop renderer is 1,587 modules and 44 packages: the walk follows `virtual:claxedo-frame-runtime` to the runtime's entry. The app's line budget is 117,432.
- [x] **P5. Local runtime.** Removed by owner ruling (plugins only when signed in). Instead, P4 removes or gates the daemon's live-plugin registry, and flows 34 and 35 move to a signed account.
- [ ] **P6. Platform API v2 on both hosts:**
- sessions (§3.3), with `plugin_session_origins` in D1 and `claxedo.db`;
- cloud workspace allocation through `origin-cloud-workspace.ts`;
- tools (§3.4) on the three MCP mounts, plus the plugin-tools root grant and env;
- session files (§3.9) in `workspace-runtime`;
- backend events into the app: decode `plugin.event` and route each to its plugin's `backend().events(...)`, in the frame and in-app, and nudge the installed list on install and enablement changes.
- The generic modules move from `@claxedo/tasks/host/*` and `/hosted/*` while the old in-process Tasks still composes them by import from their new homes, so nothing breaks.
- Tests: session start is idempotent per origin, handoff happens at most once, and abandon compensates (moved Tasks bridge tests, made generic); the member-driven agent refusal; proxy tools listed only when enabled; a sandbox call with a withdrawn grant is refused; session files round-trip through `turnSettled`.
- Checks: server-core, server, local, mcp, session-core and workspace-runtime tests (runtime suites under the no-signal `sandbox-exec` profile); typecheck; ratchets; all `verify:closure`.
- [ ] **P7a. Tasks backend on facets (not yet shipped).**
- `src/backend/`, `src/storage/facet.ts`, tools, release script. It is tested in the package under Miniflare (the conformance suite on the facet store; routes; tools; start through a platform double), plus a server workerd host test that installs the Tasks release and runs a local Start.
- Checks: tasks test, server test, typecheck, ratchets.
- [ ] **P7b. Tasks cutover.**
- Delete every Tasks row of §4: the bundle entry, composition, schema plus the drop migration, the D1 source, the MCP group, the vocabulary, env names, the owner-grant retype and `tasks-plugin/**`.
- Flows 18, 36 and `63-tasks-*` gain an arrange step that installs and enables Tasks from the test registry.
- New negative flow: a member who has not enabled it sees no Tasks rail row, no `/tasks` route (it 404s into the shell's not-found) and no `task_*` tools in an MCP `tools/list`.
- Checks: everything in "Commands used"; `d1:baseline:check`; `rg -n "@claxedo/tasks" packages --glob '!packages/claxedo-tasks/**'` returns only the registry harness script.
- **Staging D1 reset after merge.**
- [ ] **P7c. Tasks UI.**
- The catalog's `RichTextEditor`, `Dialog`, title field, clickable rows and cards and property chips (generic, in `@claxedo/plugin-api/surface` and the app renderer), and the Linear and Notion-like Tasks page and presets built from them.
- Flows `63-tasks-board` and `63-tasks-presets` are rewritten by role and name: edit the description with bold and a list, read it back as Markdown through `task_get`, paste an image, drag across columns, use the keyboard path on phone. Red runs are recorded.
- Checks: tasks test and `verify:closure`; app check; ratchets.
- [ ] **P8a. Documents backend on the platform:** facets, blobs, links, session files, tools; tested as P7a.
- [ ] **P8b. Documents cutover.**
- Delete every Documents row of §4: `/documents` and `/p` host routes, the CLI command, operations, `CLAXEDO_DOCUMENTS`, the hydration contribution and the doc migrations; add to the drop migration.
- Flow: install Documents, have an agent open a doc in a session, see the edit written back, open the public link anonymously, and revoke it.
- Checks: as P7b, plus cli test (`claxedo help` loses `documents`) and desktop `test:broad` (IPC inventory without `documents.*`).
- Delete the staging R2 bucket (§4).
- [ ] **P8c. Documents page** (an A2UI page with the `RichTextEditor`). Flows and checks as P7c.
- [ ] **P9. Ratchets and closures.**
- `script/app-plugin-isolation.test.ts` (in `test:architecture-ratchets`): no production module outside the two plugin packages and the registry harness imports them; plugin packages import only the §5.1 allowlist.
- Add `@claxedo/tasks` and `@claxedo/documents` to `forbiddenPackages` of the `server-workerd`, local-server, desktop, desktop-renderer and deployment-closure policies.
- New authoritative check: no emitted app or renderer chunk resolves into `packages/claxedo-tasks|documents`.
- Set every product ceiling exactly; the `tasks-app` and `documents-app` policies move to measuring the release bundles.
- Checks: ratchets; every `verify:closure`.
- [ ] **P10. Docs.**
- Rewrite `src/plugins/README.md` (installed versus live), `plugin-backends/README.md` (moved to `packages/plugin-runtime/README.md`), `agent-plugins/README.md` (deployment requirements), the `@claxedo/plugin-api` README (backend, permissions, release), the Tasks and Documents READMEs, and `public-docs/user-deployed-cloudflare.md` (drop `CLAXEDO_DOCUMENTS_BUCKET`; add the registry URL).
- Update `docs/plans/README.md`, mark the 2026-10-18 plan superseded, and add a DECISIONS entry ("Owner, 2026-10-20: plugins are opt-in installs").
- Checks: `docs:check-links`, and a full final run of the commands once (AGENTS.md "Validation cadence").

Order and lanes: P0, then P1, then P2, then P3. P4 follows P3. P6 follows P4. Then P7a–c and P8a–c (P8a can start beside P7b), then P9, then P10.

### 8. Risks and open questions

- **Q1. Production availability of the beta Worker Loader and facets.** Recommendation: block on P0. If refused, choose between "no backend plugins on that deployment" (default) and the static per-plugin Worker fallback (§6). Do not go back to in-process.
- **Q2. Install authority.** Recommendation: org owners and admins install, members enable for themselves, and an admin may set a positive org default. In a personal org the owner does both.
- **Q3. Signed desktop scope.** Settled by owner ruling: only signed accounts have plugins.
- **Q4. Uninstall semantics.** Recommendation: uninstall deletes data immediately after a confirm naming the plugin; "Disable for organization" is the keep-data path. No tombstone period.
- **Q5. Desktop frames.** Running installed plugins in frames on desktop (not in-app) needs the frame runtime inlined for `file:`. Recommendation: do it in P4; the in-app realm remains only for live developer plugins behind approval.
- **Q6. Documents in the repository.** The local repository-backed origin (`host/repository/*`, git) has no place in plugin storage. Recommendation: drop it. Documents live in plugin storage on both hosts and reach a session as session files; a file in the repo is just a file agents already edit.
- **Q7. Core routes from a plugin frontend.** Tasks needs `GET /api/claxedo/plugins` for preset pickers. Recommendation: keep `server.routes` with the prompt listing it, and add method-scoped entries (`GET /api/claxedo/plugins`) to the schema in P3.
- **Q8. CLI.** Recommendation: no plugin CLI commands. A generic `claxedo plugin request <id> <METHOD> <path>` only if asked.
- **R2. One supervisor per (org, plugin) is single-threaded.** A busy org's Tasks shares one object. Recommendation: facets per project spread the storage work; measure only if the owner asks for benchmarks (repo rule).
- **R3. Deploy skew.** The hosted Worker and app deploy separately, and the app's installed-plugin list needs the P2 routes. Recommendation: deploy the control plane before the app (the existing job order); the app treats a 404 list as "no app plugins".
- **R4. Tool name collisions across plugins.** Recommendation: refuse at install, naming both plugins; core names are reserved.
- **R5. Facet SQLite row limits.** Attachments go to blobs, so a facet row stays small. Recommendation: P7a asserts row-size caps in the store.

### Critical Files for Implementation
- /home/user/Claxedo/packages/claxedo-server/src/plugin-backends/supervisor.cf.ts
- /home/user/Claxedo/packages/claxedo-server/src/plugin-backends/routes.ts
- /home/user/Claxedo/packages/claxedo-app/src/plugins/provider.tsx
- /home/user/Claxedo/packages/claxedo-plugin-api/src/manifest-schema.ts
- /home/user/Claxedo/packages/claxedo-mcp/src/server.ts