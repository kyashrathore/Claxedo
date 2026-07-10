# `src/components/` vs `src/claxedo-ui/components/`

Two directories are both literally named "components" (`src/components/`,
59 top-level files plus 3 subdirectories — `prompt-input/`, `session/`,
`server/` — 125 files total; and `src/claxedo-ui/components/`, a flat
directory of 65 files, no subdirectories) with no charter
distinguishing them anywhere in the codebase before this document — a
first-time contributor asking "where do I add a UI component" gets two
equally plausible, cross-wired answers. This file is that charter.

**They are layers, not duplicates.** `src/components/` is the fork-era
component library — generic, mostly upstream-lineage dialogs, settings
panels, and session UI. `src/claxedo-ui/components/` is the tab/pane app
shell composing that library into Claxedo's workbench (page editor, review
tabs, workspace-panel diagnostics, arena dock). Verified sample contents:

- `src/components/`: `dialog-select-model.tsx`, `dialog-select-mcp.tsx`,
  `dialog-settings.tsx`, `settings-providers.tsx`, `file-tree.tsx`,
  `network-policy-settings.tsx`, `prompt-input/`, `session/`, `server/` —
  these are standalone dialogs/panels/forms with no dependency on the
  workbench's pane/tab machinery to render.
- `src/claxedo-ui/components/`: `page-editor.tsx` + `page-editor-*.ts(x)`
  (the tab-hosted document editor), `review-tab.tsx` + `review-*` (VCS
  review inside a workbench tab), `page-arena-dock.tsx`,
  `dialog-process-diagnostics.tsx`, `directory-scope.tsx` — these are
  specifically things that live *inside* a workbench pane/tab, or that
  configure how the workbench renders content.

## Current reality: they import each other (unresolved)

There is no enforced one-directional rule today — this is flagged as a
`[high]` architecture finding, not a solved problem. Verified both
directions:

- `src/claxedo-ui/components/` → `src/components/`:
  `review-workspace.tsx` imports `@/components/session/session-context-tab`
  and `@/components/dialog-select-file`;
  `src/claxedo-ui/claxedo-layout-actions/project-actions.tsx` imports
  `@/components/dialog-select-directory` and `@/components/dialog-settings`;
  `src/claxedo-ui/claxedo-layout-actions/session-actions.tsx` imports
  `@claxedo/components/session/cloud-startup-view`;
  `src/claxedo-ui/components/agent-harness-selector.tsx` imports
  `@claxedo/components/dialog-select-model`;
  `src/claxedo-ui/content-renderers/context-content.tsx` imports
  `@claxedo/components/session`;
  `src/claxedo-ui/workspace-panel/WorkspaceFilesNavigator.tsx` imports
  `@/components/file-tree`.
- `src/components/` → `src/claxedo-ui/`: `dialog-select-file.tsx` imports
  `@claxedo/claxedo-ui/state`; `prompt-input/frame.tsx` and
  `prompt-input/submit-control.tsx` import
  `@claxedo/claxedo-ui/components/session-status-stage`;
  `prompt-input/toolbar-controls.tsx` imports
  `@claxedo/claxedo-ui/components/agent-harness-selector`;
  `session/session-context-tab.tsx` imports
  `@claxedo/claxedo-ui/context/session-params` and
  `@claxedo/claxedo-ui/context/session-sync`; `session/session-header.tsx`
  and `titlebar.tsx` import `claxedo-ui/components/claxedo-icon` via
  relative paths; `session/session-new-view.tsx` and
  `session/session-new-design-view.tsx` import
  `@claxedo/claxedo-ui/components/claxedo-logo`.

## Target rule (not enforced at this granularity yet)

`components/` should be importable with no dependency on `claxedo-ui/`'s
pane/tab/layout machinery — a dialog should not need to know it's running
inside a workbench tab to render. `claxedo-ui/components/` may freely import
generic pieces from `components/` (icons, dialogs, session UI it hosts) —
that direction is legitimate composition. The direction that should NOT
exist is `components/` reaching into `claxedo-ui/`'s pane/tab/state internals
(`@claxedo/claxedo-ui/state`, `@claxedo/claxedo-ui/context/session-*`) —
those five import sites listed above are the debt to unwind, not a pattern
to extend. A directional-layering guard now exists
(`src/architecture/layering.ts` + `layering-baseline.json`, see
`../ARCHITECTURE.md`), but it operates at the directory-pair level and
`claxedo-ui<->components` is already a seeded baseline cycle — so the guard
does not block a new PR from adding a sixth import site within this
already-cycled pair, only from introducing a cycle with a directory that
isn't cycled with `components/` yet.

## Where to add a new component

- Is it a dialog, settings panel, or generic session-UI piece with no
  dependency on which pane/tab it's rendered inside? → `src/components/`.
- Does it configure or render workbench-specific chrome (a new tab-hosted
  content type, a workspace-panel widget, review/page-editor tooling)? →
  `src/claxedo-ui/components/`.
- If genuinely unsure, prefer `src/components/` and thread any
  workbench-specific wiring in through props rather than importing
  `claxedo-ui/` internals directly — that keeps you on the correct side of
  the target rule above even though the existing layering guard doesn't
  enforce it at the individual-import-site level yet.

## See also

`src/ARCHITECTURE.md` for the full directory charter list and the
`context/` ↔ `shell/` cycle (the other confirmed layering violation in the
package). `src/VOCABULARY.md` for the pane/tab/panel/group word list this
directory split leans on.
