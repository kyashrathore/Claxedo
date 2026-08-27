---
title: "refactor(runtime): cut over completely to the public OpenCode embedded SDK"
type: refactor
status: active
date: 2026-08-27
planned-at: 8be1be76ce
deepened: 2026-08-27
priority: P1
effort: XL
risk: HIGH
---

# refactor(runtime): cut over completely to the public OpenCode embedded SDK

## Overview

Replace every OpenCode execution path with the public V2 embedded SDK and make
that invariant true in source, dependency graphs, packaged artifacts, and
runtime process inventories. The final product directly installs one exact
public SDK release. It does not carry or select the vendored engine,
`sdk-next`, `opencode/node-embed`, `opencode serve`, an external OpenCode URL,
the desktop engine worker, or a raw `Request -> Response` compatibility path.

This is a repository-wide runtime migration, not an additive integration. It
changes the user action that starts OpenCode as follows:

1. A desktop, self-hosted, or hosted workspace request reaches that workspace's
   `WorkspaceRuntime`.
2. The process-owned OpenCode runtime lazily creates one public SDK host with an
   explicit database path, configuration, and Claxedo plugins.
3. `OpenCodeHarnessAdapter` invokes a narrow typed Claxedo port backed only by
   the SDK client.
4. One retained SDK event pump projects OpenCode events once into Claxedo's
   canonical runtime event model.
5. The UI, session projection, usage meter, subagent admission, and WorkGraph
   consume that one projection.
6. Process shutdown closes the SDK host exactly once after ingress and event
   queues drain.

There is no fallback to an old runtime at any step. An SDK boot, migration,
plugin, or request failure remains an explicit OpenCode-unavailable error while
other harnesses continue independently.

## Problem Frame

The repository currently has several mutually incompatible meanings of
"embedded OpenCode":

- `packages/claxedo-server-core/src/opencode/engine.ts` chooses between an
  in-process `sdk-next` host, a loopback desktop worker, and an external URL.
- `packages/sdk-next/src/embedded.ts` imports the private
  `opencode/node-embed` artifact and exposes the fork's internal router as raw
  `fetch`.
- `OpenCodeHarnessAdapter` can use an injected raw request function, forward to
  a URL, or spawn `opencode serve`.
- Hosted sandbox images install the OpenCode binary. Their image-build smoke
  explicitly runs `opencode serve` and passes `OPENCODE_URL`; deployed runtimes
  omit that URL, so `OpenCodeHarnessAdapter` instead spawns the installed binary
  on first use. Both the build-time sidecar and deployed on-demand spawn must go.
- Local compatibility routes, WorkGraph, credentials, MCP, and event bridges
  call the raw engine transport directly.
- Desktop builds and ships a separate engine artifact, worker, and V8 compile
  cache.

The now-public embedded SDK makes those paths unnecessary, but its public
contract is deliberately typed and does not expose the in-memory router or raw
`fetch`. A complete migration therefore requires replacing the raw HTTP domain
port, not wrapping the SDK beside it. It also requires resolving the package
name collision with the repository's legacy `packages/sdk/js` package, which
currently owns `@opencode-ai/sdk`.

## Requirements Trace

### Runtime and ownership

- **R1. Direct public dependency:** install and lock one immutable public V2
  SDK release and its matching client/plugin family. Do not commit `@dev`,
  `@beta`, or a range. The final releasable dependency/artifact closure contains
  one OpenCode runtime family; a non-released migration branch may temporarily
  retain the repository's pre-existing legacy families while consumers move.
- **R2. One runtime path:** the public embedded SDK is the only OpenCode
  executor in desktop, self-hosted, local workspace-runtime, hosted sandbox,
  tests, and release artifacts.
- **R3. One lifecycle owner:** one lazy, single-flight SDK host exists per OS
  process: shared across local embedded workspace runtimes, and one inside each
  sandbox workspace-runtime process. Only the process composition owns
  readiness and `close()`.
- **R4. Typed boundary only:** consumers use a narrow Claxedo-owned typed port
  implemented by the public SDK. No consumer receives a URL, raw router,
  generic `fetch`, SDK constructor, or private SDK import.

### Behavioral parity

- **R5. Session parity:** preserve create, get, list, rename, archive/delete,
  prompt, command, steer/queue, interrupt, fork, revert/unrevert, paged
  messages/history, resume, active status, subagents, permissions, structured
  questions, and todo behavior through real typed operations or a clearly
  authoritative Claxedo-owned producer. Because V2 exposes delete but no
  archive mutation, Claxedo's session projection remains authoritative for
  archive state while SDK `session.remove` remains authoritative for deletion.
- **R6. One event authority:** one SDK event pump emits each OpenCode fact once
  into Claxedo's event model. Metadata projection, usage metering, WorkGraph
  intake, session waiters, and UI streaming must not maintain separate engine
  readers or duplicate suppression paths.
- **R7. Integration parity:** Claxedo's credential registry, Agent Config/MCP
  authority, WorkGraph tools, connection tools, provider/model catalog, and
  session intake continue working without raw engine control routes.
- **R8. Outer contract clarity:** retain compatibility HTTP routes that have a
  current Claxedo consumer or a documented/published external support contract.
  Implement each as an explicit typed translation or Claxedo-owned operation;
  remove unsupported arbitrary passthrough routes only after checking public
  docs, package exports, operator integrations, and the declared compatibility
  window. Delete fabricated `{}`, `[]`, `true`, or closed-stream fallbacks.

### Persistence, operations, and removal

- **R9. Durable migration:** existing OpenCode sessions and related state
  survive the cutover. Migration is a one-writer, restart-safe operation with a
  consistent pre-migration backup, semantic validation, and a durable marker.
- **R10. Failure integrity:** SDK boot, migration, stream, credential, MCP, or
  plugin failure must surface canonically. No request retries a potentially
  admitted prompt and no error selects the removed runtime.
- **R11. Complete removal:** eliminate the forked runtime, old generated SDK,
  `sdk-next`, node-embed artifact, server process manager, desktop worker,
  external URL mode, ambient engine database configuration, raw SSE readers,
  raw proxies, runtime flags, packaging inputs, and obsolete tests/docs.
- **R12. Artifact proof:** CI must prove source, production dependency closure,
  desktop packages, self-hosted bundles, sandbox images, and process inventories
  contain only the pinned public SDK path.

## Scope Boundaries

### In scope

- Every desktop, local server, self-hosted, hosted relay, and sandbox OpenCode
  execution and packaging path.
- The OpenCode adapter, workspace-runtime composition, retained compatibility
  routes, WorkGraph OpenCode paths, credentials, MCP, event projection,
  persistence, lifecycle, and shutdown.
- Removing vendored packages that can execute or expose the old OpenCode
  runtime, plus severing shared UI code from those packages before deletion.
- Updating outer Claxedo contracts where V2 semantics are richer, notably
  structured form replies and asynchronous prompt completion.

### Out of scope

- Changing the default harness or behavior of Claude, Codex, Cursor, Pi, or
  operator-configured ACP harnesses.
- Replacing Claxedo's own terminal, relay, workspace, session projection,
  usage, credential, or Agent Config authorities with OpenCode-owned versions.
- Preserving a public `opencode serve` endpoint or supporting attachment to an
  independently managed OpenCode process.
- Redesigning shared UI components solely because they originated in the
  OpenCode fork. UI-only code may remain only after it has no runtime/server
  dependency edge and uses Claxedo or public client contracts.
- Depending on an unpublished upstream raw-router escape hatch. V2 PTY metadata
  and connection-token APIs are public, but Claxedo intentionally retains its
  existing terminal authority rather than add a duplicate OpenCode PTY path.

## Context & Research

### Relevant code and current owners

- `packages/claxedo-server-core/src/opencode/engine.ts` owns today's global
  mode switch, database environment mutation, worker, boot hooks, application
  tools, raw transport, and shutdown.
- `packages/sdk-next/src/embedded.ts` reaches into the vendored
  `opencode/node-embed` router and registers private application-tool runtime
  hooks.
