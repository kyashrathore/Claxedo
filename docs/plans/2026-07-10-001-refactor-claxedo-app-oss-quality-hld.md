# Claxedo App OSS-Quality Refactor — HLD (Leader Plan)

Date: 2026-07-10
Status: proposed
Scope: `packages/claxedo-app` only
Companion docs:
- LLD worker packages: `2026-07-10-002-refactor-claxedo-app-oss-quality-lld.md`
- Full audit findings (evidence for every claim here): `2026-07-10-003-claxedo-app-audit-findings-appendix.md`

This is the "leader knowledge" document: what is wrong at bird's-eye level, what the
target state is, and in what order the worker packages in the LLD must execute.
A leader agent orchestrating Sonnet workers should read THIS doc + the relevant LLD
work packages; workers read only their own work package + the appendix section it cites.

## 1. Objective

`claxedo-app` will be open-sourced and must withstand heavy external contribution
(forks, embedders, many PRs). It is a hard fork of OpenCode's web UI adapted for:
terminal as a first-class tab, multipane/split workspaces, cloud hosting, multiple
simultaneous server/workspace connections, multi-harness agents, and powering the
Electron desktop app.

Refactor goals, in priority order:
1. **Stability** — the riskiest stateful code (terminal, SSE engines, session controller) is tested and decomposed.
2. **Web + mobile responsiveness** — genuinely usable on a phone, not merely non-broken.
3. **Accessibility** — keyboard-only and screen-reader operable.
4. **Electron** — desktop glue is a tested, explicit seam, not scattered assumptions.
5. **Tests as specs** — the test suite alone should let an AI agent rebuild the app in another language.

## 2. State of the codebase (audit scorecard)

18-agent parallel audit, 2026-07-10. Health and spec-grade are /10.

| Scope | Health | Spec-grade | Headline |
|---|---|---|---|
| architecture & build | 6 | 6 | Mature guard suite, but no directional layering; session logic has 4 plausible homes |
| tests-as-specs | 7 | 7 | Best files genuinely meet the bar; ~49 files are grep-the-source anti-pattern |
| accessibility | 4 | 2 | Design-system layer solid; bespoke flagship widgets bypass it; zero automated a11y tests |
| responsiveness | 4 | 3 | Patchy mobile engineering; the two signature features (multipane, terminal) have no touch/narrow strategy |
| naming & vocabulary | 5 | 5 | "workspace" has five meanings; product packages still `@opencode-ai`-scoped |
| ui-components | 6 | 5 | Bimodal: well-factored pure modules next to 1000-line untested god dialogs |
| ui-layout | 5 | 5 | Excellent layout engine; 2684-line rail-sidebar; a 1186-line test testing a hand-copied shadow copy |
| ui-state | 6 | 4 | Disciplined slices, but the harness-config test suite is grep-the-source; two singleton Maps leak outside the store (one unbounded) |
| ui-misc | 6 | 8 | Strong tests; fork-era duplication never consolidated |
| components | 5 | 4 | terminal.tsx (1194 lines, zero tests) is the single riskiest file in the app |
| shell | 6 | 7 | Most disciplined layer; mechanical alias/duplication debt |
| context | 6 | 6 | Two god files; dead upstream-compat types; grep-tests |
| terminal | 6 | 6 | Well-engineered core; one 907-line helpers.ts god file; a11y hardcoded off |
| utils-shared | 5 | 4 | Ungoverned 68-file dumping ground; 3220-line architecture linter disguised as a unit test |
| pages | 5 | 4 | session.tsx + message-timeline.tsx: 3272 combined lines, zero direct tests, logic duplicated between them |
| session | 6 | 5 | Good decision-logic layer; 1079-line controller; `@claxedo/session-client` is a fake boundary |
| platform | 6 | 5 | Good new native code; stale docs; migration-frozen guard tests |
| i18n | 6 | 1 | Mostly data; zero parity tooling; 36 keys missing from every non-English locale |

**The overall diagnosis is bimodal.** Everywhere someone deliberately extracted pure,
dependency-injected modules with 1:1 behavior tests (layout engine, submit dispatch,
terminal stream core, shell identity), the code already meets the bar — those files are
the pattern to replicate. Everywhere code stayed imperative/effectful (god components,
SSE engines, dialogs), it is untested and duplicated. This refactor is not a rewrite:
it is applying the codebase's own best pattern to its remaining worst files.

## 3. The eight systemic problems

