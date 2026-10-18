# Claxedo × agent-app-benchmark: Linux infrastructure

Status: done. The Linux packaged app builds and launches. `repack.sh` builds any worktree, in full or renderer-only mode. The driver passes the framework, and a full default run (`baseline-1`, merged HEAD `24980400`) produced 107 of 107 valid observations, with valid resources and 0 clock-rule failures.

## 1. Packaging (Linux, unpacked `--dir`)

Use pinned bun 1.3.14. It goes first on `PATH` so the system bun 1.4.2 cannot rewrite `bun.lock`, which stayed unmodified.

```sh
export PATH=/home/user/tools/node_modules/.bin:$PATH
cd <checkout>
bun run build:packages
bun run --cwd packages/claxedo-desktop package:linux -- --dir --publish never
# executable: <checkout>/packages/claxedo-desktop/dist/linux-unpacked/claxedo
```

- **First build** (main checkout, pre-merge `abfff0c3`): 3 min 31 s. It needed no fixes to the environment or the product.
- **Baseline build** of the merged HEAD `24980400`, in the fresh worktree `/home/user/bench/wt/control`: 260 s. That includes `bun install --frozen-lockfile` (about 10 s) and is done through `repack.sh`.
- **Baseline executable:** `/home/user/bench/apps/control-24980400/claxedo` (provenance in `benchmark-build.txt` beside it).
- `packages/claxedo-desktop/dist/linux-unpacked` in the main checkout is the stale pre-merge build. Don't measure it.
- I removed `packages/claxedo-desktop/resources/mermaid/`. It was my build's output of the native Mermaid helper, which the pele merge removed.

## 2. `/home/user/bench/repack.sh`

```sh
repack.sh <worktree> <output-dir>                                   # full build (about 4–4.5 min)
repack.sh <worktree> <output-dir> --renderer-only <base-app-dir>    # renderer only (about 65–130 s)
          [--expect <marker>]                                       # fail unless the marker is in the packaged renderer
```

**Full mode:**
- `bun install --frozen-lockfile` if `node_modules` is missing.
- `build:packages` (turbo-cached across worktrees).
- `package:linux -- --dir --publish never`, then the result is copied to `<output-dir>`.
- Valid for any change, including main, preload and server changes.

**`--renderer-only` mode:**
- Runs `build:packages`.
- Runs `electron-vite build` with only the renderer section of the worktree's own `electron.vite.config.ts`. A temporary `packages/claxedo-desktop/.benchmark-renderer-only.config.ts` is written and removed afterwards; its source is `tools/renderer-only.config.ts`.
- Copies `<base-app-dir>` and swaps `out/renderer` inside `resources/app.asar` (`tools/replace-renderer.mjs`, @electron/asar). The 91 files that are unpacked in the base stay unpacked.
- Use it only when main, preload and the server bundle are identical to the base's commit. Mostly that means changes under `packages/claxedo-app` or `packages/ui`.
- Every output gets `benchmark-build.txt`: the worktree, commit, uncommitted file count with diff sha256, mode, and build time.

**Proof (renderer-only):**
- In a throwaway worktree at `24980400`, I changed the "Not signed in" label to "Not signed in bench-marker-7f3a" and ran `repack.sh … --renderer-only /home/user/bench/apps/control-24980400 --expect bench-marker-7f3a`.
- Output: `"bench-marker-7f3a" found in /out/renderer/assets/main-BYDFUmHV.js` in 131 s, on a loaded host. An earlier run on a quiet host took 65 s.
- The repacked app launched under Xvfb, its daemon and native modules came up, and the label rendered the marker (checked over CDP before the merge).

**Proof (full):** `/home/user/bench/apps/control-24980400` is a full-mode output (260 s). Its packaging invariants held ("bundled output and native modules").

## 3. The driver (not committed)

The files are in the working tree of `/home/user/Claxedo`:

