# Composer v2: upstream re-sync procedure + recorded vendor point

- **Date:** 2026-07-25
- **Plan:** [`docs/plans/2026-07-25-005-feat-composer-v2-migration-plan.md`](./2026-07-25-005-feat-composer-v2-migration-plan.md) — evidence for **T0.4** (churn measurement) and the deliverable for **T6.1** (documented re-sync procedure + recorded vendor point).
- **Scope:** the upstream tree `packages/session-ui/src/v2/components/prompt-input/**` and its two app-side wiring files.
- **All measurements taken against the local `upstream` remote at `refs/remotes/upstream/dev`, fetched 2026-07-25.** No fetch was performed while writing this doc; every number is reproducible from the recorded SHAs.

---

## 1. Recorded VENDOR POINT (the baseline a future re-sync diffs from)

### 1.1 Current vendor point — record this

| Field | Value |
|---|---|
| `git rev-parse upstream` | `7534d23551f665e65080809975b4ca5c7d63807b` |
| upstream ref | `refs/remotes/upstream/dev` |
| upstream HEAD date / subject | 2026-07-25 08:21:12 +0000 — `chore: update nix node_modules hashes` |
| `git log -1 --format=%H upstream -- packages/session-ui/src/v2/components/prompt-input` | `b513fafe8354b85d1ba4609733b7f33c7b46b7d5` (2026-07-21, `fix(app): support nested slash command autocomplete (#38097)`) |
| `git rev-parse upstream:packages/session-ui/src/v2/components/prompt-input` (tree object) | `0ab71bd4e017e72d16c8776699a793d550005df2` |

**Use `b513fafe8354b85d1ba4609733b7f33c7b46b7d5` as the vendor point, not the HEAD SHA.** The HEAD SHA moves on every unrelated upstream commit; the last-touch SHA is the one that actually describes the vendored content, and a diff from it produces no noise.

Per-file blob SHAs at the vendor point (use these to prove a local file is still pristine — `git rev-parse upstream:<path>` vs `git hash-object <local path>`):

| File | blob (12) | last touched by | date | LOC |
|---|---|---|---|---|
| `attachments.ts` | `8c7b12e9ae1d` | `82a3270cf2` | 2026-07-17 | 266 |
| `index.tsx` | `9b011f03e9ef` | `5586f9675e` | 2026-07-20 | 706 |
| `interaction.ts` | `f4a9fa74b7f2` | `47fc6f2991` | 2026-07-20 | 482 |
| `machine.test.ts` | `e36982666e4d` | `b513fafe83` | 2026-07-21 | 164 |
| `machine.ts` | `d2508e249c5f` | `b513fafe83` | 2026-07-21 | 261 |
| `prompt-input.stories.tsx` | `525c2640975b` | `c0a258b22a` | 2026-07-17 | 221 |
| `store.test.ts` | `a58428d9c196` | `47fc6f2991` | 2026-07-20 | 116 |
| `store.ts` | `5a27de6c4de3` | `47fc6f2991` | 2026-07-20 | 152 |
| `types.ts` | `a2630a5ea6f2` | `c0a258b22a` | 2026-07-17 | 106 |

Tree total: **2,474 lines across 9 files.**

App-side wiring (ported separately; **not** part of the session-ui tree, and structurally divergent because we are `packages/claxedo-app`, not `packages/app`):

| Upstream path | blob (12) | last touched | date |
|---|---|---|---|
| `packages/app/src/components/prompt-input-v2.tsx` | `14e8e2bd0b64` | `ce7f54d5e7` | 2026-07-24 |
| `packages/app/src/components/prompt-project-selector.tsx` | `1e5445517dbc` | `c0a258b22a` | 2026-07-17 |

### 1.2 Previous vendor point (already in this repo — verified)

The tree is **already vendored and tracked**: it entered `dev` on 2026-07-18 via `6a33d82682`, and that committed copy is **byte-identical** to upstream at `efb6cc2d4bf6332eb156709795d2b3a649198b65` (2026-07-17, `fix(session-ui): preserve prompt editing behavior (#37483)`) — both trees hash to `d1c4092818b5bdb848afa4f5e21f69dfba48855d`.