- `packages/agent-sdk-runtime/src/harnesses/opencode/{index,process,events}.ts`
  implement raw HTTP operations, SSE parsing, URL forwarding, and
  `opencode serve` ownership.
- `packages/workspace-runtime/src/workspace/runtime.ts` configures the adapter
  and proxies provider, MCP, VCS, global events, Session V2, and dynamic tools.
- `packages/claxedo-local-server/src/opencode/**` contains another event reader,
  raw proxy routes, provider/config projections, and MCP sync.
- `packages/claxedo-server-core/src/opencode/engine-auth-bridge.ts` reconciles
  Claxedo credentials through raw `/auth` and `/global/dispose` calls.
- `packages/claxedo-server/src/hosts/workgraph/**` contains direct raw Session
  V2, catalog, session-intake, context, and application-tool consumers.
- `packages/claxedo-desktop/**` builds, ships, locates, compile-caches, and
  supervises the node-embed artifact and its worker.
- `packages/claxedo-server/scripts/sandbox/**` installs the OpenCode binary.
  Image-build smoke explicitly launches `opencode serve` and injects
  `OPENCODE_URL`; the deployed command omits that URL, so the current harness
  adapter spawns the installed server on first OpenCode use. Both process paths
  and the binary installation must disappear at cutover.
- `packages/sdk/js` currently owns the public package name
  `@opencode-ai/sdk`; `packages/core`, `server`, `plugin`, and `schema` also
  occupy package names used by the new public SDK's exact dependency family.

The pattern to preserve is the repository's existing host/kit split:
`WorkspaceRuntime` owns local execution, composition roots supply product
policy and plugins, and `AgentHarnessAdapter` projects a harness into canonical
Claxedo session/events contracts.

### Institutional learnings

`docs/solutions/` and `critical-patterns.md` do not exist in this repository,
so there is no captured migration precedent to inherit. The implementation
should add a durable post-migration solution note describing the package-name,
event-authority, and SQLite lessons once the cutover is proven.

### External references

- The public SDK exposes an explicitly owned host from `OpenCode.create()` and
  `close()`, a generated typed client, session/event aliases, and plugin
  registration. It intentionally omits raw `fetch` and private router access.
- The embedded SDK defaults its database to `:memory:` unless an explicit path
  is passed. In beta-18314, the V1 migration import resolves to a real migrator
  only under Bun; the Node and Workerd conditions resolve to a no-op whose
  status immediately says `completed`. Every shipped Claxedo deployment is
  Node-based, so that status is not evidence that any V1 data moved. Suspended
  V2 session recovery may still continue in a background fiber.
- The event stream is volatile even when event persistence is enabled; recovery
  must reread canonical typed snapshots rather than assuming SSE replay. Every
  event has an ID, but only some event types carry durable aggregate sequence
  metadata; usage and text delta events do not.
- V2 is beta and intentionally breaks V1 client/server and plugin contracts.
  As observed on 2026-08-27, the stable npm `latest` remains the legacy SDK;
  the selected embedded release must therefore be an exact prerelease.
- SQLite requires a consistent backup API or `VACUUM INTO`-equivalent snapshot;
  copying a live main file without its WAL/journal is unsafe.
- Release rollback should restore an immutable application artifact and its
  matching pre-migration data snapshot, never keep a live dual runtime.

## Key Technical Decisions

1. **Pin `@opencode-ai/sdk@0.0.0-beta-18314` as the initial cutover
   baseline, with the matching exact public client/plugin family.** This is the
   published beta inspected during planning. If it fails a required contract
   gate, stop and re-plan against a later exact beta; do not silently move to
   `@dev` or retain the old runtime.
2. **Create `@claxedo/opencode-runtime` as the sole SDK owner.** It names one
   real responsibility: construct, configure, observe, and close the embedded
   OpenCode host. Generic runtime and UI packages consume Claxedo ports/DTOs,
   not SDK internals.
3. **Use one lazy SDK host per OS process.** Local desktop/self-hosted processes
   share one host and database across workspace-runtime instances; each hosted
   sandbox process owns one host. Every operation carries the authoritative
   workspace location to preserve isolation. Multiple hosts never share one
   SQLite file. Unit 1 must falsify this choice before namespace cutover by
   testing cross-location config/cache/event isolation and concurrent turns. If
   the SDK exposes host-global state or serializes work beyond the recorded
   budget, stop and re-plan host cardinality rather than compensating with
   filters.
4. **Replace `OpenCodeRequestFn` with a domain port.** The port covers the
   operations Claxedo actually uses and preserves typed errors, cancellation,
   cursors, and stream semantics. It has one production implementation: the
   public SDK.
5. **Make one retained event pump authoritative.** It starts before the first
   OpenCode mutation, survives individual browser stream disconnects, filters
   by an authorized workspace scope, and publishes at-least-once. Stable SDK
   event IDs, deterministic reconciliation keys, and idempotent consumers make
   metadata, usage, and intake effects exactly once. Unit 1 must first prove
   which events carry durable aggregate ordering and which canonical snapshots
   can yield deterministic domain keys. Usage accounting is snapshot-derived:
   assistant-message token snapshots from paged `message.list` are the per-turn
   authority; `session.get` totals detect/reconcile session-level divergence;
   and `session.stats` is coarse aggregate audit only. Usage events only trigger
   reconciliation. Unsupported exactly-once effects are a release
   blocker, not an invitation to hash volatile deltas. On stream loss it
   reconnects and reconciles from typed session/message/permission/form
   snapshots; it never synthesizes a successful terminal event.
6. **Keep Claxedo outer APIs only as named translations.** The browser and
   WorkGraph need not import the SDK. Each retained path has an explicit owner,
   typed SDK operation, authorization rule, error mapping, and contract test.
   The generic arbitrary proxy and the `http-proxy` adapter capability are
   deleted.
7. **Keep Claxedo stores authoritative where the SDK has no public domain
   operation.** Todos are written by a registered Claxedo SDK tool into the
   existing runtime store and emitted from that same producer. Claxedo's PTY
   routes remain the terminal authority; duplicative OpenCode PTY passthrough
   is retired even though V2 exposes typed PTY metadata and connection tokens.
   The registered tool manifest, not private router inspection,
   backs any retained tool catalog.
8. **Use a V2 plugin for product integrations.** Static config enters through
   explicit SDK config content. MCP and credentials reconcile through public
   typed APIs. WorkGraph and connection tools register through one plugin whose
   session/location registry resolves current bindings at execution time.
   Use the Effect plugin entrypoint, or another demonstrably cancellable owned
   mechanism, for tools that must stop with session interruption; a
   non-cancellable Promise tool is not acceptable.
9. **Preserve authority and deletion semantics.** Claxedo's credential registry
   remains authoritative for its allowlisted providers and its ownership
   ledger prevents deletion of unmanaged SDK credentials. Agent Config remains
   authoritative for Claxedo-owned MCP servers, including removal of stale
   owned entries. Secrets may cross only the typed SDK credential boundary,
   may not enter config/plugin snapshots, events, logs, errors, or diagnostics,
   and must be discarded from transient references after reconciliation.
   Rotation/revocation invalidates provider/session caches through supported
   public operations before the next eligible turn. V2 has no
   `credential.list`; Unit 1 must prove `integration.list/get` exposes enough
   connection identity for the ownership ledger. If not, Claxedo may remove
   only credential IDs it recorded when connecting, never enumerate-and-sweep.
10. **Use offline export/import as the primary Node migration.** The legacy
    tree has no existing bulk transfer surface: its only exporter is a
    single-session CLI command. A preparatory legacy release therefore adds a
    non-interactive, app-owned bulk exporter over the existing
    `Session.Service.list/get/messages` primitives, quiesces the old writer,
    writes versioned per-session envelopes plus a checksummed manifest, and
    creates a consistent database backup. The embedded-only release creates a
    fresh V2 database, transforms those envelopes, imports through public
    `session.import`, performs semantic validation, and atomically promotes
    that database before admitting traffic. It removes `time.archived` from
    the SDK import payload and restores archive state from a separate canonical
    Claxedo projection ledger, so the imported SDK copy cannot become a second
    archive authority. `migration.v1.status` is never a readiness gate on Node.
    There is no downgrade path and no old runtime may open the promoted V2
    database.
