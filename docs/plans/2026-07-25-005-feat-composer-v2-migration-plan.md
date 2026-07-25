# Composer v2 migration: adopt upstream's v2 prompt-input wholesale

- **Date:** 2026-07-25
- **Status:** IN PROGRESS — **Option 4 (§3.2) chosen by owner 2026-07-25 after T0.2/T0.4.** W0 complete, W1 complete, W6 complete.
- **Owner intent:** adopt upstream's v2 prompt-input *engine and dropdown leaves* behind Claxedo's own frame — searchable combobox dropdowns, flat `+` menu with keyboard hints, project avatars — **explicitly reversing the 2026-07-18 "stay on legacy v1" decision**, but with **zero upstream forks** (Option 4, §3.2).

> **SCOPE CHANGE, 2026-07-25.** This doc was written as a wholesale shell replacement. T0.2 showed the three forks that would have required all land in `index.tsx`, the highest-churn file, while the controller/state machine need none — and all five leaf components are exported. The owner chose **Option 4**: consume the engine and leaves unmodified, keep our frame. §4's W2/W3/W5 are restated below accordingly; the original wholesale framing is retained in §3.1/§3.2 as the record of why it was rejected.

Inherited operating principles (inlined; `docs/plans/goal.md` does not exist on `dev`):
- Exact Definition of Done per task; a task without a runnable verification command is not done.
- **No false-positive verification:** green tests are claims. Every guard tripwired (break it, watch it fail, restore).
- **UI parity is a release gate:** this replaces the most-used surface in the app. Screenshot both themes per slice.
- Strangler/additive: the v2 composer lands behind a switch and the legacy one keeps working until parity is proven.
- Make illegal states unrepresentable; one reactive data graph.
- Push parallel agents/workflows; the parallelization map is normative.

---

## 1. Decision record and the risk the owner accepted

The 2026-07-18 decision ([[ui-v2-migration-deferred]]) was: migrate **only after upstream fully completes** its v2 migration. The owner reversed it on 2026-07-25 with the measurement below in hand.

**Upstream is still ~30% migrated, and has barely moved:**

| Date | v2 imports | legacy imports | % |
|---|---|---|---|
| 2026-07-18 (decision) | 156 | 359 | 30% |
| 2026-07-25 (today) | 159 | **364** | 30.4% |

*Corrected by T0.4: legacy is **364**, not 363 (measured over all 422 files in `upstream:packages/app/src`; v2=159/55 files confirmed exact). The "68 non-v2" figure for `session-ui` was wrong in both directions — it is **81** files outside `src/v2`, or 32 counting `.tsx` only. Do not re-quote 363/68.*

Three imports in seven days at the app level. **But T0.4 found the framing incomplete: the v2 prompt-input tree is only 9 days old** — born 2026-07-17 (`c0a258b22a`, +2,350 lines). So the app-wide 30% is a slow migration, while *this tree specifically* is new and in an active fix-tail:

| Rate | Value | Use |
|---|---|---|
| 8-week average | 1.25 commits/wk | misleading — tree absent for 7 of 8 weeks |
| Tree's actual life | 7.8 commits/wk | includes birth commit |
| **Post-birth** | **6.1 commits/wk** | **plan cadence against this** |

Post-birth churn is 224 lines = **9.1% of the tree in 4 days**, all narrow `fix(...)` commits (mentions-at-cursor, paste preservation, nested slash autocomplete, keybind tooltips, model-variant a11y). Then 4 consecutive zero-commit days.

**Verdict: cooling, not stabilised** — 9 days cannot support a stabilisation claim, and the quiet stretch spans a weekend. Critically, **the app-side wiring `prompt-input-v2.tsx` was still being changed on 2026-07-24**, after the tree went quiet — and that wiring layer is exactly what Claxedo must re-implement.

Re-sync trigger: when `git log OLD..upstream -- <tree>` shows ≥3 commits (7 commits already produced 224 changed lines). Weekly while the fix-tail runs; monthly after two consecutive quiet weeks.

## 2. Size of the thing

**Porting in (~3,775 lines):**

