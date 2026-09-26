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

## Owner, 22:28: scrollbars better than v1
- v1 shows the native scrollbar in Review and none in the Files tree (`scrollbar-width: none`), and its terminal thumb is barely visible under the Codex tokens.
- **v2:** the kit's thin overlay thumb in Review and the Files tree, and a visible terminal thumb on its own token.
- Lane: tools-3.

## Orchestrator, 23:55: revert is not ported (SESS-061..063)
- v1 gates Revert message, the diff summary's Undo and the rolled-back dock on a harness declaring `revert`/`unrevert`.
- No harness in workspace-runtime or agent-sdk-runtime declares either (opencode sets both false), so v1 never renders them.
- **v2 does not port them.** The moved timeline's dead half (UserActions.revert, the Revert button, Undo) is a deletion candidate. It goes, or comes back, together with a harness that declares revert.

## Orchestrator, 00:35: request-read failures (SESS-071)
- v1 designed a "Could not load pending permissions or questions" card with Retry. It can't be reached: its SDK list returns `{data: undefined}` instead of throwing, so v1 shows no card and re-reads /permission, /question and /session/status in a hot loop (3,828 requests each in 14 s).
- **v2 shows v1's card.** The request read fails on its own, the transcript stays visible, Retry re-reads, and there is no loop. Flow 08's case branches on this entry.

## Owner, 00:50: settings content
- **No "Terminals" section in v2.**
- **Settings content sections are free to be redesigned for the best UX** ("I don't think we had best UI in v1, just take your liberty"). Every v1 settings feature and its behavior stays: options, effects and persistence. The look inside the settings content is v2's own design, within v2's settings shell (16:45).
- Settings flows assert behavior; a step about v1's markup branches on this entry. Lane transcript-3 owns src/settings.

## Owner, 00:55: no catch-all General
- Language, Appearance, Sounds and Notifications are separate top-level settings sections, not one "General".
- Everything else v1's General held goes to the section it belongs to.

## Orchestrator, 02:10: Marketplace (EXT rows)
- v1's Agent Plugins directory is ported into the shared page tab (0c36c01579).
- Signed-only parts are not ported, since v2 has no signed plugin rail yet: the project picker, organization defaults, the enterprise install option, MCP Connect/Disconnect.
- Unsigned v1 showed a Connect button and a "Connect now" second install step that did nothing. v2 drops both, and the built-in's empty "…" menu.
- The domain is 2,384 lines against an 1,800 budget; the scope review is recorded in the handoff.

## Orchestrator, 02:25: the Models tab switches reach the picker by group too
- In v1 the composer picker reads only per-model switches, so a group's "Disable all" changes Settings but not the picker.
- **v2:** the picker honors the group state too. It's a one-line fix to a v1 inconsistency.

## Owner, 02:40: keep /welcome, keep Back
- **`/welcome` stays** as the first-project route. PROJ-001, v1's canvas at `/`, is not taken; projects-app's 7c245ba6e1 is reverted (d19c7962fc).
- **Back stays as v2 has it:** browser Back after a rail click returns to the previous session. The settings Back stays too.

## Orchestrator, 03:05: no time-based "Still working…" hints (COMP-040)
- v1 shows "Still working…" at 20 s, "taking a while" at 45 s and "unresponsive" at 5 min of a turn. Those are client timers guessing at status.
- **v2 does not port them.** It shows the harness's real state instead: the health peek's "The agent stopped responding", and `session.status`. That follows the session rule "status is never guessed".

## Owner, 02:15 + bench 02:50: no DOM keep-alive for hidden session panes
- The owner's rule: if keeping hidden panes mounted doesn't buy much, remove it to prevent memory bloat.
- **Measured on packaged v2:** unmounting hidden panes costs +8.5 ms per return to a visited session (16 → 24.5 ms median) and saves ~12 MiB of JS heap and ~680 DOM nodes with 8 small sessions open, more on heavy sessions.
- **Decision:** hidden session, draft and page panes unmount; the data store and timeline snapshots stay. Terminals stay mounted (xterm state).

