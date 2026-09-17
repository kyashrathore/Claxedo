# The OpenCode engine exists only while a workspace has chosen it

Status: proposed 2026-09-16, not started. Supersedes item 1 of
`2026-09-16-001-fix-daemon-resource-waste.md`; items 2–8 there stand.

Measured on the dev install from a fresh data directory with no harness ever
selected: the daemon booted the OpenCode engine anyway, the engine's catalog
poll rewrote `opencode-runtime/opencode.db` every 5 minutes, and opening a
location for `~/test/opencode` walked 7 GB of the checkout at 200% CPU inside
`libfff_c.dylib` (every `sample` of the burst; git tracks 70 MB there). This
plan is the first-principles fix for the engine starting up unasked; the
per-symptom mitigations (fff off, catalog pinned) are here too, but as
properties of the one design, not as switches.

## The flow today, observed

**A. Daemon start.** `startSelfHostedServer` → `createSelfHostedApp`
(`claxedo-server/src/deployments/self-hosted-node/app.ts:1605`):
`const opencodeRuntime = openCodeSdkRuntime()` — the server-core singleton
(`claxedo-server-core/src/opencode/sdk-runtime.ts:29`) that composes
`createOpenCodeRuntime` in-process (`workspace-runtime/src/opencode/runtime.ts:43`):
one `OpenCodeHost` over `@opencode-ai/sdk`, plus ports for sessions, catalog,
configuration, provider policy, provider binding, launch policy,
interactions, tools, and a process-wide event pump. The host is lazy
(`host.client()` boots on first call; `status().lifecycle` starts `cold`).
`configureEmbeddedWorkspaceRuntime({ opencodeRuntime, … })` hands the same
object to every embedded workspace runtime
(`claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:197`).
The standalone composition does the same (`start-local-server.ts:130`).

**B. What boots it.** Any of the ports' first call. The credential bridge is
already careful — `syncCredentialsToSdk` is write-only-when-running and never
boots a cold host (`sdk-credential-bridge.ts:158`) — and the `/providers`
route answers the opencode catalog from Claxedo's own file
(`provider-routes.ts:47`, `opencodeProviderCatalog`). What is not careful:

- B.1 `OpenCodeSdkHarnessAdapter` (`workspace-runtime/src/opencode/harness-adapter.ts`):
  `listAgents` (`:531`), `listCommands` (`:523`), and `executeTurn` reach
  `this.engine()`. The turn's event subscription (`:434`)
  calls `runtime.events.subscribe` → `pump.start()` → `host.client()`.
  In contrast, `readHarnessCapabilities` (`:344`) returns static data with
  `configOptions: false`; this adapter does not implement `probeConfigOptions`.
  A route naming the adapter is not by itself proof that it boots the engine.
- B.2 The catalog, provider-policy and tool ports call the engine with
  `{ location: { directory } }` (`catalog-port.ts:64,79,94`,
  `provider-policy.ts:75`, `tool-port.ts:104`). A location call is what
  opens the engine's per-directory services — `FileSystemSearch`, and with it
  `fff` — for that checkout.
- B.3 The adapter is created whenever a request names the harness:
  `requestedSessionHarness(c.req) ?? currentRunner()` on
  `/api/wr/harness-config-options` (`workspace/runtime.ts:1471`), `/agent`
  and `/command` via `resolveAdapter` (`routes/session-core.ts:2335,2481`),
  `/api/wr/health?nativeHarness=…`. With no user selection `currentRunner()`
  throws `WorkspaceHarnessUnavailableError`, so on a fresh install the
  request has to *name* opencode.

**C. Suspected client trigger, not an observed request chain.**
`claxedo-app/src/app/workbench/context/directory-scope.tsx:255` describes an
absent-means-opencode convention and converts an opencode pane harness to
absence. However, the comment in
`claxedo-app/src/features/session/composer/composer.tsx:482` claiming that
`composerHarnessId` defaults to opencode is stale:
`features/session/composer/mode.ts:18–25` returns the explicit `HarnessRef`
or undefined. `harness-mode-helpers.ts:34` consults that value and the
controller; its callers must be traced rather than inferred from comments.

