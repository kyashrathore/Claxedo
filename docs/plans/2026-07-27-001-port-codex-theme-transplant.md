# Port the Codex theme clean transplant onto dev

- **Date:** 2026-07-27
- **Status:** IN PROGRESS
- **Port branch:** `port/codex-theme-transplant` (worktree `.worktrees/theme-port`)
- **Port base:** `dev` at `654df1d1ee`
- **Source branch:** `codex/theme-clean-transplant` at `04b2076bdd`
- **Source plan:** `docs/plans/2026-07-26-001-refactor-codex-theme-clean-transplant-plan.md`

## 1. Why this is a reconciliation, not a merge

`codex/theme-clean-transplant` was cut from `dev` at `0a1b7d5c56` as a reviewable
reconstruction of the throwaway exploration on `codex/icon-manifest`. The
exploration branch — not the reconstruction — is what reached `dev`, via
`9bf1b251b0`, because the permission-mode work rode on the same branch. The WIP
theme commit `bd62cfbe74` came with it.

So `dev` and the source branch now hold two implementations of the same work, and
`dev` has since gained fixes the reconstruction never saw. A `git merge` produces
43 conflicts and would revert real work. Every group below states which side wins
and why.

`git cherry dev codex/theme-clean-transplant`: 32 of 33 commits unported. True
file surface: 60 code files, of which 14 apply cleanly.

## 2. Rules for every group

- Work only inside `.worktrees/theme-port` on `port/codex-theme-transplant`.
- Touch only the files listed for your group. Another agent owns the rest.
- Commit with `git commit --only -- <paths>`. Never `git add -A`, `git commit -a`,
  `git stash`, `git checkout <branch>`, or `git rebase` — the index is shared
  across worktrees and a bare commit sweeps other agents' staged files.
- Read the source with `git show codex/theme-clean-transplant:<path>` and
  `git diff 654df1d1ee codex/theme-clean-transplant -- <path>`.
- Port intent, not bytes. Where `dev` has moved on, keep `dev`'s behavior and add
  only what is genuinely new.
- Verification is per-group and must be real output, not an assertion.

## 3. Invariants that survive the port

These exist on `dev` and MUST still be true afterwards:

1. **Licence notes stay.** `packages/ui/src/components/icon.tsx`,
   `packages/ui/src/components/codex-icons.tsx` and
   `packages/claxedo-app/src/ui/icons/codex.ts` carry a warning that the
   `codex-20-*` artwork is extracted from the proprietary ChatGPT desktop app.
   The source branch predates that audit and deletes it. Do not delete it.
2. **Icon resolution must not throw.** `Icon` falls back to the upstream set for
   an unmapped name. The source branch's `defineIconLibrary.resolve()` throws
   inside render, which unmounts the tree. Keep the fallback.
3. **`iconLibrary` stays a runtime signal.** `setIconLibrary` must keep working;
   do not reduce it to a module constant.
4. **The permission picker stays as `dev` has it** — Auto plus the expand
   drill-down. The source branch predates it and removes 212 lines of it.
5. **The composer notice row stays.** One row, one message, one action.
   Per-control "Unavailable" labels do not come back.
6. **The settings dialog stays undraggable** (`3a9a86af8e`, "no drag") and keeps
   its `claxedo-settings-dialog` class.

## 4. Groups

### Wave A — independent of theme tokens

**A1 — theme foundation.** `packages/ui/src/theme/color.ts`, `resolve.ts`,
`index.ts`, `semantic.test.ts` (new), `styles/tailwind/colors.css`,
`themes/oc-2.json`, `v2/components/progress-circle-v2.css`.
Carries the sRGB luminance fix (`0.587` → `0.7152`), `SEMANTIC_THEME_ROLE_FALLBACKS`,
and the contrast-derived icon/overlay colors.
**DoD:** `semantic.test.ts` present and passing; every role in
`SEMANTIC_THEME_ROLE_FALLBACKS` resolves to a defined value for every bundled
theme in both schemes (no `undefined` reaching a token); package typecheck clean.

**A2 — navigation icons.** `packages/ui/src/components/codex-icon-map.tsx`,
`packages/claxedo-app/src/ui/icons/codex.ts`,
`packages/claxedo-app/src/ui/controls/claxedo-icon.tsx`,
`packages/claxedo-app/src/ui/icons/manifest.ts`,
`packages/claxedo-app/src/ui/icons/registry.test.ts`.
`marketplace`, `models` and `providers` currently all alias `codex-20-123` — one
sparkle for three different things. Point them at the distinct custom glyphs.
**DoD:** the three aliases resolve to three different symbols; invariants 1–3
verified by grep in the committed files; registry test asserts every resolved id
is a real symbol in `sprite.svg`; app typecheck clean.

**A3 — select value rendering.** `packages/ui/src/components/select.tsx`,
`select.css`, `packages/claxedo-app/src/ui/select-rendering.vitest.tsx` (new),
and the `renderValue` wiring only in
`packages/claxedo-app/src/features/session/ui/controls/agent-harness-selector.tsx`.
`HarnessOptionIcon` is currently dead code on `dev` — defined, never called —
because `Select` has no `renderValue`. Add the prop and call it.
**DoD:** harness trigger and menu rows both render the harness mark; no other
change to that file (notice row, `modelHint` aria-label and `modelLabel` stay
exactly as `dev` has them); new vitest passes.

**A4 — marketplace responsiveness.**
`packages/claxedo-app/src/features/extensions/marketplace/marketplace.css` (new),
`panel.tsx`, `cards.tsx`.
Container queries replace viewport breakpoints.
**Fix while porting:** the source renders a second full copy of the category list
for the compact layout, so two "Featured"/"Installed"/"On this machine" buttons
sit in the accessibility tree at once. Render one list and reposition it.
**DoD:** exactly one control per category in the DOM at any width; layout adapts
to pane width, not viewport width; app typecheck clean.