- `packages/claxedo-app/perf-harness/README.md`: the why. The package bans code comments.
- `packages/claxedo-app/perf-harness/tsconfig.json`: typecheck with `cd packages/claxedo-app && ./node_modules/.bin/tsgo -p perf-harness/tsconfig.json`. It passes.
- `packages/claxedo-app/perf-harness/src/`:
  - `public-agent-app-driver.ts`: entry; hello, prepare, launch, execute, shutdown.
  - `driver-sdk.ts`: SDK loader. It uses `AGENT_APP_BENCHMARK_ROOT`, or else the gitignored link `node_modules/agent-app-benchmark` → `/home/user/kyashrathore/agent-app-benchmark`.
  - `corpus.ts`: manifest and NDJSON reading, digest and byte checks, turn grouping.
  - `materialize.ts`, `packaged-daemon.ts`, `history-import.ts`, `workspace-repository.ts`: native-opencode materialization.
  - `prepared-state.ts`: P0 and P1, the state-cache reuse, and P1 seeding.
  - `state-root.ts`: isolated HOME, XDG, data dir, profile, and allow-listed environment.
  - `packaged-app.ts`: executable, asar and server paths, build digest.
  - `launch.ts`, `app-window.ts`, `cdp-page.ts`, `rail.ts`, `settle.ts`, `running-app.ts`, `switch-cases.ts`, `process-family.ts`, `shutdown.ts`.
- `packages/claxedo-app/scripts/checks/data/benchmark-driver-selectors.txt`: added `[data-component="session-screen"]`, which the driver reads; `claxedo-names` passes with 0 violations. `[data-slot="session-navigation-row"]` is also read, but it is left off the list: it is written through a `data` object prop that the check can't see, so adding it fails the check. The slot already has a CSS reader.

**Checks run, all passing:**
- driver typecheck (above);
- `bun scripts/checks/claxedo-names.ts`;
- `bun run test:architecture-ratchets`: 27 pass, product boundary holds, helpers ratchet passed, file-size ratchet passed. The first run flagged 10 helper divergences in the driver. I fixed them by reusing `freePort`, `stopChild` and `waitForHealth` from `@claxedo/helpers` and `messageUpdated` and `messagePartUpdated` from session-core, and by renaming the rest.

**Product code: no changes.**

### Design decisions

**Materialization (`native-opencode`, source format `opencode-event`):**
- Claxedo has no OpenCode history importer. Its transcript store, the session-core runtime journal, keeps OpenCode's message and part shapes as `message.updated` and `message.part.updated` events.
- Preparation runs the build's own server bundle headless: the packaged executable with `ELECTRON_RUN_AS_NODE`, the same flags and daemon identity variables Electron main gives it, against P0's data dir.
- Through its HTTP API it registers both workspaces (`/api/workspace/resolve`, `/api/claxedo/projects`) and creates all 25 sessions as OpenCode sessions, with their corpus ids (`POST /session`).
- With that daemon stopped, it records each turn through `RuntimeStore` the way a prompt is recorded:
  - a human-turn mark and a lease;
  - `startTurn(user id, first reply id)`;
  - every corpus message and part appended unchanged, with the corpus part time;
  - `finishTurn`.
- Read-back from the stores must equal the manifest: 5,396 messages and 48,234,496 transcript bytes.
- The desktop app never runs on P0. P1 is P0 plus one unmeasured launch to the control session's readiness and a clean quit.

**List and walk:**
- During its preparation launch, P1 switches the rail to the app's Activity view through the session options menu, and the choice persists in the profile.
- The Activity view is the flat recency list (b8 newest, then a17, control last), which is exactly the corpus's list order.
- The default Projects view orders projects by random project id, so a walk's "next row down" could not be guaranteed there. P0 (fresh profile) keeps the default Projects view.

