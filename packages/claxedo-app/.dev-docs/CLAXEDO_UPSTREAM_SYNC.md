# Claxedo ↔ Upstream Sync Guide

This document tracks how this fork is kept in sync with `upstream/dev`, and records our **intentional deviations** from upstream so future rebases can be resolved consistently.

## Version Table

| Claxedo Version | Upstream Commit | Last Sync Date |
|----------------|-----------------|----------------|
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
| `packages/app/src/pages/session/message-timeline.tsx` | Adds `sessionID` prop for split panes | Merge carefully |
| `packages/app/src/pages/session/terminal-panel.tsx` | Fork terminal integration changes | Merge carefully |
| `packages/app/src/context/sync.tsx` | Fork session cache + debug logging modifications | Merge carefully |
| `packages/app/src/context/global-sync/event-reducer.test.ts` | Fork test modifications | Keep ours |
| `packages/app/src/pages/session/composer/session-composer-region.tsx` | Adds sessionID, sessionDirectory, navigateOnCreate, system, agent props | Merge carefully |
| `packages/opencode/src/server/server.ts` | Keep `Server.App` compat alias for Claxedo patches while upstream uses `Default`/`createApp` | Merge carefully |
| `packages/ui/src/theme/themes/aura.json` | Claxedo keeps a forked Aura palette/theme definition | Keep ours |

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
  - Still needs the upstream session-page carryover from `packages/app/src/pages/session.tsx`: removal of `createScrollSpy`, the inline history-window rewrite, `reviewSnap`, terminal-first autofocus, revert/fork/restore helpers, and the newer `MessageTimeline` action wiring.
- `packages/claxedo-app/src/overrides/pages/session.tsx`
  - Replace the old `autoScroll.smoothScrollToBottom()` + `scrollSpy.markDirty()` flow with upstream `forceScrollToBottom()`/cursor-based active-message tracking, otherwise we stay exposed to the same scroll jitter and title/active-message drift bugs.
- `packages/claxedo-app/src/overrides/pages/session.tsx`
  - Review-pane empty/loading logic still follows the older switch tree; upstream simplified it and added the Git-init empty-state CTA in the shared `reviewEmpty()` path.
- `packages/claxedo-app/src/overrides/app.tsx`
  - Still missing upstream `ConnectionGate` startup-health check, retry loop, and alternate-server fallback screen.

### Non-1:1 Areas To Audit

- Terminal bugfixes from `packages/app/src/pages/session/terminal-panel.tsx` and `packages/app/src/components/terminal.tsx` are not 1:1 with our split-pane implementation.
  - Audit `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-terminal.tsx`, `packages/claxedo-app/src/claxedo-ui/components/multi-pane/pane-terminal-logic.ts`, and `packages/claxedo-app/src/overrides/components/terminal.tsx` for the same focus, reconnect, and scroll-jank classes of bugs.
- Review/session actions from `packages/app/src/pages/session.tsx` and `packages/app/src/pages/session/message-timeline.tsx` are partly rehomed in Claxedo.
  - Audit `packages/claxedo-app/src/overrides/pages/session/use-session-commands.tsx`, `packages/claxedo-app/src/claxedo-ui/components/tab-review.tsx`, and `packages/claxedo-app/src/claxedo-ui/components/review-workspace.tsx` for parity with restore-to-message, fork, revert, and rename/archive/delete UX.
- Todo-dock lifecycle fixes from `packages/app/src/pages/session/composer/session-composer-state.ts` may surface outside the upstream composer path in Claxedo.
  - If stale todo UI reappears, inspect `packages/claxedo-app/src/claxedo-ui/components/compact-prompt-dock.tsx` and any other session-embedded dock code before assuming the bug is limited to the upstream composer files.

## Notes

- `packages/claxedo-app/**` and `packages/app-shared/**` are Claxedo-owned; keep ours on conflicts.
- Lockfiles: accept upstream during rebase, then regenerate with `bun install` once the rebase finishes.
