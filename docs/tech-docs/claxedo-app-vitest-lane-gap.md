# The `claxedo-app` vitest lane

Status: **closed**, 2026-08-09. The lane is green and gated. This records what
was wrong and how it is wired, so the gap does not reopen quietly.

## The two runners

`packages/claxedo-app` has two test runners, and both now run in CI:

| runner | glob | how it reaches CI |
|---|---|---|
| `bun test --conditions=browser --preload ./happydom.ts ./src` | `*.test.ts(x)` | `@claxedo/app`'s `test` script → `bun turbo test` |
| `vitest run --config vitest.config.ts` | `*.vitest.ts(x)` | same script, second command |

Both are one `test` script, chained with `&&`, so a failure in either fails the
package task. Each writes its own JUnit report — `.artifacts/unit/junit.xml` and
`.artifacts/unit/junit-vitest.xml` — and `.github/workflows/test.yml` publishes
both through a `junit*.xml` glob. Deliberately **not** a separate workflow step
and **never** `continue-on-error`: folding it into the package's own script is
what makes a newly added `.vitest.tsx` gated the day it lands.

## What the gap was

The vitest lane collects **107 files / 868 tests**, and until 2026-08-09 exactly
four of them reached CI, incidentally, because two other scripts named them by
path (`test:diagnostics-release`, `test:performance`). Roughly 100 Solid
component test files — the ones that actually render the workbench rail, the
process panel, the files navigator and the document editor — had never executed
on a pull request.

It stayed unwired because it was red: 9 files, 51 tests. Those 51 turned out to
be **five** distinct causes, not fifty-one:

1. **`vi.mock("@opencode-ai/ui/icon", …)` replaced the whole module** in four
   files (35 failures). `@/ui/icons/config` re-exports `iconLibrary` from it and
   `ClaxedoIcon` reads that signal, so every render reaching a Claxedo glyph
   threw. Fixed with `importOriginal` partial mocks.
2. **Stale glyph ids** (2 failures). `5197e0704` re-pointed `changes` from
   `codex-20-120` to `codex-20-071` — the boxed ± it shares with `review` — and
   two tests still pinned the old id.
3. **No router around `RailSidebar`** (6 failures). It renders
   `GlobalNavigation`, which reads `useLocation()`. Fixed by wrapping the
   harness in `MemoryRouter`/`Route`, matching `global-navigation.vitest.tsx`.
   A seventh failure in the same file pinned `#opencode-icon-warning`, which
   stopped being the rendered glyph when codex became the default library.
4. **jsdom has no `Element.prototype.scrollTo`** (3 unhandled errors + 5
   failures). `@opencode-ai/ui/list` calls it from a reactive effect, where the
   miss fails the whole file. The stub now lives in `vitest.setup.ts`; three
   test files had each carried their own copy.
5. **Assertions written against surfaces the product had removed** (5
   failures) — a "New document" button that had become a project picker
   (`createInProject`), per-agent terminal shortcuts removed by `73d56ab29`, and
   a per-row document status control removed in favour of the Status filter.
   Re-pointed at the live surfaces.

One of the 51 was a genuine **product defect**, not a harness gap:
`PageIndex`'s `createInProject` had no disposal guard, so a create still in
flight when the index closed would call `props.onOpenPage` and drop a document
tab on a surface the user had already left. Fixed in `document-index.tsx`.

## Known remaining gap

`tsconfig.json` excludes `src/**/*.vitest.ts(x)`, so these files are never
typechecked — `tsgo -b` passing says nothing about them. They are only validated
by running them.

## Related

`packages/claxedo-local-server/src/architecture/local-closure.test.ts` drives
its closure from a hardcoded 13-entry `PRODUCERS` array rather than the
package's declared entry surface. A producer added without editing that array is
not measured, and its assertions stay vacuously green for it — the same shape of
problem one layer down. Still open.
