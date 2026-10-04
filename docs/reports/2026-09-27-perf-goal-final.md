# Performance goal: final run on perf/base

Branch `perf/base`, measured at `ceab229c5b` (local, unpushed; later commits on perf/base change only tests). Base: v2/preview `8bf476ddc9`.

**Outcome:** the owner's finish line changed on 2026-09-28 from 60 Hz to parity. Once Claxedo beats T3 and OpenCode, or is close to them, on every compared metric, perf work stops. The final run beats both on every row except one tie. The panel and tab rows have no counterpart in the other apps and do not gate.

## Goal

The bar the owner set on 2026-09-27:

- **60 Hz, meaning every painted frame lands within 16.7 ms**, for:
  - a session switch, cold and warm;
  - a workspace panel switch;
  - a tab switch inside a panel.
- **Idle CPU close to 0**, and never above 0.5 %, summed over every Claxedo process.
- **Memory:** about 712 MiB RSS at launch, never above 850 MiB, and no growth.
- **Constraints:** no DOM caching, no hover or idle prefetch, a tool body loads only when the user expands it, and hidden panes unmount.

## Result

One packaged run of `ceab229c5b` (app start plus the session-switch walk, 1 m 21 s, 1-minute load 25 falling to 16), on the `4925123275` driver's rAF clock (digest `064f66ad256dcce6`). T3 Code 0.0.42 and OpenCode 1.18.32 were each run separately the same morning, with drivers byte-identical to the 27 Sep ones. Raw data and verdicts are in `~/test/claxedo-perf-private/perf/bench-now/rerun-fc104ff4ef/` (`runs/final-ceab229c5b-*`, `verdict-final-ceab229c5b-*.md`), which is private. × is the other app's median divided by Claxedo's.

| Row (median) | Claxedo | T3 | × | OpenCode | × |
|---|---|---|---|---|---|
| App start, fresh profile | 1.08 s | 2.94 s | 2.74 | 2.37 s | 2.20 |
| App start, existing profile | 980 ms | 2.81 s | 2.87 | 2.24 s | 2.29 |
| First visit, 1 MiB | 45.5 ms | 142.2 ms | 3.13 | 118.2 ms | 2.60 |
| First visit, 8 MiB | 52.2 ms | 293.4 ms | 5.62 | 124.8 ms | 2.39 |
| First visit, 1 MiB long rows | 133.3 ms | 576.2 ms | 4.32 | 130.9 ms | 0.98 (tie within 5 %) |
| Return, 1 MiB | 26.6 ms | 66.9 ms | 2.52 | 56.7 ms | 2.13 |
| Return, 8 MiB | 32.7 ms | 135.2 ms | 4.13 | 57.3 ms | 1.75 |
| Return, 1 MiB long rows | 60.4 ms | 87.0 ms | 1.44 | 107.7 ms | 1.78 |
| RSS after launch | 731 MiB | 1099 MiB | 1.50 | 1325 MiB | 1.81 |
| RSS after the walk | 750 MiB | 1337 MiB | 1.78 | 1561 MiB | 2.08 |
| Idle CPU | 0.0 % | 1.6 % | — | 20.4 % | — |

Against the goal's own bars:

