# 01 — Runtime architecture

## Scope
Process model, server-child lifecycle, IPC, packaging, auto-update — the
Electron-main replacement.

## Current implementation (canonical files)
- Spawn + env contract: `packages/claxedo-desktop/src/main/index.ts` (~line
  400 fork), `scripts/claxedo-server-startup.ts` (env: CLAXEDO_CHILD_PORT,
  CLAXEDO_DESKTOP_PARENT_PID, CLAXEDO_DATA_DIR, engine/compile-cache paths).
- Ready handshake: `src/shared/claxedo-server-lifecycle.ts` (typed IPC
  message; `LocalServer.ready` resolves on the listening event — fixed this
  session, 5e22972). Health verify before URL publish.
- Exec flags: `src/main/server-runtime-policy.ts`
  (`--expose-gc --optimize-for-size --max-old-space-size=512`) — flag hash
  keys the V8 compile cache (`src/shared/opencode-compile-cache.ts`).
- Packaging: `electron-builder.config.ts` (asar invariant, four native
  modules, locale pruning, size ratchet in `verify-package-contents.ts`).

## Target design
- One Rust binary: GPUI shell + UI. Spawns the SAME server-child bundle with
  Node (ships a minimal Node runtime or uses the engine's — decide in Phase 0
  spike: measure shipping node vs bun single-file for the server bundle).
- IPC: keep the child's stdio/IPC ready message verbatim (parse the same
  JSON shape) so the server side needs zero changes. Everything else the
  renderer needs already flows over loopback HTTP/SSE.
- Window state, menus, tray, deep links, single-instance: gpui/gpui-component
  natives; inventory from `src/main/*` in the parity matrix (10).
- Updater: replace electron-updater with platform-standard (Sparkle-style /
  MSI / AppImage-update or a first-party delta updater); keep the channel
  metadata contract (`app-update.yml` semantics) if feasible.

## Spike (Phase 0) + kill criterion
Rust program that spawns the packaged server bundle, receives the ready IPC,
GETs /provider, renders the model list in a gpui-component `List`.
KILL if the child cannot be supervised (orphan cleanup, crash restart per
`restart-policy.ts` semantics) with <200 lines of glue.

## Acceptance
Cold start to server-ready ≤ current Electron shell stage (readyMs ~5.0 s on
the Linux container, HANDOFF-comparable on mac); process family = 2 (app +
server child) + engine in-child; RSS gate per main plan.