11. **Rollback is operational, not a code path, and has zero accepted session
    loss.** Before the first V2 write, rollback restores the matching
    pre-migration snapshot and exact previous release. After V2 writes, never
    blindly restore that snapshot: stop ingress, snapshot/export the new state,
    and replay the post-cutover delta into the previous release only if a
    cross-version import was proven. Otherwise remain in maintenance and
    fix-forward. Production cohorts may admit writes only after this recovery
    point is explicit; each running artifact still contains exactly one runtime.
12. **Delete the vendored runtime, not just its call sites.** Shared UI source
    can remain only after its imports are detached. Production dependency and
    artifact inspection must prove no local OpenCode engine/server package is
    reachable.
13. **Authorize shared-host access with an opaque workspace scope.** Outer
    route authorization mints a scope from canonical workspace ID and realpath.
    Runtime-port calls do not accept caller-selected directories. Session and
    location pairs, event delivery, config, todos, and tool bindings are
    revalidated against that scope on every operation, including after a
    symlink or workspace move.
14. **Authorize model-invoked tools at execution time.** Visibility is not
    authority. Each WorkGraph/connection invocation resolves an unexpired
    capability binding actor, workspace, session, allowed action, and resource;
    validates inputs; fails closed after revoke/cancel/release; preserves
    existing confirmation policy for high-impact actions; and emits a redacted
    audit record.
15. **Forbid the unsupported internal host explicitly.** Source and artifact
    gates reject `dist/internal`, `/internal/host`, `EmbeddedHost`, and deep
    imports of the SDK package even though an exports-disrespecting bundler can
    physically reach the published raw-fetch implementation.
16. **Model typed API composites honestly.** MCP update is serialized
    `remove -> add` with compensation, and restart is
    `disconnect -> connect`; neither is an atomic public method. Archive is a
    Claxedo projection mutation, not an SDK session operation.

## Open Questions

### Resolved during planning

- **Install directly or keep a fork beside it?** Install the public SDK
  directly. Keeping the fork beside it would preserve the ambiguity this work
  exists to remove and would leave two exact but incompatible package graphs.
- **Should external URL mode remain for tests or operators?** No. Tests inject
  a fake typed port; operators run the embedded SDK. Removed environment
  variables fail startup with a clear migration diagnostic instead of being
  ignored.
- **Where should the host live?** In a single Claxedo runtime package owned by
  each execution process, not inside adapters, control-plane routes, or a
  desktop worker.
- **Should compatibility URLs be deleted wholesale?** No. Preserve routes with
  live Claxedo consumers, but rewrite them as typed translations. Delete
  unconsumed and arbitrary passthrough behavior.
- **How are questions represented in V2?** Use typed forms and extend the
  harness-neutral question contract to retain field keys, multiple values,
  and cancellation. A one-string compatibility view is allowed only for a
  proven single-field route.
- **What replaces missing public todo and dynamic-tool APIs?** Claxedo-owned
  authoritative todo state and a startup-registered plugin with a
  session/location binding registry. Do not derive or inject substitutes from
  prompt text.
- **How does rollback work without a fallback?** Immutable release rollback
  plus restoration of the matching pre-migration database snapshot before any
  V2 writes. After writes, preserve a zero-loss V2 delta and either replay it
  through a proven previous-release import or fix-forward under maintenance.
- **Does beta-18314 migrate V1 data in production Node deployments?** No. Its
  Node condition is a no-op that reports `completed`. Offline export/import is
  therefore the primary migration, and semantic validation is the readiness
  authority.
- **Does V2 support PTY?** Yes: typed PTY and persistent-PTY metadata plus
  connection-token APIs exist. They are not used because Claxedo already owns
  the product terminal path, not because V2 lacks support.
- **How are archive, MCP update, and MCP restart represented?** Archive remains
  in Claxedo's session projection. MCP update is remove/add with compensation;
  restart is disconnect/connect. These composites are drained and serialized.

### Deferred to implementation gates

- **Are V1 export data and V2 `SessionTransferData` directly compatible?** Unit
  1 must prove this across the migration corpus. If not, define a versioned,
  pure transfer-schema transformer; do not read private database tables. Any
  state that cannot be represented remains a release blocker.
- **Can credential ownership be reconstructed through `integration.list/get`?**
  Prove that connection IDs can be matched to the Claxedo ownership ledger. If
  not, record IDs at connect time and limit deletion to those known IDs.
- **Does initial plugin setup failure release all SDK resources?** Add an
  open-handle and database-lock test. If the beta leaks, report upstream and
  contain it within the sole runtime owner before cutover.
- **Which native modules and export conditions are required on each desktop
  target?** Resolve from packaged macOS, Windows, and Linux artifacts, not from
  monorepo development resolution.
- **What idle RSS/startup regression is acceptable after removing the desktop
  worker?** Record the current packaged baseline and set the release threshold
  with the existing performance harness before enabling rollout.

## High-Level Technical Design

> This diagram is directional guidance for ownership and flow. It is not an
> implementation specification.

```mermaid
flowchart LR
  UI[Claxedo UI / WorkGraph / relay] --> WR[WorkspaceRuntime routes]
  WR --> AD[OpenCodeHarnessAdapter]
  AD --> PORT[Claxedo OpenCode runtime port]
  PORT --> HOST[@claxedo/opencode-runtime]
  HOST --> SDK[Public OpenCode embedded SDK host]
  HOST --> PLUGIN[Claxedo SDK plugin]
  PLUGIN --> CREDS[Credential registry]
  PLUGIN --> MCP[Agent Config / MCP]
  PLUGIN --> WG[WorkGraph + connection registries]
  SDK --> PUMP[Single SDK event pump]
  PUMP --> HUB[Canonical RuntimeEventHub]
  HUB --> UI
  HUB --> META[Session projection]
  HUB --> USAGE[Usage meter]
  HUB --> INTAKE[WorkGraph intake]
  HOST --> DB[(Explicit process-owned SQLite)]
```

Lifecycle states are `cold -> migrating -> ready -> draining -> closed`, with
`unavailable` as an observable failure state. Event health is an orthogonal
`healthy | degraded` dimension and can coexist with `ready` or `draining`.
Concurrent cold requests share one creation promise. `unavailable` may retry
the same SDK path under bounded backoff after the cause is corrected, but it
can never select another transport. A closed owner cannot reopen; restart
constructs a fresh owner. Other harnesses do not depend on this state machine.

## Implementation Units

- [ ] **Unit 1: Freeze the public contract and characterize every current flow**

**Goal:** Establish a reviewable parity and deletion contract before changing
the runtime, using the exact selected beta and real current entrypoints.

**Requirements:** R1, R5, R7, R8, R9, R12

**Dependencies:** None

**Files:**

- Create: `docs/architecture/opencode-embedded-sdk-contract.md`
- Create: public-SDK contract fixtures/tests beside the future
  `packages/opencode-runtime`
- Modify: existing OpenCode adapter, workspace-runtime, WorkGraph, desktop, and
  sandbox contract test manifests only as needed to record expected behavior

**Approach:**

- Record every current OpenCode operation and its public V2 typed replacement,
  including semantic differences for asynchronous prompt admission, forms,
  event volatility/durability, todo ownership, dynamic tools, PTY,
  Claxedo-owned archive state, credential enumeration, and non-atomic MCP
  composites.
- Inventory every outer route and name its internal consumer or external
  contract evidence. Check public docs, exported workspace-runtime APIs,
  operator/extension integrations, and the supported older-client window;
  absence of an in-repo consumer alone is not deletion evidence.
- Build a migration corpus rather than one fixture: supported V1 schema
  generations, desktop/self-hosted/hosted layouts, clean and WAL-active
  snapshots, partial-upgrade markers, large histories, and unusual parent/tool
  graphs. Credentials and MCP are not migrated from engine storage; Unit 5
  reconstructs them from Claxedo's authoritative registry and Agent Config
  snapshot.