| Lines | File |
|---|---|
| 706 | `session-ui/src/v2/components/prompt-input/index.tsx` |
| 482 | `…/prompt-input/interaction.ts` (the controller) |
| 266 | `…/prompt-input/attachments.ts` |
| 261 | `…/prompt-input/machine.ts` (+164 test) |
| 152 | `…/prompt-input/store.ts` (+116 test) |
| 106 | `…/prompt-input/types.ts` |
| 592 | `app/src/components/prompt-input-v2.tsx` (app wiring) |
| 593 | `app/src/components/prompt-project-selector.tsx` |
| 116 | `app/src/utils/search-keydown.ts` |
| 66 | `ui/src/v2/project-avatar-v2.tsx` |

**Reconciling out:** `claxedo-app/src/features/session/composer/` is **8,285 lines** (non-test), including `composer.tsx` 794, `frame.tsx` 370, `editor-actions.ts` 315, `popover-controller.ts` 223.

## 3. The hard part: upstream's view model does not know Claxedo exists

`prompt-input/types.ts` models exactly `prompt / cursor / model / context.items`. It has **no** concept of any of the following, all of which are load-bearing in Claxedo and must survive as extension points:

| Claxedo capability | Where it lives today |
|---|---|
| Harness selection across 8 `HarnessId`s, readiness/polling, locked-after-first-turn | `AgentHarnessSelector`, `harness/*` |
| Submit-block derivation (no-credential / no-model / read-only / harness-not-ready) + explain-on-intent | `submit-block-wiring.ts`, `submit-block-reason.ts` |
| Cloud / self-hosted workspace kinds, worktree creation, the context row | `session-new-design-view.tsx`, `session-context-row.tsx` |
| Permission modes + approve control | `permission/*`, `ui/approve-control.tsx` |
| Document mentions | `document-picker-controller.ts` |
| Signed control plane, `workspaceId`, placement/role gating | `submit.ts`, `role-gate.ts` |
| Boot state / harness polling fade | `submit-ui-state.ts`, `ui/toolbar-motion.ts` |
| Composer-mode scoping (draft / session / surface / pane) | `mode-snapshot.ts`, `panePreferences` |

**If a slice cannot preserve one of these, the migration stops at that slice.** That list is the parity contract, not a wish list.

### 3.1 T0.2 RESULT (2026-07-25) — 5 seams, 3 forks, 0 blocked

| # | Capability | Verdict | Seam / fork target |
|---|---|---|---|
| 1 | Harness selection (8 ids, readiness, locking) | **SEAM** | `modelControl` JSX slot (`index.tsx:41`, rendered `:218-234`) |
| 2 | Submit-block + explain-on-intent | **FORK** | `index.tsx:247-255` — needs a submit slot |
| 3 | Workspace kinds / worktrees / context row | **SEAM** | none needed — the row is a *sibling above* the composer |
| 4 | Permission modes + approve control | **SEAM** | same `modelControl` fragment |
| 5 | Document mentions | **FORK** | `index.tsx:88` (empty label) + `:453-508` (add-menu items) |
| 6 | Signed control plane / role gating | **SEAM** | `view.submit.onSubmit` + `view.placeholder` |
| 7 | Boot state / polling fade | **FORK** | `index.tsx:192-256` — no slot between toolbar and submit |
| 8 | Composer-mode scoping | **SEAM** | `store` + `identity` — upstream designed for this exactly |

**Forks of `interaction.ts`: 0. `machine.ts`: 0. `types.ts`: 0.** All three forks land in **one file** (`index.tsx`), largely one region. The 482-line controller and 261-line state machine — the parts we cannot re-derive and most fear re-syncing — need **zero** modification for all eight capabilities.

