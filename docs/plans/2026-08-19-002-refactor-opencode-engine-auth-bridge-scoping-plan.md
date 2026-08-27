---
title: "refactor(credentials): scope the engine auth bridge to the OpenCode domain — a credential write never boots the engine"
type: refactor
status: proposed
date: 2026-08-19
planned-at: c97fe21
priority: P2
effort: M
risk: LOW
depends-on: none
---

# refactor(credentials): scope the engine auth bridge to the OpenCode domain

> **Executor instructions**: Follow this plan unit by unit. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's status row in
> `docs/plans/2026-08-19-000-opencode-just-another-harness-index.md`.
>
> **Drift check (run first)**:
> `git diff --stat c97fe21..HEAD -- packages/claxedo-server-core/src/credentials packages/claxedo-server-core/src/opencode packages/claxedo-server-core/src/authority/default-credentials.ts packages/claxedo-server/src/deployments/self-hosted-node/app.ts`
> On any in-scope change since `c97fe21`, compare the "Current state" excerpts
> against live code first; on a mismatch, STOP.

## Why this matters

Storing or deleting an AI provider credential in Claxedo currently syncs it
into the embedded OpenCode engine's own auth store — and because the engine
transport boots the engine lazily on first request, **a user who has never
selected the OpenCode harness pays an engine boot (module load, sqlite init,
instance state) as a side effect of saving an Anthropic key**. The bridge also
lives in the harness-neutral `credentials/` domain of `server-core`, which
misstates ownership: it is OpenCode-specific plumbing. This plan (a) re-homes
the bridge into the `opencode/` domain, and (b) makes it write-only-when-
running: never boot the engine to deliver auth, and deliver pending auth when
the engine actually boots. It is a prerequisite for plan 2026-08-19-003's
"no engine load without an OpenCode surface" guarantee.

## Current state (observed at c97fe21)

### Files and roles

- `packages/claxedo-server-core/src/credentials/engine-bridge.ts` — the
  bridge. Exports `syncCredentialsToEngine(org)` (line 222) and
  `scheduleEngineAuthSync(org)` (line 301). Mechanism: reads bridgeable
  registry credentials (allowlist `ENGINE_PROVIDER_BY_REGISTRY_ID`, lines
  74-84), writes them through the engine's own control routes
  (`PUT/DELETE /auth/:providerID`, lines 171-185) over `opencodeRequest`,
  keeps a removal ledger at `dataDir()/engine-auth-bridge.json` (line 125),
  follows every changed write with `POST /global/dispose` (line 192), and
  warns when `OPENCODE_AUTH_CONTENT` shadows the file (lines 146-158).
- `packages/claxedo-server-core/src/opencode/engine.ts` — the engine
  transport. `opencodeRequest` (line 185) lazily boots the embedded host on
  first request in embedded mode (`embeddedHost()`, lines 129-159). Module
  state includes `loadedHost` (line 126) and `drainOpenCodeEngine` (line 196).
  There is currently no exported "is the engine running" predicate and no
  boot hook.
- Callers of the bridge (the complete non-test set):
  1. `packages/claxedo-server/src/deployments/self-hosted-node/app.ts:1278-1288`
     — boot-time reconcile, embedded mode only:

     ```ts
     configureOpenCodeEngine({ embedded: true })
     // Stored AI credentials live in Claxedo's registry; the engine resolves
     // auth from its own store. Reconcile at boot so an already-stored key powers
     // the first turn — mutations after this keep the two in step (see
     // credentials/engine-bridge.ts). Deferred and non-blocking: it boots the
     // engine lazily and must not gate server startup.
     void import("@claxedo/server-core/credentials/engine-bridge")
       .then((bridge) => bridge.syncCredentialsToEngine())
       .catch(() => {})
     ```

     Note the comment admits the defect: "it boots the engine lazily" — at
     boot, for every install, regardless of harness choice.
  2. `packages/claxedo-server-core/src/authority/default-credentials.ts:49-59`
     — `syncEngineAuth(org)` lazily imports the bridge and awaits
     `syncCredentialsToEngine(org)` after every `putCredential` /
     credential mutation (`defaultControlPlaneCredentials()`), swallowing
     failures.