- Characterize the current single-session CLI exporter, then specify and prove
  a new non-interactive legacy bulk serializer over
  `Session.Service.list/get/messages` against V2 `SessionTransferData` and
  public `session.import`. Version and test the transfer envelope and any V1 to
  V2 transformer without importing private database code. Prove preservation
  of IDs, `parentID`, fork boundary, project, agent, and model fields. Confirm
  that a preparatory legacy release can create the complete transfer bundle
  before the embedded-only update; skipping that prerequisite release must
  block safely with an upgrade diagnostic rather than open the V1 database.
- Run an isolated dependency-resolution experiment for the exact SDK family
  before deciding which local package identities must move. Inspect the frozen
  install and production bundle closure; vacate proven collisions and runtime
  edges, not unrelated UI package names.
- Falsify the shared-host decision with concurrent multi-location turns,
  configuration/provider cache changes, event delivery, permissions, MCP, and
  tool visibility. Record measurable isolation and serialization thresholds.
- Record stable SDK event identity/order coverage and the authoritative
  snapshot/deterministic key for each metadata, usage, and intake effect. A
  consumer without a reliable idempotency source blocks the cutover.
- Record assistant-message token snapshots from paged `message.list` as the
  authoritative per-turn usage source, `session.get` token/cost totals as the
  session-level reconciliation check, and `session.stats` as aggregate audit
  only. Prove that usage events can be lost or repeated without changing final
  metered facts.
- Define the archive cutover contract: checkpoint 6a captures archive timestamps
  in a Claxedo-owned projection ledger; the transfer transformer clears
  `info.time.archived` before SDK import; and Claxedo's ledger wins on every
  read, filter, and conflict after cutover.
- Verify `integration.list/get` exposes enough credential connection identity
  to protect unmanaged entries, and characterize remove/add MCP compensation.
- Measure the current packaged cold start, first OpenCode use, idle RSS, active
  turn RSS, shutdown time, and process tree.
- Treat missing cancellation, persistence, migration, or packaged-native
  capability as a stop condition for release, not a reason to retain the fork.

**Execution note:** Characterization-first. This unit must not introduce a
second production runtime or a feature flag.

**Test scenarios:**

- **Happy path:** each existing user-visible operation maps to one named public
  client or Claxedo-owned authoritative operation.
- **Edge case:** structured/multi-field questions and paged history retain all
  information across the proposed domain port.
- **Isolation edge:** concurrent workspaces cannot observe each other's config,
  caches, events, permissions, MCP, tools, sessions, or throughput state through
  the shared host.
- **Migration edge:** every supported schema/layout/WAL/size entry in the corpus
  migrates or exports/imports with the same semantic assertions.
- **Error path:** an operation with no supported typed/public implementation is
  reported as a blocking contract gap, not assigned to raw fetch.
- **Migration error:** the embedded-only release sees a legacy database but no
  validated transfer bundle, so it fails readiness even though the SDK's Node
  migration status says `completed`.
- **Integration:** the baseline process inventory distinguishes the desktop
  server child from the additional OpenCode worker/server processes that must
  disappear.

**Verification:** A signed-off parity matrix covers all R5/R7 flows; every
retained compatibility path has an owner or external contract; the migration
corpus, shared-host falsification, and event-identity gates pass; and the exact
beta is reproducible from the lockfile.

- [ ] **Unit 2: Stage the public runtime, migrate DTO consumers, and vacate collisions**

**Goal:** In reviewable green checkpoints, create the direct public SDK runtime,
migrate consumers, then vacate the local package identities or runtime edges
that Unit 1 proved collide with the selected public dependency closure.

**Requirements:** R1, R4, R11, R12

**Dependencies:** Unit 1

**Files:**

- Modify: root `package.json`, `bun.lock`, and workspace package manifests
- Create: `packages/opencode-runtime/package.json` and the minimal owned host
  needed to contract-test the exact public SDK
- Modify: `packages/claxedo-app/src/**`, `packages/session-ui/**`,
  `packages/agent-event-runtime/**`, `packages/agent-sdk-runtime/**`, and
  `packages/workspace-runtime/**` consumers of legacy `@opencode-ai/sdk`
- Remove: `packages/sdk/js/**` after its last consumer moves
- Remove or move: local package manifests that collide with the selected
  SDK's exact dependency family (`sdk`, `core`, `server`, `plugin`, `schema`,
  and any newly observed collision). Non-colliding UI-only packages may keep
  their names only after they have no vendored runtime edge and are absent from
  the production OpenCode closure.

**Approach:**

- Replace legacy SDK imports with existing Claxedo session/event/route DTOs.
  Use the exact public `@opencode-ai/client` only inside the OpenCode runtime
  boundary or where an upstream type is truly the external contract.
- Move small UI-only helpers out of runtime-capable fork packages into their
  owning UI/Claxedo package instead of keeping a server package for one helper.
- Remove the legacy generated server-process helpers; do not rename them into
  a permanent compatibility package.
- Create the minimal lifecycle owner against the exact public SDK before
  removing the old namespace.
- Add a dependency rule that reserved `@opencode-ai/*` runtime imports are
  allowed only in `@claxedo/opencode-runtime` and explicit upstream type
  boundary files.

**Execution note:** Use three green checkpoints: (2a) add and contract-test the
exact beta in the isolated runtime package while pre-existing legacy families
remain; (2b) migrate app/generic DTO consumers package by package; (2c) vacate
colliding names and enforce the final one-family closure. Intermediate
checkpoints are development-only and must not be released or packaged as the
cutover artifact.

**Test scenarios:**

- **Happy path:** UI and generic runtime packages typecheck and render against
  Claxedo-owned DTOs with no local legacy SDK package.
- **Edge case:** generated public V2 types that differ from V1 are projected at
  the runtime boundary rather than leaked through the app.
- **Error path:** dependency analysis fails if a workspace package shadows the
  selected public SDK/client/plugin release.
- **Integration:** a clean frozen install resolves exactly one selected public
  SDK family.

**Verification:** `packages/sdk/js` and every proven colliding/runtime-capable
package identity are gone or moved, no production consumer imports their legacy
paths, the minimal new host passes its public contract test, and production
package inspection has one public SDK family.

- [ ] **Unit 3: Build the sole process-owned SDK runtime and event authority**

**Goal:** Introduce the only production owner of `OpenCode.create()`, explicit
persistence, plugins, readiness, events, and `close()`.

**Requirements:** R2, R3, R4, R6, R9, R10

**Dependencies:** Units 1-2; extend the minimal host created in Unit 2

**Files:**

- Modify: `packages/opencode-runtime/src/**` for complete host lifecycle, typed port
  implementation, location validation, event pump/projector, plugin
  composition, health, and tests
- Modify: `packages/agent-sdk-runtime/src/harnesses/opencode/**` to define the
  upstream-independent domain port and projections
- Modify: root workspace/build configuration

**Approach:**

- Construct a lazy single-flight host with an explicit absolute database path,
  config content, event persistence policy, logger, and initial plugins.
- Enforce one host per process and one database writer. Outer authorization
  mints an opaque workspace scope from canonical ID + realpath; runtime methods
  never accept an arbitrary directory. Revalidate scope, session/location
  pairing, symlink target, event visibility, and tool/todo/config ownership on
  every operation.
- Start the retained event pump before the first mutation. Project typed SDK
  events at least once into canonical Claxedo events, apply the Unit 1-proven
  domain idempotency keys to durable consumers, and keep browser subscribers
  downstream of the Claxedo hub.
- On stream loss, mark OpenCode event health degraded, reconnect the same SDK
  stream, and reconcile typed canonical snapshots. Reuse existing RuntimeStore
  journals, projection idempotency, usage fact keys/outboxes, and WorkGraph
  intake keys first. Add only the smallest missing per-location checkpoint or
  deterministic snapshot key proven necessary by Unit 1. Consumers commit
  effects and keys transactionally where existing stores support it; otherwise
  reuse deterministic domain/outbox keys rather than create a new generic
  cross-store event framework. Preserve the distinction
  between client request cancellation, session interruption, unexpected stream
  loss, and host shutdown.
