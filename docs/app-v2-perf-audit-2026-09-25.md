# App v2 performance audit, 2026-09-25

Discovery audit of `packages/claxedo-app-v2` (dev server :4480) against `packages/claxedo-app` (v1, dev server :4481), both reading the owner's real data through the daemon on :2598. Nothing in app code was changed.

Owner rules checked: no element re-renders unless required; no network call unless freshness needs it; nothing cached without a measured advantage; good idle/battery behaviour.

## Summary

v2 is cheaper than v1 on almost every count:
- idle network: 0 vs 9–24 requests per 30 s;
- boot: 15 vs 44 requests;
- streaming: 13× fewer Solid computations and 6× fewer requests per turn;
- no polling;
- CLS 0.

The problems that remain, worst first:

1. **Files search** re-renders the whole tree and fetches directory listings on every keystroke, and clearing it blocks for about 100 ms. This is the worst interaction found. v1 shares the design; v2's clear is heavier.
2. **Session switching leaks** the previous transcript while an image probe is pending: +12,240 Nodes and +9.9 MB per 80 switches. v1 stays flat.
3. **A question or permission dock unmounts and re-mounts the whole composer**, with re-fetches (invariant 3 FAIL, shared).
4. **Isolation leaks while streaming.** A background session's deltas wake 8 frames per second. Status events re-run every rail row's computations. The hidden transcript behind the floating composer keeps computing. The scroll thumb's geometry is written 0.6 times per delta.
5. **Panel re-mounts** on every switch back to a session with the panel open (34–38 ms). Panel maximize, restore and close restyle about 5,200 elements.
6. **Transcript scroll restyles 2.4× as many elements** as v1.
7. **Smaller network waste:** catalogs re-fetched per session mount; the files and git state re-fetched twice at every turn end; harness health polled during turns.

The report opens with the ranked exploratory findings and the isolation invariants (the regression gate), then the per-scenario measurements, the full ranked list, the suspected items, the gates and the per-action baseline.

## Exploratory findings, ranked (scenario 13)

Method:
- An automated crawl hovered, then clicked, every visible button, tab, tree item, menu item and link on five surfaces in both apps: a session, the workspace panel, Settings, Marketplace and Tasks. It skipped anything destructive or state-changing (delete, archive, commit, install, send, toggles).
- A scripted pass then covered what a crawl cannot reach: the Files tree (`node_modules`, scroll, search), panel maximize, restore and close, the file and command palettes, a new terminal (the launcher only; no pty was created, and `/api/wr/pty` stayed empty), sidebar hide/show, and each Settings section.
- Every interaction recorded the longest main-thread task, long animation frames, elements restyled, DOM mutations, Solid computations and requests.
- Dev builds: every click costs 5–15 ms of dev overhead, so "over one frame" means over 16 ms here.

Ranked by user impact:

1. **Typing in the Files "Search files..." box re-renders the whole tree on every keystroke, and clearing it blocks the main thread for about 100 ms.** Proven.
   - Measured, v2, per keystroke of "session" with the panel open: **22–32 ms tasks** on the first five keys; **2,036–2,892 elements restyled per key, even when the results do not change** ("o" and "n": the same 70 rows, still 2,041 restyled and 1,284 computations); 1,284–16,343 computations per key (13,756–16,343 on the first three); up to 793 mutations; **10, 14 and 18 `GET /api/wr/file` directory listings on the first three keys** (45 in total), plus one `find/file` per key.
   - Clearing the query: a **98–106 ms task** (LoAF 100–108 ms, in the input event handler), 33,995–52,597 computations, 4,785–9,329 elements restyled.
   - v1: the same design, same order of cost (38,683 computations and 60 requests for the 7 keys; the clear takes 95 ms, LoAF 103 ms). Clearing is heavier in v2 (52,597 vs 30,202 computations in the same pass).
   - Cause:
     - `SearchRow`'s `onInput` sets the query on every keystroke without a debounce (`src/files/view/files-navigator.tsx:68`).
     - Each result replaces `allowed` with a new array even when the paths are identical (`files-navigator.tsx:103-106`).
     - Every nested `FileTree` level rebuilds its filter from the whole list (`src/files/view/file-tree.tsx:155`), auto-expands every matching directory, which fetches its listing (`file-tree.tsx:161-169`), and resets its reveal batches (`file-tree.tsx:185-189`).
     - Clearing flips `allowed` to `undefined`, so every level re-renders the unfiltered tree in one task.
   - Fix: debounce the query; keep `allowed` referentially stable when the result set is unchanged; build the filter once at the root and pass membership down; expand matching directories from the search result's paths without fetching each listing; render the search result as a flat list instead of re-filtering the tree.
2. **Session switching leaks whole transcripts while an image probe is pending** (scenario 3): +12,240 Nodes, +760 listeners and +9.9 MB per 80 switches. v1 stays flat.
3. **Switching back to a session whose panel is open re-mounts the whole panel**: 34–38 ms tasks, 1,246 restyled, 5,833 computations per switch (scenario 10). v1: 26–29 ms.
4. **Maximizing, restoring or closing the panel restyles about 5,200 elements** in a 23–27 ms task each (v2 5,222 / 5,416 / 5,136; v1 5,446 / 5,757 / 5,606). This is the whole center column re-laid out and restyled on a layout toggle. Shared.
5. **Palette typing re-renders every result row per keystroke.**
   - File palette (`mod+p`), "markdown": 16,182 computations, 4,841 restyled, 8 `find/file` requests (v1: 16,911 / 5,866 / 8).
   - Command palette (`mod+shift+p`), "settings": 30,278 computations, 6,998 restyled, a 40 ms task (v1: 23,369 / 9,430 / 18 ms).
   - Closing either palette restyles about 1,500 elements.
   - Same `Show<For>` per-row filter pattern as the model picker (scenario 11); shared.
6. **A Mermaid diagram renders in one 62–87 ms main-thread task** during streaming (scenario 9). Shared.
7. **Settings → Keyboard shortcuts takes 23–49 ms to open** (360 `KeybindingRowView`s rendered at once, `src/settings/view/keybindings.tsx:63-67`), and **Settings → Models makes 11 requests** (`harness/options` ×5, `providers` ×2, credentials; v1 9) in a 31 ms task.
8. **Opening any menu writes `aria-hidden` on 167 sprite symbols**: 495 of 532 mutations on menu open, 165 on close (scenarios 7 and 12). Shared.
9. **Hovering the Marketplace "All" tab restyles 1,174 elements** (v1: 125); the other tabs restyle 49. This is a suspected broad hover selector on the selected tab and was not traced.

Everything else the crawl reached stayed under 16 ms, under 1,000 restyles and under 5 requests in v2: rail controls, project collapse and expand, header buttons, account menu, New Session, Tasks, Settings sections other than Keyboard shortcuts, sidebar hide/show, Files expand and collapse including `node_modules` (7 ms, 836 restyled), tree scrolling, terminal launcher and idle. Hovering never caused a request in v2. Crawl coverage: session 20 of 28 targets, Settings 23 of 23, Marketplace 35 of 47, Tasks 21 of 28. Panel tree items were covered by the scripted pass; the crawl's panel pass stalled after closing Review. Targets that went missing after an earlier click changed the page were not retried.

## Isolation invariants (regression gate)

Measured on real harness turns (Claude Code, "Default (recommended)") in new sessions named "perf-audit …", created on :4480 and :4481 and archived afterwards so the owner's rail stays as it was. Instruments:

- A document `MutationObserver` that classifies each mutation by region: rail own row, other rail rows, rail chrome, composer (`[data-component=composer-frame]`), dock area (the rest of `[data-component=session-prompt-dock]`), streaming message (`[data-message-id]` inside the timeline), timeline chrome, other session-screen parts, workspace panel, overlays, and body-level nodes.
- Style-invalidation tracking with each invalidated node resolved to its region.
- A count of Solid computations re-run per owner component. The dev build's `runComputation` is patched in the browser only, through a Playwright route on the Vite deps chunk, and each run is tagged with its nearest three component owners.
- A document-level observer that logs when the composer, todo dock, question dock or permission dock is added or removed.

"Per delta" divides by the `message.part.delta` frames counted on the event stream.

