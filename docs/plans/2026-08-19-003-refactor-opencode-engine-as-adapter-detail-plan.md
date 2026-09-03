---
title: "refactor(engine): the embedded OpenCode engine becomes an opencode-adapter implementation detail"
type: refactor
status: proposed
date: 2026-08-19
planned-at: c97fe21
priority: P2
effort: L
risk: MED
depends-on: 2026-08-19-002 (and coordinate with 2026-07-22-001)
---

# refactor(engine): embedded engine as an opencode-adapter implementation detail

> **Executor instructions**: Follow this plan unit by unit. Run every
> verification command and confirm the expected result before moving on. If
> anything in "STOP conditions" occurs, stop and report — do not improvise.
> When done, update this plan's status row in
> `docs/plans/2026-08-19-000-opencode-just-another-harness-index.md`.
>
> **Drift check (run first)**:
> `git diff --stat c97fe21..HEAD -- packages/workspace-runtime/src/workspace/runtime.ts packages/claxedo-server-core/src/opencode packages/claxedo-server/src/deployments/self-hosted-node`
> Plan 002 SHOULD have changed some of these files — read their updated state
> rather than expecting the c97fe21 excerpts verbatim; the excerpts below mark
> which pieces it moves. On an unexplained mismatch, STOP.

## Why this matters

The strategic claim is "OpenCode is just another harness", but the composition
still treats the vendored engine as ambient infrastructure: any unknown runner
silently becomes an OpenCode session, and several server features reach the
engine transport directly rather than through the OpenCode adapter. The
end-state this plan enforces is simple to state and machine-checkable: **a
Claxedo install whose user never touches an OpenCode surface never loads the
engine, and no non-OpenCode code path depends on `opencodeRequest`.** That is
what makes the eventual shrinking of the vendored fork possible, and what
makes capability claims about other harnesses honest.

## Current state (observed at c97fe21; per-item ownership noted)

### The engine transport and its consumer inventory

`packages/claxedo-server-core/src/opencode/engine.ts` — one injected transport
(`opencodeRequest`, line 185), embedded-by-default (`config = { mode:
"embedded" }`, line 50), lazily booting via `embeddedHost()` (lines 129-159)
with loader seam `__setOpenCodeEmbedLoaderForTests` (line 119) and
`configureOpenCodeEmbedPath` for bundled artifacts (line 105).

Complete non-test consumer inventory of `opencodeRequest` / `OpenCodeRequestFn`
at `c97fe21` (from `grep -rln "opencodeRequest\|OpenCodeRequestFn" packages/claxedo-server/src packages/claxedo-server-core/src packages/workspace-runtime/src --include=*.ts | grep -v test`):

| Consumer | Role | Disposition |
|---|---|---|
| `claxedo-server-core/src/credentials/engine-bridge.ts` | auth sync | plan 002 moves + gates it |
| `claxedo-server/src/deployments/self-hosted-node/app.ts` | composition root (engine mode config, compat events, runtime options) | U2 audits its boot triggers |
| `workspace-runtime/src/server.ts` + `src/workspace/runtime.ts` | `WorkspaceHostOptions.opencodeRequest` → OpenCode adapter + compat routes | KEEP — this IS the adapter path |

### The unknown-runner fallthrough (this plan's U1)

`packages/workspace-runtime/src/workspace/runtime.ts:740-816`,
`defaultWorkspaceHarnessRegistry()` — final entry:

```ts
{
  match: () => true,
  create: ({ options }) => new OpenCodeHarnessAdapter(options.opencodeUrl, { ... }),
},
```

with the doc comment (lines 743-746): "The final OpenCode entry matches
everything, so it is both the `opencode` runner's adapter AND the fallthrough
for any unknown runner — preserving today's 'unknown → OpenCode' behavior."
`createAdapter` (lines 855-867) already throws a typed error when no entry
matches.

### Boot triggers audited by U2 (state at c97fe21)

In `packages/claxedo-server/src/deployments/self-hosted-node/app.ts`:

