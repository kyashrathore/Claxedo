# The daemon does only what a session asked for

Status: proposed 2026-09-16, not started. Measured on the dev install
(`Claxedo Dev.app` built from this tree, Electron 43.2.0, daemon
`claxedo-server` utility process) against a data directory created fresh the
same evening, with `proc_pid_rusage` counters sampled every 10 s, `sample`
stacks taken inside each read burst, an inspector CPU profile of the daemon,
and `fs_usage` traces where they were attributable. Numbers below are from
those captures, not estimates.

## What is wrong, observed

A desktop with two projects and a handful of sessions in the Claude harness
had the daemon do the following, none of it asked for by a session:

1. **7 GB read in 35 s at 200% CPU** (22:46:42–22:47:17) when a location
   opened for `~/test/opencode`. Every stack sample was inside
   `libfff_c.dylib` on threads `fff-bg-0…5` and `fff-git-status`: the
   OpenCode engine's `FileSystemSearch` service selected the `fff` native
   indexer for the checkout (`@opencode-ai/core/dist/chunks/state-*.js`,
   `layer()`: fff on any VCS checkout on macOS). Git's view of that
   repository is 8,275 tracked files, 70 MB; fff read a hundred times that,
   so it walked ignored trees (`node_modules`, 9.9 GB of `.worktrees/`) and
   read content despite `disableContentIndexing: true`. Nothing in Claxedo
   reads that index: folder and file search are served by
   `claxedo-local-server/src/shell/routes.ts` (`globSearch`, `directorySearch`).
2. **A 5.3 MB download and a 10 MB database rewrite every 5 minutes**, forever,
   from the engine's `ModelsDev` service: `refresh().pipe(Effect.repeat(
   Schedule.spaced(5 minutes)))` is forked unconditionally at engine boot,
   fetches `https://models.dev/api.json`, and on a digest change writes the
   whole body into `opencode-runtime/opencode.db` (`kv` row
   `models-dev:catalog`, 5.28 MB; observed 20:00:26 as a 5.1 MB WAL append
   plus a 5.25 MB checkpoint). Claxedo already maintains its own catalog
   (`<dataDir>/opencode-model-catalog.json`).
3. **The engine was running at all.** No workspace had selected the
   `opencode` harness; `defaultHarness(loadUserConfig())` is `undefined` on a
   fresh install and `currentRunner()` throws `WorkspaceHarnessUnavailableError`.
   The SDK runtime is still booted, because it is composed as a process-wide
   service (`claxedo-server/src/deployments/self-hosted-node/app.ts:1605`,
   `claxedo-local-server/src/app/start-local-server.ts:130`) and consulted by
   routes that are not sessions: `integration.list` behind
   `GET /api/claxedo/agent-config/connections`
   (`workspace-runtime/src/opencode/configuration-port.ts:25`), and the
   catalog and provider-policy ports (`catalog-port.ts:64–94`,
   `provider-policy.ts:75`), whose `{ location: { directory } }` calls are
   what open an engine location and start (1).
4. **~75× write amplification while a Claude session streams** — 2.7 MB of
   journal content became 205 MB of logical writes (117 MB physical) in
   11 minutes, 63 MB in the worst minute. `RuntimeStore.commit`
   (`workspace-runtime/src/store.ts`) projected every `message.part.delta`
   immediately: `delta()` rewrote the entire part JSON per token chunk
   (O(n²) per reply) and `checkpoint()` rewrote the checkpoint row per event,
   in a second transaction after the journal insert. Benchmark on the real
   store: 27 KB of streamed text cost 47.5 MB of WAL (48.6 KB/delta); 82 KB
   cost 225 MB (76.7 KB/delta, still climbing).
   *Fixed in this tree, uninstalled build pending:* deltas are journaled per
   event and projected per settle (`settleDeltas`, 200 ms / before any other
   event for the session / before any read / on close); the checkpoint
   advances only when the projection is written, so `replay()` recovers an
   unsettled window. Same benchmark: 12.9 MB and 39.0 MB, flat 13.3 KB/delta.
   What remains is the journal row itself: three 4 KB pages per commit
   (measured 13.01 KB/row at one row per transaction, 1.63 KB at 20 rows,
   0.95 KB at 50).
5. **A full 540-row session-meta upsert on every proxied request** —
   `reconcileSessionMetadata(hit)` on every `ensureEmbeddedWorkspaceRuntime`
   cache hit (`claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:344`):
   measured 106 ms CPU and 1.1 MB of disk write per request, 2.6 GB/hour idle
   from the app's 10 s pollers, and the daemon pinned at its 512 MB heap cap.
   `onSessionMetaEvent` already projects `session.updated` incrementally.
6. **The transcript scanner rescanned 3.75 GB of `~/.claude/projects` and
   `~/.codex/sessions` on every Total-view read** whose classification key
   had moved or whose snapshot was older than 5 minutes (150 GB read in
   3.7 h). *Fixed in this tree and installed:* the snapshot is served for any
   covered range at any age; a walk runs only on explicit refresh or for a
   range nothing stored covers. The first walk on a fresh state dir is still
   1.7 GB / 173% CPU — a tokentracker cost, out of scope here.