| # | Invariant | v2 | Evidence (v2) | v1 |
|---|---|---|---|---|
| 1 | A background session's status change touches only its own rail row | **DOM PASS, compute FAIL** | Background turn in a new session (405 deltas, 28.7 s) while "Greeting" is open: 1 mutation in total, on `rail:ownRow`. 159 computations ran elsewhere: other rail rows' owners (`NavigationRow` 35, `ProjectBlock<For>` 16, `Row` 16, `ProjectRows` 10), the open session's composer (`Composer` 6, `AgentHarnessSelector` 4) and shell providers (`SessionStoresProvider` 8, `RoutingProvider`, `PanelProvider`, `CenterHeader`, `SettingsSidebar`). The background deltas also woke **240 animation frames and 442 style recalcs** with nothing visible changing (see the coalescer finding). | DOM PASS (1 row mutation, plus 2 in its kept-mounted hidden transcript); compute FAIL (725: rail 300, composer 215); 2,206 style recalcs; 38 requests |
| 2 | The session composer never re-renders while streaming | **PASS per delta; 7 mutations per turn** | 0 composer mutations per delta across 772 deltas. The 7 per turn are the submit button switching to Stop at the start and back at the end (`disabled`, `data-disabled`, `icon`, `aria-label`, `data-icon`, `use href`). 33 composer computations per turn (`Composer<Show>` 17, `AgentHarnessSelector` 8), driven by status events, not deltas. `SessionHealthPeek` inside the composer polls `agent-config/harness` every 20 s during a turn and on every working-state change (`src/composer/view/health-peek.tsx:19-36`): 4–6 requests per turn. | Same 8 button mutations; 3,196 `PromptInput` computations per turn |
| 3 | A dock appearing or leaving re-renders only the dock | **FAIL** | Todo dock: added alone (PASS). **Question dock: the composer and the todo dock are removed from the DOM when it appears and re-mounted when it is answered** (dock log: `23940 composer removed, todoDock removed, questionDock added` … `27263 composer added, todoDock added`). Cause: `src/session/view/session-screen.tsx:151` wraps the todo dock and the whole `Composer` in `<Show when={props.view.requests().length === 0}>`. The re-mount re-fetches `agent-config/connections` and `permission-mode` and re-runs 316 composer computations. A permission request takes the same path. The todo dock also shifts the composer wrapper through `margin-top: -lift()` (`session-screen.tsx:80`), which is a style write outside the dock. | Same FAIL (composer removed and re-added at the question) |
| 4 | Points 2 and 3 hold with the floating composer (panel maximized) | **PASS for the composer; FAIL for the hidden transcript** | Floating composer: the same 7 turn-edge mutations and 57 computations. The collapsed transcript behind it still runs the virtualizer per delta: 166 timeline-chrome style writes (row translate and bottom spacer, 83 each) and 887 `MessageTimeline` + 383 `hasText` computations for content nobody can see. | Composer PASS by DOM; 3,527 composer computations; hidden transcript 188 chrome writes |
| 5 | While streaming, only the streaming parts re-render; all compute relates to them | **FAIL** | Per delta (run 3, 772 deltas, panel open on Files + Review, Greeting, Local changes review, Tasks and Marketplace visited first): see the breakdown below. | FAIL, and 13× the computations |

Invariant 5 breakdown, v2 run 3 (v1 run 2 in brackets):

| Region | Mutations per turn | Per delta | Computations per turn | Note |
|---|---|---|---|---|
| Streaming message | 7,076 [16,153] | 9.2 [22.6] | 7,567 transcript + 2,117 generic (icons, tooltips, buttons) [53,197 + 91,620] | Expected work. v1's generic share is `Show<Icon>` 34,139 and `AnimatedCountLabel` 14,061. |
| Timeline chrome | 1,387 [1,279] | **1.8** [1.8] | – | Row `style` 695, **scroll thumb `style` 448**, bottom spacer 234: geometry written on each delta. The thumb is invisible unless the reader scrolls or hovers. |
| Body-level Mermaid scratch | 1,805 [1,383] | 2.3 | – | One Mermaid render once the fence completes (gated in `src/transcript/markdown.tsx:350`, correct), drawn in a scratch SVG in `body`. It is the turn's one long task: **62–87 ms** in `mermaid.core` (LoAF), in all 3 runs. |
| Rail | 1 [3] | 0 | 142 [1,605] | The DOM change is the own row's title and status. Computations re-run for every row's owner on each status or update event. |
| Composer | 7 [8] | 0 | 33 [3,196] | Turn edges only |
| Workspace panel (Files + Review open) | 5 [9] | 0 | 126 | Turn end: `statusChanged → idle` invalidates the files and git queries (`src/server/queries.ts:67-68`), so the panel re-fetches `wr/file`, `git/status`, `diff/refs`, `diff/vcs` and `diff/targets` **twice** (10 requests) after a read-only turn, and the tree re-runs `KindMark` 48 and `FileTreeNode` 24. |
| Session screen outside the timeline | 10 [11] | 0 | – | Row and key counters, the sr-only title |
| Ownerless (`createRoot`) | – | – | 518 | `hasText` memo per part, `createRoot(() => createMemo(() => !!part.text?.trim()))`, never disposed (`src/session/view/timeline/message-timeline.data.ts:491`). It trims the whole growing text on every delta. |
| Background session stores, Tasks, Marketplace, settings | 0 | 0 | 0 | PASS: nothing visited-and-left re-rendered or recomputed |

Style: 6,285 style recalcs for 772 deltas (8 per delta). Invalidated nodes resolve to the streaming message (323), the timeline chrome (6), the panel (1) and nodes removed before resolution (269). Requests during the turn: 18 in v2, 129 in v1, whose `queue` is polled 48–55 times per turn.

## Method

- One headless Chromium (Playwright 1.61.1, `chromium-headless-shell`) per run, viewport 1280×800, fresh context per run. Identical script for v1 and v2, alternating v2/v1, 3 runs each unless stated.
- Both apps run Vite dev with dev-mode Solid, so durations are rough. Findings rest on counts.
- Instruments per action (harness: `scratchpad/audit/lib.mjs`):
  - CDP `Performance.getMetrics` deltas (RecalcStyleCount, LayoutCount, Script/Task duration, Nodes, JSEventListeners, JSHeapUsedSize).
  - CDP trace (`devtools.timeline`, `…timeline.frame`, and for idle/hot actions `…invalidationTracking` and `blink.debug`): UpdateLayoutTree count and `elementCount`, Layout count, Paint count, DrawFrame count, BeginMainThreadFrame count, style-invalidation reasons.
  - Init-script wrappers for `setTimeout`/`setInterval`/`requestAnimationFrame` recording call sites (first non-library stack frame), a document-wide `MutationObserver`, `PerformanceObserver` for `long-animation-frame` and `layout-shift`.
  - `page.on("request")` per action; API requests (not Vite module/asset loads) grouped by path template. Initiators from CDP `Network.requestWillBeSent` with async stacks.
- v1's dev build has no `VITE_CLAXEDO_SERVER_URL`, so its client calls `http://127.0.0.1:2593` directly (`packages/claxedo-app/src/platform/api/api.ts:388`) and nothing listens there. The harness bridges v1 in the browser context.
  - Scenarios 1–8 used Playwright routing: HTTP to :2593 re-issued to :2598 with `route.fetch`, WebSockets piped with `routeWebSocket`. `route.fetch` buffers whole responses, so v1's fetch-streamed `/api/wr/events` could not stream there. That broken stream accounts for exactly one v1 request per idle window (a `/api/wr/events` reconnect).
  - From scenario 9 on, an init script rewrites `127.0.0.1:2593` to `127.0.0.1:2598` in `fetch`, XHR, `WebSocket` and `EventSource`. The daemon's CORS allows the v1 origin, and streams are live.
  - Re-measured with the live bridge, v1's idle polling is unchanged: 9 requests per 30 s on the draft page (`health` ×3, `status`, `permission` and `question` ×2 each) and 24 on an open session. The v1 polling reported in scenarios 1–8 is real.
  - Request counts come from `page.on("request")` in both modes.
- Added for scenarios 9–13:
  - **Computations**: in the dev build, Solid's `runComputation` (Vite deps chunk `chunk-4Z4CCSDB.js`, identical in both apps) is patched in the browser only, through a Playwright route that rewrites the served file. Each re-run is counted under the names of its nearest three component owners (`Comp.name`, which solid-refresh wraps). Computations with no component owner are counted as `root:` plus their source.
  - **Regions**: each mutation's target is classified with `closest()` into the regions listed under the invariants. Style-invalidation node ids from the trace are resolved to regions after the run.
  - **Events**: `JSON.parse` is wrapped to count event-stream frames by `type`, which gives the delta count.
  - **Longest task**: the longest `RunTask` on the renderer main thread in each action's trace.
- The owner's data has 4 sessions with local data (project "Claxedo"); the other 7 projects are unavailable fixture records. "Switch among 5 sessions" therefore uses all 4.

## Scenario 1: cold boot to rail painted, then 30 s idle