| Goal | Before (`4925123275`, same rig) | Final | Met |
|---|---|---|---|
| Session switch, first visit (1 MiB / 8 MiB / long rows, ms) | 85.9 / 169.1 / 302.4 | 45.5 / 52.2 / 133.3 | 60 Hz not the bar; parity met |
| Session switch, return (1 MiB / 8 MiB / long rows, ms) | 79.1 / 149.2 / 114.2 | 26.6 / 32.7 / 60.4 | parity met |
| Switch between live streams (median / p95, ms) | 7.2 / 15.1 | not run | not verified (needs the owner's API credentials) |
| Workspace panel open, warm; panel tab switch | 17.3–20.8 | not re-measured | does not gate |
| Idle CPU | 0.722 % mean (packaged preview) | 0.0 % median, 0.4 % p95 | met |
| RSS at launch / after the walk (MiB) | 740 / 841 | 731 / 750 | met, no growth over the walk |
| App start, existing profile | 1266 ms launch to ready | 980 ms | met |

- **The one tie:** the long-rows first visit is decided by one session, `long-1`, whose last reply is a 20 KB markdown sampler (79 code fences, 4 diagrams, math, 9 failing images). Its median settle fell from 657 to 218 ms, but one of three cold visits still took 902 ms while the worker's code colour spans landed. It is a disclosed outlier. Fixes that would have removed it were measured and dropped because each cost something elsewhere: Custom Highlights lost bold and italic in code, synchronous KaTeX added 290 KB to the main chunk, and diagram and image deferral could not reserve their boxes.
- **Earlier numbers:** a run of `394ff45ca5` earlier the same day measured the same rows; against it, no row of `ceab229c5b` is worse beyond noise.

### How to read these numbers

- **Clock:** frame times are taken on the painted-frames clock, `perf-harness/src/browser/painted-frames.ts`. A frame is sampled in its own ResizeObserver step on a hidden sentinel, then stamped in a task posted from that step, so each number includes the frame's style, layout and paint.
  - Numbers from before `457edfcadd` used a rAF clock: `performance.now()` is taken in a rAF callback, right after a DOM sample that forces style and layout, so the stamp includes those but not paint. They are not comparable with the numbers after it.
  - The gap grows with the frame. On one app build, data set and host, the same first visit read 89.2 ms on rAF and 119.4 ms painted at 1 MiB, and 183.4 ms against 233.0 ms at 8 MiB. Panel frames differ by a median of 7.9 ms. Style and layout are inside both stamps, so the gap is paint plus whatever tasks run ahead of the posted stamp (not yet attributed).
  - Session-switch rows are therefore given on both clocks. T3's driver (`t3.ts:1820–1821`) and OpenCode's (`settle.ts:183–184`) stamp on the same rAF clock, so the rAF column is the like-for-like comparison.
  - In this report, the before-column panel figures were re-measured on the painted clock.
- **Cross-app fairness:** Claxedo's session-switch rAF numbers come from the `4925123275` driver, the one that measured T3 and OpenCode. The panel scenarios have no counterpart in the other two apps.
- **Switch time is first ready:** the frame where the destination's first page has painted. Settle should equal it, because nothing loads after that paint. Whether T3's and OpenCode's settle equals their first ready, and whether they fetch tool bodies before expand, is not verified.
- **Load:** the host is shared. The run logs load average, and ratios are compared within one run, never across runs.

## What changed

perf/base carries 375 commits over `8bf476ddc9`, grouped here by the goal they serve.

### Session switch

- **Reads start earlier:**
  - The history router writes the URL in the next task, after the route has issued its reads.
  - The permission mode, model, effort and agent are facts on the session row (the mode contract), so no control query holds the reveal.
- **Markdown is parsed once:**
  - A completed block's first paint uses the projection's tokens and one block hash.
  - Sanitized markdown and diagram markup are parsed into the block once.
  - A markdown commit writes only the blocks that changed.
- **The first page is text only:**
  - A cold switch makes one read: the outline, the session row and two screens of rows. Text, file parts and the terminal message come whole; tool parts come as headers (name, title, status, time) with no attachments, except those the reader's shell/edit settings open by default.
  - The switch is done when that page paints. Nothing loads after it: no idle fill, and a warm return makes no read at all.
  - Older turns load on scroll-up, one screen before the top, in the same shape.
  - A tool body loads when the user expands its row, as one part read by primary key.
  - A folded turn is sent with every part and opens without a read; the separate fold-open read is deleted.
- **Less mounting work:**
  - A user message renders one Switch.
  - An icon is one component.
  - The jump button's working dots mount only while visible.
  - The message nav takes its width from its ResizeObserver, not a forced layout.
- **A return shows current text in its first frame:** a hidden view commits the deltas that streamed while it was away before it renders.

### Workspace panel and tabs

- Pressing the panel toggle starts the files root listing, and pressing a file row reads the file before the release opens it.
- A file row mounts one monochrome icon.
- Review rows and tree levels read their queries by key, not by position, so a reorder no longer re-parses diffs.
- A remounted navigator restores its scroll once its rows render.
- The navigator column and its content share one width.
- Selector pruning (kit patches 0074 and 0075) cut the pane's first style and layout by 25 %.

### Idle CPU

- The workbench handover cue is the handover's own element, so a stashed slot no longer animates every vsync. This was the root cause: family CPU dropped from 2.82 % to 0.069 %.
- The text shimmer moves as a transform-animated mask on the compositor instead of repainting `background-position`.
- **The daemon no longer wakes on timers:**
  - the lifecycle evaluates residency on change, not on a 1 s poll;
  - the ownership snapshot is written only when it changes;
  - a lease is held by its open connection;
  - `cp/events` beats on the shared 10 s heartbeat.
- Unobserved desktop diagnostics sample once per 60 s bucket.
- The plugin toolchain loads when a plugin is built, not at boot.

### Streaming

- A streaming code fence draws only lines its closed block will have.
- A lone trailing list marker no longer draws an empty nested list.
- Mermaid is drawn by the desktop's native helper. The web build does not bundle it.
- **Correctness defects found and fixed along the way:**
  - A prompt could name another session's message or part ids, and did.
  - Cloud-mirror and harness tool-call part ids could cross sessions.

## Also on perf/base: cleanup and fixes (2026-09-28)

- **App cleanup:** dead exports, barrels and machinery removed; the always-true CSS gates unwrapped with zero computed-style differences; phone touch reveals, 44 px targets and one phone-breakpoint owner; a failed turn's record error shows its fields; one owner per i18n key and command id, enforced by `scripts/checks/one-registration.ts`.
- **A detached-timeline leak:** the jump button's running fade kept a whole unmounted timeline alive (about 470 nodes per switch). It now cancels its animations on unmount; the phone detached-DOM check went from 2–3 failures in 10 to 30 of 30 passes.
- **Server cleanup:** routes only the v1 app used are deleted (`/project` writes, shell file and agent routes, `second-device-open`, the hosted services catalog, the v1 session-list filters, runtime `GET /mcp` and `GET /file/raw`).
- **Runtime times:** session records carry the runtime's own times and ids; nothing mints `Date.now()` or an empty id, and a delete stamps only `deleted_at`. OpenCode refuses a fork into a requested child before its engine forks.
- **Placements:** listed workspace rows carry `reachable`; a 403 ends a stream instead of reopening it, and a share grantee reads its session's own stream; the hosted control plane serves harness options; a relayed placement's terminal belongs to the open session.
- **Errors:** a temporary rate limit and a used-up plan are separate classes, each with its own recovery; a failed turn names the account it ran on; a rejected Claude plan window names its reset.
- **Desktop:** in-app links stay in the app, and the dev renderer reads the daemon's credential routes.

## Tradeoffs

- **Painted clock:**
  - A ResizeObserver pass that runs later in a frame is read one frame late.
  - The sample adds about 0.26 ms before paint.
  - The sentinel is always attached, so a theme toggle restyles 256 more elements, about +0.16 ms. Attaching it only while a measurement runs would move that cost into every measured window instead.
- **Code-block copy button:** it keeps the kit's IconButton and Tooltip, which is about 13 reactive owners per button.
- **Icons:** each icon costs 2 computations.
- **Mermaid:**
  - A failed render no longer retries on every commit; it re-renders only on a source or theme change.
  - Native layout differs on two corpus diagrams (d001, d004).
  - The web build pays a ~55 ms mermaid.js import on first use.
  - The block's height changes when the diagram replaces its source.
- **Tasks bridge:** it keeps two calls.
- **Timeline:** the active turn's last row stays rendered even when it is scrolled out of the render range, so a streaming row is never remounted.
- **Session list:** sorting by `updated_desc` reorders the list on a mode change (option A of the mode contract).
- **Terminal history:** up to ~8 ms of pty history can be lost if the daemon crashes.
- **Daemon-gone recovery:** only the desktop has it. When the daemon's lease is lost or its process exits, a banner names the cause and offers one button:
  - in the packaged app, "Restart Claxedo" relaunches the whole app through `runRestart`;
  - in a dev build, "Reload window" reloads the window.

  The web build shows nothing. Flow 41 covers the banner; the relaunch itself has no e2e test.
- **Streaming frames:** more than 33 ms happens 3 times per run, against a target of 2 or fewer (it was 5 before).
  - The remaining long frames are the main thread sitting idle (72 of 81 ms), not app work.
  - Dropped frames went from 12 to 5, the max frame from 65 to 47 ms, and LoAF from 2 to 0.

## Not verified

- A signed desktop cloud session, end to end, reading stored sessions through the account (`cb7928cf42`).
- Click-to-paint on a transcript of 9–10k elements. At 2,531 elements it measured at most 6.9 ms; the larger case needs a trace from the owner's own sessions.
- The two-browser live-sync drill (`scripts/drill/live-sync-two-browser.ts`) now reauthorizes its streams every 30 s instead of every hour. It was not run.
- The refused-requests alert has no e2e render (flow 08).
- The live-stream switch on the final build: it needs the owner's Anthropic endpoint and token, which this session did not have. The rig is `rerun-fc104ff4ef/stream-run-build.sh`.
- The Solid "computations created outside a createRoot" warning the owner saw twice in the Electron dev app. Replaying the same steps in a separate Electron dev instance did not reproduce it; the owner's DevTools stack trace is needed.

## Follow-ups

**Owner calls:**

- B2: whether the thinking shimmer stays.
- F3: the desktop still ships the mermaid.js chunks.
- F12: the `processDiagnostics` subsystem has no v2 consumer.

**Engineering:**

- F11: under load, the idle-grace boot wait can exceed 10 s.
- ACP step-start message ids are supplied by the harness and written with `INSERT OR REPLACE`.
- Server boot: when `ps` is slower than the 2 s probe budget, the daemon crashes before it sends ready. A deterministic repro proves the mechanism. That this caused the 2 of 6 boot-test failures is inferred, not confirmed, and the race is not fixed.
- The launcher's poll races at load, and its deadline is 3 s.
- `pty/index.test.ts:270` notify flake.
- The panel walk has:
  - duplicate TraceEvent records;
  - no layout-shift augmentation;
  - no cost measured for the sentinel's style on a root invalidation;
  - no zero-delta anchor for the warm panel open.
- Backfill worker, condition 3: a 60 ms main-thread parse versus ≤2.7 ms per batch clone.
- Launch-gate tests are load-sensitive (ownership-durable, authorization-recorded).
- close-panel takes 133 ms, which is its motion (a 120 ms transition plus the 140 ms hide). Shortening it is an owner design call.
- open-panel-warm is still over budget on its first frame (median 29.4 → 26.6 ms).
- A css-invalidation check for a state attribute on an ancestor combined with an identity attribute on the rightmost selector: evaluated and not added. It matches 82 rules, nearly all static or small subtrees, and would need an ~80-entry baseline to catch one case.
- The panel's `pointer-events` stays; `inert` measured slower (4.2–5.3 ms against 3.3–4.0 ms on close).
- Mermaid's SVG cache is keyed by source only, so a theme change keeps the old colours (present before this work).
- A kit TooltipV2 API that adopts an existing trigger, so the copy button can drop its owners.
- The desktop `relaunch` channel quits with `app.exit(0)`, which skips the daemon handoff. That's harmless when the daemon is already gone, but a normal restart from the renderer skips the handoff too.
- A detached doc comment in `pty/index.test.ts` no longer sits next to the `alive` helper it describes.
- A single tall text part renders whole, because a timeline row is one part. Block-level rows for long text are not built; a turn-as-window virtualizer is parked as too large for now.
- Cloud-stamped sessions: when the runtime gives no `created_at`, the order-key fallback is still open.
- The per-turn record belongs to the stream-store lane.
- `long-1`: one cold visit in three still settles at about 900 ms, after the worker's code colour spans.
- The fresh-profile app start had one 6.64 s outlier among 4 samples; not investigated.
- Owner question: nothing in production reads the D1 service installation store (`serviceInstallations`, `installation-ledger.ts`, `EMPTY_SERVICE_CATALOG`). Delete it, or keep it for optional services.
- `workspace-runtime/src/pi-native.node-test.ts` still skips unless `PI_EXECUTABLE` is set.
- The kit still carries the always-true `body:not([data-new-layout])` gate in `accordion.css`, `card.css` and `v2/styles/theme.css`.
- OpenCode's engine cannot fork into a requested child id, so a managed fork on OpenCode is refused (409 `unsupported_operation`); a fork child gets no title and does not inherit the parent's model or agent.

## Test it yourself on perf/base

The worktree is `~/test/opencode-app-v2-lanes/perf-base-merge`, branch `perf/base`.

```sh
cd ~/test/opencode-app-v2-lanes/perf-base-merge
git log -1 --format=%h
bun install
bun run dev                   # desktop dev build
# or the packaged app, which the numbers above were taken on:
bun run build:packages && CLAXEDO_CHANNEL=prod bun run --cwd packages/claxedo-desktop package:mac
open packages/claxedo-desktop/dist/mac-arm64/Claxedo.app
```

Check these by hand:

1. **Session switch.**
   - Click between a short session and your largest one, both cold (first visit since launch) and warm.
   - The destination should paint in one step with its composer mode already right: no "Default" flash and no rows jumping.
2. **Scrolling up after a cold open.**
   - Older turns load as you near the top, and the view shouldn't jump.
   - Tool rows show their header only. Expanding one loads its body; leaving the app idle loads nothing.
3. **Panel.**
   - Open and close the workspace panel.
   - Switch between the Files and Review tabs.
   - Expand one review file, and open a file from the tree.
   - Focus stays on what you pressed, and the navigator doesn't scroll sideways.
4. **Streaming.**
   - Start two long turns and switch between them while they stream.
   - A return should show current text in its first frame, with no replay.
   - Start a new session with "+" while both stream: it opens as a draft with a centered composer.
5. **Idle CPU.**
   - Leave the app for a minute after a turn finishes. In Activity Monitor, every Claxedo process should sit at about 0.0–0.3 % CPU.
   - To check that a held lease keeps the daemon asleep, run `node ~/test/claxedo-perf-private/perf/idle-cpu/lease-sleep/lease-sleep.mjs`. It needs the `exp-idle-cpu-base` worktree.
6. **Memory.** After a walk through ten or more sessions, the process-family RSS should stay near its launch value and below 850 MiB.
