# Claxedo benchmark driver

The application-owned driver of the public [agent-app-benchmark](https://github.com/kyashrathore/agent-app-benchmark). The benchmark's registry app `claxedo` declares `"driverOwnership": "application-repository"`, and the benchmark resolves the driver at the fixed path `$CLAXEDO_ROOT/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`. Do not move it.

- `src/public-agent-app-driver.ts`: the NDJSON driver. It lists the scenario ids it serves and dispatches each to its kind: app start or session switch.
- `src/public-corpus-materializer.ts`, `src/corpus-workspace.ts`, `src/fixture-registration.ts`, `src/opencode-corpus.ts`: write the benchmark corpus into a Claxedo data directory through the app's own server-core and workspace-runtime writers (`src/production-modules.ts`).
- `src/agent-claxedo-launcher.ts`, `src/agent-cdp-page.ts`: launch the packaged app and attach over CDP.
- `src/agent-browser-observer.ts`: reveals a session's rail row, arms the benchmark's page clock and opens the session with a trusted click; also the trusted-input probe after app start.
- `src/claxedo-settle-facts.ts`: what the page clock asks about Claxedo on every frame. It and the observer read the app's `data-testid`, `data-slot` and `data-component` hooks, so the app's `claxedo-names` check counts this folder as a reader.
- `src/browser/painted-frames.ts`: the frame clock the app's e2e rigs run on. The driver uses it only to stamp the paint after its trusted-input probe; session settles are timed by the benchmark's page clock.

## Settle clock

The driver does not compute its own settle. `settleExpression` from `agent-app-benchmark/driver-sdk` builds the benchmark's in-page clock for the rule `settle-31-frames`; the driver evaluates it in the renderer before the click, and the clock resolves to every frame it sampled and the settle frame. The benchmark computes the six ready gates, the frame signature and the transcript mutation flag, samples each frame after style and layout, and re-derives the settle from the frame log the driver returns (`frameLogOf`).

The driver supplies only facts about Claxedo, `claxedoSettleFacts`, evaluated in the page for the destination session:

- `displayed`: the destination's `session-page-root` sits in a `data-workbench-content` surface that is neither `aria-hidden` nor `inert`, it is the one visible session root, and its rail row is the one active rail row.
- `latestTurnRows`: the destination's `UserMessage` and `AssistantPart` timeline rows whose content message id is one of the latest turn's messages; an assistant row with a part id must show one of the latest turn's parts. Each row is answered by its text body (`user-message-text`, or the matching `text-part`'s `text-part-body`) when it has one, otherwise by the row.
- `composer`: the destination's `prompt-input` when it is `contenteditable="true"`.
- `placeholder`: no destination root or timeline, a `data-session-timeline-loading` marker, or a `skeleton` slot in the timeline.
- `transcript`: the timeline's scroller, `[data-slot="session-timeline-scroll"] [data-scrollable]`; `rows` are its `data-timeline-key` rows, keyed by that attribute.

A switch runs on the renderer's clock, from the first trusted pointerdown after the clock is armed to the settle frame. App start clicks the control session's row like a switch and runs on the driver's clock, from the process spawn to the settle frame: the renderer's frames map onto it by the difference between the renderer's and the driver's `performance.timeOrigin`.

## Settle stamp

Driver version 3 is timed by the benchmark's page clock above. It samples in the same rendering step as the painted-frames clock and reports the settle frame's observation, `performance.now()` right after the sample, with the benchmark's gates, signature and mutation scope in place of the driver's own. The measurements below compare earlier versions.

Driver version 2 reported the settle frame's observation time and declared `settle-31-frames`. Version 1 reported the time the painted-frames clock saw that frame painted and declared no clock rule. On one run of the packaged 394ff45ca5 app that recorded both for every settle (111 s, 1-minute load 20–30), the painted time was later than the observation by 3.2 ms median, 5.4 ms p95 and 6.0 ms at most over 98 switches, and by 3.2 ms median and 6.2 ms at most over 15 app-start and control settles. Version 2 durations are shorter than version 1's by that much for the same frames.