- Treat usage events as invalidation hints only. After reconnect or restart,
  page `message.list` and reconcile each completed assistant message's
  persisted token snapshot into the existing deterministic usage fact/outbox
  key. Compare `session.get` token/cost totals to detect incomplete
  reconciliation, and reserve `session.stats` for coarse aggregate audit; it
  cannot repair a specific missing message fact. Rehydrate missed text from
  persisted message pages; never attempt to replay or deduplicate volatile text
  deltas as durable history.
- Close ingress, active iterators/fibers, plugin scopes, and the SDK host in a
  deterministic order. Make repeated shutdown safe.

**Test scenarios:**

- **Happy path:** create a persistent session, close the first runtime owner,
  construct a fresh owner representing process restart on the same database,
  and read the same session/messages. A closed owner cannot reopen.
- **Edge case:** two concurrent first-use requests share one host creation and
  one database opener; two workspaces with duplicate-looking session inputs
  remain location-isolated.
- **Security edge:** traversal, symlink retargeting, mismatched session/location
  pairs, stale registrations, and cross-workspace event/tool access all fail
  closed against the opaque workspace scope.
- **Error path:** boot, plugin setup, database migration, event stream, and
  close failures produce explicit health/errors and leak no handles or locks.
- **Integration:** at-least-once SDK delivery yields one metadata, usage, and
  intake effect through the existing domain idempotency mechanisms even after
  reconnect/reconciliation.
- **Usage recovery:** dropping, duplicating, and reordering
  `session.usage.updated` events produces the same final per-message usage facts
  after paged message reconciliation, while `session.get` totals match and
  `session.stats` remains audit-only.

**Verification:** The new runtime passes lifecycle, persistence, isolation,
event ordering, recovery, and open-handle tests without importing a private SDK
module or starting a listener/child process.

- [ ] **Unit 4: Rewrite the OpenCode adapter and compatibility surface over the typed port**

**Goal:** Remove raw HTTP as the adapter mechanism while preserving required
session and UI behavior through explicit projections.

**Requirements:** R4, R5, R6, R8, R10

**Dependencies:** Unit 3

**Files:**

- Modify: `packages/agent-sdk-runtime/src/harnesses/opencode/index.ts` and its
  session, message, status, subagent, permission, form, and todo tests
- Remove: `packages/agent-sdk-runtime/src/harnesses/opencode/process.ts`
- Remove/replace: `packages/agent-sdk-runtime/src/harnesses/opencode/events.ts`
- Modify: `packages/workspace-runtime/src/workspace/runtime.ts`, `server.ts`,
  `cli.ts`, route tests, and README/docs
- Modify/remove: `packages/claxedo-local-server/src/opencode/compat-routes/**`
  and `packages/claxedo-local-server/src/opencode/events.ts`

**Approach:**

- Make `OpenCodeHarnessAdapter` a pure projector over the typed port. Delete
  URL/request/spawn ownership, leases, `http-proxy`, raw endpoint construction,
  and non-2xx-to-empty behavior.
- Map session CRUD, prompt admission/completion, paging, interrupt, fork,
  revert, commands, permissions, forms, subagents, status, and model identity
  with explicit lossless projectors.
- Map archive/unarchive to Claxedo's authoritative session projection and keep
  SDK `session.remove` exclusively for permanent deletion; do not invent an SDK
  archive call from the read-only `time.archived` field.
- Extend harness-neutral question replies to carry structured form values.
  Back todos with the existing runtime store plus the registered Claxedo tool
  so one producer owns writes, reads, and events.
- Replace retained `/provider`, `/mcp`, `/vcs`, `/session/status`, event, and
  Session V2 paths with named typed handlers. Delete passthrough routes and
  OpenCode-specific PTY routes that duplicate Claxedo's terminal service, while
  documenting that typed V2 PTY/token APIs exist and are intentionally unused.
- Remove `opencodeCompat` three-state behavior. Non-OpenCode harness routes
  retain their existing harness-neutral behavior; selected OpenCode failures
  return typed unavailable/failure responses rather than fabricated success.

**Test scenarios:**

- **Happy path:** the full R5 session matrix works through real
  workspace-runtime routes backed by the SDK port.
- **Edge case:** disconnecting one UI event stream does not stop the retained
  host pump or another active turn; long IDs and paged history remain intact.
- **Error path:** a prompt admitted before its HTTP response is never retried;
  stream loss never becomes a synthetic success; SDK unavailable never returns
  an empty catalog/status.
- **Integration:** permission response, structured form response, todo update,
  subagent event, and terminal outcome reach the UI once and persist across
  restart.

**Verification:** Every retained route has a named typed implementation and
contract test; raw request/proxy/spawn classes and fallback responses are gone.

- [ ] **Unit 5: Move credentials, MCP, WorkGraph, and connection tools onto SDK APIs/plugins**

**Goal:** Eliminate the remaining direct engine consumers while preserving
Claxedo's configuration and WorkGraph authorities.

**Requirements:** R5, R7, R8, R10

**Dependencies:** Units 3-4

**Files:**

- Replace/remove: `packages/claxedo-server-core/src/opencode/engine-auth-bridge.ts`
- Replace/remove: `packages/claxedo-local-server/src/opencode/mcp-sync.ts` and
  provider/config raw consumers
- Modify: `packages/claxedo-server/src/hosts/workgraph/composition/session-gateway.ts`
- Modify: `packages/claxedo-server/src/hosts/workgraph/composition/agent-tools.ts`
- Modify: `packages/claxedo-server/src/hosts/workgraph/local/execution-capabilities.ts`
- Modify: `packages/claxedo-server/src/hosts/workgraph/session-intake.ts` and
  corresponding local/hosted tests
- Modify: composition roots that build the SDK plugin/config snapshot

**Approach:**

- Reconcile Claxedo-owned credentials through typed integration/credential
  operations while preserving the existing provider allowlist, canonical-row
  precedence, ownership ledger, deletion/revocation, and unmanaged-credential
  protection. Because there is no `credential.list`, identify connections
  through the Unit 1-verified `integration.list/get` projection or delete only
  ledger-recorded credential IDs; never perform an SDK-side sweep.
- Enumerate and minimize every plaintext credential boundary. Prohibit secrets
  in SDK config/plugin snapshots, persisted events, logs, errors, diagnostics,
  and migration artifacts; use the platform secret backend or equally
  protected storage for any necessary durable SDK copy. Prove rotation,
  revocation, supported cache invalidation, redaction, and transient-reference
  cleanup across failure and shutdown.
- Reconcile the complete Agent Config MCP snapshot through typed MCP operations,
  including add, remove, connect, disconnect, and stale-owned entry cleanup.
  Implement update as drained `remove -> add` with restoration of the previous
  config if add fails; implement restart as `disconnect -> connect`. Serialize
  these non-atomic composites around active turns.
- Register stable WorkGraph/connection dispatcher tools at host startup. Resolve
  session-bound visibility and callbacks through the existing registries; clean
  bindings on cancel, delete, release, and shutdown.
- At invocation, re-resolve an authenticated, unexpired capability for actor,
  workspace, session, action, and resource. Validate tool inputs, preserve
  existing confirmation policy for high-impact effects, fail closed on stale or
  revoked bindings, and emit redacted audit records.
- Route both local and hosted WorkGraph Session V2 through workspace-runtime's
  typed OpenCode path. Delete the separate raw gateway, dynamic callback route,
  engine intake reader, and direct catalog calls.
- Derive tool and provider/model catalogs from public typed APIs plus the
  Claxedo-owned plugin manifest; never inspect internal router state.

**Test scenarios:**

- **Happy path:** a stored credential and MCP snapshot power the first OpenCode
  turn; WorkGraph local and hosted sessions execute registered tools and expose
  paged history.
- **Edge case:** canonical credential aliases preserve precedence, unmanaged
  SDK credentials survive reconciliation, and removed Claxedo-owned MCP entries
  disappear.
- **Error path:** plugin/tool registration failure compensates a newly admitted
  WorkGraph session; an interrupted turn cancels its tool execution and does
  not leave a binding.
- **Security error:** prompt-injected calls, cross-session IDs, stale/revoked
  bindings, cancellation races, and unauthorized connection resources fail
  before side effects.
