# Owner decisions on v1 parity (2026-09-24, 16:30)

**The rule:** v2 looks and behaves EXACTLY like v1 (today's app). The inventory in this folder (`<area>.md`) is the spec. Every DIFFERS and MISSING row gets fixed to match v1, and every EXTRA row gets removed, unless it's approved below.

## Owner-reported (must fix)
- **Compact tabs** show only while the left sidebar is closed. They list sessions, drafts, terminals and the Tasks/Marketplace surface, never files. See SHELL-502 and SHELL-010…019. v2's ⌘J overlay goes.
- **Files open inside the workspace panel's own tabbed surface.** v1's panel tabs are Review (the default), Context, file tabs, Browser, and the "+" menu. The workbench has no file panes. See SHELL-602, SHELL-606 and SHELL-020…028.
- **A new session's harness, model and effort follow v1's rule exactly** (COMP-105…114).
  - **Harness:** the last harness used for a draft in the workspace, then the server's folder harness, then "Select agent".
  - **Model:** that harness's remembered model, or its own current model.
  - **Effort:** none unless the harness names one.
  - **Reopened session:** reads its own server config.

## Approved changes from v1
1. **Marketplace detail pane on phone** fits the screen, with the close button visible (EXT-104).
2. **Marketplace toolbar on phone** stays on screen (EXT-103).
3. **A cold-loaded `/settings/<section>` link stays** on that section (SET-004).
5. **⌘⇧B** toggles the workspace panel; **⌘,** opens Settings (SHELL-807, SHELL-808).
7. **Add project:** an optional Name field, plus an Account picker when there are several connections (PROJ-014, PROJ-076).
8. ~~The project page `/p/<id>`~~ SUPERSEDED at 17:26: the projects list moves to Settings → Projects (see below). v1's Edit dialog lives there.
9. **Settings → Plugins**, with on/off switches (SET-145).
10. **Usage as a Settings section**, in addition to v1's account-menu Usage (SET-146).
11. **Two feedback states:** "The files could not be loaded" with Retry (TOOL-031), and "Reading <file>…" (COMP-044).
12. **Remove project** asks first, then removes the project everywhere (v2's behavior). The orchestrator read "rest I agree" as approving this.
13. **Choose folder: REVERSED at 16:40, now matching v1.** v1's in-app folder dialog (search, recent, Tab completion) stays on BOTH desktop and web, exactly as v1. No native picker. Port v1's `DialogSelectDirectory` unchanged. projects-app's 9a40c9632c picker is discarded.

## Rejected: match v1
4. **No "Search sessions" field** in the sidebar (SHELL-219 goes).
6. **Review stays exactly as v1.** No branch status line, no "Files to commit" checklist, no Committed/Pushed lines, no Worktrees section (TOOL-087, 093, 103, 105 go).

## Earlier removals (the plan's "Goes" list)
These stay removed unless the owner says otherwise:
- the Processes pane;
- the "Total" usage figure;
- process diagnostics (replaced by Copy diagnostics);
- rail view filters;
- the global chat block;
- the localStorage terminal restore (replaced by the runtime's PTY replay);
- dev-only screens.

**Exception: themes.** v1's themes come back. v1's default theme is Codex, not Claxedo.

## How to fix
- **Port v1's UI; don't restyle v2's rebuilt UI.** For a surface that differs, move v1's component from `packages/claxedo-app-v2/src/legacy/` (`git mv`) into its v2 folder. Adapt only its data access, to the adapter (`@/server`) and stores (`@/session`). Then delete v2's rebuilt version.
- **v1's look is the kit.** v2 renders with v1's kit components and CSS (`@opencode-ai/ui`: its styles, theme, codex default, 16px root, SF Pro Text 14px/21px). Upstream's newer kit is used only where it renders identically.
- **Verify every surface** against the matching v1 screenshot in `inventory/<area>/shots/`, and against v1 running at http://127.0.0.1:4481. Navigate and screenshot only on that daemon; it holds the owner's real data.

## The Codex theme (owner, 16:38)
v2's "Codex theme" plugin was a token guess, and the owner rejected it outright. Delete that plugin. v1's own theme files, with Codex as the default, ARE the look; v1 at 4481 already matches the Codex app. v2 renders them unchanged.

## Owner, 16:45: what to keep from v2, and what never to port from v1
- **Keep v2's @-mention popover showing files** (v2's composer behavior; the owner likes it).
- **Keep v2's Settings UI:** the "Settings" row in the left sidebar, the settings-mode sidebar, and the settings content layout. Every v1 settings FEATURE still has to exist (General, Models, Terminals, Machines, Orgs & Teams, Presets…), built in v2's settings style. SET-011's nav and SET-150's "account button instead of Settings" are NOT reverted; the account functions (sign out, org switch, help) need a home, and the owner confirms where.
- **Never port v1's performance patches.** No holding or delaying API calls on session switch, no "fast tier" switching, no hydration delays or deferral timers. v2 is designed fast through its data layer. When a v1 component carries such a patch, drop it and get the speed from v2's stores and queries.
- **Never port v1's global providers.** v1's entangled context/provider system (sync contexts, `useLanguage` over v1 dictionaries, `authFetch`/`getClaxedoServerUrl`, global SDK clients, v1 layout and route providers) must not exist in v2. Port v1 components as markup plus CSS plus behavior. Take data from `@/server` and `@/session`, strings from v2's i18n (`useTranslator` with the v1 keys copied into the domain's `i18n.ts`), and layout from the shell's registries and workbench. Cut every ported closure at data access.
- **Style is not a provider:** v1's global CSS, theme files and Tailwind tokens ARE needed. Lane shell loads them once.
- **Default otherwise:** the look and visible behavior follow v1. When v2 is clearly better somewhere else, list it for the owner's approval instead of keeping it silently.

## Owner, 17:15: no session title bar
- Remove the sticky session title bar above the transcript: the title h1, the double-click rename in place, and the "More options" menu (SESS-013, 014, 015, 017, 018). The owner: "don't think there is any reason for us to keep this title."
- Rename, Archive and Delete stay reachable from the session's row in the sidebar (v1's row context menu and hover archive).
- No parent breadcrumb in a subagent session either (SESS-016 removed; owner 17:18). Subagents show up in the WORKSPACE PANEL (owner 17:20; v1's panel "subagents" tab, SHELL-020..028), not in the sidebar. Port that tab exactly as v1 (lane tools). Flow 09 opens a subagent from the panel, and the parent stays reachable as in v1.

## Owner, 17:24: no "New project" button in the sidebar
Remove the sidebar's "New Project" row/button, both v1's top row and v2's "+ New project". A user selects or creates a project when creating a session, through the composer's Project chip and its "Create project…" item (PROJ-062). The New Project flow opens from that chip.

## Owner, 17:26: the projects list lives in Settings
A **Settings → Projects** section lists the projects and holds their management: v1's Edit dialog (icon, color, startup script, environment), rename and remove (asks first, then removes everywhere). Clicking a project no longer opens a project page. This REPLACES approved item 8 (the `/p/<id>` page), which goes. Selecting or creating a project for a session stays on the composer's Project chip. Lane projects-app owns the section's content, and registers it through the settings sections registry.
- (17:27) Settings → Projects is "where the user can see all projects and their related settings". It shows the list of every project; selecting one opens that project's settings inside Settings: name, icon, color, startup script, environment, where it runs (its folders, worktrees and cloud workspaces, with their v1 actions), and Remove.

## Orchestrator, 18:25: a v1 bug fix, in the spirit of the owner's approved "A" items (to be confirmed with the owner)
- **Closing a terminal ends its PTY.** In v1 the rail's close only closes the layout content: the rail sits outside TerminalProvider (`rail-sidebar.tsx:489` and `:1249`), so the shell keeps running, `/api/wr/pty` still lists it, and a reload at the unchanged URL brings it back.
- **v2 instead:** the pane and the row go, exactly as v1, but the PTY is ended (DELETE /api/wr/pty/<id>) and the route moves off `/terminal/<id>`. Tools' 8be1f6168a already ends the PTY on close.
- **Flow 13** asserts the kill in a step titled "v2 approved: closing a terminal ends its PTY (DECISIONS 18:25)".

## Owner, 19:00: screenshots of v2 against the real Codex app
1. **The sidebar toggle button** must match v1's (SHELL-201/202: Hide Sidebar / Show Sidebar, pin and hover-peek). Lane shell-4 owns it.
2. **The session title bar is still there.** Remove it now (17:15 decision). Lane session-screen, top priority.
3. **Compact tabs still don't match v1's design** (SHELL-502, 010..019). Lane shell-4.
4. **The Codex theme follows the real Codex app:**
   - The session page and the composer section use the SAME background as the rest of the app: no darker session canvas and no separate composer band.
   - Cards, overlays and dialogs get their background from the base background through a **Contrast** value, as Codex does.
   - Appearance offers Codex's **Contrast slider**, one each for the light and dark themes, which drives those surfaces.

   This is new, since v1 has no contrast slider, and the owner asked for it. It lives in v2's own `src/shell/styles/ui-overrides.css` and the theme tokens, NEVER in `packages/ui` (today's app shares it). Lane settings-access, resumed.
