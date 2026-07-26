# Codex theme and semantic surface cleanup

- **Date:** 2026-07-26
- **Status:** READY FOR IMPLEMENTATION
- **Target branch:** local `dev`
- **Source branch:** `codex/icon-manifest`
- **Source icon commit:** `6c89773345` (`feat(ui): add semantic Codex icon registry`)

## 1. Objective

Land the reusable parts of the Codex visual exploration on `dev` as a sequence
of reviewable changes.

The resulting design has:

- a theme-neutral contract for sidebar, header, composer, context-card, control,
  row, and overlay surfaces;
- defaults for every desktop theme;
- a Codex theme that supplies verified light and dark values through that
  contract;
- stable application hooks that components expose without knowing which theme
  consumes them;
- a semantic icon registry and independently reviewable callsite migration;
- product and interaction changes isolated from theme work.

The source working tree contains 114 changed files with approximately 1,436
additions and 506 deletions after the icon-registry commit. It is an exploration
workspace rather than a single commit candidate. Implementation reconstructs
the accepted slices from a clean branch based on local `dev`.

## 2. Scope

### 2.1 Included

- Semantic shell and overlay theme roles.
- Codex light and dark theme registration.
- Sidebar, header, workspace-tab, composer, context-card, settings, and overlay
  surface bindings.
- Stable `data-slot`, `data-surface`, and icon-interaction hooks.
- Shared dropdown, select, context-menu, popover, tooltip, and toast consumption
  of semantic overlay roles.
- Semantic Codex icon assets, manifest, registry, adapters, and selected
  callsite migrations.
- Cross-theme contract tests and focused visual verification.
- Boot-time light/dark surface correctness.

### 2.2 Accepted product slices

These changes have their own product behavior or geometry and land through
separate commits:

- responsive composer control collapse;
- composer menu widths and grouping;
- permission-mode row descriptions;
- project and worktree picker grouping, scrolling, and sticky creation actions;
- compact-switcher identity and metadata presentation;
- Review workspace close behavior;
- directory-picker close behavior;
- submit, stop, scroll-to-latest, and terminal-close controls.

### 2.3 Repository hygiene

The transplant excludes local runtime output and generated browser bundles:

- `packages/storybook/debug-storybook.log`
- `app-initial-BHB6SClA.js`

## 3. Architecture

### 3.1 Semantic theme roles

Shared components consume role names that describe purpose rather than a
specific theme:

| Role family | Required roles |
|---|---|
| Shell | `shell-surface-sidebar`, `shell-surface-header` |
| Conversation | `shell-surface-composer`, `shell-surface-context-card` |
| Controls | `control-surface`, `control-surface-active`, `control-border` |
| Rows and tabs | `row-surface-hover`, `row-surface-selected`, `tab-surface-selected` |
| Overlay | `overlay-surface`, `overlay-surface-hover`, `overlay-surface-input` |
| Overlay content | `overlay-text`, `overlay-text-muted`, `overlay-icon`, `overlay-icon-muted` |
| Borders | `shell-border-sidebar`, `shell-border-header`, `composer-border`, `overlay-border` |

`resolveThemeVariant` derives defaults for every theme from the existing
background, surface, text, icon, and border scales. Individual themes may
override any role.

The Codex palette supplies explicit verified values. Other themes receive the
same semantic hierarchy without becoming coupled to Codex naming.

### 3.2 Shape and elevation

Theme overrides remain color values. Overlay radius, shadow, padding, and
border width are component-owned structural constants. Shared legacy and V2
overlay primitives define those constants in their own CSS and consume theme
roles only for color.

The desktop theme schema, TypeScript types, resolver, and JSON themes agree on
the accepted color-value shape. An automated schema-validation test loads every
bundled theme JSON file through `desktop-theme.schema.json`; type assertions are
not the validation boundary.

### 3.3 Application surface hooks

Application components expose stable semantic hooks:

- `data-surface="sidebar"`
- `data-surface="header"`
- `data-surface="composer"`
- `data-surface="context-card"`
- `data-surface="overlay"`
- `data-slot="workbench-tab"`
- `data-slot="workspace-tab"`
- `data-slot="composer-toolbar"`

