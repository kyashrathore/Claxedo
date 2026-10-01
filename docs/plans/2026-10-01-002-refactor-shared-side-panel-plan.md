# Shared side panel

Owner: this chat. Scope: `claxedo-app/src/ui/controls/side-panel*`, shared resize and motion, workspace panel wrappers, Marketplace details, and their flow checks. The test app's build directory is configurable in `e2e/harness/app.ts` to isolate this run from other active suites. Existing plan edits belong to other work.

- [x] Extract controlled `SidePanel`, header, tabs, controls, resize and motion with no workspace dependencies.
- [x] Keep workspace state, navigation, toolbars and terminal resize policy in workspace wrappers.
- [x] Move Marketplace plugin and personal details into one Details tab, without add-tab or navigator controls.
- [x] Verify workspace behavior, selection replacement, resize, maximize, close and phone layout through real flows; run app checks, typechecks, tests, build and architecture ratchets, recording the remaining failures below.

Reviewed budgets: generic presentation lives in UI and shared sizing/motion in lib; workspace-specific data remains in the panel wrapper. Desktop renderer source closure is exactly 1245 modules (formerly 1239), with 36 packages unchanged. The full desktop `verify:closure` passed its production build, packaged-resource tests, and emitted manifests after updating that exact module ceiling. Marketplace's aggregate domain budget is 2399 (formerly 2353), accounting for the single-tab wrapper, maximize/phone policy and unified personal details; workspace code shrank to 1633 lines. No per-file or per-function ceiling changes. Pre-existing Composer (+66) and Notifications (+52) aggregate violations remain outside this task.

## Validation

From `packages/claxedo-app`:

- `bun run typecheck`: pass.
- `bun run typecheck:e2e`: pass.
- `bun run test`: 405 pass, 0 fail.
- `bun run check`: 18 of 19 checks pass. Only the pre-existing Composer and Notifications aggregate budgets fail; Marketplace, all file/function sizes, ownership, domain boundaries and CSS checks pass.
- `bun run e2e --project=web --project=phone --grep 'Marketplace details use|Tasks and Marketplace show no workspace'`: 3 pass, 3 project skips.
- Red proof: change the Details tab label to Close temporarily, then `bun run e2e --project=web --grep 'Marketplace details use'`: fails expecting one Details tab, receiving zero. The production source was restored immediately afterward.
- `bun run e2e --project=web --project=phone --grep 'Marketplace details use' --repeat-each=20`: 20 consecutive desktop passes before interruption to fix the observed phone tab-close overlap. Phone's final implementation was then proven by the isolated run below.

The phone repeat initially collided with another suite's shared build/results: its app build stamp changed from server port 46100 to 46103 while this run was active. `CLAXEDO_E2E_DIST_DIR` now allows independent builds, while the existing port-range setting and Playwright output/reporter arguments isolate runtime and artifacts.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-dist CLAXEDO_E2E_PORT_RANGE=46781-46799 CLAXEDO_E2E_DAEMON_PORT=46781 bun run e2e --project=phone --grep 'Marketplace details use' --repeat-each=20 --output=/tmp/claxedo-side-panel-phone-results --reporter=list
```

Result: 20 consecutive phone passes, 20 desktop-only project skips. Includes a 44 px close target, tab-label/close separation, full-width layout and no horizontal scroll.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-regression-dist CLAXEDO_E2E_PORT_RANGE=46801-46819 CLAXEDO_E2E_DAEMON_PORT=46801 bun run e2e --project=web --project=phone --grep 'Marketplace details use|Tasks and Marketplace show no workspace|opened panel paints|edge drags and steps|switching back to a session whose panel was open|drawer, two sessions' --output=/tmp/claxedo-side-panel-regression-results --reporter=list
```

Result: 8 pass, 8 project skips. Proves workspace pointer/keyboard resizing, width persistence, first-frame sizing, navigator/session recovery and the phone workspace flow. Light/dark screenshots inspected for both desktop and phone Marketplace Details.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-regression-dist CLAXEDO_E2E_PORT_RANGE=46801-46819 CLAXEDO_E2E_DAEMON_PORT=46801 bun run e2e --project=phone --grep 'drawer, two sessions|hover shows on touch' --output=/tmp/claxedo-side-panel-touch-results --reporter=list
```

Result: 2 pass after the workspace tab strip was changed to fill the shared header height.

From `packages/claxedo-desktop`, `bun run verify:closure`: pass on the final source, including production build, 14 packaged-resource tests and all three emitted manifests.

From the repository root, `bun run test:architecture-ratchets`: 21 ratchet unit tests and all six source-closure policies pass, as does the helpers ratchet. The final file-size scan fails on unchanged tracked Storybook output: `assets/iframe-D288tw9h.js` (2511 lines), `sb-manager/globals-runtime.js` (78957), and `sb-manager/runtime.js` (28253). These files predate this work. Owner: the Storybook/file-size gate; follow-up: remove generated output from the production-source scan or address those tracked generated artifacts in its own slice. Composer/Notifications budget ownership remains with those domains. CI and the full performance benchmark were not run.

`git diff --check`: pass. Unrelated plan and transcript-corpus edits were left untouched.

## Full-height shell correction

User screenshots showed Details below the shell toolbar: the first implementation shared the panel frame but mounted its area inside Marketplace's page body. `SidePanelSlot` now registers the page-owned panel and inset in the outer `SidePanelArea`, which contains both the toolbar and page body. `SidePanelScope` reads only caller-supplied active state; `PageTab` supplies that state so hidden retained page content cannot replace a session's workspace panel. The shell owns the mount surface, Marketplace still owns selection and Escape/close policy, and all workspace data remains in its wrapper.

The new module is reached through `ui/index.ts` by shell and Marketplace, and directly by `side-panel.tsx`; it introduces no packages or workspace imports. The reviewed renderer closure is 1245 modules, 36 packages. The full desktop `bun run verify:closure` passes its production build, 14 packaged-resource tests and three emitted manifests. Shell/platform's aggregate budget is 6628 (formerly 6617), accounting for the page active scope and full-height page host; Marketplace's is 2399 for the slot and Escape handler. File and function budgets still pass.

- `bun run typecheck` and `bun run typecheck:e2e`: pass.
- `bun run test`: 405 pass, 0 fail.
- `bun run check`: 18 of 19 pass; only unchanged Composer and Notifications aggregate violations remain.
- `bun run test:architecture-ratchets`: 21 unit tests, six source policies and helpers pass; unchanged generated Storybook files still fail the final file-size scanner.
- Light and dark screenshots inspected at desktop and phone widths. The panel's top and height match `shell-center`; its toggle is in the first toolbar row; the desktop toolbar's right edge meets the panel's left edge. Session navigation removes the page panel and restores the workspace panel.
- Red proof: a temporary test applies the former 36 px downward offset to the real panel, then invokes the actual Marketplace acceptance helper. The geometry assertion fails with expected y 1 and actual y 37. The temporary test was removed; production code was unchanged.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-height-dist CLAXEDO_E2E_PORT_RANGE=46821-46839 CLAXEDO_E2E_DAEMON_PORT=46821 bun run e2e --project=web --project=phone --grep 'Marketplace details use|Tasks and Marketplace show no workspace' --output=/tmp/claxedo-side-panel-height-results --reporter=list
```

