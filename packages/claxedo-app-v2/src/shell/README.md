# Shell

Owns: the app frame and nothing a feature knows about. Three regions and their headers, the shell layout machine, the router, the typed registries every domain and plugin fills, the command palette, and the phone behavior of the frame.

## Regions

- **Sidebar** (left): today's rail frame (`view/sidebar.tsx`): the `rail-sidebar` nav named "Projects and sessions", 260 px by default, with a 36 px header strip holding Hide Sidebar (Pin Sidebar while it peeks) and an 8 px resize grip on its right edge (220 to 520 px; dragging below 220 unpins it). Pinned, it sits in the row; unpinned, it is an overlay at the left that shows only while peeking and hides when the pointer leaves it. `main` mode shows what `AppShell` receives as `mainSidebar` (the rail); `settings` mode shows `SettingsSidebar`, the sections from the `settingsSections` registry grouped by `account`, `workspace`, `app`. The URL decides the mode: a page whose entry says `sidebar: "settings"` switches it.
- **Center**: today's workbench column (`role=main`, `--background-stronger`, a 12 px top-left corner from 768 px): the workbench of split panes (`src/workbench/`), or the page the URL names (`PageEntry`: Settings, projects, plugin pages), drawn by `PageView` with no tab or close control; its state is the URL.
- **Workspace panel** (right): `src/panel/`. The frame wraps the workbench column in its `WorkspaceArea`; the layout below decides whether it is shown.
- **Headers** (`view/workbench-header.tsx`): today's 36 px workbench header. While the sidebar is unpinned its left end holds Show Sidebar (hovering it peeks the rail, except right after Hide Sidebar until the pointer leaves) and, between drag zones, the compact tabs `AppShell` receives as `compactTabs` (the rail's `CompactSwitcher`); its right end holds New Session and New Terminal (`view/scope-buttons.tsx`, which run the `session.new` and `terminal.new` commands) and, over panes, the panel's `PanelToggle` while the panel is closed. A page gets the same header without the panel toggle; a settings page gets today's settings header (Show Sidebar and a Settings pill, only while unpinned).

## State machines

- **`ShellLayout`** (`model.ts`): `wide { sidebar, panel }` with the panel `open` or `collapsed` and the sidebar `open` (pinned), `collapsed` (unpinned) or `peeking` (unpinned and shown), or `phone { drawer, sheet }` with each overlay `open` or `closed`. Events: `viewportChanged`, `toggleSidebar`, `showSidebar`, `hideSidebar`, `peekSidebar` (only from `collapsed`), `unpeekSidebar` (only from `peeking`), `togglePanel`, `showPanel`, `hidePanel`, `navigated` (closes the phone overlays). The wide regions persist as preferences (`store.ts`) under the principal's scope, a peek as `collapsed`; phone overlays never persist.

## Routes (`routes.ts`)

