# 06 — Workbench shell

## Scope
Rail sidebar, panes/splits/tabs, navigation, layout persistence, dialogs,
toasts, command palette.

## Current implementation
- Workbench state: `packages/claxedo-app/src/app/workbench/**` — NOTE the
  reconcile-by-id store contract (N-reactivity tests + the wholesale-replace
  fix f65f0e6): port as "update in place, never replace identity".
- Rail: `rail-sidebar.tsx` (+status helper split), per-row selectors
  (createSelector fix) — in Rust this is per-row memoized state by design.
- Layout persistence: `claxedo.state.v5` persisted shape (see demo seed in
  `app/entry/main.tsx` for the schema); route spine guard defines the
  navigation contract (`architecture/app-route-spine.guard.test.ts`).
- Suspense scoping lesson (a0b91a5): loading states must be PANE-LOCAL.

## Target design
- gpui-component Dock/Tiles for panes+splits+tabs (it ships dock layouts
  with persistence); map the v5 persisted layout to its serialization, with
  a one-way migrator from existing user state.
- Rail as a gpui-component List with per-row state; keyboard nav from the
  chord inventory (04).
- Dialog/toast/palette: gpui-component Modal/Notification/Command palette
  equivalents; inventory in parity matrix.

## Acceptance
workspace-switch and pane-management scenarios at 12's gates; layout
round-trips v5 state; no whole-tree invalidation on navigation (frame
instrumentation shows only affected panes redraw — GPUI paint stats).