5. **When the workspace panel is maximized,** the session composer floats over it, as in v1. Lane tools, with lane session-screen.
6. **Terminal creation:** there is none today. Add v1's path (the header's "New Terminal", the palette command, and terminals in the rail) as ONE clean model. The rail renders one derived row list, a discriminated union `session | terminal`, from one owner, with no special cases scattered through the session list code. Lane shell-4 designs it, and lane tools supplies creation and the pane.

## Owner, 20:00: the account card comes back
- **v1's account card returns at the bottom of the rail** (SET-150..152, SHELL-223/224): avatar, name and signed-in state.
- **Its menu:**
  - v1's organization switch;
  - **Usage**, which opens **Settings → Usage** directly;
  - Settings;
  - Help;
  - **Sign in / Sign out**, which live here.
  - No "View options": the rail filters stay removed.
- **The "Settings" row the owner liked stays above the card.** The orchestrator's reading; the owner can say to remove it.
- **Lane shell-4 owns it,** using `@/auth`'s `useAuth()` for the signed-in state and sign in/out.

## Owner, 21:10: the rail foot
- No separate "Settings" row in the rail; it goes. Settings stays in the account menu and on ⌘,. This replaces the orchestrator's 20:00 reading that kept the row.
- A **Usage icon button** sits on the right of the account card, beside it, and opens Settings → Usage.
- Lane shell-4.

## Owner, 20:28: the todo dock (a deviation from v1)
- v1 keeps a finished todo list open (`todoState` returns "open" when every todo is done). The owner expects it to go away.
- **v2:** the dock shows only while a turn runs and the list is unfinished, so a finished list goes away.
- **Collapsed state:** kept per session in sessionStorage (`claxedo:session:<id>:todo-collapsed`). It survives a reload and nothing longer ("no long cache").
- Flow 03 branches on this entry: v2 expects no todo dock after the turn.

## Owner, 22:05: no session-edge strip
- v1's "Open changes / Open files" strip on the session's right edge (TOOL-003, SHELL-605) goes. The owner: "alone doesn't make any sense".
- Changes and Files open from the workspace panel toggle and its tabs.
- Flow 14 branches on this entry.

## Owner, 23:05: phone (below 768px)
- The sidebar drawer is full screen.
- No header "New terminal" button on phone.
- **Workspace panel:**
  - no Files or Review navigator toggles;
  - always in full mode, so the session composer floats over it;
  - no maximize button;
  - no "+" to add a Browser or File tab.
- Lanes: shell-4 (drawer, header), tools-3 (panel). Flow 33 branches on this entry.
