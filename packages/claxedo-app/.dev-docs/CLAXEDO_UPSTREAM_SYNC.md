# Claxedo ↔ Upstream Sync Guide

This document tracks how this fork is kept in sync with `upstream/dev`, and records our **intentional deviations** from upstream so future rebases can be resolved consistently.

The fork is allowed to stay heavily drifted. The sync goal is not to erase that drift. The sync goal is to keep the drift intentional while still pulling in upstream bug fixes, refactors, and patterns that make the fork better.

## Version Table

| Claxedo Version | Upstream Commit | Last Sync Date |
|----------------|-----------------|----------------|
| dev (full rebase, pre-rebase squash) | 9bddf7f3e | 2026-04-30 |
| dev (full rebase) | 8cc2c81d5 | 2026-04-21 |
| dev (full rebase) | 94f71f59a | 2026-04-13 |
| dev (full rebase) | 988c9894f | 2026-04-08 |
| dev (full rebase) | 00fa68b3a | 2026-04-04 |
| dev (full rebase) | 6dfb30448 | 2026-04-03 |
| dev (theme list carryover) | 9f3c2bd86 | 2026-03-31 |
| dev (general settings carryover) | 9f3c2bd86 | 2026-03-31 |
| dev (permission toggle carryover) | 9f3c2bd86 | 2026-03-31 |
| dev (targeted carryover) | 9f3c2bd86 | 2026-03-30 |
| dev | d8fbe0af0 | 2026-03-12 |
| dev | d15c2ce34 | 2026-03-08 |
| dev | c4ffd93ca | 2026-03-04 |
| dev | d1938a472 | 2026-03-02 |
| dev | 2a2082233 | 2026-02-28 |
| dev | 799b2623c | 2026-02-26 |
| dev | dbf2c4586 | 2026-02-21 |
| dev | e345b89ce | 2026-02-18 |
| dev | 1413d77b1 | 2026-02-12 |
| dev | 7e1247c42 | 2026-02-11 |
| dev | d1f5b9e91 | 2026-02-10 |
| dev | de0f4ef80 | 2026-02-09 |
| dev | fedf9feba | 2026-02-07 |
| dev | 531b1941a | 2026-02-05 |
| dev | d116c227e | 2026-02-03 |

## Workflow

- Execute daily syncs using `../../.dev-docs/DAILY_UPSTREAM_SYNC_PLAYBOOK.md`.
- Resolve conflicts using `../../.dev-docs/REBASE_AGENT.md` + `../../.dev-docs/MERGE_CONFLICTS.md`.
- After a successful sync, update this table and add an entry to `../../.dev-docs/SYNC_LOG.md`.
- If new fork-owned modifications are discovered during the sync, add them to the registry below with a clear merge strategy.
- Use targeted carryovers freely when a full rebase is unnecessary.
- For upstream changes in areas we override, make an intentional port/skip/defer decision instead of assuming "no conflict" means "no work".

## Upstream Modifications Registry

When rebasing `fork/dev` onto `upstream/dev`, use this table to decide conflict resolution.