So the repo already contains one real, measurable drift interval, and §3's command has been executed for it (see §3.2). Chain of vendor points to date:

| # | Upstream baseline SHA | Vendored on | Drift to next point |
|---|---|---|---|
| 1 | `efb6cc2d4bf6332eb156709795d2b3a649198b65` (2026-07-17) | `dev` commit `6a33d82682`, 2026-07-18 | 7 commits, 6 files, +166/−58 in 8 days |
| 2 | `b513fafe8354b85d1ba4609733b7f33c7b46b7d5` (2026-07-21) | this doc, 2026-07-25 | — |

> **Append a row to that table on every re-sync.** A vendored tree without a recorded baseline is unmaintainable: you cannot tell an upstream change from a Claxedo edit, so the next re-sync degenerates into a manual three-way read of 2,474 lines.

---

## 2. Churn measurement (T0.4) — how often to re-sync

### 2.1 `packages/session-ui/src/v2/components/prompt-input/**`

**The tree is 9 days old.** It did not exist before 2026-07-17 (`c0a258b22a`, `feat(session-ui): rewrite v2 prompt input (#37102)`, +2,350 lines in 9 new files). The requested 8-week window (since 2026-05-30) therefore contains 8 days of history, and weeks W22–W28 are structurally zero, not quiet.

| ISO week | Commits | +added | −deleted | Total lines |
|---|---|---|---|---|
| 2026-W22 … W28 (2026-05-30 → 07-12) | 0 | 0 | 0 | 0 — *tree did not exist* |
| 2026-W29 (07-13 → 07-19) | 4 | 2,439 | 68 | **2,507** |
| 2026-W30 (07-20 → 07-25, partial) | 6 | 159 | 56 | **215** |
| **8-week total** | **10** | **2,598** | **124** | **2,722** |

Per-day, which is where the signal actually is:

| Day | Commits | Lines changed |
|---|---|---|
| 2026-07-17 (Fri) | 3 | 2,498 — birth (`#37102`) + `chore: generate` + `#37483` |
| 2026-07-18 (Sat) | 0 | 0 |
| 2026-07-19 (Sun) | 1 | 9 |
| 2026-07-20 (Mon) | 5 | 198 |
| 2026-07-21 (Tue) | 1 | 17 |
| 2026-07-22 → 07-25 (Wed–Sat) | **0** | **0** |

Rates, stated three ways so nobody quotes the flattering one:

- **1.25 commits/week** averaged over the requested 8-week window (10 ÷ 8) — misleading, 7 of those weeks predate the tree.
- **7.8 commits/week** over the tree's actual life (10 commits ÷ 1.29 weeks).
- **6.1 commits/week** excluding the birth day (7 commits ÷ 8 days) — **this is the number to plan the re-sync cadence against.**
- Post-birth line churn: **224 lines in 4 days = 9.1% of the 2,474-line tree.**

The 7 post-birth commits, all bug-fixes, none re-architecting:

```
b513fafe83 2026-07-21  fix(app): support nested slash command autocomplete (#38097)
4872c48c23 2026-07-20  fix(app): complete mentions at cursor (#37941)
47fc6f2991 2026-07-20  fix(app): preserve mentions during paste (#37940)
da312b009c 2026-07-20  fix(app): preserve command menu drafts (#37942)
5586f9675e 2026-07-20  fix(app): restore model variant accessibility (#37857)
7985c2066a 2026-07-20  fix(app): show keybind tooltips on prompt input controls (#37824)
cc34084dfe 2026-07-19  feat(desktop): prevent overlapping composer borders (#37490)
```

### 2.2 `packages/app/src/components/prompt-input-v2.tsx`

5 commits in 8 weeks. **Still moving as of 2026-07-24 — the most recent activity anywhere in this measurement.**

| Week | Commits |
|---|---|
| W29 | 2 (`c0a258b22a` birth, `cc34084dfe`) |
| W30 | 3 (`7985c2066a`, `37c263e153` *project current server state*, `ce7f54d5e7` *make prompt input agent toggle reactive*) |