- line 1279 `configureOpenCodeEngine({ embedded: true })` — config only, no boot.
- lines 1285-1287 boot-time credential reconcile — REMOVED by plan 002.
- line 1296 `configureOpencodeMcpSync({ enabled: opencodeCompat })` — verify laziness (U2).
- line 1362 `createOpencodeEvents(opencodeRequest, { autoStart: false })` —
  gated on `opencodeCompat`, autoStart false; verify what `start()`s it (U2).
- line 1140 `usageSourceCoverage.ensure([...])` — list bookkeeping, no transport.
- line 1359 `captureControlPlaneStartupTelemetry(..., { engineMode: opencodeEngineMode() })` — reads config only.

### Default-harness fact (out of scope, but load-bearing context)

`packages/claxedo-server-core/src/agent-config/index.ts:354-361` —
`defaultHarness()` falls back to `{ id: "opencode", access: "native" }`. The
product default stays OpenCode; this plan does NOT change it. The guarantee is
conditional: *if* the user's effective harness is not opencode and compat
surfaces go unused, the engine never loads.

### Coordination with the scriptable-ACP plan (2026-07-22-001)

That active plan replaces closed harness unions with a server-owned accepted
registry and removes first-party ACP duplicates. U1 here touches the same
`defaultWorkspaceHarnessRegistry`. If that plan has started when you execute
this one, rebase U1 onto its registry shape instead of editing the c97fe21
shape — the semantic requirement ("unknown runner → typed error, not an
OpenCode session") is identical in both worlds.

## Commands you will need

| Purpose | Command (from repo root) | Expected on success |
|---|---|---|
| Install | `bun install` | exit 0 |
| Typecheck (all) | `bun turbo typecheck` | exit 0 |
| workspace-runtime tests (targeted) | `cd packages/workspace-runtime && bun test src/workspace --timeout 30000` | all pass |
| server-core tests | `cd packages/claxedo-server-core && node ./node_modules/vitest/vitest.mjs run src/opencode` | all pass |
| claxedo-server suite | `cd packages/claxedo-server && bun run test` | all pass |

## Scope

**In scope**:

- `packages/workspace-runtime/src/workspace/runtime.ts` (registry final entry
  + its doc comment; nothing else)
- `packages/claxedo-server/src/deployments/self-hosted-node/app.ts` (boot-
  trigger audit fixes only)
- `packages/claxedo-server/src/opencode/**` and
  `packages/claxedo-server-core/src/opencode/**` (lazy-start fixes surfaced by
  U2)
- New/updated tests beside each

**Out of scope**:

- Removing vendored engine packages, changing `defaultHarness`, or touching
  desktop artifact bundling (`opencodeEmbedPath` callers in
  `packages/claxedo-desktop/scripts/*` and
  `packages/claxedo-local-server/src/app/start-local-server.ts` stay — the
  engine remains SHIPPED, it just loads lazily).
- The OpenCode-compat route surface itself (kept by design; see index doc).

## Implementation units

### U1 — Unknown runner is an error, not an OpenCode session

In `defaultWorkspaceHarnessRegistry()`, change the final entry's predicate
from `match: () => true` to `match: (runner) => runner.id === "opencode"`, and
rewrite the entry's doc comment: unknown runners now surface
`createAdapter`'s existing typed error (`No workspace harness adapter
registered for runner "<id>:<access>"`, runtime.ts:864). Audit test
expectations that relied on the fallthrough
(`grep -rn "unknown" packages/workspace-runtime/src/workspace/*.test.ts` and
the registry tests) and update them to assert the error instead.

Risk note: today `normalizeHarness` in `routes/config.ts:136-147` rejects
unknown ids before a snapshot applies, so no VALID stored snapshot can carry an
unknown runner — the fallthrough is reachable only from host-constructed
runners. Confirm that claim by searching for direct `createWorkspaceHost`
callers passing `harness:` values
(`grep -rn "harness:" packages/claxedo-local-server/src packages/claxedo-server/src --include=*.ts | grep -v test | grep -v profile.harness`)
and reading what ids they can produce. If any live path can produce a non-enum
runner id today, STOP and report it (it would currently be silently running
OpenCode — a real finding).

**Verify**: `cd packages/workspace-runtime && bun test src/workspace --timeout 30000` → pass, including an updated/new test: runner `{ id: "waku", access: "native" }` → `createAdapter` throws the typed error; runner `{ id: "opencode", access: "native" }` → OpenCode adapter.

### U2 — Boot-trigger audit: nothing engine-flavored runs an engine request at server start

Write the test FIRST (see Test plan #2): boot the self-hosted app in
local-only mode with a spy loader installed via
`__setOpenCodeEmbedLoaderForTests` (and a spy on `opencodeRequest` if
exported seams allow), assert zero engine requests and zero embed loads
during startup and during a claude-harness session lifecycle exercised
through the app's real HTTP surface (use the existing app-level test harness
in `packages/claxedo-server/src/deployments/self-hosted-node/*.test.ts` as the
pattern — e.g. `app.posture.test.ts`).

Then fix whatever the test flags. Known candidates to check, in order:

1. `configureOpencodeMcpSync({ enabled: opencodeCompat })` (app.ts:1296) —
   read `packages/claxedo-server/src/opencode/**` for what it does at
   configure time vs. on demand.
2. `createOpencodeEvents(opencodeRequest, { autoStart: false })`
   (app.ts:1362) — find who calls `.start()`; an SSE subscribe to
   `/global/event` compat routes starting the engine stream is an OpenCode
   surface (fine); a control-plane-internal eager start is not.
3. Anything plan 002 left: the boot credential reconcile must already be
   hook-based; assert, don't re-fix.

**Verify**: the new startup test passes; full claxedo-server suite passes.

## Test plan

1. **U1**: registry dispatch test — unknown runner → typed error; opencode
   runner → OpenCode adapter; existing ACP/native/pi dispatch unchanged.
   Model on existing registry/adapter tests in
   `packages/workspace-runtime/src/workspace/`.
2. **U2**: app-level cold-engine startup test (the plan's headline
   guarantee): local-only boot + claude-harness session flow → loader spy
   never invoked, `opencodeEngineLoaded()` stays false. Then: hit one compat
   route (an OpenCode surface) → loader invoked exactly then. Model on
   `deployments/self-hosted-node/*.test.ts` composition tests.

## Done criteria

- [ ] `bun turbo typecheck` exits 0.
- [ ] `cd packages/workspace-runtime && bun run test` exits 0.
- [ ] `cd packages/claxedo-server && bun run test` exits 0.
- [ ] `grep -n "match: () => true" packages/workspace-runtime/src/workspace/runtime.ts` → no matches.
- [ ] The U2 startup test exists and proves: cold boot + non-opencode session
      lifecycle → zero engine loads; first compat/opencode use → engine loads.
- [ ] Consumer inventory holds: `grep -rln "opencodeRequest\|OpenCodeRequestFn" packages/claxedo-server/src --include=*.ts | grep -v test` lists only composition roots and `opencode`-surface modules.
- [ ] `git status` clean outside the in-scope list; index status row updated.

## STOP conditions

- Plan 002 has not landed (its dispositions are assumed throughout).
- U1's audit finds a live path that can produce a non-enum runner id (report
  the silent-OpenCode finding; do not paper over it).
- U2's test cannot isolate engine loads because a module import (not a
  request) transitively pulls `opencode/node-embed` — that is an import-graph
  finding to report with the offending chain
  (`bun x madge` or manual trace), not something to fix ad hoc.
- The scriptable-ACP plan (2026-07-22-001) landed a different registry shape
  and U1's rebase is not mechanical.
- A verification fails twice after a reasonable fix attempt.

## Maintenance notes

- After this plan, "the engine is reached only through OpenCode surfaces" is
  an enforceable review rule; consider a governance test in
  `packages/claxedo-server/src/tests/governance/codebase-shape.test.ts`
  (the repo already enforces import-direction rules there) restricting
  `@claxedo/server-core/opencode/engine` imports to an allowlist — a natural
  follow-up, deliberately not required here.
- Watch `root package.json`'s `dev` script (`bun run --cwd packages/opencode
  ...`): it advertises the engine as "the" dev entrypoint. Renaming it (e.g.
  `dev:engine`) is a one-line DX follow-up once the server is the primary
  entrypoint — out of scope here.
