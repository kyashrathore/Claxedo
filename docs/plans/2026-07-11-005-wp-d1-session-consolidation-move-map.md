# WP-D1 · Session-domain consolidation — move map (READ-ONLY pre-scoping)

**Date:** 2026-07-11 · **Status:** pre-scoping (no source edits, no commits) ·
**Owner-to-be:** WP-D1 (Wave 4, serialize one-at-a-time) · **Gate:** Wave 2 landed.
**Authority chain:** HLD `2026-07-10-001` (home = `src/session/{store,submit,composer,harness,commands}`),
LLD `2026-07-10-002` §Wave 4 WP-D1 (lines 482–485) → WP-D2 (487–490) strictly ordered,
appendix-004 rename maps. All paths below are relative to `packages/claxedo-app/`.

This maps against the **live tree** (Wave 2 uncommitted work included). Every claim
cites `file:line` or a grep/script count. Knots are called out honestly; the
layering verdict is a differential, not a hand-wave.

---

## 0. TL;DR verdict

**GO, with preconditions.** The move is a pure relabel of two subtrees into
`src/session/`. The differential layering analysis (§4) shows **zero new
top-level 2-cycles** — every `X<->session-client` cycle already has a twin
`X<->session` in the baseline, and `session-client<->shell` collapses into the
existing `session<->shell`. The blast radius is **49 files** touching
`session-client/{composer,harness,commands}` + **5 files** touching
`shell/session/**` (54 distinct importer files, 31 of them non-test), moving
**23 non-test + 18 test source files**.

The one genuine subtlety: `src/session-client/index.ts` is **NOT** part of this
move. It is the upstream `@opencode-ai/session-ui` re-export barrel and the
literal thing D2 turns into a "real session-client boundary." It stays put so
`@claxedo/session-client` keeps resolving (§5).

Preconditions: (P1) WP-02 manifest renames landed; (P2) the 4 guard **source
constants** in `src/architecture/*.ts` (§6b) are updated in the SAME commit as
the file moves or the guard suite red-flags; (P3) `import-graph.ts` SPLIT_BARREL
entry repointed; (P4) decide the `shell/session/**` target subdir (§1c — this
map recommends `session/store/`, but it is a judgment call outside the 5 HLD
names).

---

## 1. Full inventory + target paths

### 1a. `src/session-client/composer/**` → `src/session/composer/**`

| current file | importers (excl. internal, §2) | target |
|---|---|---|
| `session-client/composer/composer.tsx` (god file) | 4 | `session/composer/composer.tsx` |
| `session-client/composer/examples.ts` | 2 | `session/composer/examples.ts` |
| `session-client/composer/mode-snapshot.ts` | 1 | `session/composer/mode-snapshot.ts` |
| `session-client/composer/mode.ts` | 7 | `session/composer/mode.ts` |
| `session-client/composer/model-strategy.ts` | 11 | `session/composer/model-strategy.ts` |
| `session-client/composer/prompt-input-props.ts` | 2 | `session/composer/prompt-input-props.ts` |
| `session-client/composer/role-gate.ts` | 2 | `session/composer/role-gate.ts` |
| `session-client/composer/runtime-fallback.ts` | 2 | `session/composer/runtime-fallback.ts` |
| `session-client/composer/signed-workspace-model.ts` | 2 | `session/composer/signed-workspace-model.ts` |
| `session-client/composer/toolbar-state.ts` | 1 | `session/composer/toolbar-state.ts` |
| `session-client/composer/workspace-resolver.ts` | 6 | `session/composer/workspace-resolver.ts` |

Plus co-located tests: `composer-isolation.vitest.tsx`, `mode.test.ts`,
`model-strategy.test.ts`, `role-gate.test.ts`, `signed-workspace-model.test.ts`,
`workspace-resolver.test.ts` → same `session/composer/`.

### 1b. `src/session-client/harness/**` → `src/session/harness/**`

