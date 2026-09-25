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