7. **The daemon inherits its launcher's environment.** Launched from a shell
   inside a Claude Code session it carried `CLAUDECODE=1`,
   `CLAUDE_CODE_ENTRYPOINT=claude-desktop`, `CLAUDE_AGENT_SDK_VERSION` and
   `ANTHROPIC_BASE_URL` into every harness it spawned; the transcripts were
   stamped as desktop-originated and Claude Code's nested-session gating
   applied to sessions Claxedo owned.
8. **The build migrated the developer's real database** (fixed in this tree):
   `claxedo-server-entry.ts` composed the agent-plugins store — which opens
   and migrates `<dataDir>/claxedo.db` — before `claxedoServerStartup`
   validated the environment, so the compile-cache generator's import of the
   bundle ran migrations against `~/.claxedo`. The entry is reordered, the
   generator evaluates against a scratch data dir and fails the build if
   anything is written there (`assertDataDirUntouched`), with tests.

## Goal

A daemon whose resource use is proportional to what the user is doing:

- With no session running, the daemon reads and writes nothing on a timer
  except the session-meta projection driven by real changes, and no engine
  or indexer process exists for a harness nobody selected.
- Selecting the `opencode` harness boots the engine for that workspace and
  nothing else: no file-tree walk, no models.dev poll.
- A streaming session writes on the order of its content.
- A build never touches a data directory; a daemon never inherits a
  launcher's harness identity.

## Design

### One rule for the engine: cold until a workspace selects it

The OpenCode SDK runtime stays a process-wide singleton (its database and
plugin registry are process-owned) but gains an explicit gate: `host.client()`
is reachable only through `OpenCodeRuntime` methods that carry a workspace
scope whose applied config selects `{ kind: "native", harnessId: "opencode" }`
or a session bound to that harness. Ports that today consult the engine
without that (connections listing, catalogs, provider policy) answer from
Claxedo's own stores when the engine is cold and only consult the engine for
workspaces where it is warm. `WorkspaceHarnessUnavailableError` already
names the "unconfigured" state; the gate reuses it.

`OpenCodeHost.status()` already reports `cold`; the acceptance for this rule
is that status stays `cold` across app launch, project creation, opening a
project, opening the composer, and running a Claude session.

### The engine, when it is warm, runs on its own server options — never on a layer Claxedo built

`fff` is turned off through the server option the pinned SDK already exposes:
`OpenCode.create({ fs: { fff: false } })` (`@opencode-ai/server/options.ts`
declares `fs.fff`; `routes.ts` wires it into `FileSystemSearch.configured`).
The engine then chooses its ripgrep-on-demand implementation, the one it
already uses on Windows.

`embed.overrides` — passing `[FileSystemSearch.node,
FileSystemSearch.configured({ fff: false })]` from this package — was built,
shipped in the 2026-09-16 dev install, and REJECTED. It is not a silent no-op:
the desktop server bundle inlines every `@opencode-ai/core` module it imports,
so the node it passed belonged to a second module instance; the engine hoists
one `ChildProcessSpawner` layer per process and compares implementations by
identity, and the override's dependency chain carried the inlined
`cross-spawn-spawner` node. Every location-scoped engine request in that build
answered 500 "Tag global has conflicting implementations for
effect/process/ChildProcessSpawner" — the rail's `/permission` and
`/question` polls, `/agent`, `/command`, and the engine's own `/api/config`
for every directory — while `/api/health` and `/api/session` stayed green. The
engine has no error reporter and the SDK drops its log without a `log` sink, so
the daemon showed nothing. Guarded now by
`claxedo-desktop/scripts/bundle-single-instance.test.ts` (no `makeGlobalNode`,
`LocationServiceMap` or `ChildProcessSpawner` in the shipped bundle) and by
`OPENCODE_SDK_EXTERNALS` in `workspace-runtime/scripts/stage-opencode-sdk.ts`,
which both server bundles externalize so a future `@opencode-ai/*` import
resolves to the staged copy instead of being inlined.

`ModelsDev` has no server option; when it is addressed it goes through the
`models_dev`/`OPENCODE_MODELS_URL` config surface pointed at Claxedo's catalog
file, not through a layer.

### Session-meta projection is event-driven

`reconcileSessionMetadata` runs on runtime creation and on `config: "sync"`
only. Cache-hit dispatches trust `onSessionMetaEvent`. A read of the session
list still sees new sessions because creation binds the meta row
(`createSession` write-through, `runtime.ts:1580`).

### Journal group commit for streamed deltas

Deltas keep their per-event `seq`, assigned from an in-memory cursor per
session (`next()` reads `MAX(seq)` from the table today and would hand out
duplicates for rows not yet inserted), and are returned to subscribers
immediately; the journal insert joins the settle transaction. Any journal
read (`replay`, the SSE `since` catch-up, `getSessionMaxSeq`) settles first.
The durability change is stated plainly: a daemon killed inside the settle
window loses up to 200 ms of deltas from the journal and, in the same
transaction, from the part — the store stays consistent, ending ≤200 ms
before the harness did, and the harness transcript is the source of truth.
`synchronous = NORMAL` already makes the last WAL commits non-durable across
power loss, so the store never promised more than durable-at-checkpoint.