Medians of 3 runs each. Boot window is navigation start to 6 s after the first `[data-slot=session-navigation-row]`.

| Metric | v1 | v2 |
|---|---|---|
| First rail row (ms after nav start) | 565 | 421 |
| Boot API requests | 44 | 17 |
| Boot module/asset requests (Vite dev) | 1,471 | 1,634 |
| Boot style recalcs / elements restyled | 17 / 683 | 16 / 486 |
| Boot layouts | 13 | 8 |
| Boot paints | 25 | 36 |
| Boot frames (DrawFrame) | 54 | 53 |
| Boot timers fired / rAF fired | 32 / 82 | 2 / 5 |
| DOM elements after boot | 803 | 862 |
| Composited layers after boot | 15 | 11 |
| JS heap after GC (KB) / Nodes / listeners | 40,066 / 1,300 / 161 | 32,764 / 1,460 / 153 |
| **Idle 30 s: API requests** | **10 (9 with a live event stream)** | **0** |
| **Idle 30 s: frames / BeginMainThreadFrame** | **60 / 60** | **0 / 0** |
| Idle 30 s: style recalcs / layouts / paints / mutations | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Idle 30 s: timer callbacks fired (timeouts + intervals) | 27 | 4 |
| Idle 30 s: ScriptDuration / TaskDuration (ms) | 15 / 95 | 2 / 36 |
| Idle 30 s: JS heap growth (KB) | 258 | 9 |

v2 is better than v1 on every idle count and on boot network. v1's idle window polls `/api/claxedo/health` ×3, `/session/status`, `/permission`, `/question` ×2 each (the one `/api/wr/events` reconnect in that window was caused by the harness bridge, see Method), draws 60 frames with no paint (2 Hz), and runs incremental GC continuously (1,005 `V8.GC_MC_INCREMENTAL` events in the trace).

v2 idle wakeups that remain (all runs identical):

- `setInterval` in `ClockProvider` (`src/lib/clock.tsx:12`, `CLOCK_TICK_MS = 10_000`): 3 callbacks per 30 s. Each sets a new `Date.now()` into a signal read by the rail's relative-time labels (`src/rail/view/project-tree.tsx:40`), the account status and the file palette. The rail labels shown are "20h", "22h", "4d"; none can change within the hour, and the tick produced 0 mutations. It ticks while no visible label needs it and regardless of `document.visibilityState`.
- `armWatchdog` (`src/server/stream.ts:59`): 9 `clearTimeout`+`setTimeout(30_000)` pairs per 30 s, one per event-stream frame. The frames are the server's heartbeats on `/api/cp/events` and `/api/wr/events`; the re-arm itself costs nothing measurable. The wakeups are the heartbeat frames, set by the server's heartbeat interval.
- `@vite/client` 30 s ping: dev-only, not in production.

Boot request list, v2 (15 API calls, each once): `bootstrap`, `projects`, `cp/events`, `wr/events`, `agent-config/providers?nativeHarness=pi`, `tasks/presets`, `session-list`, `session/status`, `permission`, `question`, `agent-config/connections`, `wr/pty`, `wr/diff/refs`, `wr/git/status`, `agent-config/harness`. v1 made 44, with duplicates: `/api/control/sessions` ×7, `/api/workspace?host` ×6, `/api/claxedo/bootstrap` ×3, `health` ×2, `connections` ×2.

v2 boot calls a user did not ask for:

- `GET /api/claxedo/tasks/presets` from `probeAvailability` (`src/server/availability.ts:7`, called at `src/server/capabilities.ts:77`): downloads the preset list at boot only to decide whether the Tasks feature exists. The bootstrap declaration already carries feature facts (`declaration.documents` is read on the next line). v1 does not make this call at boot.
- `GET /api/claxedo/agent-config/providers?nativeHarness=pi` from `piConnected` (`src/server/capabilities.ts:43`): the whole provider catalog at boot to compute one boolean (is pi usable). v1 does not make this call at boot.
- `GET /api/wr/pty` from the rail's `useProjectTerminals` (`src/rail/view/terminal-row.tsx:137` → `src/terminal/public.ts:12` → `createTerminalStore`), so the rail can list terminals under each project. Justified by the rail's content; noted because v1 did not list terminals at boot.


## Scenario 2: open the long transcript, then wheel-scroll 3,000 px

Session "Local changes review" (176 KB of messages). Open = click its rail row, 5 s settle. Scroll = 30 wheel events of −100 px, 16 ms apart, then 1.5 s settle; both apps prepend one older page (`message?before`) during the scroll. Medians of 3 runs. Durations in the scroll rows come from runs without the `blink.debug` category: `SelectorStats` inflates `RecalcStyleDuration` about 500× (v2 40,420 ms, v1 7,108 ms with it; 73 ms and 40 ms without).

| Metric | v1 | v2 |
|---|---|---|
| Open: API requests | 25 | 16 |
| Open: mutations / style recalcs / elements restyled | 156 / 67 / 1,054 | 111 / 39 / 945 |
| Open: layouts / paints / frames | 19 / 67 / 32 | 15 / 77 / 22 |
| Open: timers fired / rAF fired | 48 / 28 | 4 / 10 |
| Open: ScriptDuration (ms) | 40 | 5 |
| Open: CLS | 0.079 | 0 |
| DOM elements with the session open | 1,186 | 967 |
| Scroll: API requests | 8 (`status`, `permission`, `question` ×2 each, `wr/process`, `message?before`) | 1 (`message?before`) |
| Scroll: mutations | 846 | 810 |
| **Scroll: elements restyled** | **4,696** | **11,394** |
| Scroll: style recalcs (metric) / RecalcStyleDuration (ms) | 372 / 40 | 360 / 73 |
| Scroll: layouts / LayoutDuration (ms) | 176 / 16 | 101 / 11 |
| Scroll: paints / paint area (px², clipped) | 633 / 1.90 G | 551 / 0.91 G |
| Scroll: frames | 250 | 195 |
| Scroll: rAF callbacks | 91 | 105 |
| Scroll: CLS (wheel is not "recent input") | 0.243 | 0.261 |

v2 does less network, script, layout and paint work than v1 on both actions. The exception is style: for the same wheel input on an identical DOM (the virtual list container, its 22 row children and their attributes match v1 exactly), v2 restyles 2.4× as many elements and spends 1.8× the style time.

Where the extra restyles happen (trace with `invalidationTracking` and `timeline.stack`, v2 run 1):

- 73% of v2's restyled elements (8,348 of 11,394) come from 20 recalcs that each follow a whole-subtree invalidation (`Invalidation set invalidates subtree`, `allDescendantsMightBeInvalid: true`) of one element: the virtual list container `[data-timeline-virtual-content]`'s subtree, 466 elements. The invalidation set is the `:first-child` pseudo set, scheduled from Solid's `reconcileArrays` as rows are inserted and removed.
- The same `:first-child` whole-subtree set fires in v1 (46 subtree invalidations in both apps), but in v1 it lands on small elements: the largest is the childless bottom spacer `div.pointer-events-none.h-16` (907 elements restyled in total).
- The recalcs are flushed synchronously inside `requestAnimationFrame` by the scroll thumb's geometry read: `updateThumb` (`packages/ui/src/components/scroll-view.tsx:225`, reading `scrollHeight`/`clientHeight`) forces 19 recalcs restyling 7,791 elements in v2 against 13 recalcs and 817 elements in v1. `scroll-view.tsx` is shared by both apps; it is the flush point, not the cause.
- Ruled out by experiment on the live v2 page: disabling `src/transcript/styles.css` (11,207 restyled), `src/ui/styles.css` (11,212) or the entire `shell/styles/index.css` (10,437) leaves the count unchanged, and inserting a stable first child into the scroll viewport (v1 has a `div.sticky` there; v2 does not) changes nothing (11,199). The whole-subtree invalidation is therefore not caused by the duplicated stylesheets. Which rule turns the container's `:first-child` change into a subtree invalidation is **not yet identified** (see Suspected).

Session-open requests v2 makes twice:

- `GET /session/:id/permission-mode` ×2 (v1: ×1). First from `permissionModesResource` when the composer is created (`src/composer/permission/permission-mode-wiring.ts:17`), again when `hydrateSession` applies the harness status (`src/composer/harness/harness-hydrator.ts:82` → `harness-scopes.ts:25` `applyPatch`), because the resource key includes the harness selection and changes shape from `{sessionId}` to `{sessionId, selection}` without changing the answer.
- `GET /session/:id/message?view` ×2 is the surface read plus the latest-turn completion (`src/session/transcript/snapshot.ts:51` → `latest-turn.ts:26`). v1 makes the same two reads; by design.

