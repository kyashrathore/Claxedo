# Shell

Owns: the app frame and nothing a feature knows about. Three regions and one page tab, the shell layout machine, the router, the typed registries every domain and plugin fills, the command palette, and the phone behavior of the frame.

## Regions

- **Sidebar** (left): `main` mode shows what `AppShell` receives as `mainSidebar` (the rail); `settings` mode shows `SettingsSidebar`, the sections from the `settingsSections` registry grouped by `account`, `workspace`, `app`. The URL decides the mode: a page whose entry says `sidebar: "settings"` switches it.
- **Center**: the workbench of split panes (`src/workbench/`), or the one **page tab** when the URL names a `PageEntry` (Settings, Marketplace, Tasks, Pages, projects, plugin pages). The page tab cannot split or drag; opening another page reuses it; its state is the URL.
- **Workspace panel** (right): the `panelTabs` registry, filtered by each tab's `when()`, with the active tab and width kept per scope: the current placement (`placementOf(route)`), or `default` when the URL names none. A focused pane with no route, such as a file, leaves the URL and so the scope on the last placement.
- **Top bar**: the sidebar and panel toggles, the workbench tab strip on a wide screen, the pane switcher on a phone, the page header for a page.

## State machines

- **`ShellLayout`** (`model.ts`): `wide { sidebar, panel }` with each side region `open` or `collapsed`, or `phone { drawer, sheet }` with each overlay `open` or `closed`. Events: `viewportChanged`, `toggleSidebar`, `showSidebar`, `hideSidebar`, `togglePanel`, `showPanel`, `hidePanel`, `navigated` (closes the phone overlays). The wide regions persist as preferences (`store.ts`) under the principal's scope; phone overlays never persist.

## Routes (`routes.ts`)

Id-only: `/` (home), `/w/:placementId/s/:sessionId`, `/w/:placementId/t/:terminalId`, `/settings/:section?`, each page's own `path`, and the `routes` registry for full-screen screens outside the shell (auth, onboarding) which match first. `RouteSync` opens the session or terminal the URL names in the workbench and mirrors the focused pane back into the URL with `replace`, so the URL is the one home of the current placement: `useShellRoute().placementId()`.

## Placement providers (`placement-providers.tsx`)

The domains whose state is kept per placement (terminal, files, review, browser) mount their providers here with no props, under the commands provider inside the workbench; each reads the placement from `useShellRoute().placementId` and opens panes through `useWorkbench()`. The composer's draft store sits above the workbench and the panel, inside the principal's scope, so another principal starts with no drafts.

## First run (`first-run.tsx`)

On the home route, when the projects list has loaded and is empty (`onboardingNeeded`), the shell replaces the URL with the onboarding screen. Loading and failed lists never redirect.

## Registries (`registries.ts`, `registry.ts`)

One `Registry<Entry>` per region and concept: `pages`, `paneKinds`, `panelTabs`, `settingsSections`, `sidebarItems`, `overlays`, `commands`, `mentions`, `themes`, `iconSkins`, `routes`. `registry.ts` holds the static first-party arrays that import each domain's exports; plugins `add()` entries while they are on and dispose them when off. `ThemeBridge` registers every `ThemeEntry` with the kit's theme runtime, so the kit remains the one owner of the color scheme and the active theme.

## Command palette (`palette/`)

Kept from the old app: registrations with owners, keybinding parsing and display, user overrides persisted under `claxedo:keybinds`, fuzzy search grouped by category. The `commands` registry feeds it beside component registrations.

## Phone

Below 768 px the sidebar is a drawer and the workspace panel a sheet (both Kobalte dialogs), the top bar shows the pane switcher, and the home route shows the sidebar content full screen. The frame never scrolls horizontally.

## Flows

Flow 12 (workbench and shell), flow 26 (language switch and the accessibility sweep) and flow 33 (phone).