| current file | importers (excl. internal) | target |
|---|---|---|
| `session-client/harness/controller.ts` | 9 | `session/harness/controller.ts` |
| `session-client/harness/options-state.ts` | 2 | `session/harness/options-state.ts` |
| `session-client/harness/prepared-session.ts` | 5 | `session/harness/prepared-session.ts` |
| `session-client/harness/profile.ts` | **27** (largest) | `session/harness/profile.ts` |
| `session-client/harness/selection.ts` | 3 | `session/harness/selection.ts` |
| `session-client/harness/store-policy.ts` | 14 | `session/harness/store-policy.ts` |
| `session-client/harness/store-state.ts` | 9 | `session/harness/store-state.ts` |

Plus tests: `controller.test.ts`, `options-state.test.ts`,
`prepared-session.test.ts`, `profile.test.ts`, `selection.test.ts`,
`store-policy.test.ts`, `store-state.test.ts` → same `session/harness/`.

### 1c. `src/session-client/commands/**` → `src/session/commands/**`

| current file | importers | target |
|---|---|---|
| `session-client/commands/model-selection.ts` | 3 | `session/commands/model-selection.ts` |
| `session-client/commands/prompt-machine.ts` | 2 | `session/commands/prompt-machine.ts` |

Plus tests `model-selection.test.ts`, `prompt-machine.test.ts`.

### 1d. `src/shell/session/**` → **recommend** `src/session/store/**` (judgment call)

| current file | importers (excl. internal) | recommended target | rationale |
|---|---|---|---|
| `shell/session/local-selection-handoff.ts` | 4 | `session/store/local-selection-handoff.ts` | query-cache writer (registered in `query-cache-writers.json:77`); state helper — same shape as existing `session/store/fast-session-switch.ts` |
| `shell/session/open-sessions.ts` | 4 | `session/store/open-sessions.ts` | pure open-session-ref helpers, zero imports |
| `shell/session/session-config-selection.ts` | 4 | `session/store/session-config-selection.ts` | query-key + selection state, imports `shell/data/keys` (stays a `session→shell` edge, already baseline) |

Plus tests `local-selection-handoff.test.ts`, `open-sessions.test.ts`,
`session-config-selection.test.ts`.

**Knot:** the HLD names only five subdirs (`store,submit,composer,harness,commands`).
`shell/session/**` is neither submit nor composer nor harness nor commands — it's
session config/selection state. `store/` is the closest fit (it already holds
`fast-session-switch.ts`, `accepted-prompt-refresh.ts`, query-cache writers), so
this map routes it there rather than minting a sixth `session/selection/` subdir.
If the owner prefers an explicit `session/config/` subdir, that is defensible but
widens the HLD contract — flag for the leader.

### 1e. **STAYS PUT** — not part of D1

| file | why it stays |
|---|---|
| `session-client/index.ts` | Upstream `@opencode-ai/session-ui/*` re-export barrel (ARCHITECTURE.md:166–173). It re-exports **only** session-ui subpaths (`basic-tool`, `context`, `dock-prompt`, `file`, `line-comment`, `markdown`, `message-part`, `pierre/*`, `session-diff`, `session-retry`, `session-turn`) — **not** composer/harness/commands. This IS the boundary D2 formalizes. Keep it as the sole remaining `src/session-client/` file so `@claxedo/session-client` still resolves (§5). `scanners.ts:306` already special-cases this exact path. |

---

## 2. Importer counts (grep/script, per moved file)