- `scheduleEngineAuthSync` has NO non-test callers (verified:
  `grep -rn "scheduleEngineAuthSync" packages --include=*.ts` matches only the
  defining file and tests).
- Tests: `packages/claxedo-server-core/src/credentials/engine-bridge.test.ts`
  (imports via relative `./engine-bridge`), engine loader test seam
  `__setOpenCodeEmbedLoaderForTests` in `engine.ts:119`.

### Repo conventions that apply

- One clear owner per responsibility (root `CLAUDE.md`): OpenCode-engine
  plumbing belongs in `server-core/src/opencode/`, beside `engine.ts` and
  `auth.ts`.
- `server-core` package exports are path-based
  (`@claxedo/server-core/credentials/engine-bridge` style); check
  `packages/claxedo-server-core/package.json` `exports` and mirror the pattern
  for the new path.

## Commands you will need

| Purpose | Command (from repo root) | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck (all) | `bun turbo typecheck` | exit 0 |
| server-core tests (targeted) | `cd packages/claxedo-server-core && node ./node_modules/vitest/vitest.mjs run src/opencode src/credentials src/authority` | all pass |
| claxedo-server suite | `cd packages/claxedo-server && bun run test` | all pass |
| Old-path grep | `grep -rn "credentials/engine-bridge" packages --include=*.ts` | no matches (after U1) |

## Scope

**In scope**:

- `packages/claxedo-server-core/src/credentials/engine-bridge.ts` → moved to
  `packages/claxedo-server-core/src/opencode/engine-auth-bridge.ts` (with its
  test file moved beside it)
- `packages/claxedo-server-core/src/opencode/engine.ts` (add running-state
  predicate + boot hook only)
- `packages/claxedo-server-core/src/authority/default-credentials.ts` (import
  path + scheduling semantics)
- `packages/claxedo-server-core/package.json` (exports map entry, if paths are
  explicitly listed)
- `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` (the
  boot-reconcile block only, lines 1278-1288)

**Out of scope**:

- The allowlist, ledger, precedence, and dispose semantics inside the bridge —
  they are correct and documented; this plan relocates and gates, it does not
  redesign.
- `packages/agent-sdk-runtime/src/harnesses/opencode/env.ts`
  (`opencodeAuthContent` — the spawn-fanout path for external `opencode serve`
  processes). Different mechanism, already adapter-owned.
- Hosted/worker deployments (they never import the bridge — it is lazily
  imported precisely to stay off the worker graph; preserve that property).

## Implementation units

### U1 — Re-home the bridge into the opencode domain

Move `src/credentials/engine-bridge.ts` →
`src/opencode/engine-auth-bridge.ts` and its test beside it. Update the two
import sites (`app.ts:1285`, `default-credentials.ts:52`) and any package
`exports` entry. Keep every export name identical. Do NOT leave a re-export
shim at the old path — this repo removes replaced paths (root `CLAUDE.md`),
and both importers are in-tree.

**Verify**: `grep -rn "credentials/engine-bridge" packages --include=*.ts` →
no matches; `bun turbo typecheck` → exit 0; moved tests pass.

### U2 — Engine exposes running-state and a boot hook

In `engine.ts`, add:

```ts
export function opencodeEngineLoaded(): boolean  // true iff loadedHost !== undefined (embedded) — external-url mode returns true (a remote engine is "running" by definition)
export function onOpenCodeEngineBoot(hook: () => void): () => void  // registered hooks fire once per successful embeddedHost() boot, after loadedHost is set; returns unsubscribe
```

Fire hooks inside `embeddedHost()`'s success path (after `loadedHost = host`,
line 145), isolating hook errors (log, never fail the boot). Hooks must also
fire on RE-boot after `drainOpenCodeEngine` + next request, so the bridge
re-reconciles across engine restarts.