### Wave B — after A1

**B1 — theme surfaces.** `packages/claxedo-app/src/app/styles/ui-overrides.css`,
`index.css`, `packages/ui/src/theme/themes/codex.json`, `codex.test.ts`,
`packages/claxedo-app/src/ui/context-card/context-card.css`,
`packages/ui/src/components/dock-surface.css`, `dropdown-menu.css`,
`context-menu.css`, `popover.css`, `toast.css`, `tooltip.css`,
`dropdown-menu.tsx`, `v2/components/menu-v2.css`, `select-v2.css`, `toast-v2.css`,
`tooltip-v2.css`, `packages/claxedo-app/public/oc-theme-preload.js`.
`dev` holds only the WIP version of these (`bd62cfbe74`, plus `654df1d1ee`); the
source branch's reconstruction wins, but `654df1d1ee`'s light-shell fix must
survive.
**Note:** the source writes inline `color`/`background-color` onto `<html>` in the
preload, which outranks every stylesheet rule on the root element, and hardcodes
four theme colors. Port the `colorScheme` and theme-color parts; leave the
inline paint out unless it is demonstrably needed to stop a first-paint flash.
**DoD:** Codex light and dark both render correct shell surfaces; no other
bundled theme regresses; `codex.test.ts` passes; the light-shell behavior from
`654df1d1ee` still holds.

**B2 — small clean carries.**
`packages/claxedo-app/src/app/workbench/review/review-close.ts` (new) and its
call in `review-workspace.tsx`,
`packages/claxedo-app/src/features/session/composer/submit-block-wiring.ts`,
`submit-control.tsx`, `packages/ui/package.json`.
**Decisions:** `submit-block-wiring` should prefer the harness picker explicitly
rather than relying on `querySelector` document order. Do **not** add
`src/assets/icons/codex/*` to the published `files` array — that would ship the
extracted artwork in the `@claxedo/ui` npm tarball. Record instead that published
consumers currently have no codex sprite.
**DoD:** clicking a dimmed send control with no model opens the model picker;
review tab close routes through `closeReviewWorkspaceTab`; focused tests pass.

### Wave C — product slices (reconciliation-heavy)

**C1 — composer slices.** `frame.tsx`, `model-control.tsx`, `add-menu.tsx`,
`menu-metrics`. Responsive control collapse, menu widths and grouping.
**C2 — workbench slices.** `rail-sidebar.tsx`, `workspace-toolbar.tsx`,
`global-navigation.tsx`, `workbench-shell-header.tsx`, `compact-switcher.tsx`,
`review-toolbar.tsx`, `select-directory.tsx`.
**C3 — remaining icon callsites.** `session-context-row.tsx`,
`message-timeline.tsx`, `select-model.tsx`, `session-navigation-list.tsx`,
`session-new-design-view.tsx`, `document-index.tsx`, `slash-popover.tsx`,
`terminal-surface-navigation.tsx`, `claxedo-icon-button.tsx`,
`context-card.tsx`, `v2-edit-icon.tsx`.
**DoD for each:** no `dev` behavior removed; icon names resolve; app typecheck
clean; the `semantic-icon.tsx` `isolationLocal`/`isolationWorktree` collision from
the source branch is NOT adopted — those two must stay visually distinct.

## 4a. Decisions taken during the port

- **`packages/ui/script/extract-codex-icons.ts` is NOT ported.** It hardcodes
  `/Applications/ChatGPT.app/Contents/Resources/app.asar` and unpacks the
  renderer bundle — it *is* the extraction step invariant 1 exists to flag.
  The `generate:codex-icons` package script is therefore also left out, since it
  would point at a file that does not exist here. Porting the script is a
  deliberate owner decision, not a mechanical carry.
- **`src/assets/icons/codex/*` stays out of `@claxedo/ui`'s published `files`.**
  Consequence, recorded rather than fixed: consumers installing from npm get no
  codex sprite, and `codex-20-*` names resolve to the upstream fallback. The fix
  is either shipping extracted artwork or replacing it — owner's call.
- **`bun.lock` is committed** with the `ajv` devDependency. Three CI workflows
  run `bun install --frozen-lockfile`; a `package.json`-only change breaks them.
- **The `Select` trigger no longer falls back to `children`** (A3, `7661f2e064`).
  A ported test asserts this deliberately. Callsites that relied on the fallback
  are fixed at the callsite, not by restoring the fallback.

### Cross-group item: the send-arrow contrast fix is split

Source commit `a3b03f4829` has three parts that land in three different groups:
the click-resolution behavior (B2, done), the
`[data-variant="primary"][data-icon-interaction="persistent"]` CSS rule (B1),
and the `data-icon-interaction` default flip in `claxedo-icon-button.tsx` (C3).
**The regression it fixes is not repaired until all three land**, and the
symptom only reappears once C3 flips the default. Do not close this out on B2's
commit alone.

## 5. Known open item

The source branch's last recorded request — the archive icon staying invisible on
row hover, asked to be solved as a group rule rather than one icon at a time —
was never answered before that session ended. It is not fixed at `04b2076bdd` and
this port does not fix it.

## 6. Verification

Per group as stated above, plus a final pass on the port branch:

- app typecheck clean
- `packages/ui` theme tests pass
- focused vitest for every file group that has one
- Codex light, Codex dark, and one non-Codex theme rendered and visually checked
  before this branch is offered for merge