Counts above are from a resolver script (`@/` + `@claxedo/*` + relative,
excluding a file's own test, deduped by importing file). Per-file **top-level-dir
breakdown of importers** (the shape that matters for §4):

```
composer/model-strategy.ts   11  {components:1, context:2, session:1, session-client:5, shell:2}
composer/workspace-resolver   6  {components:3, pages:1, session:1, session-client:1}
composer/composer.tsx         4  {index.tsx:1, pages:2, session-client:1}
composer/mode.ts              7  {components:1, pages:2, session-client:4}
harness/profile.ts           27  {claxedo-ui:17, components:3, context:1, session-client:6}
harness/store-policy.ts      14  {claxedo-ui:12, session-client:2}
harness/store-state.ts        9  {claxedo-ui:9}
harness/controller.ts         9  {claxedo-ui:2, components:5, session-client:2}
harness/prepared-session.ts   5  {claxedo-ui:5}
commands/model-selection.ts   3  {claxedo-ui:1, pages:1, session-client:1}
shell/session/local-...       4  {claxedo-ui:2, context:1, shell:1}
shell/session/open-sessions   4  {claxedo-ui:1, shell:3}
shell/session/config-sel.     4  {claxedo-ui:3, context:1}
```

Aggregate distinct importer files needing a repoint:
- `session-client/{composer,harness,commands}`: **49** files (36 non-test + 13 test).
- `shell/session/**`: **5** files.
- Internal cross-refs within session-client (composer↔harness↔commands) that
  become intra-`session` after the move: **6** files (repoint `../` relatives,
  net-simpler).

**Alias split of deep importers** (relevant to §5/D2):
- `@claxedo/session-client/{composer,harness,commands}/*`: 15 occurrences
  (`harness/controller` ×7, `harness/profile` ×4, `composer/model-strategy` ×3,
  `harness/store-state` ×1).
- `@/session-client/{composer,harness,commands}/*`: the bulk (47 distinct files).
- Barrel-only `@claxedo/session-client` (no subpath): **15** importers — these
  hit `index.ts` and are **untouched** by D1.
- Barrel-only `@/session-client` (no subpath): 0.

---

## 3. Ordering plan (additive move batches, each typecheck-green)

The LLD prescribes "additive first, delete after consumers move" (HLD:88). Each
batch = copy files to new home → repoint importers → delete old → `tsc` green.
Batches are independent enough to land as one PR but should be committed/verified
in this order (least-coupled first, god-file last):

1. **Batch 1 — `commands/`** (2 files, 5 importers). Lowest coupling; smoke test
   the mechanics (relative-import rewrite, guard-constant updates) on the smallest
   surface first.
2. **Batch 2 — `shell/session/**` → `session/store/`** (3 files, 5 importers).
   Independent of session-client; validates the `session/store/` target choice and
   the `query-cache-writers.json:77` path-key rename (§6a) in isolation.
3. **Batch 3 — `harness/`** (7 files, incl. `profile.ts` @27 importers — the
   single largest fan-out). Update `model-key.ts:4` constant in this batch
   (`model-strategy` is composer, but `profile.ts` holds the retired-vocab
   baseline entries — §6a).
4. **Batch 4 — `composer/`** (11 files incl. the `composer.tsx` god file @
   effect-write baseline; §6a). Update `composer-mode.ts:4`, `model-key.ts:4`,
   and `import-graph.ts:17` SPLIT_BARREL constants here.
5. **Batch 5 — charters + baselines + delete-old sweep.** Update ARCHITECTURE.md
   §157–173/§356–357/§123–146, `layering-baseline.json` (prune the 5 stale
   `*<->session-client` entries — §4), and confirm `src/session-client/` now holds
   **only** `index.ts`.

Rationale for god-file-last: `composer.tsx` and `profile.ts` carry the most
importers and the most guard baselines; landing the mechanical low-risk batches
first isolates any surprise to the smallest possible batch.

**Additivity caveat:** because `@claxedo/*` and `@/*` both alias `./src/*`, a
copy-then-repoint that leaves the old file in place during the transition risks
**duplicate top-level definitions** for guard scanners (e.g. two `model-strategy.ts`
seen by `model-key.ts` grep). Prefer `git mv` per batch (atomic move + same-batch
importer repoint) over a literal additive copy that lingers. "Additive across
batches, atomic within a batch."

---

## 4. Collision / layering-cycle analysis (the load-bearing section)

**Method.** Replicated the guard's own logic (`architecture/layering.ts`
`directoryCyclesFromEdges`): built the cross-top-level-dir import-edge set, then
applied the D1 relabel (`session-client/{composer,harness,commands}/* → session`,
`shell/session/* → session`, `session-client/index → session-client` unchanged)
to both `from`-dirs and resolved `to`-dirs, and diffed the 2-cycle set against
`layering-baseline.json`.