## Orchestrator, 2026-09-25: a preset slot never writes the composer's draft default (a v1 bug, not ported)
- v1's preset slot runs the composer's harness selector under a draft scope. Every harness or model pick in it, including the seed applied when an existing preset opens, is saved as the workspace's draft default. Opening a Pi preset makes the next new session open on Pi.
- **v2:** a new slot still opens on the draft default (the harness last used for a draft in the first workspace, else the folder's harness). The slot never writes it back: `DraftHarnessPicker` passes `saveDraftDefault: false`, so its picks stay in the slot.

## Owner, 2026-09-25 10:05: "all good" on the six open calls
- **Panel width (TOOL-009):** a dragged panel width survives closing the panel. v1 forgets it because it disposes the shell.
- **Browser pick (TOOL-145):** a pick sends a text chip with the page, the element and the comment. v1's file chip sends a `file://` part the agent can't read.
- **Composer budget:** the plan's 5.5k assumed the PromptInputV2 frame swap, which the parity ruling voided. The budget is re-based to the composer's measured size after its no-comments triage (11.1k after the cuts; v1's composer is 12.3k).
- **Cancelled turns (runtime, both apps):** fixed now, in this branch. A Stop records `cancelled`, and both apps show "Interrupted".
- **Desktop launch code shared with v1:** start fixes may change it on this branch (early server fork, the stale-daemon file, the compile cache). v1 built from this branch gets the same wins, so the benchmark's v1 baseline is built from `dev`.
- **Server gaps:** fixed in this branch. That means the pi harness options cold start, the providers route's `provider` parameter and summary form, a pushed harness-health event replacing the composer's poll, and one status read across workspaces.

## Orchestrator, 2026-09-25: panel width survives close (v1 side effect not ported; owner approved 10:05)
- v1 keeps a dragged panel width in the panel shell, which it disposes after the close motion, so every reopen starts at 70% (TOOL-009).
- **v2:** the chosen width persists (localStorage, per scope) across close and reload; maximize still restores it.

## Orchestrator, 2026-09-25: browser pick sends text (v1's file part is broken)
- v1 adds a picked element as a file chip whose path is the page URL, and sends it as a `file://<folder>/<url>` part the agent cannot read (TOOL-145).
- **v2:** a text chip "<tag> on <host>" whose text carries the page URL, the element's selector and HTML snippet, and the comment; the screenshot goes in as an image.

## Owner, 2026-09-25 11:50: streaming slice signed off
- The owner signed off `v2/stream-slice` (the protected-area rule for `src/transcript` and the timeline): open-block re-lex, one parse of the open block, controls built on the committed DOM, rows tracking whether a part has text, and one purifier. It merged into feat as e9cd0024be. The fixes are described commit by commit in `docs/app-v2-stream-slice.md`.

## Owner, 2026-09-25 12:55: plugins are made by asking any session
- The owner wants to ask any Claxedo session "add me a plugin" and get it. No CLI, and no harness-specific setup.
- **Decision:** plugin authoring becomes four tools on the Claxedo MCP server, which every harness connects to: `app_plugin_create` (scaffold), `app_plugin_add` (register with the daemon, which builds, watches and notifies the app as today), `app_plugin_check` (typecheck and build, returning errors), and `app_plugin_guide` (the authoring guide).
- The MCP guide describes those tools and reaches Claude Code, Codex, OpenCode, and Pi.
- The app's one-time confirmation before a new plugin runs stays.
- The `claxedo plugin` CLI goes once the tools land.

## Owner, 2026-09-25 15:50: fix every audit finding, architecturally
- The owner signed off the transcript and timeline performance fixes from `docs/app-v2-perf-audit-2026-09-25.md`: the image-probe leak on session switch, scroll restyles from the virtualizer's notify, the hidden transcript computing behind the full-view composer, the per-part `hasText` roots, and scroll-thumb geometry written per delta.
- "Architecturally, no patching": each fix names the owner that should hold the state or work, and moves it there. No guards, weak references, flags or special cases layered over the old shape.
- Each fix lands with a corpus or flow assertion that measures it.

## Owner, 2026-09-25 16:20: dead-sandbox session flow (signed web and cloud workspaces)
- Only sending a message wakes a cloud workspace's sandbox. App open, rail status, hover and opening a session never do. The client learns whether the backing sandbox is gone from a read that doesn't wake it.
- **Opening an existing session:**
  1. The history always comes from the control plane.
  2. The app checks whether the sandbox is alive, without waking it.
  3. If it's gone: the transcript renders read-only, and a card above the composer says the next message will wake it. On send, the dock shows a waking-up state until the sandbox is up, then the message is sent.
  4. If it's on: the app connects or reconnects, and attaches live streaming when a turn is running.
- No dimming in the rail: rows and projects look the same whatever their sandbox's state.
- v1's cloud startup view isn't ported; the dock's waking-up state replaces it.
- (Owner, via the lead, 18:40) Runtime-only parts (status, permissions, questions, todos, goal) are read from the sandbox only while it runs; while it's gone they're absent, with no errors. The dock's state and the card are states of one machine. Waking handles `provisioning` by the server's `retryAfterMs`, and a refused start (409) is a clear failure with a retry.
- **As built (lane signed-web):**
  - Sandbox state: the catalog's `reachable` for a cloud placement is its sandbox lease, read without a wake (`readyCloudWorkspaces` in server-core, both signed catalogs). A runtime read uses `GET /api/workspace/:id/connection`, which never starts compute; only `POST` does, and only a send (or an explicit start) posts it.
  - One machine per placement, owned by the adapter (`src/server/workspace-wakes.ts`, `wake-machine.ts`), read as `server.cloud.runtime(placementId)`: `live`, `asleep`, `waking(bootMode?)`, `wakeFailed(error)`.
  - Copy: asleep "This workspace is asleep. Your next message wakes it."; waking "Waking up the workspace…", plus "Resuming its sandbox" or "Restoring it from a snapshot" when the server names the boot mode; failed "Couldn't wake the workspace." with the server's reason and Try again. The composer stays usable while asleep; the message is sent once the sandbox is up, and a failed wake keeps the draft.

## Owner, 2026-09-25 17:45: session sources, merged on the server
- One list owner per connection:
  - the daemon on desktop, merging the local projection with the control plane's page when signed in;
  - the control plane on the web.
- The app never fans out list reads per placement.
- Machines publish session rows (no transcripts) to the control plane.
- One keyset cursor over `(lastHumanTurnAt, createdAt, sessionRef)`.
- Status arrives by events.
- History is routed by placement kind: control plane for cloud, relay for machines, local runtime for local.
- Terminals only for live placements.
- The plan is `docs/plans/2026-09-25-002-session-sources-plan.md`.

## Owner, 2026-09-25 18:40: the account credential stays behind AccountPort
- The signed desktop's merged session list reads the control plane through AccountPort: Electron main owns the credential and runs only named operations (`session.list` added to the closed set).
- The daemon never receives the user's bearer.
- Machine row publishing (S2) uses the machine's Host Tunnel Token, scoped to the workspaces still assigned to that host. That's a machine credential, not the user's.

## Owner, 2026-09-25 19:45: no fixes to v1
- v1 (`packages/claxedo-app` on dev) gets no fixes, including the "Too many redirects" crash in v1's route sync (`app-shell-route-sync.ts`) that the owner hit on a v1 build. v2 replaces v1 at the swap.

## Orchestrator, 2026-09-25: Composer budget re-based after parity voided the frame swap
- The plan's 5.5k Composer budget assumed swapping today's `PromptInputFrame` for upstream's `PromptInputV2` frame. The parity ruling (port v1's UI, don't restyle) voided that swap, so the composer is today's frame, moved.
- The owner approved re-basing at 10:05 ("all good"), after the composer's no-comments triage.
- After the triage (593 comment blocks: real constraints moved into `src/composer/README.md` under Constraints, the rest deleted), `src/composer` measured 10,147 lines. Splitting its 14 size violations by responsibility then added 835 lines of module seams (imports and prop types), to 10,982.
- Merging feat/app-v2's hidden-pane command registration (`composer-commands.ts`) added 5 more, to 10,987.
- The budget row is set to the measured 10,987, with no headroom, inside the owner's 11.1k; v1's composer is 12.3k.

## Owner, 2026-09-25: desktop app plugins run in-app; residual accepted, users warned
- On the desktop an app plugin runs in the app's own JavaScript, unsandboxed. It has the app's full access on this computer: it sees what the user sees, acts as the user on their server, reaches every desktop bridge (`window.api`), and can open links in the user's browser or the Browser tab that carry data out.
- The owner accepts that residual. The desktop warning says it plainly and asks the user to turn on only app plugins they trust.
- On the web an app plugin runs in a sandboxed frame (`sandbox="allow-scripts"`, never same-origin), reaches the server only through the host's manifest-checked calls, and the warning says so.
- Approval is per manifest: a changed routes, operations or requires set stops the plugin until the user approves again and shows what changed; "Code changed since you approved" shows the build time.
- Every user-visible string says "App plugins". Agent Plugins and the Marketplace keep their names.

## Owner, 2026-09-25 22:40: transcript images load from the web; plugin frames stay strict
- The app page keeps v1's image rule: `img-src` allows `https:`, so web images in agent replies load as in v1.
- On the web, each app plugin's sandboxed frame gets its own stricter policy on top: no outside images or media. A frame can only tighten the inherited policy.
- Desktop in-app plugins can load outside images. That's part of the desktop residual already accepted and warned about.

## Owner, 2026-09-26: src/server budget deferred to its dedicated rebuild
- "leave src/server for now, we anyway will do dedicated rebuild later."
- The budget table reports the adapter's lines with no ceiling. It measured 8,243 lines, 1,122 of them tests, against the plan's 4.0k.
- Duplicates already removed stay removed: the second decoder of `/api/claxedo/integrations`, the second machine-logins read, a copy of `withQuery`, and prompt-delivery types restating the runtime contract's.
- The rebuild sets the adapter's budget. The scope that later rulings added and the 4.0k did not price: session sources, the signed desktop's account catalog behind AccountPort, the dead-sandbox wake, cloud session sync, the Marketplace catalog contract, integrations and plugin hosted operations, and the harness options lane.

## Orchestrator, 2026-09-26: Plugin host budget re-based: the web frame is its own part
- The plan's 1.7k priced a web "iframe bridge". What was built is a second runtime: a control frame plus a slot frame per page, section and overlay, a mirrored `PluginApi` and its own bundle, locked down by the owner's 22:40 frame policy. `src/plugins/frame` (host bridge and frame runtime) is now its own part, budgeted at its measured 864.
- The rest of the host measured 2,064 after its deletions (`PluginOff`, the constant `CODE_CHANGE_NEEDS_APPROVAL` flag, the second bundle import). The remaining excess over 1.7k comes from rulings made after the plan:
  - per-manifest approval with the access diff, build time and per-platform warnings (owner 2026-09-25, "desktop app plugins run in-app; residual accepted, users warned");
  - the App plugins settings with the manifest summary and remove confirmation.
- The plugin host's part is re-based to 2,064 with no headroom.

## Orchestrator, 2026-09-26: Browser tabs budget re-based: the parity ruling kept v1's chrome
- The plan's 1.1k assumed v2 screens. The parity rule ("v2 looks and behaves exactly like v1") brought back v1's options menu and console drawer, and the 22:40 frame policy added the two-document web preview.
- Dead compatibility and unread fields went first (1,429 → 1,375): optional bridge members the preload declares required, bridge members nothing calls, and the picked element's bounding box.
- Re-based to the measured 1,375 with no headroom.

## Orchestrator, 2026-09-26: Marketplace budget re-based: v1's directory ported under the parity rule
- 02:10 ported v1's Agent Plugins directory into the page tab and recorded 2,384 lines against 1,800. The handoff left it "awaiting a scope review, not squeezed".
- Duplicates went first (2,378 → 2,348): the OAuth server rows built only to be counted, a copy of the harness names and a copy of the failure message reader.
- Re-based to the measured 2,348 with no headroom. v1's comparable directory code is about 3,160 lines.

## Orchestrator, 2026-09-26: Tasks budget re-based: an app domain at v1 parity, not the plan's Tasks plugin
- The plan's 2.5k was the Tasks plugin's number. The handoff recorded Tasks becoming an app domain (`src/tasks`), over budget and "awaiting a scope review, not squeezed". Presets as a Settings section then added 1,195 lines.
- A duplicate status-change runner and unreachable selection state went first (4,449 → 4,414).
- Re-based to the measured 4,414 with no headroom. v1's `features/tasks` is 4,636 lines. Cutting detail editing, subtasks, the properties rail or the presets picker needs an owner ruling under the parity rule.

## Owner, 2026-09-26: a session's first load shows the turn peek rail and places subagents without a scroll
- The owner reported that on first load a "Background subagents" card appears above the latest turn, then goes away once a scroll loads the rest; and that the turn peek rail appears only after a scroll. v1 does the same.
- **Subagents:** a subagent counts as background only when it has no spawning tool call, or when the whole history is loaded and its call is still absent. While older history is unloaded, it waits to render in its own turn (`src/session/view/subagent-views.ts`).
- **The rail:** after the first surface paints, while older history exists and the loaded turns are below the rail's threshold (more than ten), v2 loads one older page (50 messages) through the same anchored path a scroll uses (`src/session/view/history-paging.ts`). It decides once per session view, so streaming never re-runs it. v1 loads older history only on a scroll.
- The corpus case `two-turns` compares v2 against its own baseline (`two-turns.v2`), because its first load now shows both turns.