### Startup scrubs harness identity

`claxedoServerStartup` (desktop) and `startLocalServer` (standalone) own the
environment a daemon runs with. Both drop `CLAUDECODE`, `CLAUDE_CODE_*`,
`CLAUDE_AGENT_SDK_*` and the harness API-base variables before anything is
spawned, with a test that a launcher exporting them produces a daemon whose
`process.env` does not carry them.

## Change points

- `packages/workspace-runtime/src/opencode/runtime.ts`, `host.ts`,
  `configuration-port.ts`, `catalog-port.ts`, `provider-policy.ts`,
  `tool-port.ts`: the cold gate. `host.ts` already passes `fs: { fff: false }`.
- `patches/@opencode-ai%2Fsdk@0.0.0-beta-18684.patch`: `create(options, embed)`
  forwarding is in the tree but nothing passes `embed` any more; it stays only
  as the upstream-faithful signature.
- `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts:344`:
  remove the cache-hit reconcile.
- `packages/claxedo-local-server/src/agent-config/routes/*`,
  `claxedo-server/src/deployments/self-hosted-node/app.ts`: connections and
  catalogs answer without the engine when it is cold.
- `packages/workspace-runtime/src/store.ts`: in-memory seq cursor and
  batched journal insert on top of `settleDeltas` (settlement itself is done).
- `packages/claxedo-desktop/scripts/claxedo-server-startup.ts`,
  `packages/claxedo-local-server/src/app/start-local-server.ts`: env scrub.

## Definition of done

Every row is verified on the installed dev build against a fresh data
directory, with the tracker (`proc_pid_rusage` every 10 s) recording, and the
number written into the row when it is checked.

- [ ] App launched, two projects created, one Claude session run to
      completion: `OpenCodeHost.status().lifecycle === "cold"` throughout;
      no process thread named `fff-*` ever exists in the daemon; no write to
      `opencode-runtime/opencode.db` in 30 minutes. Progress:
- [ ] Selecting the `opencode` harness for a workspace on this monorepo: the
      engine boots; daemon reads during the 60 s after boot < 100 MB (was
      7 GB); no `fff-*` threads; no request to `models.dev` in 30 minutes
      (network capture on the daemon); `opencode.db` `kv` has no
      `models-dev:catalog` row. Progress:
- [ ] Idle daemon with the app open for 10 minutes: daemon disk writes
      < 5 MB total (was 26 MB per 2 minutes); CPU < 1%. Progress:
- [ ] One Claude session streaming a ≥ 50 KB reply: daemon logical writes
      during the session < 4× the journal payload bytes (was 75×);
      `getMessages` after a simulated crash mid-stream returns every settled
      chunk and replays the unsettled ones. Progress:
- [ ] Daemon launched from a shell exporting `CLAUDECODE=1` and
      `CLAUDE_CODE_ENTRYPOINT=claude-desktop`: neither variable in the
      daemon's or any spawned harness's environment; transcripts of
      Claxedo-launched sessions are not stamped `claude-desktop`. Progress:
- [ ] `bun run package:mac` with `~/.claxedo` and `~/.claxedo-dev` present
      and schema-drifted: build succeeds, neither directory's mtime changes
      (done in this tree; re-verify on the final build). Progress:
- [ ] Tests: cold-gate (engine not booted by connections/catalog reads;
      booted by an opencode selection), real-SDK search-layer test, ModelsDev
      no-fetch test, reconcile-on-create-only test, journal group-commit
      tests (seq continuity, ordering, read-before-settle, crash window),
      env-scrub test, build data-dir test (done). All green in the owning
      packages; `bun run test:architecture-ratchets` passes. Progress:
- [ ] Tracker CSV from a 1-hour normal-use window attached to the memory
      note for this plan, with the per-process totals. Progress:

## Non-goals

- Reworking session placement (the `projects()[0]` fallback in
  `handleNewSession`/`handleNewProject`) — real, tracked separately as the
  placement debt.
- Making the first transcript walk cheaper — tokentracker's.
- Replacing SQLite or the WAL settings.

## Execution: parallel lanes with disjoint ownership

Four lanes, no shared files, each ending in its own tests green and a diff
the orchestrator reads before integration:

- **Lane A — engine cold gate** (`workspace-runtime/src/opencode/*`, the
  agent-config routes' cold answers). The `fff` switch is done (`fs.fff`).
- **Lane B — store group commit** (`workspace-runtime/src/store.ts`,
  `store.test.ts`). Starts from the settlement already in the tree.
- **Lane C — session-meta reconcile** (`embedded-workspace-runtime.ts` and its
  tests) — small; can pair with D.
- **Lane D — env scrub** (`claxedo-server-startup.ts`, `start-local-server.ts`,
  tests).

Then one integration pass: rebuild, reinstall, fresh data dir, run the DoD
rows with the tracker, write the numbers in. Reviews: one adversarial review
per lane on the diff, one re-review after fixes, then integrate — no third
pass.