**Result — the differential:**

| | cycles |
|---|---|
| NEW cycles introduced by D1 (after − before) | **∅ (none)** |
| cycles REMOVED / collapsed by D1 | `claxedo-ui<->session-client`, `components<->session-client`, `context<->session-client`, `session-client<->shell`, `session<->session-client` |
| post-move session-axis cycles | `agent-runtime<->session`, `claxedo-ui<->session`, `components<->session`, `context<->session`, `session<->shell` — **all already in baseline** |

Every collapsing `X<->session-client` maps onto a baseline `X<->session` that
already exists (claxedo-ui, components, context), and `session-client<->shell`
folds into the baseline `session<->shell`. `session<->session-client` (an
internal cross-import, `session/store/session-status-dispatcher` ← session-client,
and session-client → `session/store/...`) simply becomes intra-`session`.

**The pane precedent — checked, does NOT trip.** `session-client/composer/*`
imports `pane/store/pane-preferences` ×3 (creating a post-move `session→pane`
edge). The cautionary precedent (ARCHITECTURE.md:225–238) is that folding
`pane-preferences` into `claxedo-ui/` would mint a `shared<->claxedo-ui` cycle
because the edge is bidirectional. Here it is **one-directional**: `pane/` does
not import `session-client` today (no `*<->session-client` pane entry in
baseline), so `session→pane` stays acyclic. **No new `session<->pane` cycle.**
Verified: post-move cycle set contains no `pane<->session`.

**Baseline-file edits required (§6a lists the mechanical rename):** the 5 stale
`*<->session-client` entries must be **pruned** from `layering-baseline.json`
(the guard's `staleDirectoryCycles` would flag them once `session-client/` holds
only `index.ts`, which imports nothing cross-dir). The remaining
`session-client/index.ts` barrel imports only external `@opencode-ai/*`, so
`session-client` drops out of the cycle graph entirely.

**Honest caveat on the model.** My resolver reproduces all 27 baseline entries
(zero stale) but also surfaces **5 extra 2-cycles** the guard does not
(`claxedo-ui<->pane`, `claxedo-ui<->shared`, `cloud<->components`,
`cloud<->context`, `context<->pages`) — a known over-count vs the guard's
`resolveImport`, which requires the target to resolve to a real file
(`import-graph.ts:162`) and applies `importSpecifiers` regex nuances my naive
mapper skips. **This does not affect the D1 verdict:** those 5 phantoms appear
**identically in before and after**, none touch the `session` axis, so the
*differential* (new cycles = ∅) is robust. The guard, run on the real post-move
tree, is the final authority — but the relabel provably only creates
session-axis edges, and every one already exists in the baseline.

---

## 5. `@claxedo/session-client` package-alias question (D1 must not break it; D2 owns enforcement)

- Both `@claxedo/*` and `@/*` resolve to `./src/*` (`tsconfig.json:21,25`;
  mirrored in `tsconfig.e2e.json:21,25`). The `@claxedo/session-client`≡`@/session-client`
  duplication is exactly what **D2** collapses — **not D1's job**.
- **What D1 must preserve:** `src/session-client/index.ts` stays in place. Its 15
  barrel-only importers (`from "@claxedo/session-client"`) keep resolving with
  zero changes. The barrel re-exports **only** upstream session-ui subpaths (it
  does not, and after D1 still does not, expose composer/harness/commands), so no
  consumer of the barrel is affected by the move.