Production styling uses these hooks. Test identifiers remain dedicated to test
selection.

Base component CSS owns the generic role binding. Codex-scoped CSS owns only
Codex typography, optical sizing, and other presentation that is unique to the
theme.

### 3.4 Overlay primitives

Legacy and V2 overlay primitives consume the same semantic roles:

- ContextMenu
- DropdownMenu
- Popover
- Select
- Toast
- Tooltip
- MenuV2
- SelectV2
- ToastV2
- TooltipV2

Non-Codex themes preserve their established border geometry unless their
resolved semantic roles explicitly request a different border. Adding a theme
does not alter box sizing for every other theme.

### 3.5 Icon system

The semantic icon manifest is a production input to the registry:

```text
feature code
  -> semantic AppIconName
  -> production manifest
  -> active/inactive state mapping
  -> selected icon library glyph
  -> SVG renderer
```

The manifest remains readable by developers and agents. The runtime adapter
uses it to resolve semantic names and active-state relationships before
selecting a library glyph, so production reachability reflects real behavior
rather than a guard-only import. Tests validate manifest completeness and the
active-state relationships.

Icon interaction metadata is independent of the glyph library:

- `passive`: informational icon; row state supplies emphasis.
- `row-action`: action revealed by row hover or selection.
- `binary`: icon communicates an on/off state.
- `persistent`: always-present standalone action.
- `subdued`: low-hierarchy affordance.

Theme CSS defines color and hover presentation for these states. Row actions
are also revealed through `:focus-within`. Binary controls expose their state
through the native or ARIA state owned by the control, and their active glyph
remains distinguishable without hover.

## 4. Source audit

### 4.1 Theme definition and registration

Primary source files:

- `packages/ui/src/theme/themes/codex.json`
- `packages/ui/src/theme/codex.test.ts`
- `packages/ui/src/theme/default-themes.ts`
- `packages/ui/src/theme/context.tsx`
- `packages/claxedo-app/index.html`

`public/oc-theme-preload.js` owns pre-paint scheme selection. Before the
application module loads, it resolves stored light, dark, or system preference,
sets `color-scheme`, installs the chosen cached theme CSS when present, and
applies light/dark fallback background and foreground values to the root.
`index.html` consumes those variables and does not force a dark fallback.

### 4.2 Theme-specific presentation

`packages/claxedo-app/src/app/styles/ui-overrides.css` currently contains the
Codex visual exploration. Its concerns split into:

1. verified Codex typography and optical styling;
2. generic semantic surface binding;
3. icon interaction grammar;
4. overlay token adaptation;
5. component geometry for model and directory pickers;
6. review-list border treatment.

Only the first concern remains in a broad
`html[data-theme="codex"]` presentation block. The other concerns move to their
own generic or component-owned locations.

### 4.3 Shared component changes

The following files contain reusable overlay work:

- `packages/ui/src/components/context-menu.css`
- `packages/ui/src/components/dropdown-menu.css`
- `packages/ui/src/components/popover.css`
- `packages/ui/src/components/select.css`
- `packages/ui/src/components/toast.css`
- `packages/ui/src/components/tooltip.css`
- `packages/ui/src/v2/components/menu-v2.css`
- `packages/ui/src/v2/components/select-v2.css`
- `packages/ui/src/v2/components/toast-v2.css`
- `packages/ui/src/v2/components/tooltip-v2.css`

Their clean form references semantic overlay roles and retains cross-theme box
geometry.

### 4.4 Product and API changes

The source tree also contains independently reviewable behavior:

| Change | Source |
|---|---|
| Custom selected-value rendering for shared Select | `packages/ui/src/components/select.tsx` |
| Review tab closes workspace panel | `app/workbench/review/review-workspace.tsx` |
| Responsive composer controls | `app/styles/index.css` |
| Permission descriptions inside menu rows | `features/session/composer/ui/permission-control.tsx` |
| Grouped Add menu | `features/session/composer/ui/add-menu.tsx` |
| Sticky project/worktree actions | `app/styles/index.css`, `session-context-row.tsx` |
| Project avatar and metadata-card presentation | `app/workbench/compact-switcher/compact-switcher.tsx` |
| Explicit directory-dialog close action | `app/dialogs/select-directory.tsx` |
| Submit and scroll button presentation | `submit-control.tsx`, `message-timeline.tsx` |

