# Architecture

This document covers how `@claxedo/agent-extensions` is put together: the
split between what the package owns and what a host owns, the data flow from
`install` through to a materialized file on disk, the materializers that do
the actual writing, and the lock that keeps concurrent lifecycle commands from
corrupting state.

## Host / Package Responsibility Split

The package owns deterministic extension mechanics:

- source parsing and GitHub fetch/cache
- desired install state and lock files
- install/update/enable/disable/uninstall lifecycle
- policy overlay resolution
- runtime snapshot creation
- materialization and replay
- owned-artifact cleanup and conflict detection

Product hosts own authorization and orchestration:

- user and organization identity
- workspace admin checks
- catalog allowlists
- hosted persistence
- telemetry and audit
- fanout to connected workspace runtimes

The seam between the two is `getRuntimeAgentExtensionsSnapshot` /
`applyRuntimeAgentExtensions` (`src/runtime-config.ts`, `src/replay.ts`). A
host resolves authorization elsewhere (its own database, its own admin
checks) and expresses the result as `AgentExtensionPolicyOverride[]` — plain
`{ id, scope, enabled, reason? }` records with no knowledge of the package's
internal file formats. The package folds those overrides into a
`RuntimeAgentExtensionsSnapshot`, and a runtime host applies that snapshot
with `applyRuntimeAgentExtensions`. Everything after that point — which
directories get written, how conflicts are detected, how failures are
recorded — is internal to the package.

## Data Flow: install → lock → materialize → replay

Every lifecycle command (`install`, `installCached`, `update`, `enable`,
`disable`, `uninstall`, all in `src/install.ts`) and the runtime replay path
(`src/replay.ts`) write the same three files under an `.agent-extensions`
state root (`agentExtensionFiles`, `src/storage.ts`):

- `installed.json` — desired state: one `DesiredExtensionInstall` per install
  (id, source, scope, targets, enabled) (`src/state.ts`)
- `lock.json` — content lock: resolved SHA, manifest/component digests, and
  targets recorded at install time (`ExtensionLock`, `src/lock.ts`)
- `materialized.json` — the ownership record: every component the package has
  actually written to disk, keyed by owner id (`MaterializedRuntimeRecord`,
  `src/materialization.ts`)

**install** (`installFetchedAgentExtension` in `src/install.ts`) is the
transaction that ties all three together. It resolves the package (from a
project path via `copyPackageToCache`, or from GitHub via
`fetchGitHubPackageToCache`), computes a content digest
(`digestDirectory`, `src/cache.ts`), and then:

1. upserts the `installed.json` entry (`upsertInstallState`)
2. writes the `lock.json` entry with the resolved SHA and digests
3. calls `materializeAgentExtensionSnapshot` (`src/materialize.ts`) to apply
   the package's components to the target runners
4. reads back `materialized.json` to return the caller a concrete result

**materialize** (`src/materialize.ts`) is the pure application step. Given a
list of desired installs plus a map of `{ id: packageRoot }`, it discovers
each package's components (`discoverAgentExtensionComponents`,
`src/discovery.ts` — walks `skills/`, `mcp/`, `plugins/cursor/`, `hooks/`),
dispatches each discovered component to the matching materializer for each
target runner, and writes the resulting `MaterializedComponent` list back
into `materialized.json`. A component that fails does not abort the run —
components applied earlier in the same pass, and components applied by an
earlier run that this pass didn't touch, are kept as still-owned
(`withPreviousApplied`) so a retry never has to fight the package's own prior
output. The failure is only rethrown after the record is safely on disk.