The runtime's canonical session reader also does not default missing identity
to opencode: `workspace-runtime/src/store.ts:632–641` requires both harness
id and access. Inventory reaches this store through
`workspace/runtime.ts:1023–1024`. Its binding join currently supplies workspace
identity, not a recovered harness (`store.ts:3349–3381`). The separate
`getSessionConfig` reader returns null for missing harness identity
(`store.ts:4041–4086`), and execution rejects missing configuration
(`workspace/runtime.ts:923–932`). These are migration points, not evidence
that a request named opencode. Phase 0 must identify the actual request and
engine-calling operation before attributing the measured boot to a reader.

**D. What the engine then does on its own** (`@opencode-ai/core`, not
configurable from outside today):
- `ModelsDev` forks `refresh().pipe(Effect.repeat(Schedule.spaced(5 min)))`
  at boot: GET `https://models.dev/api.json` (5.3 MB), write the body into
  the `kv` table on digest change (10 MB WAL + checkpoint per change).
- `FileSystemSearch.layer()` chooses `fffLayer` for a VCS checkout on macOS
  (`options?.fff === false` is the only opt-out, and nothing passes options):
  `Fff.create({ basePath, aiMode: true, disableMmapCache: true,
  disableContentIndexing: true })` — six `fff-bg-*` workers and a
  `fff-git-status` thread walk the tree, ignoring `.gitignore` boundaries
  (`node_modules`, `.worktrees/`) and reading content.

**E. What has not been pinned:** the trigger for the boot at 22:46:42,
including whether a request carried `nativeHarness=opencode`. The daemon is
detached with `stdio: ignore`, so that request was not captured. Phase 0
correlates request tracing with the first host boot and location setup,
recording the concrete caller and operation without logging credentials.
Revise the diagnosis and affected callers if the evidence contradicts C;
do not claim Lane A alone fixes the measured boot before reproducing it.

## Goal

- No OpenCode engine process or thread exists until a workspace's applied
  configuration selects `{ kind: "native", harnessId: "opencode" }` or a
  session bound to that harness runs. "Absent" never means opencode.
- The engine is a harness like the others: launched by the daemon on
  selection, shared across the workspaces that selected it, stopped after
  the last one releases it plus an idle grace.
- While it runs, it does only what it was launched for: no models.dev poll,
  no file-tree index. Claxedo's own catalog is the one catalog owner; the
  composer probes the harness for the models it can *run*, never for the
  catalog.

## Design

### 1. "Absent harness" is a defect, not a family

The wire and the client stop inferring opencode from absence. A session row
and a draft carry an explicit, complete harness identity or none; "none"
renders as unconfigured and issues no harness-scoped request. Remove actual
absent-means-opencode reads, not explicit native-opencode declarations.
Reassess the permission guard in `composer.tsx` against live identity flow;
remove it only after native/connection permission-delivery tests prove it
redundant, not because its comment describes an obsolete default.

`workspace-runtime/src/store.ts` owns identity recovery for legacy rows.
Use one canonical resolver for inventory, single-session, and config reads,
so list output, config endpoints, and execution binding resolution agree.
For missing stored identity, recover the complete identity from a valid
`session_execution_binding`; do not repair only presentation events.
`connectionIdForHarness` (`agent-runtime-contract/src/sessions.ts:142`)
encodes `access:id`. Decode and validate that contract, preserving the access
kind and the exact remaining id, including any separators within it. Never
infer native access from a built-in-looking name or use the encoded key as
the connection id. The client receives `{ kind: "native", harnessId }` or
`{ kind: "connection", connectionId }`, not an ambiguous bare id.

Rows without either identity source remain explicitly unconfigured. Invalid
or conflicting identities produce a diagnostic rather than silently choosing
an adapter. Existing complete identities retain their meaning. Presentation
projections consume the canonical result; they do not create a second recovery
path. Cover legacy rows, missing bindings, malformed/conflicting identities,
and native/connection id collisions through list, config, and execution
entrypoints, including reopening after restart.

### 2. The engine becomes a process harness, shared lazily

`openCodeSdkRuntime()` is deleted from both daemon compositions, and with it
`opencodeRuntime` on `createWorkspaceRuntimeApp` and the SDK/core dependency
in the daemon bundle. In its place, `agent-sdk-runtime` gains an
`opencode` harness with the ACP shape (`acp/process-manager.ts:380`
`getOrSpawnProcess: reusing shared process`):