### P1 — Vocabulary chaos (worst single contributor tax)
"workspace" means five different things (directory path, control-plane id,
toolSandbox kind, worktree map, "server we connect to"). pane/tab/panel/group are four
words for view surfaces (`ProcessPanePanel.tsx` fuses two). The runner→harness rename
finished in source but not in tests. `opencode` (lowercase) carries three meanings.
Product packages are still `@opencode-ai/*`-scoped while internal ones are `@claxedo/*`.
The `claxedo-` prefix stutters (`claxedo-ui/claxedo-layout-actions`).
**Fix direction:** canonical `VOCABULARY.md` glossary; disambiguate the directory-path
vs control-plane-id senses of workspaceId; targeted renames; a guard against retired
terms creeping back.

### P2 — No directional layering / unclear directory ownership
`context/` ↔ `shell/` import each other's internals. `components/` and
`claxedo-ui/components/` (same name, different layers) mutually import with no
documented charter. Session logic has four plausible homes (`session/`,
`session-client/`, `shell/session`, `shell/chat`). `layout/` vs `layouts/` differ by
one letter. `utils/` is a 68-file, 4-tier dumping ground. `providers/`, `hooks/`,
`constants/`, `analytics/` are single-file top-level dirs with no policy.
The existing `src/architecture` guard suite catches orphans and size growth but not
import direction — the cycles are structurally invisible to CI today.
**Fix direction:** per-directory charters (`ARCHITECTURE.md` + per-dir `AGENTS.md`),
a directed import-layering guard in `src/architecture`, then incremental migration
(session consolidation, utils dissolution) — additive first, delete after consumers move.

### P3 — God files (11 files > 750 lines, all in the hot paths)
rail-sidebar.tsx 2684 · message-timeline.tsx 1725 · session.tsx 1547 · terminal.tsx 1194
· session-controller.ts 1079 · marketplace-panel.tsx 1074 · dialog-process-diagnostics.tsx 1050
· context/layout.tsx 964 · terminal/helpers.ts 907 · context/global-sdk.tsx 870 · titlebar.tsx 777.
These are exactly where a first-time contributor lands (layout, chat, terminal), and
several are the sole owners of domain types (rail-sidebar.tsx exports the domain types
the whole actions layer imports — a dependency inversion).
**Fix direction:** the codebase's own proven pattern — extract pure decision logic into
tested modules, split rendering into single-purpose components, keep public surface stable.

### P4 — Fork-era duplication ("which copy do I edit?")
Three copy-pasted portal-slot singletons; two independently-maintained submit-directory
resolvers; title-edit/archive/prompt-preview logic implemented 2–3× across
session.tsx / message-timeline.tsx / session-composer-region.tsx; four duplicate-name
function pairs inside the one file designated as the canonical legacy resolver;
URL normalization reimplemented in 5+ files; `LocalProject` declared twice with
different shapes; two near-identical create-cloud-workspace dialogs; a dead byte-for-byte
duplicate of `shared/query/project-meta.ts`; a dead duplicated OSC 10/11 code path in
the terminal backend.
**Fix direction:** one canonical owner per behavior, delete the losers, and where two
copies must temporarily coexist, a test that fails when they drift.