- **What D1 changes:** the 15 deep `@claxedo/session-client/{composer,harness,commands}/*`
  imports and ~47 deep `@/session-client/{…}/*` imports repoint to
  `@/session/{composer,harness,commands}/*`. Recommend standardizing all deep
  moves on the `@/session/*` form (not `@claxedo/session/*`) so D2 inherits a
  single alias to reason about.
- **Statement of record for D2:** after D1, `src/session-client/` = `{ index.ts }`
  only. That single barrel is the "real session-client boundary" D2 gives a
  dedicated path + import rule (no `pane/`, `shell/`, `claxedo-ui/`, root
  `context/`). D1 leaves it re-exported and functional; it does not rename or
  relocate it.

---

## 6. Baseline / guard-artifact rename list (path-keys under moved paths)

### 6a. JSON baseline path-keys (data — rename the string keys)

| file:line | current key | new key |
|---|---|---|
| `architecture/query-cache-writers.json:77` | `shell/session/local-selection-handoff.ts` | `session/store/local-selection-handoff.ts` |
| `architecture/source-text-assertions-baseline.json:8` | `session-client/harness/options-state.test.ts` | `session/harness/options-state.test.ts` |
| `…:9` | `session-client/harness/prepared-session.test.ts` | `session/harness/prepared-session.test.ts` |
| `…:10` | `session-client/harness/profile.test.ts` | `session/harness/profile.test.ts` |
| `…:11` | `session-client/harness/store-policy.test.ts` | `session/harness/store-policy.test.ts` |
| `…:12` | `session-client/harness/store-state.test.ts` | `session/harness/store-state.test.ts` |
| `architecture/retired-vocabulary-baseline.json:19` | `session-client/composer/model-strategy.test.ts` | `session/composer/model-strategy.test.ts` |
| `…:20` | `session-client/harness/profile.test.ts` | `session/harness/profile.test.ts` |
| `…:21` | `session-client/harness/profile.ts` | `session/harness/profile.ts` |
| `…:22` | `session-client/harness/store-state.test.ts` | `session/harness/store-state.test.ts` |
| `architecture/session-client-reactivity-baseline.json:2` | `session-client/composer/composer.tsx` | `session/composer/composer.tsx` |
| `architecture/layering-baseline.json` | (prune) `claxedo-ui<->session-client`, `components<->session-client`, `context<->session-client`, `session-client<->shell`, `session<->session-client` | remove all 5 (§4) |

- `size-baseline.json`, `orphan-baseline.json`, `layout-guard-baseline.json`,
  `debt-baseline.json`: **no** `session-client`/`shell/session` keys — no edits.

### 6b. Guard SOURCE constants (code — must change with the move, precondition P2)

These live under `architecture/` (excluded from `prodSourcePaths`, so they don't
appear in the layering graph) but are string-compared against real file paths, so
a stale value silently breaks the corresponding guard:

| file:line | constant | new value |
|---|---|---|
| `architecture/composer-mode.ts:4` | `COMPOSER_MODE_OWNER_FILE = "session-client/composer/composer.tsx"` | `session/composer/composer.tsx` |
| `architecture/model-key.ts:4` | `CANONICAL_MODEL_KEY_FILE = "session-client/composer/model-strategy.ts"` | `session/composer/model-strategy.ts` |
| `architecture/import-graph.ts:17` | SPLIT_BARREL entry `"session-client/composer/prompt-input-props.ts"` | `session/composer/prompt-input-props.ts` |
| `architecture/scanners.ts:306` | `file.path !== "session-client/index.ts"` | **unchanged** — barrel stays put (§1e) |

### 6c. Prose / charter updates

- `ARCHITECTURE.md:157–173` — merge the `session-client/` charter into the
  `session/` charter; new `session/` sub-inventory = `composer/`, `harness/`,
  `commands/`, `store/`, `submit/`, `helpers.ts`, `session-layout.ts`.