v1 during the scroll polls `/session/status`, `/permission`, `/question` and `/api/wr/process`; v2 does not poll.

## Scenario 3: switch among the sessions, unvisited then visited, then 20 rounds

Order: "Markdown blocks sample", "Greeting", "Image reference verification", "Local changes review" (all 4 sessions with local data), 2.5 s settle each. Numbers are sums over the 4 switches, medians of 3 runs. Then 20 rounds × 4 switches (700 ms apart) with heap measured after two forced GCs before and after. v1 run 1's first switch reloaded the whole page (v1 navigates a local session to `/s/:id`), so v1's unvisited medians use runs 2–3 where that did not recur.

| Metric (4 switches) | v1 unvisited | v2 unvisited | v1 visited | v2 visited |
|---|---|---|---|---|
| API requests | 66 | 65 | 28 | 12 |
| Mutations | 686 | 524 | 178 | 259 |
| Elements restyled | 3,982 | 2,687 | 332 | 1,111 |
| Layouts / paints / frames | 65 / 258 / 100 | 45 / 286 / 82 | 12 / 10 / 24 | 24 / 154 / 75 |
| ScriptDuration (ms) | 117 | 14 | 93 | 8 |
| Timers fired / rAF | 187 / 96 | 15 / 32 | 116 / 28 | 12 / 30 |
| CLS | 0.08 | 0 | 0 | 0 |

| After 80 more switches (after GC) | v1 | v2 |
|---|---|---|
| JS heap (KB) | 56,440 → 56,408 | **40,422 → 50,308 (+9,886)** |
| Nodes (CDP counter, includes detached) | 3,824 → 3,824 | **3,291 → 15,531 (+12,240)** |
| JSEventListeners | 463 → 463 | **285 → 1,045 (+760)** |
| Nodes in the document | 2,336 → 2,336 | 1,285 → 1,285 |

All three v2 runs gave the same growth to the node (15,531 each time).

### Proven: v2 keeps every re-opened transcript alive while an image probe is pending

- Heap snapshot after 12 v2 switches: the detached `session-turn` DOM is retained through `EventListener → V8EventHandlerNonNull → closure → scope.settled (Set) → closure → <span data-component="markdown-image-fallback" data-state="loading"> → <p> → markdown block → … → [data-timeline-virtual-content]`, so the whole old transcript stays alive.
- Code: `probeImage` in `src/transcript/markdown.tsx:584-603` keeps a module-level `imageProbes: Map<src, Set<waiter>>`. Each mount of a markdown image whose probe has not settled adds a waiter closure over its fallback chip (`waiters.add(onSettle)`); nothing removes it on unmount. The Set is released only when the probe `Image` fires `load` or `error`.
- Trigger in the owner's data: "Markdown blocks sample" contains `https://via.placeholder.com/80`, whose request never completes in this environment, so its chip stays `data-state="loading"`. Every re-open of that session keeps one more transcript DOM alive (329-element `section[data-component=session-screen]` roots among the detached elements).
- Control experiment, same script: when the harness aborts `via.placeholder.com` so the probe errors at once, 20 switches leave Nodes flat (1,969 → 1,962) and detached elements flat (177 → 177). Without the abort they grow 2,686 → 5,739 Nodes and 264 → 921 detached elements.
- v1 has the same `probeImage` (`packages/session-ui/src/components/markdown.tsx:627-646`) but keeps visited session screens mounted, so it never re-mounts the chip, and its chip is still `loading` in the live DOM while other sessions are shown. v2 re-mounts the transcript on every switch, which turns the latent defect into a per-switch leak.
- Design fix: the probe registry must drop a waiter when its owner is disposed (return an unsubscribe from `probeImage` and call it in `onCleanup`), or the chip should read a per-`src` signal instead of registering closures. Separately, a hung external image should not keep a probe alive forever. It also fetches a third-party host on every render (in both apps).

### Proven: v2 re-fetches the machine's connection catalog on every session switch

- Each switch, visited or not, makes `GET /api/claxedo/agent-config/connections`, `GET /api/claxedo/agent-config/harness` and `GET /session/:id/permission-mode` (12 requests for 4 revisits).
- `AgentHarnessSelector` creates its own catalog and refreshes it in an effect on every mount (`src/composer/view/agent-harness-selector.tsx:86-94`, `src/composer/harness/connection-catalog.ts:10`). The catalog is machine-level; it changes only when the user edits connections. v1 re-fetches it too (4 per 4 revisits) plus `status`/`permission`/`question` polling.
- Design fix: one owner for the connections catalog at server scope, fetched once, refreshed by the event that changes it or when the harness picker opens.

### Observed trade-off: v2 re-renders a revisited session; v1 keeps it mounted

On revisits v1 paints 10 times and restyles 332 elements for 4 switches because the screens stay mounted (v1 heap 56 MB, 2,336 document nodes). v2 re-renders (154 paints, 1,111 restyles) and holds 40 MB and 1,285 document nodes. The owner's no-cache-without-advantage rule points to v2's side of this trade. It is not listed as a finding.

## Scenario 4: type 40 characters into the composer, then select-all + Delete

In session "Greeting": click the visible composer, type `the quick brown fox jumps over a lazy do` at a 60 ms key delay, then press ControlOrMeta+A and Delete. Enter and send were never pressed. No non-GET request was made in any run. Medians of 3 runs.

| Metric | v1 | v2 |
|---|---|---|
| Typing: API requests | 9 (polling: `status`, `permission`, `question` ×2 each, `health`, `wr/process`, `message`) | 0 |
| Typing: mutations | 46 | 45 |
| Typing: style recalcs / elements restyled | 14 / 14 | 11 / 12 |
| Typing: layouts / paints / frames | 42 / 83 / 59 | 42 / 83 / 59 |
| Typing: ScriptDuration / TaskDuration (ms) | 35 / 101 | 21 / 76 |
| Typing: rAF callbacks | 41 (`queueScroll`, one per key) | 0 |
| Typing: localStorage writes | 80 (9,192 bytes) | 40 (6,002 bytes) |
| Clear: mutations / restyled / layouts / paints | 8 / 12 / 4 / 6 | 8 / 11 / 4 / 6 |
| Draft left in storage after clear | empty-draft record (93 bytes) under `claxedo.workspace…:workspace:prompt` | none (key removed) |

Where the draft persists: v2 keeps it only in `localStorage` under `claxedo:composer:<serverUrl>:session:<id>` (`src/composer/persistence.ts:132`); nothing goes to the server. v1 keeps it in `localStorage` too.

v2 is at or below v1 on every count. Per keystroke v2 does one text mutation, one layout and two paints, with no restyle beyond the editor and the submit button. That is the floor for an uncontrolled contenteditable.

Remaining v2 waste: one synchronous `JSON.stringify` + `localStorage.setItem` of the whole entry (draft plus history) per keystroke (`src/composer/store.ts:66-71` → `persistence.ts:145-155`). The cost grows with the stored prompt history. Design fix: write on idle, blur, `visibilitychange` or `pagehide` rather than per input.

Shared (both apps, same numbers): each keystroke's Paint event carries a 1280×800 clip on the root layer (node 2) plus the 744×52 editor. That is 43.7 M px² for 40 keys. This may be a `chromium-headless-shell` software-raster artifact, so it is listed under Suspected.

## Scenario 5: workspace panel, Files, a file, Changes, Review expand/collapse

In session "Greeting": open the panel with "Open workspace panel" (Files shows first), expand the `docs` folder, open `docs/ci-green-staging-handoff-2026-09-23.md`, click "Open Changes" (source-control column), click the "Review" tab, click "Expand all", then "Collapse all". Commit, stage and push controls were not touched. Medians of 3 runs.

| Step | v1 API | v2 API | v1 restyled | v2 restyled | v1 paints | v2 paints | v1 script ms | v2 script ms |
|---|---|---|---|---|---|---|---|---|
| Open panel | 6 | 3 | 919 | 674 | 153 | 129 | 55 | 40 |
| Expand `docs` | 8 (5 of them polling) | 1 | **147** | **492** | 23 | 25 | 5 | 8 |
| Open file | 1 | 1 | 473 | 327 | 10 | 9 | 20 | 10 |
| Open Changes | 3 | 1 | 155 | 146 | 15 | 13 | 13 | 11 |
| Review tab | 7 (polling) | 0 | 213 | 203 | 41 | 30 | 11 | 8 |
| Expand all | 3 | 1 | 1,292 | 1,331 | 13 | 15 | 14 | 19 |
| Collapse all | 0 | 0 | 61 | 64 | 3 | 4 | 2 | 2 |