- **Integration:** credential update/delete, MCP add/update/remove, WorkGraph
  active polling, explicit completion retry, cancellation, crash recovery, and
  intake all operate through the same workspace runtime.
- **Composite failure:** MCP remove/add failure restores the previous owned
  configuration and reports degraded state; disconnect/connect failure remains
  visible and never reports a successful restart.

**Verification:** No credential, MCP, provider, WorkGraph, or composition module
imports/calls the old raw transport, and integration tests prove authority and
cleanup semantics.

- [ ] **Unit 6: Implement and gate the one-writer data migration and recovery lifecycle**

**Goal:** Move existing durable OpenCode state safely to the pinned SDK and make
readiness/recovery observable without a compatibility runtime.

**Requirements:** R3, R9, R10

**Dependencies:** Unit 1 for checkpoint 6a; Units 3-5 for checkpoint 6b

**Files:**

- Create for checkpoint 6a:
  `packages/opencode/src/session/bulk-export.ts` and focused tests. This is the
  legacy-side serializer over
  `Session.Service.list/get/messages`; it writes versioned per-session files
  and manifest inputs without stdout scraping.
- Modify for checkpoint 6a: `packages/opencode/src/cli/cmd/export.ts` to reuse
  the shared single-session serializer instead of owning a second envelope and
  add one non-interactive `--all --output-dir` release command.
- Create for checkpoint 6a:
  `packages/claxedo-server-core/src/opencode/legacy-transfer-checkpoint.ts` and
  deployment composition/tests that stop ingress, force a final full metadata
  sync into `SessionProjectionStore`, close the legacy writer, invoke that bulk
  command once against the explicit legacy database path, write a complete
  Claxedo-owned archive ledger from the projection, and publish the completed
  manifest atomically.
- Create: migration/backup/readiness code and tests under
  `packages/opencode-runtime/src/**`
- Modify: local/self-hosted health and startup sequencing
- Modify: desktop data diagnostics and token-history database discovery where
  paths or schema ownership change
- Add: a sanitized V1 migration corpus and semantic assertions across supported
  schema generations, deployment layouts, journal states, and history sizes

**Approach:**

- Deliver migration in two release checkpoints without a dual runtime inside
  either release. Checkpoint 6a is the last legacy release: stop new OpenCode
  ingress, drain active work, force one final full session-metadata sync into
  Claxedo's projection, quiesce/close the legacy writer, create and verify a
  consistent database backup, and run the newly added non-interactive bulk
  exporter over the legacy session service. The coordinator persists the
  versioned session envelopes, a complete archive ledger read from the Claxedo
  projection, and a checksummed manifest in the app-owned migration directory.
  It invokes one bulk command only after the old process has released the
  database, and waits for that command to close it again. Do not shell-loop the
  existing interactive single-session exporter or parse its stdout.
  Checkpoint 6b is the embedded-only release: never open the V1 database with
  the Node SDK, create a fresh staging V2 database, transform the versioned
  transfer schema, clear `info.time.archived`, import through public
  `session.import`, validate semantics, restore the Claxedo archive projection
  from its ledger, and atomically promote the V2 database to the canonical
  path.
- Use this deployment storage contract, completed with provider-specific
  mounted paths during Unit 1:

  | Deployment | Source/target owner | Backup and marker owner |
  |---|---|---|
  | Desktop/local | Legacy source is `dataDir()/opencode-engine/opencode.db`; import into a fresh sibling V2 staging database, then promote it to the canonical path | Adjacent app-controlled migration directory under `dataDir()`, never the app bundle or workspace checkout |
  | Self-hosted | Legacy source is the server data root's `opencode-engine/opencode.db`; import into a fresh sibling V2 staging database | Same durable data root, protected and retained by the self-host operator |
  | Hosted sandbox | Checkpoint 6a exports the old on-demand server's sessions into workspace-runtime `storeRoot`; checkpoint 6b creates a fresh V2 database on the provider's durable mounted volume | Same host/provider volume and lifecycle owner; if the current runtime has no durable sessions, record that fact rather than claim migration |
  | Cloudflare sandbox variant | Its configured durable workspace-runtime store, not the Workerd profile with local execution disabled | Provider snapshot/restore facility plus the same migration marker contract |

- Protect backups as sensitive user data: least-privilege ownership/mode,
  application-controlled location, platform encryption where available,
  authenticated restore, redacted diagnostics, exclusion from packaged
  artifacts/uploads, and deletion after the documented rollback window.
- Keep OpenCode readiness in `migrating` until transfer-manifest verification,
  typed import, semantic validation, and V2 suspended-session recovery complete.
  `migration.v1.status` is diagnostic only on Node and cannot advance readiness.
  Other harnesses may remain ready.
- Validate session/message counts and identities, locations, titles, models,
  agents, tool results, token usage, fork boundaries, and parent/child links.
  Validate archive state against the Claxedo ledger and assert that imported SDK
  session records contain no authoritative `time.archived` value. Claxedo wins
  if legacy transfer metadata and the projection ledger disagree.
- Make the migration marker and retry behavior idempotent across process crash.
  A failure preserves source and backup and exposes `unavailable`; it never
  launches the old engine.
- If an existing V1 database is present without a validated checkpoint-6a
  transfer bundle, fail readiness with an explicit prerequisite-upgrade
  diagnostic. Fresh installs create V2 storage directly. Reconcile credentials
  and MCP from Claxedo authorities after session import; do not migrate duplicate
  engine copies.
- On restart, allow suspended-session recovery, reconcile Claxedo's durable
  projection/event store from typed snapshots, then mark OpenCode ready.

**Test scenarios:**

- **Happy path:** checkpoint 6a exports every supported corpus entry;
  checkpoint 6b imports it into a fresh V2 database and resumes the same
  sessions after another restart, preserving IDs, parents, fork boundaries,
  project, agent, and model while archive filtering comes only from Claxedo's
  restored projection.
- **Authority edge:** a transfer envelope and Claxedo archive ledger contain
  conflicting archive timestamps; the transformer strips the envelope value
  and every post-cutover list/read returns the ledger value.
- **Manifest edge:** the archive ledger is missing or duplicates an exported
  session ID; checkpoint 6a refuses to seal its manifest rather than infer an
  active archive state.
- **Edge case:** crash before legacy export completion, during typed import, and
  after validation-before-promotion produces one safe, restartable outcome each.
- **Error path:** corrupt/incompatible data keeps the source and backup intact,
  reports the failed phase, and starts no legacy process.
- **Integration:** before V2 writes, restore the backup with the previous
  immutable artifact. After V2 writes, preserve/export the delta and prove its
  replay into the previous release before allowing rollback; otherwise prove
  the maintenance-mode fix-forward path with zero accepted session loss.
- **Security:** unauthorized local users and packaged-artifact collectors cannot
  read or include migration snapshots; retention cleanup removes expired
  backups without touching the active database.

**Verification:** Migration is one-writer and export/import-first, backups and
manifests are verified, semantic readiness—not Node's no-op status—is
authoritative, restart is safe, and old code never opens promoted V2 storage.

- [ ] **Unit 7: Cut over every deployment and packaged artifact**

**Goal:** Run the same embedded SDK ownership model in desktop, self-hosted, and
hosted/sandbox products and remove all separate engine processes/artifacts.

**Requirements:** R2, R3, R10, R11, R12

**Dependencies:** Units 3-6

**Files:**

- Modify: `packages/claxedo-local-server/src/app/start-local-server.ts` and
  embedded workspace-runtime composition
- Modify: `packages/claxedo-server/src/deployments/self-hosted-node/{app,index}.ts`
  and workspace-runtime boot/startup
- Modify: `packages/claxedo-server/scripts/sandbox/**` Dockerfiles, image build,
  dependency collection, and smoke tests
- Modify: `packages/claxedo-desktop/scripts/{bundle-claxedo-server,prebuild,predev,contract,claxedo-server-startup}.ts`
- Modify: `packages/claxedo-desktop/electron-builder.config.ts` and
  `packages/claxedo-desktop/src/main/index.ts`
- Remove: desktop engine worker/policy sources and engine-specific compile-cache
  assets/tests
