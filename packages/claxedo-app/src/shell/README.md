# Shell

Owns: the app frame and nothing a feature knows about. Three regions and their headers, the shell layout machine, the router, the typed registries every domain and plugin fills, the command palette, and the phone behavior of the frame.

## Regions

- **Sidebar** (left): today's rail frame (`view/sidebar.tsx`): the `rail-sidebar` nav named "Projects and sessions", 260 px by default, with a 36 px header strip holding Hide Sidebar (Pin Sidebar while it peeks) and an 8 px resize grip on its right edge (220 to 520 px; dragging below 220 unpins it). Pinned, it sits in the row; unpinned, it is an overlay at the left that shows only while peeking and hides when the pointer leaves it. `main` mode shows what `AppShell` receives as `mainSidebar` (the rail); `settings` mode shows `SettingsSidebar`, the sections from the `settingsSections` registry grouped by `account`, `workspace`, `app`. The URL decides the mode: a page whose entry says `sidebar: "settings"` switches it.
- **Center**: today's workbench column (`role=main`, `--background-stronger`, a 12 px top-left corner from 768 px): the workbench of split panes (`src/workbench/`), or the page the URL names (`PageEntry`: Settings, projects, plugin pages), drawn by `PageView` with no tab or close control; its state is the URL.
- **Workspace panel** (right): `src/panel/`. The frame wraps the workbench column in its `WorkspaceArea`; the layout below decides whether it is shown.
- **Headers** (`view/workbench-header.tsx`): today's 36 px workbench header. While the sidebar is unpinned its left end holds Show Sidebar (hovering it peeks the rail, except right after Hide Sidebar until the pointer leaves) and, between drag zones, the compact tabs `AppShell` receives as `compactTabs` (the rail's `CompactSwitcher`); its right end holds New Session and New Terminal (`view/scope-buttons.tsx`, which run the `session.new` and `terminal.new` commands) and, over panes, the panel's `PanelToggle` while the panel is closed. A page gets the same header without the panel toggle; a settings page gets today's settings header (Show Sidebar and a Settings pill, only while unpinned).

## State machines

- **`ShellLayout`** (`model.ts`): `wide { sidebar, panel }` with the panel `open` or `collapsed` and the sidebar `open` (pinned), `collapsed` (unpinned) or `peeking` (unpinned and shown), or `phone { drawer, sheet }` with each overlay `open` or `closed`. Events: `viewportChanged`, `toggleSidebar`, `showSidebar`, `hideSidebar`, `peekSidebar` (only from `collapsed`), `unpeekSidebar` (only from `peeking`), `togglePanel`, `showPanel`, `hidePanel`, `navigated` (closes the phone overlays). The wide regions persist as preferences (`store.ts`) under the principal's scope, a peek as `collapsed`; phone overlays never persist. An event that changes no region returns the same state object, so no reader re-runs: opening a file in the open panel sends `showPanel`, and a fresh object re-ran the session timeline's virtualizer options and its bottom anchor, a forced layout inside the click.

## Routes (`routes.ts`)