### 2.3 `packages/app/src/components/prompt-project-selector.tsx`

8 commits in 8 weeks — older file, refactored repeatedly, last touched 2026-07-17.

| Week | Commits |
|---|---|
| W26 (06-22 → 06-28) | 4 (`a2b847e29e` split session composer, `19e510f5d2` dropdown for project selector, `4a8fee3b2d`, `1aea999d7c`) |
| W27 | 1 (`a4fed69a82` dropdown search fix) |
| W28 | 0 |
| W29 | 3 (`f58b8cb67b`, `5f7091ab4e` picker positioning/anchor fixes, `c0a258b22a`) |
| W30 | 0 |

Combined line churn for the two app files: W26 **731**, W27 **34**, W28 **0**, W29 **643**, W30 **17**.

### 2.4 Context: the whole of `packages/session-ui/src/v2`

| Week | Commits | Lines changed |
|---|---|---|
| W26 | 1 | 1,869 |
| W27 | 1 | 1,293 |
| W28 | 4 | 516 |
| W29 | 10 | 2,780 |
| W30 (partial) | 8 | 228 |

Commit *frequency* into `src/v2` is rising (1 → 1 → 4 → 10 → 8) while line *volume* is falling. That is a tree being filled out and then fixed, not one being redesigned.

### 2.5 Verdict: cooling, but **not** stabilised — do not treat it as frozen

Evidence for cooling:
- 4 consecutive days (07-22 → 07-25) with **zero** commits to the session-ui tree, immediately after a 5-commit day.
- W30 line volume 215 vs W29's 157 post-birth-equivalent — flat, and two orders of magnitude below the 2,350-line birth commit.
- All 7 post-birth commits are `fix(...)` with narrow scope (mentions at cursor, paste preservation, command-menu drafts, keybind tooltips, nested slash autocomplete, model-variant a11y). Classic fix-tail.
- No file has been added, deleted or renamed since 2026-07-17; the 9-file shape and the `types.ts` view model are unchanged.

Evidence against calling it stable:
- **The tree is 9 days old.** Nine days of history cannot support a stabilisation claim; the quiet stretch spans a Wed–Sat and includes a weekend.
- **The app-side wiring is still live**: `prompt-input-v2.tsx` changed twice on 2026-07-24 — after the session-ui tree went quiet. The wiring layer is precisely the layer Claxedo has to re-implement, so its churn hits us harder than the tree's.
- 6.1 commits/week post-birth is a high rate in absolute terms; the interval is just too short to extrapolate.
- The surrounding migration has not moved: **30% of `packages/app` imports are v2** (§2.6), unchanged since the 2026-07-18 deferral decision. Upstream is nowhere near done, so more prompt-input work is coming.

**Cadence implied by the numbers: re-sync weekly while the fix-tail runs (expect several more weeks), then monthly once two consecutive quiet weeks are observed.** Practical trigger, not a calendar: re-sync whenever `git log <last vendor point>..upstream -- <tree>` returns 3 or more commits, since 7 commits already produced 224 changed lines.

### 2.6 Overall migration figures — verified

Measured over all **422** files in `git ls-tree -r upstream -- packages/app/src`:

| Import form | Occurrences | Distinct files |
|---|---|---|
| `from "@opencode-ai/ui/v2/…"` | **159** | 55 |
| `from "@opencode-ai/ui/…"` excluding `/v2/` | **364** | 117 |
| **Total** | **523** | — |
| v2 share | **30.4%** | — |