- Modify: self-hosted boundary builds, container build, CI, and release checks

**Approach:**

- Compose the sole host directly in local/self-hosted processes and inside the
  hosted workspace-runtime process. Remove URL/embed/worker options from public
  boot contracts and reject retired environment variables with an actionable
  diagnostic.
- Bundle/install the exact public SDK closure and required native modules for
  each platform. Remove the OpenCode binary, engine artifact, worker,
  capability token, listener port, and engine compile cache.
- Replace sandbox image smokes that coordinate two processes with a
  workspace-runtime-only smoke that exercises typed Session V2 and failure
  persistence through the embedded SDK.
- Validate packaged artifacts outside monorepo resolution and record bundle
  metafiles/SBOM-like production dependency inventories.

**Test scenarios:**

- **Happy path:** desktop-local, self-hosted, Docker sandbox, and Cloudflare
  sandbox create/resume/stream an OpenCode session with no engine child.
- **Edge case:** clean shutdown during idle, active stream, active tool, and
  suspended session releases database/native resources.
- **Error path:** a retired `OPENCODE_URL`, `CLAXEDO_CHILD_OPENCODE_*`, or worker
  setting fails startup clearly; missing native packaging fails the artifact
  smoke rather than selecting another path.
- **Integration:** packaged macOS, Windows, and Linux builds select the intended
  Node/Bun exports and pass first-use, restart, and migration smokes.

**Verification:** Release artifact and process inventories contain the
workspace runtime plus public SDK closure, with no OpenCode CLI/listener,
node-embed artifact, or engine worker.

- [ ] **Unit 8: Delete the forked runtime and install permanent absence gates**

**Goal:** Finish the migration by removing every obsolete implementation,
configuration surface, package edge, test, and document, then make regression
machine-detectable.

**Requirements:** R1-R12

**Dependencies:** Units 2-7

**Files:**

- Remove: `packages/sdk-next/**`
- Remove: `packages/opencode/**`, `packages/server/**`, and other vendored
  runtime-capable source trees after the dependency graph proves no retained UI
  consumer. Unit 2 already removed every proven collision and production
  runtime edge; this unit removes remaining dead/moved fork source and the
  OpenCode binary. Non-runtime UI/TUI/recorder source is removed only when it is
  dead or still reaches the forbidden production closure, not merely because of
  its ancestry or package prefix.
- Remove: `packages/claxedo-server-core/src/opencode/engine.ts` and obsolete
  raw auth/boot helpers
- Remove: OpenCode process manager/raw SSE/proxy/worker tests and replace their
  behavioral coverage at the typed runtime boundary
- Modify: root scripts, README, package maps, architecture docs, CI workflows,
  Dockerfiles, examples, perf harnesses, and e2e invariants
- Create: `docs/solutions/opencode-public-sdk-cutover.md` after verification

**Approach:**

- Delete in dependency order only after each retained behavior is owned by the
  new path. Do not leave dead packages merely excluded from one build.
- Add source gates for forbidden symbols and operational reads of retired
  environment variables. Reject `dist/internal`, `/internal/host`,
  `EmbeddedHost`, any `@opencode-ai/sdk/dist/**` import, and every other SDK
  deep import even if the published tarball physically contains it. Add dependency
  gates for local/duplicate OpenCode runtime families, artifact gates for old
  binaries/assets, and a process-inventory gate for child OpenCode processes.
  Allowlist only one retired-setting validator, its tests, and migration docs so
  startup can explain removals without preserving configuration plumbing.
- Update documentation to describe direct SDK ownership, typed routes, data
  migration/backup, beta upgrade policy, and operational rollback.
- Record the exact release tuple: application artifact digest, SDK family,
  lockfile, migration version, and backup identifier.

**Test scenarios:**

- **Happy path:** all three deployment modes pass the full session/integration
  matrix from a clean frozen install.
- **Edge case:** an attempted reintroduction of a forbidden import, environment
  variable, package, artifact path, or child process fails CI.
- **Error path:** an SDK failure remains explicit all the way to health/UI and
  cannot be converted to an old-path success.
- **Integration:** production dependency trees and built artifacts contain one
  exact public SDK family and no vendored runtime package.

**Verification:** Repository, dependency, artifact, and process searches are
all clean; obsolete tests/docs are replaced rather than merely deleted; and the
new solution note captures the migration's durable lessons.

## System-Wide Impact

- **Interaction graph:** OpenCode requests move from control-plane/global raw
  engine composition into the workspace runtime's typed adapter. Local and
  hosted WorkGraph converge on that same route. Browser streams stay connected
  to Claxedo's hub and no longer own upstream engine streams.
- **Error propagation:** typed SDK errors are projected once into stable
  Claxedo route/harness errors. Host boot/migration errors affect OpenCode
  readiness only. Prompt admission ambiguity is handled by rereading canonical
  session state, never by retrying the prompt.
- **State lifecycle:** one host and one event pump per process remove duplicate
  event readers but make host shutdown ordering load-bearing. The event pump,
  tool/session registry, credential/MCP reconciliation, Claxedo projections,
  SDK recovery, and SQLite writer must have explicit drain/close ownership.
- **Security boundaries:** no loopback engine listener, capability token, or
  externally configurable OpenCode URL remains. Location validation, route
  authorization, credential allowlists, unmanaged credential protection, and
  relay auth remain enforced at Claxedo boundaries. Secrets must not appear in
  SDK logs, config snapshots, migration artifacts, or bundle inventories.
- **API surface parity:** browser routes, relay routes, Session V2, harness
  adapter methods, provider/model catalogs, WorkGraph, permissions/forms,
  todos, and events all need explicit typed mappings. Removing raw proxying
  means an unlisted endpoint is intentionally absent.
- **Persistence:** the existing local database is process-global across local
  workspaces; hosted sandboxes use process/workspace-scoped storage. A location
  is always supplied and no two SDK hosts share a database file.
- **Performance:** removing the desktop worker eliminates a process and
  listener but may increase the long-lived server process's RSS. Cold shell
  hydration and generic `/global/event` must remain SDK-cold; only explicit
  OpenCode catalog/use starts it.
- **Developer workflow:** upstream upgrades become explicit contract
  migrations. Reserved package names are no longer occupied locally, frozen
  installs are mandatory, and SDK changes require the parity, migration,
  packaging, and artifact gates.
- **Unchanged invariants:** Claxedo remains authoritative for workspace
  identity, route authorization, session projection, usage accounting,
  credentials, Agent Config, terminal execution, relay routing, and WorkGraph.
  Non-OpenCode harnesses keep their current adapters and do not depend on SDK
  readiness.

## Dependencies / Prerequisites

- The exact beta release and matching public package family must remain
  obtainable and pass the Unit 1 public contract gates.
- A sanitized migration corpus covering every supported schema generation,
  deployment layout, journal state, and bounded size class plus a packaged
  performance baseline must be available before cutover is considered done.
- CI/release builders must exercise every supported desktop target and both
  sandbox image variants outside workspace package resolution.
- Operational rollout must be able to pair immutable application artifacts
  with consistent pre-migration database snapshots.
- The selected exact SDK family must satisfy the repository's dependency-age
  policy before adoption. A one-time exception, if explicitly approved, must
  capture registry source, lockfile/tarball integrity hashes, package-family
  diff, native/lifecycle-script audit, provenance, vulnerability results, and
  restore the normal age policy immediately afterward.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| V2 beta contract changes during implementation | High | High | Pin `0.0.0-beta-18314`; frozen lockfile; treat any upgrade as a separate reviewed migration. |
