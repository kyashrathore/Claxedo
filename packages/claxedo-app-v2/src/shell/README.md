# Shell

Owns: the app frame and nothing a feature knows about. Three regions and one page tab, the shell layout machine, the router, the typed registries every domain and plugin fills, the command palette, and the phone behavior of the frame.

## Regions

- **Sidebar** (left): today's rail frame (`view/sidebar.tsx`): the `rail-sidebar` nav named "Projects and sessions", 260 px by default, with a 36 px header strip holding Hide Sidebar (Pin Sidebar while it peeks) and an 8 px resize grip on its right edge (220 to 520 px; dragging below 220 unpins it). Pinned, it sits in the row; unpinned, it is an overlay at the left that shows only while peeking and hides when the pointer leaves it. `main` mode shows what `AppShell` receives as `mainSidebar` (the rail); `settings` mode shows `SettingsSidebar`, the sections from the `settingsSections` registry grouped by `account`, `workspace`, `app`. The URL decides the mode: a page whose entry says `sidebar: "settings"` switches it.
- **Center**: the workbench of split panes (`src/workbench/`), or the one **page tab** when the URL names a `PageEntry` (Settings, Marketplace, Tasks, Pages, projects, plugin pages). The page tab cannot split or drag; opening another page reuses it; its state is the URL.
- **Workspace panel** (right): `src/panel/`. The frame wraps the workbench column in its `WorkspaceArea`; the layout below decides whether it is shown.
- **Top bar**: the sidebar toggle, the workbench tab strip on a wide screen, the pane switcher on a phone, the page header for a page, and the panel's `PanelToggle` while the panel is closed.

## State machines

- **`ShellLayout`** (`model.ts`): `wide { sidebar, panel }` with the panel `open` or `collapsed` and the sidebar `open` (pinned), `collapsed` (unpinned) or `peeking` (unpinned and shown), or `phone { drawer, sheet }` with each overlay `open` or `closed`. Events: `viewportChanged`, `toggleSidebar`, `showSidebar`, `hideSidebar`, `peekSidebar` (only from `collapsed`), `unpeekSidebar` (only from `peeking`), `togglePanel`, `showPanel`, `hidePanel`, `navigated` (closes the phone overlays). The wide regions persist as preferences (`store.ts`) under the principal's scope, a peek as `collapsed`; phone overlays never persist.

## Routes (`routes.ts`)

Today's app's shapes, id-only: `/` (home), `/w/:placementId/session` (the placement's new-session draft), `/w/:placementId/session/:sessionId`, `/w/:placementId/terminal/:terminalId`, `/settings/:section?`, each page's own `path`, and the `routes` registry for full-screen screens outside the shell (auth, onboarding) which match first. `RouteSync` opens the draft, session or terminal the URL names in the workbench (through the pane kinds' `fromRoute`) and mirrors the focused pane back into the URL with `replace` (through `toRoute`), so the URL is the one home of the current placement: `useShellRoute().placementId()`.

## Placement providers (`placement-providers.tsx`)

The workspace panel and the domains whose state is kept per placement (terminal, files, review, browser) mount their providers here with no props, under the commands provider inside the workbench; each reads the placement from `useShellRoute().placementId` and opens panes through `useWorkbench()`. The composer's draft store sits above the workbench and the panel, inside the principal's scope, so another principal starts with no drafts.

## Look (`styles/`)

The app wears today's app's look: `main.tsx` loads `styles/index.css` (the kit's Tailwind and session styles, plus the app's own layers) and `styles/ui-overrides.css` (the Codex overrides: SF Pro Text, zero letter-spacing, overlay geometry, hidden scrollbars), then the kit's menu, select and tooltip sheets, in that order. `ThemeProvider` from `@opencode-ai/ui/theme` runs the kit's theme set with Codex as the default and keeps the icon library in step with the theme. The root stays at the browser's 16px; the older `src/ui` sheet no longer sets the root's size, font or colors.

## Composition (`src/app.tsx`)

`AuthProvider` → registries → `I18nProvider` → `ThemeProvider` → `ShellRouter` → the server scope → `AppShell`. The server scope (`ServerProvider`, `SessionStoresProvider`, `DialogProvider`) is keyed by the signed-in user: signed in, `createServer` gets a bearer token source from `useAuth().token`; signed out, expired or signing in, no auth. Only a change of user rebuilds it, so a token refresh does not. `App` takes an optional `router` (for example `MemoryRouter` for a `file://` renderer; the default is the history router) and an optional `serverUrl` (the desktop's embedded server, known only at runtime; without it `createServer` uses the build's `VITE_CLAXEDO_SERVER_URL` or the page origin).

## First run (`first-run.tsx`)

On the home route, when the projects list has loaded and is empty (`onboardingNeeded`), the shell replaces the URL with the onboarding screen. Loading and failed lists never redirect.

## Registries (`registries.ts`, `registry.ts`)

One `Registry<Entry>` per region and concept: `pages`, `paneKinds`, `settingsSections`, `sidebarItems`, `overlays`, `commands`, `mentions`, `themes`, `iconSkins`, `routes`. `registry.ts` holds the static first-party arrays that import each domain's exports; plugins `add()` entries while they are on and dispose them when off.

## Command palette (`palette/`)

Kept from the old app: registrations with owners, keybinding parsing and display, user overrides persisted under `claxedo:keybinds`, fuzzy search grouped by category. The `commands` registry feeds it beside component registrations.

## Phone

Below 768 px the sidebar is a drawer (a Kobalte dialog), the top bar shows the pane switcher, and the home route shows the sidebar content full screen. The frame never scrolls horizontally.

## Flows

Flow 12 (workbench and shell), flow 26 (language switch and the accessibility sweep) and flow 33 (phone).
