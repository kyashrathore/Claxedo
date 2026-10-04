# App rebuild: the first proof (v2 only, e2e only, today's server, faster)

Status: planned, not started. Revised 2026-09-24 after the owner's fifth review. Source: the file-level Part C reviews of the line-budget plan (`~/Downloads/Claxedo — how it works/97 Reducing Claxedo to 150k lines — plan.md` and `97 Part C/`).

## How the work runs

1. **Copy** `packages/claxedo-app` to `packages/claxedo-app-v2` and rename its package `@claxedo/app-v2`. All the app work happens in `claxedo-app-v2`. Today's app is not touched and keeps running for everyone.
2. **Rebuild** `claxedo-app-v2` in place, slice by slice, **against today's server contracts**. The routes, event names and payloads stay exactly as the server serves them now; both apps talk to the same backend. One module in the app, the server adapter, is the only place that knows those shapes ([The server adapter](#the-server-adapter)). The package's own `AGENTS.md` ([Appendix A](#appendix-a-packagesclaxedo-app-v2agentsmd)) holds the conventions; the repo root `AGENTS.md` and `CLAUDE.md` are not changed.
3. **You test** `claxedo-app-v2`, on web, phone width and desktop, side by side with today's app ([Testing it yourself](#testing-it-yourself)).
4. **Swap**, after your approval:
   - delete `packages/claxedo-app`;
   - rename `packages/claxedo-app-v2` to `packages/claxedo-app` and its package back to `@claxedo/app`;
   - delete what only the old app used ([P6](#p6--your-test-and-the-swap)).

Because the directory gets its old name back, CI workflows and scripts that point at `packages/claxedo-app` keep working after the swap.

**Outside `claxedo-app-v2`, only these change:**
- a desktop build target that loads v2;
- the benchmark driver, moved to the benchmark repo;
- the first-party plugin packages under `plugins/`;
- the four `app_plugin_*` tools and authoring guide on Claxedo MCP;
- the server additions you approved: the projects route ([The projects route](#the-projects-route)) and the daemon's live-plugin routes ([Live plugins](#live-plugins)).

A harness-status fix is added only if P0.7 shows it is needed and you approve it ([Where today's contract falls short](#where-todays-contract-falls-short)).

## Why today's server contracts

Keeping the server as it is makes the proof smaller and easier to trust:
- Both apps run against the same backend, so every baseline flow checks the old and new app against the same system.
- Nothing on the server can break today's app.
- The work stays inside one directory.

**What it costs:**
- The app carries its own translation of the server's shapes: OpenCode-style ids, event names and routes become Claxedo names at one boundary.
- It derives the session reference, capabilities and error classes itself.
- That is about 7k more lines than a rebuild with new server contracts would need. They come back when the server is rebuilt later, because only the adapter changes then.

**What it doesn't cost:**
- **Streams:** today's event stream already resumes by `Last-Event-ID`.
- **Pages:** today's documents API already works signed and unsigned.
- **Project ids:** the server already gives projects ids, both locally and on hosted.

## Why rebuild at all

Most of the line count goes by deleting, and deleting doesn't need a rebuild. The rebuild is for what deleting can't fix.

| Where the 169k production lines go | Lines | Needs the rebuild? |
| --- | --- | --- |
| Perf harness, Storybook, dead code, removed features (Processes, diagnostics), app scanners, dead routes, the second composer engine | ~65k | No: today's app could delete these |
| Comments and data tables in the moved code (transcript, timeline, composer core, terminal, workbench reducers) | ~6k | No |
| The data layer, shell and screens, rebuilt: ~161k today → ~64k | ~97k | Yes |

The 169.8k lines of unit tests go by your ruling, not because of the rebuild.

**What only the rebuild buys:**
1. **A session list you can trust.**
   - **Today:** a row comes from 4 sources, 6 caches and 16 per-session cache kinds, and its status from 8 files plus a timer. Of the 238 commits on that code since the fork, 132 have "fix" in the subject.
   - **v2:** one owner, six written rules, and race flows.
2. **Projects as ids.**
   - **Today:** projects are folder paths in browser storage, routes carry `?directory=`, and `ShellRoute` still has a `legacy-directory` kind.
   - **Why a rebuild:** ids reach every store and route, so this can't be patched in one place.
3. **One UI kit.** Upstream retired v1 on 2026-09-14, and today's app imports the v1 kits 610 times from 249 files. Moving to v2 touches every screen either way.
4. **Speed where today is slow.** Idle CPU is 8.6% against T3's 4.4%. Opening the workspace panel takes about a second, 900 ms of it a hydration delay. The rebuild owns the code on those paths, and the gate requires beating them.
5. **A shell that knows nothing about features** ([The app shell](#the-app-shell)).
6. **Code agents can keep correct:** one owner per concept, files under 300 lines, state machines, and fourteen checks.
7. **One place to change when the server is rebuilt:** the adapter.

**Why a copy and not in place.** Items 1–3 each touch most of the app.
- **In place,** they would land on `dev` while other sessions change the same files, with no clean comparison.
- **The copy** runs beside today's app on the same server, the same flows judge both apps, and one swap finishes it.

**What the rebuild doesn't rewrite:** the transcript, the terminal backend, the workbench reducers and the composer's editor core. They are moved.

## The goal

Rebuild the app so it is simpler, easier to reason about and easier for AI agents to maintain on their own. The rebuilt app must meet these constraints:

1. **Only v2.** One UI kit, v2 components and tokens, living inside the app. No v1 component or token is left.
2. **Today's server contracts.** No server route, event name or payload changes, apart from the additions you approved (the projects route, the live-plugin routes) and a harness-status fix if P0.7 needs one.
3. **Only e2e tests, and better ones than v1 had.** The suite must be robust, work, stay honest and run fast, measured by the criteria in [End-to-end tests](#end-to-end-tests).
4. **Extensible where we need it now.** A small plugin API, used by four first-party plugins: Tasks, Pages, compact tabs and the Codex theme. It grows when a need appears. Browser tabs and terminal links are part of the app.
5. **The session transcript stays as it is.** It is moved, not rebuilt, and proven against a corpus of today's rendering ([Areas that need extra care](#areas-that-need-extra-care)).
6. **The session sidebar gets one owner** with written reconcile rules, proven by race flows.
7. **Projects are ids, designed for hosted first.** A folder is where a project runs, never what it is.
8. **Phone layouts stay.** Every screen works at phone width.
9. **No comments** anywhere in the new work.
10. **Claxedo names only** inside the app. The server adapter is the one place that speaks today's server names ([Retiring OpenCode naming](#retiring-opencode-naming)).
11. **Explicit state machines** for every stateful concept ([State machines](#state-machines)).
12. **Faster than today.** On agent-app-benchmark, the rebuilt app loses no row to today's app and wins the rows in [Performance gate](#performance-gate).

### Headline numbers

| | Today | After the swap |
| --- | --- | --- |
| App + UI kits | 261.0k (app 208.7k; `ui`, `session-ui`, Storybook 52.3k) | **≤ 94k**, all in `packages/claxedo-app` |
| First-party plugins, in `plugins/` | inside the app and the UI kit | ≤ 7k |
| Unit tests, app + kits | 169.8k | **0** |
| e2e specs and helpers | 56.8k (32 of 58 specs run against a mocked server) | **≤ 16k**, none mocked; corpus data not counted |
| Comments in the new code | — | **0** |

Lines are tracked `.ts/.tsx/.js/.mjs` files, with locales not counted. While the work is in progress, the repo carries both apps; the swap removes the old one.

**The extra care costs about 3k lines:**
- the timeline keeps all its logic (+1.3k);
- phone layouts (+1.0k);
- the id-first project flow (+0.5k).

Live plugins add about 0.8k more.

## Rulings this plan implements

- **Side by side:** copy → `claxedo-app-v2` → you test → delete `claxedo-app` → rename v2 back to `claxedo-app`.
- **Server:** today's contracts; the app adapts to them. Two additions are approved:
  - the projects route, served the same way locally and on hosted;
  - the daemon's live-plugin routes.
- **Conventions:** in `packages/claxedo-app-v2/AGENTS.md`. The root files stay unchanged.
- **UI:** v2 is the one kit. Upstream made it the default (`newLayoutDesignsDefault = true`; old interface sunset 2026-09-14).
- **Tests:** e2e only, robust, better than v1, working, honest and fast.
- **Extra care:**
  - the transcript is moved, not rebuilt;
  - the session sidebar gets one owner and written reconcile rules;
  - adding a project is hosted first, and every project is an id;
  - phone layouts are kept.
- **Plugins:** only what we need now.
  - First-party: Tasks, Pages, compact tabs, the Codex theme.
  - Browser tabs and terminal links stay in the app (ours).
  - Plugin backends on Cloudflare are the known next step when a plugin needs one.
  - User plugins are prompted from inside the app and applied live: on desktop at the user's own risk, on the web in a sandboxed iframe ([Live plugins](#live-plugins)).
- **Comments:** none in the new work.
- **Naming:** Claxedo names inside the app.
- **Performance:** must beat today's agent-app-benchmark results.
- **App shell:**
  - a left sidebar with two modes, main and settings;
  - the workbench of split panes in the center;
  - a right workspace panel with tabs;
  - one reusable page tab for Marketplace, Tasks, Settings and the like, which can't be split or dragged ([The app shell](#the-app-shell)).
- **Pace:** aim for P0–P5 in one 6-hour push with parallel agents ([Execution](#execution-the-6-hour-push)).
- **No backward compatibility** ([No backward compatibility](#no-backward-compatibility)).
- **Access:** one written model of roles, orgs and shares, and one app domain ([Roles, permissions and orgs](#roles-permissions-and-orgs)).
- **From earlier rulings:**
  - flat session list ordered by `human_turn_desc`;
  - one identity per machine that sign-in adopts;
  - per-user account selection;
  - Cloudflare-only hosting and Node-only tooling;
  - the perf harness moves out of main.

## No backward compatibility

Your ruling: nothing is kept for compatibility, because there are no users to protect yet.

- **Browser storage.** v2 reads nothing the old app stored: no `default.dat`, `layout.v6`, `Persist.*` or `claxedo.global.dat:*` keys. Preferences start fresh. A folder the old app remembered only in the browser is added again as a project.
- **URLs.** No `legacy-directory` routes and no old deep-link shapes.
- **Server shapes.** The adapter speaks today's server only; there is no code for older server versions.
- **Server changes** move the store, the routes and every reader in one change, together with their migration. Nothing is deprecated for a release.
- **Old paths.** Today's app keeps working until the swap, because your side-by-side test needs it. The swap then deletes, in the same change, every server path that only the old app used.
- **No switches.** No flags between old and new behavior, and no dual reads or dual writes.

## Areas that need extra care

These four areas carry the most fixes or the most user-visible risk. Each gets stricter rules than the rest of the rebuild, its own flows, and your sign-off.

### 1. Transcript rendering: moved, not rebuilt

**Why.**
- The renderers (71 files, 17.6k lines) and the timeline (20 files, 4.6k lines) are where hundreds of issues were fixed.
- Since the fork on 2026-08-02, 174 commits touched them, 95 with "fix" in the subject. The history before the fork is squashed, so the real count is higher.
- They carry 1,834 comment lines, and many of them record why a fix is there.

**Rules:**
- **The code moves; its logic doesn't change.** That covers:
  - the renderers and the diff view;
  - the timeline: virtualization, prepend anchors, scroll anchoring, mount cache;
  - the streaming update path;
  - the timeline's own turn logic, which is not rewritten in this rebuild.
- **Only mechanical changes are allowed:**
  - import paths;
  - names, changed by a type-checked codemod;
  - a v1 primitive swapped for its v2 twin, only where the corpus shows no visible difference.
- **The data keeps its shape.** The adapter hands the transcript the same message and part shapes it reads today, with only the names changed by the same codemod.
- **Comments become cases before they go.** Each comment is triaged:
  - if it records a fix or a constraint, it becomes a corpus case or a line in `src/transcript/README.md`;
  - otherwise it is deleted.
- **CI:** any change under `src/transcript/` or the timeline runs the whole corpus in the same CI run.

**The transcript corpus (flow 30):**
- **Seeds:** recorded sessions, starting from `transcript-lab-fixture.json` and every part kind the scripted agents produce.
- **Cases mined from history:** each of the 95 fix commits becomes a case, or is marked as covered by an existing one.
- **How a case runs:** it is replayed through the scripted ACP agent, or through the scripted model server behind the real Claude and Codex CLIs, and rendered in today's app and in v2.
- **What must match:** screenshots, the accessibility tree, and the scroll position after scripted scroll, prepend, find and reload.
- **Sign-off:** any visible difference needs yours.

### 2. Session sidebar: one owner, written reconcile rules

**Why.**
- Since the fork, 238 commits touched the rail, the session sync and the session store, and 132 of them are fixes.
- Today a row's data comes from 4 sources, 6 caches and 16 per-session cache kinds.
- Its status comes from stream events, a lifecycle listener and a 5-second re-read, spread across 8 files.

**Rules:**
- **One owner:** the session list store in `src/session/list/`. Nothing else fetches, caches or patches rows.
- **One source per fact:**
  - rows come from today's list route, paged, plus the stream's session events;
  - status comes from `status.ts`;
  - order is `human_turn_desc` from the server row (`lastHumanTurnAt`), and only the reader's own send moves a row before the server confirms it.
- **The reconcile rules live in one `transition`:**
  1. Subscribe first, then fetch. Events that arrive during a fetch are held and applied after it.
  2. A row is replaced only by a newer server version (`time.updated`). An older list response never overwrites a newer event.
  3. A delete leaves a tombstone, so an in-flight response can't bring the row back.
  4. A `stream.replay-gap` re-reads the list and the statuses.
  5. The reader's own create or send is a pending entry, keyed by the client request id. The server's row confirms it or removes it.
  6. Status never comes from timing or message contents.
- **The rules are the first section of the domain's `README.md`.** A change to them changes the README and the race flows in the same change.

**Race flows (flow 31).** The scripted agent and the API drive each case, with no sleeps:
- an event arrives before the list response;
- a delete lands during a fetch;
- another browser creates a session;
- the app reconnects after missed events;
- 1,000 sessions, including the status of rows off screen;
- Claude, Codex and ACP sessions go working → waiting on you → working → idle, and failed;
- a session is archived, renamed or deleted while a turn runs.

At the end of every case, the visible list must equal the server's list and statuses, row by row.

### 3. Adding a project: hosted first, every project an id

**Why.**
- **Today's app keys projects by folder.** It keeps its project list in browser storage by folder path (`projects.local[].worktree` in `claxedo.global.dat:server`), and most routes still pass `?directory=`.
- **The server already has ids:**
  - the local server and the self-hosted app serve project records (`/api/claxedo/projects`: name, environment, clone source) that workspaces register under;
  - on hosted, a cloud workspace carries a `projectId`, and creating one can name an existing project.
- **Hosted has no projects route.**
  - A hosted project comes into being with its first cloud workspace, and `projectName` only becomes that workspace's display name.
  - The onboarding v2 plan's live probe on 2026-09-15 found the web Project chip posting to the missing route.
  - The approved projects route fixes this ([The projects route](#the-projects-route)).

**Rules:**
- **A project is a server record with an id.**
  - A folder, a worktree or a cloud workspace is a placement of a project, and a session belongs to one placement.
  - `SessionRef` = project id + placement id + session id.
  - A directory is never an identity. Only the adapter turns a placement into today's `directory=`.
- **The project list comes from the server**, never from browser storage.
- **The add flow is designed for hosted first:**
  1. name and source: a repo from a connected GitHub account, or a URL; a folder only when running on a machine;
  2. the AI;
  3. where it runs: a cloud workspace or a connected machine.
  - On every deployment, the project record is created first through the projects route, then its placement.
- **Routes and deep links use ids**, never paths.

**Flows 2 and 32:**
- hosted-first add on signed web (Worker + local sandbox driver);
- local add folder and clone;
- rename and remove;
- a deep link by project id.

Each asserts the id read back from the server.

### 4. Phone layouts: kept on every screen

**Why.**
- **Today's app has a phone layout.** `ui/controls/breakpoints.ts` drives it, and the workbench, workspace panel, terminal accessory row and browser pane switch on it. The sidebar becomes a drawer with an opener and a scrim.
- **Its only test** is `mobile-smoke.spec.ts`, which runs at a phone viewport against the mocked runtime.

**Rules:**
- **Every v2 screen has a phone layout at 390 px:**
  - one column: session list ↔ transcript and composer;
  - panes open as full-screen sheets;
  - the sidebar is a drawer.
- **Touch:** no hover-only control, and touch targets of at least 44 px.
- **No horizontal page scroll.**
- **Kit:** every component in `src/ui/` is checked at phone width.

**Flow 33** runs at 390×844 with touch, against the real stack instead of a mock:
- flows 3, 6, 8, 10, 15, 18 and 19 again;
- the drawer and the sheets;
- an axe sweep.

## What stays and what goes, for users

### Stays

| Area | What users keep |
| --- | --- |
| Start | Unsigned local use; sign-in; the onboarding wizard (project → AI → where it runs) |
| Projects | Add a project hosted first (a repo, the AI, where it runs), or locally a folder or a clone; list, rename, remove. Every project has an id. |
| Session list | Flat list by last human turn; live status (working, waiting on you, idle, failed); archive, rename, delete, search |
| Transcript | Everything it shows today, rendered by today's code: text, reasoning, every tool card, diffs, images, file links, Mermaid and math, line comments, subagent chips, message navigation, find in transcript, long-session scrolling, turn folding |
| Composer | Text, attachments with image marks, `@` mentions (files and plugin items), slash commands, agent/model/effort/permission-mode pickers, goal mode, queued messages, stop |
| Agents | Claude, Codex, ACP agents (Cursor, OpenCode, Gemini and custom), the external OpenCode server, Pi; subagents; permission prompts and questions |
| Workbench | Panes, tabs, splits and drag for sessions, terminals, files and Pages documents; command palette. Marketplace, Tasks, Settings and the Pages index open in one page tab. |
| Browser tabs | On desktop: preview a URL, navigate, console, pick an element and comment on it into the prompt. On the web: the sandboxed preview, as today |
| Terminal | Terminal panes; file-path, URL, multi-line and fallback-format links; agent status in terminals |
| Review | Diff, line comments sent to the agent, commit, push, worktrees, file tree, file tabs |
| Settings | Accounts per agent, machine logins, machines and remote access, org and members, sandbox providers, GitHub and MCP connections, the Marketplace (agent plugins), appearance (v2 themes), keybindings, terminals |
| Team | Session sharing (follow or send) |
| Cloud | Cloud workspaces: create, start, stop, delete |
| Usage | Per-turn usage and quota windows |
| Phone | Every screen at phone width: the sidebar as a drawer, panes as sheets |
| Plugins | Tasks; Pages; compact tabs; the Codex theme and icon skin. New: your own plugins, prompted from inside the app and applied live |
| Languages | All 18 |

### Goes

| What | Why |
| --- | --- |
| The Processes pane | Decided (A3) |
| The "Total" usage figure | Decided (A4) |
| Process diagnostics dialog and profiler | B3; replaced by "Copy diagnostics" |
| Rail workspace grouping and view filters | The flat list is decided |
| Rail "global chat" block | Behind a flag no build sets |
| Instant terminal restore from localStorage | Replay from the runtime's existing PTY route instead |
| Dev-only surfaces | Typography knobs, dialog/error harness routes, perf tracing |
| Themes outside the v2 set, apart from plugin themes | v2 only |
| Marketplace, Tasks and the Pages index as panes you can split and drag | They open in the one page tab ([The app shell](#the-app-shell)) |

**Open, your call** (see [Open decisions](#open-decisions)):
- consolidating access checks on the server;
- teams inside an org;
- network-policy settings;
- the custom-provider dialog;
- the release-notes video dialog;
- the warm-boot transcript cache, decided by the benchmark;
- a harness-status server fix, only if P0.7 finds the gap.

## What stays and what goes, in the code

All numbers are production lines. "Measured" means counted from named files. Per-file fates are in the Part C reviews:
- `97 Part C/app-session.md`, with every one of its 395 files given a fate;
- `97 Part C/app-shell.md` (598 files);
- `97 Part C/kit-relay-rest.md` (its kit rows).

Those reviews assumed new server contracts and a rebuilt timeline. Where today's contracts or the extra-care rules keep something alive, the tables below say so.

### Kept as it is (moved, re-skinned on v2 primitives, renamed to Claxedo names, stripped of comments; not rewritten)

| Module | Lines today | Where it lands in `claxedo-app-v2` | Notes |
| --- | --- | --- | --- |
| Transcript renderers, `session-ui/src/components/*` | ~15.6k | `src/transcript/` | `message-part.tsx`, Markdown with its worker, Shiki and cache, tool cards, file view and media, line comments, review code view, subagent chip, message nav, turn fold, question card, retry. The transcript rules apply ([Areas that need extra care](#1-transcript-rendering-moved-not-rebuilt)). The Linguist list (1.9k) and the Shiki theme (0.4k) become JSON assets. |
| Diff view, `session-ui/src/pierre/*` | 1.8k | `src/transcript/diff/` | As is |
| Transcript timeline: `message-timeline*.tsx`, `timeline-virtualization.ts`, `timeline-prepend-anchor.ts`, `message-timeline-observe-offset.ts`, `timeline-row-model.ts`, `timeline-mount-cache.ts`, `timeline-file-paths.ts`, `markdown-viewer.ts`, message nav and author | 5.5k → ~5.0k | `src/session/view/timeline/` | Logic unchanged, including its own turn logic. Only its data source changes: the new session store, which hands it today's shapes. |
| Composer editor core: `editor-dom`, `editor-keymap`, `editor-serialization`, `history`, `slash-popover`, `attachments`, `files`, `context-items`, image marks | ~2.3k | `src/composer/` | Kept inside the v2 `PromptInputV2` frame |
| Docks: question, permission, todo, goal | ~1.2k | `src/session/view/docks/` | Kept |
| Workbench component and reducers | 2.6k → ~1.5k | `src/workbench/` | Proven pane and split logic |
| Terminal backend: xterm, renderer, clipboard, keyboard, resize | ~1.3k | `src/terminal/` | Kept |
| Terminal link detection, including multi-line and fallback matchers | 1.5k → ~1.0k | `src/terminal/links/` | Ours; one provider set, fewer duplicated parsers |
| Command palette | 0.6k | `src/shell/palette/` | Kept |
| Auth routes: login, device approval, OAuth consent, CLI login | ~0.7k | `src/auth/` | Security boundaries; not squeezed |
| v2 kit components, taken from upstream's latest UI library (`anomalyco/opencode` dev, `packages/ui/src/v2` and `theme/v2`), not our older vendored copy | ~1.3k used, ~2.8k available | `src/ui/` | The one kit |
| Locales, 18 languages | not counted | `src/i18n/` | Keys for deleted features are removed |

### Moves to first-party plugins

| Plugin | Built from | Talks to | Budget |
| --- | --- | --- | --- |
| Tasks | the UI of `features/tasks/*` (4.6k) | today's Tasks API, `/api/claxedo/tasks` on the Claxedo server the app is connected to, unchanged | ≤ 2.5k as a plugin; 4.4k as the app domain it became (re-based; DECISIONS 2026-09-26) |
| Pages | the UI of `features/documents/*` (5.1k) | today's documents API, unchanged: control-plane operations (`documents.*`) when signed, the daemon's `/documents` routes when not | ≤ 3k |
| Compact tabs | `app/workbench/compact-switcher/*` (0.8k) | the app's workbench | ≤ 0.6k |
| Codex theme | `ui/icons/codex.ts`, `ui/codex-icon-map.tsx`, the Codex half of `claxedo-icon.tsx`, the `data-theme="codex"` overrides (~0.7k + sprite) | the app's theme and icon registry | ≤ 0.6k + assets |

The Tasks and documents server code stays on the server, unchanged.

### Goes, as whole files (measured)

| Group | Lines | Why |
| --- | --- | --- |
| Perf harness, `claxedo-app/perf-harness/**` | 34.6k | Not copied into v2; the benchmark driver moves to the benchmark repo in P0 |
| Storybook and stories | 16.8k | Not copied; deleted at the swap. `transcript-lab-fixture.json` moves into the transcript corpus first. |
| Dead code | 1.9k | No entrypoint reaches it |
| Processes pane (A3) and diagnostics (B3) | 5.2k | Features removed |
| Session state assembled from 4 sources, 6 caches and 16 per-session cache kinds | ~2.5k | One store per session and one session list store, fed by a snapshot and today's streams through the adapter |
| Directory-string routing spread through the app | ~3.0k | Project ids and `SessionRef` inside the app; only the adapter turns a placement into today's `directory=` |
| Second composer engine, `composer/v2` | 1.0k | Only a localStorage key or an unset build variable turns it on |
| Prepared-session scaffolding | 0.6k | One caller, which uses the result immediately |
| Copied server rules scattered through the app (error regex copies, harness lists, permission modes, token sums, subagent reducer) | ~2.0k | One copy each, in the adapter or its domain |
| Rail status polling spread across 8 files and the lifecycle→status listener | 1.7k | One status owner in the adapter ([Where today's contract falls short](#where-todays-contract-falls-short)) |
| Feature ports, registries, product composition | 2.9k | First-party code imports directly; plugins use the plugin host |
| Terminal replay twin (`replay-sanitize`, `replay-safe-slice`, `mode-scan` and friends) | 1.6k | The file itself says "DUPLICATED, deliberately"; the runtime's existing replay is used |
| Layout state duplicated across seven owners | 1.9k | One workbench state owner |
| Directory helpers, route shims, posture files | 1.3k | `SessionRef` and one capabilities reader |
| Files importing Part A/B deletions | 1.1k | Their features are gone |
| Architecture scanners and guard scripts in the app | 2.5k | Checks live in `script/` |
| Dead and dev-only routes | 0.7k | See [Goes](#goes) |
| Kit: dead files; v1 components with a v2 twin; generated icon tables; OpenCode icon libraries and artwork | 6.2k | Not carried into `src/ui/`; `packages/ui` and `packages/session-ui` are deleted at the swap |
| The old app's own `AGENTS.md` files (8 left, the package root's included) | — | Appendix A replaces the root one; each domain's `README.md` replaces the rest |
| **Whole-file deletions, total** | **~88k** (plus ~11k moving into plugins) | |

### Rebuilt (the concept stays, the file shrinks; estimated)

| Module | Today | After | What makes it smaller |
| --- | --- | --- | --- |
| Server adapter, new home of today's `platform/{api,runtime,sync,query,account,remote-access}` wire code | ~16k spread across the app | ~4.0k in `src/server/` | One transport; one wire module converting today's shapes into app types; one error table; one status owner |
| Session client, including the session list store | 31.1k | ~9.5k | One store per session and one list store with written reconcile rules; snapshot plus today's streams; `SessionRef`; pickers from one capabilities reader |
| Session screen, apart from the kept timeline and docks | ~13.8k | ~8.1k | v2; its own status and placement guessing goes |
| Composer | 12.0k | ~5.5k | `PromptInputV2` frame with Claxedo's slots; the 592-line `handleSubmit` closure → a ~150-line send |
| Rail and workbench | 21.8k | ~8.3k | One flat list over the list store; three groupers → one; route sync over `SessionRef`; one state owner; phone drawer and sheets |
| Browser tabs, `features/browser/*` | 1.4k | ~1.1k | v2 screens; one machine for loading and element picking; the 954-line `browser-pane.tsx` split into address bar, page host, console and picker. The desktop's `window.api.browser` bridge and `<webview>`, and the web's sandboxed preview, are unchanged. |
| Shell and platform | 26.2k | ~6.5k | One entry, capabilities instead of 11 build flags; the wire moves to the adapter |
| Terminal | 8.2k | ~4.3k | One attach path; links kept |
| Settings (with accounts, machines and remote access) | 12.3k | ~5.2k | One Accounts screen; one Machines screen; remote access still goes through today's desktop path; org and sharing move to Access |
| Access: roles, org, members and shares. Today in `platform/auth/role.tsx`, `org-team-section.tsx`, `org-team-api.ts`, the rail's org switcher and the share controls | ~1k | ~1.0k | One domain; one `can()` that answers from server facts only |
| Review, git, files | 8.6k | ~4.3k | Four file caches → one store |
| Projects and cloud workspaces | 5.7k | ~3.0k | One project model keyed by id; the hosted-first add flow; placements; today's lifecycle routes through the adapter |
| Onboarding and usage | 3.4k | ~1.8k | Through the adapter |
| Marketplace (agent plugins, as today) | 3.8k | ~1.8k | v2 screens over today's routes |
| UI kit (v2), `src/ui/`, including the no-twin components restyled (list, scroll view, popover, card, collapsible, dock surface, resize handle, file and provider icons, image preview) | ~12k | ~6k | One token source, one icon library, no v1 |

### New in the app

| What | Lines (estimated) |
| --- | --- |
| Plugin host: the primitives, the live-plugin loader and hot swap, the web iframe bridge, error boundaries | 1.7k |
| `machine()` helper for state machines | 0.1k |
| Four v2 components vendored from upstream (progress circle, split button, tab state indicator, wordmark) | 0.2k |

### Budget per part (enforced by a ratchet on `claxedo-app-v2`)

| Part | Budget |
| --- | --- |
| Server adapter | 8.2k in eleven parts (re-based: split by responsibility at measured sizes; DECISIONS 2026-09-26) |
| Session client, including the session list store | 9.5k |
| Session screen incl. the kept timeline and docks, with its phone layout | 14.3k |
| Composer | 11.0k (re-based: the 5.5k assumed the voided `PromptInputV2` frame swap; DECISIONS 2026-09-25) |
| Rail and workbench | 8.3k |
| Browser tabs | 1.4k (re-based: the parity ruling kept v1's chrome; DECISIONS 2026-09-26) |
| Shell and platform | 6.5k |
| Terminal | 4.3k |
| Settings | 5.2k |
| Access | 1.0k |
| Review, git, files | 4.3k |
| Projects and cloud | 3.0k |
| Onboarding and usage | 1.8k |
| Plugin host | 2.1k, plus the web plugin frame 0.9k (re-based; DECISIONS 2026-09-26) |
| Marketplace | 2.3k (re-based: v1's directory under the parity rule; DECISIONS 2026-09-26) |
| Moved in from the session feature (rail rows, review clients) | 0.6k |
| State-machine helper | 0.1k |
| UI kit (`src/ui/`) and kept transcript renderers (`src/transcript/`) | ~20k |
| **Total** | **≤ 94k** (the parts add up to 98.5k; the enforced total is the measured app, not the sum) |

## The server adapter

`src/server/` is the only module that knows today's server: its routes, its OpenCode-shaped payloads and event names, and how to reach a daemon, the control plane or the relay. Every domain calls it with Claxedo types and gets Claxedo types back. Nothing outside it imports `src/server/wire/`.

| File | Owns |
| --- | --- |
| `transport.ts` | Authenticated requests to the daemon, the control plane and the relay; event streams resumed by `Last-Event-ID`, with bounded, visible reconnect |
| `errors.ts` | The one table from today's responses (status and body) to error classes (`auth`, `rate_limit`, `network`, `not_found`, `conflict`, `invalid`, `internal`) |
| `wire/` | Today's shapes (`sessionID`, `message.part.updated`, `prompt_async`, `?directory=`) and their conversion to app types, both ways |
| `sessions.ts` | List (the same route the product uses today), snapshot, subscribe, create, prompt, stop, answer permissions and questions |
| `status.ts` | Session status from the snapshot and the stream (`session.status`, `session.idle`, `session.error`, `permission.asked`, `question.asked`): one owner, where today it is spread across 8 files |
| `projects.ts` | Project records by id through `/api/claxedo/projects`, the same route on every deployment ([The projects route](#the-projects-route)) |
| `workspaces.ts` | Placements (folders, worktrees, cloud workspaces) and machines; `SessionRef` → the directory that today's routes need |
| `capabilities.ts` | One `Capabilities` value derived from today's agent catalog, account state and service list |
| `files.ts`, `git.ts`, `terminal.ts`, `accounts.ts`, `usage.ts`, `marketplace.ts`, `cloud.ts`, `machines.ts` | The rest of today's routes, one area each |

**Reconnecting.** A reconnect resumes from the last event id, as today's stream allows. When the server answers with a `stream.replay-gap` frame (the cursor fell out of its retention window, or a slow connection shed a frame), the adapter re-reads the sessions that stream feeds, as today's reader does.

When the server is rebuilt later, only this folder changes.

### Where today's contract falls short

**1. Does harness session status reach the app as events?** The evidence points both ways:
- **Today's rail says no.** `rail-sidebar-status-poll.ts` says the server does not push `session.status` for harness (ACP, Claude) sessions, so the rail re-reads status every 5 seconds, the first time after 250 ms.
- **The runtime code suggests yes:**
  - harness turns publish `session.status` busy when they start and `session.idle` when they end;
  - `bridgeLifecycleEvent` in `session-core/src/routes/session.ts` forwards those, plus permission and question requests and errors, as `agent.lifecycle` events;
  - both existed before the poll was written.
- **How P0.7 settles it.** It runs scripted Claude and ACP turns on the real stack and records which of those frames arrive on the stream the app reads.
  - **If they all arrive:** `status.ts` keeps no timer.
  - **If some never arrive:** `status.ts` keeps one bounded 5-second re-read, in one place instead of eight files. You then decide whether a small runtime fix is worth it. It would keep the event name and shape, and only send the event where it is missing today.

**2. Hosted has no projects route.** Approved: one projects route, served the same way on every deployment ([The projects route](#the-projects-route)).

**Pages needs no server change.** Today's documents API already works in both setups:
- **signed:** through control-plane operations;
- **unsigned:** through the daemon's `/documents` routes, git-backed in the project.

## State, caching and fetching

**Today**, from a read of the code:
- **The transcript is held four times:**
  - a module `Map` of `@tanstack/ai-client` chat clients;
  - a TanStack Query mirror;
  - an IndexedDB store (`claxedo-conversations-v2`) with no size or age limit;
  - a message-prefetch copy.
- **Every streamed text delta:**
  - copies the message and part arrays;
  - makes `setQueryData` walk the whole value for structural sharing;
  - queues an IndexedDB write with no debounce, twice.
- **Session rows live in six caches** kept in step by hand. Event handlers write rows with `setQueryData`, then invalidation "doorbells" refetch what they just wrote. The code documents the races.
- **Session status has 25 writers.** A timer ladder (8 s, 20 s, 45 s, 5 min) makes up a `retry` status. More polls run: a 5 s status poll after 60 s, the rail's 5 s poll, the queue every 1 s, processes every 5 s, health every 20 s, the server every 10 s.
- **The query cache holds things that aren't data:** in-flight Promises and counters.
- **Query keys are scattered:** 7 key families with 34 builders, an open-ended shell key space, 31 literal keys written in place, and 9 harness key builders.
- **Persistence:**
  - 19 `persisted()` sites and about 20 raw `localStorage` uses;
  - a hand-written IndexedDB query persister, which drops its whole snapshot past 2 MiB.
- **Libraries used for little:** `@tanstack/ai` and `@tanstack/ai-client` serve only as a message-array holder and an IndexedDB persistor; their connection is a no-op. `@solid-primitives/event-bus` re-emits frames per scope inside an effect with no cleanup.

**The redesign.** One mechanism per kind of data, one home per entity, and a library for every generic part.

| Kind of data | Home | Library |
| --- | --- | --- |
| Data the server pushes: session rows, status, the transcript (messages and parts), permission and question requests, todos | One normalized Solid store per domain, fed by the snapshot and the stream through the adapter | `solid-js/store`: a text delta updates one text node, with no copies and no deep compare |
| Data the app fetches: projects, machines, accounts and providers, tasks, the documents index, Marketplace, usage, the file tree, file content and status, git status and log, diffs on demand | The TanStack Query cache | `@tanstack/solid-query`, kept: caching, dedup, pagination, retries and background refetch are not ours to write |
| Preferences | `makePersisted`, keyed by user and `SessionRef` | `@solid-primitives/storage`, kept |
| The warm-boot transcript cache, only if the benchmark needs it | IndexedDB, written when a turn ends, never per delta, with a size cap | `idb-keyval`, kept |
| The event stream | An SSE client that resumes by `Last-Event-ID` | A maintained SSE library in place of today's hand-written 753-line client; a P0 spike picks between `eventsource` (with a custom fetch) and `eventsource-parser` |
| State machines | `machine()` | None, because a ~100-line helper covers flat state unions |

**Rules:**
1. **Every entity has one home.** Pushed data never enters the query cache, and fetched data is never copied into a store.
2. **Events never write into the query cache.** They invalidate, through one table in `src/server/` that maps each event to query keys. `setQueryData` is used only for a mutation's own result, inside `src/server/`.
3. **Query keys come only from the query options** exported by `src/server/<area>.ts`.
4. **The query cache holds only server data:** no Promises, counters or UI state.
5. **Cache timing:** `staleTime` is infinite for data an event invalidates, and `gcTime` is bounded. Retries happen only for the `network` and `rate_limit` error classes.
6. **Streaming deltas** are coalesced per animation frame and applied in place. Nothing is copied or persisted per delta.
7. **Every cache has a bound:**
   - transcript stores for the 8 most recently open sessions;
   - a 10-minute `gcTime`;
   - IndexedDB at 20 sessions or 64 MiB.
8. **Status comes only from server facts.** No timer makes up a status.
9. **No app-wide event bus.** The adapter hands each frame to the domain stores through one typed switch.
10. **The transcript keeps the timeline's input shape.** The store produces the rows the timeline builds from today, and `@tanstack/ai`'s message wrapper goes.

**Dropped:**
- `@tanstack/ai`, `@tanstack/ai-client` and `@tanstack/ai-solid`;
- `@solid-primitives/event-bus`;
- the hand-written query persister;
- the conversation registry, hydrator and persistor.

**Not adopted:**
- **TanStack DB:**
  - it is beta (0.9), and its Solid adapter has only `useLiveQuery`;
  - each streamed delta would run a dataflow pass.
  - Revisit it at 1.0, for the session list.
- **TinyBase, LiveStore, Zero and Electric:** each brings its own sync model or server protocol.

**Why it matters for speed (to be measured in P2):** each delta goes from several whole-array copies, a deep compare and two IndexedDB writes to one in-place update per frame. That is the likeliest lever for the idle-CPU and long-row targets.

## The projects route

You approved one projects route that the local server, the self-hosted app and the hosted worker all serve the same way.

**Today:**
- **Local.**
  - `claxedo-local-server/src/workspace/routes/projects-route.ts` serves `/api/claxedo/projects`: list, create, `by-directory`, and name and environment edits.
  - Records live in the server-core workspace store (`workspaces.json`).
  - A project's id is its root workspace's UUID, and worktrees share it through `repo_key`.
- **Self-hosted** mounts the same router, and files a SQLite authority row under the local id.
- **Hosted** has no projects route.
  - A cloud-workspace create derives the project from `(org_id, repo_key)` or mints a `prj_…` id, and inserts rows into `projects` and `project_memberships`.
  - The D1 `projects` table has no name or environment column.
  - Hosted `GET /project` groups projects out of the workspace list, using name heuristics.

**The change:**
- **One route module in server-core,** `/api/claxedo/projects`, over a `ProjectStore` port:

  | Endpoint | Does |
  | --- | --- |
  | `GET /` | List the projects the caller may read |
  | `POST /` | Create from a source: a repository (URL, or connection + full name), or a folder on a machine |
  | `GET /:id` | Read one project |
  | `PATCH /:id` | Rename; set its environment |
  | `DELETE /:id` | Remove the project and unregister its placements. Folders on disk are untouched; cloud workspaces must be deleted first (409) |

- **Two store adapters:**
  - the local one wraps today's workspace store;
  - the D1 one adds `name` and `env` columns by migration. It reuses the `repo_key` derivation, so a project created first and one created by a cloud-workspace create agree on ids.
- **Mounted three times:** by the desktop's local server, the self-hosted app and the hosted worker.
- **Access:** checked through the one access policy ([Roles, permissions and orgs](#roles-permissions-and-orgs)).
- **Ids:** opaque and minted per deployment (a UUID locally, `prj_…` on hosted). The app never parses them.

**Deleted at the swap** (they serve only the old app):
- `projectName` on cloud-workspace create: `createCloudBody`, `CreateCloudWorkspaceInput`, and the desktop's forwarded body;
- the onboarding's hosted `draftProjectName` branch;
- the `signedShellProjects` name heuristics and the synthetic `hostedProject()` in `routes/hosted/shell.ts`;
- `GET /by-directory`, because v2 never looks a project up by folder;
- the hosted-operation inventory's exemption for the missing route;
- the OpenCode-shaped `/project` and `/project/current` routes, once nothing but the old app reads them.

**Verification:** flows 2 and 32 run against both the local server and the hosted worker, and each reads the project back by id.

## Roles, permissions and orgs

This section is the one place the plan defines who may do what. In the app, `src/access/` is the one place that code lives.

**Two different words.**
- **Access** is who may do what: org roles, session shares, machine ownership.
- **Agent requests** are an agent asking to run a tool, or asking a question. The UI keeps the word "permission" for those prompts.
- **In code the two never share a name.** Access lives in `src/access/`, and agent requests in `src/session/requests/`.
- **Today they collide.** The runtime's access table lists agent-prompt operations (`permission_list`, `permission_response`). The app has a stub `/permissions` page and, in `composer/role-gate.ts`, mixes access with permission modes.

**The model**, from your rulings:

| Concept | What it is | What it grants |
| --- | --- | --- |
| User | A signed-in person, or the machine's own identity when unsigned | — |
| Org | A group of people | Nothing on any machine, folder or project |
| Org role | Owner, admin or member | Owners and admins manage the org's provider accounts, org plugins and network policy. Members manage nothing. |
| Machine | A computer running Claxedo, owned by one user | Only its owner runs agents, opens terminals and reads folders on it |
| Project and its placements | A record with an id, and where it runs | Its owner's. Others see it only through a shared session. |
| Session share | The only grant between people: **follow** (read) or **send** (read and prompt) | That one session, until revoked. A share never controls the machine. |
| Provider account | Chosen per user, per provider: an org account or a personal one | Only the machine owner may fall back to the machine's own keys and logins |

**Today, in code:**
- **About 28 places on the server decide access, in three vocabularies:**
  - the control plane, with SQLite and D1 twins of each rule;
  - the runtime's `SessionAccessPolicy`, `denyWorkspaceViewers` and host-capability checks;
  - the relay's `roleAllowsRelayRequest`.
- **Where the server disagrees with your rulings:**
  - An org owner or admin ranks as admin on every org workspace, members' machines included (`orgWorkspaceRole`).
  - Team grants give roles on projects (`grantTeamProject`).
  - A `send` share can answer agent prompts, because `permission_response` counts as an agent-turn operation.
- **The members list has no server route.** Adding or removing members has none; `addOrganizationMember` has no caller.
- **The app:**
  - it copies the relay's and runtime's rules on the client (`RolePolicy` and `can()` in `platform/auth/role.tsx`);
  - it doesn't gate the org and team screens on role, so the server answers 403 instead;
  - it keeps the active org and team only in browser storage, where nothing else reads them.

**v2's `src/access/` domain:**
- **It holds** the principal, the user's org and role, the member list, and each session's shares.
- **It has one `can(action, subject)`.** It answers only from facts the server reports: the runtime's `capabilities.prompt`, the session's `can_manage_shares`, and the org role. It never re-derives a server rule, so `RolePolicy` goes.
- **Screens:**
  - one Settings page, **Organization**: members, roles, the org's provider accounts;
  - the share control on a session: follow or send, and revoke;
  - no team screens, unless you keep teams (open decision 3);
  - no org switcher, because today's server resolves one org per user.
- **Flow 36** checks the rules today's server already enforces:
  - org settings open only to owners and admins;
  - a follow share reads, a send share prompts, and revoking ends both.

**On the server (open decision 1).** One policy module in server-core would hold the table above.
- Every one of the ~28 sites asks it.
- SQLite and D1 only fetch facts.
- The relay and runtime read the same table through their token claims.

That removes the three disagreements above. It touches the security boundary everywhere, so I recommend running it as its own slice right after this push, with its own flows and review.

## The app shell

**Today.** The shell is spread across `app/`, about 46k lines:
- **Size:**
  - `app/workbench` is 24.8k: the rail 8.5k, workbench state and route sync 6.2k, the workbench 2.8k, review 1.9k;
  - then `app/integrations` 4.8k, `app/providers` 4.6k, `app/dialogs` 2.2k, `app/routes` 1.7k, and entry, boot and composition 3.6k.
- **Pages are panes.** Marketplace, Tasks and the Pages index are workbench content types beside sessions and terminals, so they split, drag and persist like panes.
- **Settings is its own route.** `/settings/<section>` swaps the rail for `settings-nav.tsx`, which copies the rail's row component.
- **Routing and layout state are tangled.** `ShellRoute` still has a `legacy-directory` kind, layout state has seven owners, and `route-bridge.tsx` alone runs past 690 lines.
- **Phone behavior is scattered** across `ui/controls/breakpoints.ts`, the workbench, the workspace panel, the terminal accessory row and the browser pane.

**v2: three regions and one page tab**, your structure:

| Region | Holds | Behavior | On a phone |
| --- | --- | --- | --- |
| Left sidebar | **Main** mode: projects, sessions, and rows for Tasks, Pages and Marketplace. **Settings** mode: the settings sections | Resizable, collapsible | A drawer |
| Workbench (center) | Split panes: sessions and drafts, terminals, files, Pages documents | Split, tabs, drag, restore | One pane at a time, with a pane switcher in the top bar |
| Page tab (center) | One reusable tab for Marketplace, Tasks, Settings, the Pages index and plugin pages | No split, no drag; opening another page reuses it; its state is the URL | Full screen |
| Workspace panel (right) | Tabs: Files, Changes, Browser, Subagents, Context | Resizable, collapsible | A sheet |

**The component.** `src/shell/` draws the regions and knows nothing about features:

```tsx
<AppShell
  sidebar={{ mode: route.sidebarMode, main: <MainSidebar />, settings: <SettingsSidebar /> }}
  center={route.page ? { kind: "page", page: route.page } : { kind: "panes" }}
  panel={{ tabs: panelTabs() }}
/>
```

- **What it owns:** resizing, collapsing, the phone drawer, sheet and pane switcher, focus order, and one error boundary per region.
- **Region state:** one `ShellLayout` machine holds each region's state (open, collapsed, drawer, sheet).
- **The URL is the source of truth** for the center (a page, or the active pane) and for the sidebar mode. A settings path means settings mode.
- **Preferences:** the pane layout and the panel's width and tab are per-user preferences, kept per project.

**What fills it: typed registries, one entry type per region.**
- **The types:**
  - `PageEntry`: `id`, `path`, `title`, `icon`, `sidebar: "main" | "settings"`, `view`;
  - `PaneKind`: `kind`, `title`, `view`, `restore`;
  - `PanelTab`;
  - `SettingsSection`.
- **First-party entries** are static arrays in `src/shell/registry.ts`, so every page, pane kind and tab can be found in one file.
- **Plugins** add entries of the same types while they are on. Marketplace is a first-party `PageEntry`; Tasks and Pages register theirs.

**Routes, by id only:**
- `/w/<workspaceId>/s/<sessionId>` and `/w/<workspaceId>/t/<terminalId>`;
- `/marketplace`, `/settings/<section>`, and each page's own path (`/tasks/<taskId>`, `/pages`);
- no directory routes, and no `legacy-directory`.

**Size.** The frame (regions, the layout machine, the router, the registries, phone behavior) targets about 1.5k lines within the shell budget. The sidebar's contents, the panes and the panel tabs belong to their domains.

## How plugins work (now)

**Scope.**
- **First-party plugins** are bundled from `plugins/`.
- **User plugins** are prompted from inside the app and applied live ([Live plugins](#live-plugins)).
- **Not now:** plugins that run on the server or on hosted cloud workspaces come later.
- Every plugin can be switched on or off in Settings.

A plugin is a package with a small manifest and an app entry: `activate(api)` registers what it contributes. The host gives it only what the four first-party plugins use, and user plugins get the same API.

| Primitive | Used by |
| --- | --- |
| `sidebar.item`: a row in the main sidebar that opens a page | Tasks, Pages |
| `pages.register`: a page in the page tab, with its own path | Tasks, Pages |
| `panes.register`: a pane kind in the workbench, with its restore state | Pages documents |
| `settings.section`: a section in the settings sidebar and page | Tasks presets |
| `overlays.register`: a keyboard-invoked overlay | Compact tabs |
| `commands.register`, with keybindings | all |
| `mentions.register`: items in the composer's `@` menu | Tasks, Pages |
| `workbench`: list tabs with status, activate, close, move | Compact tabs |
| `themes.register`, `icons.registerSkin` | Codex theme |
| `sessions`: create with a prompt and attachments, status, open | Tasks |
| `projects`: list, and the current project's id | Tasks, Pages |
| `server`: authenticated calls through the adapter, limited to what the manifest names. That is route prefixes on the Claxedo server (Tasks: `/api/claxedo/tasks`) and control-plane operations (Pages: `documents.*`, which the adapter sends to the control plane when signed and to the daemon's `/documents` routes when not, as today). | Tasks, Pages |
| `context`, `ui` (toast, confirm), `i18n.t` | all |

Every contribution renders inside the plugin's error boundary, so a failing plugin can't take down the app, and it gets the shell's phone behavior.

### At runtime

1. **Build.** The four plugins are workspace packages under `plugins/`, listed in `src/plugins/bundled.ts` by static import. Their heavy views load through `import()` with literal paths, so bundles stay split and the import graph stays readable.
2. **Boot.** Once the adapter has a connection and `Capabilities`, the host checks each plugin. A plugin activates when both of these hold:
   - the user hasn't switched it off (a per-user preference; on by default);
   - its `requires` are met: Tasks needs the tasks route on the connected server, and Pages needs the documents API.
3. **Activate.** The host runs `activate(api)` inside a Solid root that belongs to the plugin. Every registration (`sidebar.item`, `pages.register`, `commands.register`, …) adds an entry to the shell's registries, tagged with the plugin's id, and removes it again when that root is disposed.
4. **Render.** The regions read the registries reactively. The plugin's rows, pages, panes and commands appear without a reload, each inside the plugin's error boundary.
5. **Change.**
   - Switching a plugin off disposes its root. All its entries disappear, and an open page or pane of its kind shows "plugin off" in place.
   - Switching it on activates it again.
   - When capabilities change (sign-in, sign-out, another server), the host re-checks `requires` and activates or disposes to match.
6. **Failure.** If `activate` throws, the plugin's machine moves to `failed(reason)`, its root is disposed, and Settings shows why. A render error stays inside the boundary where it happened.

**Trust.**
- **First-party plugins, and user plugins on desktop,** run in the app's own JavaScript. The manifest's route list catches mistakes; it is not a sandbox.
- **On the web,** user plugins run in a sandboxed iframe ([Live plugins](#live-plugins)).

**Parity lists:**
- **Tasks:** create a task (title, Markdown, images, To do/Backlog, project); list and board views with filters; presets; Start → a session with the task as the first message; agents' task tools keep working, because the server side is unchanged.
- **Pages:** index; rich and source editing with slash commands and Mermaid; version history; conflict recovery; `@page` mentions; create from a repo file. It works signed and unsigned, as today.
- **Compact tabs:** a keyboard switcher over open tabs with their status; switch, close, reorder.
- **Codex theme:** the Codex tokens and icon skin as a selectable theme. The icon artwork carries an unresolved licence note, so it lives in a plugin that can be shipped or withheld on its own.

**Next, when a plugin needs a backend.** The design is known: a plugin's backend is a Workers module run by the control plane.

- **Isolation:** Cloudflare Dynamic Workers run each backend in its own isolate.
- **Storage:** Durable Object Facets give each org its own SQLite.
- **The supervisor:** a supervisor Durable Object checks authentication, the caller's role and the plugin's permissions first.
- **What the backend can reach:** an egress gateway limits its network, and a narrow platform API is its only way into Claxedo.
- **Status:** both Cloudflare features are open beta on Workers Paid.

It is not built in this slice.

## Live plugins

A user asks an agent, inside the app, for a plugin, and the running app picks it up without a reload.

**How bb does it** (read from `~/test/bb`):
1. **Create.** The agent scaffolds a plugin package and registers its folder in place.
2. **Rebuild.** A dev loop rebuilds with esbuild on every save and tells the server to reload.
3. **Swap.** The server swaps the plugin's backend inside its own process, serves the frontend as a hashed bundle, and broadcasts `plugins-changed`.
4. **Reload clients.** Every open client imports the new bundle and swaps its slot registrations. The new version starts before the old one is disposed, and a failed load keeps the old one.
5. **Learning the API.** The agent learns it from a skill that the `bb-guide` plugin adds to every session.
6. **Trust.** There is no sandbox. Plugins are full trust, gated only by an install confirmation, and each slot has an error boundary.

**In Claxedo:**
1. **One format.** A plugin is a package whose `package.json` has a `claxedo` block: `id`, `name`, the `app` entry, `requires`, and the server routes it may call. The four first-party plugins use the same format.
2. **Where it lives.** A folder inside the session's workspace, registered in place with the daemon by `app_plugin_add`. The registry belongs to the machine's owner.
3. **Build.** The daemon watches registered folders, builds them with esbuild, and serves each build as a hashed, immutable bundle. The app provides `solid-js`, the plugin API and the v2 kit at runtime, so plugins stay small and look native.
4. **Notify and swap.** The daemon sends `plugins.changed` on the stream the app already reads.
   - The host activates the new version in a fresh root, then disposes the old one.
   - A version that fails to activate leaves the old one running and shows the error.
5. **Where it runs, by your ruling:**
   - **Desktop:** in the app's own JavaScript, with the app's full reach, at the user's own risk. Adding a plugin asks for confirmation once.
   - **Web:** in a sandboxed iframe (`sandbox="allow-scripts"`, no same-origin) placed in the plugin's page, pane or panel tab.
     - The plugin API reaches the iframe over `postMessage`, limited to the manifest's primitives and routes.
     - The host passes the v2 tokens in, so the plugin looks close to native.
6. **Prompting.**
   - The Claxedo MCP server exposes `app_plugin_create`, `app_plugin_check`, `app_plugin_add`, and `app_plugin_guide` to the machine owner's own sessions across Claude Code, Codex, OpenCode, and Pi.
   - `app_plugin_check` typechecks against the API, then builds. The guide carries the API reference and examples; there are no plugin CLI commands or harness-specific authoring skills.
   - "Make me a plugin that …" ends with an in-app confirmation before the plugin runs.
7. **Safety nets:**
   - an error boundary per contribution;
   - Settings → Plugins lists every plugin, with on, off and remove;
   - safe mode starts the app with every user plugin off;
   - a user's plugins load only in that user's app, never in someone else's view of a shared session.
8. **Not in this slice:** user plugins running on the server, and plugins for hosted cloud workspaces.

**New daemon pieces:**
- `GET /api/claxedo/live-plugins`;
- the bundle route, `GET /api/claxedo/live-plugins/:id/:hash/app.js`;
- add and remove;
- the folder watcher and build;
- the `plugins.changed` event.

**A2UI as the UI shape.** I read a2ui.org.
- **What it is:**
  - a declarative UI protocol from Google, under Apache-2.0;
  - v0.9.1 is current, and v1.0 is a candidate whose stable release is targeted for Q4 2026. It calls itself an early public preview.
- **How it works.** An agent sends JSON surfaces built only from a component catalog the app owns. The app renders them natively and routes their actions to its own handlers.
- **Strengths:**
  - It is data, not code, so it is safe anywhere, even on the web without an iframe.
  - It could use the v2 kit as its catalog.
- **Limits:**
  - It has no logic: no expressions and no conditionals, only a few format and validation functions.
  - The basic catalog has no charts or tables.
  - There is no SolidJS renderer. We would write one over `@a2ui/web_core`, which also brings Preact signals and Zod.
- **Recommendation:** plugins stay code (`activate(api)`), because a prompted plugin usually needs logic. A2UI fits later for agent-generated UI inside the transcript, where the agent sends data rather than code. It is not in this slice.

## Retiring OpenCode naming

Inside the app, only Claxedo names. The server keeps its names in this slice, and `src/server/wire/` is the one folder that uses them.

| Debt | Today | In v2 |
| --- | --- | --- |
| Kit package names `@opencode-ai/ui`, `@opencode-ai/session-ui`, and the `@opencode-ai/app-shared` alias | 610 imports in 249 files | The app's own `src/ui/` and `src/transcript/`; the alias is deleted |
| OpenCode id casing: `sessionID`, `messageID`, `partID`, `providerID`, `modelID`, `callID`, `projectID` | ~2,300 uses | App-defined names use `sessionId` and the rest. The runtime contract package's own fields (`sessionID`, `parentID`, …) stay: the transcript and the session store use its message and part types as they are, because converting every part would be a second copy per delta. Renaming them is a server-contract change for the server rebuild. |
| OpenCode event names: `message.part.updated`, `message.updated`, `session.status`, `session.idle`, `session.updated`, `permission.asked`, `question.asked` | 115 uses in 44 files | Claxedo events inside the app (`itemUpdated`, `turnStarted`, `turnFinished`, `requestOpened`, …); mapped at the adapter |
| OpenCode routes (`prompt_async`, `/experimental/session`, `/session/:id/message`) and `?directory=` routing | 82 uses in 40 files | Only in the adapter; the app uses project ids and `SessionRef` |
| Projects kept in browser storage by folder path (`projects.local[].worktree`) | the app's project list | Project records by id from the server |
| OpenCode app-shell concepts: `globalSDK`, `globalSync`, the server picker, `layout.v6`, `default.dat` storage, `Persist.*` keys by directory | 336+ uses | One store per domain; `persisted()` keyed by user and `SessionRef` |
| OpenCode UI hooks: `data-component`, and `data-slot` outside the kit | 2,782 uses in 286 files | App code uses kit components; `data-slot` stays inside `src/ui/` only |
| `oc-` prefixes | 11 | `claxedo-` or neutral names |
| OpenCode icon libraries and artwork, `OpencodeTheme` names | icon sets, themes | One Claxedo icon library; the Codex skin → plugin |
| Upstream code vendored verbatim (`lib/search-keydown.ts`) | 127 | Rewritten |

"opencode" as the name of the OpenCode agent (the ACP preset and the server adapter) stays; that is the external product's name.

## State machines

`claxedo-app-v2` declares these machines in each domain's `model.ts`. Where the server owns a lifecycle, the machine is fed only by the adapter's mapping of today's server data and events; views never guess.

| Machine | States | Owner |
| --- | --- | --- |
| Connection (daemon or relay) | connecting, connected, reconnecting(attempt), offline(reason) | server adapter |
| Stream | opening(cursor), live(cursor), rereading (after a replay gap), failed(class) | server adapter |
| Auth | signedOut, signingIn, signedIn(principal), expired | auth |
| Session list | subscribing, fetching (events held), live, rereading, failed(class); each row is pending, confirmed or tombstoned | session list |
| Session row | draft, creating, ready(status), archived, failed(class) | session |
| Turn | queued, running, waitingOnUser(request), finished(outcome), failed(class), cancelled | session |
| Request: permission or question | open, answering, answered, expired | session |
| Composer send | editing, sending, accepted, rejected(class) | composer |
| Attachment | reading, ready, failed(class) | composer |
| Add project | choosingSource, choosingAgent, choosingPlacement, creating, created(projectId), failed(class) | projects |
| Browser tab | loading(url), ready(url), picking(url), failed(reason) | browser |
| Terminal | connecting, attached, detached, exited(code) | terminal |
| File view | loading, ready, missing, failed(class) | review and files |
| Cloud workspace | provisioning, starting, ready, stopping, stopped, failed(reason) | cloud |
| Remote access | off, publishing, published, paused, failed(reason) | machines |
| Plugin | off, loading, on(version), swapping(to version), failed(reason) | plugin host |
| Shell layout | each side region: open, collapsed, or on a phone drawer or sheet (open or closed); the center: panes or page(ref) | shell |
| Onboarding | one state per step, plus done | onboarding |

The transcript's own state stays as it is today (moved, not rebuilt).

**The helper.** `machine()` (~100 lines) takes the state union, the event union and a pure `transition`, and gives a Solid store with `send(event)` and `state()`. There is no state-machine library. Views switch on `state().kind`.

## Conventions and their checks

The conventions for this work live in `packages/claxedo-app-v2/AGENTS.md` ([Appendix A](#appendix-a-packagesclaxedo-app-v2agentsmd)). A `CLAUDE.md` next to it holds `@AGENTS.md`, so Claude and Codex read the same rules there.

Every rule a machine can check is checked. These checks run over `packages/claxedo-app-v2` and `plugins/`, and must be at zero there. Nothing outside the new work is checked by them.

| Check | Fails on |
| --- | --- |
| No comments | Any comment that isn't a tool directive |
| Size | A file over 300 lines, a function over 40, a component over 120. The moved transcript files are measured but not split in this rebuild. |
| v2 only | An import from `packages/ui` or `packages/session-ui`, or a v1 token |
| Claxedo names | The retired names, anywhere except `src/server/wire/` |
| Adapter boundary | An import of `src/server/wire/` from outside `src/server/` |
| No swallowed errors | `.catch(() =>`, an empty `catch`, matching on error text outside `src/server/errors.ts` |
| No polling | `setInterval`, and `setTimeout` loops outside the named owners: the stream reconnect, and `status.ts` if P0.7 finds harness status that never arrives |
| One home per datum | `setQueryData` or `setQueriesData` outside `src/server/`; a literal query key; an `@tanstack/ai*` or event-bus import; a query for pushed data (sessions, transcript, status, requests); module-level mutable `let` in a domain |
| Domain boundaries | An import of another domain except through its `index.ts` |
| One owner | The same exported name defined in two domains; duplicated blocks over 25 lines |
| No directory identity | A folder path used as a key, a route parameter or a stored project identity outside `src/server/` |
| Access boundary | A role, rank or share rule outside `src/access/`: comparing role names, or reading `capabilities.prompt` or `can_manage_shares` anywhere else |
| Protected areas | A change under `src/transcript/`, the timeline or `src/session/list/` in a CI run that skipped flows 30 or 31 |
| e2e hygiene | A CSS-class selector, `waitForTimeout`, a spec without its flow number, or a mock of a Claxedo component |

## End-to-end tests

### The goal: better than v1, and provably so

v1's suite is 58 specs and 56.8k lines. 32 of those specs run against `mock-runtime.ts`, a hand-written fake of 70 server routes. So a green run proved the app agreed with a fake; it said nothing about the system.

The v2 suite must beat that on five measurable criteria. Each is checked at every phase gate and again at the swap.

| Criterion | What it means | How it is measured |
| --- | --- | --- |
| **Robust** | Same result every run; nothing timing-dependent | Before a spec merges, it passes 20 runs in a row locally and 3 repeated runs in CI. At the swap, the last 20 CI runs of the full suite have zero flaky failures. No sleeps; agents and model responses are scripted and deterministic; each spec has its own data directory. |
| **Better than v1** | Covers at least everything v1 covered, and the parts v1 couldn't | A coverage map from all 58 v1 specs to v2 flows: every user-visible behavior a v1 spec asserted is asserted by a v2 flow, or listed as dropped with the reason. Zero specs against a mocked server (v1: 32). Real-stack flows v1 lacked: signed web on the Worker and D1, team sharing across two browsers, cloud workspaces, plugins, the transcript corpus, session-list races, the phone layout on the real stack. |
| **Works** | Green on the real stack | All flows green on CI at each phase gate. The baseline flows are green on both apps. |
| **Honest** | A green run means the product works | The four rules below. |
| **Fast** | Agents actually run it | One flow runs in 60 seconds or less locally on a warm harness. The harness starts in 10 seconds or less. The full suite runs in 12 minutes or less on CI, sharded; the transcript corpus runs as its own shard. v1's durations are recorded in P0 for comparison. |

**The four "honest" rules:**
1. **Fakes only at external boundaries:** the scripted model endpoint, a scripted ACP agent, a local sandbox driver, a scripted OAuth provider.
2. **No test-only paths in production code:** no dev event emitters, no `window.__claxedo*` hooks.
3. **Every spec asserts both sides:** the user-visible result, and one fact read back from the server.
4. **Every spec is proven able to fail.** Each has a recorded red run: the scripted model or agent returns the failure, or the feature is switched off, and the spec fails. When a spec asserts an absence or a filter, it checks every route that answers the same question, not only the one it happens to call.

### The harness

`claxedo-app-v2/e2e/` runs a real app against the real daemon and runtime.

- **Which app.** A launcher option `--app=v1|v2` picks today's app or v2, so the baseline flows run against both.
- **Web, phone and desktop.** The web app is served by the daemon, and runs at desktop width and, in the `phone` project, at 390×844 with touch. The desktop is the Electron app, packaged or dev, loading either renderer.
- **Agents:**
  - a **scripted ACP agent** (a small test process speaking ACP), for deterministic transcripts of every part kind and for replaying corpus cases;
  - **real Claude Code and Codex CLIs** pointed at `scripted-model-server.ts`, for agent-specific flows.
- **Signed and team flows:** `wrangler dev` (Worker + local D1) plus the relay (`wrangler dev`) and an enrolled machine agent.
- **Cloud workspaces:** a local sandbox driver, which runs the sandbox image as a local process.
- **Kept helpers** from the old `e2e/`: `real-local-server.ts`, `electron-app.ts`, `desktop-daemon.ts`, `scripted-model-server.ts`, and the rail, geometry and terminal observers where still useful.
- **Selectors:** roles and accessible names first, then the frozen hook list ([Performance gate](#performance-gate)). No CSS-class selectors, no sleeps.

### The flows

A flow marked **B** (baseline) must pass on today's app and on v2. A flow marked **N** (new) runs on v2 only; where today's app can run it, its result is recorded but not a gate.

| # | Flow | Setup | Mark |
| --- | --- | --- | --- |
| 1 | First run and onboarding: detect agents, add project, first prompt | desktop unsigned | B |
| 2 | Projects, local: add a folder, clone a repo, rename, remove; each project's id is read back, and routes and deep links use it | local web | N |
| 3 | Send a turn; the transcript streams every part kind (text, reasoning, read/list/grep/web/shell/edit/patch/todo/MCP tool cards, images, diffs, Mermaid, math) | local web | B |
| 4 | Stop, queued messages, reload mid-turn → the failure shown | local web | B |
| 5 | Errors by class: rate limit, auth, network (scripted model returns 429/401) | local web | B |
| 6 | Composer: attachments with image marks, `@file`, slash commands, pickers, permission mode | local web | B |
| 7 | Goal mode: native (Codex) and evaluated (Claude) | local web | B |
| 8 | Permission prompts and questions answered | local web | B |
| 9 | Subagents: created by the agent, opened, navigated | local web | B |
| 10 | Session list: flat order, live status for a harness session (working → waiting → idle), archive, rename, delete, search | local web | N |
| 11 | Long transcript: virtualization, prepend anchors, find, file link → file tab | local web | B |
| 12 | Workbench and shell: split, tabs, drag, command palette. Marketplace, Tasks and Settings open in the one page tab, which can't be split or dragged. Settings switches the sidebar to settings mode | local web | N |
| 13 | Terminal: run a command, reload → replay, TUI exit leaves no mouse garbage, multi-line link opens the file at the line, agent status in the terminal | desktop | B |
| 14 | Review: diff, line comment → agent, commit, push to a local bare remote, worktree | local web | B |
| 15 | Settings: accounts per agent, machine logins, theme, keybindings | local web | B |
| 16 | Usage: per-turn usage and quota windows | local web | B |
| 17 | Marketplace: install an agent plugin from a local source, enable it, its skills and MCP tools reach the agent | local web | B |
| 18 | Tasks plugin: create, board, preset, Start → session | local web + signed | B |
| 19 | Pages plugin: create, edit rich and source, history, `@page` | local web + signed | B |
| 20 | Plugins on and off: turning a plugin off removes its slots; a plugin that throws shows its error in its slot only | local web | N |
| 21 | Sign-in on a machine that was used unsigned; its sessions stay | desktop + Worker | B |
| 22 | Remote access: publish, web lists the machine's sessions, open, send over the relay, pause | desktop + Worker + relay | B |
| 23 | Team: a member follows a shared session, send permission, revoke | Worker + relay, two browsers | B |
| 24 | Cloud workspace (local driver): create, start, turn, stop, delete, failure shown | Worker + local driver | B |
| 25 | Desktop: quit during a turn and reopen, deep link, update check | desktop | B |
| 26 | Language switch, accessibility sweep (axe) of the main screens | local web | B |
| 27 | Browser tab: preview a local URL, navigate, console, pick an element → attached to the prompt | desktop | B |
| 28 | Compact tabs plugin: keyboard switcher lists tabs with status, switch, close | local web | B |
| 29 | Codex theme plugin: tokens and icon skin apply; turning it off restores the v2 defaults | local web | B |
| 30 | Transcript corpus: every case renders the same in both apps (screenshots, accessibility tree, scroll position after scroll, prepend, find and reload) | local web, own shard | B |
| 31 | Session-list races: the cases in [Session sidebar](#2-session-sidebar-one-owner-written-reconcile-rules); the visible list equals the server's list and statuses at the end | local web, two browsers | N |
| 32 | Add a project, hosted first: signed web → repo → AI → cloud workspace; the project id read back; a deep link by id | Worker + local driver | N |
| 33 | Phone: flows 3, 6, 8, 10, 15, 18 and 19 at 390×844 with touch; the drawer and sheets; no horizontal scroll; an axe sweep | local web, `phone` project | B |
| 34 | Live plugin on desktop: a scripted agent turn creates a plugin; the daemon builds it; its page appears without a reload; an edit swaps it; a broken edit keeps the old version and shows the error; switching it off removes it | desktop | N |
| 35 | Live plugin on the web: the same plugin renders in a sandboxed iframe, works through the bridge, and can't read the app's storage or DOM | local web | N |
| 36 | Access: the Organization page and org settings open only to owners and admins; a follow share reads, a send share prompts, revoking ends both | Worker + relay, two browsers | N |

**Budget:** ≤ 16k lines for the suite and harness together; the corpus data is JSON and not counted. Transcript screenshots from today's app must match v2; other screens get new baselines on v2.

## Performance gate

**Baseline.** agent-app-benchmark, `compare --preset claxedo-vs-t3-fast` plus the full suite (size sweep, long rows, workspace panel, memory, CPU). It runs against a packaged build of today's app and a packaged v2 build, on the same host, in the same run. For reference, the 2026-09-23 medians and the 2026-09-02 p95s:

| Row | Today |
| --- | --- |
| App start, fresh profile / existing profile (median) | 1.24 s / 1.22 s |
| Switch to an unvisited session, same / other workspace (median) | 41.3 ms / 41.3 ms |
| Return to a visited session, same / other workspace (median) | 16.8 ms / 16.3 ms |
| Memory idle after launch / after the switching workload | 801 MiB / 823 MiB |
| CPU while idle | 8.6% (T3: 4.4%) |
| Long rows: 8 MiB in 8 rows / 32 MiB in 32 rows (p95) | 3.5 s / 2.8 s |
| Workspace panel open, moderate return | 1,032 ms (a 900 ms hydration delay) |
| Retained memory growth after the workload | 47 MiB |

**The rule.** Run the framework's `verdict` (exact Mann-Whitney, bootstrap CI, 5% margin):

- **No row may go to today's app.**
- **These rows must go to v2:** CPU while idle (target ≤ 4.4%, below T3); long rows (target ≤ 2.4 s for 8 MiB in 8 rows); workspace-panel open return (target ≤ 250 ms); memory idle after launch (target ≤ 700 MiB); app start (target ≤ 1.1 s).

**Long rows and the kept transcript.** The long-row target has to be met without changing the transcript's logic. Where the time goes is measured first. If the renderers themselves are the cost, the change is its own slice, proven by the corpus and signed off by you.

**The driver moves first.** `perf-harness/src/public-*.ts` (3.3k lines) moves to the agent-app-benchmark repo as `drivers/claxedo/`. Its one import from app source (`review-loaded-diff-identity`) is replaced, so it drives an app only through CDP and DOM hooks.

The driver carries two hook maps with the same readiness meaning:
- **today's hooks,** unchanged, so today's app is not touched;
- **v2's hooks,** in Claxedo names: test ids `session-page-root`, `workspace-panel-shell`, `workspace-panel-toggle`, `workspace-files-navigator`, `review-pane-root`, `review-pane-loading`, `workspace-review-pending`, `tab-file-root`, `workspace-tab-close`; attributes `data-session-id`, `data-workspace-id`, `data-ready`, `data-warm`, `data-mode`, `data-workspace-tab-kind`, `data-file-tree-path`, `data-file-tree-row`, `data-file-tree-loading`, `data-review-file`, `data-review-total-files`, `data-review-diff-style`, `data-open`, `data-line`, `data-scrollable`, `data-workspace-panel-session-id`.

The e2e selectors use the same v2 hook list.

**The warm-boot transcript cache** stays or goes by measurement. It stays if the snapshot path can't beat today's app-start row without it.

## Testing it yourself

| What | How (added in P0) |
| --- | --- |
| v2 on the web | `bun run --cwd packages/claxedo-app-v2 dev` (its own port); same local daemon as today's app |
| v2 at phone width | your browser's device mode at 390×844, or the flows' `phone` project: `bun run --cwd packages/claxedo-app-v2 e2e -- --app=v2 --project=phone` |
| v2 in the desktop | `bun run --cwd packages/claxedo-desktop dev:v2`, a dev build whose renderer loads `@claxedo/app-v2` |
| v2 packaged | `bun run --cwd packages/claxedo-desktop package:mac:v2` → "Claxedo V2 Dev.app", beside today's "Claxedo Dev.app" |
| Today's app | Unchanged: `dev`, `package:mac` |
| The flows | `bun run --cwd packages/claxedo-app-v2 e2e -- --app=v2` (or `--app=v1` for the baseline flows) |

Both apps talk to the same server with the same contracts, and share your local data.

## Phases

Each phase ends green on the e2e flows that exist so far, on the five e2e criteria and on the checks. Every slice deletes what it replaces inside `claxedo-app-v2` in the same slice. Every screen a phase builds ships with its phone layout, and flow 33 grows with it.

### P0 — Set up v2, baselines, harness and checks

- [ ] **P0.1 The copy.**
  - `packages/claxedo-app` is copied to `packages/claxedo-app-v2`, without `perf-harness/`, unit tests, Storybook files or the app's scanners.
  - The copied source moves to `src/legacy/`, excluded from the build. The new app grows from a new entry, `src/main.tsx`. Each lane `git mv`s what it keeps out of `src/legacy/`, and `src/legacy/` is deleted before the swap. The baseline flows run against today's app, `packages/claxedo-app`.
  - Its package is renamed `@claxedo/app-v2`, with its own dev port (4445).
  - The desktop gets `dev:v2` and `package:mac:v2` targets, and CI gets a v2 job.
  - `AGENTS.md` (Appendix A) replaces the copied package-root one, and `CLAUDE.md` (`@AGENTS.md`) is added. The other 7 copied `AGENTS.md` files are removed.
  - `Progress:` done in `0158b533ec` (base) and `f49df7872a` (the shared contracts).
- [ ] **P0.2 Benchmark driver out of the app.** The driver lives in the benchmark repo with the two hook maps. Baseline runs of today's packaged app are recorded (3 runs, gate host). `Progress:`
- [ ] **P0.3 e2e harness** in `claxedo-app-v2/e2e`: scripted ACP agent, scripted model server wired to the real Claude and Codex CLIs, `wrangler dev` Worker and relay, local sandbox driver, desktop launcher, the `phone` project, `--app=v1|v2`. The harness start time and one warm flow are measured against the "fast" targets. `Progress:`
- [ ] **P0.4 v1 measured.** v1's coverage map (all 58 specs), durations, and flake rate over its last 20 CI runs are recorded. v2 must beat all of them. `Progress:`
- [ ] **P0.5 Baseline flows.** Every **B** flow passes on today's app, with its recorded red run; 20 local runs green each. Transcript screenshots are recorded. `Progress:`
- [ ] **P0.6 Checks.** The fourteen checks run over `claxedo-app-v2` and `plugins/`. The per-part line budget ratchet starts at the copy's size and can only go down. `Progress:`
- [ ] **P0.7 Harness status on today's stream.** On the real stack, scripted Claude and ACP turns run while a probe records which `session.status`, `session.idle`, `session.error`, `permission.asked` and `question.asked` frames arrive on the stream the app reads. The result decides whether `status.ts` needs its re-read ([Where today's contract falls short](#where-todays-contract-falls-short)). `Progress:`
- [ ] **P0.8 Transcript corpus.**
  - The corpus is built from the seeds.
  - The 95 fix commits are mapped to cases.
  - The 1,834 comment lines are triaged into cases, README lines or deletions.
  - Today's screenshots, accessibility trees and scroll positions are recorded.
  - Flow 30 is green on today's app.
  - `Progress:`
- [ ] **P0.9 Session list.** The reconcile rules are written into `src/session/list/README.md`. Flow 31 is written and run on today's app, and its results are recorded. `Progress:`
- [ ] **P0.10 Projects.** The projects route's contract is fixed from the mapped facts ([The projects route](#the-projects-route)), and flows 2 and 32 are written against it. That includes a signed web user adding a project for a connected machine through the relay. `Progress:`

### P1 — The server adapter, the v2 kit and the transcript move (in parallel)

- [ ] **Adapter.**
  - `src/server/` holds every route, payload and event name the app uses, `projects.ts` included.
  - Streams resume by `Last-Event-ID` and re-read after a `stream.replay-gap`.
  - The rest of v2 imports only its Claxedo-typed surface.
  - The wire code scattered through `platform/*` and `features/*` is deleted.
  - `Progress:`
- [ ] **Projects route.**
  - One route module and a `ProjectStore` port in server-core, with the local adapter and the D1 adapter plus its migration.
  - It is mounted by the local server, the self-hosted app and the hosted worker.
  - `projects.ts` in the adapter uses only this route.
  - `Progress:`
- [ ] **Status.** `status.ts` reads status from the snapshot and the stream. It keeps the one 5-second re-read only if P0.7 found harness status changes that never arrive. `Progress:`
- [ ] **Kit.** `src/ui/` with v2 components and tokens only, Claxedo names, no comments, each component checked at phone width. The no-twin components are restyled into v2, and upstream's four missing v2 components are vendored. `Progress:`
- [ ] **Transcript.**
  - `src/transcript/` holds the renderers and diff view, moved by the transcript rules.
  - Data tables are JSON assets.
  - v2 no longer imports `@opencode-ai/*`, `packages/ui` or `packages/session-ui`.
  - Flow 30 is green on v2, with no visible difference you haven't signed off.
  - `Progress:`

### P2 — Session client, session list and session screen

- [ ] **The session store.** One store per session replaces `features/session/{store,data,harness,providers,conversation,submit}` and the old `platform/{runtime,sync,query}`. It is fed by a snapshot plus today's streams through the adapter, and it holds the `SessionRef`, the capabilities and the machines. `Progress:`
- [ ] **The session list store.** `src/session/list/` implements the written reconcile rules in one `transition`. Flow 31 is green on 20 runs in a row. `Progress:`
- [ ] **The timeline.** The moved timeline reads the new store, which hands it today's shapes. Flows 3, 4, 5, 8, 9, 11 and 30 pass. `Progress:`
- [ ] **The composer** is on `PromptInputV2` with Claxedo's slots. Flows 6 and 7 pass; `composer/v2` and the prepared-session scaffolding are deleted. `Progress:`
- [ ] **Benchmark.** The switch rows and long rows are measured: no regression. `Progress:`

### P3 — Rail, workbench, browser tabs, terminal, review

- [ ] Flat rail over the session list store, with live status from the adapter's one status owner, and the phone drawer. Flows 10 and 31 pass. `Progress:`
- [ ] **The shell:**
  - three regions and one page tab over typed registries;
  - one workbench state owner;
  - the phone drawer, sheet and pane switcher.
  - The layout twins are deleted, and flow 12 passes.
  - `Progress:`
- [ ] Browser tabs on v2 over today's desktop bridge and web preview; flow 27 passes. `Progress:`
- [ ] Terminal on one attach path, links kept; the client replay twin is deleted; flow 13 passes. `Progress:`
- [ ] Review, git and files on one file store; flow 14 passes; the panel-open row is measured (target ≤ 250 ms). `Progress:`

### P4 — Shell, projects, settings, onboarding, cloud, machines, Marketplace

- [ ] One entry, capabilities through one reader; no posture file or build flag left; feature ports are deleted. `Progress:`
- [ ] **Projects** keyed by id, with the hosted-first add flow and placements. No folder path is used as an identity. Flows 2 and 32 pass. `Progress:`
- [ ] Settings on v2 with one Accounts screen and one Machines screen; flows 15, 21 and 22 pass. `Progress:`
- [ ] Cloud workspaces; flow 24 passes. `Progress:`
- [ ] Onboarding (on the new project flow) and usage; flows 1 and 16 pass. `Progress:`
- [ ] Team flows; flow 23 passes. `Progress:`
- [ ] **Access.**
  - `src/access/` with one `can()` that answers from server facts, and the Organization page.
  - `RolePolicy` is deleted.
  - Flow 36 passes.
  - `Progress:`
- [ ] Marketplace for agent plugins; flow 17 passes. `Progress:`

### P5 — Plugin host, the four plugins and live plugins

- [ ] The plugin host with the primitives in [How plugins work](#how-plugins-work-now), error boundaries, and on/off in Settings; flow 20 passes. `Progress:`
- [ ] Tasks (flow 18) and Pages (flow 19). `Progress:`
- [ ] Compact tabs (flow 28) and the Codex theme (flow 29). `Progress:`
- [ ] **Live plugins.**
  - The daemon registers, builds, serves and watches plugins, and sends `plugins.changed`.
  - The host loads plugins and swaps them live: in the app's JavaScript on desktop, and through the iframe bridge on the web.
  - The CLI's `plugin` commands and the authoring skill are in place.
  - Flows 34 and 35 pass.
  - `Progress:`

### P6 — Your test and the swap

- [ ] **Ready for you:**
  - all 36 flows green on v2, flow 33 on every screen;
  - the five e2e criteria met, including the coverage map against v1;
  - every check at zero;
  - the v2 line budget ≤ 94k;
  - the benchmark verdict passes (packaged today vs packaged v2, three runs).
  - `Progress:`
- [ ] **You test** v2 on web, phone width, desktop dev and the packaged build, and approve. `Progress:`
- [ ] **The swap, one change:**
  - delete `packages/claxedo-app`, `packages/ui`, `packages/session-ui` and `packages/storybook`;
  - rename `packages/claxedo-app-v2` → `packages/claxedo-app` and `@claxedo/app-v2` → `@claxedo/app`;
  - delete every server path only the old app used, including the project paths listed in [The projects route](#the-projects-route);
  - remove the desktop v2 targets, the v2 CI job and the perf-harness workflow steps;
  - point the desktop's two remaining kit imports at the app.
  - `Progress:`
- [ ] **After the swap:** all 36 flows, the five e2e criteria, every check and the benchmark pass again on the renamed app. `Progress:`

## Execution: the 6-hour push

The aim is P0–P5 in one 6-hour push with parallel agents, then your test and the swap.

**As run (2026-09-24, from 03:25):** the integration branch is `feat/app-v2` in `~/test/opencode-app-v2`. Each lane has its own worktree, `~/test/opencode-app-v2-lanes/<lane>`, on branch `v2/<lane>`. There are 15 lanes: harness, bench, checks, kit, transcript, server-projects, live-plugins, adapter, session-data, session-screen, shell, tools, projects-app, settings-access and plugins. Strings live per domain (`src/<domain>/i18n.ts`), merged by the shell's i18n provider, so lanes never share a locale file.

**How it stays parallel:**
- **A dedicated worktree.** `~/test/opencode-app-v2` on `feat/app-v2` off `dev`, with its own install, because other sessions sweep the main worktree's index with `git add -A`.
- **Contracts first.** In the first 45 minutes the orchestrator makes the copy (P0.1) and freezes the types every lane builds against:
  - `src/server/index.ts`: sessions, status, projects, placements, capabilities, errors;
  - the session, session-list and project store APIs;
  - the shell's regions and registry entry types;
  - the plugin API;
  - `machine()`.
  - A change to any of them goes through the orchestrator.
- **Disjoint files.** Each lane owns its files. The shared ones belong to the orchestrator: `src/shell/registry.ts`, the router and `package.json`.

| Lane | Owns | Delivers |
| --- | --- | --- |
| **Harness** | `e2e/**`, apart from the corpus | P0.3–P0.5, P0.7, P0.9; flows as the other lanes land |
| **Bench** | the benchmark repo's `drivers/claxedo/` | P0.2; one packaged benchmark run at the end |
| **Checks** | `packages/claxedo-app-v2/scripts/checks/` and the v2 budget baseline | P0.6 |
| **Transcript** | `src/transcript/**`, `src/session/view/timeline/**`, `e2e/corpus/**` | P0.8; the transcript move; flow 30 |
| **Adapter** | `src/server/**` | P0.10; the adapter and status |
| **Server** | the projects route in server-core, its D1 migration and its three mounts | the projects route; the old-path deletions at the swap |
| **Kit** | `src/ui/**` | the v2 kit |
| **Session data** | the session and session-list stores in `src/session/` | P2 stores; flow 31 |
| **Session screen** | the rest of `src/session/view/**`, and `src/composer/**` | P2 screen and composer |
| **Shell** | `src/{shell,rail,workbench}/**` | the shell frame, sidebar modes, page tab, panel frame and phone behavior; P3 rail and workbench |
| **Tools** | `src/{terminal,browser,review,files}/**` | P3 terminal, browser tabs, review and files |
| **Projects** | `src/{projects,cloud,onboarding}/**` | P4 projects, cloud and onboarding |
| **Settings** | `src/{settings,access,auth,machines,marketplace,usage}/**` | P4 settings, access, machines, Marketplace and usage |
| **Plugins** | `src/plugins/**`, `plugins/*`, the daemon's plugin routes, the CLI's `plugin` commands, the authoring skill | P5 host, the four plugins and live plugins |

**The schedule:**

| When | What |
| --- | --- |
| 0:00–0:45 | The worktree, the copy, the frozen contracts |
| 0:45–4:30 | All lanes in parallel, landing in slices. Each slice gets an adversarial review before it merges. |
| From 2:00 | Flows run as slices land, on as many local stacks as the machine holds. Web flows can also run on crabbox boxes. |
| 4:30–6:00 | Integration, the full suite, fix loops, one packaged benchmark run |

**What six hours can honestly reach:**
- **Likely:**
  - v2 running end to end on today's server;
  - every lane's first version merged;
  - most flows green once;
  - the corpus compared on its seeded cases;
  - one benchmark run.
- **Unlikely in the same six hours:**
  - 20 clean runs of every flow;
  - all 95 transcript fix commits mined into cases;
  - the idle-CPU and long-row targets, which may need profiling;
  - your sign-off and the swap.
  - Those need a second, shorter block.

**Cost and setup.** About 14 lanes plus reviewers running for about five hours is a large model spend.
- **Models:** lanes run on Fable, falling back to Opus when Fable is limited.
- **Workflow:** it runs as a workflow, which needs your go-ahead. The session's workflow size setting (medium, under 10 agents) must be raised in `/config`.

**Review.**
- A "done" row from an agent is a claim until the flows, the five criteria and the checks say so.
- The transcript, the session list and projects get a second reviewer.

**Fan-outs inside lanes:**
- one agent per flow, 36 in all, each with its red run;
- agents over the 95 transcript fix commits, about ten commits each, and over the transcript comments;
- one review agent per deleted-file group, checking that nothing in v2 still imports it.

## Open decisions

1. **Consolidating access on the server** ([Roles, permissions and orgs](#roles-permissions-and-orgs)).
   - One policy module in server-core that all ~28 sites ask, which removes the three places where the server disagrees with your rulings.
   - **Recommendation:** run it as its own slice right after this push, with its own flows and review.
2. **Harness status,** only if P0.7 finds changes that never reach the app. Either keep the one 5-second re-read in `status.ts` (no server change), or approve a small runtime fix that sends today's `session.status` event where it is missing.
3. **Teams inside an org.**
   - **What it is.** Named groups of members inside an org. In Settings you can create teams, add and remove members, and pick an active team. `grantTeamProject` gives a team access to a project, and a session can be shared with a whole team. The rail has an org/team switcher, but in the app only that switcher and the settings page read the chosen team; nothing else is scoped by it.
   - **Recommendation: drop it from the v2 screens.** The org is the team, and sharing can target a person or the whole org. The server side is not touched in this slice.
4. **Network-policy settings:** ~0.25k to keep.
5. **Custom-provider dialog:** ~0.3k to keep.
6. **Release-notes video dialog:** ~0.12k to keep.
7. **Five optional session-screen simplifications** (environment card → terminal pane, file dialog → palette, context tab, one dock, one picker): −1.8k if taken. The transcript is not touched.

## Risks

1. **The adapter is the critical path.** Every other lane builds on its Claxedo-typed surface, so it is built and frozen first.
2. **Transcript regressions.** Hundreds of fixes live in that code, many recorded only in comments. The code moves instead of being rewritten; every comment is triaged before it goes; the corpus runs on every change; and any visible difference needs your sign-off.
3. **Session-list races.** The rebuild replaces today's brittle data path. The reconcile rules are written before the code, and flow 31 is written and run on today's app before the new store exists.
4. **Project ids differ per deployment.** Ids are UUIDs locally and `prj_…` on hosted. The app treats both as opaque and always knows which server it is talking to, and the projects route gives both the same contract.
5. **Today's contract shapes some app behavior.** The adapter carries OpenCode's shapes until the server is rebuilt, and harness status may need the app's one bounded re-read (P0.7 decides).
6. **Phone layouts drift.** Each phase ships its screens with phone layouts, and flow 33 grows with them, so there is no end-of-project mobile pass.
7. **e2e only means slower feedback.** A single flow must run in 60 seconds or less locally, or agents will stop running it; "fast" is a gate, not a hope.
8. **Performance targets.** Idle CPU and long rows are today's weak rows. They are measured at the end of P2 and P3, well before the swap. The long-row target has to be met with the transcript's logic unchanged.

## Definition of done

- [ ] `packages/claxedo-app` (the renamed v2) ≤ 94k production lines, with per-part budgets enforced by the ratchet; first-party plugins ≤ 7k in `plugins/`.
- [ ] **Server changes are only the approved ones:** the projects route, the live-plugin routes, and a harness-status fix if you approved one. The swap deletes every server path only the old app used.
- [ ] **Transcript:**
  - moved, not rebuilt;
  - flow 30 green, with no visible difference you haven't signed off;
  - every fix commit mapped to a case;
  - every transcript comment triaged.
- [ ] **Session sidebar:** one owner; the reconcile rules written in its README; flow 31 green on 20 runs in a row.
- [ ] **Projects:** every project an id; no folder path used as an identity outside `src/server/`; flows 2 and 32 green.
- [ ] **Phone:** every screen has a phone layout; flow 33 green; no horizontal scroll at 390 px.
- [ ] **Shell:** three regions and one page tab; pages can't be split or dragged; flow 12 green.
- [ ] **Access:** one `src/access/` domain; `can()` answers only from server facts; flow 36 green.
- [ ] **Live plugins:** a prompted plugin reaches the running app, on desktop directly and on the web in a sandboxed iframe; flows 34 and 35 green.
- [ ] No v1 component, token or class; no import from the old kit packages, which are deleted.
- [ ] Zero comments in the app and plugins; every check at zero.
- [ ] No retired OpenCode name outside `src/server/wire/`.
- [ ] Every machine in [State machines](#state-machines) exists; no view guesses status.
- [ ] Zero unit tests; ≤ 16k lines of e2e; all 36 flows green on CI against the real stack.
- [ ] The five e2e criteria are met: robust (20 clean CI runs), better than v1 (coverage map, zero mocked specs), works, honest (the four rules, a red run per spec), fast (≤ 60 s per flow, ≤ 12 min suite).
- [ ] Browser tabs and terminal links work in the app; the four first-party plugins work with their parity lists.
- [ ] The benchmark verdict passes: no row lost; idle CPU, long rows, panel open, idle memory and app start won.
- [ ] You tested v2 and approved; the swap is done; everything passes again on the renamed app.

## Appendix A: `packages/claxedo-app-v2/AGENTS.md`

This file is written into the copy in P0.1. A `CLAUDE.md` beside it contains `@AGENTS.md`. The repo root files are unchanged.

````markdown
# Claxedo app (v2)

This package is the rebuilt Claxedo app. These rules apply to everything in it and to `plugins/*`. The repo root `AGENTS.md` still applies; where the two differ, this file wins for this work.

## Today's server

The app runs on today's server contracts. `src/server/` is the only place that knows routes, payloads and event names, and `src/server/wire/` is the only place that uses the server's names. Everything else uses Claxedo types from `src/server/index.ts`. Do not change a server contract from this package's work.

## Areas that need extra care

- **Transcript** (`src/transcript/`, `src/session/view/timeline/`):
  - Hundreds of fixes live here. Change its logic only in a slice of its own, proven by the corpus (flow 30) and signed off by the owner.
  - Mechanical changes (imports, names by the codemod, a v2 twin that renders the same) still run the whole corpus.
  - A fix here adds a corpus case in the same change.
- **Session list** (`src/session/list/`):
  - One store owns rows, order and reconciliation. Nothing else fetches, caches or patches rows.
  - The reconcile rules are the first section of its `README.md`. A change to them changes the README and the race flows (flow 31) in the same change.
- **Projects:**
  - A project is a server record with an id. A folder, a worktree or a cloud workspace is a placement.
  - Never use a folder path as a key, a route parameter or a stored identity. Only `src/server/` turns a placement into a directory.
  - Design flows for hosted first.
- **Phone:**
  - Every screen and plugin slot has a phone layout at 390 px: the sidebar as a drawer, panes as sheets, no hover-only controls, touch targets of at least 44 px, no horizontal scroll.
  - A new screen extends flow 33 in the same change.

## Access

- Every access question in the UI goes through `can()` in `src/access/`, which answers only from facts the server reports. Never re-derive a server rule in the app.
- "Permission" in code means an agent request, and lives in `src/session/requests/`. Access code never uses the word.

## Plugins

- First-party and user plugins get the same API. Add a primitive only when a plugin needs it, and add it to the plan's primitive table in the same change.
- User plugins run in the app's JavaScript on desktop, and in a sandboxed iframe on the web. Never give that iframe same-origin.

## No comments

Code carries no comments: no line comments, block comments, JSDoc, file headers, section banners or commented-out code.
- Names, types and small functions say what the code does.
- The domain's `README.md` says why: owned concepts, state machines, invariants, constraints.
- The end-to-end flows and the transcript corpus say how it behaves.

Directives a tool reads are not comments and stay, with no prose added: `// @ts-expect-error`, `// oxlint-disable-next-line <rule>`, `/* @vite-ignore */`, `/*#__PURE__*/`, `/// <reference …>`, shebangs, and generated-file markers.

## Files and folders

- One responsibility per file, and its name says what it owns. No `utils`, `helpers`, `common` or `misc` files or folders.
- A file stays under 300 lines, a function under 40 and a component under 120. Past that, split along responsibilities; never compress lines to fit. The moved transcript files are split only in their own corpus-proven slice.
- Organize by domain, not by layer. A domain lives in `src/<domain>/` and has:
  - `model.ts`: types, events and state machines;
  - `store.ts`: state and actions;
  - `api.ts`: calls into `src/server/`;
  - `view/`: components;
  - `index.ts`: the domain's public surface;
  - `README.md`: owned concepts, machines, flows.
  - Folders go at most three levels deep.
- Import another domain only through its `index.ts`. Shared code lives in `src/lib/<concept>.ts` only when two or more domains use it; otherwise it lives with its one user.

## Names

- Use Claxedo names only, outside `src/server/wire/`:
  - `sessionId`, not `sessionID` (same for message, part, provider, model, call and project ids);
  - `@claxedo/*`, never `@opencode-ai/*`;
  - no `oc-` prefixes, no `globalSDK` or `globalSync`, no OpenCode event names, no `directory` routing.
- Name the domain concept, not the mechanism: `SessionRow`, `TurnStatus`, `startTurn`.
- Events are past tense (`turnFinished`); commands are imperative (`startTurn`).
- No abbreviations except `id`, `url` and `api`.

## State and state machines

- **Any state with more than two values is an explicit machine:**
  - a discriminated union of states (`{ kind: "loading" } | { kind: "ready"; data } | { kind: "failed"; error }`);
  - a union of events;
  - one pure `transition(state, event)` with an exhaustive switch, built with `machine()` from `src/lib/machine.ts`.
  - Effects run outside the transition. No parallel booleans (`isLoading`, `isError`, `hasData`) describing one thing.
- **Make illegal states unrepresentable.** A field that exists in only one state lives only in that state's variant.
- **Server-owned lifecycles** (session, turn, request, cloud workspace, remote access) are fed only by the adapter's mapping of server data and events. Views never guess status from timing or message contents.
- **Every datum has one home:**
  - **Data the server pushes** (sessions, status, transcript, requests, todos) lives in one Solid store per domain, fed by the snapshot and the stream through the adapter. Deltas are coalesced per frame and applied in place.
  - **Data the app fetches** (projects, machines, accounts, tasks, files, git, Marketplace, usage) lives in the TanStack Query cache, through the query options in `src/server/<area>.ts`. Events only invalidate it, through the adapter's event table. `setQueryData` is only for a mutation's own result, inside `src/server/`.
  - **Not allowed:**
    - a second copy of any datum;
    - Promises, counters or UI state in the query cache;
    - module-level mutable state;
    - an effect that copies one store into another (derive with memos instead).
- **UI state that belongs to one component stays in that component.** Persisted UI preferences go through `persisted()`, keyed by user and `SessionRef`.

## Errors

- **Errors are typed values.** Every failure has:
  - a class (`auth`, `rate_limit`, `network`, `not_found`, `conflict`, `invalid`, `internal`) from `src/server/errors.ts`, the one place that reads server responses;
  - a `retryable` flag;
  - a cause.
  - Never match on message text anywhere else.
- **A failure becomes a machine state and is shown, or logged with context.** Not allowed:
  - `.catch(() => default)`;
  - an empty `catch`;
  - a silent fallback;
  - a retry loop, apart from the stream's bounded, visible reconnect.
- **User-facing error copy comes from one table**, class → message, in i18n.
- **Every pane and every plugin slot has an error boundary.**

## Loading states

- Every async view renders from its machine: idle, loading, ready or failed, each drawn explicitly. No spinner without a failure path.
- Show a placeholder only after 150 ms, so fast loads don't flash. A secondary load never blocks the shell or the transcript.
- Optimistic changes are pending entries in the store, confirmed or rolled back by the server; never a second copy of the data.

## Performance

- **Budgets are part of done:**
  - session switch p95 ≤ 50 ms cold and ≤ 20 ms warm;
  - app start ≤ 1.1 s;
  - idle CPU ≤ 4%;
  - idle memory ≤ 700 MiB;
  - an 8 MiB long-row session ready in ≤ 2.4 s.
  - The agent-app-benchmark verdict against today's app must lose no row.
- **No polling.** Timers only for bounded backoff and debouncing, each owned by one named module.
- **Lists longer than 100 rows are virtualized.**
- **No main-thread task over 50 ms during an interaction.**
- **Every cache has a size cap, and every subscription is disposed with its owner.**

## End-to-end tests

The suite must be robust, better than v1, working, honest and fast.

- **Real stack only.** The real app against the real daemon, runtime, relay and Worker. Fakes only at external boundaries:
  - the scripted model endpoint;
  - a scripted ACP agent;
  - a local sandbox driver;
  - a scripted OAuth provider.
  - No test-only paths in production code.
- **One spec per user flow**, named `NN-flow-name.spec.ts`.
  - Arrange through the API, act through the UI.
  - Assert what the user sees and one fact read back from the server.
  - Select by role and accessible name, then by the frozen hook list.
  - No CSS-class selectors and no sleeps; wait on a visible state.
- **Every spec is proven able to fail:** record its red run (a scripted failure, or the feature switched off). When asserting an absence or a filter, check every route that answers the same question.
- **Before a spec merges,** it passes 20 runs in a row locally and 3 repeated runs in CI. A flaky spec is a bug: find the cause before retrying.
- **Fast:** one flow in 60 seconds or less locally on a warm harness; the full suite in 12 minutes or less on CI.
- **A change to user-visible behavior adds or updates its flow in the same change**, at desktop width and in the `phone` project.

## One owner per concept

- Before writing code, find the concept's owner (the domain `README.md` owner lists first, then the code) and extend it. Two implementations of one concept are a defect even when both work.
- A domain `README.md` lists the concepts it owns, its state machines and its flows. Adding a concept adds it there.
- Before starting a task, check the plan's progress notes and open branches for the same work. Claim the task in the plan, and edit only the files your lane owns.

## Checks

`bun run check` in this package runs:
- no comments;
- size;
- v2 only;
- Claxedo names;
- adapter boundary;
- no swallowed errors;
- no polling;
- one home per datum;
- domain boundaries;
- one owner;
- no directory identity;
- access boundary;
- protected areas;
- e2e hygiene.

All must be at zero before a change is done.
````