**replay** (`applyRuntimeAgentExtensions`, `src/replay.ts`) is how a runtime
host applies a snapshot it didn't generate locally — the pushed
`RuntimeAgentExtensions` payload from `getRuntimeAgentExtensionsSnapshot`
(or a hosted equivalent). It writes `installed.json` and `lock.json` from the
snapshot's `desired`/`lock` fields, resolves each install's package root
(from a caller-supplied override, a project-relative path, or by fetching
the resolved SHA from GitHub into the state root's `cache/` directory), and
then calls the same `materializeAgentExtensionSnapshot` used by the lifecycle
commands. Every fetched package root is checksummed against the lock's
digest before it's trusted (`verifyPackageDigest`); a mismatch discards the
cache entry and refetches once before giving up. Concurrent replay calls are
serialized through a module-level `applyQueue` promise chain so overlapping
`applyRuntimeAgentExtensions` calls in one process run one at a time, on top
of the cross-process lock described below.

```
install/enable/disable/uninstall ─┐
                                   ├─▶ installed.json + lock.json ─▶ materialize ─▶ materialized.json
replay (pushed snapshot) ─────────┘
```

`materialized.json` is also what powers `list()` and `doctor()` on the
facade (`src/facade.ts`): `list` just reads `installed.json` and
`materialized.json` back; `doctor` cross-references all three files plus the
cache and target paths on disk to report orphaned locks, missing cache
roots, stale symlinks, and corrupt state files as structured issues instead
of throwing.

## The Materializers

Four modules under `src/materializers/` are exposed as their own package
subpath exports (`./materializers/mcp`, `./materializers/cursor`,
`./materializers/opencode-agent`, `./materializers/skills`):

- **`skills.ts`** — `materializeStandaloneSkill` symlinks (or copies, if
  symlinking fails) a package's skill directory into the runner-native skills
  location (`.claude/skills/<name>`, `.agents/skills/<name>` for codex,
  `.opencode/skills/<name>`, `.cursor/skills/<name>`, project- or
  machine-scoped per `skillTargetDir`).
- **`mcp.ts`** — `materializeStandaloneMcp` merges a package's MCP server
  entries into the runner-native config: `.mcp.json` for Claude,
  `.cursor/mcp.json` for Cursor, `.codex/config.toml` for Codex (hand-written
  TOML section editor), `opencode.jsonc` for OpenCode (JSONC edits via
  `jsonc-parser` that preserve the user's comments and formatting).
- **`cursor.ts`** — `materializeCursorLocalPlugin` symlinks a package's
  Cursor plugin directory into `~/.cursor/plugins/local/<name>` (or the
  project directory for workspace-scoped installs).
- **`opencode-agent.ts`** — `materializeOpenCodeDocAgent` writes the
  first-party OpenCode "page assistant" agent file
  (`generateOpenCodeDocAgentMarkdown`) into an agent directory. This one is
  not part of the package-discovery pipeline above — it materializes a
  single fixed, built-in agent definition, not a discovered package
  component.

`skills.ts`, `mcp.ts`, and `cursor.ts` share a common return interface:
each accepts a runner (`HarnessTarget`), a scope (`project` | `machine`), an
`ownerId`, and the previous `MaterializedRuntimeRecord` (so it can tell
whether a conflicting path is already owned by this same package), and each
returns one or more objects shaped like `MaterializedComponent` —
`{ runner, component, type, status, reason?, path? }` with
`status` one of `"applied" | "skipped" | "failed" | "drifted"`. That shared
shape is what lets `materializeDiscoveredComponent`
(`src/materialize.ts`) dispatch to whichever materializer matches a
discovered component's type without any per-runner special-casing, and lets
the result be appended directly into `materialized.json`.

A fourth module conforms to the same interface but sits outside the
discovery pipeline: `hooks.ts` — `materializeAgentHooks` — writes Claxedo's
own cross-runner notification hooks (`~/.claude/settings.json`,
`~/.codex/hooks.json`, `~/.cursor/hooks.json`, and equivalents for Droid,
Gemini, and Mastra) and returns one `{ runner, component: "hooks", type:
"hook", status, path?, reason? }` result per runner. It is invoked directly
by a host, not through `materializeAgentExtensionSnapshot` — package-shape
`hooks/*.json` components discovered by `discoverAgentExtensionComponents`
are recorded as `status: "skipped"` today (`"agent hook package
materialization is not implemented yet"`, `src/materialize.ts`).

Conflict handling is centralized in `linkOrCopyOwnedDirectory` and
`AgentExtensionMaterializationError`
(`src/materialization.ts`): writing over a path this package doesn't already
own throws instead of overwriting, and MCP config merges throw
`agent_extension_mcp_server_conflict` when a server name collides with an
entry this install doesn't own.

## State Locking

Lifecycle commands (`install`, `update`, `enable`, `disable`, `uninstall`)
and runtime replay all perform read-modify-write cycles over the same three
state files. Run two of them concurrently without coordination — a CLI
`install` racing a background `applyRuntimeAgentExtensions` replay, say —
and one process's write can silently clobber the other's.

`withAgentExtensionStateLock` (`src/fs-safe.ts`, added in `4665a18a68`) is a
cross-process mutex over an `.agent-extensions` state root that every one of
those entry points wraps its transaction in
(`src/install.ts:114,384,419,457`, `src/replay.ts:263`). It is a directory
lock, not a file lock: it takes the lock by calling `fs.mkdir` on a
`.replay-lock` subdirectory, which is atomic across processes on every
platform Node targets. A second process racing for the same lock hits
`EEXIST`, waits 100ms, and retries.

A crashed holder would otherwise leave that directory behind forever, so a
lock directory older than `STATE_LOCK_STALE_MS` (10 minutes, by `mtimeMs`) is
treated as abandoned: the next contender removes it and takes over rather
than spinning indefinitely. The lock is released in a `finally`, so a
transaction that throws still releases it for the next caller.

The directory name (`.replay-lock`) predates lifecycle locking — it's kept
as-is for compatibility with older processes that might still be running
against the same state root during a rolling deploy.

This is a distinct mechanism from `lock.json` / `ExtensionLock`
(`src/lock.ts`): that file records what package content is trusted
(resolved SHA and digests) so replay can verify a fetched or cached package
root before materializing it. `withAgentExtensionStateLock` is the mutex
that protects concurrent writes to that file (and to `installed.json` and
`materialized.json`) from interleaving in the first place.