**App start:**
- Clock: from spawn (Bun `performance.now()` just before spawn) to the control session's settle-31-frames, armed with `start: "now"` once the rail renders and mapped onto the driver clock by the time-origin offset.
- The control session is the corpus's oldest, so it isn't listed on the first page. The driver presses the list's own "Load more" (trusted CDP clicks) until its row exists, then clicks the row. Those presses are inside the measured start: once in P1's Activity view, up to 3 times in P0's Projects view.
- The app doesn't restore the last open session across launches.

**Switches:**
- The row is revealed (scrolled into view) untimed, then the driver waits two frames and arms `settleExpression({start: "trusted-pointerdown"})`.
- A round-trip evaluate makes sure the listener is installed before the click.
- Then a trusted `Input.dispatchMouseEvent` mouseMoved, pressed and released sequence goes to the row's `navigation-row-activate` button.

**Walk rules:**
- The destination row must be directly below the source row in the rail's DOM order; this is checked after the switch, except at walk position 0, which comes from control at the bottom.
- A cold step requires that this process never showed the session and that no `session-screen` for it is mounted.
- A warm step requires that it was shown.

**Resource workload:**
- The control session is re-shown untimed before each progressive destination.
- `resource-control` is a measured switch back to control.

**Readiness facts:**
- Displayed: the destination's `session-screen` sits in a non-stashed, non-hidden workbench slot, and it is the only active rail row.
- Transcript: the screen's `[data-slot=session-timeline-scroll] > [data-scrollable]`.
- Rows: `[data-timeline-row]`, keyed by kind, turn, message and part ids.
- Latest turn: `AssistantPart` rows whose `data-content-message-id` is one of the latest turn's replies.
- Composer: the `contenteditable` prompt-input.
- Placeholder: the timeline loading skeleton.

**Processes:**
- `launch` returns one root, the Electron main process (`role: main`). The daemon is main's forked child, so the framework's monitor follows it.
- The driver keeps the family's identities (pid + start time) with a 250 ms `ps` refresh.
- Shutdown sends main SIGTERM (the app quits and stops its daemon), then SIGTERM/SIGKILL to any known survivor.
- Every launch copies its state handle into its own attempt directory, which is deleted when cleanup has no survivors.

**State cache:** `AGENT_APP_BENCHMARK_STATE_CACHE/claxedo/{P0,P1,workspaces,prepared.json}`. It is materialized once per run and keyed by corpus digest and build digest; the second scenario reuses it.

**Environment:**
- The app gets an allow-list: `PATH`, `TMPDIR`, `LANG`, `LC_*`, `TZ`, `USER`, `LOGNAME`, `SHELL`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, plus its isolated `HOME`, `XDG_*`, `CLAXEDO_DATA_DIR` and `CLAXEDO_DESKTOP_USER_DATA_DIR`.
- So the container's proxy and `NODE_OPTIONS` variables never reach the app.
- `CLAXEDO_BENCH_ISOLATE_AMBIENT=1` is accepted, but isolation is always on.

**Logging:** `CLAXEDO_BENCHMARK_DRIVER_LOG=<file>` mirrors the driver's stderr to a file. The framework only shows stderr when a request fails.

### Deviations from the macOS protocol

**Window:**
- Xvfb has no window manager, so `--claxedo-window-maximized` cannot maximize the window.
- The driver passes `--claxedo-window-size=1512,902`, which is the 875 px viewport plus the 27 px Linux menu bar.
- Xvfb runs a `3024x1804x24` screen, which is 1512 × 902 CSS px at `--force-device-scale-factor=2`. The window then centres at (0, 0) and fills the screen.
- Every launch verifies `innerWidth`/`innerHeight` = 1512 × 875 and `devicePixelRatio` = 2 and fails otherwise; the logs show `screenX`/`screenY` = 0/0.
- The window is visible and focused (`visibilityState` visible, `hasFocus()` true) before every measured frame; that is also a gate in every frame.
- The task's suggested 3024x1750 screen is too short: the menu bar would push the viewport to 848 px.

**Theme:** the dark theme comes from `--force-dark-mode`, giving `prefers-color-scheme: dark`; there is no system dark setting under Xvfb.

