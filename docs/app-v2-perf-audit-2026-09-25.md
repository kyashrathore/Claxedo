# App v2 performance audit, 2026-09-25

Discovery audit of `packages/claxedo-app-v2` (dev server :4480) against `packages/claxedo-app` (v1, dev server :4481), both reading the owner's real data through the daemon on :2598. Nothing in app code was changed.

Owner rules checked: no element re-renders unless required; no network call unless freshness needs it; nothing cached without a measured advantage; good idle/battery behaviour.

## Method

- One headless Chromium (Playwright 1.61.1, `chromium-headless-shell`) per run, viewport 1280×800, fresh context per run. Identical script for v1 and v2, alternating v2/v1, 3 runs each unless stated.
- Both apps run Vite dev with dev-mode Solid, so durations are rough. Findings rest on counts.
- Instruments per action (harness: `scratchpad/audit/lib.mjs`):
  - CDP `Performance.getMetrics` deltas (RecalcStyleCount, LayoutCount, Script/Task duration, Nodes, JSEventListeners, JSHeapUsedSize).
  - CDP trace (`devtools.timeline`, `…timeline.frame`, and for idle/hot actions `…invalidationTracking` and `blink.debug`): UpdateLayoutTree count and `elementCount`, Layout count, Paint count, DrawFrame count, BeginMainThreadFrame count, style-invalidation reasons.
  - Init-script wrappers for `setTimeout`/`setInterval`/`requestAnimationFrame` recording call sites (first non-library stack frame), a document-wide `MutationObserver`, `PerformanceObserver` for `long-animation-frame` and `layout-shift`.
  - `page.on("request")` per action; API requests (not Vite module/asset loads) grouped by path template. Initiators from CDP `Network.requestWillBeSent` with async stacks.
- v1's dev build has no `VITE_CLAXEDO_SERVER_URL`, so its client calls `http://127.0.0.1:2593` directly (`packages/claxedo-app/src/platform/api/api.ts:388`) and nothing listens there. The harness bridges v1 in the browser context: HTTP to :2593 is re-issued to :2598 with `route.fetch`, and WebSockets to :2593 are piped to :2598 with `routeWebSocket`. Request counts come from `page.on("request")` and are unaffected by the bridge.
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
| **Idle 30 s: API requests** | **10** | **0** |
| **Idle 30 s: frames / BeginMainThreadFrame** | **60 / 60** | **0 / 0** |
| Idle 30 s: style recalcs / layouts / paints / mutations | 0 / 0 / 0 / 0 | 0 / 0 / 0 / 0 |
| Idle 30 s: timer callbacks fired (timeouts + intervals) | 27 | 4 |
| Idle 30 s: ScriptDuration / TaskDuration (ms) | 15 / 95 | 2 / 36 |
| Idle 30 s: JS heap growth (KB) | 258 | 9 |

v2 is better than v1 on every idle count and on boot network. v1's idle window polls `/api/claxedo/health` ×3, `/session/status`, `/permission`, `/question` ×2 each, reconnects `/api/wr/events` once, draws 60 frames with no paint (2 Hz), and runs incremental GC continuously (1,005 `V8.GC_MC_INCREMENTAL` events in the trace).

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
