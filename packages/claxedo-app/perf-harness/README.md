# Claxedo benchmark driver

The application-owned driver of the public [agent-app-benchmark](https://github.com/kyashrathore/agent-app-benchmark). The benchmark's registry apps `claxedo` and `claxedo-v2` declare `"driverOwnership": "application-repository"`, and the benchmark resolves the driver at the fixed path `$CLAXEDO_ROOT/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`. Do not move it.

- `src/public-agent-app-driver.ts`: the NDJSON driver. It lists the scenario ids it serves and dispatches each to its kind: app start, session switch, session navigation, workspace panel.
- `src/public-corpus-materializer.ts`, `src/fixture-registration.ts`, `src/opencode-corpus.ts`: write the benchmark corpus into a Claxedo data directory through the app's own server-core and workspace-runtime writers (`src/production-modules.ts`).
- `src/agent-claxedo-launcher.ts`, `src/agent-cdp-page.ts`: launch the packaged app and attach over CDP.
- `src/agent-browser-observer.ts`, `src/public-workspace-panel.ts`, `src/frame-sampler.ts`: the readiness predicates and frame timing. They read the app's `data-testid`, `data-slot` and `data-component` hooks, so the app's `claxedo-names` check counts this folder as a reader.
- `src/browser/painted-frames.ts`: the one frame clock those predicates run on. Each frame is timed and then sampled in a task its requestAnimationFrame callback posts, which runs once the main thread has finished rendering the frame, so a sample reads what the frame painted and a reported end is when the ready frame was painted, not when it began. A frame an input overtook before its sample is not sampled.

The same driver measures the archived packaged v1 app and today's app, so a precondition it enforces must hold for both.

## Frame clock

`installPaintedFrames` in `src/browser/painted-frames.ts` is serialized into the page, so it has no runtime imports: its one import is the `PaintedFrames` type from `src/browser/page-globals.ts`. It is installed before any readiness loop runs.

Each frame's requestAnimationFrame callback records `performance.now()` as the frame's start, requests the next frame and posts a task. That task reads the painted time and then runs `sample`. In traced panel and session interactions it began 0.05–0.66 ms after the frame's Commit, so the sample reads the DOM the frame painted, including what the app changed in its own requestAnimationFrame callbacks. The requestAnimationFrame timestamp is the compositor's BeginFrame time, issued while an input task can still be running: it was 1.7–23 ms earlier than the painted time, and a `performance.now()` read in the callback was 1.1–7.6 ms earlier.

The posted task is not always the next task: Chromium runs a queued input task first. In a page whose frames did 8 ms of requestAnimationFrame work, a click landed between the frame and its task in 20 of 20 tries. That input's DOM changes are not in the frame, so a frame that a trusted pointerdown, pointerup, click, keydown or keyup overtook calls `overtaken` instead of `sample` and `painted`, and a subscriber without `overtaken` skips it. A queued data task can still run in between; its DOM changes are then read one frame early.

The next frame is requested from the callback, not from the posted task: after a long frame Chromium can begin the next one before the task runs, and requesting from the task would skip that frame.

A subscriber stops by returning `true` from `painted` or `overtaken`, or by calling the function the subscription returns.

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