Three concrete blockers behind the forks, for whoever implements them:
- Submit enablement is one reason-less boolean (`disabled={!controller.canSubmit()}`, `index.tsx:250`); `PromptInputV2SubmitButton`'s props carry no tooltip-content slot and `disabled` hard-blocks the click, so explain-on-intent (clickable-while-dimmed) is unreachable. Using `props.disabled` instead would make the editor non-typeable (`index.tsx:153`), contradicting our deliberate "gate submission, not typing" rule.
- `PromptInputV2AddMenu` hardcodes exactly four items with no extra-items prop and no children (`index.tsx:453-466`, `:490-502`), and `view.add.onAttach` becomes unreachable once an `attachments` config is supplied (`interaction.ts:102-108`).
- The left toolbar cluster is `inert` in shell mode (`index.tsx:196`) and carries a fixed fade (`:56-60`, `:197`) with no input, so a cancel/retry control relocated into `modelControl` would go dead — and the polling dim is a second independent factor upstream has no notion of.

### 3.2 OPTION 4 — the possibility this plan failed to enumerate

All five leaf components are **exported**: `PromptInputV2Attachments` (`index.tsx:368`), `PromptInputV2AddMenu` (`:453`), `PromptInputV2Select` (`:534`), `PromptInputV2Popover` (`:588`), `PromptInputV2SubmitButton` (`:655`). Verified.

So a fourth path exists: **consume `interaction.ts` + `machine.ts` + `store.ts` + `types.ts` unmodified, plus the exported leaves, and keep Claxedo's own frame.** Zero upstream forks. Cost: we do not inherit upstream's shell markup.

Why this is likely the better trade, on the evidence now in hand: the only file needing forks (`index.tsx`, 706 lines of markup) is also the **highest-churn file** in the tree (+57/−41 of the 166 drifted lines in 8 days, per T0.4), and it is the file W4 wants for its dropdowns. Option 4 avoids forking precisely the file that moves most, while still inheriting the tested state machine and the searchable dropdown leaves that were the original ask.

## 4. Workstreams

### W0 — Probes (all parallel; ship before any porting)
- **T0.1** Does upstream's v2 prompt-input compile against our `packages/ui`/`session-ui` at all? Vendor the tree unmodified into a scratch path and typecheck. **DoD:** a written list of every unresolved import and v2-token dependency.
- **T0.2** Enumerate upstream's extension seams — which of §3's capabilities can hang off `interaction.ts`/`types.ts` without forking them. **DoD:** a per-row verdict (seam exists / needs a fork / blocked).
- **T0.3** Storybook renderability of the v2 prompt-input in this repo (see [[storybook-monorepo-gotchas]] — 4 interlocking pins). **DoD:** the upstream story renders locally.
- **T0.4** Diff upstream's v2 prompt-input against the last vendored point to gauge churn rate. **DoD:** commits/week touching that tree, which sets W6's re-sync cadence.

### W1 — Vendor the tree (additive; nothing switched on)

**T0.1/T1.1 DONE 2026-07-25 — and the framing above was WRONG.** The tree was ALREADY vendored at HEAD (`d6353b71d0`), at an older upstream snapshot. So this was a **version bump, not a fresh vendor**, and the discovery work does not need repeating.

Result: all 9 files now byte-identical to upstream with **zero logic changes**; 6 files changed (`index.tsx` 98±, `store.ts` 38±, `machine.test.ts` 27+, `interaction.ts` 24±, `store.test.ts` 22+, `machine.ts` 15±). `attachments.ts`, `types.ts`, `stories.tsx` were already current.

**The bump fixed three real behaviours, not just text.** Upstream's current tests against HEAD's `machine.ts`/`store.ts` were **13 pass / 3 fail**:
- nested slash-command completion (`/review/` → `/review/nested`)
- context completion at the cursor returned `{type:"closed"}` instead of `{type:"context",query:…}`
- `store.addText` flattened structured mentions instead of preserving `file` parts and re-basing offsets

Verified state: `bun test src/v2/components/prompt-input` → **16 pass / 0 fail**; package suite 84/0; `tsgo -p . --noEmit` → 0 errors.