- `159` matches the plan's expected figure exactly.
- `364` vs the plan's `363` — **the plan is off by one; legacy is 364.** The conclusion is unaffected (30% either way).
- Sanity check: `from "@opencode-ai/ui"` and `from "@opencode-ai/ui/v2"` with **no** subpath both occur **0** times, so those two counts are exhaustive — there is no third bucket hiding imports.
- Top legacy subpaths (the migration's real backlog): `context/dialog` 45, `icon` 38, `button` 32, `icon-button` 27, `context` 24, `tooltip` 20, `dialog` 16.
- Top v2 subpaths: `icon` 30, `icon-button-v2` 20, `tooltip-v2` 18, `button-v2` 17, `text-input-v2` 11.
- `packages/session-ui`: **30** files under `src/v2`, **81** files under `src` outside `v2` (the plan says "68 non-v2"; measured as all tracked files it is 81, as `.tsx` only it is 32 — neither is 68, so **do not re-quote 68**). `packages/ui/src/v2` holds 89 files.

---

## 3. The re-sync procedure

### 3.0 Preconditions

- `upstream` remote present and fetched (`git remote -v` shows `anomalyco/opencode`). Fetch deliberately, on a clean tree.
- **`dev` and `upstream` have no merge base** — `git merge-base dev upstream` returns empty. This is a hard fork with reset history. Therefore: **never `git merge upstream`, never `git rebase upstream`, never `git cherry-pick` across the seam.** Re-sync is always *read a diff, apply it by hand or with a scoped `git apply -3`*.
- Do not re-sync on a working tree with unrelated uncommitted work. Land or park it first.

### 3.1 The command

```bash
# 1. New vendor point candidate: what upstream has now for this tree.
git rev-parse upstream
git log -1 --format='%H %ci %s' upstream -- packages/session-ui/src/v2/components/prompt-input

# 2. Is there anything to do? (OLD = the recorded vendor point from §1.2)
git log --format='%h %ad %s' --date=short OLD..upstream \
  -- packages/session-ui/src/v2/components/prompt-input

# 3. Size it.
git diff --stat OLD..upstream  -- packages/session-ui/src/v2/components/prompt-input
git diff --numstat OLD..upstream -- packages/session-ui/src/v2/components/prompt-input

# 4. Read it. This is the load-bearing step; do not skip to applying.
git diff OLD..upstream -- packages/session-ui/src/v2/components/prompt-input

# 5. Same for the app-side wiring — separately, because our copy is a rewrite,
#    not a vendored file. Read these as intent, then re-express in claxedo-app.
git diff OLD..upstream -- packages/app/src/components/prompt-input-v2.tsx \
                           packages/app/src/components/prompt-project-selector.tsx
```

Useful variants:

```bash
# What did WE change relative to the vendor point? (should ideally be empty)
git diff OLD -- packages/session-ui/src/v2/components/prompt-input

# Per-commit review instead of one big blob — strongly preferred once >3 commits.
git log -p --reverse OLD..upstream -- packages/session-ui/src/v2/components/prompt-input

# Apply upstream's delta with 3-way merge, scoped to the tree, conflicts left in-file.
git diff OLD..upstream -- packages/session-ui/src/v2/components/prompt-input | git apply -3 --directory=.
```

### 3.2 Worked example (verified 2026-07-25)

```bash
git diff --stat efb6cc2d4bf6332eb156709795d2b3a649198b65..7534d23551f665e65080809975b4ca5c7d63807b \
  -- packages/session-ui/src/v2/components/prompt-input
```

```
 .../src/v2/components/prompt-input/index.tsx       | 98 +++++++++++++---------
 .../src/v2/components/prompt-input/interaction.ts  | 24 +++---
 .../src/v2/components/prompt-input/machine.test.ts | 27 ++++++
 .../src/v2/components/prompt-input/machine.ts      | 15 ++--
 .../src/v2/components/prompt-input/store.test.ts   | 22 +++++
 .../src/v2/components/prompt-input/store.ts        | 38 ++++++++-
 6 files changed, 166 insertions(+), 58 deletions(-)
```

Per-file: `index.tsx` +57/−41, `store.ts` +37/−1, `machine.test.ts` +27/−0, `interaction.ts` +13/−11, `machine.ts` +10/−5, `store.test.ts` +22/−0. Untouched in this interval: `attachments.ts`, `types.ts`, `prompt-input.stories.tsx`.

Read that shape: **the view model (`types.ts`) held still; the behaviour (`index.tsx`, `store.ts`, `interaction.ts`) moved.** That is the drift profile to expect, and it is the worst possible profile for us, because our eight adapters (§4) attach to exactly those behaviour files.

### 3.3 Step-by-step order

Do these in order. The order exists so that every conflict you resolve is resolved with the upstream *intent* already in hand.

1. **Freeze.** Clean working tree; branch `sync/composer-v2-<date>` off `dev` (never re-sync on `dev` directly). Record `OLD` and the candidate `NEW` SHAs in the §1.2 table before touching a file.
2. **Prove the local tree is pristine.** `git diff OLD -- <tree>` must be empty, or each hunk must be a *recorded* fork (plan T2.x requires forks be written down). An unrecorded local hunk is a stop: find out who made it and why before proceeding.
3. **Read upstream's commits one at a time** (`git log -p --reverse OLD..upstream -- <tree>`). Write a one-line intent per commit. Fix-tail commits usually carry a behaviour contract in their test file, so read the `*.test.ts` hunks first — upstream's `machine.test.ts` / `store.test.ts` are the state-machine spec (plan T1.1).
4. **Take the upstream tests first, alone.** Apply only the `machine.test.ts` / `store.test.ts` hunks and run them. They should fail. That failure set is your exact behaviour delta and it is the only trustworthy checklist for the rest of the re-sync. (Green tests are claims — this is the one step that makes them evidence.)
5. **Apply the pure-vendor files** in dependency order, cheapest first: `types.ts` → `attachments.ts` → `machine.ts` → `store.ts` → `interaction.ts` → `index.tsx` → `prompt-input.stories.tsx`. Resolve conflicts as **upstream-wins inside the tree**: the vendored tree stays a faithful copy, and Claxedo behaviour lives in adapters outside it. If you find yourself editing the tree to keep a Claxedo behaviour, stop — that is a fork, and it needs a recorded T2.x task.
6. **Typecheck the tree in isolation** before touching any adapter, so type breakage is attributed to upstream rather than to your adapter edits.
7. **Run the upstream suites** (`machine.test.ts`, `store.test.ts`) to green. Any test you had to modify must be justified in writing as behaviour-preserving.
8. **Now the adapters, one §4 capability at a time**, in this order — least-coupled first, so each fix narrows the blast radius of the next:
   1. composer-mode scoping · 2. boot state / harness polling fade · 3. permission modes · 4. document mentions · 5. workspace kinds / context row · 6. harness selection · 7. submit-block derivation · 8. signed control plane.
   *(Rationale: 7 and 8 gate submission, so they must be resolved last, against an already-correct editor. 6 and 7 are the two that upstream's `interaction.ts` has the least room for.)*
   Run each capability's existing tests **unchanged** where possible.
9. **Re-express the app-side wiring** from the §3.1 step-5 diff. Never copy `prompt-input-v2.tsx` or `prompt-project-selector.tsx` verbatim — upstream is `packages/app` with different layout context and helpers; ours is `packages/claxedo-app`. Port the *intent*, keeping our project/workspace model (cloud / self-hosted / worktree) which upstream has no concept of.
10. **Guards + parity.** Architecture/import guards, locale + `size-baseline.json` ceilings, and the three core composer e2e specs (`core-composer-modes`, `core-model-effort-agent-controls`, `core-harness-ownership-local`). No selector-only edits that mask a behaviour change: a `data-action` may move, what it does may not. Tripwire at least one guard you rely on (break it, watch it fail, restore).
11. **Vision gate.** Screenshot the composer in both themes and measure all four dropdowns. UI parity is a release gate for this surface; a green suite is not sufficient evidence.
12. **Record the new vendor point** — append the row to §1.2 (baseline SHA, tree object SHA, date, per-file blob SHAs, drift stats) **in the same commit as the code**. If the SHAs land in a later commit, they are already wrong.

### 3.4 If a re-sync stalls

- Conflicts concentrated in `types.ts` mean upstream changed the **view model**. That invalidates adapter assumptions wholesale; escalate rather than patching through — it is the plan's §6 sunk-cost trigger.
- If three or more §4 capabilities need `interaction.ts` forked, resurface to the owner. Per the plan, that makes wholesale adoption more expensive than the targeted adoption it replaced.
- Never resolve a conflict by deleting a Claxedo capability to match upstream. Every §4 row is a parity contract; if a slice cannot preserve one, the migration stops at that slice.

---

## 4. WARNING — every re-sync will conflict with the Claxedo adapters

Upstream's `prompt-input/types.ts` models exactly `prompt / cursor / model / context.items`. **106 lines.** It has no concept of any of the following eight capabilities, all of which are load-bearing in Claxedo, all of which are unrepresentable in upstream's view model, and none of which upstream will ever consider when it changes this tree:

| # | Claxedo capability upstream has no concept of | Lives in |
|---|---|---|
| 1 | **Harness selection** across 8 `HarnessId`s — readiness/polling, locked-after-first-turn | `AgentHarnessSelector`, `harness/*` |
| 2 | **Submit-block derivation** — no-credential / no-model / read-only / harness-not-ready, plus explain-on-intent | `composer/submit-block-wiring.ts`, `composer/submit-block-reason.ts` |
| 3 | **Workspace kinds** — cloud / self-hosted, worktree creation, the context row | `session-new-design-view.tsx`, `session-context-row.tsx` |
| 4 | **Permission modes** + approve control | `permission/*`, `ui/approve-control.tsx` |
| 5 | **Document mentions** | `composer/document-picker-controller.ts` |
| 6 | **Signed control plane** — `workspaceId`, placement/role gating | `composer/submit.ts`, `composer/role-gate.ts` |
| 7 | **Boot state** / harness polling fade | `composer/submit-ui-state.ts`, `ui/toolbar-motion.ts` |
| 8 | **Composer-mode scoping** — draft / session / surface / pane | `composer/mode-snapshot.ts`, `panePreferences` |

Why this guarantees conflict on every single re-sync, not occasionally:

- **The drift lands exactly where the adapters attach.** In the one measured interval (§3.2) upstream changed `index.tsx`, `store.ts`, `interaction.ts`, `machine.ts` and left `types.ts` alone. Those four behaviour files *are* the adapter seam. A quiet `types.ts` is not safety; it is upstream reserving the right to change behaviour without changing the shape you type-checked against.
- **Upstream's fix-tail is behavioural, so `tsc` will not catch it.** "Complete mentions at cursor", "preserve mentions during paste", "preserve command menu drafts", "nested slash command autocomplete" all change *what the editor does* while keeping signatures intact. Claxedo's document-mention picker (#5) and popover/composer-mode scoping (#8) ride on those semantics. A silent, green re-sync that changed mention behaviour is the realistic failure mode — hence §3.3 step 4, take upstream's tests first and read their failures.
- **Adapters #2 and #6 gate submission**, which is the single code path upstream touches most (model variant, agent toggle, keybinds, server state — 3 of the 5 app-side commits in W30). Every upstream change to how submit is wired is a merge decision for us.
- **The app-side files are not vendorable at all.** `prompt-input-v2.tsx` and `prompt-project-selector.tsx` are where upstream puts *its* equivalent of #1/#3, in terms of *its* project and server model. Ours is a rewrite (plan §6: "not a copy-paste"), so every upstream change there is a manual re-expression, permanently. This is also the file still moving as of 2026-07-24.
- **The tree currently has zero consumers in this repo.** Nothing under `packages/claxedo-app`, `packages/session-ui` or `packages/ui` imports `@opencode-ai/session-ui/v2/prompt-input*` yet (the four subpath exports exist in `packages/session-ui/package.json` but are unused). Today's re-sync is therefore *cheap and misleadingly clean*. The cost appears the moment W2/W3 wires the eight capabilities in, and it appears in full — a first re-sync that went smoothly is not evidence the procedure is cheap.

**Corollary for reviewers:** a re-sync PR whose diff touches only the vendored tree is incomplete. Either it also touches the adapters, or it carries a written statement of why none of the eight capabilities is affected — checked against upstream's commit *intents*, not against a green suite.