### P5 — Grep-as-test anti-pattern (~49 files) + shadow-implementation tests
Tests that read the source file's raw text and assert `.toContain(...)`, tests that
re-implement the production function and test the copy (`workspace-project-integrity.test.ts`,
1186 lines, cites a source file that no longer exists; `slash-commands.test.ts`;
`page-index.test.ts`'s optimistic-mutations block), a 3220-line whole-repo architecture
linter living in `utils/` as a "unit test", and migration-completion guard tests frozen
at internal milestones (P5 composer, ModelKey). These inflate test counts while
specifying nothing.
**Fix direction:** boundary rules move to `src/architecture/scanners.ts` (the correct,
already-excellent home); every displaced feature test is rewritten as a behavior spec
or deleted; the tests-as-specs standard (§5) becomes the merge bar.

### P6 — Accessibility debt concentrated in flagship widgets
The Kobalte-based design-system layer is genuinely accessible. But: prompt-input
@-mention/slash popovers have no combobox/listbox ARIA (a screen-reader user cannot
tell they opened); the terminal hardcodes `screenReaderMode: false` with no toggle;
split-pane and workspace-panel resize are pointer-only; sidebar rows are hand-rolled
`div role="button"`; keyboard shortcuts are split across 3+ uncoordinated systems
(two of which both bind mod+w and mod+alt+Arrow — also a correctness bug); zero
automated a11y testing.
**Fix direction:** ARIA-pattern the bespoke widgets, consolidate shortcuts onto the
command registry, wire `@xterm/addon-a11y`, add an axe-core sweep to Playwright.

### P7 — Mobile is structurally absent for the two signature features
All pane/tab/session reordering uses native HTML5 drag-and-drop, which does not fire
on touch devices at all. The multipane workbench has no narrow-viewport collapse
strategy. The terminal has no accessory key row for soft keyboards. Breakpoints are ad
hoc (420/639/767/900/1200px alongside Tailwind's scale). Not one Playwright spec sets
a mobile viewport, so none of this can be guarded.
**Fix direction:** mobile Playwright project first (make the gap measurable), then
touch-capable reorder affordance, workbench collapse mode, terminal accessory row,
one breakpoint token set.

### P8 — Dead code and stale docs that actively misdirect
`src/overrides/README.md` documents an override system that no longer exists post-hard-fork.
Five `utils/` files with zero importers; `debug-bar.tsx` (443 lines, unreferenced);
dead `SwitcherKind` variants from a deleted feature; most of `cloud-strings.ts`;
stale `dist-desktop`/`dist-opencode` targets no script produces; an orphaned `uk`
locale key; upstream feedback/docs links still pointing at opencode.ai.
**Fix direction:** delete first (it's the cheapest wave), rewrite the two stale READMEs.

## 4. Target vocabulary (canonical glossary seed)

To be published as `packages/claxedo-app/src/VOCABULARY.md` by WP-01 and enforced going
forward. Canonical implementations in parentheses.

- **session / sessionId** — the root identity key of everything (`shell/identity/session-ref.ts`).
- **host** — where the agent process runs. **toolSandbox** — where its tools execute. (`session-ref.ts`; `runnerHost` is retired, one documented compat site in `utils/session-url.ts`.)
- **harness** — the agent runtime flavor (claude/codex/opencode/...). One kind-enum, one source of truth (today drifted across 3 files — WP-B5 fixes).
- **workspace** — a server the app connects to, identified by an opaque control-plane `workspaceId`. NEVER a directory path.
- **directory** — a filesystem path scoping sessions/tools. UI code that today calls a directory a "workspace(Id)" migrates to `activeDirectory`/`directoryRef`.
- **project** — user-facing grouping in the rail (one `LocalProject` type, one owner).
- **pane** — a split region of the workbench. **tab** — a selectable surface within a pane. **panel** — a docked auxiliary surface (workspace panel). "group" reserved for session groups only. No fused names (`ProcessPanePanel` → `ProcessPanel`).
- **conversation** — the message timeline of a session (`shell/chat`).
- **opencode** — allowed ONLY for (a) the vendored engine protocol/compat surfaces, (b) the upstream product in prose. Never for Claxedo UI concepts, storage keys, DOM ids, or user-visible strings.

## 5. The tests-as-specs standard (merge bar)

Published to CONTRIBUTING.md/AGENTS.md by WP-01. Distilled from the suite's own best
files (`session-ref.test.ts`, `submit/dispatch.test.ts`, `terminal-focus-switch.test.ts`,
the lettered `layout/tests/A..N` suite):

- **Runners:** `<subject>.test.ts` (bun:test) for pure logic; `<subject>.vitest.tsx`
  (vitest + @solidjs/testing-library) ONLY when the assertion needs a real Solid
  mount/reactive timing/keyboard/aria. Never mix runner imports in one file.
- **Names are contract sentences:** `<input/state> → <output/effect> when <condition>`.
  Bad: "works", "handles edge case". Good: "demo path returns the reply via onDemoReply
  and never calls promptAsync".
- **Body shape:** construct concrete input → invoke the exported function / mounted
  component → assert concrete end-state. One assertion cluster per test. (Numbered
  user-journey suites like `K-journeys.test.ts` are a sanctioned, labeled exception.)
- **Assert real values:** `toEqual`/`toMatchObject` against literal expected objects,
  DOM attributes, or ordered side-effect calls WITH payloads. Never bare
  "was called N times".
- **Mock only true I/O boundaries** (fetch, SDK client, timers/rAF, storage), injected
  as parameters. Never mock the unit under test or a pure in-repo collaborator.
- **Never** assert against a source file's raw text (`Bun.file(...).text()` +
  `.toContain`). Boundary rules belong in `src/architecture/scanners.ts` with a named
  rule and baseline.
- **The falsifiability test:** could an agent holding only this test file re-implement
  the feature in another language? If the test would pass against a hand-copied shadow
  implementation, it is not a test.

## 6. Execution strategy — waves

Workers are Sonnet agents run via workflows. **Within a wave, work packages have
disjoint file ownership and run in parallel. Waves are barriers.** Every WP ends with:
focused tests green, `bun run typecheck` green from `packages/claxedo-app`, and a
one-paragraph evidence report (per repo AGENTS.md). Browser/E2E verification where the
WP touches routing, layout, chat, or visuals.

- **Wave 0 — Foundations (do first, small, serial-friendly):**
  WP-01 vocabulary + charters + tests-as-specs standard docs;
  WP-02 architecture guards (import-layering/cycle rule, retired-term guard, manifest
  renames, unfreeze migration guard tests);
  WP-03 test infrastructure (mobile Playwright project, axe-core sweep, dual-runner
  docs, shared mock-api fixture).
  *Rationale: everything later is judged against these bars, and the guards prevent
  regression while 10+ workers land parallel changes.*

- **Wave 1 — Mechanical cleanup (highly parallel, low risk):**
  dead-code sweep (WP-A1), shell alias-pair collapse (WP-A2), page-editor file renames
  (WP-A3), portal-slot unification (WP-A4), terminal-fit event centralization (WP-A5),
  i18n parity tooling + dead keys (WP-A6), shared-helper dedup (WP-A7), fork-legacy
  strings/links (WP-A8).

- **Wave 2 — Directory deep refactors (the bulk; one WP per directory, disjoint):**
  WP-B1 claxedo-ui/components · WP-B2 claxedo-ui layout+layouts · WP-B3 claxedo-ui misc
  · WP-B4 components/ · WP-B5 shell/ · WP-B6 context/ · WP-B7 terminal/ · WP-B8 pages/
  · WP-B9 session/ · WP-B10 platform dirs · WP-B11 ui-state (pending re-audit).
  Each: split god files by extracting pure tested modules, dedup against the canonical
  owner, replace grep-tests with behavior specs, close the named test gaps.

- **Wave 3 — Product-goal features (needs Wave 2's decomposed surfaces):**
  WP-C1 accessibility remediation; WP-C2 keyboard-shortcut consolidation onto the
  command registry; WP-C3 responsive/mobile (touch reorder, workbench collapse,
  terminal accessory row, breakpoint tokens).

- **Wave 4 — Structural migrations (serialize; each is a repo-wide rename risk):**
  WP-D1 session-domain consolidation (one home for session logic);
  WP-D2 real `session-client` boundary (alias + enforced import rule);
  WP-D3 utils/ dissolution; WP-D4 package scope `@opencode-ai/*` → `@claxedo/*`
  (coordinates outside claxedo-app); WP-D5 workspace-vs-directory identifier
  disambiguation (ties into the known directory-string-routing debt; see
  `project_session_placement_debt` memory / plan `2026-07-09-001`).

## 7. Global Definition of Done

1. No file > 700 lines without a documented allowlist entry that shrinks monotonically
   (existing debt-ratchet pattern).
2. Zero grep-the-source assertions outside `src/architecture/`.
3. Import-layering guard green: no `context/`↔`shell/` or `components/`↔`claxedo-ui/`
   cycles; `session-client` imports nothing from `pane/`, `shell/`, `claxedo-ui/`, root `context/`.
4. Every WP's named test gaps closed with spec-grade tests (standard §5).
5. Mobile Playwright project + axe sweep exist and pass; the sidebar drawer,
   workspace panel, and chat scroll work at 375×812.
6. `VOCABULARY.md` terms are the only names for their concepts in new code; retired-term
   guard green.
7. All audits' `critical` and `high` findings resolved or explicitly waived in the LLD.
8. Full package verification green: typecheck, targeted test files (full local vitest
   suite is known to hang — run targeted lists per repo memory), demo build, and an
   Electron smoke (app boots, terminal opens, session sends).

## 8. Risks / don't-regress

- **Don't rewrite; extract.** The working app is the spec. Public component surfaces
  stay stable within a WP; behavior-identical refactors only, except where a finding
  names a bug (double-bound shortcuts, harness-kind unchecked cast).
- **Two keyboard systems both bind mod+w** — reconciling them changes behavior;
  needs an explicit decision on which semantics win (WP-B2/WP-C2).
- **Terminal is perf-critical** (see perf-harness memory). Any terminal/ or
  components/terminal.tsx change runs the frame-first perf harness before merge.
- **`architecture/` ratchets must not be loosened silently** — baselines only shrink.
- **Vendored-package CSS overrides** (`claxedo-ui/styles.css` selector monkey-patching)
  break silently on upstream rebuilds — replace, don't extend, when touched.
- **Sequencing hazard:** Wave 4 renames (packages scope, workspace/directory) conflict
  with everything — they go last and land solo.
