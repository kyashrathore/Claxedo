# Agent App Benchmark driver

`src/public-agent-app-driver.ts` is Claxedo's driver for the public agent-app-benchmark: an NDJSON subprocess the framework starts as `bun <root>/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`. It serves `app-start` and `session-switch-walk` over the `opencode-completed-sessions` corpus and declares the `settle-31-frames` clock rule. The framework's `docs/driver-protocol.md` is the contract.

## Environment

- `CLAXEDO_BENCHMARK_EXECUTABLE`: the packaged desktop executable (the framework sets it from `--executable`).
- `AGENT_APP_BENCHMARK_ROOT`: the framework checkout whose `src/driver-sdk.mjs` the driver loads; without it the driver imports `agent-app-benchmark/driver-sdk`, which resolves through a `node_modules/agent-app-benchmark` link.
- `CLAXEDO_BENCHMARK_DRIVER_LOG`: optional file that receives the driver's log lines, which the framework otherwise shows only when a request fails.
- The framework passes the driver only `PATH`, `TMPDIR`, `LANG` and the `--driver-env` entries, so a display (`DISPLAY`, and `XAUTHORITY` under `xvfb-run`) must be passed with `--driver-env`.

## Materialization (`native-opencode`)

Claxedo's transcript store is the session-core runtime journal, whose `message.updated` and `message.part.updated` events carry OpenCode's message and part shapes. Preparation writes the corpus through the build's own code paths:

1. The packaged executable runs its own local-server bundle headless (`ELECTRON_RUN_AS_NODE`, the flags and daemon identity Electron main gives it) against the `P0` data directory. Its HTTP API registers each corpus workspace (`/api/workspace/resolve`, `/api/claxedo/projects`) and creates every session with its corpus id as an OpenCode session (`POST /session`). The desktop app itself never runs on `P0`.
2. With the daemon stopped, each turn is recorded through `RuntimeStore` exactly as a prompt is: a human-turn mark, a lease, `startTurn` with the turn's user and first reply ids, every corpus message and part appended unchanged as presentation events (with the corpus part time), then `finishTurn`. Sessions are written oldest first, so the journal's human-turn order is the corpus's recency order.
3. Every session's messages are read back from the stores and must match the manifest's message count and transcript bytes.

The journal stamps turn rows with the time of preparation while messages keep the corpus's 2023 times, so a turn's "Worked for" header shows a long duration.

`P1` is a copy of `P0` that completed one launch to the control session's readiness, switched the rail to its Activity view through the session options menu, and quit. The Activity view lists every session newest first across workspaces, which is the corpus's list order. The Projects view orders projects by their random ids, so its order would differ between preparations. A launch from `P0` therefore uses the Projects view.

## Launch and readiness

- Each launch copies its state handle into its own attempt directory with its own `HOME`, XDG directories, Electron profile (`CLAXEDO_DESKTOP_USER_DATA_DIR`) and data directory (`CLAXEDO_DATA_DIR`), and passes the app an allow-listed environment.
- The window is 1512 × 875 CSS pixels at device scale 2 in the dark theme (`--force-device-scale-factor=2`, `--force-dark-mode`, `--claxedo-window-maximized`). On Linux the app is also given `--claxedo-window-size`, 27 px taller than the viewport for its menu bar, because a bare X server has no window manager to maximize it; as root it also needs `--no-sandbox`. A launch fails unless the renderer reports that exact viewport and scale.
- App start runs from process spawn to the control session's settle. The control session is the corpus's oldest, so it is reached the way a user reaches it: the driver presses the list's own Load more until its row is listed, then clicks the row. These presses are inside the measured interval.
- The process root is the Electron main process. The local-server daemon is its forked child, so the framework's monitor counts it in the family. Shutdown sends the main process SIGTERM, which quits the app and stops the daemon, then signals any process of the family still alive.

## Session switches

- The source is the session on screen. Before a switch the driver scrolls the destination's row into view, untimed, and arms the page clock; the trusted pointerdown on the row starts it.
- A walk step fails unless the destination's row is directly below the source's in the rail, and unless a first visit is to a session this process has not shown (and that has no mounted session screen) and a return is to one it has.
- The memory workload returns to the control session, untimed, before each progressive destination.

## Readiness facts (`settle.ts`)

- Displayed: the destination's `session-screen` is in a workbench slot that is not stashed or hidden, and the rail's only active row is the destination's.
- Transcript: `[data-slot="session-timeline-scroll"] > [data-scrollable]` inside that screen; rows are its `[data-timeline-row]` elements, keyed by row kind, turn, message and part ids.
- Latest turn: an `AssistantPart` row whose `data-content-message-id` is one of the latest turn's replies.
- Composer: the screen's `[data-component="prompt-input"]` while it is `contenteditable`.
- Placeholder: the timeline's loading skeleton.

## Payload boundaries

Everything the driver reads from outside its own code arrives as `unknown` and is narrowed before use: the corpus manifest and events, the prepared-state cache (`prepared.json` under `AGENT_APP_BENCHMARK_STATE_CACHE`), the packaged daemon's answers, CDP replies, renderer evaluation results, the framework's cases and the SDK module loaded from `AGENT_APP_BENCHMARK_ROOT`. Corpus messages and parts must pass `isAgentMessageInfo` and `isAgentContentPart` from `@claxedo/agent-runtime-contract`, the same contract the runtime journal stores, so a corpus the runtime would not accept fails preparation instead of reaching the store. A malformed payload fails the request with an error that names it; nothing falls back to a default.
