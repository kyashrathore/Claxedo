# WP-D4 — Package scope rename `@opencode-ai/*` → `@claxedo/*`: pre-scoping inventory

Read-only inventory. No source edits made. Repo: `/Users/yashvardhansingh/test/opencode`,
branch `codex/feat-connection-scoping`. LLD source of truth:
`docs/plans/2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md:504-506` (WP-D4, Wave 4,
"M, repo-wide... Coordinates outside claxedo-app; solo change, own PR"; ordering note at
line 570: "WP-D4/D5 land solo, last."). **WP-D4 has no explicit appendix-section citation in
the LLD** (unlike WP-D3, which cites "appendix-004 support-dirs-org") — its authoritative
detail lives in `docs/plans/2026-07-10-003-claxedo-app-audit-findings-appendix.md:1114-1169`
(the audit finding this WP was carved from). Workers should be pointed at that appendix
range explicitly since the LLD entry itself doesn't name it.

## 1. Classification: rename vs vendored-keep

Full `packages/*/package.json` inventory (34 dirs), split by scope:

### 1a. Product packages to RENAME (4) — WP-D4 scope, confirmed by three independent sources
`src/VOCABULARY.md:150-165` ("Package scope" section), audit appendix
`2026-07-10-003:1114-1169`, and direct grep — all agree on exactly these four:

| package.json | current name | file:line |
|---|---|---|
| `packages/claxedo-app/package.json` | `@opencode-ai/claxedo-app` | :2 |
| `packages/claxedo-server/package.json` | `@opencode-ai/claxedo-server` | :2 |
| `packages/claxedo-desktop/package.json` | `@opencode-ai/claxedo-desktop` | :2 |
| `packages/claxedo-web/package.json` | `@opencode-ai/claxedo-web` | :2 |

Audit appendix `2026-07-10-003:1144` proposes the literal target mapping:
`@opencode-ai/claxedo-app, @opencode-ai/claxedo-server, @opencode-ai/claxedo-desktop,
@opencode-ai/claxedo-web` → `@claxedo/app, @claxedo/server, @claxedo/desktop, @claxedo/web`
— i.e. it **drops the `claxedo-` stutter** rather than doing a literal scope-only
substitution (`@claxedo/claxedo-app`). **This is a decision the LLD text itself does not
make explicitly** ("Package scope rename @opencode-ai/* → @claxedo/*" reads as scope-only).
Flagged as a precondition to resolve before execution (see §6). Two collision checks against
the drop-stutter proposal, both clear:
- `@claxedo/server` — no existing `@claxedo/*` package uses `server` (the vendored engine's
  server is `@opencode-ai/server` at `packages/server/package.json:2`, different scope, no
  collision).
- `@claxedo/app`, `@claxedo/desktop`, `@claxedo/web` — none of the 13 existing `@claxedo/*`
  packages (agent-event-runtime, agent-extensions, agent-sdk-runtime, channels, connections,
  docs, mcp, sandbox-manager, wakes, workgraph, workspace-relay, workspace-relay-protocol,
  workspace-runtime) use these basenames.