v2's panel does fewer requests on every step. Where v1 makes two `diff/vcs/file` reads on Expand all, v2 makes one; v1 also reads `git/status`, `diff/refs` and `file/status` that v2 does not. Panel state goes to `localStorage` only (`claxedo:panel:navigator`, `claxedo:shell:machine:this-machine`).

Folder expand restyles 3.3× more elements in v2 (492 vs 147). The detailed trace shows the same 118-element recalc for the inserted tree rows in both apps. v2 adds one recalc of 343 elements, triggered when the expanded tree becomes taller than the pane and `ScrollView` inserts its thumb (`Node was inserted into tree: div.scroll-view__thumb`, plus an inline-style write to the thumb). Inserting a sibling after the viewport restyles the viewport's subtree, the same positional-selector class as in scenario 2. In v1 the tree root does not change scrollability on this expand. This costs 343 restyles once per expand, so it is wasted work, not lag.

## Scenario 6: hover over rail rows and transcript rows

On session "Local changes review": hover the 4 rail rows (4-step move, 400 ms dwell each), then sweep the transcript at x = 800 from y = 120 to 680 in 40 px steps (120 ms dwell). Medians of 3 runs.

| Metric | v1 rail | v2 rail | v1 transcript | v2 transcript |
|---|---|---|---|---|
| API requests | 9 (polling) | 0 | 0 | 0 |
| Mutations | 16 | 14 | 2 | 2 |
| Elements restyled | 701 | 154 (one run 704) | 480 | 344 |
| Paints / frames | 61 / 22 | 60 / 19 | 18 / 49 | 11 / 53 |
| ScriptDuration (ms) | 13 | 6 | 5 | 4 |