**GPU:**
- No GPU: Chromium composites in software (SwiftShader) on Xvfb.
- Every frame is software rasterized at 3024 × 1750 device pixels, so absolute times are not comparable with macOS runs.
- Only control vs candidate on this host is meaningful.

**Sandbox:** `--no-sandbox`, because the process runs as root.

**Power:** the framework reports `powerSource: "unknown"`; there is no battery or AC information on Linux.

**Host:**
- A 4-core container shared with other agents' typechecks, builds and e2e runs.
- The framework logs load and the busiest non-benchmark processes in `host-conditions.jsonl` and in each table header.

**Memory:**
- RSS includes the local-server daemon. It boots the embedded OpenCode engine at startup because the workspaces' `opencode.db` exists; on Claxedo that happens whenever the user has OpenCode sessions.
- The family is about 1.2 GiB at idle.

**Transcript header:** turn rows carry the preparation time while messages carry the corpus's 2023 times, so each turn's "Worked for …" header shows a duration of tens of thousands of hours. It is the same row shape, with a few more characters.

## 4. Commands

Each run takes about 4 minutes (232–317 s measured), including about 20 s of materialization. Run it serially, and never at the same time as a build.

```sh
# a run (the default repetitions: 4 starts per mode, 2 walk processes, 1 memory process)
/home/user/bench/bench-run.sh <name> <packaged-executable> [driver-checkout] [extra run options]
#   wraps: xvfb-run -a -s "-screen 0 3024x1804x24 -nolisten tcp" node bin/agent-app-benchmark.mjs run --app claxedo \
#     --root /home/user/Claxedo --executable <exe> --output /home/user/bench/runs/<name> \
#     --driver-env DISPLAY=$DISPLAY --driver-env XAUTHORITY=$XAUTHORITY \
#     --driver-env AGENT_APP_BENCHMARK_ROOT=/home/user/kyashrathore/agent-app-benchmark \
#     --driver-env CLAXEDO_BENCHMARK_DRIVER_LOG=/home/user/bench/logs/driver-<name>.log
# low repetitions for a smoke check:   ... --repetitions 1   (1–100; about 2.5–3 min)
# dry run:  node bin/agent-app-benchmark.mjs run --app claxedo --root /home/user/Claxedo --executable <exe> --dry-run

# control vs candidate (example)
/home/user/bench/repack.sh /home/user/bench/wt/control  /home/user/bench/apps/control-<sha>
/home/user/bench/repack.sh /home/user/wt/switch         /home/user/bench/apps/switch-<sha>   # add --renderer-only <base> when valid
/home/user/bench/bench-run.sh control-1   /home/user/bench/apps/control-<sha>/claxedo
/home/user/bench/bench-run.sh candidate-1 /home/user/bench/apps/switch-<sha>/claxedo
node /home/user/bench/tools/claxedo-runs.mjs verdict /home/user/bench/runs/control-1 /home/user/bench/runs/candidate-1

# one run's table
node /home/user/bench/tools/claxedo-runs.mjs table /home/user/bench/runs/<name>
```

**Why a wrapper for the verdict:**
- The framework's `verdict` groups runs by `app.id` and refuses two runs of the same app ("A verdict needs runs of at least two apps").
- `tools/claxedo-runs.mjs` relabels the two runs as `control` and `candidate` in memory, then calls the framework's own `comparabilityProblems`, `buildVerdict` and `renderVerdict`.
- So the result has the same statistics, the same refusals (different scenario, corpus, clock rule or framework revision, or a failed frame-log check), and the same host-condition header.
- `table` renders one run through the same verdict code: medians, p95/max, min, and valid/attempted.
- I tested both: `verdict` on two control runs, `table` on baseline-1.

