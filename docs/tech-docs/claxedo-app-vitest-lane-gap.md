# The `claxedo-app` vitest lane does not run in CI

Status: **open finding**, measured 2026-08-08. Nothing is being suppressed; this
records a gap so it stops being invisible.

## What is not running

`packages/claxedo-app` has two test runners:

| runner | glob | in CI? |
|---|---|---|
| `bun test --conditions=browser --preload ./happydom.ts ./src` | `*.test.ts(x)` | yes — `.github/workflows/test.yml` via `bun turbo test` |
| `vitest run --config vitest.config.ts` | `*.vitest.ts(x)` | **no** |

The vitest lane collects **107 files / 868 tests**. Exactly **four** reach CI,
and only incidentally, because two other scripts name them by path:

- `test.yml` → `test:diagnostics-release` names `dialog-process-diagnostics.vitest.tsx`
- `typecheck.yml` → `@claxedo/app#typecheck` → `test:performance` names
  `directory-scope.vitest.tsx`, `F-mount-retention.vitest.tsx`,
  `N-reactivity.vitest.tsx`

`grep -rn "vitest" .github/workflows/` returns one hit, and it is a
claxedo-server release-script test. So **roughly 100 Solid component test files
have never executed in CI.**

These are the files that render components. The `bun test` lane covers logic and
architecture; the rendering behaviour of the workbench rail, the process panel,
the files navigator and the document editor is only covered here.

## Why it has not simply been wired

The lane is **red**: 9 files, 51 tests failing.

```
features/processes/ui/workspace-panel/process-pane-panel.vitest.tsx          17
app/workbench/rail/rail-sidebar-disclosure.vitest.tsx                         7
features/processes/ui/workspace-panel/workspace-processes-navigator.vitest.tsx 7
features/session/ui/components/session-status-stage.vitest.tsx                6
app/workbench/workspace-panel/files-navigator.vitest.tsx                      5
features/documents/editor/document-index.vitest.tsx                           5
app/workbench/rail/rail-workspace-tools.vitest.tsx                            2
ui/controls/claxedo-icon.vitest.tsx                                           1
app/workbench/workspace-panel/workspace-tool-buttons.vitest.tsx               1
```

The failures are `iconLibrary` mock gaps, a router `invariant`, an icon sprite,
and `scroll.scrollTo` — test-harness problems, not product defects, as far as
anyone has looked. That is a guess until someone reads them.

## Why this is worse than a red lane

A red lane is visible. A lane nobody runs is not: the 51 failures have been
treated as a "known baseline" by every change that touched this package,
including all of the local/cloud split work, and nothing distinguishes those 51
from a 52nd introduced yesterday.

## What to do, in order

1. **Fix the 51.** They are the reason the lane cannot be wired, and they are
   almost certainly four or five harness fixes rather than fifty-one.
2. **Then wire it** — a `test:vitest` step in `test.yml`, or fold it into the
   package's `test` script so `bun turbo test` picks it up automatically like
   every other package.
3. Do **not** wire it first with `continue-on-error`. That produces a lane that
   is green when it fails, which is how this gap started.

## Related

`packages/claxedo-local-server/src/architecture/local-closure.test.ts` drives
its closure from a hardcoded 13-entry `PRODUCERS` array rather than the
package's declared entry surface. A producer added without editing that array is
not measured, and its assertions stay vacuously green for it — the same shape of
problem one layer down.