| Existing V1 database is incompatible | Medium | Critical | Treat the published Node V1 migrator as a known no-op; ship the legacy export checkpoint first, import into fresh V2 storage through the public typed API, validate semantics, and never let the new runtime open the V1 database. |
| Event projection loses or duplicates facts | Medium | High | One retained at-least-once pump; durable checkpoints where events expose ordering; deterministic reconciliation keys elsewhere; repair usage from paged assistant-message token snapshots, compare `session.get` totals, and keep `session.stats` as aggregate audit rather than accumulating event deltas. |
| WorkGraph Promise tools ignore interruption | High if Promise API is used | High | Use a cancellable Effect plugin/owned cancellation path and make interruption a release gate. |
| Package name collision resolves old/local code | High before Unit 2 | High | Isolate and contract-test the exact public family in checkpoint 2a, migrate DTO consumers in 2b, then vacate legacy names last and enforce the one-family dependency/bundle gate in 2c. |
| Native SDK closure fails in packaged Electron/sandbox | Medium | High | Cross-platform artifact smokes outside monorepo; verify export conditions/native modules before deletion release. |
| Removal of worker regresses memory/startup | Medium | Medium | Preserve lazy host creation; measure packaged baselines; establish explicit go/no-go thresholds. |
| Credential/MCP reconciliation deletes unmanaged state | Low-Medium | High | Preserve ownership ledgers and complete-snapshot semantics; cover add/update/remove and unmanaged cases. |
| Raw compatibility behavior is recreated ad hoc | Medium | High | Route-to-typed-operation manifest; forbid generic request/proxy capabilities and private imports. |
| Published but unexported raw-fetch host is deep-imported | Medium | High | Ban SDK deep imports, `dist/internal`, `/internal/host`, and `EmbeddedHost` in source, dependency, and bundle scans; import only documented package exports. |
| Rollback loses post-cutover writes | Medium | Critical | Zero-loss RPO; pre-write snapshot rollback only; after writes require preserved V2 delta + proven replay or maintenance-mode fix-forward. |
| Migration backup exposes conversations or secrets | Low-Medium | Critical | Protected app-data location, least-privilege access, encryption where supported, redacted diagnostics, authenticated restore, bounded retention, and artifact exclusion. |
| Shared host crosses workspace authority | Low-Medium | Critical | Opaque authorized workspace scopes, canonical realpaths, per-operation session/location checks, and adversarial isolation tests. |
| Pinned beta or native dependency is compromised | Low | Critical | Integrity/provenance capture, lifecycle/native audit, real SBOM, vulnerability gate, and bundled-plugin allowlist. |

## Phased Delivery

### Phase 1: Contract and namespace preparation

- Complete Units 1-2 without shipping a second runtime.
- Establish exact package resolution, behavior parity, data fixture, and
  performance/process baselines.
- After Unit 1 proves the transfer schema, ship checkpoint 6a in the final
  legacy-runtime release: add the non-interactive bulk exporter, quiesce and
  close its writer, export all sessions plus the Claxedo archive ledger, write
  the checksummed manifest, and verify the rollback backup. Do not begin the
  embedded-only rollout for installations that have legacy data until this
  checkpoint has completed.

### Phase 2: Build the sole path behind all product contracts

- Complete Units 3-5 and checkpoint 6b on a non-released cutover branch.
- Run the typed SDK host, adapter, events, integrations, WorkGraph, and data
  migration through runtime-boundary integration fixtures. Real packaged
  desktop/self-hosted/sandbox entrypoints are reserved for Phase 3 after Unit 7
  composes them.
- No request-level or runtime-selection feature flag is introduced.

### Phase 3: Artifact cutover and deletion

- Complete Units 7-8 as one release boundary.
- Roll out immutable embedded-only artifacts by cohort if desired. Each cohort
  runs one path; the prior cohort artifact is a full release rollback, not a
  runtime fallback.

## Success Metrics

- All desktop-local, self-hosted, and hosted/sandbox OpenCode session matrices
  pass with zero child OpenCode/engine-worker processes.
- Cold shell hydration, generic session listing, and the Claxedo global event
  stream do not create the SDK host; concurrent first OpenCode use creates one.
- Every supported V1 migration-corpus entry is exported by checkpoint 6a,
  imported into fresh V2 storage by checkpoint 6b, and restarts with matching
  semantic counts/identities and verified backup restoration.
- SDK events are delivered at least once while stable idempotency keys produce
  exactly one Claxedo metadata and intake effect; usage reconciles exactly once
  from paged assistant-message token snapshots after reconnect, agrees with
  `session.get` totals, and uses `session.stats` only for aggregate audit.
- Credential and MCP add/update/remove behavior affects the next eligible turn
  and preserves unmanaged entries.
- WorkGraph local and hosted sessions use the same workspace-runtime typed path.
- Production source, dependency graphs, bundles, images, and process
  inventories contain one exact public SDK family and none of the removed path.
- SDK failure is observable and never results in an external URL, spawned
  server, worker, raw-router, or fabricated-success fallback.

## Documentation / Operational Notes

- Update root/package architecture docs to stop describing Claxedo as shipping
  the OpenCode engine fork. Distinguish retained UI ancestry from runtime
  ownership.
- Document the exact SDK upgrade procedure: inspect V2 migration/changelog,
  change the pinned family atomically, rerun contract/data/artifact gates, and
  record the new release tuple.
- Document lifecycle (`cold`, `migrating`, `ready`, `draining`, `closed`,
  `unavailable`) separately from orthogonal event health (`healthy`,
  `degraded`) without exposing credential details.
- Add a migration/rollback runbook that always pairs application artifact and
  database snapshot.
- Delete operator documentation for `OPENCODE_URL`, embed/worker paths, and
  separate OpenCode server setup; replace it with the removed-setting startup
  diagnostic and embedded-only model.
- Treat the SDK as privileged supply-chain code: capture registry/tarball
  integrity and provenance, audit native modules and install scripts, generate
  a real SBOM, scan vulnerabilities with explicit exceptions, and forbid
  runtime plugin/package discovery outside the reviewed bundle.

## Sources & References

- [Public OpenCode embedded SDK](https://opencode.ai/v2/docs/build/sdk)
- [Public JavaScript client](https://opencode.ai/v2/docs/build/client/)
- [Published `@opencode-ai/sdk@0.0.0-beta-18314` artifact](https://www.npmjs.com/package/@opencode-ai/sdk/v/0.0.0-beta-18314)
- [Published `@opencode-ai/core@0.0.0-beta-18314` artifact](https://www.npmjs.com/package/@opencode-ai/core/v/0.0.0-beta-18314)
- [Public V2 plugin API](https://opencode.ai/v2/docs/build/plugins)
- [V1 to V2 migration status and breaking changes](https://opencode.ai/v2/docs/migrate-v1)
- [OpenCode V2 API](https://opencode.ai/v2/docs/api)
- [OpenCode Cloudflare/Workerd profile](https://opencode.ai/v2/docs/build/sdk/cloudflare/)
- [SQLite online backup API](https://www.sqlite.org/backup.html)
- [SQLite corruption guidance](https://www.sqlite.org/howtocorrupt.html)
- [Google SRE release engineering](https://sre.google/sre-book/release-engineering/)
- [Google SRE canarying releases](https://sre.google/workbook/canarying-releases/)
- Related strategy: `docs/plans/2026-08-19-000-opencode-just-another-harness-index.md`
- Prior engine ownership plan: `docs/plans/2026-08-19-003-refactor-opencode-engine-as-adapter-detail-plan.md`

## Alternative Approaches Considered

- **Keep the vendored engine and add the public SDK beside it:** rejected
  because it preserves two package/runtime graphs, doubles lifecycle and data
  ownership, and does not satisfy the user's removal requirement.
- **Port the public SDK code into the Claxedo fork:** rejected because Claxedo
  would continue owning an upstream runtime fork and would not benefit from the
  public package contract or upgrade path.
- **Keep raw `Request -> Response` as the internal abstraction:** rejected
  because the public SDK intentionally does not expose raw fetch/router access;
  using private imports would make the public installation cosmetic.
- **Keep `opencode serve` only for hosted sandboxes:** rejected because hosted
  would retain a second lifecycle, listener, binary, and API path, contradicting
  the product-wide invariant.
- **Create one SDK host per local workspace:** rejected for the initial cutover
  because the current local database and engine are process-global; it would
  multiply memory and turn migration into a database split. Location validation
  provides isolation within the one local process host.
- **Runtime fallback on SDK failure:** rejected because it masks migration
  defects, risks two writers against one database, and makes removal
  unverifiable. Release rollback provides safer recovery.
