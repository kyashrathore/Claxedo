# Claxedo benchmark driver

The application-owned driver of the public [agent-app-benchmark](https://github.com/kyashrathore/agent-app-benchmark). The benchmark's registry apps `claxedo` and `claxedo-v2` declare `"driverOwnership": "application-repository"`, and the benchmark resolves the driver at the fixed path `$CLAXEDO_ROOT/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`. Do not move it.

- `src/public-agent-app-driver.ts`: the NDJSON driver. It lists the scenario ids it serves and dispatches each to its kind: app start, session switch, session navigation, workspace panel.
- `src/public-corpus-materializer.ts`, `src/fixture-registration.ts`, `src/opencode-corpus.ts`: write the benchmark corpus into a Claxedo data directory through the app's own server-core and workspace-runtime writers (`src/production-modules.ts`).
- `src/agent-claxedo-launcher.ts`, `src/agent-cdp-page.ts`: launch the packaged app and attach over CDP.
- `src/agent-browser-observer.ts`, `src/public-workspace-panel.ts`, `src/frame-sampler.ts`: the readiness predicates and frame timing. They read the app's `data-testid`, `data-slot` and `data-component` hooks, so the app's `claxedo-names` check counts this folder as a reader.
- `src/browser/painted-frames.ts`: the one frame clock those predicates run on. Each frame is sampled in its own rendering step, after layout and before paint, so a sample reads what the frame painted, and it is stamped in a task posted from that step, so a reported end is when the ready frame was painted, not when it began.
- A workspace panel trace reports `frameTimestampsMs` from that clock: the painted time of each frame that began after the input. The benchmark's `summarize.mjs` derives `worstIntervalMs`, the p95 interval and `overBudgetIntervalCount` from those timestamps, so for this driver every interval is the gap between two painted frames, and a frame over 16.7 ms is a painted gap over 16.7 ms.

The same driver measures the archived packaged v1 app and today's app, so a precondition it enforces must hold for both.

## Frame clock

`installPaintedFrames` in `src/browser/painted-frames.ts` is serialized into the page, so it has no runtime imports: its one import is the `PaintedFrames` type from `src/browser/page-globals.ts`. The app's e2e suite imports the file by path, not through an install, and `typecheck:e2e` checks it through that import. It is installed before any readiness loop runs.

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

See the benchmark's `docs/presets/claxedo-v1-vs-v2-fast.md`: `CLAXEDO_ROOT` names this checkout, and `CLAXEDO_BENCHMARK_EXECUTABLE` / `CLAXEDO_V2_BENCHMARK_EXECUTABLE` name the packaged apps.