| Path | Why we modify | Merge strategy |
|------|---------------|----------------|
| `.github/workflows/beta.yml` | Disable scheduled runs on the fork | Keep ours |
| `.github/workflows/close-stale-prs.yml` | Disable scheduled runs on the fork | Keep ours |
| `.github/workflows/daily-issues-recap.yml` | Disable scheduled runs on the fork | Keep ours |
| `.github/workflows/daily-pr-recap.yml` | Disable scheduled runs on the fork | Keep ours |
| `.github/workflows/docs-update.yml` | Disable scheduled runs on the fork | Keep ours |
| `.github/workflows/stale-issues.yml` | Disable scheduled runs on the fork | Keep ours |
| `.github/workflows/stats.yml` | Disable scheduled runs on the fork | Keep ours |
| `packages/opencode/script/build.ts` | Allow offline dev builds by using `MODELS_DEV_API_JSON` or local fixture instead of fetching `models.dev` | Keep ours |
| `packages/desktop/scripts/predev.ts` | Desktop dev should build sidecar with cached models data (no network) | Keep ours |
| `packages/desktop/src-tauri/src/perf.rs` | Support `TAURI_ENV_OC_PERF*` env passthrough in `tauri dev` | Keep ours |
| `packages/desktop/src/perf.ts` | Ensure frontend perf timestamps reach Rust (`atMs` + `at_ms`) | Keep ours |
| `packages/desktop/src-tauri/src/cli.rs` | Avoid slow interactive shell startup (`-i`) when running the sidecar | Keep ours |
| `packages/desktop/src-tauri/src/lib.rs` | Claxedo-specific Tauri command/module wiring (`save_dropped_file`, license hooks, mermaid/os wiring) | Merge carefully |
| `packages/app/src/app.tsx` | Claxedo extension system wiring (`DesktopPerf` type + `wsl` in Window.__OPENCODE__) | Merge carefully |
| `packages/app/src/pages/layout.tsx` | Extension hooks + additional sidebar/workspace props | Merge carefully |
| `packages/app/src/pages/session.tsx` | Extension hooks (focusInput, etc.) | Merge carefully |
| `packages/app/src/context/command.tsx` | Widen `isTerminalElement` param to accept `undefined` | Keep ours |
| `packages/opencode/src/pty/escape-filter.ts` | Detect clear-scrollback sequences (new file, for upstream PR) | Keep ours |
| `packages/opencode/src/pty/index.ts` | Upstream manages this; we do NOT modify it | Accept upstream |
| `packages/opencode/src/server/routes/pty.ts` | Upstream manages this; we do NOT modify it | Accept upstream |
| `packages/app/src/utils/server-health.ts` | Widen `checkServerHealth` to accept `HttpBase` objects (upstream API compat) | Merge carefully |
| `packages/app/src/components/prompt-input.tsx` | Adds `sessionID`, `navigateOnCreate`, `system`, `agent` props for embedded/multi-session contexts | Merge carefully |
| `packages/app/src/pages/session/composer/session-composer-state.ts` | Split-pane composer session resolution + todo lifecycle handling | Merge carefully |
| `packages/app/src/pages/session/composer/session-question-dock.tsx` | Keep the latest upstream question-dock behavior unless Claxedo adds explicit customizations | Accept upstream |
| `packages/app/src/pages/session/message-timeline.tsx` | Adds `sessionID` prop for split panes | Merge carefully |
| `packages/app/src/pages/session/terminal-panel.tsx` | Fork terminal integration changes | Merge carefully |
| `packages/app/src/context/sync.tsx` | Fork session cache + debug logging modifications | Merge carefully |
| `packages/app/src/context/global-sync/event-reducer.test.ts` | Fork test modifications | Keep ours |
| `packages/app/src/pages/session/composer/session-composer-region.tsx` | Adds sessionID, sessionDirectory, navigateOnCreate, system, agent props | Merge carefully |
| `packages/opencode/src/server/server.ts` | Keep `Server.App` compat alias for Claxedo patches while upstream uses `Default`/`createApp` | Merge carefully |
| `packages/ui/src/theme/themes/aura.json` | Claxedo keeps a forked Aura palette/theme definition | Keep ours |

## 2026-03-30 Targeted Carryover

### Ported During This Carryover

- `packages/app/src/pages/session/composer/session-question-dock.tsx`
  - Ported the latest upstream question-dock cleanup: extracted option/check primitives, explicit `type="button"` on option buttons, shared answered-state logic, and safer custom-answer focus/autoresize handling.
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
  - Reviewed against `upstream/dev`; current fork delta is intentionally limited to forwarding `system` and `agent` into `PromptInput`.
- `packages/app/src/pages/session/composer/session-composer-scope.ts`
  - Removed the stale helper because upstream deleted it and no current caller still uses it.
- `packages/ui/src/theme/themes/aura.json`
  - Moved the forked Aura theme onto upstream's newer `palette` schema while preserving the Claxedo-specific chrome, markdown, and syntax tuning.

### Theme Inventory Check

- Compared `packages/ui/src/theme/themes/` with `upstream/dev` at `9f3c2bd86`.
  - The branch already includes the current upstream theme file set, so there was no separate "new theme" import missing from the fork.

## 2026-03-31 Permission Toggle Carryover

### Ported During This Carryover

- `packages/claxedo-app/src/overrides/components/prompt-input.tsx`
  - Replaced the old bottom-left chevron permission toggle with the upstream-style tray `shield` button and aligned the no-session state with directory-level auto-accept, matching current upstream behavior more closely.
- `packages/claxedo-app/src/overrides/pages/session/use-session-commands.tsx`
  - Updated the `permissions.autoaccept` command so new sessions use directory-level toggling instead of disabling the command until a session exists.

## 2026-03-31 General Settings Carryover

### Ported During This Carryover

- `packages/claxedo-app/src/overrides/components/settings-general.tsx`
  - Restored the newer upstream General settings rows for reasoning summaries, shell tool-part expansion, edit tool-part expansion, and follow-up behavior while keeping the Claxedo-specific section layout and analytics hooks.

## 2026-03-31 Theme List Carryover

### Ported During This Carryover

- `packages/claxedo-app/src/components/settings-appearance.tsx`
  - Switched the theme picker to load the full upstream theme catalog on mount and derive options from `theme.ids()` / `theme.name()` instead of the lazily populated theme map, which was why only a couple of themes appeared in Claxedo.
- `packages/claxedo-app/src/overrides/pages/layout.tsx`
  - Updated theme cycling to use the same upstream theme registry so layout-level theme switching also sees the complete theme set.

## 2026-03-12 Carryover Review

### Ported During This Sync