Two findings that change later tasks:
- **The tree is self-contained.** It takes everything host-specific through `PromptInputV2Props` / `PromptInputV2ViewConfig` / `PromptInputV2StoreInput` — **no dependency on upstream's `packages/app` context or helpers.** That is why it ports cleanly, and it is the reason W2's seam question is answerable at all.
- **Zero module-level consumers exist.** Nothing imports `PromptInputV2`; every grep hit is a comment or a testid pointing at the legacy v1 composer. So this carries no consumer-breakage risk and W3 starts from a clean seam.
- `session-ui/tsconfig.json` excludes only `**/*.stories.*` and `**/*.mdx`, so **tests ARE typechecked here** (unlike `agent-sdk-runtime`) — proven by a deliberate type error surfacing in `store.test.ts`. But `prompt-input.stories.tsx` is both out of scope AND carries upstream's own `// @ts-nocheck`, so it can rot silently.

- **T1.2** Vendor `search-keydown.ts` and `project-avatar-v2.tsx`. **DoD:** typecheck clean; keydown util unit-tested.

### W2 — Adopt the engine behind our frame (RESTATED FOR OPTION 4)

Under Option 4 the eight capabilities **stay where they are** — our frame keeps rendering them — so the per-capability adapter work in the original W2 largely evaporates. What replaces it is one substantive swap: retire Claxedo's own editor/draft machinery in favour of upstream's controller.

- **T2.1** Expose a per-scope raw `[store, setStore]` tuple from `providers/prompt.tsx` (it returns a wrapped API today) so `createPromptInputV2Store` / the controller's `store` + `identity` inputs can bind to it. `composerModeSnapshot` already computes exactly the `scope` + `sessionKey` pair those two want. **DoD:** switching scope resets machine state and does not leak a draft between scopes; existing prompt-persistence tests pass.
- **T2.1 DONE 2026-07-25.** Adapter is `promptDraftControllerInput(() => prompt.capture(scope?))` → `{store, identity}`, in `providers/prompt.tsx` (additive; the one existing-line edit is a type extraction). `identity` is the capture object itself — one per prompt-cache entry — mirroring upstream's `identity: () => prompt.capture()`. 6 tests drive the REAL vendored store and controller, tripwired three ways.
  - **Guard boundary matters here.** `deepSessionUiImports` is a debt-ratchet metric pinned at **0** that exempts exactly one file: `ui/session-kit.ts` (`src/architecture/scanners.ts:321`). Importing v2 types straight into `prompt.tsx` regressed it 0→2. Fix was **type-only** re-exports through that barrel, so no v2 runtime code enters it. T2.2 must cross the same boundary the same way.
  - **My brief to the agent was wrong on one point:** upstream's `PromptInputV2Comment` declares `key: string` as **required** (`types.ts:59-68`), so our `ContextItem & {key}` matches exactly — that was never a divergence.
  - **`model` confirmed inert** — `interaction.ts` references it only as a host-owned select control; `machine.ts` never touches it; `store.setModel`/`setVariant` are never called by the controller. Keeping model/harness state outside the draft is safe.
  - **One real divergence that IS written:** `sourcePath` on image parts, set by `attachments.ts:110` whenever an `attachments` config is supplied. It round-trips through the store and persistence **untyped** and no Claxedo reader consumes it. Declare it on `ImageAttachmentPart` (`prompt.tsx:36-42`) the moment a reader appears — otherwise it is silent data loss waiting to happen.
  - **Pre-existing LRU lifetime risk, recorded not hidden.** `promptCache` uses `createLruResourceCache`, which has no ref-counting — a mounted controller's scope is evictable once `MAX_PROMPT_SESSIONS` (20) other scopes load, and eviction disposes the reactive root, leaving the controller holding a tuple whose persist effect is dead. Not made worse by v2 (the existing wrapped API reads the same cache) and 20 concurrent scopes is beyond realistic pane counts. Captured as a passing characterisation test. If it ever needs fixing, swap to the sibling `createRefCountedResourceCache` — local to `prompt.tsx:117` + `load()`.
  - **Placement note:** the bridge lives in `prompt.tsx`, not `composer/v2/`, because the orphan guard rejects production modules with no production consumer (verified by probe: guard failed 4/1). `composer/v2/` holds the test only.