Today's app's shapes, id-only: `/` (home), `/w/:placementId/session` (the placement's new-session draft), `/w/:placementId/session/:sessionId`, `/s/:sessionId` (a session on this machine, as today's rail links it; the router resolves its placement through the resolver RouteSync registers over the session list's `rowOf`, which knows every row the store holds, not only the rail's visible window; until then the route is `localSession`. The route changes only when the URL or the resolved placement does, never on a list update, so nothing downstream (the layout's `navigated`, the workbench's `openRoute`) runs because another session changed), `/w/:placementId/terminal/:terminalId`, `/settings/:section?`, each page's own `path`, and the `routes` registry for full-screen screens outside the shell (auth, onboarding) which match first. `RouteSync` opens the draft, session or terminal the URL names in the workbench (through the pane kinds' `fromRoute`) and mirrors the focused pane back into the URL with `replace` (through `toRoute`), unless the URL already names that session, so the URL is the one home of the current placement: `useShellRoute().placementId()`. With nothing focused on a placement's route it opens that placement's draft. A page registered with `tab: true` (the rail's Tasks and Marketplace) opens in today's one shared page tab instead of the center: the singleton `pageTab` pane kind (`view/page-tab.tsx`) keeps the page's path, so opening another tab page reuses it, the compact tabs show it as a global tab, and the header over it is the page header without the panel toggle. It never takes part in a split, because the workbench refuses to split a `singleton` kind's content or split beside it: its pane has no drag handle, a row dropped on it opens as if clicked, and `mod+\` splits in the most recent other content. Closing it as the last tab goes home.

## Placement providers (`placement-providers.tsx`)

The workspace panel and the domains whose state is kept per placement (terminal, files, review, browser) mount their providers here with no props, under the commands provider inside the workbench; each reads the placement from `useShellRoute().placementId` and opens panes through `useWorkbench()`. The composer's draft store sits above the workbench and the panel, inside the principal's scope, so another principal starts with no drafts.

## Look (`styles/`)

The app wears the kit's look. `src/styles.ts` loads every global sheet once, in cascade order: `src/ui/styles.css` (the layer order, the touch layer and the reduced-motion rule), `styles/index.css` (the app's one Tailwind build: the kit's Tailwind, theme and v2 tokens, scanning the app's source and `index.html`, plus the app's own layers), `styles/ui-overrides.css` (the Codex overrides: SF Pro Text, zero letter-spacing, overlay geometry, hidden scrollbars), the kit's menu, select and tooltip sheets, `styles/app-shell.css`, and `src/transcript/styles.css` (the renderers' sheets). Each rule has one of these owners, and no sheet is a second Tailwind build. `ThemeProvider` from `@opencode-ai/ui/theme` runs the kit's theme set with Codex as the default and keeps the icon library in step with the theme. The root stays at the browser's 16px.

Rules in those sheets that code cannot explain:

- `styles/app-shell.css`:
  - The `--bp-*` properties are the layout thresholds on Tailwind's `sm`/`md`/`lg`/`xl`/`2xl` scale plus three document-editor widths, for `calc()` and inline styles. `@media` cannot read a custom property, so media rules keep the literal pixels (767 is the complement of `md`).
  - The modal stack is named, not guessed. Every layer is portaled to `<body>`, so only these numbers decide what paints over what. A dialog's layer wrapper sits in the same elevated context, so a dialog opened from another opens above it, and a select's portaled list clears the dialog layer.
  - Below `md` or on a coarse pointer, icon and labelled buttons get a 40 px floor. `data-claxedo-compact-touch` exempts an element or a dense region such as the rail, whose full-width rows are the tap targets.
  - The palette gets an 8 px gutter and a 14 px radius, concentric with its rows. The palette and the page-scale dialogs dim their backdrop because the shared 0.2 alpha is invisible on dark chrome. The overlay is a sibling of the dialog layer, so the backdrop is selected from `<body>`, and it moves at the dialog's own 150 ms in and 100 ms out.
  - The main column is a positioned layer above the panel. The floating session stack's `z-index` is otherwise trapped in its pane's `contain: strict` context.
- `styles/index.css`:
  - **Tailwind scans what the app renders**: the kit's own source (from the kit's entry), this package's `src` and `index.html`. The desktop renderer's source is excluded: scanning another package's source ships its utilities, and `group-data-[expanded]:*` from the old app compiled to universal descendant selectors that restyled every open menu or dialog.
  - **The terminal font** is `font-display: swap`. It is 1 MB, and text never waits for it.
  - **The new-session content** (`session-new-design`) and the getting-started card are size containers, so what they hold lays out by the space they get rather than by the viewport.
  - **The composer's menus share one surface, elevation and row spec.** That covers the `+` menu, the harness/model picker and the popover lists, so neighbouring menus keep one rhythm.
    - The rules are unlayered and use a doubled class, because the menu, select and list sheets ship unlayered rules that beat any `@layer components` rule, and Vite's injection order is not guaranteed.
    - Their width clamps to the viewport, not the pane, because they float above it.
  - **The harness/model picker** enters with a 150 ms slide from its header, and animates its surface's height with `interpolate-size: allow-keywords`. Both are off under reduced motion.
  - **The effort slider's geometry is literal custom properties.** The slider reads them back through `getComputedStyle`, which returns a custom property's text unresolved, so a `calc()` there would read as 0.
  - **The dock collapses by container query** (`prompt-composer`, 560 px) on the space it owns. The harness/model chip keeps its label, because it is the only control naming what will answer.
  - **The collapsed composer** is driven by the `data-composer-collapsed` attribute, not `:focus-within`, because its menus are portaled and focus entering one would fold the card under it.

- `styles/ui-overrides.css`, today's app's override sheet:
  - **Semantic surfaces are theme-agnostic.** A role a theme does not override inherits the generic token (`SEMANTIC_THEME_ROLE_FALLBACKS` in `packages/ui/src/theme/resolve.ts`), so one selector serves every theme and Codex only supplies values.
  - **Floating surfaces rebind the page palette to the overlay palette** for their subtree. `[data-surface="overlay"]` comes from DropdownMenu; `.overlay-palette` is the opt-in for pickers built outside the menu primitives. It is inert in a theme with no overlay overrides. Only hand-authored shells get their paint forced, because a forced rule on `[data-surface="overlay"]` would take the paint from every DropdownMenu.
  - **The composer dock** binds only the ring colour its mask paints with.
  - **The icon interaction grammar** (`data-icon-interaction`) is theme-agnostic:
    - passive glyphs stay quiet on row hover;
    - row actions brighten without a second pill;
    - standalone controls get a hover surface;
    - a pressed binary control shows by glyph and foreground.
  - **Filled primary icon buttons keep their inverse foreground.** Without that rule the composer's send arrow paints the colour of its circle in every theme, and no component test catches a cascade conflict.
  - **Every searchable picker's field** gets one inset fill. The List paints its search with the shell surface, which is a grey slab on a light menu. The merged harness/model picker's field doubles its class to clear index.css's (0,3,0) rule.
  - **The Codex layer covers only what a colour token cannot express:** typography, SVG geometry and elevation.
    - Elevation is Codex's own: a half-pixel stroke from the foreground at 12% plus two light black washes, the same in dark mode.
    - Shadows live here because theme `overrides` are validated as colours.
    - The composer is borderless at 20 px radius with a 90% blurred fill.
    - The user bubble is foreground/5 at 16 px radius.
    - Navigation rows are 30 px at 10 px radius.
    - Its shell selectors stay scoped to Codex and keyed by `data-testid`, because moving them onto `data-surface` would repaint the other 37 themes.
  - **The sidebar's edge falloff is an inset shadow.** The sidebar clips its overflow and the workbench paints over anything outside it.
  - **Positioners opt out of overlay chrome** with a doubled class. An example is the tooltip that only places the session card.
  - **Codex tooltips are not inverted:** they use the overlay family, as the shipped app does.
  - **The composer and timeline widths** are restored to 800/1000 px, because 500/700 is too narrow for split panes.
  - **The timeline skeleton's bars** use the muted text role so they read on every page background, and are staggered into a wave.

## Composition (`src/app.tsx`)

`AuthProvider` → registries → `I18nProvider` → `ThemeProvider` → `ShellRouter` → the server scope → `AppShell`. The server scope (`ServerProvider`, `SessionStoresProvider`, projects' `ProjectListProvider`, `DialogProvider`) is keyed by the signed-in user: signed in, `createServer` gets a bearer token source from `useAuth().token`; signed out, expired or signing in, no auth. Only a change of user rebuilds it, so a token refresh does not. `App` takes an optional `router` (for example `MemoryRouter` for a `file://` renderer; the default is `HistoryRouter` in `history-router.tsx`: solid router's own browser integration, `browserIntegration`, which the repo's dependency patch `patches/@solidjs%2Frouter@0.15.4.patch` exports, with one change: its `pushState`/`replaceState` run in the task after the navigation, and a `popstate` writes any pending ones before the router reads the location. A route's reads are issued from the navigation's task, and Chromium hands the responses of fetches issued after a history write in the same task to the main thread 10–20 ms late (measured 2026-09-27: +16/+26 ms instead of +5), which was a third of a cold session switch. Until that write, `window.location` still holds the previous URL, so a view under the router reads its path, query and hash from `useLocation()` and only the origin from `window.location`. Anchor interception, scrolling to a hash and leave-blocking are the integration's, so `A` and plain anchors to app routes stay in-app) and an optional `serverUrl` (the desktop's embedded server, known only at runtime; without it `createServer` uses the build's `VITE_CLAXEDO_SERVER_URL` or the page origin).

## Sign-in (`sign-in-gate.ts`)

On a server that issues sessions (`capabilities.signedIn`, from the bootstrap's `deployment.issuesSessions`), a reader who is signed out or whose session expired is sent to `/login` with the URL replaced, as today's app does, and nothing of the shell renders; the original URL is not kept, as today. While sign-in settles the splash holds. A server that issues no sessions, or one whose bootstrap has not been read, never redirects.

## Home (`home-redirect.tsx`)

`/` is never a screen of its own, as in today's app. When the projects list has loaded and is empty (`onboardingNeeded`), the shell replaces the URL with the onboarding screen; loading and failed lists never redirect. Otherwise it replaces `/` with the draft of the active workspace: the placement of the restored focused pane, else the folder placement of the first project `useProjectList()` lists.

## Local service lost (`daemon-status.ts`, `view/daemon-lost-banner.tsx`)

Desktop only. Electron main publishes the daemon's status on `api.daemonStatus`: `lost` when its lease on the daemon closes or the daemon it started exits, with that exit's code or signal when it has one. A window opened after the loss reads it; a push overtakes an older read. The shell then shows one alert with the cause and one button, which sends `api.relaunch()` once. Main's `runRestart` decides what that does: a packaged app relaunches, which starts a new daemon, and a development run reloads the window, so the label says "Restart Claxedo" or "Reload window" from the `restart` main sends. Nothing detects a daemon coming back and nothing retries. The web has no daemon status and keeps the session's reconnect line.

## Registries (`registries.ts`; the first-party entries in `src/registry.ts`)

One `Registry<Entry>` per region and concept: `pages`, `paneKinds`, `panelViews` (the workspace panel's "context" and "subagent" tab views, registered by the domains that own them so `src/panel` never imports them), `settingsSections`, `sidebarItems`, `overlays`, `commands`, `mentions`, `themes`, `iconSkins`, `routes`. `registry.ts` holds the static first-party arrays that import each domain's exports; plugins `add()` entries while they are on and dispose them when off. `view/registered-appearance.tsx` is the reader for `themes` and `iconSkins`: each theme entry is registered with the kit's `ThemeProvider` as OC-2 with the entry's tokens as v2 overrides (so Appearance lists it) and unregistered when its entry goes, which falls back to the default theme if it was selected; the skin whose id is the selected theme's is provided to `ClaxedoIcon` through `IconSkinContext`.

## Command palette (`palette/`)

Kept from the old app: registrations with owners, keybinding parsing and display, user overrides persisted under `claxedo:keybinds`. The `commands` registry feeds it beside component registrations. No keybinding fires while a dialog is open. The palette is today's `DialogSelectFile` (`select-file.tsx`), the one implementation for both modes: the palette keybinding (mod+shift+P) runs `file.open` with the source `palette`, which opens it in `all` mode (empty: the common commands, then recent files; typed: every command, the current project's sessions and file search, grouped); mod+P opens it in `files` mode (recent and root files, then file search). Its caller passes the placement and `onOpenFile`; the shell's `OpenFileCommand` opens the file as a workspace panel tab, and the panel's "+" → File passes its own.

## Phone

Below 768 px the rail itself becomes a drawer that fills the viewport (an owner ruling over today's 280 px drawer beside a scrim), sliding in from the left over 300 ms, opened and closed by the fixed "Open navigation sidebar" button over the header's left end. The header there holds New Session only; New Terminal is desktop-only. The frame never scrolls horizontally.

## Flows

Flow 12 (workbench and shell), flow 26 (language switch and the accessibility sweep), flow 33 (phone) and flow 41 (the desktop's local service lost).
