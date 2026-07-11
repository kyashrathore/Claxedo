# Contributing to Claxedo App

`packages/claxedo-app` is a hard fork (single-commit history reset
`00a533c2fb`) of OpenCode's web UI. **There is no `packages/app` in this
monorepo and no upstream override system** — an earlier revision of this
file described a `packages/app` + override-scanner setup that predates the
fork and no longer exists (verified: `ls packages/` at the repo root has no
`app`; see "History: the override system" below for the full verification).
All Claxedo-owned code lives directly under `packages/claxedo-app/src/**`;
`@/...` and `@claxedo/...` both resolve to `./src/*` (`tsconfig.json:21-25`)
and are interchangeable — there is no "overridden vs. upstream" import
distinction to get right.

See `src/ARCHITECTURE.md` for directory charters and import rules, and
`src/VOCABULARY.md` for the canonical noun list (read this before naming
anything "workspace" — it has five different meanings in this codebase
today, see that file's first section).

## Scope

Contribute to Claxedo for:

- cloud features
- authentication and account flows
- Claxedo-specific UI (terminal, multipane workbench, session chrome)
- Electron desktop integration
- remote access and workspace orchestration

## Development

### Web

```bash
cd packages/claxedo-app
bun run dev
```

### Desktop

```bash
cd packages/claxedo-desktop
bun run dev
```

The Electron renderer source lives in `packages/claxedo-desktop/src/renderer`.

## Adding first-party code

1. Put Claxedo-owned files under `packages/claxedo-app/src/**`, in the
   directory whose charter (`src/ARCHITECTURE.md`) matches what you're
   adding.
2. There is no `src/overrides` directory and no override-resolution scanner
   to hook into; put the file directly at its real charter'd location (see
   "History: the override system" below if you find stale docs elsewhere
   still describing one).
3. Use the vocabulary in `src/VOCABULARY.md` for session/host/toolSandbox/
   harness/workspace/directory/project/pane/tab/panel/group. Do not
   introduce a new sense of "workspace" or reintroduce "runner"/"runnerHost"
   outside the one documented compat site (`src/utils/session-url.ts`).

## History: the override system

`src/overrides/` used to exist as a tombstone directory (no production
`.ts`/`.tsx` files, `README.md` only) documenting a retired pre-fork
mechanism. This section preserves that history now that the directory itself
has been deleted (it added nothing beyond this explanation).

Before the hard fork (commit `00a533c2fb`, see the `project_hardfork_completion`
project memory), Claxedo was layered on top of a separate `packages/app`
package that vendored upstream OpenCode's web UI. `src/overrides/` used to
hold first-party replacement files for individual upstream `@/...` modules,
resolved by a dynamic override-scanning system, and its README used to
document each mapped override plus a `@opencode-ai/app` vs
`@opencode-ai/claxedo-app` import-resolution contract.

**That system no longer exists.** Verified at the time of the README's last
rewrite:

- `packages/app` does not exist anywhere in this monorepo (`ls packages/` at
  the repo root lists `claxedo-app`, `claxedo-server`, `claxedo-desktop`,
  `claxedo-web`, and the `@claxedo/*` internal packages — no `app`).
- `tsconfig.json`'s path map resolves **both** `"@/*"` and `"@claxedo/*"` to
  `["./src/*"]` (`packages/claxedo-app/tsconfig.json:21-25`) — there is no
  fallback to any `packages/app/src/*` location, and never a distinction
  between "overridden" vs "upstream" import paths.
- `vite.cloud.config.ts` aliases `@claxedo/` and `@/` to this package's own
  `./src/` directory directly (post-divorce plan 006).
- `packages/claxedo-desktop/vite.renderer.ts` states explicitly:
  "Post-divorce (plan 006): the renderer resolves `@/` against claxedo-app,
  not packages/app."

In other words: every module this app imports via `@/...` or `@claxedo/...`
resolves directly into `packages/claxedo-app/src/**`. There is nothing left
to "override" — the entire app is first-party, single-source-of-truth source
code. There is no more upstream-diffing workflow
(`git diff upstream/dev -- packages/app/src/...`) — that command no longer
has a target.

If you are trying to change behavior that used to live in an "override" per
old documentation you found elsewhere (an old `CONTRIBUTING.md` revision, or
a two-level "App scope vs Directory scope" context architecture, or a
`@opencode-ai/app` vs `@opencode-ai/claxedo-app` import distinction), that
behavior is not overridden anymore — it is simply implemented directly at
`src/app.tsx`, `src/pages/layout.tsx`, `src/context/global-sync.tsx`, and so
on. Edit those files directly, and use plain `@/...` or `@claxedo/...`
imports (they are equivalent, both resolve to `./src/*`) — there is no
"wrong" scope to accidentally import from anymore.