One extra wrinkle inside the "product" surface: `packages/claxedo-app/tsconfig.json:20`,
`vitest.config.ts:21`, `tsconfig.e2e.json:20`, and `packages/claxedo-desktop/vite.renderer.ts:57`
all declare an alias `@opencode-ai/app-shared` → `./src/extensions/index.ts`. This is **not a
real npm package** (no matching `package.json` name anywhere) — it's an internal path alias
that happens to carry the `@opencode-ai` scope string, already flagged as a retired/renaming
concept in `src/extensions/index.ts:4` and `src/extensions/types.ts:2` ("Replaces the
@opencode-ai/app-shared ... registry"). It is explicitly whitelisted as "allowed and
unrelated" by `src/architecture/divorce-guard.test.ts:6-7,53`. **Recommend leaving it alone**
for WP-D4 — it isn't one of the four product package.json names, isn't published, and a
same-day PR that touches it invites confusion with the separate in-flight extensions-registry
migration. If a worker does touch it, it must NOT be conflated with the `@opencode-ai/app`
guard string below (near-identical spelling, different guard, see §4).

### 1b. Vendored upstream-engine packages — MUST KEEP `@opencode-ai/*` scope

Per `src/VOCABULARY.md:162-165`: "Design-system/shared packages this app also imports
(`@opencode-ai/ui`, `@opencode-ai/session-ui`) are a separate, intentionally-unrenamed case
(they are shared upstream-lineage UI kits, not one of the four product packages) and are out
of scope for WP-D4." Memory `project_hardfork_completion.md` and
`project_upstream_trim_and_externalize.md` corroborate: "KEEP = vendored engine+UI
(opencode/core/server/protocol/schema/plugin/llm/codemode/tui/ui/session-ui/sdk/
http-recorder/effect-*)" and the explicit decision that upstream fixes port via
`git diff upstream/<old>..<new> -- packages/<pkg>` — a **tree diff against the real upstream
package name**, which breaks if the local name diverges from upstream's.

Confirmed still `@opencode-ai/*`-scoped in this checkout (16 packages):

```
@opencode-ai/cli                  packages/cli/package.json:2
@opencode-ai/codemode              packages/codemode/package.json:2
@opencode-ai/core                  packages/core/package.json:2
@opencode-ai/effect-drizzle-sqlite packages/effect-drizzle-sqlite/package.json:2
@opencode-ai/effect-sqlite-node    packages/effect-sqlite-node/package.json:2
@opencode-ai/http-recorder         packages/http-recorder/package.json:2
@opencode-ai/llm                   packages/llm/package.json:2
@opencode-ai/plugin                packages/plugin/package.json:2
@opencode-ai/protocol              packages/protocol/package.json:2
@opencode-ai/schema                packages/schema/package.json:2
@opencode-ai/script                packages/script/package.json:2
@opencode-ai/server                packages/server/package.json:2
@opencode-ai/session-ui            packages/session-ui/package.json:2
@opencode-ai/storybook             packages/storybook/package.json:2
@opencode-ai/tui                   packages/tui/package.json:2
@opencode-ai/ui                    packages/ui/package.json:2
```

Plus `packages/opencode/package.json:2` — name `opencode` (unscoped), the engine root, and
`packages/sdk/js/package.json` — name `@opencode-ai/sdk`. Both vendored, both out of scope.

**None of these 18 identifiers should be touched by WP-D4.** A naive
`s/@opencode-ai\//@claxedo\//g` across the repo would corrupt every one of them (see §4 risk
table) — this is the single largest hazard in this WP.

### 1c. Stray/retired strings — not real packages, do not treat as rename targets

- `@opencode-ai/app` — the retired upstream `packages/app` (physically deleted per
  `project_hardfork_completion` memory, "removed"/"KEEP" tables). No `package.json` declares
  this name anymore; it survives only as a **forbidden string** guarded against in
  `packages/claxedo-app/src/architecture/divorce-guard.test.ts:15,44-58` (constant
  `UPSTREAM_PKG = "@opencode-ai/app"`) and in prose in `CONTRIBUTING.md:73-74,102`. Do not
  rename or touch — it must stay exactly `@opencode-ai/app` for the guard's forbidden-pattern
  match to remain meaningful (and it must stay clearly distinguishable from the real rename
  target `@opencode-ai/claxedo-app`, which is one character away).
- `@opencode-ai/sdk-next` — package physically deleted (Plan 007 Tier A per
  `project_upstream_trim_and_externalize` memory); only remaining mention is a test fixture
  string in `packages/claxedo-app/src/architecture/scanners.test.ts:45` asserting the scanner
  finds zero imports of it. Harmless, no action.
- `@opencode-ai/orchestrator-*` — mentioned once in `packages/workgraph/TASKS.md:14` as
  historical prose ("Replaced all @opencode-ai/orchestrator-* imports with relative paths").
  No live code reference found. No action.

## 2. Reference inventory for the 4 renameable packages

Repo-wide grep for each literal specifier (excludes `node_modules`, `.git`; includes
`.worktrees/`/`.claude/worktrees/` copies only where separately noted — **caution**, see §4):

| specifier | live-tree hit count (grep -rn, non-worktree) | files |
|---|---|---|
| `@opencode-ai/claxedo-app` | 33 | 21 distinct files (list below) |
| `@opencode-ai/claxedo-server` | 12 | 7 distinct files |
| `@opencode-ai/claxedo-desktop` | 5 | 3 distinct files |
| `@opencode-ai/claxedo-web` | 4 | 3 distinct files |

### 2a. `@opencode-ai/claxedo-app` — full file list with usage kind

Cross-package real imports (must update, functional):
- `packages/claxedo-app/src/main.tsx:11` — `import { PlatformProvider, type Platform } from "@opencode-ai/claxedo-app"` (self-package import via its own `exports["."]`)
- `packages/claxedo-app/src/shell/app-state-snapshot.ts:3`
- `packages/claxedo-app/src/shell/app-shell-state.ts:8`
- `packages/claxedo-app/src/shell/app-shell-layout.tsx:30`
- `packages/claxedo-app/src/components/settings/network-policy.tsx:12`
- `packages/claxedo-app/src/claxedo-ui/state/route-bridge.tsx:10`
- `packages/claxedo-app/src/claxedo-ui/rail/workspace-panel-body.tsx:13`
- `packages/claxedo-app/src/claxedo-ui/rail/rail-sidebar.tsx:23`
- `packages/claxedo-app/src/claxedo-ui/layout-actions/shared.ts:2`
- `packages/claxedo-desktop/src/renderer/index.tsx:8,9,20` (3 imports; genuine cross-package consumer — `@opencode-ai/claxedo-app` → `getAuthToken`/`getDefaultConfig`/`initClaxedo`/`handleNotificationClick`/`Platform` type)

Test-mock string literals (must update in lockstep with the real import, else mocks silently no-op):
- `packages/claxedo-app/src/components/settings/network-policy.ui.vitest.tsx:51` — `vi.mock("@opencode-ai/claxedo-app", ...)`
- `packages/claxedo-app/src/claxedo-ui/rail/rail-workspace-tools.vitest.tsx:44` — same pattern
- `packages/claxedo-app/src/claxedo-ui/rail/rail-sidebar-disclosure.vitest.tsx:8` — same pattern
- `packages/claxedo-app/src/claxedo-ui/components/page-editor/page-editor.integration.vitest.tsx:129` — same pattern

Tooling/guard string literals (self-referential resolvers, must update the literal constant, not just imports):
- `packages/claxedo-app/src/architecture/import-graph.ts:166-168` — `if (specifier === "@opencode-ai/claxedo-app") ...` and prefix-strip for subpath imports (exact string comparison — silently stops resolving self-imports if only the package.json name is renamed and this literal isn't)
- `packages/claxedo-app/scripts/check-forbidden-eager-deps.ts:127,170` — `const CLAXEDO_APP_PKG = "@opencode-ai/claxedo-app"` (same self-resolution risk)

Build/packaging config:
- `packages/claxedo-desktop/electron-builder.config.ts:18` — `"!**/node_modules/@opencode-ai/claxedo-app/**"` glob exclude pattern (must track the new node_modules path or the exclude silently stops matching, bloating/duplicating the desktop build)
- `packages/claxedo-desktop/package.json:34` — `"@opencode-ai/claxedo-app": "workspace:0.0.59"` dependency entry (the only cross-package.json `workspace:` edge onto any of the 4 renameable packages — confirmed by grepping all `packages/*/package.json` for `"@opencode-ai/claxedo-\(app\|server\|desktop\|web\)"`: claxedo-server and claxedo-web have zero such cross-deps)

Docs/prose (should update for consistency, non-functional):
- `packages/claxedo-app/package.json:1` name field itself (counted separately in §1a)
- `packages/claxedo-app/README.md:1` — `# @opencode-ai/claxedo-app` heading
- `packages/claxedo-app/CONTRIBUTING.md:74,102` — historical prose contrasting `@opencode-ai/app` vs `@opencode-ai/claxedo-app` (retired-system explanation; rename the second term only, do not touch the first — see §1c)
- `packages/claxedo-app/src/VOCABULARY.md:150-165` — the glossary section documenting this very rename as NOT-YET-DONE; must be updated to reflect DONE state as part of the same PR, or it becomes stale documentation the moment WP-D4 lands
- `docs/plans/2026-07-10-003-claxedo-app-audit-findings-appendix.md:1114-1169` — the audit finding itself; leave as historical record (do not edit past-dated plan docs), but note it in the WP-D4 PR description as "addressed"

Lockfile: `bun.lock` — 3 direct occurrences at the package's own workspace declaration
(`:93`) plus the `workspace:` resolution table entries (`:2142`); regenerated by
`bun install` after `package.json` edits, not hand-edited (see §5).

No `.d.ts` file references anywhere in the repo (`grep -rln --include="*.d.ts"` returned
empty for all four names) — no ambient type-declaration surface to update.

No `tsconfig.json` `paths` entries alias any of the four package names directly (checked
`claxedo-app`, `claxedo-server`, `claxedo-desktop`, `claxedo-web` tsconfig.json files: only
`@opencode-ai/app-shared` appears, which is the separate non-package alias from §1a, not
these four). No `vite.config`/`vitest.config` alias entries either — desktop's
`vite.renderer.ts` resolves `@opencode-ai/claxedo-app`'s consumer-side import purely through
normal `node_modules` package resolution (bun workspace symlink → `exports` map in
`packages/claxedo-app/package.json:7-17`), not a bespoke Vite alias, so the alias table in
`vite.renderer.ts` needs **no edit** for this package (only `@opencode-ai/app-shared`,
untouched, appears there).

Subpath/deep imports: only one construct handles them, and it's the self-resolver at
`import-graph.ts:167-168` (`specifier.startsWith("@opencode-ai/claxedo-app/")`). No other file
in the repo imports a deep subpath (`@opencode-ai/claxedo-app/extensions`, `/components`,
etc.) even though `package.json:7-17` exports 9 subpaths — they exist but are unused
cross-package (only same-package `@/...`-style internal imports use those directories
directly). Low risk, but the exports map itself (`package.json:7-17`) does not need any
key changes — only the package `name` field changes; subpath keys are name-independent.

### 2b. `@opencode-ai/claxedo-server` — file list

- `packages/claxedo-server/package.json:2` — name field
- `packages/claxedo-server/README.md:1` — `# @opencode-ai/claxedo-server` heading
- `packages/claxedo-server/src/architecture.test.ts:132` — **defensive** forbidden-import
  list: `const forbidden = ["@opencode-ai/claxedo-server", "@claxedo/claxedo-server",
  "claxedo-server"]` inside test `"keeps workspace-runtime from importing claxedo-server"`.
  This test already anticipates BOTH the old name and a hypothetical `@claxedo/claxedo-server`
  stutter-name as forbidden strings for `workspace-runtime` to import — i.e., regardless of
  what WP-D4 renames `claxedo-server` to, `workspace-runtime` must import neither form. Update
  the list only if the actual new name differs from both strings already listed (e.g. if the
  drop-stutter `@claxedo/server` is chosen, add it as a third forbidden entry — the existing
  two entries become moot but harmless to leave).
- `script/verify-examples.ts:4,8,13,17,22` (5 occurrences) — cookbook/example verification
  config referencing `@opencode-ai/claxedo-server` as `packageImports`/`forbiddenImports` in
  example-recipe metadata. Functional: controls which recipes are allowed/forbidden to import
  this package. Must update or examples silently stop being checked against the real package
  name.
- `packages/claxedo-docs/packages/control-plane.mdx:9` — prose: **explicitly describes a
  DIFFERENT, not-yet-planned rename** — "`@opencode-ai/claxedo-server` with `private: true`
  ... A rename to **`@claxedo/control-plane`** (a thin wrapper with explicit stable exports)
  is planned but not published under that scope." This is NOT the same rename as WP-D4 — it
  describes a future semantic repackaging (thin public wrapper), separate from the scope-only
  rename WP-D4 performs. **Do not conflate**: WP-D4 should still update the literal
  `@opencode-ai/claxedo-server` string in this doc to whatever the new in-repo name becomes
  (e.g. `@claxedo/server`), while leaving the "a further rename to `@claxedo/control-plane` is
  planned" sentence intact as still-future work.
- `bun.lock` — `:284` (name decl) + `:2146` (workspace resolution table)

No cross-package `workspace:` dependency edges onto `claxedo-server` from any other
`packages/*/package.json` (checked all 34; only claxedo-desktop→claxedo-app exists, per §2a).

### 2c. `@opencode-ai/claxedo-desktop` — file list

- `packages/claxedo-desktop/package.json:2` — name field
- `docs/plans/2026-07-10-003-claxedo-app-audit-findings-appendix.md` — historical, leave
- `bun.lock` — `:223` (name decl) + `:2144` (workspace table) + `:7260`
  (`"@opencode-ai/claxedo-desktop/typescript"` — a bun-lock-internal dependency-resolution
  sub-key for desktop's own `typescript` devDependency; purely lockfile bookkeeping,
  regenerated automatically, not hand-edited)

No source file anywhere imports `@opencode-ai/claxedo-desktop` as a package specifier (it's
an Electron main-process app, not a library other packages depend on) — confirmed zero hits
outside package.json/bun.lock/docs.

### 2d. `@opencode-ai/claxedo-web` — file list

- `packages/claxedo-web/package.json:2` — name field
- `docs/plans/2026-07-10-003-claxedo-app-audit-findings-appendix.md` — historical, leave
- `bun.lock` — `:329` (name decl) + `:2148` (workspace table)

Same as desktop: no source imports, Astro marketing site, self-contained.

## 3. Published-package check

Reference memory `reference_npm_publishing.md`: "ALL 11 framework packages LIVE on npm...
Only claxedo-server (control plane) stays private." Cross-checked against every
`packages/*/package.json`'s `"private"` field:

| package | `"private"` | `publishConfig` | published under WP-D4-renamed name? |
|---|---|---|---|
| `claxedo-app` | `true` (`package.json:4`) | none | No — private, npm rename has no registry effect |
| `claxedo-server` | `true` (`package.json:9`) | none | No — private, confirmed by reference memory and `control-plane.mdx:9` |
| `claxedo-desktop` | `true` (`package.json:4`) | none | No — private, Electron app, not published |
| `claxedo-web` | `true` (`package.json:4`) | none | No — private, Astro site, not published |

**None of the 4 WP-D4 rename targets are published to npm.** All four are `"private": true`
with no `publishConfig` block. This means the WP-D4 rename has **zero npm-registry
consequences** — no "new name = new package" split, no need to `npm deprecate` an old name,
no re-publish flow. This significantly de-risks the WP relative to the general "renaming a
published package" concern in the task brief.

The 11 LIVE-published packages (per the same memory: sandbox-manager, channels, connections,
workgraph, mcp, and presumably agent-event-runtime/agent-extensions/agent-sdk-runtime/
workspace-relay/workspace-relay-protocol/workspace-runtime to reach 11) are **already**
`@claxedo/*`-scoped (confirmed in the full package-name dump in §1a's sibling list) — they are
untouched by WP-D4 entirely; they were never `@opencode-ai/*`. Verified each declares
`publishConfig` (grep hits at e.g. `agent-event-runtime/package.json:100`,
`sandbox-manager/package.json:154`, `workspace-runtime/package.json:93`, etc.) — orthogonal to
this WP, listed only to confirm no overlap.

## 4. Risk table — what breaks if done naively

| # | Hazard | Evidence | Naive-mistake consequence |
|---|---|---|---|
| R1 | Global `sed 's/@opencode-ai\//@claxedo\//g'` (or equivalent IDE "replace in files") | §1b: 18 vendored `@opencode-ai/*` identifiers (`cli`, `codemode`, `core`, `effect-*`×2, `http-recorder`, `llm`, `plugin`, `protocol`, `schema`, `script`, `server`, `session-ui`, `storybook`, `tui`, `ui`, `sdk`) plus `@opencode-ai/app` (retired-but-guarded) and `@opencode-ai/app-shared` (non-package alias) | Corrupts every vendored-engine import repo-wide (hundreds of files under `packages/{core,server,protocol,...}` and every consumer); breaks the upstream `git diff upstream/<old>..<new> -- packages/<pkg>` port workflow the hard-fork decision explicitly preserved (memory `project_upstream_trim_and_externalize`); silently defeats `divorce-guard.test.ts`'s `@opencode-ai/app` forbidden-string check by turning the guarded string into `@claxedo/app`, which then never matches real (already-nonexistent) offending imports — the guard goes permanently green for the wrong reason |
| R2 | Scoping the sed to only the 4 basenames (`claxedo-app`, `claxedo-server`, `claxedo-desktop`, `claxedo-web`) but as a substring match rather than exact-specifier match | `import-graph.ts:167` uses `specifier.startsWith("@opencode-ai/claxedo-app/")`; `check-forbidden-eager-deps.ts:127` uses exact string constant `CLAXEDO_APP_PKG` | A regex like `@opencode-ai/claxedo-app` would also match inside `@opencode-ai/claxedo-app-something` if such ever existed (none today, but exact-match tooling constants like `CLAXEDO_APP_PKG` must be updated as whole-string constants, not partial regex substitutions, to stay correct) |
| R3 | Missing the self-referential resolver literals | `import-graph.ts:166-168`, `check-forbidden-eager-deps.ts:127,170` | These are hand-written string constants used for *self*-import resolution (claxedo-app importing its own package name) inside architecture-guard scripts. If the `package.json` name changes but these constants don't, the guard scripts silently stop resolving self-imports — either false-passing (imports treated as unresolvable 3rd-party, guard's checks skip them) or false-failing depending on downstream logic. Must grep-verify zero remaining `@opencode-ai/claxedo-` hits after the rename, not just "imports still work" |
| R4 | Test-mock string/import mismatch | `network-policy.ui.vitest.tsx:51`, `rail-workspace-tools.vitest.tsx:44`, `rail-sidebar-disclosure.vitest.tsx:8`, `page-editor.integration.vitest.tsx:129` — all `vi.mock("@opencode-ai/claxedo-app", ...)` | `vi.mock` matches by exact specifier string against the import statement in the file under test. If the source import is renamed but the mock string isn't (or vice versa), the mock silently fails to intercept and the real module loads instead — tests may still pass (false green) if the real module happens to work standalone, or fail with a confusing unrelated error. This is exactly the kind of failure mode the user's memory `feedback_no_false_positive_verification` warns about — must run the affected vitest files and confirm mocks are actually engaged (e.g. via a deliberately-wrong assertion first, or checking mock call counts), not just "tests green" |
| R5 | `architecture.test.ts:132` forbidden-list staleness | `const forbidden = ["@opencode-ai/claxedo-server", "@claxedo/claxedo-server", "claxedo-server"]` | This test is a *negative* guard (workspace-runtime must NOT import claxedo-server by any name). It already defensively lists a stutter-form guess. Low risk either way (test stays correct whether or not updated, since `workspace-runtime` doesn't import claxedo-server under any name), but worth an explicit real-final-name entry for documentation clarity |
| R6 | `electron-builder.config.ts:18` glob | `"!**/node_modules/@opencode-ai/claxedo-app/**"` | If left stale after rename, the desktop build's exclude glob stops matching (new node_modules path is `@claxedo/app` or similar), silently including claxedo-app's source in the packaged Electron output that the glob was meant to exclude — a packaging-size / potential duplicate-code regression that no test catches (packaging-only, not exercised by `bun run typecheck` or vitest) |
| R7 | `@opencode-ai/app` vs `@opencode-ai/claxedo-app` visual near-collision | Both strings coexist in `CONTRIBUTING.md:73-74,102` and conceptually in `divorce-guard.test.ts` | A worker skimming for `@opencode-ai/claxedo` might miss that `@opencode-ai/app` (no "claxedo-" infix) is a *different*, deliberately-still-forbidden string belonging to a different guard, and rename it too — this would break `divorce-guard.test.ts`'s own literal (`UPSTREAM_PKG = "@opencode-ai/app"` at `:15` is a hardcoded constant, not derived from any package.json, so a blind find-replace across `.ts` files WOULD touch it if the search pattern is `@opencode-ai/app` rather than the more specific `@opencode-ai/claxedo-app`) |
| R8 | `@opencode-ai/app-shared` conflated with the rename | `tsconfig.json:20`, `vitest.config.ts:21`, `tsconfig.e2e.json:20`, `vite.renderer.ts:57` | Same near-miss as R7 — a substring match on `@opencode-ai/` scope would catch this alias too, even though it's explicitly whitelisted as unrelated by the divorce-guard's own doc comment. Must exclude via exact-specifier match (`@opencode-ai/claxedo-app` / `-server` / `-desktop` / `-web`), never a bare `@opencode-ai/` prefix match |
| R9 | `bun.lock` hand-editing | 3 name-declaration line ranges + resolution-table entries (§2a-d) + `packages/claxedo-desktop/package.json:34`'s `workspace:0.0.59` version-pinned dep string | Hand-editing `bun.lock` risks producing an inconsistent lockfile (bun.lock format includes content hashes / structural invariants bun's resolver expects). Correct sequence: edit all 4 `package.json` name fields + the one cross-dep in `claxedo-desktop/package.json:34` first, then run `bun install` to regenerate `bun.lock`, never hand-patch it (§5 recipe) |
| R10 | Docs left inconsistent | `README.md:1` headings, `VOCABULARY.md:150-165` (documents the rename as NOT-done), `control-plane.mdx:9` (describes an unrelated *future* second rename) | If WP-D4 lands without updating `VOCABULARY.md`, the glossary — the canonical source new contributors are told to trust — actively asserts a false "not yet renamed" state, actively misleading the next contributor who reads it before touching this area |

## 5. Mechanical execution recipe (ordered, with verification per step)

Preconditions before starting: resolve the naming-scheme question in §6 first (drop-stutter
`@claxedo/{app,server,desktop,web}` vs literal scope-swap `@claxedo/claxedo-{app,...}`) — the
recipe below is name-agnostic (`<NEW_X>` placeholders) but every step's exact string depends
on that decision being locked first.

1. **Baseline gate.** From repo root: confirm `bun turbo typecheck` (or the equivalent
   per-package `bun run typecheck` in `claxedo-app`, `claxedo-server`) is green *before*
   starting, so any new red is attributable to this change.
2. **Rename the 4 `package.json` name fields**, one file at a time:
   `packages/claxedo-app/package.json:2`, `packages/claxedo-server/package.json:2`,
   `packages/claxedo-desktop/package.json:2`, `packages/claxedo-web/package.json:2` →
   `<NEW_APP>`, `<NEW_SERVER>`, `<NEW_DESKTOP>`, `<NEW_WEB>`.
3. **Update the one cross-package.json dependency edge:**
   `packages/claxedo-desktop/package.json:34` — `"@opencode-ai/claxedo-app": "workspace:0.0.59"`
   → `"<NEW_APP>": "workspace:0.0.59"`.
4. **Update the 9 real source-import call sites** for `@opencode-ai/claxedo-app` (§2a list,
   "cross-package real imports" + "test-mock string literals" groups — 13 files total
   including the 4 vitest mocks; exact-string match on `@opencode-ai/claxedo-app`, not a bare
   `@opencode-ai/` prefix, per R7/R8).
5. **Update the 2 self-referential tooling constants:** `import-graph.ts:166-168`,
   `check-forbidden-eager-deps.ts:127,170` (`CLAXEDO_APP_PKG` constant + comment at :170).
6. **Update the desktop packaging glob:** `electron-builder.config.ts:18`.
7. **Update `script/verify-examples.ts:4,8,13,17,22`** (5 occurrences of
   `@opencode-ai/claxedo-server`) to `<NEW_SERVER>`.
8. **Update `packages/claxedo-server/src/architecture.test.ts:132`**'s forbidden-list to
   include the real `<NEW_SERVER>` value alongside the existing defensive entries (leave the
   old entries too — harmless, documents the migration).
9. **Update docs:** `packages/claxedo-app/README.md:1`, `packages/claxedo-server/README.md:1`,
   `packages/claxedo-app/CONTRIBUTING.md:102` (the `@opencode-ai/claxedo-app` half only, not
   the `:73-74` historical-prose sentence's `@opencode-ai/app` half — that one stays),
   `packages/claxedo-docs/packages/control-plane.mdx:9` (rename the literal, keep the
   "further rename to @claxedo/control-plane is planned" sentence).
10. **Update `src/VOCABULARY.md:150-165`** to state the rename is DONE with the actual new
    names (this is the canonical glossary — leaving it stale is itself a P1-vocabulary-chaos
    regression of the exact kind this refactor exists to fix).
11. **Grep-verify zero remaining hits** of the 4 old exact specifiers, scoped correctly to
    avoid R7/R8 false-positives:
    ```
    grep -rn '@opencode-ai/claxedo-app\b' --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" .  # expect 0 outside historical-dated docs
    grep -rn '@opencode-ai/claxedo-server\b' ...   # expect 0 outside historical-dated docs
    grep -rn '@opencode-ai/claxedo-desktop\b' ...  # expect 0 outside historical-dated docs
    grep -rn '@opencode-ai/claxedo-web\b' ...      # expect 0 outside historical-dated docs
    grep -c '@opencode-ai/app\b' packages/claxedo-app/src/architecture/divorce-guard.test.ts   # expect unchanged (>=1) — this string must survive
    grep -c '@opencode-ai/app-shared' packages/claxedo-app/tsconfig.json packages/claxedo-app/vitest.config.ts packages/claxedo-app/tsconfig.e2e.json packages/claxedo-desktop/vite.renderer.ts  # expect unchanged (1 each) — must survive
    ```
12. **Regenerate the lockfile:** `bun install` from repo root (never hand-edit `bun.lock`,
    per R9). Diff `bun.lock` afterward and confirm only the 4 renamed packages' entries and
    their reverse-dependency edges (the `claxedo-desktop` → `claxedo-app` edge) changed — no
    unrelated version bumps should appear (if any do, `bun install` picked up something else
    stale and that needs separate investigation before proceeding).
13. **Full verification:**
    - `bun turbo typecheck` (repo-wide) — must return to the pre-change baseline (green, or
      the same pre-existing red as step 1, no new failures).
    - `bun run test:architecture` in `packages/claxedo-app` (exercises `import-graph.ts`,
      `check-forbidden-eager-deps.ts`, `divorce-guard.test.ts` directly).
    - `bun run test:architecture` (or equivalent) in `packages/claxedo-server` (exercises
      `architecture.test.ts:132`'s updated forbidden-list).
    - Targeted vitest run of the 4 mock-affected files (§2a "test-mock" group) with
      `--conditions=browser` per `reference_frontend_patterns` memory convention — confirm the
      mocks are actually engaged (spot-check one assertion depends on the mocked value, not
      just "no error thrown").
    - `bun run build` in `packages/claxedo-desktop` (or at minimum a dry construction of the
      Rollup input) to sanity-check the `electron-builder.config.ts` glob still excludes the
      renamed dependency directory.
    - `bun run script/verify-examples.ts` (or its CI entrypoint) to confirm the
      `packageImports`/`forbiddenImports` config against `<NEW_SERVER>` still resolves
      correctly against whatever recipes it scans.
14. **Do not touch:** any of the 18 vendored `@opencode-ai/*` identifiers from §1b, the
    `@opencode-ai/app` string in `divorce-guard.test.ts`, or the `@opencode-ai/app-shared`
    alias in the 4 files from §1a/R8.

## 6. Go / no-go

**Go, with two preconditions:**

1. **Resolve the exact target naming scheme before writing any code.** The LLD's own wording
   ("Package scope rename @opencode-ai/* → @claxedo/*") reads as a scope-only substitution
   (`@claxedo/claxedo-app`), while the audit appendix that originated this finding
   (`2026-07-10-003:1144`) proposes dropping the `claxedo-` stutter (`@claxedo/app`). These
   produce different literal strings throughout §2's file list and are NOT
   interchangeable-after-the-fact (a later rename-the-rename is exactly the kind of churn this
   refactor is trying to eliminate). Recommend confirming with whoever owns the LLD/appendix
   before the worker starts — this is a 10-minute decision, not a blocker, but it must be made
   once, explicitly, and documented in `VOCABULARY.md` per step 10 above.
2. **Confirm `@claxedo/server` is acceptable** despite `packages/claxedo-docs/packages/
   control-plane.mdx:9` separately proposing `@claxedo/control-plane` as a *future* rename for
   the same package — if the drop-stutter scheme is chosen, `@claxedo/server` becomes the
   *interim* name before a later, separate rename to `@claxedo/control-plane`; confirm this
   two-step naming path is intended rather than jumping straight to `@claxedo/control-plane`
   inside WP-D4 itself (WP-D4's LLD text describes only a scope swap, not the "thin wrapper
   with explicit stable exports" restructuring the docs describe for `control-plane` — that
   restructuring is out of scope here).

Everything else is low-risk and mechanical: zero npm-registry consequences (§3, all 4
packages private), a fully enumerated and small reference surface (54 total literal
occurrences across §2a-d, only ~24 of which are functional code/config — the rest are
lockfile/docs), exactly one cross-package `workspace:` dependency edge to update
(`claxedo-desktop` → `claxedo-app`), and no CI workflow, Dockerfile, or `fly.toml` references
found anywhere (`grep -rln "opencode-ai/claxedo" .github` returned empty). The primary
execution risk is entirely about *not* touching the 18 vendored-engine identifiers and the 2
near-collision strings (`@opencode-ai/app`, `@opencode-ai/app-shared`) — a worker using
exact-string (not prefix/substring) matching on all four target specifiers, per the recipe in
§5, avoids this by construction.