- `packages/claxedo-app/src/overrides/context/platform.tsx`, `packages/claxedo-app/src/desktop/index.tsx`, `packages/claxedo-desktop-electron/src/preload/index.ts`, `packages/claxedo-desktop-electron/src/preload/types.ts`, `packages/claxedo-desktop-electron/src/renderer/index.tsx`
  - Ported upstream default-server API rename from `getDefaultServerUrl`/`setDefaultServerUrl` to key-based `getDefaultServer`/`setDefaultServer`.
- `packages/claxedo-app/src/overrides/components/status-popover.tsx`
  - Ported upstream `useCheckServerHealth()` wiring and default-server key lookup so the custom server UI follows the new platform contract.
- `packages/claxedo-app/src/overrides/context/terminal.tsx`
  - Ported upstream terminal persisted-state migration to recover missing or duplicate `titleNumber` values from old terminal snapshots.
- `packages/claxedo-app/src/overrides/utils/persist.ts`
  - Ported the upstream Windows-safe workspace storage-name sanitization, and applied the same fix to our server-scoped storage variant.
- `packages/claxedo-app/src/overrides/app.tsx`
  - Ported upstream `ConnectionGate` startup-health checks, retry loop, and alternate-server fallback UI into the Claxedo-authenticated app shell.
- `packages/claxedo-app/src/overrides/pages/session.tsx`
  - Ported upstream cursor-based active-message tracking, terminal-first autofocus, `forceScrollToBottom()` semantics, `sync.session.todo()` refresh, and revert/fork/restore flows while preserving split-pane/session-param behavior.
- `packages/claxedo-app/src/claxedo-ui/components/compact-prompt-dock.tsx`
  - Ported the upstream todo-dock lifecycle state machine so stale todos clear instead of sticking around in compact/review docks.
- `packages/claxedo-app/src/claxedo-ui/components/tab-review.tsx`, `packages/claxedo-app/src/claxedo-ui/components/review-workspace.tsx`
  - Added the matching session todo refresh/clear behavior for standalone review surfaces that do not use the upstream composer path directly.
- `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-terminal.tsx`, `packages/claxedo-app/src/overrides/components/terminal.tsx`
  - Applied the terminal carryovers that still mapped cleanly in Claxedo: disable pane-level auto-focus stealing and accept palette-only theme variants.

### Direct Upstream Files We Merged This Sync

- `packages/app/src/pages/session/composer/session-composer-state.ts`
  - Kept our embedded session resolution while also taking upstream todo clear/close behavior.
- `packages/app/src/pages/session/composer/session-composer-region.tsx`
  - Kept fork session embedding props and accepted upstream revert-dock support/layout sizing changes.
- `packages/app/src/pages/session/message-timeline.tsx`
  - Kept split-pane navigation/session props while accepting upstream session header actions, comment guards, and active-status rendering.
- `packages/app/src/pages/session/terminal-panel.tsx`
  - Kept Claxedo terminal integration while accepting upstream terminal focus/jank fixes and panel animation changes.
- `packages/opencode/src/server/server.ts`
  - Accepted upstream `createApp`/`Default` refactor and preserved a one-line `export const App = Default` alias for Claxedo compatibility.
- `packages/ui/src/theme/themes/aura.json`
  - Kept the Claxedo Aura palette instead of upstream's regenerated version.

### Remaining Override Follow-Up

- `packages/claxedo-app/src/overrides/pages/session.tsx`
  - Review-pane empty/loading logic still follows the older switch tree; upstream simplified it and added the Git-init empty-state CTA in the shared `reviewEmpty()` path.
- `packages/claxedo-app/src/claxedo-ui/components/tab-review.tsx`, `packages/claxedo-app/src/claxedo-ui/components/review-workspace.tsx`
  - Session-message action parity is still partial outside the main timeline path; if we need full parity, audit how fork/revert/restore and rename/archive/delete should surface in these standalone review panes.

### Non-1:1 Areas To Audit

- Terminal bugfixes from `packages/app/src/pages/session/terminal-panel.tsx` and `packages/app/src/components/terminal.tsx` are not 1:1 with our split-pane implementation.
  - `pane-terminal.tsx` and `overrides/components/terminal.tsx` have the carryovers that mapped directly; keep `pane-terminal-logic.ts` on the watch list if pane-specific timing bugs recur.
- Review/session actions from `packages/app/src/pages/session.tsx` and `packages/app/src/pages/session/message-timeline.tsx` are partly rehomed in Claxedo.
  - The main session page now has the upstream restore-to-message / fork / revert flow; `tab-review.tsx` and `review-workspace.tsx` still need a deliberate product decision if they should expose the same message/session management actions.
- Todo-dock lifecycle fixes from `packages/app/src/pages/session/composer/session-composer-state.ts` may surface outside the upstream composer path in Claxedo.
  - `compact-prompt-dock.tsx` now mirrors the upstream lifecycle; if stale todo UI reappears, inspect any other custom dock surface before assuming the bug is back in the shared composer files.

## Notes

- `packages/claxedo-app/**` and `packages/app-shared/**` are Claxedo-owned; keep ours on conflicts.
- Lockfiles: accept upstream during rebase, then regenerate with `bun install` once the rebase finishes.