These are not prerequisites for the semantic theme contract.

## 5. Required corrections before transplant

### 5.1 Preserve permission semantics

Every non-empty `PermissionModeOption.caveat` remains discoverable.

Shared timing text may render once when all options have the same value.
Option-specific caveats render with the corresponding option or in an
unambiguous menu footer. This includes:

- application beginning with the next message;
- application to the next agent rather than the current session;
- Claxedo answering prompts when the harness itself enforces nothing.

### 5.2 Bound responsive menus

Composer menus use available inline or viewport width:

```css
width: min(360px, calc(100vw - 24px));
min-width: 0;
```

Compact and harness variants retain their preferred widths while yielding to
the available space. Verification includes 320px and a squeezed multi-pane
composer.

### 5.3 Keep Select render responsibilities explicit

`children` continues to render option rows. A separately named property such as
`renderValue` renders the selected trigger value.

This API change lands with focused tests demonstrating:

- plain string options;
- custom option rows with a plain trigger;
- custom option rows with a custom trigger;
- grouped options;
- placeholder and current-value behavior.

### 5.4 Wire the icon manifest into production

`packages/claxedo-app/src/ui/icons/manifest.ts` becomes a production dependency
of the registry or adapter. The architecture orphan guard passes without adding
the manifest to a debt baseline.

### 5.5 Keep context-card and composer roles independent

The floating environment card consumes
`shell-surface-context-card`. The composer consumes
`shell-surface-composer`. Each role resolves independently in light and dark
variants for every theme.

### 5.6 Preserve recent upstream theme parity

The transplant includes the retained UI portions of recent upstream theme
changes:

- `DockSurface` composer underlays use `data-dock-border-underlay="v2"` in the
  Claxedo composer and the shared dock stylesheet contains the corresponding
  border-underlay rule.
- `ProgressCircleV2` uses the base icon token for track contrast.

These changes receive focused source assertions and visual coverage alongside
the shell and overlay work.

### 5.7 Define responsive control priority

At narrow composer widths, controls collapse in this order:

1. secondary labels and descriptive text;
2. optional model metadata;
3. low-frequency picker actions into the existing add menu.

Permission mode, model identity, attachment access, and submit or stop remain
keyboard reachable. Menus use viewport-bounded widths at 320px and in squeezed
multi-pane layouts.

### 5.8 Treat the Codex palette as approved source data

`themes/codex.json` is the canonical checked-in palette. A focused fixture in
the Codex theme test records the approved light and dark semantic values and
contrast pairs. Tests compare the resolved theme against that independent
fixture so edits to the implementation cannot silently redefine the expected
palette.

## 6. Commit plan

Implementation leaves the exploration worktree untouched. Create a separate
clean worktree and `codex/theme-clean-transplant` branch from local `dev`, record
the source HEAD, and confirm that the source worktree's staged, unstaged, and
untracked files remain available. Mixed source files are reconstructed by hunk
rather than committed wholesale.

### C1 — `refactor(ui): wire semantic icon manifest`

- Repair production manifest consumption in `6c89773345`.
- Preserve extracted SVGs, aliases, catalog, registry, adapters, and tests.
- Pass the Claxedo architecture orphan guard.

### C2 — `refactor(theme): add semantic shell and overlay roles`

- Add generic resolved roles for every theme.
- Align the TypeScript and JSON-schema contracts.
- Add all-theme role-completeness tests.
- Keep radius and shadow within their declared contract.

### C3 — `feat(theme): add Codex theme`

- Register Codex.
- Add verified light and dark palette values.
- Add focused palette and contrast tests.
- Add Codex-specific typography and optical treatment.

### C4 — `refactor(app): expose themeable shell surfaces`

- Bind sidebar, header, tabs, composer, context card, settings, and controls.
- Use stable semantic hooks.
- Keep context-card and composer surfaces independent.

### C5 — `refactor(ui): theme overlay primitives by semantic role`

