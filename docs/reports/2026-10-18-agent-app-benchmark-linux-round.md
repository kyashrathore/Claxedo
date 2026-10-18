# Agent App Benchmark round on Linux, 2026-10-18

The agent-app-benchmark's app start and session-switch walk, run against packaged Linux builds in a 4-core cloud container. Five changes were merged; together they make app start 2.1× faster, first visits 1.3–1.8× faster and returns 2.2–2.4× faster, and they lower family RSS by 50–73 MiB. Mermaid now draws with pele, which the benchmark corpus cannot measure because it has no diagrams.

## Result

`combo2` is the five merged changes on top of `24980400` (pele). It was measured at `--repetitions 6` between two control runs of `24980400` at the same repetitions, both full packages. Medians; × is control over candidate.

| Row | Control | Merged | × |
|---|---:|---:|---:|
| App start, fresh profile | 3,150 ms (n=12) | 1,471 ms (n=6) | 2.14 |
| First visit, 1 MiB | 128.5 ms (n=228) | 88.6 ms (n=114) | 1.45 |
| First visit, 8 MiB | 138.0 ms (n=36) | 107.2 ms (n=18) | 1.29 |
| First visit, 1 MiB long rows | 191.4 ms (n=24) | 107.9 ms (n=12) | 1.77 |
| Return, 1 MiB | 75.0 ms (n=228) | 34.2 ms (n=114) | 2.19 |
| Return, 8 MiB | 83.7 ms (n=36) | 37.5 ms (n=18) | 2.24 |
| Return, 1 MiB long rows | 154.3 ms (n=24) | 65.3 ms (n=12) | 2.36 |
| RSS idle after launch | 1,220 MiB (2 runs) | 1,170 MiB (1 run) | — |
| RSS idle after the walk | 1,258 MiB (2 runs) | 1,185 MiB (1 run) | — |
| Idle CPU | 0.0 % | 0.0 % | — |

Every bootstrap 95% interval of the time ratios excludes 1. The RSS rows rest on one memory process per run and are not resolvable below tens of MiB.

## What changed

- **Opening an OpenCode session no longer boots the embedded engine.** The open view's todos and goal facts read the transport's capabilities for an unattached session. `OpenCodeSdkTransport.capabilities` answered that by listing the engine's unbound model catalog, which imports and creates the engine; both callers read only static fields. That branch now returns the declared facts with no models (`packages/harness/src/transports/opencode-sdk/transport.ts`). Alone: app start 3,232 → 1,542 ms, RSS after launch 1,252 → 1,128 MiB. The first OpenCode turn after launch now pays the engine's boot.
- **A return to a session evicted from the eight open views paints its kept turn at once.** The row read that gated the reveal is a side read (`src/session/transcript/snapshot.ts`). The walk visits about 24 sessions, so most returns are evictions. Alone: returns 77 → 33 ms (1 MiB). If the runtime has lost a kept session, the reader sees the kept turn and the failed row read is logged.
- **A primary press on a rail row starts that session's reads.** Activation stays on click, so dragging a row into a split still works; touch presses read nothing (`src/rail/view/row-navigation.ts`, `navigation-row.tsx`). The read no longer waits behind the click task's mount. Alone: first visits 137 → 97 ms (1 MiB). A press dragged away still costs one read.
- **The first view renders no overscan rows** until the first wheel, touch or pointer press (`src/session/view/timeline/message-timeline.tsx`). In the long-rows sessions the row above the reply is a 131 KB prompt. Alone: long-rows first visit 207 → 158 ms.
- **The autolink extension's start search is bounded** to 1,024 characters and a whitespace cut (`packages/ui/src/context/marked.tsx`). It scanned the rest of the paragraph at every inline step: 71 MB of scanning and 55–104 ms of lexing for the 131 KB reply, against 6 ms now, with identical tokens. The benchmark did not resolve it alone at n=4; it is merged for the quadratic cost, which also applies while a long paragraph streams.

## Tried and not merged

See the 2026-10-18 rows of [the perf ledger](../perf/AGENTS.md). Renderer `--optimize-for-size` made returns slower. The in-process network service saved about 30 MiB at the cost of process isolation. Nine other candidates stayed inside the drift between control runs. A folded-prompt prefix reached the same row as zero overscan but hides the prompt from screen readers and find-in-page while folded.

## Method

- **Host:** 4 vCPU, 15 GiB, Linux 6.18, Xvfb `3024x1804x24` without a window manager, software rendering. The window is placed at (0,0) with a 1512×875 viewport at scale 2, checked on every launch, instead of maximized. Absolute numbers are not comparable with the macOS runs in [the 2026-09-27 report](./2026-09-27-perf-goal-final.md).
- **Driver:** `packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts`, rationale in `packages/claxedo-app/perf-harness/README.md`. It imports the corpus as OpenCode sessions through the packaged build's own server and session-core store, walks the Activity view, and stamps frames with the SDK's `settle-31-frames` clock. App start includes pressing the list's "Load more" until the control session, the corpus's oldest, is visible, then opening it.
- **Builds:** full `package:linux --dir` packages. Renderer-only repacks were used to screen renderer candidates, but a repack of an unchanged commit measured 90 MiB more RSS than its full package, so their RSS rows were discarded.
- **Statistics:** screening runs at the default repetitions were compared with pooled controls, because two controls of one build differed by up to 20% on a row with n=4. Medians with bootstrap 95% intervals of the control/candidate ratio.
- **Commands:** `/home/user/bench/repack.sh <worktree> <out>`, `/home/user/bench/bench-run.sh <name> <exe> [--repetitions N]` (wrapping `node bin/agent-app-benchmark.mjs run --app claxedo` under `xvfb-run`), and a pooled comparison script over the runs' `result.json`. These live outside the repository.

## Not verified

- A macOS packaged run, and the published comparison against T3 Code and OpenCode.
- The e2e flows owed by the timeline changes, flow 30 in particular, which this host cannot run against its darwin baselines.
- A positive control that the engine stays unbooted after the walk (`opencode.db` open in the server child); the 124 MiB and 1.7 s drops are the only evidence.