**Verify**: new unit tests in `engine.test.ts` style using
`__setOpenCodeEmbedLoaderForTests`: hook fires after first request-triggered
boot; not before; again after drain + next request; unsubscribe works.

### U3 — Write-only-when-running semantics

In `engine-auth-bridge.ts`:

- Add a module-level dirty flag. Give `scheduleEngineAuthSync` real callers
  and the gating logic: if `opencodeEngineLoaded()` is false, set the dirty
  flag and return WITHOUT touching `opencodeRequest` (which would boot the
  engine); if loaded, run `syncCredentialsToEngine` as today.
- Register (once, at module init or first schedule) an
  `onOpenCodeEngineBoot` hook that runs the sync when the flag is dirty — and
  ALWAYS on boot for the boot-reconcile case (a stored key must power the
  first embedded turn; the hook replaces app.ts's eager reconcile).
- In `default-credentials.ts`, `syncEngineAuth` switches from awaiting
  `syncCredentialsToEngine` to calling the gated `scheduleEngineAuthSync`.
- In `app.ts:1278-1288`, replace the boot-time
  `void import(...).then(bridge => bridge.syncCredentialsToEngine())` with a
  lazy import that just registers the bridge's boot hook (e.g. an exported
  `armEngineAuthSyncOnBoot()`), keeping the block inside the
  `else { configureOpenCodeEngine({ embedded: true }) ... }` branch. In
  external-url mode, preserve today's behavior: `opencodeEngineLoaded()` is
  true there, so mutations still sync eagerly to the remote engine (no boot
  cost exists to avoid).

One subtlety to preserve: the CURRENT boot reconcile also REMOVES stale
ledger entries when credentials were deleted while the server was down. The
boot hook's unconditional sync covers this — write a test for it.

**Verify**: targeted server-core tests pass, including new cases below.

## Test plan

Model on the existing `engine-bridge.test.ts` (temp `dataDir`, injected
engine transport) and `engine.test.ts` (loader seam). New cases:

1. Credential mutation with engine NEVER booted → no engine request issued,
   no embed-module load (assert via a loader spy through
   `__setOpenCodeEmbedLoaderForTests`), dirty flag set.
2. Engine boots later (first `opencodeRequest`) → pending sync runs once;
   ledger and dispose behavior identical to today's direct sync.
3. Engine already loaded → mutation syncs immediately (existing tests keep
   passing, relocated).
4. Drain + re-boot → sync re-runs (hook re-fires).
5. External-url mode → mutation syncs immediately without any embed load.
6. Boot-hook sync removes a ledger entry whose credential was deleted while
   the engine was down.

## Done criteria

- [ ] `bun turbo typecheck` exits 0.
- [ ] `cd packages/claxedo-server-core && node ./node_modules/vitest/vitest.mjs run src/opencode src/credentials src/authority` exits 0.
- [ ] `cd packages/claxedo-server && bun run test` exits 0.
- [ ] `grep -rn "credentials/engine-bridge" packages --include=*.ts` → no matches.
- [ ] Test 1 above proves: credential write with cold engine performs zero engine requests and zero embed loads.
- [ ] `git status` clean outside the in-scope list.
- [ ] Index status row updated.

## STOP conditions

- "Current state" excerpts don't match live code.
- You find an additional non-test caller of the bridge beyond the two listed
  (the plan's caller inventory would be wrong — re-verify with
  `grep -rn "engine-bridge\|syncCredentialsToEngine\|scheduleEngineAuthSync" packages --include=*.ts | grep -v test`).
- The engine boot hook cannot be made reliable across drain/reboot without
  restructuring `embeddedHost()` beyond adding a hook list.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- Plan 2026-08-19-003 depends on this plan's guarantee for its end-state
  check ("server boot + non-opencode usage never loads the engine").
- Future credential providers reach the engine only via the allowlist
  `ENGINE_PROVIDER_BY_REGISTRY_ID` — unchanged, deliberate.
- Reviewers should confirm no re-export shim was left at the old path and
  that the worker import graph still excludes the bridge (see
  `deployments/hosted-workerd/worker.import-graph.test.ts` in claxedo-server).