## Writing tests: the tests-as-specs standard

This is the merge bar for every test file in `packages/claxedo-app`. It is
distilled from the suite's own best files
(`src/shell/identity/session-ref.test.ts`,
`src/session/submit/dispatch.test.ts`,
`src/terminal/integration/terminal-focus-switch.test.ts`, the lettered
`src/claxedo-ui/workbench/tests/A..N` suite).

**Runners — one file, one runner, never mixed:**
- `<subject>.test.ts` — **bun:test**, the default. Use for pure logic with
  no real DOM. Run via `bun run test` (never `bun test ./src` directly — the
  `--conditions=browser` flag in the npm script is load-bearing for SolidJS;
  without it `createEffect` becomes a no-op and `createMemo` evaluates only
  once, silently producing wrong test results).
- `<subject>.vitest.tsx` / `<subject>.vitest.ts` — **vitest** +
  `@solidjs/testing-library`, used ONLY when the assertion needs a real Solid
  mount, reactive timing, keyboard interaction, or ARIA state that bun:test's
  environment can't exercise. Run via `bun run test:ui`.
- Never `import` from `bun:test` and `vitest` in the same file.

**Test names are contract sentences:** `<input/state> → <output/effect> when
<condition>`.
Bad: `"works"`, `"handles edge case"`.
Good (from `src/components/prompt-input/submit.test.ts`'s style): `"demo
path returns the reply via onDemoReply and never calls promptAsync"`.

**Body shape:** construct concrete input → invoke the exported function or
mounted component → assert concrete end-state. One assertion cluster per
test. (Numbered user-journey suites like a `K-journeys.test.ts` style file
are a sanctioned, explicitly-labeled exception — not a template for
everything else.)

**Assert real values:** `toEqual`/`toMatchObject` against literal expected
objects, DOM attributes, or ordered side-effect calls WITH their payloads.
Never bare "was called N times" with no payload/ordering check.

**Mock only true I/O boundaries** — fetch, SDK client, timers/rAF, storage —
injected as parameters (see `terminal/integration/terminal-focus-switch.test.ts`'s
injected `requestFrame`/`write`/`onOverload`, or
`components/dialogs/select-mcp.test.tsx`'s `fakeFetch`). Never mock the unit
under test or a pure in-repo collaborator.

**Never assert against a source file's raw text**
(`Bun.file(new URL(...)).text()` + `.toContain`/`.not.toContain`). This
pattern exists in ~49 files today as tracked debt — it is not a model to
copy. Boundary/import-graph/retired-vocabulary rules belong in
`src/architecture/scanners.ts` with a named rule and an allowlist/baseline,
where they are centrally tracked — not scattered per feature test file.

**The falsifiability test:** could an agent holding only this test file
re-implement the feature in another language? If the test would pass against
a hand-copied shadow re-implementation of the function under test, it is not
a test — it must import and exercise the real production export (as
`context/layout-projects.test.ts` does, importing the real
`projectCatalog`/`canAutoOpenProject` from `context/layout-projects`, and
`claxedo-ui/utils/workspace-display.test.ts` /
`claxedo-ui/rail/rail-git-remote.test.ts` do for the workspace-name and
owner/repo derivations, rather than a hand-maintained copy). A test that
re-declares the logic it claims to verify tests nothing; do not do that. The
former `claxedo-ui/rail/workspace-project-integrity.test.ts` was exactly this
anti-pattern — a 1186-line hand-copied shadow that had already drifted from the
shipped logic (it derived the project label from `sessions[].git.remote`, while
production reads `workspaces[].repo_url`) — and was deleted once every genuine
invariant it specified moved to a real-import spec beside its subject.

### Template: pure-logic spec (default — bun:test)

```ts
import { describe, expect, test } from "bun:test"
import { subjectFn } from "./subject"

// One sentence: what real-world behavior this module owns and why.

describe("subjectFn", () => {
  test("<input/state> produces <output> when <condition>", () => {
    const result = subjectFn(/* concrete literal input */)
    expect(result).toEqual(/* concrete literal expected output */)
  })

  test("<edge case> is handled by returning <edge output>", () => {
    expect(subjectFn(/* edge input */)).toEqual(/* edge output */)
  })

  test("<error condition> rejects with <message>", async () => {
    await expect(subjectFn(/* bad input */)).rejects.toThrow("<message>")
  })
})
```

### Template: real-DOM spec (only when Solid reactivity/mount/keyboard/aria matters — vitest)

```tsx
import { afterEach, describe, expect, test } from "vitest"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { Component } from "./component"

afterEach(cleanup)

describe("Component", () => {
  test("renders <role> labelled <name> and updates aria state on <interaction>", () => {
    const { getByRole } = render(() => <Component />)
    const el = getByRole("button", { name: "Close workspace panel" })
    fireEvent.click(el)
    expect(el.getAttribute("aria-pressed")).toBe("true")
  })
})
```

## Where a test file lives

The convention is **colocation everywhere**: `<subject>.test.ts` or
`<subject>.vitest.tsx` sits next to `<subject>.ts`/`.tsx` as a direct
sibling. This holds for roughly 94% of the 340+ test files in the package
(343 as of this writing: `find src -name "*.test.ts" -o -name "*.test.tsx"
-o -name "*.vitest.ts" -o -name "*.vitest.tsx"`, a number that changes with
every PR — treat it as approximate) — if you're adding a test for a file,
put it right next to that file.

**Suffix taxonomy** (the suffix tells you the runner and the test's role —
keep it accurate):
- `.test.ts` — bun:test, pure logic. The default.
- `.vitest.ts` / `.vitest.tsx` — vitest, needs a real DOM mount/reactive
  timing/keyboard/aria.
- Qualifier segments before the runner suffix narrow the test's scope, e.g.
  `.integration.test.ts` (drives a real, wider pipeline end-to-end —
  use a dot before "integration", not a hyphen, so a `**/*.integration.test.ts`
  glob finds it) or `.bugs.vitest.tsx` (regression tests narrating a specific
  race condition or bug, e.g. `compact-switcher.bugs.vitest.tsx`).
- `.live.spec.ts` — Playwright specs that require live credentials and are
  excluded from the default e2e run (see `e2e/playwright/`, not owned by
  this package's WP).

**Sanctioned exceptions to colocation** (do not add a third without
documenting it here):
- `src/architecture/*.guard.test.ts` — these test repo-wide invariants (
  import graph, file sizes, single-writer cache ownership) with no single
  subject file, so there is nothing to colocate next to. This is the
  correct home for boundary/source-text-shaped checks — see "never assert
  against a source file's raw text" above.
- Per-feature ordered spec suites that document a cross-file behavioral
  sequence, e.g. `src/claxedo-ui/workbench/tests/` (renamed from the old
  `claxedo-ui/layout/tests/` in Wave 1.5; currently lettered A–N; the letters
  themselves are a known naming defect being cleaned up — the *pattern* of a
  dedicated ordered-suite folder for a workbench-engine-wide behavior is
  sanctioned, opaque lettering is not).

**Known, not-yet-fixed violations** (do not copy these; they are tracked
debt per the org-review appendix, not conventions):
`src/extensions/server.test.ts` imports from `vitest` despite
the `.test.ts` (bun:test-signaling) suffix. (Wave 1.5 fixed several formerly
listed here: the `claxedo-ui/state/tests/` subfolder was flattened;
`review-mount-retention.vitest.tsx` moved to `shell/review/` alongside its
`review-region-policy` subject; and `navigation-islands/session-navigation`'s
test was renamed to the `.vitest.ts` suffix that matches its runner. Wave 2
deleted `claxedo-ui/rail/workspace-project-integrity.test.ts` — a mislocated
hand-copied shadow whose subject lived in `context/layout-projects` — moving
every real invariant it specified to a real-import spec beside its subject.)

**Shared test fakes:** `src/utils/test-support/` is the sanctioned location
for fakes reused by 2+ unrelated test suites. It now exists (created per LLD
WP-03) and holds `mock-api.ts` (with its own `mock-api.test.ts`), intended to
replace the hand-copied `mock.module("./api")` boilerplate duplicated across
`src/utils/api.test.ts`, `living-apps-api.test.ts`, `pages-api.test.ts`, and
`persist.test.ts` — note those callers have not all been migrated onto it yet.
Do not create a locally-scoped test-support module for something only one
suite uses — keep single-use fakes colocated with their test file.
`test-fixtures/` at the repo root (outside `src/`) is the correct home for
binary/visual Playwright baselines — never put those under `src/`.

## Verification

Run checks from the package directories, not the repo root.

```bash
cd packages/claxedo-app
bun run test          # bun:test — the default suite
bun run test:ui       # vitest — the small DOM-mount subset
bun run typecheck     # includes architecture guards + tsgo + perf budget
bun run build

cd ../claxedo-desktop
bun run build
```

The full `bun run test` suite is known to hang in some local environments;
if it does, run targeted file lists instead (`bun test --conditions=browser
--preload ./happydom.ts ./src/path/to/file.test.ts`) and say so in your PR.

If you change behavior, add or update tests in the affected package,
following the tests-as-specs standard above.

## Before opening a PR

1. Run the relevant web and Electron checks.
2. Verify new/changed vocabulary matches `src/VOCABULARY.md`; verify new
   code respects the directory charters in `src/ARCHITECTURE.md`.
3. Update docs or changelog entries for user-facing changes.