**Notes for runs:**
- The driver checkout (`--root`) stays `/home/user/Claxedo`, where the uncommitted driver lives. Only `--executable` changes between control and candidate.
- The driver hashes the executable and `app.asar` into `buildDigestSha256`.
- `bench-run.sh` refuses an output directory that already exists.
- The framework passes the driver only `PATH`, `TMPDIR`, `LANG` and `--driver-env` values. Without `DISPLAY` and `XAUTHORITY` the app can't reach the X server ("Timed out waiting for Claxedo's renderer CDP target").

## 5. Baseline (`/home/user/bench/runs/baseline-1`, build `24980400`, driver digest `483b4b70e5bb`)

- Run: 22:03–22:07 UTC, 232 s.
- 1-minute load 0.98–2.26 (median 1.63) on 4 CPUs. The host was quiet; the busiest non-benchmark process was `claude` at 7.6%.
- Validity: app-start 8/8 valid, session-switch-walk 99/99 valid, resources valid, clock-rule frame logs 107 checked with 0 failed, and `result validate` passes for both result files.
- The table is in `/home/user/bench/runs/baseline-1/table.md`:

| Metric | Median | p95 / max | Min | Valid / attempted |
|---|---:|---:|---:|---:|
| App start, fresh profile | 3257.1 ms | 3570.5 ms (max) | 3069.3 ms | 4 / 4 |
| App start, existing profile | 3239.4 ms | 3324.7 ms (max) | 3082.1 ms | 4 / 4 |
| First visit, 1 MiB | 148.7 ms | 180.3 ms / max 182.8 ms | 103.1 ms | 38 / 38 |
| First visit, 8 MiB | 143.4 ms | 188.3 ms (max) | 137.6 ms | 6 / 6 |
| First visit, 1 MiB long rows | 218.6 ms | 268.6 ms (max) | 201.2 ms | 4 / 4 |
| Return, 1 MiB | 96.3 ms | 145.5 ms / max 170.7 ms | 65.9 ms | 38 / 38 |
| Return, 8 MiB | 98.2 ms | 182.2 ms (max) | 85.2 ms | 6 / 6 |
| Return, 1 MiB long rows | 171.7 ms | 179.1 ms (max) | 152.8 ms | 4 / 4 |
| RSS idle after launch | 1202.8 MiB | 1202.8 MiB | 1202.7 MiB | 6 samples |
| RSS idle after the walk | 1260.1 MiB | 1260.2 MiB | 1260.1 MiB | 6 samples |
| CPU while idle | 0.0 % | 8 % (max) | 0 % | 10 samples |

- **Earlier full runs** of the same build, with an earlier driver revision, were discarded. Under a 1-minute load of 13–39, caused by other agents' tsgo, tsc and vite builds, they gave fresh/existing start medians of 5.67 s / 4.81 s and a 1 MiB first visit of 201 ms. Load moves these numbers by 1.5×–2×, so compare control and candidate only when both ran under similar load; the table headers show it.
- **Repetitions:** with 4 starts and 4–6 samples on the 8 MiB and long-row rows, those rows give the verdict only its minimum sample size. Use `--repetitions` up to 100 when a decision depends on them.

## 6. Blockers and open items

- Nothing blocked the work.
- **Absolute numbers aren't comparable with macOS.** They come from software rendering (SwiftShader) at scale 2 on a shared 4-core VM, and not on a Retina Mac. Every macOS-specific item in the protocol (true maximize, the system dark setting, AC power) is replaced as listed in section 3.
- **The `Load more` presses inside app start are a policy choice.** Measured start includes reaching the control session through the app's own list: one press from P1, up to three from P0. If the owner prefers a start target that is already on the first page, the corpus or the driver policy would have to change. I left it as the honest user path.
- **The driver sits uncommitted in this checkout.** AGENTS.md says it belongs on an `agent-app-benchmark` branch, so whoever lands it should commit it there.
- **Workspace directories are shared.** P0 and P1 store their absolute paths, so attempts share `<state-cache>/claxedo/workspaces`. They are read-only git repos, and nothing writes to them during a run.
