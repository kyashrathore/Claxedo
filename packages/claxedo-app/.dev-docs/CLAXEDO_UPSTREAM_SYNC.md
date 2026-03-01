# Claxedo ↔ Upstream Sync Guide

This document tracks how this fork is kept in sync with `upstream/dev`, and records our **intentional deviations** from upstream so future rebases can be resolved consistently.

## Version Table

| Claxedo Version | Upstream Commit | Last Sync Date |
|----------------|-----------------|----------------|
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
| `packages/app/src/app.tsx` | Claxedo extension system wiring (`DesktopPerf` type + `wsl` in Window.__OPENCODE__) | Merge carefully |
| `packages/app/src/pages/layout.tsx` | Extension hooks + additional sidebar/workspace props | Merge carefully |
| `packages/app/src/pages/session.tsx` | Extension hooks (focusInput, etc.) | Merge carefully |
| `packages/app/src/context/command.tsx` | Widen `isTerminalElement` param to accept `undefined` | Keep ours |
| `packages/opencode/src/pty/escape-filter.ts` | Detect clear-scrollback sequences (new file, for upstream PR) | Keep ours |
| `packages/opencode/src/pty/index.ts` | Upstream manages this; we do NOT modify it | Accept upstream |
| `packages/opencode/src/server/routes/pty.ts` | Upstream manages this; we do NOT modify it | Accept upstream |
| `packages/app/src/utils/server-health.ts` | Widen `checkServerHealth` to accept `HttpBase` objects (upstream API compat) | Merge carefully |

## Notes

- `packages/claxedo-app/**` and `packages/app-shared/**` are Claxedo-owned; keep ours on conflicts.
- Lockfiles: accept upstream during rebase, then regenerate with `bun install` once the rebase finishes.