The published results from before the rule came from driver commit 0df673fff3, which sampled each frame inside its requestAnimationFrame callback and reported that sample's observation. That sample ran before the frame's style and layout, where version 2's ran after them: on the same run version 2's observation came 2.2 ms median and 4.5 ms at most after the callback began. The two samples can read different content for the same frame, so the difference from those results is not a fixed offset. Results from either earlier driver declare no clock rule, and the benchmark's verdict refuses to pair them with results that declare one.

## Frame clock

`installPaintedFrames` in `src/browser/painted-frames.ts` is serialized into the page, so it has no runtime imports: its one import is the `PaintedFrames` type from `src/browser/page-globals.ts`. The app's e2e suite imports the file by path, not through an install, and `typecheck:e2e` checks it through that import. The driver installs it when it attaches to the renderer.

Each frame's requestAnimationFrame callback records `performance.now()` as the frame's start, requests the next frame and observes a 1 px sentinel with a new ResizeObserver. Chromium delivers that observer in the same rendering step, after every requestAnimationFrame callback and its microtasks and after style and layout, before paint. Its callback disconnects the observer, runs `sample` and posts a task, and that task reads the painted time and runs `painted`. No task runs inside a rendering step, so an input or data task that Chromium runs between the frame and its posted task is not in the sample.

The frame's observer is created in its requestAnimationFrame callback, so in the rendering step's first ResizeObserver pass it runs after every app observer created earlier and reads what they wrote. When those writes resize other observed elements, Chromium runs another pass for the deeper ones; what that pass writes is painted in this frame and read in the next frame's sample, one frame late. Chromium limits each further pass to elements deeper than the shallowest one the previous pass delivered. The sentinel sits 256 elements deep so that it is never that element; the app's deepest element in flow 12 is 41 deep. With the sentinel one element below the root, an app observer that resized its own element ran twice per frame instead of once, in 29 of 29 frames.

In three traced panel interactions the posted task began 0.02–2.92 ms after the frame's Commit, median 0.03–0.05 ms across 124 stamps, so the stamp is the time the frame was painted. The sample itself runs before paint: 0.26 ms median, 0.35 ms at most, for the panel walk's recorder. The requestAnimationFrame timestamp is the compositor's BeginFrame time, issued while an input task can still be running: it was 1.7–23 ms earlier than the painted time, and a `performance.now()` read in the callback was 1.1–7.6 ms earlier.

An input or data task in the gap between the frame and its posted task delays the stamp. In a streaming session an SSE read ran between a frame's Commit and its stamp in 3 of 4,915 stamps, landing more than 2 ms late and at most 9.2 ms late, against a median lag of 0.02 ms: a reported 33.8 ms interval was a 24.7 ms frame plus 9.2 ms of stamp lag. The lag inflates the worst interval and adds about two frames to the over-budget count, but it never creates a stall; traced frame-end intervals are the cross-check. A frame an input delayed is stamped after that input, with the state painted before it, so a subscriber places a frame before or after an input by its start, not its stamp.

The next frame is requested from the callback, not from the posted task: after a long frame Chromium can begin the next one before the task runs, and requesting from the task would skip that frame.

A subscriber stops by returning `true` from `painted`, or by calling the function the subscription returns.

## Install and verify

This package is not a workspace member; the root install does not install it. Its framework dependency is the benchmark checkout that runs it, linked:

```sh
cd /path/to/agent-app-benchmark && bun link
cd packages/claxedo-app/perf-harness && bun install
bun run verify
```

`verify` typechecks `src/` and `test/` and runs `test/`. From the app package, `bun run test:perf-harness` runs the same.

## Run

From the benchmark checkout, `node bin/agent-app-benchmark.mjs run --app claxedo`, with `CLAXEDO_ROOT` naming this checkout and `CLAXEDO_BENCHMARK_EXECUTABLE` the packaged app. The benchmark's README lists the other variables.