- **One child per daemon**, `opencode serve` (or the SDK inside a Node child
  — decided in Lane B by which one the pinned beta supports without
  patches), bound to loopback with a per-launch token, database under
  `<dataDir>/opencode-runtime/`, started by the first `acquire(workspace)`,
  released by `release(workspace)`, stopped after the last release plus an
  idle grace (the daemon's own lease pattern, `server-daemon-lease.ts`).
  Lane B first proves the transport on the pinned beta with a spike before
  any port is retargeted: install the Claxedo tool plugin, register and
  re-register session tools, and exercise a tool callback against a real
  child. The spike must also prove authenticated client calls, SSE delivery,
  search-layer replacement, and a no-fetch catalog in the child. Record the
  chosen entrypoint, supported APIs, and exact verification commands before
  retargeting ports. If these require an unapproved dependency patch, stop
  and record the unsupported capability.
  If the transport spikes fail, stop and report rather than silently
  reverting to an in-process engine: the lifecycle goal, not the transport,
  is the fixed constraint.
- **Leases cover both selection and execution.** A workspace selection lease
  is taken on apply and released on deselect or close. An execution lease is
  taken when a session binds and runs on the child and released on turn
  completion, cancellation, or failed startup. Deselect does not evict an
  active turn: the workspace lease may drop to zero while the execution lease
  holds. An idle timer may stop the child only when no workspace selection
  and no execution lease remains; the timer resets on acquire. After a daemon
  restart, restore leases from persisted selections and recover bound
  sessions. A crashed or unreachable child is restarted for the next acquire
  and never resurrects a completed turn.
- The SDK client stays: `OpenCode.make({ baseUrl })` over HTTP is what the
  in-process host already speaks after `create`; the ports (`session-port`,
  `interaction-port`, `event-pump`, `tool-port`) keep their code shape and
  change transport. The event pump subscribes to the child's SSE and fans
  out as today.
- Provider policy and launch policy become **launch projections** (config
  handed to the child at start and on credential change, the way
  `claudeAuthEnv` and the launch document are for Claude), not live plugin
  calls into an in-process host. The credential bridge keeps
  write-only-when-running against the child.
- Tool dispatch (`tool-port.ts`, "the SDK owns tool dispatch for its
  sessions") registers the Claxedo tool plugin with the child over the same
  plugin route the SDK exposes; the callback URL is the daemon's, as today.

`acquire` is called from exactly two places: applying a workspace config
whose harness is opencode, and binding a session to it. Nothing else can
reach the child.

### 3. The child is launched with Claxedo's layers

Whether `opencode serve` or the SDK-in-a-child, the launch passes:
- search: `FileSystemSearch.configured({ fff: false })` — ripgrep on demand,
  the engine's own Windows path; no index, no walk. Verified by a real-engine
  test on a temporary git checkout that asserts the search service is the
  ripgrep layer (no `fff-*` threads, no `Fff.create`), not that an option was
  passed.
- catalog: `ModelsDev` with `fetch: false` and `file` = Claxedo's
  `opencode-model-catalog.json`. Claxedo is the one owner of that file:
  fetched by `opencode-provider-catalog.ts`, ETag-conditional, on a daily
  cadence and on demand from the connections screen — never by the engine.
  If the pinned beta cannot take these as layer overrides in the child, the
  fallback is the engine's config document (`models_dev` / file URL) and the
  plan records which held.

### 4. Models: probe what can run, own what exists

The composer keeps probing the selected harness for models
(`/api/wr/harness-config-options` → `probeConfigOptions`). For opencode the
probe answers the engine's `model.list` — providers with credentials — and is
cached per child launch keyed by the child's catalog digest, invalidated on
credential change. The catalog (217 providers / 7,822 models / 4.6 MB) is
never the probe's answer and never crosses to the renderer as a model list;
it serves provider metadata to the connections screen only.

## Change points

- `claxedo-app`: `directory-scope.tsx:255`, `harness-mode-helpers.ts:34`,
  `composer.tsx:482`, the session-list reader, and every consumer of the
  absent-means-opencode convention (Lane A enumerates by grep for
  `"opencode"` defaults and the convention's comments).
- `agent-event-runtime` client-presentation projection: harness on every
  session row.
- `agent-sdk-runtime/src/harnesses/opencode/*` (new): process manager
  (acquire/release/idle), launch projection, probe, adapter.
- `workspace-runtime/src/opencode/*`: `host.ts` and `runtime.ts` deleted;
  ports retargeted to the child client; `harness-adapter.ts` rebuilt on the
  new harness; `workspace/runtime.ts:181,492,1854` lose `opencodeRuntime`.
- `claxedo-server-core/src/opencode/sdk-runtime.ts` deleted;
  `sdk-credential-bridge.ts` targets the child.
- `claxedo-server/.../app.ts:1605`, `claxedo-local-server/.../start-local-server.ts:130`,
  `embedded-workspace-runtime.ts:75,144,158,197`: no engine at composition.
- `claxedo-server-core/src/credentials/opencode-provider-catalog.ts`: the
  single catalog owner (cadence + ETag).
- `patches/@opencode-ai%2Fsdk@…patch`: keep the `create(options, embed)`
  extension only if the SDK-in-a-child path is chosen; delete it otherwise.

## Definition of done

Each row verified on the installed dev build from a fresh data directory,
tracker recording, numbers written in.

- [ ] Phase 0 — capture: relaunch the app from Finder, inspector on the fresh
      daemon, CPU profile armed; open a project and a draft composer; the
      profile names the request that called into the engine. Recorded here
      before Lane A starts. Progress:
- [ ] Fresh install, two projects, Claude sessions run: no process named
      `opencode` and no `fff-*` thread in the daemon at any point; no
      `opencode-runtime/opencode.db` exists; no request to `models.dev` from
      the daemon in 30 min. Progress:
- [ ] Grep gate: no `?? "opencode"`, no absent-means-opencode read remains in
      `claxedo-app`, `agent-event-runtime`, `workspace-runtime`; a draft with
      no harness issues zero requests carrying `nativeHarness`. Progress:
- [ ] Select the opencode harness on this monorepo: one `opencode` child
      appears within 5 s; daemon + child reads in the following 60 s
      < 100 MB (was 7 GB); no `fff-*` thread; a file search from the
      composer still answers (ripgrep). Progress:
- [ ] Deselect / close the last opencode workspace: the child exits after
      the idle grace; a second workspace selecting opencode while the first
      holds it shares the same child (one pid). Progress:
- [ ] Models: the composer's model picker for opencode shows only providers
      with credentials; the renderer never receives more than the probe
      (response size logged < 200 KB); the catalog file is fetched at most
      once per day (ETag). Progress:
- [ ] Credentials: adding and removing a provider credential while the child
      runs is reflected in its providers without restart; with the child
      cold, nothing is spawned. Progress:
- [ ] Tests: process-manager acquire/release/idle/shared (fake child),
      real-engine search-layer test, no-fetch catalog test, launch-projection
      test, absent-harness client tests, projection harness-on-every-row test.
      `bun run test:architecture-ratchets` passes; boundary closure for the
      daemon bundle no longer contains `@opencode-ai/core`. Progress:

## Non-goals

- Changing the other harnesses' process units.
- Making fff honour ignore rules — it is not used.
- The transcript scanner's first cold walk (tokentracker's).

## Execution: parallel lanes with disjoint ownership

- **Lane A — absent ≠ opencode** (`claxedo-app` readers, `agent-event-runtime`
  projection). Independent of the engine work; lands first and alone
  already stops the unasked boot on this install.
- **Lane B — opencode process harness** (`agent-sdk-runtime/src/harnesses/opencode/*`
  new; the two compositions; `workspace-runtime/src/opencode/*`). Owns the
  serve-vs-SDK-child decision and the launch layers (search, catalog).
- **Lane C — catalog owner + probe** (`opencode-provider-catalog.ts`,
  `provider-routes.ts`, the probe cache in the new adapter). Pairs with B on
  the probe contract.
- Phase 0 runs before A on the live daemon and is the only serial step.

One adversarial review per lane on the diff, one re-review after fixes,
then the integration pass with the tracker; no third review pass.