Result: 3 pass, 3 project skips. Repeat validation uses the same environment and grep with `--repeat-each=20 --output=/tmp/claxedo-side-panel-height-repeat`. Result: 60 pass, 60 project skips in 5.7 minutes: 20 consecutive desktop Details runs, 20 consecutive desktop page-to-workspace isolation runs, and 20 consecutive phone Details runs. No failures or retries.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-height-red-dist CLAXEDO_E2E_PORT_RANGE=46841-46859 CLAXEDO_E2E_DAEMON_PORT=46841 bun run e2e --project=web --grep '99 red proof' --output=/tmp/claxedo-side-panel-height-red-results --reporter=list
```

Result: one intentional failure at the panel-top assertion. The temporary CSS perturbation and its test were removed.

The native app was restarted with root `bun run dev`; its renderer serves at `http://127.0.0.1:5173/index.local.html` and its real daemon is healthy on port 2593. The running Marketplace Details and skill view were observed through the desktop accessibility tree. Left running for the user.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-height-red-dist CLAXEDO_E2E_PORT_RANGE=46841-46859 CLAXEDO_E2E_DAEMON_PORT=46841 bun run e2e --project=web --project=phone --grep 'opened panel paints|edge drags and steps|switching back to a session whose panel was open|drawer, two sessions' --output=/tmp/claxedo-side-panel-height-workspace --reporter=list
```

Result: 5 pass, 5 project skips. Covers first-frame workspace sizing, left and right navigator pointer/keyboard sizing and persistence, restoring the file tree on session return, and the phone drawer/session/workspace panel flow with accessibility and overflow checks.

## Cleanup and reuse rule

The workspace open toggle and panel header close toggle now share `SidePanelToggle`, including icon state, accessibility labels and touch sizing. Workspace file-list prefetch stays in its wrapper. Removed the duplicate `PanelWidthInput`, unused width constants and the private workspace toggle's export. The replaced Marketplace pane frames, workspace exposure helper and workspace settle helper are deleted; live source and flow imports point only to their shared replacements. Historical transcript fixtures remain evidence and are not production callers.

`src/ui/AGENTS.md` requires the shared panel components, full-height shell host, active-page isolation and domain wrappers for caller-specific data and policy. The app-level `AGENTS.md` links this rule so domain callers also receive it. UI, Marketplace, panel and shell ownership documentation names the canonical components.

Final cleanup validation from `packages/claxedo-app`: `bun run typecheck` and `bun run typecheck:e2e` pass; `bun run test` has 405 passes, zero failures; `bun run check` has 18 of 19 passing checks with the same two pre-existing domain-budget violations. From `packages/claxedo-desktop`, `bun run verify:closure` passes the production build, 14 packaged-resource tests and three emitted manifests. From the root, `bun run test:architecture-ratchets` passes 21 unit tests, six source policies and the helpers ratchet; only the same three unchanged generated Storybook files fail its final scanner.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-commit-touch-dist CLAXEDO_E2E_PORT_RANGE=46881-46899 CLAXEDO_E2E_DAEMON_PORT=46881 bun run e2e --project=phone --grep 'drawer, two sessions|hover shows on touch' --output=/tmp/claxedo-side-panel-commit-touch --reporter=list
```

Result: 2 pass, including the shared workspace toggle's 44 px touch target.

```sh
CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-side-panel-commit-dist CLAXEDO_E2E_PORT_RANGE=46861-46879 CLAXEDO_E2E_DAEMON_PORT=46861 bun run e2e --project=web --project=phone --grep 'Marketplace details use|Tasks and Marketplace show no workspace' --repeat-each=20 --output=/tmp/claxedo-side-panel-commit-repeat --reporter=list
```

Result: 60 pass, 60 project skips in 5.1 minutes, with no failures or retries. Each of desktop Details, desktop active-page/workspace isolation and phone Details passed 20 consecutive runs on the final production source. `git diff --check` and `git diff --cached --check` pass. CI and the full performance benchmark remain unrun. Commit scope excludes the unrelated Tasks/LOC/hosted-agent plans and transcript-corpus work.