Hover triggers no request and no prefetch in v2. It is at or below v1 on every count. The per-row mutations (`childList div.size-6.shrink-0`, the row's action slot) and the transcript's `:hover` whole-subtree invalidation of `.ui-text-part` / `.ui-user-message` rows are shared with v1.

## Scenario 7: Settings, Marketplace, Tasks, and Back from each

From session "Local changes review": Settings through the account menu (account row → "Settings"), then browser Back. Marketplace and Tasks through their rail buttons, each followed by Back. Medians of 3 runs.

| Step | v1 API | v2 API | v1 mutations | v2 mutations | v1 restyled | v2 restyled | v1 paints | v2 paints |
|---|---|---|---|---|---|---|---|---|
| Settings | 8 | 0 | 783 | 748 | 1,297 | 853 | 43 | 33 |
| Back from Settings | 12 | 3 | 53 | 47 | 257 | 489 | 19 | 49 |
| Marketplace | 4 | 3 | 47 | 58 | 1,220 | 1,257 | 31 | 34 |
| Back from Marketplace | 0 | 3 | 12 | 65 | 87 | 397 | 24 | 49 |
| Tasks | 6 | 2 | 15 | 44 | 161 | 189 | 31 | 29 |
| Back from Tasks | 1 | 4 | 9 | 67 | 87 | 404 | 26 | 50 |

- Every Back in v2 re-mounts the session screen and re-fetches `agent-config/connections`, `agent-config/harness` and `session/:id/permission-mode`. This is the scenario-3 catalog finding again. v1 keeps the session mounted, so Back from Marketplace and Tasks costs it 0–1 requests and 87 restyles; v2 pays 3–4 requests and about 400 restyles.
- Proven, v2 only: leaving Tasks fires `GET /api/claxedo/tasks/tasks?includeArchived,parent,projectId` (initiator `useTaskList` → `src/tasks/data/queries.ts:109-118`, page `queryFn` at `:15`) while the page is being torn down. `TasksPage` derives its project from `store.state.projectId ?? activeProjectId() ?? projects()[0]` (`src/tasks/view/tasks-page.tsx:14`). The route change flips `activeProjectId()` before the Tasks view unmounts, so the list query key changes and fetches a list nobody will see. Suspected mechanism; the request and its initiator are proven.
- Shared, both apps: opening the account menu and choosing Settings makes 668 `aria-hidden` attribute mutations on `<symbol>` elements: the 167 symbols of the inline icon sprite `svg#codex-icon-sprite`, a direct child of `body`, set and cleared twice. The menu's hide-outside pass walks into the sprite and marks every symbol instead of the one `<svg>` container. It is wasted work on every modal or menu open.
- Settings opens with 0 API requests in v2 (v1: 8, including `connections` ×2).

## Scenario 8: window resize 1280 → 900 → 1280

On session "Local changes review", viewport width set to 900 px and back. Medians of 3 runs, identical in each direction.

| Metric (each direction) | v1 | v2 |
|---|---|---|
| Mutations | 0 | 9 |
| Elements restyled | 240 | 312 |
| Layouts / paints | 2 / 2 | 5 / 4 |
| API requests | 0 | 0 |

v2 changes the DOM on a width change: `div.workbench-root` gets `data-collapsed` and a child re-render, and `aside.absolute.bottom-0`, the scroll thumb and the bottom spacer get inline styles. v1 absorbs the same resize with CSS alone (0 mutations). This is minor, but it is script work on every resize frame of a live drag. Design fix: express the collapse breakpoint as a container or media query rather than a JS-set attribute.

## Extra idle check: 30 s on an open session with the panel open

Session "Local changes review" with the workspace panel open, pointer parked, 5 s settle, then 30 s. 3 runs each, identical.

| Metric | v1 | v2 |
|---|---|---|
| API requests | 25 (`status`, `permission`, `question` ×6 each, `health` ×3, `message` ×3, `wr/events` ×1) | 0 |
| Mutations / style recalcs / layouts / paints | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Frames / BeginMainThreadFrame | 0 / 3 | 60 / 60 |
| Timer callbacks fired | 50 | 4 |
| ScriptDuration (ms) | 20 | 1 |

v2's 60 frames are the text caret blinking at 2 Hz, not an app animation. `document.getAnimations()` is empty and there are no SMIL or video elements. The frames occur exactly when an editable element has focus: in v2 opening the panel moves focus into the Files search `<input placeholder="Search files...">`; in v1's boot idle the composer holds focus, and that is where v1's 60 idle frames in scenario 1 come from. Neither app runs an idle animation. Whether opening the panel should move focus into the search box is a product choice; while it does, an idle window with the panel open redraws twice a second.

## Stylesheets: duplication and coverage

CSSOM census and `CSS.startRuleUsageTracking` over boot plus opening "Local changes review" (1 run each; the counts are static).

| Metric | v1 | v2 |
|---|---|---|
| Stylesheets | 23 | 42 |
| Stylesheet text (bytes) | 617,751 | 824,383 |
| Style rules (CSSOM, nested included) | 3,655 | 5,579 |
| Unique rule texts | 3,450 | 3,864 |
| **Duplicate rules / bytes** | **205 / 15,666** | **1,715 / 238,508** |
| Rules used during boot + session open | 1,153 (32%) | 1,672 (30%) |

The duplicates come in two pairs, not one:

- `shell/styles/index.css` + `src/ui/styles.css`: 878 identical rules.
- `shell/styles/index.css` + `src/transcript/styles.css`: 658 identical rules. This is the known one: the shell imports session-ui's styles while `src/transcript/styles.css` imports v2's own copies.
- Plus 25 rules present in all three.

The two extra sheets are 107,563 and 80,707 bytes. Disabling either copy on the live page does not change the scroll restyle count (scenario 2), so the measured cost is parse, memory and rule-matching setup at boot, not per-frame style work. Design fix: one owner per stylesheet. The shell must not import session-ui's and ui's CSS when v2 imports its own copies, or v2 must not keep copies.

## Ranked findings, proven (v2)

Severity order: battery/idle, then lag, then wasted work. Each finding gives (a) scenario/action, (b) metric v1 → v2, (c) cause, (d) whether v1 shares it, (e) design fix.

1. **Session switching leaks whole transcripts while an image probe is pending** (memory growth feeds GC and lag).
   - (a) S3, 80 switches.
   - (b) Nodes 3,824 → 3,824 in v1; 3,291 → 15,531 in v2. Listeners 463 → 463 vs 285 → 1,045. Heap +0 MB vs +9.9 MB. Identical in all 3 runs.
   - (c) `probeImage` waiters are never removed on unmount (`src/transcript/markdown.tsx:584-603`), and v2 re-mounts the transcript on each switch. Proven by retainer path and by a control run where failing the image fast keeps Nodes flat.
   - (d) The code is shared (`session-ui/src/components/markdown.tsx:627-646`), but v1 does not re-mount, so v1 does not leak.
   - (e) Unsubscribe the waiter in `onCleanup`, or key a per-`src` signal. Bound or abort a hung probe.
2. **Transcript scroll restyles 2.4× the elements** (lag).
   - (a) S2, wheel-scroll 3,000 px.
   - (b) 4,696 → 11,394 elements restyled. RecalcStyleDuration 40 → 73 ms. Forced recalcs inside `requestAnimationFrame` at the thumb read: 13 → 19, restyling 817 → 7,791 elements.
   - (c) 73% of v2's restyles follow whole-subtree `:first-child` invalidations of `[data-timeline-virtual-content]` (466 elements), flushed synchronously by `ScrollView.updateThumb` (`packages/ui/src/components/scroll-view.tsx:225`). The rule is not yet identified (see Suspected).
   - (d) The invalidation set exists in v1 but lands on a childless spacer there.
   - (e) Find the featureless `:first-child … *` rule and give it a feature (class) in its descendant part. Read the thumb geometry from cached `ResizeObserver`/scroll values instead of `scrollHeight` inside rAF.
3. **A 10 s clock tick runs for the app's lifetime** (battery/idle).
   - (a) S1, 30 s idle.
   - (b) 3 interval callbacks per 30 s, 0 DOM changes. v1 has 27 timer callbacks and 10 requests in the same window, so v2 is far better.
   - (c) `ClockProvider` `setInterval(…, 10_000)` (`src/lib/clock.tsx:12`) ticks regardless of readers or visibility. The rail's labels are hours and days old.
   - (d) v1 has its own 10 s rail interval plus TanStack's.
   - (e) Tick only while a mounted label needs it, schedule the next tick at the label's next boundary, and stop while `document.hidden`.
4. **Machine-level catalogs are re-fetched on every session mount** (wasted network).
   - (a) S3 revisits and S7 Back.
   - (b) 3 requests per revisit or Back (`agent-config/connections`, `agent-config/harness`, `session/:id/permission-mode`); v1: 4–11.
   - (c) `AgentHarnessSelector` owns its own catalog and refreshes it in a mount effect (`src/composer/view/agent-harness-selector.tsx:86-94`).
   - (d) v1 re-fetches too.
   - (e) Give the catalog one server-scope owner, refreshed by its change event or when the picker opens.
5. **`permission-mode` is fetched twice per session open** (wasted network).
   - (a) S2 and S3 open.
   - (b) v1 ×1 → v2 ×2.
   - (c) The resource key changes shape from `{sessionId}` to `{sessionId, selection}` when the harness hydrates (`src/composer/permission/permission-mode-wiring.ts:17`, `src/composer/harness/harness-hydrator.ts:82`).
   - (d) v2 only.
   - (e) For an existing session, key only on the session.
6. **Leaving Tasks fetches the task list again** (wasted network).
   - (a) S7, Back from Tasks.
   - (b) 0 → 1 `GET /api/claxedo/tasks/tasks`.
   - (c) The `useTaskList` key follows `activeProjectId()` (`src/tasks/view/tasks-page.tsx:14`), which flips before unmount.
   - (d) v2 only.
   - (e) Freeze the page's project when the route leaves, or key it on the route's project only.
7. **Boot fetches two payloads to derive two booleans** (wasted network).
   - (a) S1 boot.
   - (b) v1 0 → v2 2 (`tasks/presets`, `agent-config/providers?nativeHarness=pi`).
   - (c) `probeAvailability` and `piConnected` in `src/server/capabilities.ts:43,77`.
   - (d) v2 only.
   - (e) Let the bootstrap declaration carry both facts, or fetch lazily when Tasks or the pi picker opens.
8. **Every keystroke serializes and writes the whole composer entry to localStorage** (wasted work).
   - (a) S4.
   - (b) 40 writes and 6,002 bytes for 40 keys; v1: 80 writes and 9,192 bytes.
   - (c) `src/composer/store.ts:66-71` → `src/composer/persistence.ts:145-155`.
   - (d) v1 does twice as many.
   - (e) Persist on idle, blur or `pagehide`.
9. **Stylesheets are loaded twice** (wasted work at boot).
   - (a) Boot and session open.
   - (b) Duplicate rules 205 → 1,715. Duplicate bytes 15.7 KB → 238.5 KB. Sheets 23 → 42.
   - (c) `shell/styles/index.css` imports session-ui and ui styles that `src/transcript/styles.css` and `src/ui/styles.css` also load.
   - (d) v2 only.
   - (e) One owner per stylesheet.
10. **Menus hide 167 sprite symbols one by one** (wasted work).
    - (a) S7, account menu → Settings.
    - (b) 668 `aria-hidden` mutations on `<symbol>` elements in both apps (v1 783 total mutations, v2 748).
    - (c) The hide-outside pass walks into the inline sprite `svg#codex-icon-sprite` under `body`.
    - (d) Shared.
    - (e) Mark the sprite container `aria-hidden` and keep it out of the walk, or move the sprite to an external file.
11. **Resize changes the DOM** (wasted work).
    - (a) S8.
    - (b) Mutations 0 → 9, layouts 2 → 5, restyled 240 → 312 per direction.
    - (c) `Workbench` measures with a `ResizeObserver` plus `getBoundingClientRect`, sets a new size object each callback and toggles `data-collapsed` (`src/workbench/view/workbench.tsx:25-70`).
    - (d) v2 only.
    - (e) A container or media query for the collapse.
12. **Folder expand restyles 343 extra elements when the scroll thumb appears** (wasted work).
    - (a) S5, expand `docs`.
    - (b) 147 → 492 restyled.
    - (c) `ScrollView` inserts `div.scroll-view__thumb` as a sibling after the viewport when the tree becomes scrollable, which restyles the viewport's subtree.
    - (d) The mechanism is shared (`packages/ui` `ScrollView`); v1's tree did not change scrollability here.
    - (e) Keep the thumb element mounted and toggle visibility.

Added by the widened scope (scenarios 9–13). The Files-search finding ranks above all of the above for lag. The dock and coalescer findings rank with finding 3 for battery.

13. **Files search re-renders the whole tree on every keystroke; clearing blocks for 98–106 ms.** See the exploratory finding 1 at the top: per key 2,000–2,900 restyled, up to 16,000 computations and up to 18 directory fetches (`src/files/view/files-navigator.tsx:68,103-106`, `src/files/view/file-tree.tsx:155,161-169,185-189`). Shared design; heavier in v2.
14. **Background sessions wake frames**: 240 rAF callbacks and 442 style recalcs per background turn (`src/server/wire/coalesce.ts:53-66`). Battery. v2 only in this form; v1 runs 2,206 recalcs of its own.
15. **A question or permission dock unmounts the composer and todo dock** (`src/session/view/session-screen.tsx:151`), and the re-mount re-fetches `connections` and `permission-mode`. Shared.
16. **Status events re-run every rail row's computations**: 159 computations outside the own row per background turn. The session-list `state()` object is replaced on each status change, so `statusOf` and `rows` recompute for all rows (`src/session/list/statuses.ts:4-8`, `store.ts:111-120`). Wasted compute; there are no DOM writes.
17. **The hidden transcript behind the floating composer keeps computing**: 887 `MessageTimeline` computations and 166 style writes per turn while collapsed. Wasted work.
18. **The panel re-mounts on every switch back to a session that had it open**: 34–38 ms, 1,246 restyled (`src/panel/session-memory.ts`). Shared; lag.
19. **Panel maximize, restore and close each restyle about 5,200 elements** in a 23–27 ms task. Shared; lag.
20. **Every turn end re-fetches the files and git state twice**: 10 requests after a read-only turn (`src/server/queries.ts:67-68`). Wasted network.
21. **Harness health is polled every 20 s during a turn and on each working-state change**: 4–6 requests per turn (`src/composer/view/health-peek.tsx:19-36`). Shared.
22. **Invisible scroll-thumb geometry is written 0.6 times per streaming delta** (`packages/ui/src/components/scroll-view.tsx:225`). Wasted work, with a forced style and layout read each time.
23. **Palettes and the model picker re-evaluate every row per keystroke**: 16,000–30,000 computations per word. Shared.
24. **Mermaid renders in one 62–87 ms main-thread task.** Shared.
25. **An ownerless `createRoot` memo per text part** is never disposed and trims the whole text on each delta (`src/session/view/timeline/message-timeline.data.ts:491`).

Where v2 is already better than v1 and must stay that way: idle network (0 vs 10–25 requests per 30 s), boot requests (15 vs 44), session-open requests (16 vs 25), session-open script time (5 vs 40 ms), no polling during scroll, typing or hover, and CLS 0 on open and switch (v1 0.08).

## Suspected (not proven)

- **The rule behind the scroll subtree invalidation.** The trace names the `:first-child` pseudo invalidation set with `allDescendantsMightBeInvalid` on the list container, scheduled from Solid's `reconcileArrays`. Disabling `shell/styles/index.css`, `src/ui/styles.css` or `src/transcript/styles.css` did not remove it, and the container's own DOM, attributes and matched positional rules are identical to v1's. Next step: disable the remaining 39 sheets one at a time with `bisect-css.mjs`, or read Blink's `InvalidationSet` dump (`--vmodule=invalidation_set*=2`) for the set id.
- **Why Tasks refetches on leave.** The request and its initiator are proven; that `activeProjectId()` flips first is read from code, not traced.
- **Full-viewport paint per keystroke** (shared, same in both): each key reports a 1280×800 Paint on the root layer. This may be `chromium-headless-shell` software raster reporting the layer bounds rather than the damage rect. Check in headed Chrome with paint flashing.
- **Panel focus into "Search files..."** keeps a caret blinking (60 frames per 30 s idle). This is a product behaviour, not a defect; listed because it is the only source of idle frames in v2.

- **Marketplace "All" tab hover** restyles 1,174 elements in v2 against 49 for the other tabs and 125 in v1. Not traced.
- **Frames in headless:** `DrawFrame` and `BeginMainThreadFrame` counts run above 60 per second during streaming in `chromium-headless-shell`. Frame counts are therefore not used as findings for streaming; rAF callbacks are.

## Deterministic regression gates

These counts did not vary across runs, so each can be an exact or ceiling assertion. They must run against a fixture server, not the owner's data. Harness: `lib.mjs` in the audit scratchpad (Playwright + CDP, one headless Chromium).

| Gate | Action | Assertion | Today (v2) |
|---|---|---|---|
| Idle is silent | boot, settle 10 s, 30 s window | API requests = 0, DrawFrame = 0, UpdateLayoutTree = 0, mutations = 0, timer callbacks ≤ 0 after finding 3 is fixed | 0 / 0 / 0 / 0 / 4 |
| No switch leak | 80 switches over 4 sessions, one with an image routed to never respond; 2× GC | ΔNodes ≤ 50, ΔJSEventListeners ≤ 10 | +12,240 / +760 |
| Scroll restyle budget | long-transcript fixture, 30 × −100 px wheel | elements restyled ≤ 5,000; API requests = 1 | 11,394 / 1 |
| Session open requests | click a rail row | no path template twice; total ≤ 15 | `permission-mode` ×2; 16 |
| Revisit requests | revisit a mounted-before session | API requests = 0 | 3 |
| Boot requests | cold boot | ≤ 13 (drop `tasks/presets`, `providers`) | 15 |
| Typing | 40 chars in the composer | API = 0, rAF = 0, mutations ≤ 45, localStorage writes ≤ 2 | 0 / 0 / 45 / 40 |
| Resize | 1280 → 900 → 1280 | mutations = 0 | 9 |
| Menu open | account menu open + close | `aria-hidden` mutations ≤ 20 | 668 |
| Stylesheet duplication | CSSOM census after boot | duplicate rules ≤ 205 | 1,715 |
| Files search | panel open, type "session" | per key: `wr/file` requests = 0, restyled ≤ 300 when results are unchanged; clearing: longest task ≤ 16 ms | 10–18 / 2,041 / 98–106 ms |
| Invariant 1 | background turn while another session is open | mutations outside the own rail row = 0; computations outside the own row's owner = 0; rAF callbacks = 0 | 0 / 159 / 240 |
| Invariant 2 | foreground turn | composer mutations per delta = 0; composer computations per delta = 0 | 0 / 0 (7 and 33 per turn at the edges) |
| Invariant 3 | question dock appears and is answered | composer-frame removals = 0; composer requests = 0 | 1 removal, 2 requests |
| Invariant 4 | turn with the panel maximized | `MessageTimeline` computations while the transcript is collapsed = 0 | 887 |
| Invariant 5 | turn with the panel open | timeline-chrome mutations per delta ≤ 1; thumb writes while hidden = 0; files/git requests after a read-only turn = 0 | 1.8 / 448 / 10 |
| Panel re-mount | switch back to a session with the panel open | Files-tree computations = 0 | 5,833 |

## v2 per-action baseline (medians, dev build, this machine)

| Action | API | Mutations | Restyled | Layouts | Paints | Frames | Script ms |
|---|---|---|---|---|---|---|---|
| Cold boot (to +6 s after rail) | 15 (plus the document and `@solid-refresh`) | 76 | 486 | 8 | 36 | 53 | 45 |
| Idle 30 s, draft page | 0 | 0 | 0 | 0 | 0 | 0 | 2 |
| Idle 30 s, session + panel | 0 | 0 | 0 | 0 | 0 | 60 (caret) | 1 |
| Open long session | 16 | 111 | 945 | 15 | 77 | 22 | 5 |
| Scroll 3,000 px | 1 | 810 | 11,394 | 101 | 551 | 195 | 107 |
| 4 switches, unvisited | 65 | 524 | 2,687 | 45 | 286 | 82 | 14 |
| 4 switches, visited | 12 | 259 | 1,111 | 24 | 154 | 75 | 8 |
| Type 40 chars | 0 | 45 | 12 | 42 | 83 | 59 | 21 |
| Select-all + Delete | 0 | 8 | 11 | 4 | 6 | – | – |
| Open panel | 3 | 124 | 674 | 30 | 129 | 26 | 40 |
| Expand folder | 1 | 28 | 492 | 3 | 25 | 14 | 8 |
| Open file | 1 | 116 | 327 | 2 | 9 | 11 | 10 |
| Review Expand all | 1 | 67 | 1,331 | 8 | 15 | 4 | 19 |
| Hover 4 rail rows | 0 | 14 | 154 | 9 | 60 | 19 | 6 |
| Hover transcript sweep | 0 | 2 | 344 | 0 | 11 | 53 | 4 |
| Settings (menu + item) | 0 | 748 | 853 | 12 | 33 | 37 | 11 |
| Back to session | 3 | 47–67 | 397–489 | 3–6 | 49 | 19 | 2 |
| Resize, each direction | 0 | 9 | 312 | 5 | 4 | 2 | 1 |
| Streaming turn, per delta (panel open) | 0.02 | 14.3 (9.2 in the streaming message) | 45 | 1.6 | 17 | – | 0.85 |
| Background turn, per delta | 0.01 | 0.002 | 1.1 | 0 | 0 | 0.6 rAF | 0.04 |
| Files search, per key | 1–19 | 28–793 | 2,036–2,892 | – | – | – | – (longest task 6–32 ms) |
| Files search clear | 0 | 378–644 | 4,785–9,329 | 4–22 | – | – | 72–184 (longest task 98–106 ms) |
| Panel maximize / restore / close | 0 | 31–59 | 5,136–5,416 | 19–28 | 46–126 | – | 6–17 |
| Heap after boot, after GC | 32,764 KB, 1,460 Nodes, 153 listeners | | | | | | |

## Scenario 10: switching sessions with the workspace panel open, then switching panel tabs

The panel was opened on "Greeting", `docs/ci-green-staging-handoff-2026-09-23.md` was opened as a file tab, then the 4 sessions were switched twice (unvisited, then visited). The harness now also counts Solid computations re-run per component owner and DOM mutations per region (rail row, panel, composer, timeline turns, shell). It does this by patching Solid's dev `runComputation` in the browser (see Method). 1 run each here; the counts repeat from scenario 3.

| Switch (visited pass) | v1 panel mutations | v2 panel mutations | v1 restyled | v2 restyled | v1 longest task | v2 longest task | v2 computations |
|---|---|---|---|---|---|---|---|
| → a session without the panel | 0–13 | 0–20 | 61–150 | 134–1,258 | 21 ms | 10–25 ms | 1,712–2,631 |
| **→ "Greeting" (panel open)** | **88** | **54** | **1,584** | **1,246** | **29 ms** | **38 ms** | **5,833** |

- The panel's open state is remembered per session (`src/panel/session-memory.ts`, `rememberPanelPerSession`), and its body unmounts when hidden (README: "The body mounts while the panel is shown and unmounts 140 ms" later). Switching back to a session whose panel was open therefore re-mounts the Files tree, the Review tab and the file viewer from scratch: `Dynamic<FileTreeNode>` 360 runs, `Switch<KindMark>` 342, 1,246 elements restyled, and a 34–38 ms task (2 frames) in every v2 run. The project, tree, review and file are the same as before the switch.
- v1 does the same (88 panel mutations, 1,584 restyled, 26–29 ms). Shared, lag.
- Design fix: keep the panel body mounted and hidden while the placement is unchanged, or cache the tree's rendered state per placement. Remounting identical content on every switch is the cost.

Panel tab switching (Greeting, panel open):

| Step | v1 API | v2 API | v1 mutations | v2 mutations | v1 restyled | v2 restyled | v1 computations | v2 computations |
|---|---|---|---|---|---|---|---|---|
| File → Review tab | 3 (polling) | 0 | 107 | 107 | 240 | 245 | 1,147 | 965 |
| Review → file tab | 0 | 0 | 124 | 119 | 378 | 363 | 1,332 | 843 |
| Open Changes | 4 | 1 | 27 | 25 | 169 | 158 | 878 | 838 |
| Open Files | 6 (polling) | 0 | 36 | 38 | 399 | 745 | 259 | 174 |

Every panel-tab mutation stays inside the panel region in both apps. Switching tabs re-renders the tab body each time (about 100 mutations and 1,000 computations), because only the selected tab is mounted. No terminal tab existed, so none was measured.

## Scenario 11: the harness/model picker on a new draft

On the draft page: open "Select harness and model", expand Harness, pick Claude Code, scroll the model list, type "sonnet" into "Search models" and delete it, pick Codex, pick Claude Code again, then Escape. The draft started at "Select agent", which cannot be re-selected, so "set back" means back to Claude Code ("Default (recommended)"). The choice lives in `localStorage` (`…workspace:session.draft-default.v1`) of the throwaway browser context; nothing was sent to the server. 2 runs each, identical.

| Step | v1 API | v2 API | v1 mutations | v2 mutations | v1 restyled | v2 restyled | v1 computations | v2 computations |
|---|---|---|---|---|---|---|---|---|
| Open picker | 0 | 0 | 16 | 16 | 170 | 172 | 325 | 309 |
| Expand Harness | 0 | 0 | 33 | 32 | 201 | 203 | 349 | 338 |
| Pick Claude Code | 5–6 | 2 | 79 | 76 | 513 | 500 | ~1,000 | 974 |
| Scroll model list | 0 (3 polling) | 0 | 2 | 2 | 7 | 16 | 16–21 | 13 |
| Type "sonnet" (6 keys) | 0 | 0 | 16 | 16 | 234 | 234 | 1,566 | 1,536 |
| Delete it (6 keys) | 0 | 0 | 15 | 15 | 269 | 269 | 1,838 | 1,808 |
| Pick Codex | 7 | 2 | 109 | 91 | – | 439 | – | 912 |
| Pick Claude Code again | 2 | 2 | 92 | 88 | 462 | 449 | 1,086 | 1,029 |

v2 matches v1 on rendering and makes fewer requests per pick: 2 (`permission/modes`, `harness/options`), where v1 also fetches `commands`, `agents`, `session/capabilities` and `workspace/resolve`. No step exceeded 18 ms.

Shared wasted work: each search keystroke re-runs about 250–300 computations (`Show<For>` 942 runs for 6 keys), because every model row's `Show` re-evaluates the filter even though only 2–3 rows change. Design fix: filter the list once in a memo and let `For` diff it, instead of a per-row `Show` over the unfiltered list.

## Scenario 12: the composer's "+" (Add) menu

In "Greeting": open "+", close it, then open each item that opens something (Commands "/", Context "@", Shell command "!") and dismiss it with Escape. "Images and files" opens the OS file chooser and "Goal" toggles a mode, so neither was clicked. The composer text was verified empty after each. The menu has no submenus. 2 runs each, identical.

| Step | v1 mutations | v2 mutations | v1 restyled | v2 restyled | v1 computations | v2 computations | v1 longest task | v2 longest task |
|---|---|---|---|---|---|---|---|---|
| Open menu | 526 | 532 | 380–386 | 393–400 | 366 | 351 | 13–14 ms | 13 ms |
| Close menu | 179 | 181 | 181 | 164 | 40 | 40 | 3 ms | 4 ms |
| Commands | 194 | 198 | **2,052** | 300 | **6,837** | 236 | 16–20 ms | 3–4 ms |
| Context | 188 | 213 | 301 | 363 | 110 | 421 | 3 ms | 3–4 ms |
| Shell command | 601 | 597–606 | 418 | 394–401 | 1,074 | 1,027–1,048 | 4 ms | 3 ms |

- Opening the menu: 495 of v2's 532 mutations are `aria-hidden` writes on the icon sprite's `<symbol>` elements, and closing adds 165 more. That is the scenario-7 sprite finding, measured per region.
- Shell-command mode re-renders the composer: 412–421 composer mutations and 839–858 `ButtonRoot` computations in both apps.
- v2's Commands popover is 23× cheaper than v1's (236 vs 6,837 computations).

## Scenario 9: streaming a real agent turn

On the draft page of project "Claxedo", with Claude Code "Default (recommended)" selected: a prompt asking the agent to read `package.json` and `AGENTS.md` with its tools and write a ~1,200-word report with a TypeScript block, an 8-row table, a bash block and a Mermaid flowchart. No file changes. Sent with Enter. The workspace panel was opened on the new session, then measurement ran from about 2 s after send until the session was idle plus 2.5 s. Each run created one session. Every such session was then renamed `perf-audit <app> <mode> <run>` and archived through `PATCH /session/:id` (`scratchpad/audit/cleanup.mjs`), leaving the owner's 4-row rail as it was.

The scripted stack (`bun run e2e:perf-stream`) was not run. It builds both apps first, and the real-harness runs answered the questions without a second stack.

| Metric (one turn) | v1 run 2 | v2 runs 2 / 3 |
|---|---|---|
| Deltas (`message.part.delta` frames) | 714 | 785 / 772 |
| Turn length (s) | 52.0 | 59.5 / 51.5 |
| API requests during the turn | **129** (`queue` ×48, `status` ×21, `permission` ×17, `question` ×17, `message` ×11) | **20 / 18** |
| DOM mutations | 19,673 | 13,018 / 11,068 |
| **Solid computations re-run** | **150,836 (211 per delta)** | **11,461 / 10,503 (14 per delta)** |
| Elements restyled / style recalcs | 27,541 / 5,263 | 30,816 / 5,310 · 35,188 / 6,285 |
| Layouts / paints | 1,323 / 10,804 | 1,252 / 11,671 · 1,208 / 13,356 |
| ScriptDuration / RecalcStyleDuration / LayoutDuration (ms) | 2,061 / 496 / 139 | 843 / 527 / 138 · 656 / 567 / 123 |
| rAF callbacks | 753 | 1,598 / 1,494 |
| Longest task / long tasks > 16 ms | 68 ms / 5 | 62 ms / 5 · 75 ms / 1 |
| Worst long animation frame | 76 ms (Mermaid) | 72 ms / 80 ms (Mermaid, `chunk-TCVXKB7Q` = `mermaid.core`) |
| JSEventListeners / Nodes growth | +1,081 / +14,230 | +59 / +4,507 · +37 / +4,642 |

v2 streams with 13–14× fewer computations, 6–7× fewer requests and about 2.5× less script time than v1. Rendering work (restyle, layout, paint) is on par; that is the streaming text itself.

v2 problems seen while streaming, beyond the invariant failures above:

- **Mermaid renders on the main thread in one 62–87 ms task** (every run, both apps; the diagram renders once, when its fence closes). It is the only long animation frame of the turn, 4–5 dropped frames. Design fix: render off the visible frame (idle callback or a worker-side layout where Mermaid allows), or show the code block and render on demand.
- **The scroll thumb's geometry is written 448 times per turn** (0.6 per delta) while it is invisible (`ScrollView.updateThumb`, `packages/ui/src/components/scroll-view.tsx:225`), and each write follows a `scrollHeight` read that forces style and layout. Design fix: skip thumb geometry while the thumb is hidden and compute it when it shows.
- **The turn end re-fetches the placement's files and git state twice** (10 requests) even for a read-only turn: `invalidationKeys` treats `statusChanged → idle` as a file change (`src/server/queries.ts:67-68`), and idle arrives twice (`session.status` and `session.idle`). Design fix: invalidate on the file events or the turn's tool results; de-duplicate the idle transition.
- **`SessionHealthPeek` polls the harness during every turn**: `setInterval(probe, 20_000)` plus a probe on each working-state change (`src/composer/view/health-peek.tsx:19-36`), 4–6 `agent-config/harness` requests per turn. v1 has the same poll.
- **Background sessions wake frames.** Every event batch schedules `requestAnimationFrame` plus a 250 ms timeout (`src/server/wire/coalesce.ts:53-66`), whether or not anything visible depends on it. A background turn produced 240 rAF callbacks and 442 style recalcs (about 8 frames per second) while the visible page did not change (invariant 1). Design fix: flush events for sessions that are not on screen on a timer or microtask; request a frame only when a mounted view subscribes.