Today's app's shapes, id-only: `/` (home), `/w/:placementId/session` (the placement's new-session draft), `/w/:placementId/session/:sessionId`, `/s/:sessionId` (a session on this machine, as today's rail links it; the router resolves its placement through the resolver RouteSync registers from the session list, and until then the route is `localSession`), `/w/:placementId/terminal/:terminalId`, `/settings/:section?`, each page's own `path`, and the `routes` registry for full-screen screens outside the shell (auth, onboarding) which match first. `RouteSync` opens the draft, session or terminal the URL names in the workbench (through the pane kinds' `fromRoute`) and mirrors the focused pane back into the URL with `replace` (through `toRoute`), unless the URL already names that session, so the URL is the one home of the current placement: `useShellRoute().placementId()`. With nothing focused on a placement's route it opens that placement's draft. A page registered with `tab: true` (the rail's Tasks and Marketplace) opens in today's one shared page tab instead of the center: the singleton `pageTab` pane kind (`view/page-tab.tsx`) keeps the page's path, so opening another tab page reuses it, the compact tabs show it as a global tab, and the header over it is the page header without the panel toggle. Closing it as the last tab goes home.

## Placement providers (`placement-providers.tsx`)

The workspace panel and the domains whose state is kept per placement (terminal, files, review, browser) mount their providers here with no props, under the commands provider inside the workbench; each reads the placement from `useShellRoute().placementId` and opens panes through `useWorkbench()`. The composer's draft store sits above the workbench and the panel, inside the principal's scope, so another principal starts with no drafts.

## Look (`styles/`)

The app wears today's app's look: `main.tsx` loads `styles/index.css` (the kit's Tailwind and session styles, plus the app's own layers) and `styles/ui-overrides.css` (the Codex overrides: SF Pro Text, zero letter-spacing, overlay geometry, hidden scrollbars), then the kit's menu, select and tooltip sheets, in that order. `ThemeProvider` from `@opencode-ai/ui/theme` runs the kit's theme set with Codex as the default and keeps the icon library in step with the theme. The root stays at the browser's 16px; the older `src/ui` sheet no longer sets the root's size, font or colors.

Rules in those sheets that code cannot explain:

- `styles/app-shell.css`:
  - The `--bp-*` properties are the layout thresholds on Tailwind's `sm`/`md`/`lg`/`xl`/`2xl` scale plus three document-editor widths, for `calc()` and inline styles. `@media` cannot read a custom property, so media rules keep the literal pixels (767 is the complement of `md`).
  - The modal stack is named, not guessed. Every layer is portaled to `<body>`, so only these numbers decide what paints over what. A dialog's layer wrapper sits in the same elevated context, so a dialog opened from another opens above it, and a select's portaled list clears the dialog layer.
  - Below `md` on a coarse pointer controls get a 40 px floor. `data-claxedo-compact-touch` exempts an element or a dense region such as the rail, whose full-width rows are the tap targets.
  - The palette gets an 8 px gutter and a 14 px radius, concentric with its rows. The palette and the page-scale dialogs dim their backdrop because the shared 0.2 alpha is invisible on dark chrome. The overlay is a sibling of the dialog layer, so the backdrop is selected from `<body>`, and it moves at the dialog's own 150 ms in and 100 ms out.
  - The main column is a positioned layer above the panel. The floating session stack's `z-index` is otherwise trapped in its pane's `contain: strict` context.
- `styles/index.css`:
  - The terminal font is `font-display: swap`. It is 1 MB, and text never waits on it.
  - The composer's dropdown normalisation is unlayered and uses a doubled class. The menu, select and list sheets ship unlayered rules, which beat any `@layer components` rule, and Vite's injection order is not guaranteed.
  - One surface, elevation and row spec covers the composer's `+` menu, selects and popover lists, so neighbouring menus keep one rhythm. Their width clamp is viewport-relative because they float above the pane.
  - The slider's thumb offset is a literal. The slider reads it back through `getComputedStyle`, which returns a custom property's text unresolved.
  - The dock collapses by container query on the space it owns. The harness/model chip keeps its label, because it is the only control naming what will answer.
  - The collapsed composer is driven by an attribute, not `:focus-within`. Its menus are portaled, and focus entering one would fold the card under it.

## Composition (`src/app.tsx`)

`AuthProvider` → registries → `I18nProvider` → `ThemeProvider` → `ShellRouter` → the server scope → `AppShell`. The server scope (`ServerProvider`, `SessionStoresProvider`, projects' `ProjectListProvider`, `DialogProvider`) is keyed by the signed-in user: signed in, `createServer` gets a bearer token source from `useAuth().token`; signed out, expired or signing in, no auth. Only a change of user rebuilds it, so a token refresh does not. `App` takes an optional `router` (for example `MemoryRouter` for a `file://` renderer; the default is the history router) and an optional `serverUrl` (the desktop's embedded server, known only at runtime; without it `createServer` uses the build's `VITE_CLAXEDO_SERVER_URL` or the page origin).

## Home (`home-redirect.tsx`)

`/` is never a screen of its own, as in today's app. When the projects list has loaded and is empty (`onboardingNeeded`), the shell replaces the URL with the onboarding screen; loading and failed lists never redirect. Otherwise it replaces `/` with the draft of the active workspace: the placement of the restored focused pane, else the folder placement of the first project `useProjectList()` lists.

## Registries (`registries.ts`, `registry.ts`)

One `Registry<Entry>` per region and concept: `pages`, `paneKinds`, `panelViews` (the workspace panel's "context" and "subagent" tab views, registered by the domains that own them so `src/panel` never imports them), `settingsSections`, `sidebarItems`, `overlays`, `commands`, `mentions`, `themes`, `iconSkins`, `routes`. `registry.ts` holds the static first-party arrays that import each domain's exports; plugins `add()` entries while they are on and dispose them when off.

## Command palette (`palette/`)

Kept from the old app: registrations with owners, keybinding parsing and display, user overrides persisted under `claxedo:keybinds`. The `commands` registry feeds it beside component registrations. No keybinding fires while a dialog is open. The palette is today's `DialogSelectFile` (`select-file.tsx`), the one implementation for both modes: the palette keybinding (mod+shift+P) runs `file.open` with the source `palette`, which opens it in `all` mode (empty: the common commands, then recent files; typed: every command, the current project's sessions and file search, grouped); mod+P opens it in `files` mode (recent and root files, then file search). Its caller passes the placement and `onOpenFile`; the shell's `OpenFileCommand` opens the file as a workspace panel tab, and the panel's "+" → File passes its own.

## Phone

Below 768 px the rail itself becomes a drawer that fills the viewport (an owner ruling over today's 280 px drawer beside a scrim), sliding in from the left over 300 ms, opened and closed by the fixed "Open navigation sidebar" button over the header's left end. The header there holds New Session only; New Terminal is desktop-only. The frame never scrolls horizontally.

## Flows

Flow 12 (workbench and shell), flow 26 (language switch and the accessibility sweep) and flow 33 (phone).