- `ARCHITECTURE.md:123–146` — rewrite the "4-way session-domain split" note
  (`session/`, `session-client/`, `shell/session/`, context providers) → now a
  2-way split (`session/` + session-shaped `context/` providers); delete
  `shell/session/` from the `shell/` 12-subdomain list (line 125).
- `ARCHITECTURE.md:350–357` — the "new session-lifecycle behavior" decision entry
  currently routes to `src/session/` vs `src/session-client/` vs "not
  `shell/session/`"; collapse to `src/session/{store,submit,composer,harness,commands}`.
- `ARCHITECTURE.md:15` — the top-level directory list drops `session-client` only
  after D2 (D1 leaves the barrel there); **do not** remove `session-client` from
  this list in D1.
- `VOCABULARY.md:89,97` — repoint `src/session-client/harness/` and
  `session-client/harness/profile.test.ts` references to `session/harness/`.

---

## 7. Blast radius + go/no-go

**Blast radius (measured):**
- Files moved: **23 non-test + 18 test = 41 source files** (composer 11+6t,
  harness 7+7t, commands 2+2t, shell/session 3+3t).
- Distinct importer files to repoint: **54** (49 hitting session-client subpaths
  incl. 13 tests; 5 hitting shell/session) + 6 internal relative rewrites.
- Guard/baseline artifacts: **11 JSON key renames + 5 layering-baseline prunes +
  4 source-constant edits + 4 prose/charter sections.**
- `e2e/**`: **7 files** contain the strings `session-client/composer/…` etc., but
  these are **comment/citation references only** (e.g. `composer.tsx:202-206`),
  **not imports** — no functional breakage. `e2e/**` is owned by the separate
  live-e2e session (LLD dependency note); D1 should not touch it, but should flag
  the stale citations to that owner.

**Readiness verdict: GO** — conditional on:
- **P1.** Wave 2 landed (gate) and WP-02 manifest renames present, so baselines
  are the ones §6a targets.
- **P2.** The 4 guard source-constants (§6b) change in the same commit as their
  files, or `composer-mode.guard`, `model-key.guard`, `import-graph.guard` go red.
- **P3.** `import-graph.ts:17` SPLIT_BARREL repointed (P2 covers it; called out
  because a missed SPLIT_BARREL entry produces a confusing "barrel not split"
  failure rather than an obvious missing-file error).
- **P4.** Leader signs off on the `shell/session/** → session/store/` target
  (§1d) — the only choice not dictated by the 5 HLD subdir names.
- **P5.** `session-client/index.ts` explicitly excluded from the move; verified
  post-move that `src/session-client/` contains exactly that one file so D2 has a
  clean single-file boundary to formalize.

**No-go triggers:** a real (non-phantom) `pane<->session` or any non-baseline
`X<->session` cycle appearing when the actual guard runs on the moved tree
(§4 predicts none — but the guard, not this model, is final); or D2 being
attempted concurrently (LLD: "WP-D1 → WP-D2 strictly ordered", line 570).

---

## Appendix — evidence index

- Live inventory: `find src/session-client`, `find src/shell/session`,
  `find src/session` (§1 tables).
- Importer counts + dir breakdown: resolver script over all `src/**/*.ts{,x}`
  (§2), cross-checked against `grep -rl` distinct-file counts (§7).
- Cycle differential: Python re-implementation of `layering.ts`
  `directoryCyclesFromEdges` with the D1 relabel; diffed vs
  `architecture/layering-baseline.json` (§4).
- Guard artifacts: `grep -rnE 'session-client|shell/session' architecture/*.{json,ts}`
  (§6a/§6b).
- Alias resolution: `tsconfig.json:18–26`.
- Charter text: `ARCHITECTURE.md:123–173, 350–357`; `VOCABULARY.md:89,97`.
- Barrel scope: `src/session-client/index.ts` (session-ui subpaths only).