- **T2.2** Drive our frame from `createPromptInputV2Controller`, retiring `composer/ui/editor-actions.ts` (315), `popover-controller.ts` (223) and the local `store.popover`/history machinery in favour of the controller's dispatch. **DoD:** `core-composer-modes` passes — slash, shell, `@` mentions, attachments, drafts, history — with no selector-only masking. Consume T2.1's adapter; cross the session-ui boundary via `ui/session-kit.ts` type-only re-exports, never directly.
- **T2.3** Keep all eight §3 capabilities rendering in our frame, unchanged. **DoD:** their existing tests pass untouched. Any test that must change is called out as behaviour-preserving.
- **NO T2.x forks.** Option 4 forks nothing. If a fork appears necessary, that is a signal Option 4 is failing and belongs back with the owner, not a task to quietly add.

### W3 — The switch (strangler) — RESTATED
Option 4 keeps one frame, so there is no v2-vs-legacy *component* switch. The strangler boundary moves inward to the engine.
- **T3.1** Flag which engine drives the frame: our existing machinery or upstream's controller. **DoD:** both paths render the same frame; no shared mutable draft state; flipping does not lose a draft.
- **T3.2** Parity sweep unchanged in substance: `core-composer-modes`, `core-model-effort-agent-controls`, `core-harness-ownership-local` green with the controller path on, **no selector-only edits that mask a behaviour change** (a `data-action` may move; what it does may not).

### W4 — The dropdowns (the actual ask)
- **T4.1** Project selector with search + avatars, reworked for our project list (cloud / self-hosted / worktree concepts upstream lacks). **DoD:** search filters; avatars render; cloud UUID-named workspaces still disambiguate.
- **T4.2** Flat `+` menu with right-aligned keyboard hints, including **Commands (`/`)** and **Context (`@`)** — upstream dispatches `commands.open`/`context.open` state events, and our equivalent lever is `setStore("popover", "slash"|"at")`; both lists populate on an empty query ([popover-controller.ts:41](../../packages/claxedo-app/src/features/session/composer/ui/popover-controller.ts)). **DoD:** every menu entry opens its surface; none is inert.
- **T4.3** Adopt upstream's labels ("Images and files", "Commands", "Context", "Shell command"), retiring the i18n keys added on 2026-07-25 if superseded. **DoD:** locale parity + size-baseline guards green (16 locales, 17 ceilings, guard counts `split("\n")`).

### W5 — Cutover — RESTATED
- **T5.1** Flip the engine default to upstream's controller; our machinery retained one release. **DoD:** vision gate — both themes screenshotted, all four dropdowns measured consistent.
- **T5.2** Delete the retired editor/popover/history machinery. **NOTE:** Option 4 does **not** discard the 2026-07-25 composer redesign — the context row, approve control, merged model+effort and the shared dropdown normalisation all live in the frame we are keeping. The original W5.2 said to delete them; that no longer applies. **DoD:** guards green; `size-baseline.json` shrinks; no orphans.

### W6 — Standing re-sync (the accepted-risk mitigation)
- **T6.1 DONE 2026-07-25** — `docs/plans/evidence/2026-07-25-composer-v2-resync-procedure.md`. Recorded vendor point: the tree entered `dev` on 2026-07-18 via `6a33d82682`, byte-identical to upstream `efb6cc2d4b`. Baseline SHA for diffs is the tree's **last-touch** `b513fafe8354b85d1ba4609733b7f33c7b46b7d5` (2026-07-21), not `upstream` HEAD, which moves on unrelated commits and produces noisy diffs.
  - **`git merge-base dev upstream` is EMPTY — the histories are disjoint.** Never merge, rebase, or cherry-pick across the seam; re-sync is always read-diff-then-apply via scoped `git apply -3`.
  - **DoD REVISED — the original was unfalsifiable.** "One re-sync performed end-to-end" passes trivially today because *nothing imports the tree*, so it would prove nothing. Revised DoD: one re-sync performed **after W2 has wired at least one capability adapter**, so the procedure is exercised against real conflicts. Reviewer corollary: a re-sync PR touching only the vendored tree is incomplete.
  - Drift measurement that validated the procedure: 6 files, +166/−58 over 8 days, landing in `index.tsx` (+57/−41), `store.ts` (+37/−1), `interaction.ts` (+13/−11), `machine.ts` (+10/−5) — **precisely the adapter seam** — while `types.ts` held still. So `tsc` will NOT catch upstream's behavioural fix-tail; the procedure therefore applies upstream's tests alone and reads their failures *before* any adapter work.