- Migrate legacy and V2 overlays to the generic overlay contract.
- Preserve established geometry for existing themes.
- Cover one light and one dark non-Codex theme.
- Include the shared dock border-underlay and progress-circle upstream parity
  fixes.

### C6 — `refactor(app): migrate semantic icon callsites`

- Migrate import-only and glyph-mapping changes.
- Include sidebar folder states and panel-toggle states.
- Keep interaction behavior unchanged.

### C7 — `feat(app): add stateful icon interaction grammar`

- Apply passive, row-action, binary, persistent, and subdued semantics.
- Verify hover-revealed actions and active/inactive binary states.

### C8 — accepted feature commits

Each product slice receives its own commit and tests:

1. `fix(composer): preserve permission-mode caveats`
2. `fix(composer): make controls responsive`
3. `refactor(composer): structure picker menus`
4. `feat(ui): separate select row and value renderers`
5. `refactor(workbench): refine compact switcher identity`
6. `feat(workbench): close review workspace from its tab`
7. `fix(app): align directory and terminal close actions`
8. `refactor(app): align session action controls`

## 7. Verification

### 7.1 Automated gates

Run from package directories:

```bash
cd packages/ui
bun typecheck
bun test src/theme

cd ../claxedo-app
bun typecheck
bun run test:vitest -- <focused changed suites>
```

Required focused coverage:

- every default theme resolves all semantic shell and overlay roles;
- every bundled theme JSON file validates against the desktop theme schema;
- Codex light and dark values match the approved palette;
- shared overlay primitives preserve non-Codex rendering contracts;
- icon manifest is complete and production-reachable;
- row actions reveal on hover and keyboard focus, and binary controls expose
  their state;
- permission caveats remain discoverable;
- Select row and trigger renderers remain independent;
- Review-panel and directory-panel closing are covered;
- composer controls and menus remain usable at 320px and in a narrow pane;
- composer dock underlays and V2 progress contrast match current upstream.

### 7.2 Visual matrix

Capture the following surfaces in Codex light, Codex dark, one non-Codex light
theme, and one non-Codex dark theme:

- sidebar with selected project and session;
- workbench header and selected tabs;
- composer idle, focused, enabled-submit, and running states;
- floating context card;
- dropdown, select, tooltip, toast, and model picker;
- overlay hover, focus, selected, disabled, and destructive states;
- narrow composer with collapsed controls.

The visual gate confirms:

- sidebar, composer, and context card remain distinguishable;
- overlays retain readable text and visible inputs;
- borders remain hairline rather than changing component geometry;
- portalled surfaces follow the active theme contract;
- active icon states communicate state without relying on hover.

## 8. Baseline evidence

Audit verification performed on 2026-07-26:

- `packages/ui`: `bun typecheck` passed.
- Codex theme tests: 2 passed.
- Focused Claxedo Vitest suites: 54 tests passed across 9 files.
- Theme-token lint passed.
- Claxedo architecture suite reported one orphan production module:
  `ui/icons/manifest.ts`.
- The source working-tree diff passed `git diff --check`.

## 9. Definition of done

### Icon system

- [ ] Icon manifest is used by production and the icon commit passes architecture checks.

### Theme contract

- [ ] Every default theme resolves generic shell and overlay roles.
- [ ] Codex is registered as a normal theme using the generic role contract.
- [ ] Sidebar, composer, and context card have independent surface roles.
- [ ] Shared overlay primitives contain no Codex-prefixed dependencies.
- [ ] Theme schema and TypeScript types accept exactly the values themes provide.
- [ ] Existing themes preserve their established overlay geometry.
- [ ] Every bundled theme validates against the desktop theme schema.
- [ ] First paint follows stored light, dark, and system preference.

### Application behavior

- [ ] Permission-mode caveats remain discoverable.
- [ ] Narrow composer menus remain inside the available viewport.
- [ ] Select option-row and selected-value rendering remain independent.
- [ ] Row actions and binary icon controls remain keyboard and screen-reader discoverable.
- [ ] Recent upstream dock-underlay and progress-contrast changes are present.
- [ ] Product behavior changes are isolated in independently reviewable commits.

### Repository hygiene

- [ ] Storybook logs and generated browser bundles are absent from commits.

### Verification

- [ ] Automated and visual verification matrices pass.
