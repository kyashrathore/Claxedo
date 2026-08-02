# `src/ui/controls/` — reusable presentation primitives

This directory holds presentation-only controls with demonstrated reuse
across features and app workbench surfaces (icons, logo, portal slot,
breakpoint/reduced-motion helpers, file-tree helpers). The admission rule
lives in `../AGENTS.md` and is guard-enforced (`src/architecture/ownership.ts`):
`ui/` may import only `lib/` and external packages — never `@/app/*`,
`@/features/*`, or `@/platform/*`.

## Where to add a new component

- Reused by two or more features AND imports no product state? → here.
- Specific to one feature (its dialogs, docks, panels, toolbars)? → that
  feature's `ui/` directory (e.g. `src/features/session/ui/`).
- Cross-feature application chrome (titlebar, rail, pane furniture)? →
  `src/app/workbench/`.
- Cross-feature dialogs composed by the app (settings shell, provider
  connect, server select)? → `src/app/dialogs/`.

## History

This file previously documented the pre-refactor `src/components/` vs
`src/claxedo-ui/components/` split and their mutual-import debt. That
topology was dissolved by the 2026-07-12 domain-ownership refactor;
the bidirectional-import problem it described is now structurally impossible
under the ownership guard. See git history for the old text.