## 5. Parallelization map (normative)

- **Wave 1:** T0.1 ∥ T0.2 ∥ T0.3 ∥ T0.4. Nothing ports until all four report.
- **Wave 2:** T1.1 → T1.2.
- **Wave 3 (widest fan-out — one agent per §3 capability, disjoint files):** the W2 tasks.
- **Wave 4:** T3.1 → T3.2, ∥ T4.1 ∥ T4.2 ∥ T4.3.
- **Wave 5:** T5.1 → T5.2, then T6.1.

## 6. Risks / honesty notes

- **The moving target is unmitigated.** 30% migrated, ~zero movement in a week. Every re-sync will conflict with our capability adapters. W6 exists because of this; T0.4 sizes it.
- ~~This discards most of the 2026-07-25 composer redesign~~ **NO LONGER TRUE under Option 4** — we keep our frame, so the context row, approve control, merged model+effort and the `claxedo-composer-menu` normalisation all survive. The findings behind them (unlayered-CSS override, `fitViewport` clipping, `Index`-vs-`For` remount, light-mode `bg-deep` collapse) remain load-bearing rather than historical.
- **Structural divergence:** upstream is `packages/app`; we are `packages/claxedo-app` with different layout context and helpers. `prompt-project-selector.tsx` is not a copy-paste.
- **The v2 token gate** (`BodyDesignClass`, `data-new-layout`) already applies body-wide here; confirm in T0.1 that the v2 prompt-input does not assume more of the v2 shell than we have.
- **Legacy/v2 coexistence in one composer** is the highest-risk state: two editors, two draft stores. T3.1's DoD explicitly requires no shared mutable state.
- **Sunk-cost honesty (THRESHOLD CLARIFIED — the original wording was self-contradictory).** This doc shipped with two different trip-wires: §6 said "three or more rows need forks of `interaction.ts`" while T0.2's DoD said "needs a fork" of any vendored file. T0.2 measured **0** by the first reading and **exactly 3** by the second, so the ambiguity decided nothing. The threshold is hereby: **forks of `interaction.ts` / `machine.ts` / `types.ts`** — the dispatch core and view model, i.e. the parts whose re-sync cost is highest and whose logic we cannot re-derive. Forks confined to `index.tsx` markup are a lesser concern and do not trip the wire on their own; they are recorded as T2.x tasks instead.

## 7. Definition of Done (plan-level)

- [ ] **W0** All four probes reported; a per-capability seam verdict exists for every §3 row. *Progress:* —
- [x] **W1** Upstream's `machine.test.ts` + `store.test.ts` green against the unmodified vendored tree. *Progress:* **T0.1/T1.1 done 2026-07-25** — 16/0, tsgo clean, zero logic changes, all files byte-identical to upstream. Was a version bump (already vendored at HEAD), which fixed 3 real state-machine bugs. T1.2 outstanding.
- [ ] **W2** Every §3 capability works against the v2 composer, with its existing tests passing and any test change justified as behaviour-preserving. *Progress:* —
- [ ] **W3** The three core composer e2e specs green with the flag on, no selector-only masking. *Progress:* —
- [ ] **W4** All four dropdowns searchable and visually consistent; **no `+` entry inert**; project avatars render; locale/size guards green. *Progress:* —
- [ ] **W5** v2 default, legacy deleted, guards green, baselines shrink. *Progress:* —
- [ ] **W6** One full re-sync performed as proof of procedure, vendor point recorded. *Progress:* —
- [ ] **Vision gate:** composer screenshotted in both themes at cutover, all dropdowns measured. *Progress:* —
- [ ] **Decision record updated:** `ui-v2-migration-deferred` memory rewritten to record the reversal, its date, and the 30%-stalled measurement that was accepted. *Progress:* —
