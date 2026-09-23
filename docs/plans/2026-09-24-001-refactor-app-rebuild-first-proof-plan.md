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
- the first-party plugin packages under `plugins/`.

No server code changes, except two that you may choose to approve ([Where today's contract falls short](#where-todays-contract-falls-short)):
- a harness-status fix, only if P0.7 shows it is needed;
- a hosted projects route.

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

## The goal

Rebuild the app so it is simpler, easier to reason about and easier for AI agents to maintain on their own. The rebuilt app must meet these constraints:

1. **Only v2.** One UI kit, v2 components and tokens, living inside the app. No v1 component or token is left.
2. **Today's server contracts.** No server route, event name or payload changes, apart from the two you may approve.
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
| App + UI kits | 261.0k (app 208.7k; `ui`, `session-ui`, Storybook 52.3k) | **≤ 93k**, all in `packages/claxedo-app` |
| First-party plugins, in `plugins/` | inside the app and the UI kit | ≤ 7k |
| Unit tests, app + kits | 169.8k | **0** |
| e2e specs and helpers | 56.8k (32 of 58 specs run against a mocked server) | **≤ 16k**, none mocked; corpus data not counted |
| Comments in the new code | — | **0** |

Lines are tracked `.ts/.tsx/.js/.mjs` files, with locales not counted. While the work is in progress, the repo carries both apps; the swap removes the old one.

**The extra care costs about 3k lines:**
- the timeline keeps all its logic (+1.3k);
- phone layouts (+1.0k);
- the id-first project flow (+0.5k).

## Rulings this plan implements

- **Side by side:** copy → `claxedo-app-v2` → you test → delete `claxedo-app` → rename v2 back to `claxedo-app`.
- **Server:** today's contracts. The app adapts; the server does not change.
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
- **Comments:** none in the new work.
- **Naming:** Claxedo names inside the app.
- **Performance:** must beat today's agent-app-benchmark results.
- **From earlier rulings:**
  - flat session list ordered by `human_turn_desc`;
  - one identity per machine that sign-in adopts;
  - per-user account selection;
  - no backward-compatibility bridges;
  - Cloudflare-only hosting and Node-only tooling;
  - the perf harness moves out of main.

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
- **Hosted has no projects route.** A hosted project comes into being with its first cloud workspace (`createCloudBody` takes `projectName` and a repo). The onboarding v2 plan's live probe on 2026-09-15 found the web Project chip posting to that missing route.

**Rules:**
- **A project is a server record with an id.**
  - A folder, a worktree or a cloud workspace is a placement of a project, and a session belongs to one placement.
  - `SessionRef` = project id + placement id + session id.
  - A directory is never an identity. Only the adapter turns a placement into today's `directory=`.
- **The project list comes from the server**, never from browser storage.
- **The add flow is designed for hosted first:** name and source (a repo from a connected GitHub account, or a URL; a folder only when running on a machine) → the AI → where it runs (a cloud workspace or a connected machine).
  - **On hosted,** today's contract creates the project together with its first cloud workspace, so the flow commits at the end.
  - **Locally,** the project record comes first, as today, then its placement.
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
| Workbench | Panes, tabs, splits, drag; command palette |
| Browser tabs | On desktop: preview a URL, navigate, console, pick an element and comment on it into the prompt. On the web: the sandboxed preview, as today |
| Terminal | Terminal panes; file-path, URL, multi-line and fallback-format links; agent status in terminals |
| Review | Diff, line comments sent to the agent, commit, push, worktrees, file tree, file tabs |
| Settings | Accounts per agent, machine logins, machines and remote access, org and members, sandbox providers, GitHub and MCP connections, the Marketplace (agent plugins), appearance (v2 themes), keybindings, terminals |
| Team | Session sharing (follow or send) |
| Cloud | Cloud workspaces: create, start, stop, delete |
| Usage | Per-turn usage and quota windows |
| Phone | Every screen at phone width: the sidebar as a drawer, panes as sheets |
| As plugins | Tasks; Pages; compact tabs; the Codex theme and icon skin |
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

**Open, your call** (see [Open decisions](#open-decisions)):
- a hosted projects route;
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
| v2 kit components from `packages/ui/src/v2` | ~1.3k used, ~2.8k available | `src/ui/` | The one kit |
| Locales, 18 languages | not counted | `src/i18n/` | Keys for deleted features are removed |

### Moves to first-party plugins

| Plugin | Built from | Talks to | Budget |
| --- | --- | --- | --- |
| Tasks | the UI of `features/tasks/*` (4.6k) | today's Tasks API, `/api/claxedo/tasks` on the Claxedo server the app is connected to, unchanged | ≤ 2.5k |
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
| The 35 `AGENTS.md` files copied from the old app | — | Each domain's `README.md` replaces its one |
| **Whole-file deletions, total** | **~88k** (plus ~11k moving into plugins) | |

### Rebuilt (the concept stays, the file shrinks; estimated)

| Module | Today | After | What makes it smaller |
| --- | --- | --- | --- |
| Server adapter, new home of today's `platform/{api,runtime,sync,query,account,remote-access}` wire code | ~16k spread across the app | ~4.0k in `src/server/` | One transport; one wire module converting today's shapes into app types; one error table; one status owner |
| Session client, including the session list store | 31.1k | ~9.5k | One store per session and one list store with written reconcile rules; snapshot plus today's streams; `SessionRef`; pickers from one capabilities reader |
| Session screen, apart from the kept timeline and docks | ~13.8k | ~8.1k | v2; its own status and placement guessing goes |
| Composer | 12.0k | ~5.5k | `PromptInputV2` frame with Claxedo's slots; the 592-line `handleSubmit` closure → a ~150-line send |
| Rail and workbench | 21.8k | ~8.5k | One flat list over the list store; three groupers → one; route sync over `SessionRef`; one state owner; phone drawer and sheets |
| Browser tabs, `features/browser/*` | 1.4k | ~1.1k | v2 screens; one machine for loading and element picking; the 954-line `browser-pane.tsx` split into address bar, page host, console and picker. The desktop's `window.api.browser` bridge and `<webview>`, and the web's sandboxed preview, are unchanged. |
| Shell and platform | 26.2k | ~6.5k | One entry, capabilities instead of 11 build flags; the wire moves to the adapter |
| Terminal | 8.2k | ~4.3k | One attach path; links kept |
| Settings (with accounts, machines and remote access) | 12.3k | ~5.7k | One Accounts screen; one Machines screen; remote access still goes through today's desktop path |
| Review, git, files | 8.6k | ~4.3k | Four file caches → one store |
| Projects and cloud workspaces | 5.7k | ~3.0k | One project model keyed by id; the hosted-first add flow; placements; today's lifecycle routes through the adapter |
| Onboarding and usage | 3.4k | ~1.8k | Through the adapter |
| Marketplace (agent plugins, as today) | 3.8k | ~1.8k | v2 screens over today's routes |
| UI kit (v2), `src/ui/`, including the no-twin components restyled (list, scroll view, popover, card, collapsible, dock surface, resize handle, file and provider icons, image preview) | ~12k | ~6k | One token source, one icon library, no v1 |

### New in the app

| What | Lines (estimated) |
| --- | --- |
| Plugin host: the slots and primitives the four plugins use, loader, error boundaries | 0.9k |
| `machine()` helper for state machines | 0.1k |
| Four v2 components vendored from upstream (progress circle, split button, tab state indicator, wordmark) | 0.2k |

### Budget per part (enforced by a ratchet on `claxedo-app-v2`)

| Part | Budget |
| --- | --- |
| Server adapter | 4.0k |
| Session client, including the session list store | 9.5k |
| Session screen incl. the kept timeline and docks, with its phone layout | 14.6k |
| Composer | 5.5k |
| Rail and workbench | 8.5k |
| Browser tabs | 1.1k |
| Shell and platform | 6.5k |
| Terminal | 4.3k |
| Settings | 5.7k |
| Review, git, files | 4.3k |
| Projects and cloud | 3.0k |
| Onboarding and usage | 1.8k |
| Plugin host | 0.9k |
| Marketplace | 1.8k |
| Moved in from the session feature (rail rows, review clients) | 0.6k |
| State-machine helper | 0.1k |
| UI kit (`src/ui/`) and kept transcript renderers (`src/transcript/`) | ~20k |
| **Total** | **≤ 93k** (the parts add up to 92.2k) |

## The server adapter

`src/server/` is the only module that knows today's server: its routes, its OpenCode-shaped payloads and event names, and how to reach a daemon, the control plane or the relay. Every domain calls it with Claxedo types and gets Claxedo types back. Nothing outside it imports `src/server/wire/`.

| File | Owns |
| --- | --- |
| `transport.ts` | Authenticated requests to the daemon, the control plane and the relay; event streams resumed by `Last-Event-ID`, with bounded, visible reconnect |
| `errors.ts` | The one table from today's responses (status and body) to error classes (`auth`, `rate_limit`, `network`, `not_found`, `conflict`, `invalid`, `internal`) |
| `wire/` | Today's shapes (`sessionID`, `message.part.updated`, `prompt_async`, `?directory=`) and their conversion to app types, both ways |
| `sessions.ts` | List (the same route the product uses today), snapshot, subscribe, create, prompt, stop, answer permissions and questions |
| `status.ts` | Session status from the snapshot and the stream (`session.status`, `session.idle`, `session.error`, `permission.asked`, `question.asked`): one owner, where today it is spread across 8 files |
| `projects.ts` | Project records by id: `/api/claxedo/projects` locally and on self-hosted; on hosted, projects through their cloud workspaces' `projectId` |
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
  - `bridgeLifecycleEvent` in `workspace-runtime/src/routes/session.ts` forwards those, plus permission and question requests and errors, as `agent.lifecycle` events;
  - both existed before the poll was written.
- **How P0.7 settles it.** It runs scripted Claude and ACP turns on the real stack and records which of those frames arrive on the stream the app reads.
  - **If they all arrive:** `status.ts` keeps no timer.
  - **If some never arrive:** `status.ts` keeps one bounded 5-second re-read, in one place instead of eight files. You then decide whether a small runtime fix is worth it. It would keep the event name and shape, and only send the event where it is missing today.

**2. Hosted has no projects route.** A hosted project exists only once it has a cloud workspace. v2 works within that: the hosted add flow creates the project together with its first workspace. Two things need a hosted projects route, a server change:
- a hosted project that exists before its first workspace;
- a hosted project list that doesn't go through workspaces.

This is [open decision 1](#open-decisions).

**Pages needs no server change.** Today's documents API already works in both setups:
- **signed:** through control-plane operations;
- **unsigned:** through the daemon's `/documents` routes, git-backed in the project.

## How plugins work (now)

**Scope.** Only first-party plugins, bundled from `plugins/` and switched on or off in Settings. Third-party app plugins, plugin backends and plugin machine code come later, when a need appears.

A plugin is a package with a small manifest and an app entry: `activate(api)` registers what it contributes. The host gives it only what the four plugins use.

| Primitive | Used by |
| --- | --- |
| `slots.navPanel`: a rail item that opens a panel | Tasks, Pages |
| `slots.pane`: a workbench pane type with its own tab and restore state | Pages editor |
| `slots.settingsSection` | Tasks presets |
| `slots.overlay`: a keyboard-invoked overlay | Compact tabs |
| `commands.register`, with keybindings | all |
| `mentions.register`: items in the composer's `@` menu | Tasks, Pages |
| `workbench`: list tabs with status, activate, close, move | Compact tabs |
| `themes.register`, `icons.registerSkin` | Codex theme |
| `sessions`: create with a prompt and attachments, status, open | Tasks |
| `projects`: list, and the current project's id | Tasks, Pages |
| `server`: authenticated calls through the adapter, limited to what the manifest names. That is route prefixes on the Claxedo server (Tasks: `/api/claxedo/tasks`) and control-plane operations (Pages: `documents.*`, which the adapter sends to the control plane when signed and to the daemon's `/documents` routes when not, as today). | Tasks, Pages |
| `context`, `ui` (toast, confirm), `i18n.t` | all |

Each slot renders inside an error boundary, so a failing plugin can't take down the app. Each slot also has a phone layout.

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

## Retiring OpenCode naming

Inside the app, only Claxedo names. The server keeps its names in this slice, and `src/server/wire/` is the one folder that uses them.

| Debt | Today | In v2 |
| --- | --- | --- |
| Kit package names `@opencode-ai/ui`, `@opencode-ai/session-ui`, and the `@opencode-ai/app-shared` alias | 610 imports in 249 files | The app's own `src/ui/` and `src/transcript/`; the alias is deleted |
| OpenCode id casing: `sessionID`, `messageID`, `partID`, `providerID`, `modelID`, `callID`, `projectID` | ~2,300 uses | `sessionId` and the rest everywhere in the app; converted at the adapter. In the transcript, by the type-checked codemod. |
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
| Plugin | off, loading, on, failed(reason) | plugin host |
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
| One store | A query-library import; module-level mutable `let` in a domain |
| Domain boundaries | An import of another domain except through its `index.ts` |
| One owner | The same exported name defined in two domains; duplicated blocks over 25 lines |
| No directory identity | A folder path used as a key, a route parameter or a stored project identity outside `src/server/` |
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
| 12 | Workbench: split, tabs, drag, command palette | local web | B |
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
  - `packages/claxedo-app` is copied to `packages/claxedo-app-v2`, without `perf-harness/`, unit tests or Storybook files.
  - Its package is renamed `@claxedo/app-v2`, with its own dev port.
  - The desktop gets `dev:v2` and `package:mac:v2` targets, and CI gets a v2 job.
  - `AGENTS.md` (Appendix A) and `CLAUDE.md` (`@AGENTS.md`) are written into it; the 35 copied `AGENTS.md` files are removed.
  - v2 runs exactly like today's app.
  - `Progress:`
- [ ] **P0.2 Benchmark driver out of the app.** The driver lives in the benchmark repo with the two hook maps. Baseline runs of today's packaged app are recorded (3 runs, gate host). `Progress:`
- [ ] **P0.3 e2e harness** in `claxedo-app-v2/e2e`: scripted ACP agent, scripted model server wired to the real Claude and Codex CLIs, `wrangler dev` Worker and relay, local sandbox driver, desktop launcher, the `phone` project, `--app=v1|v2`. The harness start time and one warm flow are measured against the "fast" targets. `Progress:`
- [ ] **P0.4 v1 measured.** v1's coverage map (all 58 specs), durations, and flake rate over its last 20 CI runs are recorded. v2 must beat all of them. `Progress:`
- [ ] **P0.5 Baseline flows.** Every **B** flow passes on today's app, with its recorded red run; 20 local runs green each. Transcript screenshots are recorded. `Progress:`
- [ ] **P0.6 Checks.** The thirteen checks run over `claxedo-app-v2` and `plugins/`. The per-part line budget ratchet starts at the copy's size and can only go down. `Progress:`
- [ ] **P0.7 Harness status on today's stream.** On the real stack, scripted Claude and ACP turns run while a probe records which `session.status`, `session.idle`, `session.error`, `permission.asked` and `question.asked` frames arrive on the stream the app reads. The result decides whether `status.ts` needs its re-read ([Where today's contract falls short](#where-todays-contract-falls-short)). `Progress:`
- [ ] **P0.8 Transcript corpus.**
  - The corpus is built from the seeds.
  - The 95 fix commits are mapped to cases.
  - The 1,834 comment lines are triaged into cases, README lines or deletions.
  - Today's screenshots, accessibility trees and scroll positions are recorded.
  - Flow 30 is green on today's app.
  - `Progress:`
- [ ] **P0.9 Session list.** The reconcile rules are written into `src/session/list/README.md`. Flow 31 is written and run on today's app, and its results are recorded. `Progress:`
- [ ] **P0.10 Projects.** Today's project contract is mapped, locally and on hosted: create, list, rename, remove, and the id each one returns. That includes a signed web user adding a project for a connected machine through the relay. `Progress:`

### P1 — The server adapter, the v2 kit and the transcript move (in parallel)

- [ ] **Adapter.**
  - `src/server/` holds every route, payload and event name the app uses, `projects.ts` included.
  - Streams resume by `Last-Event-ID` and re-read after a `stream.replay-gap`.
  - The rest of v2 imports only its Claxedo-typed surface.
  - The wire code scattered through `platform/*` and `features/*` is deleted.
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
- [ ] One workbench state owner, with phone sheets; the layout twins are deleted; flow 12 passes. `Progress:`
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
- [ ] Marketplace for agent plugins; flow 17 passes. `Progress:`

### P5 — Plugin host and the four plugins

- [ ] The plugin host with the primitives in [How plugins work](#how-plugins-work-now), error boundaries, and on/off in Settings; flow 20 passes. `Progress:`
- [ ] Tasks (flow 18) and Pages (flow 19). `Progress:`
- [ ] Compact tabs (flow 28) and the Codex theme (flow 29). `Progress:`

### P6 — Your test and the swap

- [ ] **Ready for you:**
  - all 33 flows green on v2, flow 33 on every screen;
  - the five e2e criteria met, including the coverage map against v1;
  - every check at zero;
  - the v2 line budget ≤ 93k;
  - the benchmark verdict passes (packaged today vs packaged v2, three runs).
  - `Progress:`
- [ ] **You test** v2 on web, phone width, desktop dev and the packaged build, and approve. `Progress:`
- [ ] **The swap, one change:**
  - delete `packages/claxedo-app`, `packages/ui`, `packages/session-ui` and `packages/storybook`;
  - rename `packages/claxedo-app-v2` → `packages/claxedo-app` and `@claxedo/app-v2` → `@claxedo/app`;
  - remove the desktop v2 targets, the v2 CI job and the perf-harness workflow steps;
  - point the desktop's two remaining kit imports at the app.
  - `Progress:`
- [ ] **After the swap:** all 33 flows, the five e2e criteria, every check and the benchmark pass again on the renamed app. `Progress:`

## Execution: parallel lanes

Use parallel agents with disjoint file ownership, and a Workflow for the flow-writing and verification fan-outs. Each lane owns its files. A lane that needs another lane's file sends the change to its owner.

| Lane | Owns | Starts after | Delivers |
| --- | --- | --- | --- |
| **Setup** | the copy, `claxedo-app-v2/package.json`, `AGENTS.md`/`CLAUDE.md`, the desktop v2 targets, the v2 CI job | now | P0.1 |
| **E2E** | `claxedo-app-v2/e2e/**`, apart from the corpus | P0.1 | P0.3–P0.5, P0.7, P0.9; then each phase's flows and the five criteria |
| **Bench** | the benchmark repo's `drivers/claxedo/` | now | P0.2, the gate in P6 |
| **Checks** | `script/` checks and the v2 budget baseline | P0.1 | P0.6 |
| **Transcript** | `claxedo-app-v2/src/transcript/**`, `src/session/view/timeline/**`, `e2e/corpus/**` | P0.1 | P0.8, the P1 transcript move, flow 30 at every gate |
| **Adapter** | `claxedo-app-v2/src/server/**` | P0.1 | P0.10, the P1 adapter and status; answers every other lane's server needs |
| **Kit** | `claxedo-app-v2/src/ui/**` | P0.1 | P1 kit |
| **Session** | `claxedo-app-v2/src/{session,composer}/**`, apart from the timeline | the adapter's session surface frozen | P2 |
| **Workbench** | `claxedo-app-v2/src/{rail,workbench,browser,terminal,review,files}/**` | P2's store APIs frozen | P3 |
| **Shell** | `claxedo-app-v2/src/{shell,auth,projects,settings,cloud,machines,onboarding,usage,marketplace}/**` | P2's store APIs frozen | P4 |
| **Plugins** | `claxedo-app-v2/src/plugins/**` (the host), `plugins/*` | P3 | P5 |

- **Review.** Every lane's slice gets an adversarial review before it merges. A "done" row from an agent is a claim until the flows, the five criteria and the checks say so. The transcript, the session list and projects get a second reviewer.
- **Workflows:**
  - In P0.5, fan out one agent per flow to write specs (33 flows, each with its red run).
  - In P0.8, fan out agents over the 95 transcript fix commits (about ten each) and over the transcript comments, turning each into a corpus case, a README line or a deletion.
  - In P1–P5, fan out a review agent per deleted-file group, which checks that nothing in v2 still imports it.
- **Shared worktree.** Commit with `git commit --only <paths>`. Other sessions sweep the index with `git add -A`.

## Open decisions

1. **A hosted projects route.**
   - **Without it,** v2 builds the hosted-first flow on today's contract: a hosted project is created together with its first cloud workspace, and the hosted project list comes through workspaces.
   - **With it,** a hosted project can exist before it runs anywhere, and the list is direct. It would be one route family with the same record shape as the local `/api/claxedo/projects`, repo sources only. Because the adapter owns projects, adding it later changes only `projects.ts`.
   - **Recommendation:** build on today's contract now, and add the route as the first server change.
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
4. **Project identity across deployments.** Local project records and hosted projects are separate id spaces today, and a hosted project needs a workspace to exist. P0.10 maps it before the flow is built.
5. **Today's contract shapes some app behavior.** The adapter carries OpenCode's shapes until the server is rebuilt, and harness status may need the app's one bounded re-read (P0.7 decides).
6. **Phone layouts drift.** Each phase ships its screens with phone layouts, and flow 33 grows with them, so there is no end-of-project mobile pass.
7. **e2e only means slower feedback.** A single flow must run in 60 seconds or less locally, or agents will stop running it; "fast" is a gate, not a hope.
8. **Performance targets.** Idle CPU and long rows are today's weak rows. They are measured at the end of P2 and P3, well before the swap. The long-row target has to be met with the transcript's logic unchanged.

## Definition of done

- [ ] `packages/claxedo-app` (the renamed v2) ≤ 93k production lines, with per-part budgets enforced by the ratchet; first-party plugins ≤ 7k in `plugins/`.
- [ ] No server contract changed, apart from the changes you approved (a hosted projects route, a harness-status fix).
- [ ] **Transcript:**
  - moved, not rebuilt;
  - flow 30 green, with no visible difference you haven't signed off;
  - every fix commit mapped to a case;
  - every transcript comment triaged.
- [ ] **Session sidebar:** one owner; the reconcile rules written in its README; flow 31 green on 20 runs in a row.
- [ ] **Projects:** every project an id; no folder path used as an identity outside `src/server/`; flows 2 and 32 green.
- [ ] **Phone:** every screen has a phone layout; flow 33 green; no horizontal scroll at 390 px.
- [ ] No v1 component, token or class; no import from the old kit packages, which are deleted.
- [ ] Zero comments in the app and plugins; every check at zero.
- [ ] No retired OpenCode name outside `src/server/wire/`.
- [ ] Every machine in [State machines](#state-machines) exists; no view guesses status.
- [ ] Zero unit tests; ≤ 16k lines of e2e; all 33 flows green on CI against the real stack.
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
- **Server data reaches a domain one way:** a snapshot plus the stream, through the adapter, into one store per domain. Not allowed:
  - a second cache;
  - a query library;
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
- one store;
- domain boundaries;
- one owner;
- no directory identity;
- protected areas;
- e2e hygiene.

All must be at zero before a change is done.
````
