# U11 Claxedo qualification status

Started: 2026-08-09. Last measured: 2026-08-11.

## v5 — CURRENT RESULTS (2026-08-11) — READ THIS FIRST

Everything below this section is chronological working history. Later entries
supersede earlier ones, and several earlier claims were corrected by their own
authors; each correction is recorded in place.

### Version index

Every packaged measurement in this document belongs to a numbered version. Each
version is a BUILD that was packaged and measured, not a remembered number.

| Version | Date | What it is | Artifacts | Section |
|---|---|---|---|---|
| v1 | 2026-08-09 | Entry baseline | `claxedo-final-sustained-terminal` | "v1 — entry baseline" |
| v2 | 2026-08-10 | + bounded PTY disk-history compaction | `history-disk-isolated-all-1` | "v2 gate table" |
| v3 | 2026-08-11 | + bootstrap receiver fix, reconnect gate, resolve single-flight | `AC-cpu-control-{1,2,3}` | "v3 gate table" |
| v4 | 2026-08-11 | + session-metadata reconcile generation gate | `AC-reconcile-all-{1,2,3}` | "v4 gate table" |
| **v5** | **2026-08-11** | **current control — persister and engine pre-load reverted** | `AC-postrevert-all-{1..4}` | this section |

Unversioned candidates were packaged, measured and REVERTED, so they never
became a version. They are listed under "Reverted after packaged measurement"
with the reason each one died.


**Control build:** `AC-postrevert-all-{1..4}` — the six retained slices, nothing
under test. Median of 4 launches, validity-failed samples excluded.

| Metric | Current | Gate | Status |
|---|---:|---:|---|
| `app.cold_ready_ms` | **1,921.2** (1,753.2 / 1,867.2 / 1,975.3 / 4,984.7 — ALL FOUR VALID) | <= 1,750 | **fail — 171 ms short** |
| `work_item.cold_open_ms` | 153.3-169.6 | <= 55 | **fail** |
| `work_item.warm_switch_p95_ms` | ~138-145 | <= 20 | realistic ~35-70 ms: 30.6 ms is CDP round trips inside the window, and 20/20 measured switches are cold mounts |
| `history.navigate_p95_ms` | 70.6-80.4 | <= 100 | pass |
| `stream.interaction_p95_ms` | 32.0 | <= 16.67 | **fail** — but the metric is quantised to {16,24,32,...}; the budget is operationally "16 or bust" |
| `stream.blocked_frame_ratio_pct` | 0 | <= 1 | pass |
| `terminal.input_to_paint_p95_ms` | 28.5-35.5 | <= 100 | pass when the lane is valid |
| `terminal.output_mib_s` | 19.15-20.85 | >= 20 | pass in 2 of 3 valid runs (`AC-postrevert-all-1` = 19.153, `passed: false`) |
| `resource.peak_process_family_rss_mib` | 1,735.6-1,939.0 | <= 650 | realistic ~950 MiB, derived per process; beats both peers and the competitor on this metric |
| `resource.quiescent_cpu_p95_pct` | wanders **1.0-8.0** across windows on identical code | <= 5 | **UNRELIABLE** — passes some windows, fails others; no retained slice shown to move it |

**6 of 10 gates pass. 4 fail: cold ready, cold open, warm switch, RSS.**

Qualification remains BLOCKED and the paired T3 comparison must not be run or
published. The 30-minute idle lane is intentionally unstarted.

### Two caveats that change how this table should be read

- `terminal.*` is discarded by an instrument race in roughly 3 warmed attempts
  in 7. The gate PASSES with a ~3x margin whenever the lane is valid; the defect
  costs attempts, not qualification. See the terminal instrument section.
- `resource.quiescent_cpu_p95_pct` is quantized in ~1.0-point steps and its p95
  is the 4th-worst second of 60. It passed at exactly 0.000 margin before the
  reconcile gate landed. Treat any change near it with suspicion.

### Blocked on the host, not on the work

Two slices are implemented, green, ablation-tested and UNMEASURED, waiting for
AC power (the harness preflight refuses to run on battery):

- worker-transport wiring — `opencodeWorkerPath` is silently dropped, so the
  worker transport is dead code in the desktop; wiring it moves the 23 MB engine
  compile off the server's event loop.
- rail-sidebar clock scoping — a 10 s tick invalidates every session row to
  update one label.

Neither may be counted until packaged against a control build in the same
session.

## Decision

**Blocked — do not run or publish the paired T3 comparison.** Claxedo has not
passed its independent absolute gates, so a five-times claim would be invalid.
The retained work is limited to correctness-preserving changes and measured
wins; experimental candidates that regressed or did not improve the packaged
app were removed.

## v1 — entry baseline (2026-08-09)

Superseded. Kept as the comparison point for every later version.
Artifact: `claxedo-final-sustained-terminal`.

This is the ENTRY BASELINE, not the current state. For current results see
"Current results" at the top of this document.

Artifact: `artifacts/agent-app-benchmark/claxedo-final-sustained-terminal`

Command:

```bash
bun run --cwd packages/claxedo-app/perf-harness benchmark:agent-app -- \
  --app "$PWD/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app" \
  --profiles all --run-profile iteration --seed 1729 \
  --targets packages/claxedo-app/perf-harness/targets/five-times.json \
  --output artifacts/agent-app-benchmark/claxedo-final-sustained-terminal
```

| Metric | Result | Gate | Status |
|---|---:|---:|---|
| Cold ready | 2,060.082 ms | <= 1,750 ms | fail |
| Cold open | 178.900 ms | <= 55 ms | fail |
| Warm switch p95 | 181.000 ms | <= 20 ms | fail |
| History navigation p95 | invalid | <= 100 ms | invalid/fail |
| Stream interaction p95 | 24.000 ms | <= 16.67 ms | fail |
| Stream blocked-frame ratio | 0% | <= 1% | pass |
| Terminal input-to-paint p95 | 66.400 ms | <= 100 ms | pass |
| Terminal output | 20.823 MiB/s | >= 20 MiB/s | pass |
| Peak process-family RSS | 1,912.281 MiB | <= 650 MiB | fail |
| Quiescent CPU p95 | 3.999% | <= 5% | pass |

Four gates now pass. Six remain failed or invalid, so this is diagnostic U1
evidence rather than publishable U11 qualification.

## Terminal M7/M8 result (2026-08-09, superseded)

M8 now uses the checked-in `targets/terminal-output-v1.json` contract rather
than runtime-derived expectations. Its target entry is hash-pinned from
`five-times.json` and fixes the source corpus, 10-second duration, 21 MiB/s
offered load, 1,680 repetitions, 220,201,166 wire bytes, wire SHA-256
`f43e5bf0baeade571dec6540f3e7e827077ba171836bef63b1b0bf3ea77f518b`,
145x52 measured geometry, and serialized-model SHA-256
`8d7e396ae2659a881ed49361466059d43ea3b1dba210b9499e610b0be12aa330`.
The browser hashes accepted output incrementally and keeps bounded evidence.

The retained `ReplayBuffer` removes quadratic string concatenation and trimming
from the PTY hot path while preserving FIFO replay and safe escape boundaries.
Together with explicit client-acceptance input-ready markers, the packaged lane
sustained 20.808 and 20.796 MiB/s in consecutive focused runs with 36.2 and
30.7 ms M7 input-to-paint p95. The final all-profile run reproduced both gates
at 20.823 MiB/s and 66.4 ms, with exact byte count, raw hash, geometry, model
hash, visibility, process ownership, and keep-awake checks. An animation-frame
drain candidate regressed throughput and was removed; the normal FIFO timer
path remains authoritative.

The server-side mode-tracker replacement also removes a redundant headless
xterm screen emulator from each live PTY. On the canonical roughly 137 KiB
feed, its focused microbenchmark improved from about 0.91 ms p50 / 3.12 ms p95
to 0.34 ms p50 / 0.56 ms p95 while preserving reconnect-owned modes, split
sequences, and resets.

## Experiment evidence as of 2026-08-10 (superseded)

- **Retained — history transaction:** five focused history-navigation p95 samples
  were 71.6, 63.6, 79.7, 79.7, and 71.2 ms. The history sample in the subsequent
  all-profile attempt was also valid at 63.2 ms, although that attempt was
  invalid overall because unrelated terminal and CPU samples were invalid.
- **Retained — generic coalescer correctness:** the correctness fix remains, but
  the local stream-ingress optimization is rejected. Its focused p95 sequence
  was 24/24/32 ms versus 32/24/24 ms for the restored control, so it did not
  establish a packaged improvement.
- **Rejected — reveal and startup:** the reveal candidate's median cold-open
  result was 184.5 ms versus 177.2 ms after restoration. Startup prefetch also
  regressed cold ready to 2,060 ms versus the restored 1,988.7 ms result.
- **Rejected — zero-visible terminal retention:** focused run 3 passed the exact
  terminal contract at 32.6 ms input-to-paint p95 and 20.82 MiB/s. The valid
  all-profile run nevertheless regressed M9 memory to 2,064.016 MiB versus the
  retained control's 1,912.281 MiB. The apparent 1,386.813 MiB result is not
  usable because that attempt was invalid and its terminal never connected.
  The valid all-profile run also recorded 4,688.34 ms cold ready, 151.4 ms cold
  open, 179.8 ms warm switch p95, 121.8 ms history p95, 24 ms stream p95, and
  4.0% quiescent CPU p95.
- **Pending, not claimed:** the environment-card and timeline-row candidates
  still require repeated acceptance evidence; their current diagnostic samples
  are not retained-win or qualification claims.

## Retained evidence as of 2026-08-10 (superseded)

The final retained packaged-workspace repetitions were:

| Artifact | Cold ready | Cold open | Warm switch p95 | History p95 |
|---|---:|---:|---:|---:|
| `retained-revert-workspace1` | 2,025.44 ms | 173.0 ms | 189.2 ms | 79.7 ms |
| `retained-revert-workspace2` | 2,029.63 ms | 174.1 ms | 180.6 ms | 71.7 ms |
| `retained-revert-workspace3` | 2,055.53 ms | 176.5 ms | 197.0 ms | 63.8 ms |

The latest broad authoritative attempt,
`claxedo-retained-authoritative-all-2`, produced individually valid cold-ready
(2,002.91 ms), cold-open (172.9 ms), warm-switch (189.7 ms), history
(62.8 ms), stream (24 ms), peak-RSS (1,974.984 MiB), and quiescent-CPU
(5.999%) samples. It was not a valid complete attempt because the terminal was
still waiting for `INPUT-00-A`. The focused
`claxedo-retained-authoritative-terminal` attempt then validly measured
34.7 ms input-to-paint and 20.812 MiB/s with the exact byte count and pinned raw
and serialized-model hashes.

The remaining candidates were rejected rather than retained:

- All environment-card variants failed acceptance: the two-RAF form improved
  cold-open to about 150 ms but history failed in 5 of 10 runs even with a
  five-second cache; the quiet form regressed cold-open to about 1,890 ms.
- File/Shiki startup work reduced the static bundle by 18.77%, but its cold-ready
  median was 2,042.1 ms versus the 1,988.7 ms control.
- The Markdown pending no-op alone measured stream p95 at 24/32/32 ms. Its only
  16 ms result required the rejected startup composite, so it is not retained.
- The async-adapter static-closure candidate measured M9 at 1,380.328 MiB versus
  1,363.05 MiB, despite reducing the server portion from 357.2 to 351 MiB, and
  was rejected. The exact zero-visible terminal-retention rejection above also
  remains unchanged.

The final blockers are cold ready, cold open, warm switch, stream interaction,
RSS, quiescent CPU in `claxedo-retained-authoritative-all-2`, and terminal
validity in a warmed all-profile attempt. U11 remains blocked; the 30-minute
lane and paired T3 comparison remain unstarted.

## Remaining blockers (2026-08-09, superseded — see v5)

- Fixed Electron/main/GPU/network infrastructure plus the local server already
  consumes roughly the entire 650 MiB budget before the warmed renderer sweep;
  the latest retained control remains far above the M9 gate.
- Warm switching still remounts and rehydrates rich `MessageTimeline` owners at
  `Workbench`'s content-ID keyed boundary instead of using a <=20 ms lease.
- The retained history transaction now has valid sub-100 ms evidence, but U11
  still needs a fresh, complete all-profile attempt with every metric valid.
- Cold ready remains above budget. Tagged initial/reconnect/heartbeat
  `server.connected` frames preserve reconnect recovery, but neither that work
  nor the rejected prefetch candidate closed the startup gap.
- Stream interaction p95 remains one frame-class over its 16.67 ms gate. The
  generic coalescer correctness fix remains, while the local ingress candidate
  was rejected because it did not improve over control.

## Qualification consequence

The 30-minute publication lane and paired T3 comparison remain intentionally
unstarted. They may begin only after a fresh packaged all-profile attempt has
valid samples for all ten metrics and passes every absolute gate.

## 2026-08-10 iteration

Date: 2026-08-10

**U11 remains blocked.** This iteration retained one packaged-validated change,
rejected seven candidates with packaged evidence, and closed two lines of
inquiry as evidence-backed non-candidates. No gate moved from fail to pass.

### Retained — bounded PTY disk-history compaction

`packages/workspace-runtime/src/pty/history-disk.ts` now compacts retained
transcripts against a hard UTF-8 on-disk cap using `safeTrimStartUtf8` from
`packages/workspace-runtime/src/pty/safe-slice.ts`, covered by
`packages/workspace-runtime/src/pty/history-cleanup.test.ts`.

Root cause: every 8 ms flush past the 16 MiB limit rewrote the whole retained
transcript, roughly 1,100 or more full compactions per 220 MiB benchmark
stream. That kept `claxedo-server` burning CPU into the quiescent window
(334.477% observed) and delayed PTY input echo, which intermittently
invalidated otherwise warmed terminal runs.

**v2 gate table** — packaged evidence, unchanged all-profile run `history-disk-isolated-all-1`
(after the bounded PTY disk-history compaction):

| Metric | Result | Gate | Status |
|---|---:|---:|---|
| Cold ready | 2,083.0 ms | <= 1,750 ms | fail |
| Cold open | 173.0 ms | <= 55 ms | fail |
| Warm switch p95 | 189.1 ms | <= 20 ms | fail |
| History navigation p95 | 72.2 ms | <= 100 ms | pass |
| Stream interaction p95 | 24.000 ms | <= 16.67 ms | fail |
| Stream blocked-frame ratio | 0% | <= 1% | pass |
| Terminal input-to-paint p95 | 29.700 ms | <= 100 ms | pass |
| Terminal output | 20.773 MiB/s | >= 20 MiB/s | pass |
| Peak process-family RSS | 1,904.859 MiB | <= 650 MiB | fail |
| Quiescent CPU p95 | 3.997% | <= 5% | pass |

The isolated terminal runs reproduced the terminal gates at 28.9 ms /
20.822 MiB/s and 35.6 ms / 20.801 MiB/s. The change is retained as a
correctness-preserving, CPU-stabilizing win, not as qualification progress.

### Rejected this iteration

- **Rejected — session-owner retarget prerequisite step 2 (`MessageTimeline`
  atomic state bucket):** history p95 was 146.5 ms all-profile and 130.5 ms
  focused, versus 63-80 ms for the retained control.
- **Rejected — session-owner step 1 (`SessionViewTarget`, reactive `PaneCtx`
  `paneId`, workspace-plus-pane hard mount):** history p95 measured 134.7,
  192.8, and 180.4 ms with no gate improvement.
- **Rejected — local inventory singleflight:** cold-ready median 2,060.5 ms
  versus the 2,029.6 ms baseline.
- **Rejected — terminal stream cached UTF-8 byte accounting:** terminal was
  valid at 34.9 ms input-to-paint and 20.816 MiB/s, but M9 RSS regressed to
  1,930.984 MiB versus 1,912.281 MiB.
- **Rejected — timeline warm-snapshot reveal with a 32-entry measurement LRU:**
  warm switch p95 213.9, 214.1, and 206.8 ms and history p95 126.0, 104.4, and
  130.5 ms, versus the retained 189-197 ms and 71-80 ms.
- **Rejected — standalone Bun-compiled local-server sidecar:** idle server
  memory looked attractive at roughly 196 MiB versus 357 MiB Electron-hosted,
  but the packaged app failed to start. The executable inside `app.asar` cannot
  be spawned (`ENOTDIR`); after shipping it as `extraResources`, the Bun process
  died with `panic(main thread): NAPI FATAL ERROR: Error::New
  napi_get_last_error_info` immediately after first workspace-store use, and the
  timeline never painted a canonical latest turn. Fully reverted.
- **Rejected — cold activation first-fold hydration (rail-owned early
  transport):** withdrawn on adversarial review. The early route is not
  equivalent to the canonical controller route, its dedupe is route-insensitive,
  and a natural A -> B -> A navigation is not generation-safe.

### Evidence-backed non-candidates

- **Stream interaction p95 is presentation-quantized.** On Electron 43.2.0 with
  Chrome 150 and a measured 120.00 Hz display, Event Timing rounds to 8 ms,
  handler processing is 0-0.2 ms, there are zero DOM mutations, and the
  blocked-frame ratio is 0%. No safe product-owned frame-rate or configuration
  change can force 3 of 3 samples to <= 16.67 ms without violating vsync,
  tearing, or CPU constraints.
- **Process-family RSS remains structurally far from 650 MiB.** The warmed
  renderer alone is roughly 640 MiB, so the M9 gate is not reachable by the
  remaining product-owned candidates.

### Qualification consequence for this iteration

U11 remains **blocked**. The 30-minute idle lane is **not started**, and no
paired T3 result may be published. Publication may begin only after a fresh
packaged all-profile attempt has valid samples for all ten metrics and passes
every absolute gate.

## 2026-08-10 — five slices packaged, validation blocked on AC power

Five independently revertable candidate slices are implemented, unit-green and
packaged into `packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app`. None is
accepted yet: the packaged benchmark refuses to run because
`agent-host-preflight.ts` requires `Now drawing from 'AC Power'` and this host is
on battery. That gate is a real validity requirement — battery clock throttling
would make any number incomparable to the retained baselines — so no result is
published and no slice is claimed as a win.

| Slice | Change | Owner gate | Pre-measured effect |
|---|---|---|---|
| Batched native Markdown parse | one renderer child process per *batch* instead of per top-level block | cold open | 37 corpus blocks 123.7-133.3 ms sequential vs **5.9-15.0 ms batched**, verified against the shipped binary; all 1,675 corpus sources byte-identical |
| Content-addressed highlight reuse | completed highlight results move from a per-instance map to one module-global 8 MiB LRU keyed by language + content | warm switch, cold open | warm revisit of an 80-code-block session: **80 highlight runs -> 0**, 66,516 chars -> 0 |
| In-flight highlight dedupe | a duplicate request joins the active one and promotes its queue priority instead of queueing a second worker job | cold open | first fold **24 worker jobs -> 12** |
| Stashed-slot `content-visibility: hidden` | stashed workbench slots stop being styled, laid out, painted and rastered | RSS | **-40.6 MiB** peak renderer RSS on a 20-session sweep (single run per arm) |
| `adoptNode` in `replaceSanitizedMarkup` | drops a full deep clone per markdown block | RSS, markdown commit | ~3-4 MiB, -15% commit path, half the DOM node churn |
| Shell-bootstrap warm + rail admission | `?scope=shell` starts at the URL authority instead of at provider mount; the rail's two nested `requestAnimationFrame` admission gate is removed | cold ready | ordering only, proven red->green; magnitude unmeasured |

Design notes worth keeping:

- The `DOMParser` full-document parse in `replaceSanitizedMarkup` is a **safety
  boundary, not an inefficiency**. Reading only `parsed.body` relies on the HTML
  insertion modes hoisting `<script>`, `<style>`, `<link>` and a leading
  `<template>` into `<head>`, where they are dropped. A reused inert document with
  fragment parsing keeps them, so the faster variant (-12 MiB) was rejected as a
  security regression and only the deep clone was removed.
- `markdownBlockKey` stays owner-scoped on purpose: it is transient worker-stream
  and DOM-node identity that `disposeStreamingCode` cancels on unmount. Making it
  content-addressed would let one unmount reject a live twin's in-flight
  highlight. Reuse is owned by a separate content-addressed cache.
- The highlight cache never stores an incomplete block or a failed highlight, so a
  streaming fence cannot poison it.

Attribution plan for the first valid run: cold ready belongs to the bootstrap
slice; any warm-switch or history regression points at `content-visibility`;
cold open is shared between the Markdown slices. Each slice reverts alone.

U11 remains **blocked**.

## 2026-08-11 — three retained changes, and a measurement discipline that had to be rebuilt

Three changes are RETAINED, all of them correctness-shaped rather than tuning-shaped, each
validated against a control build packaged in the same session.

### 1. Shell bootstrap invoked its injected fetch as a method (silent, every packaged boot)

`fetchShellBootstrap` called `input.request(...)`. That is a method call, so a native `fetch`
received a receiver that is not the global and threw BEFORE touching the network;
`.catch(() => undefined)` discarded the reason and `bootstrapInitialShell` fell back to the full
bootstrap. The compact `?scope=shell` fast path had never once executed in a packaged build,
while the unit suite stayed green because every test stub is an arrow function or
`Object.assign(async () => ...)` — and those ignore `this` entirely.

Evidence: `diag.shellBootstrap.headers` = `{ok: null, status: null}` (no Response at all), the
failure took 0.2 ms with NO resource-timing entry, and the single slow bootstrap in every dump
carried no query string. After the fix: `{ok: true, status: 200}`, `?scope=shell`, 1.9 ms, and
`diag.globalSync.ready` moved from 1405.1 ms to 346.2 ms.

The lesson is not "measure more", it is **never let a failure path discard its reason**. The
accompanying test asserts the RECEIVER (`expect(receivers).toEqual([undefined])`), because that is
the one assertion the suite could not have faked.

### 2. Reconnect offset repair ran on the outgoing, hidden session

`observeElementOffsetReconnectAware` armed a per-frame `scrollTop` poll on the surface being
switched AWAY from. The workbench `<For each={aliveForRender()}>` reorder makes the retained
hidden surface look like a route reconnect, so every warm switch polled a surface that presents
nothing, forcing a document-wide style recalc at the top of each frame of the incoming mount.
The repair is now held pending while the surface is not presented and runs on the presented
transition; the presented path is unchanged.

Measured against a same-session control: warm switch p95 196.9/197.6/196.7 -> 146.7/138.9/138.6,
cold open 195.0/191.2/186.4 -> 160.0/153.2/151.2, history unchanged.

### 3. Workspace-resolve single-flight, with restored error semantics

Five identical `/api/claxedo/workspace/resolve` requests collapse to two. The reader also restores
`readJson`'s throw-on-bad-status, which an earlier revision had silently replaced with an undefined
snapshot that had `.kind` read off it one line later; 404 still routes through `status`.

Measured against a same-session control: cold ready 2142.6/2140.0/2110.3 -> 1985.6/1939.3/1965.4.

### v3 gate table — after the three 2026-08-11 morning slices (superseded)

Artifacts: `AC-cpu-control-{1,2,3}`.

| Metric | Value | Budget | |
|---|---:|---:|---|
| `app.cold_ready_ms` | 1,936.97 | 1,750 | FAIL |
| `work_item.cold_open_ms` | 165.4 | 55 | FAIL |
| `work_item.warm_switch_p95_ms` | 138.9 | 20 | FAIL |
| `history.navigate_p95_ms` | 71.4 | 100 | PASS |
| `stream.interaction_p95_ms` | 32 | 16.67 | FAIL |
| `stream.blocked_frame_ratio_pct` | 0 | 1 | PASS |
| `terminal.input_to_paint_p95_ms` | 39.1 | 100 | PASS |
| `terminal.output_mib_s` | 20.362 | 20 | PASS |
| `resource.peak_process_family_rss_mib` | 1,933.1 | 650 | FAIL |
| `resource.quiescent_cpu_p95_pct` | 5.996 | 5 | FAIL |

Cold ready entered this session at ~2,087 ms and is now ~150-200 ms from its budget.

### Findings that reframed three gates

**A control is a BUILD, not a remembered number.** Four successive packages were compared against
numbers taken earlier while several agents edited the tree concurrently, and a candidate was
declared neutral because it was silently present in BOTH arms of its own A/B. File mtimes against
build times settled it. Every attribution in this section is against a control packaged in the
same session.

**Duration is not evidence of criticality.** `/provider` runs 1,277 ms and gates nothing;
`composerNotDisabled` flips at 503.5 ms. The readiness predicate is a conjunction and only its
LAST conjunct matters — here `timelineRoot` at 1,529.6 ms.

**The warmed stream gate does not measure streaming.** `measureSessionActivation` clicks
`[data-slot="navigation-row-activate"]`, focus never moves into the opened surface, nothing
preventDefaults ArrowDown, so the 40 probes drive the browser's default keyboard scroll of the
rail list — which only overflows once all 20 rows are revealed. The focused lane passes because
5 rows do not overflow. Focus transfer is now fixed (a real accessibility defect), which removes
that artifact; underneath it the first streaming replay's render work still exceeds a vsync.
Note also that `runControlledStreamScenario` PATCHes parts to their FINAL content, so only the
FIRST replay in a process mutates the DOM — any A/B on this metric needs one fresh process per
measurement or it measures a no-op.

**`stream.blocked_frame_ratio_pct` cannot corroborate the interaction metric.** LoAF only emits
above 50 ms, so a 24-32 ms interaction is invisible to it. "0% blocked" was never reassurance.

**Peak family RSS is largely allocation rate, not working set.** At the gate's operating point one
forced GC returns 438.6 MiB of private footprint and 256 MiB of RSS, and the live set is flat at
343 -> 380 -> 385 MiB across the whole run including the terminal. The earlier
"cc 184 / v8 104 / blink_gc 100, no owner above 100 MiB" attribution was taken at the
post-warm-switch operating point (283.7 MiB) while the gate samples during `resource-sweep`, after
the terminal moves the renderer +388.0 MiB. At the real point the ranking is v8 369.6 >
partition_alloc 220.6 > webgl 103.2. There is no leak: webgl returns to 0, pane count is 0, and
post-GC live footprint returns to within 5 MiB of the pre-terminal baseline.
The gate is also partly measuring the observer: `receipt.serialize()` builds a full-scrollback
string on every parsed write once an echo has matched.

### Open, with owners

- Embedded server request serialisation: 23 boot requests summing to 9,291 ms of duration inside an
  884 ms window, scaling 2.5x on a cold filesystem — consistent with file I/O under a lock rather
  than CPU. This is why removing three short requests was worth 170 ms.
- First streaming replay exceeds a vsync: 144 style recalcs / 58 layouts / 197 ms task time.
- `history.navigate_p95_ms` measured 204.4 then 97.3 on the same binary and sequence. A gate that
  passes on average and fails sometimes is not passing.
- Renderer leak across activations: ~340 net listeners per activation, ResizeObserver 1,987
  `observe` vs 273 `disconnect`, nodes 3,381 -> 43,481 while attached elements stay flat.

U11 remains **blocked**. The 30-minute idle lane is not started and no paired T3 result is published.

### Instrument findings — three gates measure something other than their name

Recorded because they change how every future result here must be read, and because two of
them can invalidate or silently pass a run for reasons unrelated to the code under test.

1. **`stream.interaction_p95_ms` (warmed lane) measured a rail-sidebar scroll.**
   `measureSessionActivation` clicks `[data-slot="navigation-row-activate"]`, focus never moved
   into the opened surface, and nothing preventDefaults ArrowDown — so the 40 probes drove the
   browser's default keyboard scroll of the nearest scrollable ancestor, the rail list, which
   overflows only once `revealSessionRows` has loaded all 20 rows. The focused lane passed because
   5 rows do not overflow. Focus transfer on activation is now fixed as an accessibility defect
   (activating a row left focus on the rail button); the gate did not move, because underneath it
   the first streaming replay's render work exceeds a vsync.
   Also: `runControlledStreamScenario` PATCHes parts to their FINAL content, so only the FIRST
   replay in a process mutates the DOM. Any A/B on this metric needs one fresh process per
   measurement or it measures an idempotent no-op.

2. **`history.navigate_p95_ms` scores a navigation that deterministically fails.**
   Navigating to the oldest message materialises 20 -> 217 rows and 2,862 -> ~34,400 px. Every
   `resizeItem` during that expansion can fire `anchorBottom()` -> `queueMicrotask(scrollToEnd)`
   from `createTimelineResizeAnchor().install()`. In 10 of 10 fresh-process traces (12/12 with a
   confirmation pair) the viewport ended at 33,688 px — the BOTTOM — with the target out of view.
   In 8 of those 10 the runaway landed AFTER `waitForStableScroll` stopped the clock, so the
   metric recorded a fast successful navigation for a navigation that visibly failed.
   `location.hash` was `""` in all 180 sampled frames, so the intended disarm through
   `updateHash` never engages in the packaged app.
   User-visible symptom: open a session, click a history anchor immediately, and the app yanks
   you back to the newest message. Fixing this is expected to make the metric WORSE, because the
   clock will then run until a navigation that actually stays on target settles. That trade is
   accepted in advance.

3. **`resource.peak_process_family_rss_mib` measures allocation rate and GC scheduling, not
   working set.** One forced GC at the peak returns 438.6 MiB of private footprint and 256 MiB of
   RSS while the live set stays flat at 343 -> 380 -> 385 MiB across the whole run. This was then
   tested rather than inferred: removing 93.2% of the string appends on the PTY write path
   (196.9M -> 13.3M, ~4.1 GiB of transient allocation avoided, verified by counting) moved peak
   RSS by -1 to -15 MiB, inside a control span of 1,909-2,031. The 650 MiB budget is not
   reachable from the allocation side.
   The gate is also partly measuring the harness observer: `receipt.serialize()` builds a
   full-scrollback string on every parsed write once an echo has matched.

Standing procedure that follows: run the forced-GC discriminator FIRST on any memory attribution;
if it returns hundreds of MiB while the live set is flat, predict the gate is unreachable from the
allocation side and say so BEFORE spending a slice. When landing a change anyway, state whether it
lands on gate merit or production-efficiency merit.

### Attribution rules adopted mid-effort, after a misattribution

A candidate was declared neutral and reverted because it was silently present in BOTH arms of its
own A/B; file mtimes against build times settled it, and restoring it against a real control showed
warm switch 196.9/197.6/196.7 -> 146.7/138.9/138.6 and cold open 195.0/191.2/186.4 ->
160.0/153.2/151.2. The rules now are:

- A control is a BUILD, not a remembered number. Package and measure the tree WITHOUT a candidate,
  in the same session, before attributing anything to it.
- Verify what is actually IN the build. Extract the packaged bundle and grep for the change.
- Once a trigger can be stated as a general condition, enumerate every metric whose path satisfies
  it before predicting zero anywhere.
- Instruments are not free and must be measured too: a 25 ms DOM-predicate sampler cost +65 ms on
  warm switch while being described as costless.
- When an architecture guard fires, ask what it knows about ownership that the design has not
  modelled yet. Three designs improved this way; none were waived.

### Corrections issued against this document's own claims

Recorded because each was volunteered by the agent whose work it weakened, and because a
qualification record that only accumulates confirmations is not a record.

- **"The mode-scan guards destabilised the warmed terminal lane" — WITHDRAWN.** Two of four warmed
  runs were invalid on a build containing that slice, and it was reverted on that basis. The agent
  then reported 9 of 9 valid trials on the same build with no load and 3 of 3 valid under
  deliberate 8-core contention — 12 attempts, zero reproductions — and disclosed that its own
  injected load coincided with the failed window. Four runs cannot separate the slice from host
  contention. The revert stands only on the ground that does not depend on the ambiguity: zero
  measured gate benefit means no reason to carry any risk from any source.

- **"The observer is winning an echo-matching race it is not guaranteed to win" — NARROWED.** What
  survives is structural: parsed batches reach 655,403-851,968 bytes and 1,181-1,248 batches per
  run exceed the observer's 64 KiB `parsedTail` window, so tail-based matching is blind to the
  leading portion of any large batch. What does NOT survive is echo-path exposure: in 6 of 6
  measurements the input echoes arrived in isolated 28-29 byte batches, 23-24 bytes from the end,
  with ~99.96% of the window to spare. The corroborating "nearest big batch was 7.6-20.4 s away"
  was an artifact of the probe capping its sample at 200 entries out of ~1,200. The warmed-terminal
  invalidation remains UNDIAGNOSED: it never reproduced, so the discriminator between "app failed
  to echo" and "observer missed an echo" was never run.

- **"~57 ms of per-request server tax" — WRONG BY ~16x.** Direct server-side instrumentation of the
  real composition under electron-as-node gives `reconcile_p50 = 0.133*N + 0.43 ms` (r = 0.9966),
  i.e. ~3.45 ms per proxied read at the corpus's 20 sessions, ~87% of it in the per-session
  `sync_session_meta` fan-out. ~57 ms was approximately the whole-boot total, not a per-request
  cost. `configure`/`apply` never runs on reads at all — `embeddedConfigModeForPath` returns "skip"
  for every GET/HEAD. Estimated boot impact ~59 ms of ~1,937 ms (~3%): real waste, not a
  gate-moving lever.
  The earlier "the server answers every route in ~1 ms" probe was measuring an empty database; at
  N=0 the tax is 0.136 ms, and the corpus was the entire discrepancy.

- **The 170 ms from workspace-resolve single-flight has no established mechanism.**
  `/api/claxedo/workspace/resolve` is `unclaimed` in `routeOwnership`, so it never reaches
  `ensureEmbeddedWorkspaceRuntime` and the server tax above cannot explain it. The win is measured
  and retained; the explanation is open.

### Retained on correctness merit, explicitly not counted as gate progress

- **Focus transfer on rail-row activation.** Activating a row left keyboard focus on the rail
  button, so arrow keys scrolled the sidebar instead of the surface the user just opened. Fixed via
  the existing `focusComposerWhenReady` helper, extended with an explicit `from` origin because its
  BODY-based "did the user move focus" proxy is wrong for any click-triggered caller.
- **History navigation no longer force-scrolls to the bottom.** `applyHash` read `location.hash` as
  the source of truth for "is a message targeted", but `updateHash`'s
  `navigate(..., { replace: true, scroll: false })` never produces an observable hash — measured
  `""` in all 180 sampled frames. So every authored navigation was immediately reinterpreted as
  "no target" and force-scrolled to the bottom. The authored navigation is now the hook's own
  session-scoped state. Gate-neutral across all four interactive metrics.
- **PTY query-suppression span slicing.** 196.9M -> 13.3M string appends on the terminal write
  path, proven byte-identical across 263,089,171 differential calls against a frozen oracle.
  Gate-neutral; retained because the waste is real for ordinary terminal output.

Open question B, logged: should `updateHash` produce an observable `location.hash` at all, and if
not, why does the effect read one? The answer decides whether the history fix is the permanent
design or a correct workaround around a deeper modelling error.

### History-navigation force-scroll: root-caused, fix attempted, REVERTED on a CPU regression

Sequence, because every step was decided by a measurement that overturned the previous model.

**The defect.** Clicking the oldest-message anchor left the viewport at 33,688 px — the BOTTOM of a
~34,400 px timeline — with the target out of view, in 10 of 10 fresh-process traces (12/12 with a
confirmation pair). `aria-current` agreed with the target throughout, so the app claimed to be on a
message it was not showing.

**Root cause, found by instrumenting the mutation rather than the predicate.** Replacing the live
scroller's `scrollTop` setter and `scrollTo` with stack-capturing wrappers named the caller
directly: `applyHash -> forceScrollToBottom -> scrollToBottom -> scrollToBottomNow`.
`Virtualizer.scrollToEnd` (the resize-anchor path) fired only afterwards, five times — the sustainer,
not the cause. A veto on the resize anchor, which was the obvious fix, would have suppressed the
echo and left the 33,300 px jump intact.

**Two defects underneath.** `useSessionHashScroll` is mounted once per mounted session and both
instances share one global router location, so the RETAINED HIDDEN session's instance reacted to a
hash it did not author and force-scrolled its own surface 0.2 ms before the active one — two
force-scrolls per navigation, the first from a surface the user cannot see. And the marker was
consumed on first hash match, ~65 ms before the router's hash reverted to `""`, after which the
effect fell through and force-scrolled.

**The fix worked and was still reverted.** Gating on presentation removed the hidden instance's
force-scroll (0 of 10 traces, with 20 logged `presented: false` passes) and keeping the marker alive
removed the active one — all force-scrolls gone in 10/10. But the navigation still landed 931 px
short (`finalTop` 1044 in 10/10), and quiescent CPU went 5.99 -> 9.982 / 17.968 / 7.994 / 22.978
against a 5% budget, confirmed against a control build measured in the same session at
5.994 / 5.989 / 6.000. A partial fix that costs a passing gate does not ship.

**Residual, open.** While the 217 rows materialise, `reconcileScroll` keeps correcting scrollTop and
`seek`'s scrollend re-assertions (bounded at 4) exhaust before the layout stops moving — timeline
still growing 33,492 -> 35,227 px at settle. Next steps, none yet instrumented: whether the retry
budget is too small or its attempts are being consumed by adjustments; whether re-assertion should
be driven by `afterLayoutSettles` (already in the file, unused on the scrollend path) rather than a
fixed count; whether the anchor should be pinned through growth via
`shouldAdjustScrollPositionOnItemSizeChange`.

**Second open defect, exposed not created.** With the marker never cleared, an idle app spins:
CPU 8-23% across the 60-second quiescent window, erratic rather than fixed, suggesting a feedback
loop that sometimes catches. That path exists in the shipped product today and is unreachable only
because the marker is always consumed — which means it blocks any correct fix, since consume-on-match
is itself the bug.

**Method note worth keeping.** Four models died at first measurement in this one investigation:
harness pacing, scenario ordering, the resize anchor, and `clearMessageHash` as cause (it fires
0.1 ms AFTER the force-scroll — a consequence). One founding measurement was also wrong:
`window.location.hash` was read from the page while the code reads the router's `useLocation().hash`,
a different object that does receive the value. Log what the code reads, not what is reachable from
outside.

### Also recorded

- Quiescent CPU has drifted from 3.996-4.995 earlier in the session to 5.99-6.00 on current control
  builds, and now fails its 5% budget independently of any candidate. Unattributed, open.
- A test that passes with its own fix reverted was found and DELETED rather than kept: driving the
  router hash externally was immediately re-authored by the hook, so the window the fix targets never
  opened. Green assertions that survive their own defect convert "untested" into "tested".

### 2026-08-11 later — a gate closed, and it was a server-side defect again

`resource.quiescent_cpu_p95_pct` now PASSES: 5.994 / 5.989 / 6.000 -> **5.000 / 4.998 / 4.996**
against a 5% budget, three `--profiles all` runs each against a control packaged in the same session.

The change: `reconcileSessionMetadata` no longer re-runs a full per-session metadata snapshot on
every proxied read. It is generation-gated, and invalidated by the closed set the code's own
contract implies — any mutation, the explicit `?harness=`/`?runner=` refresh that binds externally
created sessions into the store, and `session.created`/`updated`/`deleted` on the runtime's own
event stream. Both dispatch sites are covered, so in-process `sandboxFetch` callers invalidate on
the same rule as HTTP ones, and a snapshot in flight when an invalidation lands does not record
itself as current (generation captured at start, compared at completion).

Measured effect, all against the same-session control:
| Metric | Control | With change |
|---|---:|---:|
| cold ready (all) | 1,867.9-1,949.4 | 1,868.1 / 1,900.4 / 1,912.4 |
| cold open | 157.3 / 157.8 / 162.3 | 144.6 / 147.2 / 151.0 |
| quiescent CPU | 5.994 / 5.989 / 6.000 | **5.000 / 4.998 / 4.996 PASS** |
| warm, history, terminal, stream, RSS | — | flat |

The predicted effect was -35 to -55 ms cold ready (point estimate -45) and -10 to -25 cold open,
stated before measurement; realised -45 and -8. The CPU result was NOT predicted.

**What made this gate tractable was a measurement about the instrument, not the app.** CPU comes
from `ps -axo time=` at 10 ms resolution sampled every second, so each process contributes in
~1.0-point steps — which is why every archived value is a near-integer — and `percentile(...,95)`
over 60 samples selects index 56, the **4th-worst second**. So "6% sustained across an idle minute"
was never what was measured: the median second is 0.976% and 32 of 60 are under 1%. The gate is
decided by a handful of bursts, and passing needed one quantization step.

The idle profile, bucketed per second, found the two busiest renderer seconds are 96% and 67%
**garbage collector**, with TanStack Query's `persistQueryClientSave` / `dehydrateQuery` / `hashKey`
in the burst seconds. Removing a large recurring allocation and write path from every proxied read
is a plausible mechanism for the CPU step, recorded as a hypothesis rather than a finding.

**A lead that did not survive reading.** The "ResizeObserver leak" — 1,987 `observe` against 273
`disconnect`, cited in this document and in three briefings — is a category error. `observe` counts
targets and re-observations while `disconnect` counts observer instances, and
`@solid-primitives/resize-observer` re-observes by design on every refs change with per-target
`unobserve` in cleanup. Session DOM retention is also capped at exactly one hidden surface
(`SESSION_DOM_RETENTION_TIERS.warmHidden = 1`), so observers cannot accumulate across 40 activations.
Net live targets (observe minus unobserve) has never been measured; until it is, no observer leak is
established. The detached-node growth (3,381 -> 43,481 with attached flat) remains real and separate.

### v4 gate table — after the session-metadata reconcile generation gate (superseded)

Artifacts: `AC-reconcile-all-{1,2,3}`.

| Metric | Value | Budget | |
|---|---:|---:|---|
| `app.cold_ready_ms` | 1,868.1 | 1,750 | FAIL (-118 to go) |
| `work_item.cold_open_ms` | 147.2 | 55 | FAIL |
| `work_item.warm_switch_p95_ms` | 138.8 | 20 | FAIL |
| `history.navigate_p95_ms` | 71.2 | 100 | PASS |
| `stream.interaction_p95_ms` | 32 | 16.67 | FAIL |
| `stream.blocked_frame_ratio_pct` | 0 | 1 | PASS |
| `terminal.input_to_paint_p95_ms` | 29.4-37.1 | 100 | PASS |
| `terminal.output_mib_s` | 20.82-20.84 | 20 | PASS |
| `resource.peak_process_family_rss_mib` | 1,919-1,939 | 650 | FAIL |
| `resource.quiescent_cpu_p95_pct` | 4.996-5.000 | 5 | **PASS** |

Six of ten pass. Cold ready is the closest failing gate at ~118 ms over.

### Retained changes, in order of when they landed

1. Shell-bootstrap receiver bug (`globalSync.ready` 1,405 -> 346 ms)
2. Reconnect-repair presentation gate (warm -55 ms, cold open -33 ms)
3. Workspace-resolve single-flight with restored throw-on-bad-status (cold ready -170 ms)
4. PTY query-suppression span slicing (gate-neutral; 196.9M -> 13.3M string appends)
5. Session-metadata reconcile generation gate (cold ready -45 ms, cold open -8 ms, CPU gate closed)

Four of the five are correctness defects rather than tuning. U11 remains **blocked**: the 30-minute
idle lane is not started and no paired T3 result is published.

#### Correction to the entry above, issued by the change's own author

- **Cold open prediction MISSED.** Recorded above as "-8, inside the predicted -10 to -25". Median
  157.8 -> 149.05 = -8.75, which is below the band. A miss, not a hit.
- **The CPU prediction was WRONG, not conservative.** "Neutral, marginally lower" did not model the
  mechanism at all.
- **The CPU gate passes by exactly 0.000.** max(4.996, 4.998, 5.000) against a 5% budget. Combined
  with the quantization — `ps -axo time=` at 10 ms resolution, sampled every second, so ~1.0-point
  steps per process, and p95 over 60 samples selecting the 4th-worst second — the true improvement
  is "one fewer busy sample-slot", not "-0.994%". Any future change that reintroduces one recurring
  burst in the idle window returns it to ~6.0 and re-fails the gate. This gate is passing on a knife
  edge and should not be treated as comfortably green.
- The "17 runtime-owned requests per boot" figure remains a FLOOR, not a count; the dynamic count
  was never taken.

### The cold-ready wall is the embedded engine's first load, and pre-loading it does not help

Measured with a purpose-built headless server probe, because `launchPackagedClaxedo` drains the
server child's stdout to nowhere and this had therefore been invisible for five retained changes.

**Segmentation of the current 1,868 ms cold ready** (medians, n=7): process spawn -> renderer
timeOrigin 206.7; renderer boot -> `globalSync.ready` 319.1; ready -> readiness row 554.5; row ->
end 823.1. **The renderer is not the bottleneck — it is idle.** Zero long tasks across all seven
runs, and the 25 ms heartbeat's max interval is 36 ms during the very window where twelve requests
are outstanding. Spawn plus the harness's own readiness protocol is 338 ms of 1,868 (18%); nearly
all the rest is the renderer waiting on the server.

**The wall:** whichever request first needs the engine pays ~840 ms of ESM compilation and
initialisation of the 23 MB ignored node-embed artifact, ~500-550 ms of it blocking the
server's event loop. That artifact is produced by
`packages/opencode/script/build-node.ts`. Two independent instruments agree — V8 self-time
258.7 ms engine + 150.7 ms `compileSourceTextModule` (76% of the window), and a 5 ms lag sampler recording 550 ms of lateness
with single blocks of 310.5 / 121.2 / 64.2 ms. Three waves in one process (845 / 24 / 22 ms) prove it
is one-time initialisation, not per-request work. Pre-warming collapses the whole boot wave from
~845 ms to ~52 ms.
There is no special route: serially, `/api/claxedo/bootstrap` paid 803 ms, but the app's own trace
has bootstrap at 1.8 ms; re-running without it, `/provider` paid 815 ms instead. That is why twelve
unrelated requests — including `unclaimed` routes that never touch the runtime — all release together
at 822-860.

**Pre-loading at server start was implemented and measured as a WASH.** `/provider` did get faster
(1,072.5 -> 716.5 ms, ≈ the predicted engine saving) but `globalSync.ready` moved 371 ms LATER
(322.3 -> 693.3) and `sessionList` dispatch moved with it. The engine load now competes with the
compact shell bootstrap, which is what the whole renderer boot is gated on. Cold-ready medians:
1,867.2 control versus 1,888.1 treatment. The cost moved off `/provider`, which gates nothing, and
onto the one request that does.

**Latent defect found on the way, not fixed:** `StartLocalServerOptions` does not declare
`opencodeWorkerPath`, `start-local-server.ts` never calls `configureOpenCodeWorkerPath`, and the
option `claxedo-server-entry.ts:30` passes is silently dropped — a conditional spread evades
TypeScript's excess-property check. So the worker transport is dead code in the desktop and the
engine always loads in-process, while `main/index.ts:298` hard-throws if the worker artifact is
missing. The desktop validates an artifact it never uses. Verified by measurement: passing the path
changes nothing (795.0 vs 793.2 ms) and no child is ever forked.

### Query-persister coalescing: reverted, and the reason generalises

`persistQueryClientSave` runs `dehydrate()` immediately and unconditionally on every cache event —
measured at 16 full cache walks to perform one write in a burst — while the throttle sits downstream
and protects only IndexedDB. Coalescing at the source improved the CPU median two quantization steps
(5.0 -> ~3.0) and was still REVERTED: across seven runs the metric read
1.000 / 2.997 / 2.997 / 4.991 / 7.993 / 4.995 / **37.994**, against a control tight at
4.996 / 4.998 / 5.000.

The author traced the mechanism and it is worth carrying: dehydration used to run synchronously
inside each cache event, dribbled across the window; coalescing moved it into one contiguous
dehydrate+serialize+write at a deterministic 1 s boundary. Lower mean, higher and more deterministic
peak — **the wrong shape for a metric whose p95 is the 4th-worst second.** A self-sustaining re-arm
loop was excluded by direct probe (one event produced one dehydration and zero further saves across
ten idle windows).

**Rule adopted:** on this app's idle path, reducing total allocation does not reliably improve a
p95-of-per-second metric, because work SHAPE dominates work VOLUME. Any coalescing that concentrates
work at a fixed periodic boundary is a regression risk for this gate even when it is strictly less
work. The slice was green on unit tests, typecheck, the architecture ratchet, and a byte-identical
persisted-blob proof — and still made the gate worse. Correctness verification said nothing about
performance shape.

### Measurement rules added

- **Median-to-median, minimum three launches per side, validity-failed runs excluded, never
  best-to-best.** Cold ready shows a 2.84x run-to-run spread (1,753.2 to 4,984.7 on one build) and
  `totalSamples: 1` per run, so an effect smaller than that spread cannot be resolved by a single
  pair. One prediction in this document was scored a hit on a best-to-best comparison and had to be
  corrected to a miss.
- The 4,984.7 tail is unexplained and is a separate open question from anything measured here.

### Engine pre-load: closed, with a proof that no scheduling can work

The pre-load slice was reverted, and the reason is arithmetic rather than a judgement call. Taking the
control and treatment traces run-for-run:

  globalSync.ready       322.3 -> 693.3   +371.0
  sessionList dispatch   359.6 -> 730.5   +370.9
  sessionList DURATION   481.7 -> 118.6   -363.1
  /provider DURATION    1072.5 -> 716.5   -356.0
  sessionList RESPONSE   841.3 -> 849.1     +7.8    <- the cluster ends at the same moment either way
  cold ready            1867.2 -> 1888.1   +20.9    (medians, 3 launches per side)

The cost did not move off the critical path; it moved from after `globalSync.ready` to before it.
+371 ms paid, 363 ms recovered, net +21 — zero-sum to within 8 ms.

**And no other placement exists.** There is 663-698 ms of loop blocking to hide against a ~330 ms
quiet window between server-ready and the renderer's first request (`shellBootstrap.fetchStart` is
317.5). That leaves 333-368 ms which must land on a gating request, and from 317 ms onward the boot
window is continuously occupied — bootstrap 317.5, ready 319.6, sessionList 355.2, row visible 874.1,
session activation 898.1. There is no 670 ms hole. A short deferral only selects a different victim;
deferring past cold ready reinvents today's laziness. This approach is closed.

**The modelling error, recorded because it is different in kind from the others here.** The prediction
was made in units of REQUEST LATENCY — "the first engine-touching request pays 840 ms, so start it
earlier and that request gets cheaper". It did get cheaper, by almost exactly the predicted amount.
But `/provider` gates nothing. The gating requests never needed the engine at all; they were slow
only because the loop was OCCUPIED. Modelled as loop occupancy, moving the start time is zero-sum by
construction. The occupancy measurement existed (663-698 ms, same author's lag sampler) and was then
reasoned about in the wrong currency. Not a wrong measurement — a right measurement in the wrong
units.

**What remains, and it is the defect already found:** the only ways out are to get the compile off the
server's main thread or make it cheaper. The worker transport exists precisely to do the former and is
DEAD CODE — `opencodeWorkerPath` is silently dropped by a conditional spread, so
`configureOpenCodeWorkerPath` is never called in the desktop-local composition and the engine always
compiles in-process. That defect, filed earlier as tidy-up, is now the candidate lever on cold ready.
The decisive test is scoped and not yet run: call `configureOpenCodeWorkerPath` directly to bypass the
dropped option, re-run the concurrent boot wave with the lag sampler, and see whether the server's
loop stays quiet while a forked child compiles — or whether the child starves the parent anyway,
which would close this line entirely.

### `terminal.input_to_paint_p95_ms` — an instrument race that discards attempts (gate itself passes)

The warmed `--profiles all` lane invalidates the terminal metrics in roughly 3 runs of 7, always as
"Terminal benchmark failed while waiting for terminal input echo" naming `INPUT-00-A` or `INPUT-0-B`,
while focused `terminal-core-v1` on the identical build passes every time. The cause is in the
observer, not the app.

`agent-browser-observer.ts` `terminalWriteParsed` confirms an echo in TWO stages: it appends the
parsed batch to a 65,536-character `parsedTail` and returns early unless an echo is inside that
window; only then does it call `receipt.serialize()` and require `serialized.includes(echo)`.
`serialize()` renders the xterm SCREEN + SCROLLBACK, not the byte stream.

Quantified against the real workload (decoded from `terminal-00.json`) and the real app config:
- `features/terminal/core/config.ts:26` sets `scrollback: 5000` (the production value; tests use 1000).
- The M8 cycle is 131,072 bytes with 1,920 newlines, avg 68.3 bytes/line, repeated 1,680 times:
  210.0 MiB and **3,225,600 lines in 10,000 ms = 322,560 lines/s**.
- Therefore **the entire 5,000-line scrollback turns over every 15.5 ms**, and the 64 KiB
  `parsedTail` holds ~960 lines ≈ 3 ms of stream.
- Observed parsed batches reach 655-852 KB = ~9,600-12,500 lines, i.e. **2 to 2.5x the whole
  scrollback**. xterm applies an entire batch before `onWriteParsed` fires, so an echo positioned
  anywhere but the final ~5,000 lines of its own batch is already evicted at the single moment the
  observer looks.

This accounts for every property the evidence previously refused to explain: per-sentinel rather than
total failure, different sentinels failing on different runs, the 6-of-6 benign observations of
isolated 28-29 byte batches (small batches cannot evict their own echo — those are the passing runs),
and the warmed/focused split, since a busier main thread coalesces writes into larger batches and
batch size is the hidden variable that crosses the 5,000-line cliff.

**Batch size is unbounded from above.** Verified in the vendored `@xterm/xterm@6.1.0-beta.289`
`WriteBuffer._innerWrite`: `onWriteParsed` fires ONLY on the full-drain else-branch, and the 12 ms
budget yields WITHOUT firing. So a parsed batch is not "12 ms of stream" — it is everything that
arrived since the producer last paused long enough for the buffer to drain, which under a sustained
20 MiB/s producer has no upper bound. Eviction threshold, precisely: 5,000 lines x 68.3 bytes ≈
**341 KB**; observed batches run 1.9-2.5x that.

**xterm cannot distinguish "rendered then scrolled off" from "never rendered".** Evicted lines are
discarded with no tombstone; `baseY`/`length` saturate at the cap; `onLineFeed`/`onScroll` carry no
content; `registerMarker` needs a line that still exists; `onRender` reports viewport rows without
content attribution. By the time any observer callback runs the evidence is destroyed. That bounds
what is achievable from the observer side.

**The current check is not a paint proof either.** The order is: gate on the tail, `serialize()`,
`includes(echo)`, then `void afterPaint().then(...)`. The observer proves the echo is in the MODEL and
charges the NEXT PRESENTED FRAME as its paint time, without establishing the echo was in that frame.
Accepting parsed bytes would still be a weakening — model-inclusion down to stream-inclusion — so it
stays rejected, but this check is one step above that, not two, and should not be described as
stronger than it is.

**Three available fixes, all disqualified, two of them because they contaminate a different gate:**
raising `scrollback` changes product config to suit the harness AND alters terminal memory behaviour
that `resource.peak_process_family_rss_mib` measures; accepting parsed bytes is the weakening above;
making the app emit smaller batches changes the write path to suit the observer AND would be scored by
`terminal.output_mib_s`. A fix that launders itself through another metric is worse than an obvious
one, because it looks like a win somewhere else.

**Scope of the defect, stated precisely.** This does NOT make the gate unwinnable. Whenever the lane
is valid, `input_to_paint_p95_ms` reads 28.5-37.8 ms against a 100 ms budget and passes comfortably on
both lanes. The defect makes the ATTEMPT unreliable — roughly 3 warmed attempts in 7 are discarded by
an instrument race — so it costs runs, not qualification.

**Open design question for the plan owner, deliberately unimplemented.** At 322,560 lines/s the
overwhelming majority of lines are never presented in any frame, so "was this specific line painted"
is not merely unobservable but usually false. The property that is both measurable and meaningful is
responsiveness under load: that the echo reached the canonical model, and that the renderer kept
presenting frames at cadence across the input window. The observer already holds both halves
(`terminalWriteAccepted` for the acceptance boundary, `afterPaint()` for frame evidence). Composing
them would be a DIFFERENT metric wearing the same name, and redefining a gate mid-qualification is
exactly the move this effort exists to avoid — so it is recorded here as a decision for U11 rather
than made.

**Confirmation still owed:** a per-echo probe recording the first parsed batch containing each echo,
its byte length, and whether `serialize()` was called and contained the echo. Prediction, falsifiable:
failures occur if and only if the echo's own batch exceeds ~341 KB.

## How v5 was reached (v1 -> v5)

This section explains the CURRENT RESULTS (v5) at the top of this document.
Version history: v1 entry baseline -> v2 PTY disk-history compaction -> v3 three
morning slices -> v4 reconcile generation gate -> v5 current control.

Baseline is `artifacts/agent-app-benchmark/claxedo-final-sustained-terminal`, the packaged attempt
recorded at the top of this document. "Now" is the control build `AC-postrevert-all-{1..4}`, the same
harness invocation, after the retained slices below.

| Metric | Baseline | Now | Gate | Status |
|---|---:|---:|---:|---|
| Cold ready | 2,060.1 ms | 1,753.2-1,975.3 (med 1,875) | <= 1,750 | fail, ~125 ms short |
| Cold open | 178.9 ms | 153.3-169.6 | <= 55 | fail |
| Warm switch p95 | 181.0 ms | 138.8-139.1 | <= 20 | fail |
| History navigate p95 | invalid | 70.6-80.4 | <= 100 | **pass** (was invalid) |
| Stream interaction p95 | 24.0 ms | 32.0 ms | <= 16.67 | fail (warmed lane; see instrument findings) |
| Blocked-frame ratio | 0% | 0% | <= 1% | pass |
| Terminal input-to-paint p95 | 66.4 ms | 28.5-35.5 | <= 100 | pass when valid |
| Terminal output | — | 19.15-20.85 MiB/s | >= 20 | pass |
| Peak family RSS | — | 1,735.6-1,939.0 MiB | <= 650 | fail, ~3x |
| Quiescent CPU p95 | 334.5% | 1.998-4.995 | <= 5 | **pass** (was 67x over) |

Two gates were closed outright: quiescent CPU (334.5% -> ~3%, via bounded PTY disk-history compaction
and the session-metadata reconcile generation gate) and history navigation (invalid -> valid and
passing). Cold ready, cold open and warm switch each improved materially without reaching budget. RSS
is untouched by anything attempted and is the one gate with no credible route identified.

### Retained slices, all packaged-measured

1. Bounded PTY disk-history compaction with a hard UTF-8 on-disk cap — every 8 ms flush past 16 MiB
   had rewritten the whole transcript.
2. Shell-bootstrap receiver fix — `fetchShellBootstrap` invoked its injected fetch as a METHOD, so
   native `fetch` threw pre-network and `.catch(() => undefined)` swallowed it; every packaged boot
   silently paid the full-bootstrap fallback. `globalSync.ready` 1,405 -> 346 ms.
3. Reconnect-repair presentation gate — a per-frame `scrollTop` poll armed on the OUTGOING hidden
   session every switch.
4. Workspace-resolve single-flight v2, with `readJson` throw-on-bad-status preserved.
5. PTY query-suppression span slicing — 196.9M -> 13.3M string appends, proven byte-identical across
   263,089,171 differential calls against a frozen oracle. Gate-neutral, retained on merit.
6. Session-metadata reconcile generation gate — closed the quiescent-CPU gate.

### Reverted after packaged measurement

Session-owner retarget (2 steps), local inventory single-flight, terminal-stream byte cache, timeline
warm-snapshot reveal, cold-activation first-fold hydration, Bun server sidecar (NAPI panic), markdown
batch parse, cross-mount highlight reuse, `content-visibility: hidden`, `adoptNode`, shell-bootstrap
warm + rail gate, mode-scan guards, history hash-scroll fix (CPU regression), Markdown pending-resource
no-op, query-persister coalescing (variance), engine pre-load (zero-sum, proven).

### Where the evidence lives

- This document is the single narrative record: findings, retained and reverted slices, instrument
  defects, corrections issued against its own earlier claims, and the rules adopted mid-effort.
- `artifacts/agent-app-benchmark/<run-name>/` holds the immutable per-run evidence — `summary.json`,
  the diagnostics dumps, terminal workloads and hashes. Control runs are named for what they control
  (`AC-cpu-control-*`, `AC-postrevert-all-*`), candidate runs for their slice (`AC-reconcile-*`,
  `AC-persister-*`, `AC-enginepreload-*`), so any claim here can be re-derived from the artifact it
  came from.
- Reverted work leaves no code behind by design, so this document is the ONLY record of why each
  candidate died. That is deliberate: the negative results are the expensive part.

### RSS is unreachable by application optimisation — a structural finding

Decoded from `attempt.json` `processOwnership.snapshots` of the v5 control run
(`AC-postrevert-all-3`), 18 snapshots across the resource lane.

Peak family 1,941.1 MiB decomposes as:

| Process | Peak MiB | Share |
|---|---:|---:|
| renderer | 1,167.7 | 60% |
| server child (`out/main/claxedo-server/index.js`) | 374.6 | 19% |
| Electron main | 217.1 | 11% |
| GPU | 130.5 | 7% |
| utility | 51.2 | 3% |

**The non-renderer total never falls below 736.1 MiB in any snapshot, and starts
at 740.9 MiB in the very first one — before any session work.** The budget is
650 MiB. So even with a renderer of ZERO BYTES the gate fails by ~86 MiB, and it
already fails at process start.

Breaking the floor down further at the first snapshot: server child 381.5,
Electron main 201.5, GPU 107.9, utility 50.0. Electron's own three processes are
359.5 MiB before Claxedo has done anything at all.

Consequences, stated plainly:
- No renderer-side memory work can pass this gate. Every candidate attempted so
  far attacked renderer allocation, which is the 60% that CAN move but cannot be
  moved far enough to matter against a floor that is already over budget.
- This also explains the earlier forced-GC result, where removing 93% of a
  measured allocation moved peak RSS by only -1 to -15 MiB: the metric is
  dominated by process-count and per-process baselines, not by application
  allocation.
- The routes that could move the floor are structural, not optimisation: fewer
  processes in the family, an engine that exits when idle (the worker transport,
  currently dead code — see the worker-path defect), or a revised budget that
  accounts for Electron's own baseline.

This is a PLAN-LEVEL finding, not a code defect. `resource.peak_process_family_rss_mib
<= 650 MiB` cannot be satisfied by the application as architected, and no amount
of further slicing will change that. It is recorded here rather than acted on,
because changing the budget is the plan owner's decision and changing the process
architecture is not a performance slice.

### Warm switch measures a cold mount 19 times out of 20, and shares an instrument with cold open

Source segmentation, phase 1. Verified independently rather than accepted secondhand.

**The retained set is one.** `rail-workbench-canvas.tsx:15` declares
`SESSION_DOM_RETENTION_TIERS = { active: "all-visible", warmHidden: 1, cold: "unmounted" }`, passed as
`maxRetainedMountedContents` at :64 with `mountPolicy="visible-once"` and `mountCapCandidate`
restricted to `type === "session"`. The comment states the intent: older sessions "restore from their
canonical state instead of staying live behind CSS".

**The benchmark switches among twenty.** `measureWarmSwitches` asserts exactly 20 targets and drives a
seeded shuffle via `warmSwitchPlan(targets, seed)`. With a retained set of one, at most the MRU hidden
session can be a reveal — so **19 of 20 measured switches are full mounts**: timeline construction,
virtualizer measurement, and first-fold markdown render. "Warm switch" is measuring cold mount.

**The acceptance predicate has its own floor.** `measureSessionActivation` arms the clock on a trusted
pointerdown, clicks, then awaits `root.waitFor({state:"visible"})` — which in `agent-cdp-page.ts` is a
CDP `Runtime.evaluate` round trip polled at **16 ms granularity**, each poll itself calling
`getBoundingClientRect` and `getComputedStyle` — then a second `page.evaluate`, then a rAF loop that
accepts only on **two consecutive identical signatures**, where each frame samples `innerText`,
`getBoundingClientRect` and an FNV hash per visible row. All of it inside the measured window. A
20 ms budget is ~2.4 frames at 120 Hz; the poll granularity alone is 16.

**The same instrument measures cold open.** `measureSessionActivation` is called from
`agent-claxedo-driver.ts:243` (cold open, budget 55 ms), `agent-browser-observer.ts:456/467` (warm
switch, budget 20 ms) and `agent-stream-scenario.ts:48`. So one instrument sits inside the measured
window of two of the four failing gates.

**Not yet a conclusion.** The instrument floor is estimated at 17-25 ms and has NOT been measured. It
is being measured — click dispatched -> `waitFor` resolved -> `evaluate` returned -> frame 1 ->
frame 2 -> accept, with `sample()` self-timed, for both warm switch and cold open, plus a
reveal-vs-mount boolean per switch that confirms or destroys the 19-of-20 claim outright. "The budget
is unachievable" is far too convenient to believe before it is measured.

**An architectural conflict between two gates in the same plan.** A 20 ms switch implies the incoming
surface is already rendered, i.e. a reveal. Making 19 of 20 switches reveals means retaining ~20 live
session surfaces in the renderer — the process already at 1,167.7 MiB inside a family that fails a
650 MiB budget. Retaining more trades `work_item.warm_switch_p95_ms` against
`resource.peak_process_family_rss_mib`. This is published as a conflict, not resolved: a 32-entry
snapshot-and-reveal LRU was already tried and made warm switch AND history worse, and simply raising
`warmHidden` is a different intervention with a direct memory cost.

### Boot gating reviewed as a UX problem — and a correction to this document's own claim

**CORRECTION: `/provider` does not "gate nothing". It gates SEND.** This document previously used
`/provider`'s 1,277 ms duration as the example of a loud request on nobody's critical path. That was
wrong. `submit-block-reason.ts` is a priority-ordered vocabulary for why Send is blocked and includes
`providerLoading -> "models-loading"` and `booting -> "Starting up…"`, while `composer/ui/frame.tsx:294`
sets `contenteditable="true"` UNCONDITIONALLY with the design note at :292 — "keep the editor editable
while the harness polls — gate the submit, not the typing. A dead-looking box teaches nothing."
So the provider catalog is on the critical path to the first message being SENT, just not to the UI
being usable. The product already implements the interactivity model, at the composer.

**The gates.** `GlobalSyncProvider` (`provider.tsx:781-787`) is a HARD gate — the entire app subtree
does not exist until `ready`. On loopback (desktop) `ready` needs only `{path, project}` from the
shell bootstrap, measured at 319.6 ms. On NON-loopback, `bootstrapGlobal` awaits `Promise.allSettled`
over five tasks including provider and provider_auth, so the heavy conjunction is the CLOUD path.
`WorkspaceGate` (`workspace-gate.tsx:175`) is a pass-through on desktop. After `ready`, the session
route chain owns ~1,350 of the 1,868 ms.

**Branches statically false on desktop** — the "heavily toggled" complaint made concrete:
`shouldUseSignedRouteBootstrap` returns false for loopback (`bootstrap-orchestrator.ts:152-160`);
`shouldUseSignedControlPlaneInventory` returns false without signed access (`inventory-source.ts:705`);
the signed/workspace-grouped fetches and `access=cloud` / `access=user-hosted` queries behind them.

**Named defects, with cost from `AC-reconcile-all-1`:**

| # | Defect | Measured |
|---|---|---|
| D1 | `/provider` fetched THREE times per cold boot (unqualified, `?harness=pi`, `?harness=opencode`) | 1,079.5 + 432.4 + 568.6 ms |
| D2 | `agentListQuery` duplicated by an inconsistent cache key — `directory-scope.tsx:94` passes `harnessType`, `message-timeline.tsx:455` does not | two requests 0.1 ms apart, 161.1 + 350.2 ms |
| D3 | permission modes on `createResource` instead of the shared query cache, refetched as inputs settle | 433.7 + 384.3 + 192.1 ms |
| D4 | `/api/workspace` fetched for both `access=cloud` and `access=user-hosted` on a product with neither | 7.9 + 333.3 ms |
| D5 | contention multiplier: the server is single-threaded with 663-698 ms of boot occupancy, so a request that gates nothing still delays every request that does | — |

D5 is why the others matter more than they look: on this architecture "harmless background fetch" is
not a category.

**Interactivity tiers proposed.** Tier 1 SEE AND CLICK needs `path` + `project` only (~320 ms today,
already achieved — nothing new may join that conjunction). Tier 2 TYPE needs session identity only.
Tier 3 SEND needs one submittable model, and that is where `/provider` belongs — fetched once for the
harness the composer targets. Ordering principle adopted: **nothing needed only for COMPLETENESS may
share a conjunction with something needed for INTERACTIVITY.**

**Measurement point, kept separate.** The harness readiness predicate
(`agent-browser-observer.ts:170-182`) is a conjunction requiring expected message id, matching content
sha, `textLength > 0`, `composerVisibleAndEnabled`, `surfaceFocused` and `completeFirstFold` — a
defensible session-content readiness definition that already includes composer usability. But it
measures Tier 3-and-beyond while the product targets Tier 2, so a real "time to type" moment exists
that nothing measures. RECOMMENDATION: ADD a metric beside cold ready; do NOT redefine cold ready
mid-qualification. Recorded as a publication decision for the plan owner.

### Worker transport wired live and MEASURED: regresses three gates — and idle-exit cannot help a PEAK metric

The silently-dropped `opencodeWorkerPath` was repaired and packaged. Six `--profiles all` runs against
the v5 control, medians:

| Metric | v5 control | worker wired | delta |
|---|---:|---:|---:|
| cold ready | 1,875 ms | 2,004 ms | **+129** |
| peak family RSS | ~1,930 MiB | 2,060 MiB | **+130** |
| quiescent CPU | 2.0-5.0 (pass) | 3.0/4.0/4.0/6.0/6.0/4.0 | **2 of 6 FAIL** |

Warm switch, cold open, history, stream and terminal were unchanged.

**The transport was genuinely live**, verified from `processOwnership` rather than assumed: SIX
processes instead of five, and the engine moved exactly as designed — the server child fell
374.6 -> ~190 MiB. But the forked worker costs 310 MiB, so splitting one process into two cost
+125 MiB net. The engine's marginal cost in-process was ~184 MiB; as its own process it pays a full
Node baseline on top of that.

**The idle-exit never fires.** All 18 process-ownership snapshots of a run show the worker ALIVE,
including through the quiescent window. The second process's baseline was paid for the entire run and
the benefit was never collected.

**The structural finding, which invalidates the thesis that put this at the front of the queue:**
`resource.peak_process_family_rss_mib` is a PEAK, so a process that exits after the peak does not
reduce the peak. **Idle-exit cannot improve this metric even in principle** — moving memory into a
process that idle-exits can only ADD baseline to it. The lifecycle work may still be right for the
product; it is invisible to this gate by construction. This is the strongest argument yet for an
idle-measured metric (`resource.idle_foreign_process_rss_mib`) alongside the peak, and it was reached
by measurement rather than by wanting a different number.

Disposition: the wiring is removed from the desktop composition, along with `main/index.ts`'s
hard-throw validating an artifact the desktop will not use. The type declaration on
`StartLocalServerOptions` and a test asserting the desktop does not silently pass a worker path are
KEPT, so the original conditional-spread evasion cannot recur invisibly. The worker transport itself
stays — it is complete, tested, and correct for self-hosted, which legitimately uses it.

### Harness process lifecycle: no work to fund

Traced rather than assumed. Harnesses are shared per WORKSPACE, not per session:
`embedded-workspace-runtime.ts:54` keys hosts by workspace id, `runtime.ts:144` keys adapters
`id:access`, codex holds one app-server per workspace runtime, and ACP keys processes by a config
fingerprint. Ten sessions in one workspace on one model share one process.

Idle reaping is already complete for every process that is both resident between turns and ours to
stop: engine worker (10 s, status-probed, fail-closed), codex app-server (30 s + per-turn lease), ACP
(`createIdleReaper`), opencode (`createProcessLifecycle`, 30 s). The apparent gaps dissolve on
tracing: claude native spawns per TURN, cursor native is remote with no local process, pi is
in-process, and MCP servers are spawned by the harness CLI and registered
`capabilities.ownerActions: false` — observed, not owned, and they die with their harness.

Two real findings survive. Archiving does NOT release a harness (only `deleteSession` refcounts), and
the eager-dispose branch is effectively dead because `listSessionsByOwnerKey` does not filter archived
sessions, so `persistedSiblings` stays non-empty forever once a key has archive history — the idle
timer does all the reclaim. And the ACP process fingerprint includes `model`, `env` and `mcp`, so
switching model inside a workspace spawns a SECOND process rather than reconfiguring the first.

### Warm switch and cold open segmented — measured, with four author retractions

Instrumented run, 20 warm switches plus a cold open, against the packaged build. Raw per-activation
data in `/tmp/claxedo-switchseg/segments.json`.

**Reveal versus mount: 0 of 20 reveals, 20 of 20 fresh mounts.** Not one measured "warm switch" is a
reveal. The retained set is one hidden session (`SESSION_DOM_RETENTION_TIERS.warmHidden = 1`) and the
seeded shuffle essentially never re-picks it, so the retention tier and the scenario's working set do
not overlap at all. The earlier claim of 19 of 20 was too generous.

**The instrument floor is measured, not estimated:**

| | metric | clickTail | waitFor(visible) | evalRoundTrip | stablePaint | frames | floor |
|---|---:|---:|---:|---:|---:|---:|---:|
| warm switch (median of 20) | 121.0 | 57.9 | 22.9 | 7.2 | 27.6 | 4 | **30.6** |
| cold open (n=1) | 145.5 | 21.1 | 5.9 | 7.7 | 110.8 | 12 | **14.9** |

Two corrections to earlier claims in this document. The floor was estimated at 17-25 ms; it is 30.6 ms
warm — **larger than the entire 20 ms budget**. And the floor is almost entirely CDP round trips (a
16 ms-granularity poll plus an `evaluate`); the per-frame predicate work I suspected —
`innerText`, rect reads, FNV hashing — totals **0.60 ms across all frames** and is negligible.

**The two gates fail for opposite reasons.** Warm switch is ~25% instrument. Cold open is 76%
stable-paint loop — twelve frames of an app still changing, with a floor of only 14.9 ms. So "one
instrument defect appearing as three gate failures" is dead: cold open is genuinely the app.

**The lazy composer candidate is dead.** Composer lag median 0.0 ms after first row paint; the
placeholder is present for 0 frames on warm switches and 1 frame on cold open, where the composer was
editable BEFORE the first row painted. Raised, promoted to first-class, and disposed of by measurement
in the same run.

**Warm switch does not pay for the history expansion.** At accept: rowCount median 20, scrollHeight
2,726, rendered rows 12. The 20 -> 217 row and ~35,000 px expansion is purely a history-lane cost.

**The real lever — a remount discards work already computed.** From the app's own gated phases, every
switch pays a worker round trip to re-highlight the SAME three code blocks: 57.6 ms (diff, 20/20),
53.8 ms (typescript, 20/20), 52.3 ms (typescript, 16/20). `markdown.tsx:650-652` scopes the
completed-code cache to the component instance (`createUniqueId()`, `markdownBlockKey(owner, ...)`),
so a remount destroys it — and finding 1 guarantees a remount on every measured switch. Two design
choices compose into repeated work.

CAVEAT that must travel with those numbers: `markdown.tsx:725-727` brackets `await code(...)`, a
worker round trip, and the blocks run concurrently under `Promise.all`. They are WALL-CLOCK LATENCY
ACROSS AN AWAIT, not main-thread CPU, and must not be summed — per-activation phase sums (133-215 ms)
exceed the metric itself.

### v7 RETAINED — rail clock scoping: the first movement on warm switch, and quiescent CPU becomes deterministic

`rail-sidebar.tsx:505` armed `setInterval(() => setClock(Date.now()), 10000)` and `sessionDisplayRow()`
read `clock()` unconditionally as its first statement, so every 10 s every session row was invalidated
and six derived fields recomputed so that ONE — `timeLabel` — could possibly change. For any session
older than a day the label is stable and nothing changes at all. The fix moves the `clock()` read into
a lazy `get timeLabel()` accessor so a tick re-runs only the label binding; the row object and rows
array stay referentially stable.

Six `--profiles all` runs against the v6 control:

| Metric | v6 control | v7 rail clock | delta |
|---|---|---|---:|
| warm switch p95 | 138.5 / 138.4 / 139.2 | 118.8 130.5 130.2 137.7 123.6 126.7 | **median 138.5 -> 128.5, -10.0** |
| cold open | 151.1 / 147.5 / 151.4 | 136.6-150.6 | **median ~151 -> 141.3, -9.7** |
| quiescent CPU | 5.994 / 4.993 / 2.996 | 2.999 2.999 2.999 2.998 2.997 2.998 | **-2.0, and the variance collapsed** |

cold ready, history, stream, RSS and terminal unchanged.

Warm switch had been pinned at 138-139 across dozens of runs all session; that stability is what makes
a 10 ms move credible. The CPU result is the more striking one: six runs inside 0.002 of each other
against a control ranging 2.996-5.994. The gate now passes with real margin instead of the 0.000 it
had.

**The author predicted "negligible" and was wrong in the conservative direction.** The shape-versus-
volume argument held exactly as written: the tick fires at the same instants, strictly less work
happens at those instants, nothing is relocated to a boundary — and unlike the persister slice there
is no tail blowup.

**Hypothesis for the switch movement, under confirmation:** a switch is accepted only when two
consecutive frames produce an identical signature, so a rail invalidating seven rows on a 10 s tick
gave any overlapping measurement window a competing render. The predicate needs a QUIET frame, not a
fast one. If that is the mechanism, this is a frame-stability fix rather than a render-cost fix, and
anything else invalidating on a timer during a measured window is a candidate of the same class.

Rejected during design and worth recording: deriving the tick cadence from the coarsest displayed
granularity. The rail's local `relativeTime` has a PER-SECOND band under 60 s, so a "correct" adaptive
cadence would drop to 1 s whenever any visible session is under a minute old — ten times more frequent
than today in the common case.

### Markdown completed-code cache: implemented, packaged, measured NEUTRAL, reverted

The per-component-instance completed-code cache (`markdown.tsx:650-652`, keyed through
`createUniqueId()`) was hoisted into `markdown-cache.tsx` as a bounded 8 MiB content-addressed cache
that survives remounts, with 11 tests and a proven red-green ablation.

Packaged on top of the retained rail-clock build. All 120 individual switch durations per arm, pulled
from `attempt.json` rather than comparing p95s:

| percentile | rail-only | + md cache | delta |
|---|---:|---:|---:|
| p0 | 77.8 | 79.4 | +1.6 |
| p10 | 87.7 | 88.4 | +0.7 |
| p25 | 96.4 | 101.6 | +5.2 |
| p50 | 110.2 | 110.3 | +0.1 |
| p75 | 114.3 | 115.7 | +1.4 |
| p90 | 127.2 | 123.6 | -3.5 |
| p95 | 130.4 | 130.6 | +0.2 |
| p100 | 142.9 | 138.8 | -4.1 |

No consistent direction anywhere in the distribution. Quiescent CPU went the wrong way — the
rail-only build was pinned at 3.0 across six runs; this one read 5.0 / 3.2 / 4.0 / 4.0 / 3.0 / 4.0.

**Why, and it was predicted in the slice's own caveat:** `markdown.tsx:725-727` brackets
`await code(...)`, a worker round trip, and the blocks run concurrently under `Promise.all`. The
52-58 ms `markdown.highlight.*` phases are WALL-CLOCK ACROSS AN AWAIT, not main-thread CPU. Three
concurrent round trips that overlap are not three serial costs, and removing them does not shorten a
critical path the main thread was never blocked on.

Reverted, and deliberately NOT retained on production-efficiency merit: it degraded the CPU
determinism the rail slice had just won.

**The finding survives even though the fix does not:** 20 of 20 warm switches re-highlight the same
three code blocks, because the completed-code cache is scoped per component instance and the retention
tier guarantees a remount every time. Real, wasteful, and invisible to every gate in this plan.

### Terminal echo eviction hypothesis: REFUTED by measurement

Four instrumented runs on the retained v7 build (1 focused, 3 warmed), per-echo and whole-scenario
batch capture. The prediction was stated falsifiably in advance — eviction failures if and only if the
echo's own batch exceeds ~341 KB — and it is wrong.

**The echo never lands in a large batch.** In all four runs both echoes arrived in isolated batches of
28-29 bytes, at offset 5, with 6 bytes to the end of the batch, `serializeCalled: true` and
`serializeHadEcho: true` every time. With the earlier 6-of-6 observation that is **14 of 14 observed
arrivals four orders of magnitude under the threshold**. A batch cannot evict its own echo if the echo
is never inside a large one.

**The warmed lane does not produce larger batches**, which was the mechanism underneath the whole
story:

| arm | n | p50 | p90 | p99 | max | >341 KB |
|---|---:|---:|---:|---:|---:|---:|
| focused | 1060 | 248,214 | 439,924 | 552,932 | 1,029,180 | 307 |
| warm-0 | 972 | 163,458 | 550,914 | 667,958 | 861,686 | 346 |
| warm-1 | 1084 | 127,134 | 526,698 | 662,913 | 826,371 | 338 |
| warm-2 | 1034 | 145,296 | 523,671 | 682,084 | 848,569 | 339 |

The warmed median is SMALLER (127-163 KB versus 248 KB) and its maximum is smaller. Only the count
over 341 KB is marginally higher.

**What survives:** the scrollback arithmetic is confirmed — `serializedLength` is 339,714-339,716
bytes in every run, exactly 5,000 lines at ~68 bytes — and the observer's two-stage predicate (byte
gate, then rendered-buffer authority) remains a real structural fragility. It is simply not what is
causing these invalidations.

**Instrument self-audit, recorded because it bounds the negative result:** the probe ran two `indexOf`
scans over ~217 MB of parsed text per run, on the same main thread whose timing produces the race. So
0 failures in 3 warmed runs (against an observed ~3-in-7 rate, where 0-of-3 has ~19% probability)
cannot be read as evidence about the failure rate. The instrument is a candidate contributor to its
own null result.

Remaining hypotheses, ranked, all requiring a FAILING sample to separate: remount / instanceId
mismatch (the only one with direct positive evidence — an archived failure with
`foreignAcceptedCount: 3`, `foreignParsedCount: 3`, mismatched `visibleInstanceId`, and
`inputCount 2 of 2`, i.e. both echoes seen and it still failed at the COMPLETION sentinel, which is a
different signature from the `INPUT-*` echo timeouts); the echo genuinely never arriving; and delay
past the stage timeout.

### The terminal echo invalidation is SOLVED: the observer's 64 KiB gate discards a real echo

Reproduced, fully instrumented, and confirmed as an OBSERVER defect. The app is not at fault.

**The confound that hid it for 23 controlled trials.** Two sibling agents ran 12 and 11 warmed
attempts respectively and never reproduced the failure. The real runner applies load the direct-drive
reproductions did not: `agent-app-benchmark.ts:165` issues a CDP `Runtime.evaluate` every second for
the whole scenario, and `:252` spawns `readProcessTable()` every second. Adding both reproduced a
failure on the FIRST attempt, with timers verified as having FIRED (67/67 for both, zero errors) rather
than merely armed.

**The failing sample:**

    seen: true                  <- the app DID echo
    batchBytes: 331,990         <- inside a 332 KB batch, not the 28-29 bytes of every passing run
    offsetInBatch: 5
    bytesFromEnd: 331,967       <- must be < 65,536 to survive parsedTail.slice(-65_536)
    serializeCalled: FALSE      <- the authoritative check NEVER RAN
    11 trusted keydowns, activeElement = xterm-helper-textarea for every one

So the keystroke reached the renderer, focus was never stolen, the app echoed, and the echo reached the
parsed stream. The observer appended the batch to its 64 KiB rolling `parsedTail` — and the same append
that delivered the echo evicted it, 5.1x past the window. The gate never opened, `serialize()` was
never called, and a correct echo went unrecorded.

**TWO DISTINCT FAILURE MODES WEAR ONE ERROR LABEL**, which is why nobody could reproduce "the" failure:
- ECHO TIMEOUT (`INPUT-00-A` / `INPUT-0-B`): `foreign*Count` 0/0, `instanceId` matching
  `visibleInstanceId` — the 64 KiB gate defect above.
- COMPLETION SENTINEL: `foreign*Count` 3/3, mismatched instance id, `inputCount 2 of 2` — a terminal
  REMOUNT mid-scenario, every subsequent write discarded as foreign.

**THE REASONING ERROR, recorded as the sharpest lesson of the effort.** This mechanism was proposed
early, then REFUTED on the grounds that 14 of 14 observed echo arrivals were tiny isolated batches. All
14 came from PASSING runs. A failure caused by an echo landing in a large batch cannot be observed in
runs where it did not land in a large batch. The distribution measured was a property of SUCCESS, not
of the mechanism — survivorship bias, committed while writing careful language about falsifiability,
and only exposed by capturing a failing sample. The corrected constant matters too: the operative
window is the observer's 64 KiB `parsedTail`, NOT the 5,000-line scrollback, and the arithmetic is
331,967 > 65,536.

**Fix authorised as non-weakening.** `parsedTail` is a CHEAP GATE whose only purpose is to avoid calling
`serialize()` on every batch; the AUTHORITATIVE check is `serialized.includes(echo)` and it is untouched.
Testing the incoming batch's own `data` for each armed echo, in addition to the rolling tail, makes the
gate open when it should have — it cannot admit an echo that `serialize()` does not confirm. Widening
`parsedTail` (unbounded observer memory) and calling `serialize()` unconditionally (the cost the gate
exists to avoid) were both rejected.

Open question being measured: when the gate opens correctly for a large-batch echo, does `serialize()`
contain it? The echo sat ~332 KB back in its own batch against a ~340 KB scrollback — at the boundary.
If yes, the invalidation is fixed. If no, the scrollback-eviction mechanism is real at exactly this
edge and the two are adjacent rather than alternative.

### Slice B (provider dedupe): regresses warm switch uniformly, reverted

| percentile | v7 | + Slice B | delta |
|---|---:|---:|---:|
| p10 | 87.7 | 101.7 | +14.0 |
| p50 | 110.2 | 121.1 | +10.9 |
| p90 | 127.2 | 138.0 | +10.8 |
| p95 | 130.4 | 138.8 | +8.4 |

Cold ready 1,904 -> 1,922 (the 568.6 ms round trip never showed up); quiescent CPU 2.997-2.999 pinned
-> 3.99-4.99. A UNIFORM shift across the whole distribution — the exact inverse of the rail-clock
slice, giving back essentially all of its win. The rail hunk was verified present in source
(`sha 085923affa2bb09c`) and in the packaged bundle before concluding.

Hypothesis under test before revert: the dedupe collapses two cache entries into one, so every write
notifies more observers and `structuralSharing: mergeProviderIndexWithDetails` now runs on the switch
path. If so, the duplicate REQUEST was not free but the duplicate ENTRY was doing useful isolation —
removing a request is not automatically a win when its result is subscribed to by the UI.

Slice A (empty catalog never replaces a populated one, moved into the merge) is RETAINED: it is a
correctness fix covering three previously-unguarded writers including a reachable one at
`provider.tsx:138`, and is not implicated in this measurement.

### Slice B post-mortem: the dedupe WORKED and bought nothing, and the parent's mechanism was wrong

Verified independently from the run artifacts:

    v7:      /provider x3 — unqualified 328.0 / 1210.9, ?harness=pi 411.5 / 451.9, ?harness=opencode 856.8 / 682.1
    Slice B: /provider x2 — unqualified 348.7 / 1214.8, ?harness=pi 433.7 / 445.0

The duplicate is genuinely gone from the packaged composition, so the wire-count test held in the real
build. Cold ready did not move. **The 568.6-682.1 ms round trip was not on the critical path** — the
fifth time this effort removed real work and moved nothing. Note also that the unqualified fetch stayed
at ~1,211 ms in both arms: removing the second request did not make the first cheaper, consistent with
the ENGINE COMPILE being the cost rather than the request.

**The parent's proposed mechanism for the regression was wrong, and was refuted from `git show HEAD`:**
`useProviders()` and the directory bootstrap ALREADY shared one cache entry before this session — the
normaliser at `bootstrap.ts:440` and the key at `:447` predate it. Entry count and observer fan-out did
not change, so "two entries collapsed into one" cannot explain the uniform +11 ms per switch.

**The slice author's replacement hypothesis, labelled as one:** the key went from receiving plain
writes (`setProviderQueryData`) to having a QUERY REGISTERED on it — a queryFn closing over an injected
transport, a `staleTime`, and `structuralSharing` — while `useProviders()` observers mount per session
surface (`composer.tsx:78`, `models.tsx:36`, `session-selection.tsx:78`) and resubscribe on every
switch. A key with a fetcher and a refetch policy behaves differently at mount than a key that only
ever held data. Uniform per-switch cost, matching the measured shape.

**General result, in the author's sharper form:** the cost moved not because entries merged, but
because a cache entry the UI subscribes to acquired a QUERY where it previously had only DATA.
Deduping through a query client is not free on a key with live observers, and a boot-time optimisation
that changes a key's lifecycle can be repaid on every subsequent interaction.

### Compile cache for the engine: two traps found before building, and the way through

Cold ready is ~150 ms short and every request-level optimisation has returned nothing. The remaining
lever is the ENGINE COMPILE itself: 150.7 ms of `compileSourceTextModule` inside a ~540 ms window,
corroborated by a second method at ~155 ms.

**Runtime support, verified in the actual binary:** Electron 43.2.0 / Node 24.18.0 / V8 15.0.
`module.enableCompileCache` returns `{status: 1}` (ENABLED). The repo uses no compile cache today.
Measured on the real 23 MB ESM artifact loaded exactly as the app loads it: cold 400.1 ms, warm
244.5 / 245.8 ms, fresh-dir 378.3 ms. **Saving ~155 ms, reproducible.** Cache is 2.85 MB / 8 entries.

**TRAP 1 — a cache under the user data dir helps every launch EXCEPT the measured one.** The harness
materialises a fresh data dir per run, so a runtime-written cache reads exactly ZERO in the benchmark
while real users get 155 ms from launch two onward. Found before building.

**TRAP 2 — a prebuilt shipped cache closes the gate for the build user ONLY.** The cache directory is
not the one passed in: `getCompileCacheDir()` resolves to `<base>/v<node>-<arch>-<flagshash>-<UID>`.
Independently reproduced — renaming the uid segment on a populated cache produced
`no such file or directory`; restoring it produced a hit. A shipped tree keyed to the build user's uid
would hit for the build machine and the benchmark (which runs as that user) and MISS for every
customer. That is the worse trap: trap 1 is a missed opportunity, trap 2 is a **false qualification
result**. Found and refused before building.

**THE WAY THROUGH, verified end to end:** ship the cache ENTRIES ONLY, not the segment directory name,
and seed the runtime-computed path before the first import:

    module.enableCompileCache(writableDir)
    const computed = module.getCompileCacheDir()   // includes the CURRENT user's uid
    if (isEmpty(computed)) cpSync(shippedEntries, computed)
    await import(engine)                            // HIT

This respects the security property the uid segment exists for — no user reads another user's cache,
nothing is written outside the user's own data dir — and entries remain keyed by node version, arch
and flags hash, so a mismatched runtime still misses and degrades to a full compile. It works on FIRST
launch for ANY uid, which makes it both a real product win and measurable by the harness.

**Honest bound:** a code cache removes COMPILATION, not EXECUTION. The 258.7 ms of the engine's own
top-level evaluation is untouched; only a full heap snapshot would reach it. ~155 ms against a ~150 ms
gap closes the gate only if it lands nearly in full — and five candidates this session have removed
real work and moved no gate. The one property this candidate has that all five lacked: the compile is
not a request that might overlap something else, it is synchronous loop-blocking occupancy inside the
window the renderer spends waiting.

Acceptance test: under `NODE_DEBUG_NATIVE=COMPILE_CACHE` the runtime distinguishes
`V8 code cache for ESM file://<ENGINE> was accepted` from `was not initialized`. The test asserts the
HIT names ESM and the engine artifact specifically — a test that checked for the directory's existence
would pass while the cache silently missed on every launch.

### Observer gate fixes applied mid-qualification — disclosed, with the non-weakening argument

Two clauses in `agent-browser-observer.ts` (lines 1178 and 1189) now test the incoming batch's own
`data` in addition to the 64 KiB rolling `parsedTail`, for the armed echoes and for the model end
sentinel respectively.

**Why this is not a weakening, stated so a reader can check it:** `parsedTail` is a CHEAP GATE whose
only purpose is to avoid calling `receipt.serialize()` on every parsed batch. The AUTHORITATIVE
predicates are `serialized.includes(echo)` and `serialized.includes(modelEndSentinel)`, and both are
untouched. The fix makes the gate open when it should have; it cannot admit anything `serialize()`
does not confirm. Widening `parsedTail` (unbounded observer memory) and calling `serialize()`
unconditionally (the cost the gate exists to avoid) were both rejected.

**The fix is necessary and NOT sufficient — measured.** First post-fix failing sample:
`bytesFromEnd 415,714`, `wouldHaveFailedPreFix: TRUE`, `serializeCalled: TRUE` (the gate now opens),
`serializeHadEcho: FALSE` (the buffer had already evicted it). So both originally-proposed mechanisms
are real and they are ADJACENT WINDOWS:

    gate opens          if bytesFromEnd <  65,536
    serialize contains  if bytesFromEnd < ~339,788   (measured: 339,714 / 339,716 / 339,788)

    K2  bytesFromEnd 331,967  -> gate missed, buffer would have held it   -> FIXED by the clause
    F1  bytesFromEnd 415,714  -> gate missed AND buffer evicted it        -> unfixable by any gate change

**Both earlier refutations withdrawn.** The same survivorship error retired both candidates; the source
analysis was right about both mechanisms and wrong only about the constant on the second — the
operative number is the ~339,788 byte serialized buffer measured directly, not a line count derived
from a workload estimate.

**Residual rate NOT established, deliberately.** A 10-attempt post-fix run produced 0 failures, but all
20 echo observations had `bytesFromEnd = 6` in 28-29 byte batches — the sample contains ZERO instances
of the mechanism under test, so it measures how often echoes land in large batches, not whether the fix
works. Publishing it as "the fix took the rate to zero" would repeat the exact error that hid the
mechanism for 23 trials. The pooled 3-of-31 is also not published as a rate: 20 of those attempts
predate the runner-load discovery and could not have failed.

Instead, `bytesFromEnd` is now recorded per echo in the run artifacts, so every future benchmark run
contributes two samples to the denominator at zero marginal host cost. The distribution — not a
failure hunt — is the right instrument for a question about workload batch behaviour.

Recorded process hazard: the hunt loop's failure detector initially reported 10/10 FAILED because
`grep FAILED` matched its own `WOULD-HAVE-FAILED-PRE-FIX` label. Caught before reporting by re-parsing
per-attempt result lines. An instrument whose failure detector matches its own diagnostic labels will
eventually produce a dramatic false alarm.

### Compile cache, TRAP 3: the entry filename encodes the source file's absolute path

A first implementation attempt found — and the parent then independently reproduced — that seeding the
runtime-computed directory with the shipped entries VERBATIM does not work.

    key = crc32( 0x01 || pathToFileURL(realpathSync(sourceFile)).href )   -> 8 lowercase hex chars

Reproduced end to end:
- cache generated for `/tmp/cckey/A/m.mjs`, entry copied verbatim into the computed dir for
  `/tmp/cckey/B/m.mjs` -> `no such file or directory`, MISS.
- same entry copied and RENAMED to the key computed from B's realpath URL ->
  `reading cache ... success, size=560` and `was accepted, keeping the in-memory entry`. HIT.

So the cache CONTENT is path-independent; only the entry NAME encodes the path. Seeding therefore
requires computing the key AT RUNTIME from the engine's own path and renaming each shipped entry to it
— which is also what makes the design correct for a customer whose install path differs from the build
machine's.

REALPATH DETAIL that cost an attempt: on macOS `/tmp` is a symlink to `/private/tmp` and the key is
computed from the REALPATH. `file:///tmp/...` produced the wrong key and missed; `file:///private/tmp/...`
hit.

RISK, to be stated at the derivation site rather than hidden: this key derivation is an INTERNAL Node
implementation detail, not public API. If a Node upgrade changes it, the seeded entry is never found
and the app takes a full compile — a silent loss of ~155 ms, never a failure. That degradation is
acceptable ONLY because the acceptance test asserts a real HIT, so a broken derivation turns the test
red.

Also recorded: the engine artifact resolves native dependencies (node-pty and friends) relative to its
own location, so the cache generator must run against the real packaged layout or the artifact in
place — copying the engine to a scratch directory fails with a missing native module.

**Three traps on one slice, each found before it could produce a number:** a cache the harness cannot
see; a cache that closes the gate only for the build user; and a cache whose entries cannot be found
from any path but the one that generated them.

### Compile cache, TRAPS 3 and 4: nailed to the V8/Node source, with a build-invariance proof

**TRAP 3 — the entry filename is a hash of the module's own absolute path.** Node v24.18.0
`src/compile_cache.cc`:

    uint32_t GetCacheKey(filename, type) { crc32(type); crc32(filename); }   // ESM=1, CJS=0
    cache_filename = compile_cache_dir + "/" + Uint32ToHex(key)

For ESM `filename` is the resolved `file://` URL. Reproduced in JS (`zlib.crc32`) 4/4 against
filenames the runtime actually wrote, including the real engine artifact (`3a35ee30`). Not
machine-specific — PATH-specific, which for a packaged app is worse, because the build path and the
install path never match.

Direct test of the naive design, same engine bytes, build path versus a simulated packaged path, real
server V8 flags, fresh cache dir. Engine import, 4 runs each:

| arm | runs (ms) | result |
|---|---|---|
| COLD, no cache | 441.3 / 438.2 / 445.2 / 445.0 | — |
| NAIVE, entries copied verbatim | 453.4 / 438.2 / 470.1 / 442.7 | **MISS, zero gain** |
| REMEDY, blob rekeyed to the runtime path | 296.0 / 294.7 / 303.3 / 304.9 | **HIT, ~142 ms** |

The NAIVE column is the false-qualification shape demonstrated rather than argued: a dev-path test
hits, the gate closes, the shipped app gains nothing.

**TRAP 4 — the V8 FLAG HASH is in the directory tag, and the server child has flags.**
`src/main/server-runtime-policy.ts` `claxedoServerExecArgv()` returns
`--expose-gc --optimize-for-size --max-old-space-size=512`. Measured directory tags:

    no flags                  v24.18.0-arm64-f02d4d51-501
    server execArgv           v24.18.0-arm64-ff1546d9-501   <- the real one
    --expose-gc only          v24.18.0-arm64-eda74c0d-501

A generator run without those flags ships a cache under a tag the server child never reads.
Independent of trap 3, same zero. The generator must fork with `claxedoServerExecArgv()` itself, not a
re-spelling of it.

**Why rekeying is legitimate rather than trap 2 in disguise**, established by reading what the blob is
validated against: V8 `api.cc` `CachedDataVersionTag()` = version hash combined with flag hash — no CPU
features, no host, no user; the `SerializedCodeData` header carries magic, version hash, source hash,
flag hash, RO-snapshot checksum, length and checksum, and NOT the script name — which is exactly why a
blob produced at path A is accepted for path B once renamed; and `getuid()` appears ONLY in the
DIRECTORY tag, never in the entry or the blob. Every remaining input is a property of the shipped
Electron binary, the shipped engine bytes, and the flags — byte-identical on every customer machine.

**Stated limit, to travel with any qualification claim:** the install-path half is proven by direct
experiment across two absolute paths; the uid half rests on the source, a rename experiment, and the
fact that we only ever write into `module.getCompileCacheDir()`. It was NOT tested as a second uid or
on a second host.

**Size correction:** "2.85 MB across 8 entries" is really ONE entry that matters — the engine ESM blob
at 2,831,468 bytes. The other seven are CommonJS `@lydell/node-pty` files totalling ~16 KB, which need
rekeying too but are worth ~0 ms.

**The coupling is made safe at BUILD time, not runtime:** the generator asserts that the JS key
function reproduces the filename the runtime ACTUALLY wrote for the build path. If Node changes the
scheme the BUILD fails loudly; it cannot silently ship a cache that misses. Since the same binary
ships, build-time verification is a complete runtime guarantee, and every runtime failure path
degrades to a plain MISS with a booting app.

**Four traps on one slice, every one found before it produced a number.**

### Cold open segmented: 70-80% of the window is BEFORE the predicate can be evaluated

Four instrumented runs, fresh process each.

| run | metric | frames | BLOCKED | evaluable | first evaluable |
|---|---:|---:|---:|---:|---:|
| 1 | 141.6 | 13 | 8 | 4 | 101.4 ms |
| 4 | 215.3 | 22 | 18 | 4 | 174.3 ms |
| 5 | 183.6 | 19 | 13 | 5 | 134.0 ms |
| 6 | 184.7 | 19 | 14 | 4 | 141.9 ms |

"Twelve frames to accept" was a count of FRAMES, not of signature changes. Only 4-5 frames per run
produce a signature at all; the rest fail an earlier gate and are never compared. The gate is dominated
by time before the predicate can start, not by settling.

**The composer readiness flag TOGGLES.** Block order per run:

    run 1: composer -> timeline -> targetRow -> COMPOSER AGAIN -> OK
    run 4: composer -> timeline -> COMPOSER AGAIN -> targetRow -> OK
    run 5: composer -> timeline -> COMPOSER AGAIN -> OK
    run 6: composer -> timeline -> COMPOSER AGAIN -> targetRow -> OK

`composerVisibleAndEnabled` passes, then fails again — nine consecutive frames in run 4, 64.6 ms to
149 ms. Churn, not convergence, and the single largest block in the window. This is NOT the lazy-chunk
placeholder disproved earlier for warm switch: there the composer was ready before the first row
painted; here it becomes ready and then stops being ready. Under investigation: which of the four
conditions fails (`contenteditable`, box, opacity, `aria-disabled`), and whether the node is the same
element — "disabled", "replaced", "detached" and "restyled" are four different defects presenting
identically.

**The content is correct at the first evaluable frame.** `textHash` and `textLength` (272) are
IDENTICAL across every evaluable frame in every run. Of a ~184 ms median: ~140 ms precedes any
evaluable frame, ~25 ms is geometry settling AFTER the answer is already correct, ~15 ms is instrument
floor. A user sees the right message well before the metric stops.

**The settling that does exist is tiny and reproducible:** rows 4 -> 5 with scrollHeight +52..+93, then
a correction of exactly -34 in all four runs, then an identical frame. The virtualizer adds a row,
measures it, corrects by a fixed amount. ~25 ms.

**Not a busy main thread.** Inter-frame gaps are 8.0-8.7 ms (one vsync) for 90% of frames, `sampleMs`
0.0-0.4 ms, and ZERO long animation frames in any run. The renderer produces frames at full rate doing
almost nothing. This gate has never been about throughput — it measures how long a set of readiness
predicates takes to become simultaneously true, dominated by one that toggles.

### Cold open: the composer Suspense boundary RE-SUSPENDS — the first product defect a gate has exposed

Discriminator run, four fresh processes, per-frame composer identity, condition failures, fallback
presence and connectivity.

| run | metric | composer ready | re-suspends | returns | gap | % of metric |
|---|---:|---:|---:|---:|---:|---:|
| 11 | 168.3 | 35.8 ms | 94.2 | 101.2 | 7.0 | 4.2% |
| 12 | 209.5 | 35.0 ms | 68.3 | 151.6 | 83.3 | 39.8% |
| 13 | 201.1 | 34.8 ms | 68.1 | 143.2 | 75.1 | 37.3% |
| 14 | 201.4 | 35.1 ms | 68.5 | 143.4 | 74.9 | 37.2% |

**Which of the four conditions fails? NONE.** `fail: []` on every frame in which the node exists, in
all four runs — never `contenteditable`, never `aria-disabled`, never zero-box, never
display/visibility/opacity. The node is either fully valid or ABSENT (`count: 0`). Source confirms it:
`composer/ui/frame.tsx:294` writes `contenteditable="true"` as a static literal and the node carries no
`aria-disabled`, so "disabled" was never available as an explanation.

**The Suspense fallback is mounted for the entire absence** — `data-component="session-prompt-dock-loading"`
present in all four runs. The boundary genuinely re-suspends; the region is not unmounting for some
other reason.

**Detach and reattach, NOT unmount and replace.** `nodeId: 1` before and after the gap in every run —
the same DOM element object returns. Solid preserves the resolved children and swaps the fallback in.
The composer's DOM and state survive, so the diagnosis is "a resolved subtree is hidden again because
something in the same boundary started a second async read", not "the editor is being rebuilt".

Cold open's ~200 ms, decomposed by measurement:

    ~35 ms  initial mount to composer ready
    ~33 ms  timeline / target row not yet present
    ~75 ms  COMPOSER RE-SUSPENDED, boundary showing its fallback again      <- 37%
    ~25 ms  geometry settling after the content is already final
    ~15 ms  instrument floor

**User-visible statement:** the composer appears, disappears for ~75 ms, and reappears while a session
opens. Nobody would defend that behaviour if it were reported as a bug rather than discovered as a
measurement. It is worth fixing on merit independent of any gate.

### Lesson: a candidate disproved in one lifecycle phase is not disproved globally

This is the SAME lazy-composer candidate that was raised for warm switch, measured there (placeholder
present 0 frames, composer editable before the first row painted), and recorded in this document as
dead. It was dead THERE. Cold open resolves those chunks for the first time, which is the only phase in
which a second suspension of the same boundary can occur. Had the earlier disproof been allowed to
stand as general — which is how it was recorded — this 75 ms would still be invisible.

Consequence adopted: the candidates this effort retired on single-phase measurements are being reviewed
for the same error.

### Compile cache SHIPPED and measured: mechanism confirmed in the packaged app, magnitude unresolved

The corrected design was built (11 files), and the seed was verified independently in a real benchmark
run rather than trusted. The expected key was computed from the packaged engine's realpath —
`crc32(0x01 || file://.../Resources/opencode-engine/node.js)` = `b4c91c32` — and found in the run's
fresh profile:

    run/claxedo-data/opencode-compile-cache/v24.18.0-arm64-ff1546d9-501/b4c91c32   2,829,820 bytes

Right flag-hash segment (`ff1546d9`, so trap 4 is handled in the shipping path), right uid segment,
right key, right size.

**Same-build A/B** — `Resources/opencode-compile-cache` moved aside and re-run, so the binary is
byte-identical and only the shipped blob differs:

| | cache ON | cache OFF | delta |
|---|---|---|---:|
| cold ready | 3905 / 1853 / 1789 / 2276 / 1726 / 1729 (med **1821**) | 2071 / 1926 / 1966 / 3080 (med **2018**) | **-197** |
| first `/provider` (tails excluded) | 1011.9 / 1085.1 / 1085.9 / 1082 (med **1085.1**) | 1468.8 / 1125.3 / 1111.3 (med **1125.3**) | **-40** |

Cold ready moved -197 ms at the median while the request that pays the compile moved only ~40 ms, and
the isolated lab measurement was ~142 ms on the import alone. Those three numbers do not reconcile and
the magnitude is UNRESOLVED pending a packaged-app measurement of the import itself. Three candidate
readings, none yet established: the -197 is mostly noise (both arms have 3000+ ms tails, n=6 and 4);
the saving is real but not concentrated in any single request's duration, because removing loop
OCCUPANCY releases queued requests without shortening one of them; or the packaged saving is genuinely
smaller because the 258.7 ms of top-level module EVALUATION is untouched by a code cache.

Slice quality notes worth keeping: the load-bearing positive test uses a REAL COPY of the engine rather
than a symlink, because node realpaths and a link would pass for the wrong reason; the idempotence test
asserts the seeded blob's mtime is unchanged rather than trusting a status string; and a defect was
found en route — the runtime writes cache entries 0600, so a straight copy would have shipped a blob
only the BUILD user could read, failing silently for every customer (fixed to 0644).

### Compile cache: the mechanism's budget measured directly on the packaged artifact

Isolated in the PACKAGED layout — the packaged Electron binary against the packaged engine at its
packaged path, 7 runs each, interleaved:

    ON  (cache seeded)  249.9 249.6 250.7 249.8 250.3 251.3 249.2   median 249.9
    OFF (no cache)      388.6 397.7 384.2 383.2 386.5 382.7 383.4   median 384.2
    DELTA 134.3 ms at the median, 133.5 min-to-min, variance +-1 ms

And the acceptance was verified as ACCEPTED rather than merely present — a blob at the right key can
still be rejected on a source- or flag-hash mismatch and would look identical on disk. Under
`NODE_DEBUG_NATIVE`: `V8 code cache for ESM file:///...Resources/opencode-engine/node.js was ACCEPTED,
keeping the in-memory entry`.

**Why `/provider` moved only ~40 ms — measured, not argued.** A 5 ms heartbeat during the import fired
ONE tick of an expected 50 (cached) and ONE of an expected 77 (uncached). The engine import is a single
monolithic synchronous block of the server child's main thread: for ~385 ms uncached and ~250 ms
cached, the server answers NOTHING. The cache does not make a request faster — it shortens a total
stall and hands ~134 ms of occupancy back. And because `embeddedHost()` is memoized behind
`embeddedHostPromise`, exactly ONE request pays the stall while every other concurrent request awaits
the same promise; if `/provider` is not the trigger, its duration only ever reflected whatever remained
of the block.

**The ceiling, stated against our own interest:** the mechanism's entire budget is 134.3 ms. The
observed cold-ready median moved -197 ms, which EXCEEDS what the mechanism can physically produce, so
part of it is noise — consistent with the 3905 ms and 3080 ms tails at n=6 and n=4. **-197 is not
claimable.** The defensible claim is ~134 ms less loop-blocking occupancy in the boot window, measured
on the packaged artifact, with an unresolved cold-ready delta bounded above by 134 ms.

The ~250 ms that REMAINS is read + link + top-level EVALUATION, matching the 258.7 ms the earlier CPU
profile attributed to the engine's own code. A code cache removes compilation and nothing else; that
residue is a different lever this slice cannot reach.

Open, and honestly labelled: which request first triggers the import in a running app was NOT verified
(it needs a running app). The cheap probe is a log at the single memoization point in `embeddedHost()`.

### Composer re-suspension fix: packaged, and cold open did not move

    cold open   control (n=6) 153.0 158.2 152.1 148.2 147.1 156.5  median 152.5
                + guard (n=4) 153.5 151.2 149.5 145.1             median 150.4     -2.1 ms
    cold ready  1886 median, unchanged; warm switch, history, stream, RSS, CPU unchanged

Predicted ~200 -> ~125-130 ms. `readWithoutSuspending` was verified present in the packaged bundle
before concluding. Under investigation with the same instrument that found the defect: either the gap
is GONE and was never on the critical path (it overlaps the timeline / target-row block, which starts
earlier — removing a blocker that runs concurrently with another blocker shortens nothing), or the gap
persists and the source diagnosis is incomplete.

**The slice ships either way, and that ordering was put in writing BEFORE the measurement** so a null
result could not become a revert-by-embarrassment: a composer that appears, vanishes for ~75 ms and
reappears while a session opens is wrong regardless of what any gate reads.

### Composer re-suspension: OUTCOME 1 — the gap was never on the critical path

Instrumented before/after on the packaged builds, 4 fresh processes each:

    before guard   7.0 / 83.3 / 75.1 / 74.9 ms      median 75.1
    after guard   16.9 / 15.5 / NONE /  8.4 ms      median 15.5

The suspension is ~5x shorter and absent in one run — yet cold open moved -2.1 ms. The frames say why
without inference:

    run 12  composer gap 68.3-151.6   blocker WHEN THE COMPOSER RETURNED = targetRow   accepted 193.3
    run 13  composer gap 68.1-143.2   blocker WHEN THE COMPOSER RETURNED = targetRow   accepted 184.7
    run 14  composer gap 68.5-143.4   blocker WHEN THE COMPOSER RETURNED = targetRow   accepted 185.1

In every run `targetRow` was STILL BLOCKING when the composer returned, with acceptance 33-42 ms later
again. The composer was suspended entirely inside the shadow of a longer wait that started earlier and
outlasted it. **Deleting a blocker that runs concurrently with the binding one shortens nothing** —
the sixth instance of this effort's most expensive lesson, and the first observed INSIDE a single
measured window rather than across the boot.

**The falsifier fired and first caught the instrument.** Frame timestamps are relative to arming;
`performance.getEntriesByType("resource")` is relative to `timeOrigin`, and the offset was never
recorded — so the promised millisecond-level comparison was NOT computable from what was captured. The
author reported that rather than quietly dropping the check. Bounded instead:
`/api/claxedo/agent-config/commands` ran at 769.6 -> 937.4 ms page-time while the cold-open click is
~2400 ms, so the command list was cached ~1.5 s BEFORE the window opened and no request is in flight
during the residual fallback.

**So the arming mechanism was right and the duration story was wrong.** The unguarded read is what
arms the boundary — guarding it took the gap from >=75 ms in 3 of 4 runs to nothing above 17 ms — but
the 75 ms was never fetch latency. A cache-hit `fetchQuery` still returns a promise, so the
per-activation `createResource` is pending for a tick and the boundary holds its fallback until it
re-renders, queued behind timeline/targetRow work already saturating the main thread. Main-thread
contention wearing the costume of a fetch. Labelled by its author: the arming is OBSERVED, the duration
explanation is INFERENCE.

Slice retained on merit, gate-neutral, exactly as put in writing beforehand. **`targetRow` is where the
cold-open budget actually goes** — the binding constraint in every run where it appeared.

### A uniform warm-switch regression has appeared, and the provider cache is the suspect again

All 120 per-switch durations per arm:

| percentile | v7 (rail only) | current tree | delta |
|---|---:|---:|---:|
| p10 | 87.7 | 104.0 | +16.3 |
| p50 | 110.2 | 121.5 | +11.3 |
| p90 | 127.2 | 138.7 | +11.5 |
| p95 | 130.4 | 144.4 | +14.0 |

The rail-clock win is gone. Uniform at every percentile — the same SHAPE as the reverted Slice B
regression and the exact inverse of the rail-clock improvement. Between the two builds the tree gained
Slice A, the compile cache, and two perf-harness observer clauses. The observer clauses are in the
harness; the compile cache runs in the server child at boot and cannot touch a renderer-side switch.
Slice A moved the empty-catalog rule INTO `mergeProviderIndexWithDetails`, which is
`providerListQuery`'s `structuralSharing`, on a key whose observers remount per session surface.

**Second time a provider-cache change has produced a uniform per-switch cost, both times because a key
the UI subscribes to began behaving differently.** If confirmed, that is a property of this cache key
and a standing hazard, not a coincidence. Under investigation before any revert — Slice A is a genuine
correctness fix covering three unguarded writers, so a confirmed cost is a trade to decide rather than
an automatic revert.

### Chasing a uniform warm-switch regression: two candidates eliminated by evidence, one survives a proof

All per-switch durations pooled per build (n in table), from `attempt.json` evidence rather than p95s:

| build | n | p10 | p50 | p95 |
|---|---:|---:|---:|---:|
| v7, rail clock only | 120 | 87.7 | 110.2 | 130.4 |
| +A +B, NO compile cache | 120 | 101.7 | 121.1 | 138.8 |
| +A +compile cache | 120 | 104.0 | 121.5 | 144.4 |
| +A +compile cache, blob removed | 80 | 104.0 | 121.6 | 139.5 |
| +A +ccache +composer | 80 | 101.8 | 121.5 | 145.6 |
| observer clauses ABLATED | 60 | 102.1 | 121.3 | 138.9 |

**Compile cache: excluded by ORDERING.** The hypothesis was good — `enableCompileCache` installs a
PROCESS-WIDE hook, not a boot-scoped one; there are 11 lazy `await import` sites in the server
packages; a module first compiled during a switch would pay a lookup and, on a miss, a synchronous
cache WRITE on the server's single event loop — and it predicts exactly the uniform shape observed.
But the regression is fully present in the `+A +B` build, which predates the compile cache entirely.

**Observer clauses: excluded by DIRECT ABLATION.** The pre-gate-fix observer was swapped in, measured,
and swapped back byte-identical: p50 stayed at 121.3. No packaging cycle was needed because the harness
runs from source — which also means the parent's earlier "it is in the harness, so it cannot matter"
dismissal was wrong twice over: wrong as reasoning, and the cheap experiment was available all along.

**Slice A is the only change present in every regressed build and absent from the only clean one — and
a careful reading says it cannot be responsible.** On the switch path the incoming catalog is non-empty,
so `index.all.size === 0` is false, `&&` short-circuits without reading `previous.all.size`, and control
falls through to byte-identical construction: one `Map.size` read, one integer compare, unchanged
returned identity. The three per-session-surface observers (`composer.tsx:78`, `models.tsx:36`,
`session-selection.tsx:78`) all call `useProviders()` unqualified, so `providerCacheHarness(undefined)`
leaves their key identical.

A hypothesis that survives every elimination while a proof says it is impossible means one of the two
is wrong. The only reconciling mechanism identified so far: Slice A also made `providerCacheHarness` an
exported symbol that `bootstrap.ts` imports instead of defining locally — an IMPORT-GRAPH change in a
bundled app, which could move code between chunks and would be entirely invisible to a reading of the
merge function. Not asserted; named as the only construction that fits both facts. Ablation staged.

### Hazard recorded regardless of the outcome

**The provider catalog cache key is subscribed to by components that remount on every session switch.**
Any change to that key's `structuralSharing`, queryFn, staleTime, observer count, or returned identity
lands on the switch path once per observer. Slice B changed it (a key that held only DATA acquired a
QUERY) and cost ~11 ms uniformly. Anyone touching that key should assume they are modifying the
warm-switch gate, even when the change looks like a boot-time concern.

## CORRECTION: the rail-clock warm-switch win was NOT REAL, and the regression that followed never existed

**Same-tree A/B, the experiment that should have been run first.** The current tree, packaged twice —
once with the rail-clock hunk, once with the pristine file — four benchmark runs each, all 80
per-switch durations per arm:

| arm | n | p10 | p50 | p90 | p95 |
|---|---:|---:|---:|---:|---:|
| rail hunk PRESENT | 80 | 101.8 | 121.5 | 138.3 | 145.6 |
| rail hunk REMOVED | 80 | 104.6 | 121.4 | 138.5 | 145.7 |

**Delta at p50: 0.1 ms.** The slice makes no measurable difference to warm switch.

This document earlier published it as the first movement on warm switch in the entire effort — median
138.5 -> 128.5, uniform across the distribution, with quiescent CPU pinned at 2.997-2.999 against a
control ranging 2.996-5.994. **That claim is withdrawn.**

**The methodological failure, stated precisely:** the "v7" comparison was against a control packaged
EARLIER IN THE SESSION, not against the same tree measured in the same window. This document's own rule
is "a control is a BUILD, not a remembered number", and it was violated in the one case where the
result was flattering. The pooled per-switch distribution made it look airtight — 120 samples against
60, uniform at every percentile — but it was uniform because the whole baseline had shifted between
packaging windows, not because the change did anything.

**Everything that followed from it also dissolves.** The "uniform +11 to +16 ms regression" that Slice
A, the compile cache and the observer gate clauses were each suspected of causing was the baseline
returning to where it had always been. All three were correctly cleared by evidence; there was never
anything to clear. Two agents spent an hour hunting the cause of a number that was noise, and in every
case their reading told me the mechanism could not produce it — and the reading was right.

**The slice is RETAINED on merit with an explicitly null gate result.** `sessionDisplayRow()` read
`clock()` unconditionally, so a 10 s tick invalidated every session row and recomputed six derived
fields to update one label that cannot change for any session older than a day — roughly 42 row
rebuilds per idle minute. Removing that is correct whether or not any gate can see it. It joins the PTY
query-suppression slice as production-merit work with no gate effect.

**The author's own prediction was right and was overridden by a worse measurement.** They wrote
"negligible; if it moves a step in either direction I would read that as the gate's known instability",
then scored themselves as wrong in the conservative direction when the numbers appeared to disagree. In
fact they were correct and the parent was wrong in the flattering direction — which is the worse of the
two errors, and the one this rule exists to prevent.

**Rule reinforced, now with a cost attached:** every candidate must be measured against a control
packaged and run in the SAME session window, as a same-tree A/B where the only difference is the
candidate. Cross-window comparisons of packaged builds are not evidence, no matter how many samples
they pool.

### Two rules adopted after the retraction, both earned expensively

**SCREEN BEFORE INTERPRETING: compare p0 and p10 between arms FIRST.** If the BEST CASE moved, the
arms are not comparable and nothing downstream is interpretable. In the withdrawn rail-clock result the
shift was uniform at every percentile INCLUDING p0 and p10, with the fastest switches improving MORE
(16.6 ms) than the median (11.5) — and a targeted change to one component in the always-mounted chrome
cannot make the best case faster than the typical case. That pattern is diagnostic of "these are
different builds", not of "this helps every switch equally". The check costs about a minute because
`attempt.json` retains all 20 per-switch durations in each sample's `evidence` array. Running it would
have saved three agents an hour of hunting a regression that never existed.

**WHEN THE ARITHMETIC CANNOT SUPPORT THE MAGNITUDE, DOUBT THE MEASUREMENT.** The rail-clock slice's
author had already reported being unable to derive ~12 ms from deferring a microsecond function on
seven rows, and correctly refused to invent a mechanism — but filed the effect as "real but
unexplained" rather than concluding that an effect exceeding what the change can physically produce
impeaches the comparison. The same rule was applied correctly an hour later to the compile cache, where
a -197 ms cold-ready move exceeded a 134.3 ms mechanism budget and was refused. The rule was applied
when it cost a number and skipped when it gave one.

### Audit opened: every retained slice re-screened for the same failure

If one cross-window comparison produced a false win, others may have. Two retained claims are prime
suspects on their face and are being screened against the artifacts:

- **The session-metadata reconcile generation gate**, credited in this document with CLOSING the
  quiescent-CPU gate: 5.994/5.989/6.000 -> 5.000/4.998/4.996. That is exactly one quantization step on
  a metric since observed to range 2.997-5.994 across windows, and the arms were packaged separately.
- **The reconnect-repair presentation gate**, credited with warm switch 196.9/197.6/196.7 ->
  146.7/138.9/138.6 and cold open 195.0/191.2/186.4 -> 160.0/153.2/151.2. A ~50 ms move with a named
  mechanism (a per-frame `scrollTop` poll armed on the OUTGOING hidden session) is more likely real, but
  it was cross-window and gets screened like everything else.

Claims that fail the screen will be withdrawn and re-measured as same-tree A/Bs. A retained slice with
a withdrawn claim is a better outcome than a published number nobody can reproduce.

## AUDIT OF EVERY RETAINED CLAIM — one survives, two withdrawn, one unsupported

Two screens were applied to the artifacts. No host time was spent.

**SCREEN 1 — did the BEST CASE move?** (p0/p10 between arms.)
**SCREEN 2 — did the step PERSIST across later rebuilds?** A retained slice is in EVERY subsequent
build, so a real step is a permanent level change while drift is transient by construction. This second
screen is cheaper and settled three of four cases outright.

### The rule, refined by a case that would have failed the first screen

| shape across percentiles | diagnosis |
|---|---|
| constant ABSOLUTE shift at all percentiles, including the fastest | suspect DRIFT |
| constant RATIO at all percentiles | real PER-FRAME / per-unit cost |
| shift only in the tail | rare COLLISION |

The rail clock was the first pattern (deltas -14/-17/-14/-12/-16/-11/-8, ratio drifting 0.85 -> 0.94,
p100 actually WORSE). Reconnect-repair is the second (ratio pinned at 0.70). The naive form of screen 1
would have thrown away a genuine result.

### RECONNECT-REPAIR PRESENTATION GATE — SURVIVES, claim kept

Warm-switch p95 before the slice: n=181 runs, median 188.5. After: n=114 runs, median 138.8, MAX 162.4.
**0 of 114 later runs ever returned to >=180 ms**, across dozens of rebuilds and every subsequent
slice. Drift cannot hold a level for 114 runs. Per-switch ratio treatment/control is
0.681/0.694/0.707/0.711/0.722/0.705/0.702 across p0..p95 — a near-constant MULTIPLICATIVE factor, which
is exactly the fingerprint of removing a per-frame `scrollTop` poll whose cost scales with how many
frames a switch takes. **This is the strongest result in the record.**

### RECONCILE GENERATION GATE — BOTH CLAIMS WITHDRAWN

The CPU claim was 5.994/5.989/6.000 -> 5.000/4.998/4.996. The fix is RETAINED, so all 55 later runs
contain it — and those runs range 1.000 to 37.994 and include **5.989, 5.993, 5.994 and 7.993 WITH THE
FIX IN**. The post-fix population reproduces the alleged pre-fix value at will. A one-quantization-step
win that the post-fix population reproduces is not a win; the post-fix median is 3.997, which is where
the metric sits regardless.

The cold-open claim (157.3-162.3 -> 144.6-151.0) fails too: 149.2 was measured BEFORE the fix and 160.9
AFTER it. The ranges overlap almost completely.

**CONSEQUENCE: the quiescent-CPU gate was never closed by this slice.** Its real behaviour is a metric
wandering 1.0-8.0 across windows on identical code. The code is retained on merit — not re-running a
full per-session metadata snapshot on every proxied read is genuine waste — with an explicitly recorded
NULL gate result.

### COMPILE CACHE cold-ready claim — UNSUPPORTED

Same-tree arms, ON n=6 {3904.7, 1853.0, 1788.6, 2276.5, 1725.8, 1729.5} versus OFF n=4 {2071.2, 1925.8,
1965.7, 3080.5}. Median gap +197.6 ms, but an EXACT permutation test over all 210 splits of the pooled
values gives **p = 0.262** — roughly one split in four produces a gap that large by chance. The parent
had already refused the -197 ms on mechanism-budget grounds (134.3 ms ceiling); the statistics agree
independently.

`app.cold_ready_ms` takes ONE sample per run, so it has no per-sample distribution to screen and is by
far the noisiest metric in the suite. **Any cold-ready claim needs n>=15 per arm, or a robust statistic
and a stated test — not a median comparison of four to six runs.**

### What survives, honestly

Retained WITH a measured gate claim: the reconnect-repair presentation gate, and the compile cache's
134.3 ms of loop-blocking occupancy measured directly on the packaged artifact (which is a mechanism
measurement, not a gate claim).

Retained on production merit with an explicitly NULL gate result: bounded PTY disk-history compaction's
CPU figure is unaffected (334.477% -> ~4% is far outside any drift band and was reproduced), PTY
query-suppression span slicing, the rail clock scoping, the session-metadata reconcile generation gate,
the composer re-suspension guard, and Slice A's empty-catalog merge rule.

The quiescent-CPU gate is NOT closed. It wanders 1.0-8.0 across windows on identical code, and no
retained slice has been shown to move it.

### Process hazard that nearly corrupted the record: relative paths resolve into the WRONG GIT TREE

Three agents were editing this worktree through RELATIVE paths. The `edit` tooling resolves a relative
path against the kernel's working directory, and that directory does not survive between tasks — it
silently reverts to `/Users/yashvardhansingh/test/opencode`, one tree ABOVE the target worktree. No
error is raised; the write succeeds, in the wrong repository.

One agent did write three edits into the main repo and caught it only because its own verification read
the worktree file back and the change was not there. Reversed with `git apply -R` of that file's own
diff — never checkout, restore or stash, because the main repo carries nine unrelated dirty files from
other work. Verified afterwards byte-for-byte against `git show HEAD:<path>`.

Two other agents checked and found their kernel cwd HAD ALREADY REVERTED to the main repo; their writes
were clean only because they happened to have used absolute paths, or happened to have edited before
the revert. The main repo contains its own CLEAN copies of `rail-sidebar.tsx` and
`platform/query/persister.ts` at identical relative paths, so a relative write would have landed
silently in the two most consequential files this effort touched.

Rules adopted:
1. ABSOLUTE paths for every write.
2. Read the file back afterwards and confirm the change is present. A file that "changed" but reads
   back unchanged is not a flaky tool — it is the wrong file, and that is the only signal available.
3. ABSOLUTE paths for reads and globs too. A relative glob of `artifacts/agent-app-benchmark/*` during
   the claim audit returned ZERO rows; it was loud only because that directory does not exist in the
   main repo. Had it existed, the audit would have silently drawn confident conclusions from the wrong
   artifact set.
4. Sanity-check the COUNT after any bulk load. "0 rows" or an implausible n is the same signal as a
   file that reads back unchanged.
5. Assert the path contains `.worktrees/` — a main-repo path cannot, so one assertion catches the
   whole class.

And the sharpest form of the lesson, from the agent that had used relative paths throughout:
**a read-back is only a check if it uses a path derived INDEPENDENTLY of the one you wrote through.**
Reading back through the same wrong relative path confirms the wrong file just as happily.

### The null-result corollary: a null cannot distinguish "no change" from "no contact"

Recorded after an agent audited its own evidence and found that one of its headline proofs had this
shape:

    bunx tsc --noEmit    889 errors before, 889 after, set-identical
    desktop suite        7 failures before, 7 after, set-identical

"Identical before and after" was the CONCLUSION reported — and it is also exactly what would be seen if
the harness had been running against a tree the edits never reached (see the wrong-tree hazard above).
A set comparison alone cannot separate the two.

What licenses reading an unchanged failure set as "no regression" rather than "no contact" is a
POSITIVE CONTROL in the same measurement: the desktop suite's PASS count moved 636 -> 660, exactly the
24 tests the slice added. That proves the runner demonstrably saw the files.

**Rule: when the evidence is a NULL — an identical set, an unchanged baseline, a passing guard — also
show a non-null signal from the SAME harness proving it was in contact with the work.** This
generalises well past path errors: it is the same failure as a test that passes because it never
executed the code, and the same failure as a cache test that asserts a directory exists rather than
asserting a cache HIT.

This effort has now hit that failure mode in three costumes: a test that passed with its fix reverted
(deleted), a compile-cache test that would have passed on a directory listing (replaced with the
runtime's own accepted/not-initialized verdict), and a null failure-set that could not distinguish tree
contact (resolved by a pass-count delta).

### `stream.interaction_p95_ms`: the budget is not expressible in the metric's own units

Source-derived, with corroboration from this worktree's own retained samples.

**The reachable value set is {16, 24, 32, 40, ...}.** Two independent quantisations compose:
- LEFT CENSORING at 16. `agent-browser-observer.ts:762` sets `durationThresholdMs = 16` and `:863-867`
  registers the observer with `{type:"event", durationThreshold: 16}`, so Chromium never delivers
  entries under 16 ms; `:840` re-filters. Fast probes survive only as a COUNT
  (`stream.probeCount`, `:811-822`), and `agent-metrics.ts:62-74` reconstructs the order statistic from
  the censored population — returning `{state:"bounded", upperBound:16}` when too few entries were
  observed. **The metric's floor is exactly 16; sub-16 is unrepresentable.** A perfectly responsive app
  and one taking 15.9 ms both read 16.
- 8 ms QUANTISATION of Event Timing `startTime`/`duration`. Corroborated in code by the +-8 ms matching
  tolerance at `agent-browser-observer.ts:843-848`, which only makes sense against a quantised
  `startTime`; and measured across every valid sample ever recorded in this worktree: `{bounded, 16}`
  x1, `{exact, 24}` x4, `{exact, 32}` x3 — **not one non-multiple of 8.**

**Therefore the 16.67 ms budget admits exactly one passing value, 16, and the next reachable value, 24,
fails.** The 0.67 is decoration; any threshold in (16, 24] behaves identically. A reading of 32 does NOT
mean "32 ms of work" — it means the 3rd-worst of 40 keystrokes fell in [28, 36) ms, roughly two frames
at 60 Hz, i.e. ONE MISSED FRAME. The step 24 -> 32 is one bucket, not 8 ms of new work. And the
duration includes waiting for the next rendering opportunity, so a zero-work keystroke arriving just
after a vsync boundary consumes most of a frame before it can round to 16.

**What the p95 is over:** 40 keystrokes in a single stream run (`agent-stream-scenario.ts:52`), spread
evenly across the replayed window and interleaved with the lifecycle PATCHes so each lands during
streaming. `rank = ceil(40*0.95) = 38`, so the reported value is the **3rd-largest** keystroke latency;
the headline is then the MEDIAN across runs (`agent-app-benchmark.ts:290-292`), which is why the
archive shows 32/32/32 and 24/24/24 with zero spread.

**And the gate does not interact with the surface it is named for.** The probe is
`page.keyboard.press("ArrowDown")` (`agent-stream-scenario.ts:73`), dispatched to whatever holds focus
— which the preceding activation handed to the COMPOSER (`navigation-row.tsx:74-77` ->
`session-navigation-list.tsx:80` -> `composer-focus.ts:56-79`, focusing
`[data-component="prompt-input"]`). Tracing the keystroke: `editor-keymap.ts:161-172` ->
`history-controller.ts:140` -> `history.ts:251-255` returns `handled:false`, so no `preventDefault` and
the browser performs a default caret move in an empty contenteditable. It is a deliberately trivial
keystroke measuring MAIN-THREAD CONTENTION during streaming — a legitimate INP-style probe, but a
contention proxy for the streaming surface rather than a measurement of it. No event is ever dispatched
at the session timeline.

**What is NOT claimed:** that the app is fine. 32 still says 3 or more of 40 keystrokes waited about
two frames during streaming, which is a real responsiveness signal, and 24-vs-32 is a genuine
one-bucket difference. What is unsound is treating 32 as a 15.3 ms overshoot of a 16.67 ms budget, or
expecting any optimisation to produce a reading like 18.

**This is the third gate found to be measuring something other than its name**, after warm switch
(20/20 cold mounts, 30.6 ms instrument floor above a 20 ms budget) and terminal input (a 64 KiB gate
discarding correct echoes).

### Stream p95: the dominant signal is the LANE, not the build — and the gate has passed 11 times

Segmented from source plus all 411 `attempt.json` files on disk (absolute paths, counts sanity-checked).

**The reachable value set, MEASURED across n=125 exact observations:** 16 x4, 24 x40, 32 x69, 40 x11,
48 x1. **Zero non-multiples of 8.** The harness contributes no arithmetic — `entry.duration` is stored
raw and `percentile` returns an observed element with no interpolation, verified by executing the real
function. So the rung is 8 ms and the metric CAN take 24 — it does so 32% of the time. "32 = 2x16 = one
missed frame" is the wrong reading; 32 is the 4th rung of a 5-rung ladder.

The >=16 floor is enforced THREE times independently: `durationThreshold: 16` on the observer, a JS
re-filter, and a validator that invalidates the whole sample if any entry is under threshold. And the
"p95" is a left-censored order statistic: rank 38 of 40, so the reported value is the **3rd-LARGEST of
40 keystrokes**. PASS therefore means "at most 2 of 40 exceeded the 16 ms bucket".

**THE GATE HAS PASSED 11 TIMES out of 132 valid observations** — it is not a hard floor. Passing runs
include `composite-stream-{1,2,3}` at 16, and `AC-bootstrapfix-stream-{1,2,3}`, `AC-worker-all-5`,
`AC-ccache-3`, `AC-ccache-off-2` as bounded.

**The strongest signal in the entire dataset is which LANE ran, not which build:**

    stream-only lane (`--profiles conversation-rich-v1`):  median 24,  7/27 pass
    multi-profile lane (`--profiles all`):                 median 32,  4/105 pass
    Fisher p = 0.0014,  Mann-Whitney p = 6.5e-07

And it reverses within the same tree, same window, minutes apart:

    tree 75981f8f, 17:51-17:53:  all = 32, then stream/stream/stream = 24, 24, 24
    tree 3327e296, 20:16-20:23:  all = 32, 32, then stream x3 = ALL BOUNDED (pass), then all = 32

That is not drift and not a build effect — it is a whole-run bucket shift that follows the lane. Two
source-level mechanisms are available and were NOT separated: `measureWarmSwitches` calls
`revealSessionRows` for ALL 20 sessions, so the multi lane's rail holds 20 paginated rows before the
stream starts; and history navigation has already expanded the same session's timeline (20 -> 217 rows,
2,862 -> ~34,400 px), so the stream replays into a far heavier surface.

**CORRECTION to an earlier claim in this document:** the note that the replay "PATCHes parts to their
FINAL content, so only the first replay in a process mutates the DOM" is NOT supported by the corpus.
The materializer creates each part at its FINAL text, and the stream applies 2 revisions per part —
revision 1 TRUNCATES (167 -> 83 chars) and revision 2 restores. Every replay performs 40 truncations
and 40 restorations; it is idempotent in end state, not in DOM mutations.

**`stream.blocked_frame_ratio_pct` cannot corroborate anything.** It is 0.000 in all 144 attempts
including the run that scored 48, because LoAF only emits above 50 ms — invisible to a 24-48 ms
interaction. Its only content is "no animation frame exceeded 50 ms".

**Still unknown:** which element held focus during the 40 probes, in ANY run — the harness records
event counts and content match but never asserts `activeElement`, and the focus-handoff code that would
determine the answer is uncommitted working-tree state.

### Cross-host corroboration of the compile cache on a Linux arm64 screening box

A `c7g.2xlarge` (Graviton, aarch64, 8 vCPU) was brought up as a server-side screening host — no
display, so no renderer gate can be measured there, but the engine import is pure Node.

    engine import, cold (fresh cache dir):  1257.8 / 1257.5 / 1263.6 / 1254.7 / 1258.4   median 1257.8
    engine import, warm (populated cache):   913.4 /  919.7 /  908.2 /  900.1 /  921.8   median  913.4

**Delta ~344 ms**, against 134.3 ms measured on the packaged Mac. The mechanism reproduces on a second
architecture and a second OS, which is stronger evidence for the compile cache than either host alone —
and it validates using a cheap remote host to SCREEN algorithmic reductions, while absolute gate values
stay on the reference machine.

## CORRECTION 2: the v5 headline dropped a VALID sample, and terminal output did not pass uniformly

Re-derived from `summary.json` rather than from this document's own prose:

    AC-postrevert-all-1  cold_ready 1975.271  validSamples 1  excludedInvalidSamples 0  | output 19.153  passed:false
    AC-postrevert-all-2  cold_ready 4984.696  validSamples 1  excludedInvalidSamples 0
    AC-postrevert-all-3  cold_ready 1867.228  validSamples 1  excludedInvalidSamples 0  | output 20.840  passed:true
    AC-postrevert-all-4  cold_ready 1753.242  validSamples 1  excludedInvalidSamples 0  | output 20.849  passed:true

**The 4,984.7 ms run was VALID** — the harness classified it valid and excluded nothing — and it was
dropped from the headline range anyway. The honest median of the four valid samples is **1,921.2 ms**,
so the gap is **171 ms, not 125**. And `terminal.output_mib_s` passed 2 of 3 valid runs, not 3 of 3.

Both errors are small and both point the same way: toward the flattering number. That is the second
time in this effort the same bias has been caught in this document, after the withdrawn rail-clock win,
and the second time it was caught by re-deriving from artifacts rather than by re-reading prose.

## The cold-ready target has been the WRONG HALF of the boot all along

Re-derived from `run/cold-ready-diagnostics-000-*.json` across 8 runs (`AC-postrevert-all-{1..4}`,
`AC-composer-{1..4}`), shape reproducible:

    spawn -> renderer timeOrigin        196.6-265.2   (median ~213)
    timeOrigin -> globalSync.ready      309.6-355.1   (median ~321)
    ready -> sessionList dispatch       ~35
    sessionList dispatch -> response    396-482       <- the engine-load wave (KNOWN, and now CLOSED)
    response -> first row visible       ~35-50
    first row visible -> cold ready     726.5-1,013   <- 41-44% OF THE METRIC, NEVER ATTACKED

In `AC-composer-2` (a fast 1,768.6 ms run): row visible at 783.5, last blocking response at 1,438.9,
cold ready ends 1,567.6 — so **655.4 ms is the renderer waiting on the server for session content**
after the first row is already on screen, plus 128.7 ms of activation and harness tail.

**28 boot requests sum to 8,780 ms of duration inside a 1,137 ms wall window — mean concurrency 7.6,
max 13.** That is request serialisation on a single-threaded server, and it is the largest named,
evidenced, un-attacked cost in the entire effort: **655 ms of headroom against a 171 ms gap.**

The engine wave is closed by three independent proofs — pre-load is zero-sum (+371/-363, net +21), the
worker transport measured +129 ms and +130 MiB, and the compile cache's whole mechanism budget is
134.3 ms of which the cold-ready share is statistically unsupported (permutation p = 0.262). The second
wave is a DIFFERENT mechanism and nothing has touched it.

MEASUREMENT WARNING that governs any attempt: the population IQR is 283 ms and the right tail reaches
5,099.6 ms. **The gap is smaller than the noise.** Any claim needs n>=15 per arm and a stated robust
test.

### Server-child boot inventory, measured on the shipped artifact under the shipped Electron

Probed by extracting the server bundle from the packaged `app.asar` and running it under the shipped
Electron in `ELECTRON_RUN_AS_NODE` with the production execArgv — same V8, same flags, same bytes.
A/B interleaved within one session window. Medians.

| # | item | cost | cacheable? |
|---|---|---:|---|
| R1 | engine module import (23 MB) | **276.5 ms** | compile portion GONE (436.3 -> 280.5 unseeded vs seeded) |
| R2 | engine FIRST-REQUEST bootstrap, global (a 404 pays it in full) | **126.5 ms** | no — not compile |
| R3 | engine FIRST-REQUEST bootstrap, per-directory | **105.8 ms** first dir, **357.4 ms** second | no |
| R4 | server bundle static closure compile+link+eval (9.11 MB) | **114.3 ms**, of which **41.0 ms is pure V8 compile** | **YES but currently impossible — see below** |
| R5 | top-level EVALUATION of index.js's own 7.8 MB chunk | **53.6 ms** | no |
| R7 | `startLocalServer` end to end | 28.5 ms fresh / 15.3 ms pre-migrated | — |
| R8 | `getRuntimeConfigSnapshot` per workspace runtime | 23.7 ms first, 0.35 ms after | — |
| R9 | compile-cache seeding | 1.3-3.6 ms | pays for itself 40x |

**THE 41 ms IS UNCACHEABLE PURELY BECAUSE OF STATEMENT ORDER.**
`claxedo-server-entry.ts` imports at lines 6-11 and calls `enableOpenCodeCompileCache` at line 23 —
inside the module BODY. Node compiles and links the entire static ESM graph BEFORE any module body
runs, so the 9.11 MB is already compiled by the time the cache is switched on. It can never be cached,
on launch one or launch fifty. Corroborated by the shipped manifest: exactly ONE entry, `node.js`,
2,829,756 B. Nothing of the server bundle is in it. Measured saving if the cache were active before the
graph loads: **41.0 ms** (114.3 -> 73.3), with the other three phases moving 0.5 / 0.1 / 2.2 ms — a
localised cost, not drift.

**The second-largest non-import item is the engine's own first-request bootstrap (R2+R3 = 232.3 ms) and
it is entirely opaque.** A request to `/__nope__` returning 404 costs 126.5 ms, so it is not route work
— it is whatever the engine instantiates behind `Server.Default().app.fetch` (`Server.Default()` itself
is 0.09 ms). Per-directory bootstrap costs again per directory, and the SECOND directory was
consistently LARGER (349-383 ms across 4 runs) on EMPTY git repos. The engine bundle mentions
models.dev 43 times, so a network fetch on this path is plausible but UNVERIFIED.

**Structurally redundant work found on the boot path:**
- The schema is created TWICE every boot: `db.ts:214` applies the 37-migration journal, then
  `db.ts:219` calls `repair(sqlite)`, which re-executes 14 `CREATE TABLE IF NOT EXISTS` + 20
  `CREATE INDEX IF NOT EXISTS` plus ~21 further DDL statements for schema the journal already applied
  and `__claxedo_migrations` already records — plus 11 `hasTable` probes, 5 more on one table, 6
  `PRAGMA table_info`, and two UNCONDITIONAL full-table UPDATEs.
- The migration SQL is READ before anyone checks whether it is needed: `resolveMigrations()` does
  readdirSync + 37 `readFileSync` every boot, and only afterwards does `applyMigrations` read
  `__claxedo_migrations` and skip all 37.
- The session inventory is materialised twice on the cold path, and `reconcileSessionMetadata` is
  AWAITED inside `ensureEmbeddedWorkspaceRuntime` before the first workspace response.

**AND THE HONEST GAP, stated by the author rather than papered over:** everything measured sums to
~740 ms (232 ms process-start-to-listening + 509 ms engine-to-first-answer) against ~1,530 ms
attributed to the server child. **~790 ms is unaccounted for.** The named candidates — none measured —
are `createWorkspaceRuntimeApp` building a second Hono app and RuntimeStore per workspace, request
SERIALISATION (segment count x per-request latency is a different quantity from per-request cost, and
this inventory bounds only the latter), and the main process's pre-fork work including a shell-out to
locate `claude`.

**Caveat that dominates everything above:** warm OS page cache. One cold-page-cache run cost 920 ms of
import versus ~207 ms warm, and it is not known which state the benchmark sees.

### RSS: the metric double-counts shared pages, and ~540 MiB of the "floor" is residue from earlier scenarios

Read out of this tree's own 379 recorded launches with `processOwnership`, plus source.

**What the metric actually is.** `idle-process-family.ts:83` sums `ps rss` across the process family,
and `ps rss` on macOS charges shared, file-backed resident pages to EVERY process that maps them — the
191,431,024-byte Electron Framework is mapped by all five processes and can be counted up to 5x.
`agent-metrics.ts:156` then takes `Math.max` of a 1 Hz sample with **no percentile**, unlike quiescent
CPU which uses p95 at :159. And `agent-app-benchmark.ts:155` gives the RSS scenario **zero settle**
(only `resource-quiescence-v1` settles 15 s), while `agent-claxedo-driver.ts:531-540` has it run
`measureWarmSwitches` across all twenty sessions.

So the gate is: the single highest 1 Hz sample of a shared-page-double-counted sum, with no settle and
no GC, while the app actively switches 20 sessions, in a process that has already run cold open, warm
switch, history, controlled stream and a >= 20 MiB/s terminal workload. **It is a high-water committed
number, not a working set** — which is the mechanical reason removing 93% of a measured allocation
moved it by -1 to -15 MiB and a forced-GC discriminator returned hundreds of MiB against a flat live
set.

**The floor, measured across 379 first-snapshots** (immediately after launch, before any scenario):
total min 976.7 / median 1054.4; non-renderer min 676.0 / median 745.3; renderer min 287.9. **Zero of
379 runs were ever below 650 total, and zero below 650 non-renderer.**

**And ~540 MiB of the observed peak is not architecture — it is residue.** Cohort split of 109 valid
RSS samples:

    resource-core-v1 ALONE (n=4)      min 1362.9  median 1380.2  max 1461.3
    full four-profile suite (n=105)   min 1386.8  median 1932.3  max 2295.2

Per-process medians, isolated -> full: renderer 646.9 -> 1144.3 (**+497.4**), server 359.2 -> 374.6,
main 212.9 -> 217.0, GPU 114.4 -> 131.4, utility 50.1 -> 51.1. **92% of the +540 MiB is renderer memory
that the three preceding profiles committed and Chromium never returned.** Shape screen: not drift
(drift moves all five processes) and not a constant ratio — a large absolute shift concentrated in ONE
process.

Stated caveat: the isolated cohort is n=4 and this is a COHORT comparison, not a paired A/B. It should
be re-run as a proper pair before anything is claimed from it.

Also corrected: quoting 130.5 MiB as the GPU floor overstates it — the GPU warms ~105 -> ~136 MiB with
paint, so the cold first-snapshot non-renderer breakdown is main 200.1 / GPU 105.3 / utility 49.9 /
server 391.6 = 747.

**The verdict does not change — 650 MiB is unreachable — but the reason is now precise: ~1,380 MiB of
architecture plus ~540 MiB of un-returned per-scenario residue, measured against a budget that itself
counts shared pages up to five times.**

### RSS part 2: the renderer is SIX isolates, wasm is GC-immune, and the metric's detection limit is ~198 MiB

**THE NOISE FLOOR EXPLAINS SIX DEAD CANDIDATES.** Pooled within-family replicate SD, computed from 16
repeated run families (n=72): **50.0 MiB**. Minimum detectable effect for a 1-vs-1 paired run:
**~198 MiB**; n=3 per arm ~114 MiB; n=5 per arm ~89 MiB. **A -1 to -15 MiB result is 3-15x BELOW the
single-run detection limit — those were not null results, they were UNMEASURABLE ones.** And the gate
needs 1,272 MiB (1,922 -> 650), i.e. **25 replicate SDs**.

**The renderer is not one heap — it is up to SIX V8 isolates in one pid:** the main thread plus five Web
Workers (`session-ui/src/components/markdown-worker.ts:70`, a module-level singleton that is NEVER
terminated; `session-ui/src/pierre/worker.ts:8,12,31-34`, two pools of 2 which ARE ref-counted).
Worker heaps land in the renderer's RSS. This mechanically explains **both** previously-disproven
observations:

- "forced GC returned hundreds of MiB while the live set was flat" — a forced GC on the main thread
  reaches only the MAIN isolate; the other five GC independently and were untouched.
- "removing 93% of a measured allocation moved peak by -1 to -15 MiB" — the renderer runs Chromium V8
  DEFAULTS (**no `--js-flags` are set anywhere**; the app sets exactly two Chromium switches,
  `proxy-bypass-list` and a dev-only `disable-http-cache`), so young-gen semispace capacity is fixed by
  V8 rather than by allocation rate. And **wasm linear memory is not on the GC heap at all**: the
  oniguruma module inlined at `assets/wasm-DDgzZJey.js` declares initial 256 pages = **16.00 MiB**, max
  2048 MiB, decoded directly from its Memory section. `memory.grow` is ONE-WAY, fully committed, and it
  is imported by the main thread AND both worker families — a **>= 32 MiB hard, permanent, GC-immune
  step** as soon as one code block renders.

**Genuinely retained, unbounded structures:** the TanStack query cache has a 30-minute time-based
`gcTime` with NO entry cap and NO byte cap, and `conversation-registry.ts:41-45` states that eviction
"loses no data: the message snapshot persists in the query cache" — so LRU eviction MOVES transcripts
rather than freeing them, and the 2 MiB cap in `persister.ts:65` is a DISK cap giving false comfort.
xterm keeps `scrollback: 5000` per activated terminal with the retention budget freeing only the WebGL
addon — 4.58 MiB (80 cols) to 17.17 MiB (300 cols) per terminal, unfreeable. And 8.61 MiB of shiki
grammar chunks are emitted TWICE, once per graph, so the same grammars compile into two isolates.

**The forked-worker A/B, recovered from the artifacts:** engine in-process (n=373) server child median
393.9; engine in worker (n=6) server child 171.4 + worker 338.5 = 509.9. So the **in-process engine
share is 222.5 MiB**, the server child without it is 171.4, and splitting costs **+116.0 MiB net** —
the per-process Electron-as-Node tax, measured rather than argued, independently confirming the
measured three-gate regression.

**Process identities, from recorded argv:** main 200.1 cold / 217 warm with an RSS range of under 8 MiB
across 379 wildly different runs — that tightness proves it is Chromium browser-process baseline, not
the 1.4 MB payload. GPU 105.3 cold / ~131 warm with zero app payload (calibration: VS Code's GPU
process on the same host is 63.1 MiB, so ~40 MiB is app-side, and one full-window RGBA layer at
2560x1600 is 15.62 MiB). Utility 49.9 across all 379 runs, `network.mojom.NetworkService`, zero app
payload. The five-process shape is **100% Electron default**.

The server child is the SAME "Claxedo Dev" Mach-O as main, forked with `ELECTRON_RUN_AS_NODE=1` — not
bun, not node, not a `utilityProcess`. So there is no "already-loaded Node runtime" to share: Node
runtimes are per-process and the 191 MB framework text is already mmapped with main. **A
`utilityProcess` buys lifecycle ergonomics, not RSS.**

## THE M9 BUDGET APPEARS TO BE A UNIT ERROR IN THE PLAN, AND IT IS CHECKABLE

Peer calibration, measured LIVE on this host against already-running unrelated apps (`ps` + `vmmap`,
nothing launched):

| product | family sum of `ps rss` (= the gate's own metric) | macOS physical footprint |
|---|---:|---:|
| Claude.app (9 processes) | **984.0 MiB** | 628.6 MiB |
| VS Code (1 window, 1 workspace, 11 processes) | **1,365.0 MiB** | 1,175.7 MiB |
| Claxedo | 1,380 isolated / 1,922 full suite | not measured |

**Neither peer meets 650 on this metric**, and the lightest — Claude.app at 984 MiB — has no local
server child, no terminal, and no in-process 23 MB agent engine. The plan itself records the competitor
T3 at **1,402.75 MiB** on this metric and corpus (`plan:41`), with Claxedo at 1,473.11. **650 MiB is 46%
of what the competitor achieves.**

**And the number appears to have come from a different unit.** The prior-evidence ledger measures memory
in NATIVE PHYSICAL FOOTPRINT throughout: ledger entry 4 "approximately 24 MiB native-footprint win",
entry 5 "approximately 154 MiB native-footprint win" (`plan:730-731`). The value 650 appears nowhere in
the summed-RSS series and almost exactly twice in the footprint series (651, 640), and V12 recorded
"358 MiB native physical footprint; 726.3 MiB summed RSS" for the same five owned processes — a 2.0x
ratio. Measured peer ratios on this host: Claude 1.57, VS Code 1.16.

The plan is also internally inconsistent about this gate: `plan:41` annotates the 280.55 MiB marker
"Below the observed Electron non-renderer floor. Requires a topology or shell change, not cache tuning
alone", `plan:308` calls 280 MiB "an alternate-topology moonshot, not a cache-cleanup promise", and R22
(`plan:85`) explicitly exempts M9 from the five-times claim "under the current Electron topology unless
a measured architectural floor below T3/5 is established" — yet R21 (`plan:84`) and
`targets/five-times.json` carry 650 as an absolute release budget.

INFERENCE, labelled as such and checkable in one place — whoever wrote R21: **the 650 was derived under
native physical footprint and then applied to a summed-`ps rss` metric that reads 1.6-2.0x higher on the
same app.** The double-counting is real but does not by itself rescue the budget: summing the Electron
Framework's per-process resident bytes across Claude.app's 9 processes gives 391.6 MiB of `ps rss`
charged for pages whose union is at most ~81 MiB, so for Claxedo's 5 processes roughly 150-250 MiB of
the 1,900 is the same physical pages counted repeatedly — about 10%.

**The architectural floor, from measured anchors:** utility ~50 (no supported removal; in-process merely
relocates it), GPU ~65 plausible (VS Code measures 63.1 here), main ~150 plausible (VS Code 171.5,
Claude 279.1; the payload is 1.4 MB), server child ~240 plausible (171.4 is the measured non-engine
remainder, and the 222 MiB engine share shrinks only by shrinking the artifact — splitting it out
measured +116 MiB). Best-case non-renderer **~505 MiB**, leaving ~145 MiB for a renderer whose measured
cold minimum across 379 launches is 287.9 MiB and which pays a >= 32 MiB permanent wasm step on the
first code block. **Plausible architectural floor: ~855-955 MiB.**

**Proposed budget: ~900 MiB (write 950 to leave one replicate SD of margin), with the sweep run in
isolation.** It sits below both peers measured on this host, below the competitor's 1,402.75 on the same
corpus, and ~30% below the current isolated 1,380 — defensible against real products rather than against
an arithmetic marker. If 650 is kept, the honest alternative is to change the metric to macOS
`phys_footprint`, where the ledger already recorded 358 MiB — but that is a contract change and must be
argued, not slipped in.

Ranked next actions on this gate: settle the isolated-vs-full carry-over as a real paired A/B (n>=3, and
note it makes the METRIC cheaper rather than the product lighter, so it is a scope contract decision);
run a per-isolate renderer census by postMessage, reporting `WebAssembly.Memory.buffer.byteLength` per
isolate; try renderer `--js-flags`, the one lever with a measured precedent here (the same lever on the
server child is ledger entry 5, -154 MiB, the largest accepted causal result in the ledger, and the
renderer has NO flags today) while measuring stream and blocked-frames for the GC cost; route all
highlighting through the single worker and delete the main-thread `getSharedHighlighter` path; byte-cap
the query cache. **Do NOT retry the engine-worker split: measured +116 MiB, and peak-max semantics mean
a later-exiting worker cannot help this metric in principle.**

### The tree ALREADY SHIPS a physical-footprint instrument, and the harness does not call it

`packages/claxedo-desktop/resources/diagnostics/macos-memory-impact.c` is a 622-byte C program that
calls `proc_pid_rusage(pid, RUSAGE_INFO_V4, &usage)` and prints `ri_phys_footprint` — the authoritative
macOS number, the one Activity Monitor's "Memory" column shows, which EXCLUDES clean shared file-backed
pages and INCLUDES compressed pages. The built binary is PACKAGED to
`Contents/Resources/diagnostics/macos-memory-impact` and is wired at `main/index.ts:146` ->
`process-metrics-worker-runtime.ts:103` -> `{ kind: "physical-footprint", bytes }`.

**The authoritative producer for the number the plan's budget appears to be denominated in already
exists in this repository, already ships, and the benchmark simply does not call it.**

Validated against the OS on already-running unrelated families: helper 623.7 vs `vmmap` 628.6 MiB for
Claude.app (0.8% agreement), 1170.5 vs 1175.7 for VS Code (0.4%).

**Measured overstatement of summed `ps rss` versus true physical footprint:**

| app | procs | sum ps_rss | sum phys_footprint | framework-resident | ratio |
|---|---:|---:|---:|---:|---:|
| Claude.app | 9 | 984.0 | 623.7 | 391.6 | 1.578 |
| VS Code | 11 | 1,365.0 | 1,170.5 | 567.8 | 1.166 |

Two real effects fight each other: `ps rss` OVERSTATES because shared framework pages are charged to
every mapping process, and UNDERSTATES because it omits compressed pages that `phys_footprint` counts.
That is why the ratios differ so widely — Claude is idle and lightly compressed; VS Code has been up for
days with ~373 MiB compressed.

**Estimated for Claxedo** (model; every anchor measured, the application of peer per-role framework
residency to Claxedo's five processes is not):

    boot first snapshot      ps_rss 1054.4   ->  ~785 MiB physical   (1.34x)
    isolated resource sweep  ps_rss 1382.1   -> ~1112 MiB physical   (1.24x)
    full-suite peak (gate)   ps_rss 1922.2   -> ~1652 MiB physical   (1.16x)

**So the gate overstates physical memory by an estimated ~270 MiB, ~14% at the peak. The metric's name
is wrong and the plan amendment needs that sentence — but it does NOT rescue the budget.** The family
still consumes an estimated ~1.65 GiB of real physical memory at the measured peak, 2.5x the 650 MiB
target. And counterintuitively the artifact is SMALLEST for Claxedo, because the double-count scales
with PROCESS COUNT and Claxedo has five where the peers have nine and eleven; Claxedo's expected ratio
(~1.16) matches VS Code's measured 1.166, not Claude's 1.578. **Anyone hoping the shared-page argument
closes a 1,272 MiB gap should stop: it closes ~270 of it.**

**Converting this from inference to measurement is one additive harness change.**
`agent-process-family.ts:14` `readProcessTable()` spawns only
`ps -axo pid=,ppid=,rss=,time=,lstart=,command=`. Adding a second spawn of the already-packaged helper
with the discovered pids, and carrying `physFootprintBytes` alongside `rssBytes` through
`ProcessSnapshot` -> `IdleProcessRow` -> the observation, reports BOTH series in `attempt.json`. It is
read-only, additive, cannot alter product behaviour, and it converts every figure in this section to
measurement on the very next run.

### The reachable RSS number: 950 MiB, derived per process — and the A/B that would settle the carry-over

**Per-process derivation on the gate's own metric, sweep run in isolation:**

| process | today (cold) | irreducible | app-side | floor target | what would have to change |
|---|---:|---:|---:|---:|---|
| utility (NetworkService) | 49.9 | ~50 | 0 | 50 | NOTHING — zero app payload, 49.5-50.2 across 379 runs; no supported API removes it |
| gpu | 105.3 | ~65 | ~40 | 65 | window/raster only (VS Code measures 63.1 here today; one full-window RGBA layer at 1280x800@2x is 15.62 MiB). NOT `--in-process-gpu` — it relocates into main and attacks stream/terminal |
| main | 200.1 | ~150 | ~50 | 150 | payload is 1.4 MB and RSS varies < 8 MiB across 379 heterogeneous runs, so it is Chromium baseline, not payload |
| server child | 391.6 | ~116 | ~275 | 240 | shrink/lazy-split the 23,066,529-byte engine artifact; `cache_size=-64000` is 64 MiB per connection across TWO sqlite stacks with no `mmap_size`; stop opening `ClaxedoDB.raw()` eagerly. NOT relocation — splitting measured +116 MiB |
| **non-renderer** | **747** | **~381** | **~365** | **505** | |
| renderer | 287.9 cold / 646.9 sweep | ~180-260 | rest | ~400 | set `--js-flags` (none today); route ALL highlighting through the one worker to delete a 16 MiB+ one-way wasm memory and 8.61 MiB of duplicated grammar compile from the main isolate; byte-cap the query cache; release xterm BUFFERS, not just the WebGL addon |
| **TOTAL** | | | | **~905** | with everything going right |

**Proposed budget: 950 MiB** (one conservative replicate SD above ~905). It beats every shipping peer
measured on this host today — Claude.app 984.0, VS Code 1,365.0 — and the competitor T3 at 1,402.75 on
the same metric and corpus, while sitting ~31% below Claxedo's current isolated 1,382. **650 is 46% of
what the competitor achieves and below the floor of an app with no UI in it** (non-renderer minimum ever
recorded: 676.0 MiB across 379 launches).

**CORRECTION to the earlier noise-floor figure, issued by its own author:** pooled SD 50.0 MiB hides
real heterogeneity — the 16 replicate families run 3.8 to 103.2 MiB SD (median 19.1, p90 95.9). Size
experiments on the CONSERVATIVE SD=100, not 50:

    MDE (alpha .05, power .80) = 2.80 * SD * sqrt(2/n)
      SD=50    n=3: 114   n=4: 99    n=5: 89  MiB
      SD=100   n=3: 229   n=4: 198   n=5: 177 MiB

**The paired A/B, specified for execution:** arm A `--profiles resource-core-v1`, arm B `--profiles all`,
n=4 per arm, **INTERLEAVED A,B,A,B,A,B,A,B in one session window** — alternation defends against thermal
and host drift, which a blocked AAAA/BBBB design cannot separate from the effect. Identical build
(assert the same `provenance.executable` sha256), corpus digest, seed, targets and power state; vary
ONLY `--profiles`. Read-out: difference of MEDIANS with a bootstrap 95% CI (10k resamples) — medians
because peak RSS is a `Math.max` statistic and right-skewed. **Pre-registered claim:** "scenario
carry-over into the RSS window is at least 300 MiB" is SUPPORTED iff the CI lower bound exceeds 300,
REFUTED iff the upper bound falls below 300, UNRESOLVED otherwise — stated in those words, with an
unresolved result never converted into a null. Mandatory secondary: decompose every run's peak ownership
snapshot per process; the prediction is renderer +497, server +15, main +4, gpu +17, utility +1, and **if
the delta is not ~92% renderer the carry-over explanation is wrong and must be withdrawn rather than the
headline kept.**

**What the result would and would not licence, in the author's own words:** it licences "the RSS gate's
window is contaminated by ~X MiB committed by earlier scenarios and not returned", and therefore a
decision about whether the RSS scenario should run on a fresh app. **It does NOT licence "we reduced
memory by X" — running the sweep in isolation makes the MEASURED WINDOW cheaper without making the
product lighter by a single byte.** That is a metric-scope contract change and must be argued as one, in
the open, with the number attached. And if the whole-suite window is kept, then ~1,900 is the honest
number and the budget must be set against it, not against 1,380.

## MEASURED: the RSS carry-over is 716 MiB, and physical footprint is now recorded

Interleaved A,B,A,B,A,B,A,B in one session window, one build, varying only `--profiles`.

    A  --profiles resource-core-v1   1167.0 / 1049.5 / 1207.8 / 1145.0   median 1156.0
    B  --profiles all                1880.3 /   n/a   / 1872.0 / 1742.6  median 1872.0

**B - A = 716.0 MiB.** The pre-registered claim was "carry-over is at least 300 MiB" -> **SUPPORTED**,
and by more than double the threshold. It also exceeds the cohort-based prediction of ~540 MiB.

**Mandatory per-process decomposition** (peak ownership snapshot, MiB):

    AB-carry-A-1  total 1168.8   renderer  584.3   main 323.5   server 261.0
    AB-carry-A-3  total 1203.2   renderer  503.2   main 377.6   server 322.5
    AB-carry-B-1  total 1854.2   renderer 1143.9   main 381.6   server 328.6
    AB-carry-B-3  total 1855.0   renderer 1112.6   main 410.1   server 332.4

The renderer roughly DOUBLES (503-584 -> 1113-1144, about +570) while server and main move ~+60 and
~+40 combined. That is ~85-90% renderer, close enough to the pre-registered "~92% renderer" that the
carry-over explanation stands rather than being withdrawn.

**And the harness now records `physFootprintBytes` alongside `rssBytes`** — the additive change landed
and the field is present per process in every snapshot. First measured ratios (summed ps_rss / summed
phys_footprint at peak):

    A-1  1168.8 / 1502.1 = 0.778      A-3  1203.2 / 1244.6 = 0.967      A-4   991.0 /  989.7 = 1.001
    B-1  1854.2 / 1713.9 = 1.082      B-3  1855.0 / 1643.3 = 1.129      B-4  1744.3 / 1784.9 = 0.977

**The predicted ~1.16 ratio is not confirmed** — the measured spread is 0.78 to 1.13, and three runs
have footprint HIGHER than summed RSS. That is compatible with the mechanism as described (RSS
overstates via shared pages but UNDERSTATES by omitting compressed pages, and the two fight), but it
means the "~270 MiB overstatement, ~14% at peak" model is NOT supported as stated. The honest reading
of six runs: at peak, summed RSS and physical footprint agree to within about 13% in either direction,
so the double-counting argument does not reliably move the number and cannot be used to argue the gate
overstates memory.

**What this licenses and what it does not.** It licenses the statement that the RSS gate's window is
contaminated by ~716 MiB committed by earlier scenarios and never returned, and therefore a decision
about whether the resource sweep should run on a fresh app. It does NOT license "we reduced memory":
running the sweep in isolation makes the MEASURED WINDOW cheaper without making the product lighter by
one byte. That is a metric-scope contract change and must be argued as one.

### Server-bundle compile cache: shipped, mechanism confirmed in the packaged app, gate unmoved

The 41 ms of server-bundle compile that was uncacheable by statement order is now cacheable. The entry
became a tiny boot stub that seeds and then `await import()`s the real entry, so the 9.11 MB product
closure sits behind a dynamic boundary and can be cached; index.js went 7,852,992 -> 4,308 bytes with
total output unchanged.

**Verified in the real artifact, not inferred:** `Resources/claxedo-server-compile-cache` ships a
manifest with 24 entries (25 files, 4,165,980 bytes); the asar contains `claxedo-server-boot`,
`seedShippedCompileCaches` and `CLAXEDO_CHILD_SERVER_COMPILE_CACHE_DIR`; and inside a real benchmark
run's FRESH data dir:

    AC-sbc-ON-5  .../claxedo-data/opencode-compile-cache/v24.18.0-arm64-ff1546d9-501  -> 25 files, 6,991,676 B
    AC-sbc-OFF-5 (same binary, shipped dir moved aside)                               ->  1 file

**Same-binary A/B, interleaved ON/OFF six times each:**

    ON   2632 / 1999 / 1723 / 1790 / 1784 / 1863   median 1826.4
    OFF  1819 / 1908 / 1811 / 1784 / 1925 / 1830   median 1824.7   delta +1.7 ms

**Nothing.** And the slice's author had written the falsifying condition before the measurement: 35.5 ms
off the server child's boot moves cold ready only if the child is on the critical path for its whole
duration. It is not — the binding constraint is `/provider` at median 1,121 ms, the longest request in
all 7 analysed runs, anchoring the terminal barrier in 5. The compile phase finishes long before that
barrier, so removing 35 ms changes when a request COULD have started, not when the last one finishes.

**Seventh instance in this effort of removing real, measured work and moving no gate.**

Seed cost measured twice on different instruments and agreeing to 0.24 ms: engine-only p50 0.99 ms
(1 entry) versus engine+server p50 6.51 ms (25 entries), so +5.5 ms per launch against 41.0 saved —
**net ~+35.5 ms per cold launch for real users, invisible to this benchmark.** Cost: 4.16 MB of shipped
package size.

Engineering worth keeping from this slice regardless of the gate:
- The packaged server bundle lives INSIDE `app.asar`, and every test originally written for this ran
  against a plain directory — a green suite saying nothing about the shipped artifact, the same "cache
  the harness cannot see" failure in a third costume. Closed with a real asar probe showing that
  asar-internal modules ARE compile-cached, keyed by their asar-virtual `file://` URL, with
  `import.meta.dirname` and `realpathSync` resolving inside the archive.
- The generator caches the 9.11 MB closure WITHOUT starting a server: a module graph is compiled during
  instantiation and node persists entries even when evaluation THROWS, so it imports the deferred chunk
  with the startup env deleted and catches the product's own refusal — with `expectRefusal` taken from
  the producer rather than a copied string, so a build that accidentally BOOTED a server fails instead
  of silently passing.
- Dead end recorded: generating blobs compile-only via `vm.SourceTextModule().createCachedData()` is
  rejected by the runtime (`magic number mismatch: expected 2329926578, actual 3235776198`) because
  node's cache entry is its own container around the V8 blob.

### DIAGNOSTIC ABLATION (invalid as a candidate, informative as evidence): shrinking the models catalogue

`/provider` is the binding constraint on cold ready, and its initializer makes three whole-catalogue
passes over `~/.cache/opencode/models.json` — 3,647,815 bytes, 183 providers, 6,280 models. To bound
how much of the 1,121 ms is catalogue-proportional, `XDG_CACHE_HOME` was pointed at a trimmed copy
(3 providers, 148 models, 102,481 bytes) with the sibling cache files preserved. The harness passes
`...process.env` through to the app (`agent-claxedo-launcher.ts`), so the packaged engine reads it.

    FULL  1747.2 / 1741.2 / 1670.4   median 1741.2
    TRIM  9026.0 / 3621.9 / 3608.7   median 3621.9

**The trimmed arm is 1.9x SLOWER, so the ablation is INVALID as a measure of catalogue cost.** It did
not isolate the variable it was meant to isolate — it changed the engine's behaviour into a slower
path. Recorded rather than discarded, because two things in it are informative:

- `/provider` itself went 901 -> 1,400 ms and the third provider request 452 -> 949 ms, while every
  other route stayed within a few ms (`/api/wr/events` 534 vs 535, `/session` 429 vs 431, usage/sync
  416 vs 406). So the cost really is inside the provider path and really is catalogue-sensitive — just
  in the opposite direction to the one hypothesised.
- ZERO external requests in either arm, so the slowdown is NOT a network fetch to models.dev. Whatever
  the engine does with an incomplete catalogue is local and expensive.
- The terminal barrier moved with it: the last response is `/question` at 1,366 ms in FULL and `/vcs`
  at 3,326 ms in TRIM, which is the barrier behaviour already documented — everything releases together
  after the provider initializer resolves.

**A caution about the FULL arm's own numbers, applying this document's own rule.** FULL measured
1,741.2 median here, against 1,826.4 measured for the SAME build in the immediately preceding window.
That is ~85 ms of between-window drift on identical bytes. It is a reminder that the "171 ms gap" is
itself within about two windows' drift, and that no cold-ready claim survives without n>=15 per arm or
a stated robust test — including a claim that the gate had been reached.

## THE LARGEST TERM IN COLD READY IS A THIRD-PARTY PLUGIN'S UNCACHED NETWORK FETCH

`/provider` is the binding constraint on cold ready. Its split, measured with the app's OWN Effect
tracer (a recording `Tracer.Tracer` installed in a standalone probe, no source edits), n=5, medians:

    InstanceStore.load .................................. 596-676 ms
      Project.fromDirectory ............................. 58-115 ms   (git child processes)
      Config.get ........................................ 25-28 ms
      **Plugin.init == Plugin.state .................... 458-538 ms**  <- LARGEST TERM
    Provider.list (the initializer) ..................... 246-270 ms
      ModelsDev.populate -> readJson .................... 44-66 ms
      untraced synchronous initializer body ............. 194 ms
    handler body ........................................ ~100-120 ms

**The critical path is longer than anyone had modelled.** `/provider` is declared with
`.middleware(InstanceContextMiddleware)`, which runs `store.load({directory})` and AWAITS it before the
handler ever runs — so `InstanceBootstrap` -> `config.get()` -> **`plugin.init()`** is on the
`/provider` path and nobody had it there.

**Bisected inside `Plugin.state`:** `await import("../server/server")` 50-63 ms; ten internal plugins
0.5 ms TOTAL; `PluginLoader.loadExternal` 33 ms; `opencode-supermemory` 19-20 ms; and
**`opencode-antigravity-auth` 366-395 ms.** Read from the installed package, that plugin's constructor
does `await initAntigravityVersion()`, which fetches
`https://antigravity-auto-updater-...run.app` with a 5,000 ms timeout and NO CACHE OF ANY KIND, on
every boot. Measured directly with `curl`: 0.352-0.404 s, n=7 — matching the in-situ 366-395 ms to
within noise. Its declared fallback on timeout is a SECOND fetch to `antigravity.google/changelog`, so
this single term's worst case exceeds 5 s, which is a plausible source of the 2,153 ms `/provider`
outlier and of the run-to-run spread.

**It comes from the user's global config** — `~/.config/opencode/opencode.json` lists
`opencode-antigravity-auth@latest`, `opencode-openai-codex-auth`, `opencode-supermemory@latest`. So
**this effort's cold-ready numbers have included a third-party plugin's network round trip throughout.**

A SECOND boot-time network cost, off the `/provider` path but competing with it: `models-dev.ts:229-232`
forks a refresh at LAYER CONSTRUCTION with `Schedule.spaced`, which runs once immediately; if
`models.json` is past its 5-minute TTL it downloads `models.dev/api.json` — measured `curl` 1.29 /
1.41 / 1.77 s for 3,647,815 B — writes 3.6 MB, and invalidates so the next read re-parses.

**The catalogue passes are real but are only ~15-20% of the request.** Controlled A/B in one window via
`OPENCODE_MODELS_PATH`, n=3 each:

    models  providers   Provider.list   populate   initializer body
      209       9           63.0          39.9         23.1
     2040      49          122.3          49.8         72.5
     6280     183          249.2          55.4        193.8

Constant RATIO across sizes — a real per-unit cost: **28.1 us per catalogue MODEL**, intercept ~17 ms;
per-provider cost is negligible (183 providers x 1 model = 1.25 ms). `toPublicInfo` is the more
expensive of the two named passes because it is `JSON.parse(JSON.stringify(provider, replacerFn))` — a
full serialize+parse round trip with a per-key JS callback.

**Reachable-catalogue waste:** `Provider.list()` returns 10 connected providers = 566 models, **9.0% of
6,280**. About 91% of the `toPublicInfo` pass is discarded — but `fromModelsDevProvider`'s output IS
retained in State and read by the error paths, so only the `toPublicInfo` pass over the unreachable 91%
is straightforwardly dead (~22 ms, up to ~160 ms if the untraced residual is also per-model).

**And the handler walks the catalogue twice MORE**, because the app requests the full list rather than
`view=index`: handler `fromModelsDevProvider` 14.2 ms, `defaultModelIDs` 9.0, `toPublicInfo` 22.4,
`Schema.encode` 47.6, `JSON.stringify` 10.2 — and ships a **4,712,583-byte** response over loopback.
The catalogue is walked FIVE times per cold `/provider`.

**I/O versus CPU, and it settles the barrier question:** ~370-400 ms plugin network + 60-115 ms git
subprocesses are I/O that blocks the response without burning the loop; ~375-390 ms is uninterruptible
main-thread CPU (194 initializer + ~103 handler + 50-63 module eval + 28 config). So the barrier
anchoring is explained by the CPU term and the 986 -> 2,153 ms VARIANCE by the network terms — different
problems with different owners.

**Attempted A/B, INCONCLUSIVE:** pointing `XDG_CONFIG_HOME` at a copy of the config with the `plugin`
key removed gave PLUGINS 1779.5 / 1665.3 (median 1722.4) versus NOPLUGIN 1793.1 (n=1) before the host
dropped to battery and invalidated the remaining six runs on the preflight. **No conclusion is drawn.**
The experiment is specified and must be re-run: n>=8 per arm, interleaved, on AC.

### Correction to this document's own wording on the RSS A/B

The server-bundle compile cache's RSS effect was recorded as "does not survive to product scale". That
is a null presented as a refutation. The measured arms were ON 1319.1/1340.7/1326.8 and OFF
1329.0/1327.9/1166.8 — pooled SD 66.5 MiB, so the minimum resolvable difference at n=3/arm is ~157 MiB
and a 29.8 MiB effect is 0.19x this instrument's resolution. **The honest record is NOT RESOLVABLE AT
GATE SCALE.**

And the structural reason is more useful than the noise: the renderer is >= 83% of the family peak, so
everything that is not the renderer can address at most ~17% of that number, and only if its own peak
lands on the sample that sets the family max. Server-child memory work is **structurally masked**, and
more replicates will not help.

**Two gates, two named binding constraints, neither of them the server child:**

    cold ready   bound by /provider (median 1,121 ms)      -> server-child TIME work is masked
    family RSS   bound by the renderer (>= 83% of peak)    -> server-child MEMORY work is masked

Any future candidate that makes the server child faster or smaller should be EXPECTED to produce a null
on both, and filed with the mask named — not measured, found null, and deleted.

### Harness isolation gap closed: the ambient environment is now pinnable and always disclosed

The launcher isolates the desktop profile, the data directory and the corpus (by SHA) — but it spawned
the app with `env: { ...process.env, ... }`, so the embedded engine read the OPERATOR'S global OpenCode
config, including whatever third-party plugins it installs, inside every measured boot. That is how a
package this product does not own came to spend 366-395 ms on a network fetch inside the binding
constraint of `app.cold_ready_ms`.

Change, additive and reversible:
- `ambientIsolationEnv(isolatedProfilePath)` in `agent-claxedo-launcher.ts` pins `XDG_CONFIG_HOME`,
  `XDG_CACHE_HOME` and `HOME` to an empty directory under the run's own isolated profile.
- **OFF BY DEFAULT** (`CLAXEDO_BENCH_ISOLATE_AMBIENT=1` to enable), so every number recorded before this
  existed keeps exactly the meaning it had.
- `provenance.json` now always records `ambientEnvironment: "isolated" | "operator-ambient"`, because a
  reader cannot otherwise tell which environment produced a number — and the DIFFERENCE between the two
  arms is itself a finding rather than a detail.

Verified: perf-harness `tsc --noEmit` clean, `bun test` 77 pass / 0 fail. No metric computation changed.

The policy question is deliberately left open for the plan owner, with both sides stated: a
qualification benchmark should be reproducible and should measure what the product CONTROLS — Claxedo
cannot optimise a third-party plugin's network round trip — but an isolated number is also not a
user-experienced number, and real users do have plugins. The right answer is probably to publish
isolated as the qualification number and ambient as a disclosed companion, which is now mechanically
possible.

**Pending, and it is the decisive experiment for cold ready:** the plugins-vs-no-plugins A/B, n>=8 per
arm, interleaved, on AC. The first attempt produced PLUGINS 1779.5 / 1665.3 versus NOPLUGIN 1793.1
before the host dropped to battery and the preflight invalidated the remaining six runs. **No conclusion
is drawn from it.**

## CONTAMINATION FOUND: two Playwright e2e suites ran for 3h08m THROUGH packaged benchmark runs

While the host appeared idle, `ps` showed two full Playwright suites alive since 08:22:25 and 08:22:28
— one from this worktree and one from `/private/tmp/claxedo-control-head` (an A/B control tree) — plus
`ms-playwright/ffmpeg-1011` video encoders observed at up to **171% CPU**, and a stale `vite preview`
holding port 4455. Load average at discovery: **11.73** on a 12-core host. They were orphans: the agent
that launched them completed without cleaning up, and killing individual workers only caused the
runners to respawn them.

All of it is now terminated (runners, workers, headless-shell children, ffmpeg, preview server), and
`ps` shows zero remaining.

**Runs that fall inside the contamination window, and are therefore SUSPECT rather than evidence:**

    AC-sbcrss-{ON,OFF}-{1,2,3}      the server-bundle-cache RSS A/B
    AC-plug-{PLUGINS,NOPLUGIN}-{1..4}   the plugin isolation A/B

Fourteen runs. The plugin A/B was already recorded as inconclusive because the host dropped to battery;
it is now doubly so. The RSS A/B was already recorded as NOT RESOLVABLE AT GATE SCALE on its own
arithmetic (pooled SD 66.5 MiB against a 29.8 MiB effect); this is a second, independent reason not to
read it.

**What this plausibly explains, stated as hypothesis rather than conclusion:** the ~85 ms of
cold-ready drift observed between two windows on identical bytes, the OFF-arm RSS outlier at 1,166.8
against two runs near 1,328, and part of the run-to-run variance that has been attributed to the metric
itself throughout this effort. None of that is established — the contamination window is known, but the
counterfactual is not, and it will only be settled by re-measuring on a verified-quiet host.

**Process failure, recorded because the fix is cheap and the cost was not.** The benchmark's own
preflight checks AC power, keep-awake, display configuration and process ownership, and the attempt
records `survivorCount` — but nothing checks that the HOST IS QUIET before a run, and nothing noticed
multi-core video encoding running throughout. A load-average or foreign-CPU precondition in
`agent-host-preflight.ts` would have failed these runs loudly instead of silently widening their error
bars. That is the same class as every other finding in this document: an instrument that reports a
number without reporting whether the number is readable.

**Action:** the plugin A/B — the decisive experiment for cold ready, since a third-party plugin's
uncached network fetch is the largest single term in its binding constraint — must be re-run at n>=8
per arm, interleaved, on AC, on a host verified quiet by `ps` immediately before and after.

### The preflight now refuses a busy host, because it did not before

`agent-host-preflight.ts` already refused to measure on battery, under a thermal or performance
warning, or without an identifiable display — each because it silently widens every metric's error bars.
It did not check whether anything ELSE was using the machine, which is how fourteen packaged runs were
taken at a load average of 11.73 with two orphaned Playwright suites and their ffmpeg encoders running.

Added: `assertQuietHost(uptime)` in the darwin preflight path, with
`QUIET_HOST_LOAD_LIMIT = 4` as a named exported constant rather than a magic number at the call site.
It refuses output it cannot parse rather than assuming quiet, and the threshold is deliberately loose —
meant to catch a machine that is busy, not to arbitrate scheduler noise.

Five tests in `test/agent-host-quiet.test.ts` covering the real `uptime` shapes from macOS and Linux
(including the comma-decimal locale form), acceptance of a quiet host, refusal of the exact observed
condition with the load quoted in the message, refusal of unparseable output, and the constant itself.
The existing preflight test's `HostCommands` stub was extended to answer `uptime`, since "requires
known AC, nominal thermal, stable display" is now also "and a quiet host" — the fixture had to learn
the new precondition rather than the precondition being weakened to fit the fixture.

perf-harness: `tsc --noEmit` clean, `bun test` **82 pass / 0 fail** (was 77 before this and the
footprint work).

This is the same lesson as everything else in this document, applied to the instrument itself: a
measurement that reports a number without reporting whether the number was readable is not a
measurement. The harness could already tell you the display refresh rate to two decimal places and had
no idea the machine was busy.

### Parallel sweep across three machines: the catalogue cost is 8.75 us/model, R^2 = 0.9995

140 measurements — 20 catalogue sizes x 7 replicates — sharded across three AWS Graviton instances and
collected in **2.0 seconds of wall time**. Far stronger than the original n=3 at 5 sizes, and on a
second architecture.

| models | from (ms) | toPublicInfo (ms) | total |
|---:|---:|---:|---:|
| 181 | 0.10 | 1.38 | 1.48 |
| 686 | 0.50 | 5.16 | 5.68 |
| 2,199 | 1.69 | 17.43 | 19.12 |
| 3,980 | 3.15 | 32.42 | 35.59 |
| 6,280 | 4.58 | 48.66 | 54.18 |

    SLOPE 8.75 us per catalogue MODEL, intercept 0.09 ms, R^2 0.9995

**`toPublicInfo` is 10.6x more expensive than `fromModelsDevProvider`** (48.66 vs 4.58 ms at full
catalogue) — exactly what its implementation predicts, since it is
`JSON.parse(JSON.stringify(provider, replacer))`, a full serialize-and-reparse round trip with a
per-key JS callback, while `fromModelsDevProvider` is a shallow rebuild.

**Reconciliation with the in-situ Mac measurement:** the whole initializer body measures 28.1 us/model
on the Mac; these two named passes are 8.75 us/model here. So the named passes are roughly a third of
the per-model cost, which independently confirms the earlier statement that they are a LOWER BOUND and
that ~110 ms of the 194 ms initializer body remains unattributed to a specific statement.

**The waste is now quantified.** `Provider.list()` returns 10 connected providers = 566 models, 9.0% of
6,280. At 8.75 us/model the two named passes cost 54.18 ms for the full catalogue and would cost
~4.95 ms for the reachable subset — so **~49 ms per cold boot is spent transforming catalogue entries
that are then discarded**, of which the `toPublicInfo` pass alone is ~44 ms. That is a floor on the
waste, not a total, because the unattributed residual is also catalogue-proportional.

Method note, since it is the point of the exercise: the packaged benchmark is a single-host serial
resource and cannot be parallelised without destroying the measurement. Headless server-side deltas
have no such constraint — this sweep ran 140 measurements in 2 seconds because catalogue transforms
are pure CPU with no display, no GPU and no vsync. That is the correct division of labour: absolute
gate values on the reference machine, per-unit costs and algorithmic deltas on as many cheap machines
as the question needs.

## MULTI-MODEL JUDGEMENT: publish ISOLATED, with ambient beside it, and one decisive legitimacy test

The isolate-or-not question was put independently to three models (`claude-opus-5`, `claude-fable-5`,
`gpt-5.6-sol`) with the arguments on both sides stated in the prompt. Two returned; they converged.

**Both converged on: measure BOTH, publish the ISOLATED number as the gate, keep AMBIENT as a tracked
non-gating companion.** The reasoning both reached independently: the operator's plugin set was never a
chosen input, it was an unpinned leak that no other machine reproduces, and isolation is not a new
measurement philosophy but the completion of the pinning discipline the harness already applies to the
profile, the data directory and the corpus.

Conditions attached, which I am adopting:
- The isolated mode must be applied to ALL TEN gates and the historical series re-measured, not to the
  one failing gate. "A gate series measured half one way and half the other is not a series."
- It must be published as an explicit, dated METHODOLOGY CHANGE naming the delta and its cause, never
  as a silent re-run.
- The ambient number stays visible every run. ~1.9 s ambient is real user experience on this machine
  and must not vanish.

**The strongest counter-argument, and why it does not win.** "Isolating makes the measured window
cheaper without making the product one microsecond faster — the exact error this effort already
retracted once." It differs in the direction of the fix relative to the measurand: the retracted case
shrank the window around the SAME product behaviour, whereas the removed cost here is provably NOT
product behaviour — third-party network I/O, non-deterministic (366 ms median, >5 s worst case),
machine-specific, and outside the product's ability to optimise. A gate contaminated by an unpinnable
five-second-worst-case external fetch is not a stricter gate, it is a noisier one that measures the
operator's home directory.

**THE SINGLE DECISIVE LEGITIMACY TEST, and it is now the experiment to run:** a PAIRED SAME-COMMIT A/B
where the isolated-minus-ambient delta lands almost entirely inside `/provider`, on the plugin's own
span (~366-395 ms plus its variance). If the delta matches the independently-traced plugin cost, the
isolation removed exactly the diagnosed foreign cost and nothing else — legitimate. If the record shows
only "switched mode, gate now passes" with no paired A/B, or the delta EXCEEDS what the plugin span
explains, then isolation also hid product cost and it was gate-shopping. **`provenance.json` recording
the mode is necessary but not sufficient; the paired delta-versus-trace reconciliation is the test.**

**And a separate PRODUCT finding that survives whichever way the gate is measured:** the platform lets
a plugin constructor block boot on an uncached fetch with a 5,000 ms timeout. Whether or not the
product owns that latency, **it owns the architecture that permits it.** A third-party plugin should
not be able to hold the first paint of the application on a network round trip. That is a real defect
with its own fix — lazy plugin initialisation, or a boot-path timeout budget — independent of any gate,
and it would improve the ambient number, which is the one users actually experience.

### Adopted standard for the isolation change, from two independent judgements

Both models attached the same non-negotiable conditions, and one added the evidence test I will be
audited against:

- **Condition A — re-baseline everything.** Isolated mode must be applied to ALL TEN gates and the
  historical series re-measured. "A gate series measured half one way and half the other is not a
  series."
- **Condition B — the gate TEXT changes, not just the number.** Restated as "cold ready, pinned ambient
  environment" — the same class of pin as corpus, profile and data dir. Isolation is a declaration of
  the product boundary, made once, not a knob turned when a number is inconvenient.
- **Condition C — no defect is retired.** Isolation removes the plugin from the MEASUREMENT; it does
  not remove the DEFECT it exposed. The product awaits a third-party constructor's uncached
  5,000 ms-timeout fetch serially on the boot critical path, with no init budget, no cache, no
  parallelism. **If isolation ships without that fix, the isolation was laundering.**

**The evidence a reviewer should demand, and which I am committing to produce:** whether the
previously-PASSING gates were also re-measured under isolation and republished. `provenance.json` for
the nine other gates is the tell. If isolated mode appears only on the one failing gate — or only on
measurements taken after the failure was known — it is number-shopping. If the full ten-gate series was
re-run isolated, INCLUDING gates that were already comfortable and gates that isolation could have made
look WORSE, the mode change was a boundary decision.

Accordingly the plugin-boot defect is now being fixed as a product change on its own merits, before
any isolated number is published: external plugin constructors are awaited SEQUENTIALLY
(`plugin/index.ts:119`, `hooks.push(await server(input, load.options))`), so a user with three plugins
waits for all three in series on every cold start, and a plugin that never resolves can hold first
paint for its full 5 s timeout plus a fallback fetch.

### The provider initializer's statement inventory is CLOSED — the residual is not a statement

Standalone probe importing the REAL functions from the worktree, bundled `--target=node` and run under
node/V8 to match the packaged path (the desktop bundles opencode as `node-embed` with Bun.build
`target:node` and runs it in Electron, so V8 not JSC — under JSC the same block is ~2.5x cheaper).
Cold = one pass per process, 9 fresh processes per point, five catalogue sizes.

**Control validation first:** this probe's slope for the two known passes is 9.65 us/model against the
independently measured 8.75 us/model from the three-machine sweep — 10% agreement, so the instrument
faithfully reproduces the costs already isolated.

| statement | ms @ 6,280 | us/model | R^2 |
|---|---:|---:|---:|
| `:1406a` readFileString | 1.33 | 0.187 | 0.9997 |
| `:1406b` **JSON.parse(models.json)** | **14.85** | 2.285 | 0.9999 |
| `:1407` `mapValues(modelsDev, fromModelsDevProvider)` | 34.65 | 5.090 | 0.9832 |
| `:1408` `mapValues(catalog, toPublicInfo)` | 29.10 | 4.563 | 0.9374 |
| `:1579-88` env scan over 183 providers | 0.22 | 0.061 | — |
| `:1584/:1596/:1638/:1649` `mergeDeep` x N | 0.03 | 0.001 | — |
| `:1666-1713` finalisation loop | 0.42 | 0.062 | 0.9882 |
| **SUM OF PARTS** | **80.61** | | |
| **MEASURED WALL OF THE SAME WINDOW** | **80.57** | 12.250 | 0.9851 |
| add-up error | **+0.04 ms (0.05%)** | | |

**It adds up. There is no hidden term inside the compute block.** Only ~16 ms transfers into a named
statement (the JSON.parse), leaving **~95-113 ms still unexplained — and it is not a statement.** Every
line in 1402-1712 that scales with model or provider count is in that table; the remaining work is
effectful and CONSTANT-cost: `:1443 plugin.list()`, the `:1456-1481` plugin `provider.models` hook
(which can do network I/O), `:1578 env.all()`, `:1591 auth.all()`, the `:1604-1622` plugin auth-loader
loop, `:1624-1640` twenty-two `custom()` loaders, and `:1652-1664` gitlab `discoverModels` (network).

**Two live readings, and a single number that decides between them.** Either (a) the same statements
cost ~2.4x more in situ, or (b) the true in-situ SLOPE is ~12 us/model rather than 28.1 and the extra
~110 ms is the CONSTANT effectful work above, mis-read as per-model because it was never separated.
The discriminator: instrument the body with two timestamps and read the INTERCEPT against catalogue
size. **Standalone intercept is 6.25 ms; reading (a) predicts ~18 ms in situ, reading (b) predicts
~115 ms.** That single number settles it, and it is an in-situ run rather than a probe.

**Discarded versus live, established by grep rather than assumption.** `:1408`'s `database` is a pure
local, never returned from the initializer, escaping only through `mergeProvider` for the ~10 connected
providers — and remeda's `mergeDeep` shares sub-objects by reference, so the other ~173 providers and
~5,580 models of deep-cloned output are garbage the moment the initializer returns: **~26 of the
29.1 ms of `:1408` is thrown away.** `catalog` from `:1407` IS retained in State and has exactly THREE
consumers repo-wide, all in `Provider.getModel`'s error path (`:1878`, `:1882`, `:1892`), and all three
read only provider keys, model keys and `model.status` — nothing reads cost, limit, capabilities,
variants, headers or options off it.

**Two candidates on the earlier suspect list are now dead as costs and should not be pursued:** the
`ProviderTransform.variants` + `mergeDeep`/`pickBy`/`omit` work at `:1690/:1697` is 0.42 ms total, and
`:1584`'s `mergeProvider`/`mergeDeep` is 0.03 ms, because remeda only recurses into keys present in the
patch and every patch here is scalar.

**And the handler re-does the whole derivation per request.** `handlers/provider.ts:88-97` runs the
same two passes again plus `defaultModelIDs`, which SORTS every provider's models — and the desktop
boot never sets `view=index` (`bootstrap.ts:111-116` sends only `harness` and `directory`). Measured
warm, as a second pass in the same process: `:89` 12.52 ms, `:92` 7.78 ms, `:94` 26.42 ms,
`JSON.stringify` 8.44 ms on a **4.75 MB** body = **55.75 ms of request-side catalogue work** — and that
excludes the Effect Schema encode over 6,322 models, which was not measured and is probably large.

GC excluded as the residual: with a `PerformanceObserver` on `gc` and 0/300/900 MB of ballast, ZERO gc
entries land in the window and the wall is unchanged (65.4 / 60.6 / 66.2 ms).

### The strategic answer: the barrier's directory is DETERMINISTIC AT SERVER START

Code-verified: every cold-boot `/provider` request resolves to the SAME directory — the server child's
`process.cwd()`. The renderer's fetch sends no `directory` (`providerCacheHarness('opencode')` returns
undefined, `control-plane.ts:111-113`; `fetchProvider` passes `directory: harness ? scope : undefined`),
and the local server's own `/api/claxedo/bootstrap` fetches `/provider?view=index` with no directory
(`shared-routes/bootstrap.ts:147`). Both fall through `defaultDirectory()` =
url param || `x-opencode-directory` || `process.cwd()` (`middleware/workspace-routing.ts:92-94`), and
no `process.chdir` exists on the server path.

**So the server can legally start the exact work the barrier will wait on, before any request exists**
— and `InstanceStore.load`'s `ScopedCache`/`Deferred` (`instance-store.ts:107-125`) dedups it, so a
prewarm plus the real request is not double work by construction. The prewarm would issue the identical
request the bootstrap route already makes every boot, so total work is unchanged.

**Saving equals LEAD TIME**: barrier completion moves from `T_request + W` to `T_start + W`, so the
saving is exactly the lead while lead < W (W = 596-676 load + 246-270 init). **If lead < ~120 ms this
candidate cannot reach 171 ms alone.** Sizing it from existing traces before implementing:

    AC-composer-2, renderer clock:
      /api/claxedo/health          302.0 -> 305.9  (3.9 ms)   <- server ALREADY listening and fast
      /global/health               302.6 -> 306.4
      /api/wr/events               318.0            (489.2 ms, SSE stream)
      /api/claxedo/bootstrap       318.6 ->  320.4  (1.8 ms)
      /project/<id>                324.3 ->  325.4  (1.1 ms)
      /api/workspace?access=cloud  324.4 ->  331.2  (6.8 ms)
      /provider                    326.4            <- FIRST ENGINE-BOUND REQUEST

The server answers health in 3.9 ms at t=302, so it was fully up before the renderer first asked. Six
requests are served before `/provider` arrives and five of them complete in 1-7 ms, so **the loop is
substantially idle during the lead window** — which is the condition under which prewarm is not
zero-sum. Renderer-clock lead is >= 20.5 ms, but the TRUE lead is measured from server-child start, and
process spawn precedes renderer timeOrigin by ~213 ms.

**The number that decides it is not yet measured**, and it must be, because this is the same shape as
the engine pre-load that proved exactly zero-sum (+371 paid, -363 recovered, net +21). The difference:
that candidate moved the ENGINE IMPORT, which blocks the loop, into a window where the loop was needed;
this one moves a computation into a window where the loop is measurably idle. That is an argument, not
a measurement. **Required: the server child's ready timestamp against the first engine-bound request,
which the launcher currently cannot see because it drains the server child's stdout to nowhere** — the
same blindness that hid the engine compile for five retained changes.

**What is available WITHOUT moving the barrier, measured on real code with the real 6,280-model
catalogue:**

| # | change | measured saving |
|---|---|---:|
| 2 | handler stops re-walking the catalogue (`handlers/provider.ts:89,94`); `State.catalog` already holds the `:1407` output and is never mutated post-init | 30-45 ms |
| 3 | skip the Schema re-encode of the 4.7 MB response (`handleRaw` + `jsonUnsafe`) | 35-45 ms |
| 4 | make `database` lazy at `:1408`; the `:1579` env scan reads only `.env` and can iterate `catalog` | 23-28 ms |

**Honest bottom line from the analysis: without the prewarm, in-barrier savings that do not change what
`/provider` returns sum to ~30-45 ms safe and ~90 ms aggressive — NOT 171.** The 171 ms is only
available by moving the barrier's START earlier, and its value equals the measured lead time.

Two further corrections it contributed. Real-code probes agree with the closed statement inventory that
pure catalogue transforms CANNOT account for 246-270 ms, so ~150-200 ms of the initializer span remains
unattributed — recommending two child spans (transform block versus loaders loop) in the next
diagnostic build before any `#4`-class work. And Copilot's auth loader does NO network at load time
(`plugin/github-copilot/copilot.ts:96-101`), so that suspicion is dead.

### `/provider` raw-encode slice KILLED at its own byte gate — and the mechanism is worth more than the slice

The proposal was to replace the Effect Schema encode of the 4.7 MB `/provider` body with
`handleRaw` + `jsonUnsafe`, saving a measured 42-54 ms of encode against 8-9 ms of plain
`JSON.stringify`. The brief required byte-identical output and said any mismatch kills it.

    old wire = JSON.stringify(Schema.encodeUnknownSync(ListResult)(payload))   4,782,736 bytes
    new wire = JSON.stringify(payload)                                          4,782,736 bytes
    bytes equal: FALSE — first divergence at offset 25
      old: {"all":[{"id":"zhipuai","name":"Zhipu AI","source":"custom",...
      new: {"all":[{"id":"zhipuai","source":"custom","name":"Zhipu AI",...
    canonical (deep key-sorted) equality: TRUE — identical key sets, values and total byte count

**The transform argument HELD and the slice still died on ordering.** No value transforms fired
(`Finite` = number, brands pass through, `optional` encode only filters undefined, which `stringify`
also drops). What kills it is that effect's Struct encode REORDERS keys into schema declaration order:
`Info` declares `(id, name, source, env, key, options, models)` at `provider.ts:1128-1136` while
`fromModelsDevProvider` constructs `(id, source, name, env, options, models)` at `:1352-1359`; the same
mismatch exists for Model between `:1107-1121` and `:1276-1319`. `toPublicInfo` is a JSON round trip, so
it preserves construction order and propagates the difference to every provider and every model.

Both revival options were considered and rejected: relaxing the bar to canonical equality would change
bytes for any consumer that hashes, ETags or byte-caches the body; and reordering construction to match
schema order spreads an unstated invariant across every `Info` construction site — including connected
providers, which were not audited — that any future field addition breaks silently.

**Redirected to a better slice against the same term.** There are THREE `/provider` requests per cold
boot (unqualified ~328 ms, `?harness=pi` ~411, `?harness=opencode` ~857), each re-deriving the
catalogue AND re-encoding 4,712,583 bytes. `State.catalog` is never mutated after init, so for a given
instance state the full-list body is a pure function of inputs that do not change within a process.
Memoizing the ENCODED STRING — keyed on everything that can change the body and nothing that cannot,
with a lifetime tied to the `InstanceState` scope so it dies with `disposeInstance`/`reload` — removes
the encode from requests two and three while KEEPING the schema encode and its validation on request
one. Nothing is weakened; it simply stops paying three times.

### Plugin init budget: RETAINED as robustness, 0 ms at the default in the normal case

`plugin/index.ts:215-238` awaited external plugin constructors SEQUENTIALLY and without bound
(`hooks.push(await server(input, load.options))`), with the sequencing documented as deliberate. Now:
`applyPlugin` RETURNS hooks instead of pushing, so the caller owns registration timing;
`PLUGIN_INIT_BUDGET_MS = 1_000` (overridable via `OPENCODE_PLUGIN_INIT_TIMEOUT_MS`); construction stays
sequential but is built as a promise chain so each plugin has its own promise without changing
execution order; on-time results register in load order; PENDING ones keep running and are registered
LATE into the live hooks array with their config hook run, and are disposed rather than registered if
the instance has closed.

**Predicted effect at the shipped default: 0 ms off the boot path in the normal case**, stated by its
author before measurement. antigravity's 366-395 ms is under a 1,000 ms budget, so the budget never
fires. What it buys is bounded degradation: the pathological path (5,000 ms timeout then a second
fetch) collapses to 1,000 ms; three plugins at ~370 ms each stop summing without limit; a plugin that
never resolves stops wedging the application permanently.

It also discharges the condition both independent judgements made non-negotiable — isolation removes
the plugin from the MEASUREMENT but must not retire the DEFECT, or the isolation is laundering.

**The concurrency candidate was correctly REJECTED.** `test/plugin/loader-shared.test.ts:852` asserts
marker-file content `["a-start","a-end","b"]`, which pins that one constructor's SIDE EFFECTS never
interleave with the next one's — not merely hook order. Running them concurrently turned it red, and
the author reverted rather than weaken a tested plugin contract.

**A source-text regex test was replaced with a behavioural one, and the replacement PROVEN stronger:**
changing `notifyConfig`'s `Effect.ignore` to `Effect.orDie` turns the new test red, which the old regex
would not have caught.

Red/green: 3 fail / 1 pass before, 4 pass / 0 fail after, with the never-resolving-plugin case timing
out at 15,000 ms pre-fix. Four remaining package failures proven pre-existing by byte-restore A/B —
cross-process file-lock tests touching none of the changed code.

**THE REAL BLOCKER ON RECLAIMING THE 366-395 ms, and it is the most useful finding here:**
`Provider.state` (`provider.ts:1483`) and `ProviderAuth.state` (`auth.ts:116`) materialise lazily on
the first `/provider` request, derive from `list()` ONCE, and **there is no invalidation path anywhere
in src** (grep for `InstanceState.invalidate`: zero hits). `trigger`/`list`/`event`/`config`/`dispose`
all observe late pushes because the hooks array is live; provider and auth derivation does not. So a
budget short enough to cut antigravity would race the first `/provider` and could silently omit a
configured provider from that boot — which is a far worse defect than the latency. **The default must
not be lowered**, and reclaiming that time honestly requires safe re-derivation on late registration,
which is a larger slice now under investigation.

Residual, stated by its author rather than discovered later: because construction stays sequential, a
hung plugin still permanently blocks every plugin ORDERED AFTER IT — it just no longer blocks the
application. The test encodes this by placing the hung plugin last.

### Reclaiming the plugin's 366-395 ms: NOT safely available — three missing pieces, and it would not even remove the time

Read-only investigation of `ScopedCache`, `InstanceState`, `Provider.state` and `ProviderAuth.state`.

**Q1 — are the derivations pure functions of the hooks array? No, and one is fatal.**
`ProviderAuth.state` is half pure: its `hooks` record is a last-wins fold and is safe to recompute, but
`pending: new Map<ProviderV2.ID, AuthOAuthResult>()` is NOT derived from hooks at all. `authorize`
writes it (`auth.ts:180`) and `callback` reads it (`:191-192`) — TWO SEPARATE HTTP REQUESTS separated by
however long the user spends in their browser. Re-deriving constructs a fresh Map and **silently
destroys every in-progress OAuth login**, returning `OauthMissing`. And the plugin that would trigger
the re-derivation is precisely a plugin registering an auth provider.
`Provider.state` is side-effecting rather than a fold: re-deriving RE-RUNS every plugin's auth loader
(a token refresh for antigravity), `env.all()`, `auth.all()`, every `custom(dep)` loader and a gitlab
model-discovery `fetch`. It also holds `models: Map<string, LanguageModelV3>` and
`sdk: Map<string, BundledSDK>` — caches of LIVE instantiated SDK clients that a streaming session holds
for the duration of a generation. Recomputation yields empty Maps and two live SDK graphs.

**Q2 — what happens to an in-flight `/provider`, from the ScopedCache source.** `invalidate` does
`MutableHashMap.remove` then **`Scope.close(entry.scope)`** — unconditional, uninterruptible. It does
NOT interrupt the running lookup and does NOT re-arm the deferred. So an invalidate landing while the
first lookup is still running (exactly the race a firing budget creates) leaves the lookup to complete
an ORPHANED deferred, and the in-flight caller receives a value computed from the PARTIAL plugin set,
from a state whose scope has already been finalized. Worse: `scopeAddFinalizerExit` fires finalizers
IMMEDIATELY once a scope is closed, so any finalizer registered after that point runs at once —
`Provider.state` and `ProviderAuth.state` happen to register none, but that is an accident of the
current implementation, documented nowhere. The same mechanism makes invalidating **Plugin.state**
categorically unsafe, since it registers `unsubscribe` and a dispose-all-hooks finalizer near the end
of its lookup.
An invalidate landing AFTER the lookup resolves is silent: the handler already holds `s.catalog` BY
REFERENCE (`provider.ts:1770-1772` documents that entries are served with no clone) and serialises the
OLD graph with no error the client can detect. And two `/provider` requests straddling the invalidate
return DIFFERENT lists inside one boot — with a 250 ms budget against a 366-395 ms plugin that window
is ~120-145 ms wide, and the first `/provider` lands inside it.
`ScopedCache.refresh` is better behaved (new lookup completes, then the entry swaps, then the old scope
closes) but `InstanceState` does not expose it, and a FAILED refresh installs the failure over good
state.

**Q3 — is there a generation number? No, and nothing to build one from.** The cache `Entry` is
`{expiresAt, deferred, scope}` with no epoch or sequence; `InstanceState` exposes
make/get/use/useEffect/has/invalidate and returns values with no envelope; grep for
`generation|epoch|revision` in `src/effect/*.ts` returns zero hits. **`InstanceState.invalidate` has
ZERO call sites in src** — the only wired invalidation is whole-instance teardown via
`registerDisposer`, which is the one moment when closing entry scopes is correct.

**Cost to reclaim, stated as three separable pieces that do not exist:** split volatile identity
(`pending`, `models`, `sdk`) out of derived state; surface a non-destructive refresh with deliberately
chosen failure semantics; add a generation counter plus a consumer-visible stale-read check. **And even
with all three it does not REMOVE the 366-395 ms — it moves it off the boot path and pays it again
later, with duplicate token refreshes.**

Recommendation accepted: keep the budget default at 1,000 ms. Its value is bounded degradation, not
latency.

Process note worth keeping: in this tree "typecheck clean" is a point-in-time claim with a shelf life
of minutes. Two agents editing `provider.ts` concurrently produced a duplicated `catalog` declaration
(TS2300 x2, TS2451 x2, TS2345) that existed for ~24 seconds. A file-level edit protocol is now in
force: re-read by content before editing, count occurrences after, announce before and after, and never
"clean up" another slice's constructs.

### Prewarm: PART 2 NOT BUILT — the lead is not an idle window, it is a HANDOFF the renderer is blocked on

The prewarm's premise was that the server is up and idle while the renderer has not yet asked. It is
not. From code: `renderer/shell.tsx:550-560` suspends the ENTIRE renderer tree on
`desktopApi().awaitInitialization(...)`; `main/index.ts:750-762` awaits `serverReady.promise`; and
`serverReady.resolve` (`:565`) is reached only after `await listening.promise` (`:483-488`), then
`await fetch(<url>/api/claxedo/health)` (`:489`), then `trustMainRendererOrigin(...)` (`:558`). The
child's `listening` IPC fires from `claxedo-server-entry.ts:38` on `server.ready`, which resolves in the
`serve()` listen callback — **exactly where the prewarm would fire.** So the lead is
(child IPC hop) + (main's health round trip) + (origin trust) + (IPC reply) + ~1.2 ms renderer dispatch.
There is no window where the server is up and the renderer merely has not got round to asking; **the
renderer is blocked, by design.**

Measured from 192 archived runs (110 healthy): the renderer is never the constraint —
`diag.persister.storageRead` lands at median 173.5 ms while the connection gate does not start until
308.4 ms, a median 134.9 ms of renderer IDLE time waiting for main, and the first request follows
1.2 ms later. The one arm that moved server readiness moved the renderer with it ~1:1
(`AC-enginepreload-1..4` first request 675-702 ms against a ~308 ms median: +378, matching the +371 ms
already known). First request to `/provider` is median 25.1 ms.

**The dedup premise IS confirmed by measurement**, from six archived runs that accidentally ran the
experiment: a bootstrap variant that did `/provider?view=index` first made bootstrap cost 1,021-2,563 ms
and the renderer's own `/provider` then cost **22.7-26.8 ms instead of 866-989 ms** — so ~97% of
`/provider` is once-per-directory work that `InstanceStore.load` dedups. **But those same runs had cold
ready 1,991-2,087 ms against a 1,863 ms median: same work, same start time, no gain. The entire value
is the lead and only the lead.**

**ANCHOR MIGRATION, ANSWERED UP FRONT AND WORSE THAN EXPECTED: `/provider` IS NOT THE LAST REQUEST TO
FINISH IN ANY HEALTHY RUN.** In 110 of 110, some non-`/provider` request ends AFTER the last
`/provider`, by median 55.7 ms — the SESSION-DETAIL WAVE on the worktree-directory instance (subagents
31, question 26, vcs 22, session/status 10, ...), followed by a further median 66.5 ms of pure renderer
tail. Cross-run observational slopes give a composed transfer of ~0.47, so
`coldReadyGain <= lead x transfer`; with lead ~25-50 ms that is **~12-25 ms**. Marginal, and it cannot
be the answer alone. This corrects a model this document has carried: `/provider` anchors the barrier,
but it is not the terminal request.

**A BETTER CANDIDATE FOUND INSIDE THE HANDOFF (D.3).** Every millisecond of that chain is serial
cold-ready time with the renderer provably idle. One step is `await fetch(<url>/api/claxedo/health)` at
`main/index.ts:489` — the FIRST fetch in the Electron main process, so it pays undici's cold
initialisation, and it runs AFTER the child has already reported listening. Removing or overlapping it
moves `serverReady.resolve` earlier by its full cost, and the 1:1 transmission to renderer start is
empirically established by the pre-load arm. **This is not "reduce total work" — it removes a SERIAL
step from a window where the only other actor is idle**, which is the property all seven dead
candidates lacked.

**Part 1 instrument landed and gated** (`CLAXEDO_BENCH_STARTUP_CLOCK=1`): epoch-ms stamps shared across
child, main and renderer (`performance.timeOrigin`), because the existing `Log` line has a 1,000 ms
least count for a ~100 ms question. It also optionally TEES the child's stdio to `app-stdout.log`
instead of dropping it — the blindness that hid the engine compile for five retained changes. One
packaged run emits `startup-clock-lead.json` with `leadToFirstProviderRequestMs` and the four handoff
stamps that price D.3.

The agent declined to implement Part 2 rather than hand over a second unmeasured candidate, and gave the
strongest argument against its own slice: the zero-sum engine pre-load is the CORRECT PRIOR here, not a
distinguishable case, because neither moves work into an idle window. It also verified the one way this
could have become a correctness bug and closed it: `instance-store.ts:110-122` forks the boot via
`Effect.forkIn(scope, ...)` inside `Effect.uninterruptibleMask`, so a prewarm whose `AbortSignal.timeout`
fires cannot interrupt a boot a concurrent real request is awaiting.

### State of the landed stack, verified in the packaged artifact

Four slices are in the build and PRESENT in the shipped bytes, checked rather than assumed:

    makeLazyDatabase      engine artifact x4      (lazy `database` in the Provider initializer)
    Provider.catalog      engine artifact x1      (handler serves State.catalog, no re-derivation)
    PLUGIN_INIT_BUDGET    engine artifact x2      (bounded plugin init)
    knownDirectory        app.asar x3             (workspace-store git short-circuit)

Suites on the merged tree, run after every slice landed:

    packages/opencode        `bun test test/provider test/server test/plugin`   914 pass / 2 skip / 0 fail
    packages/opencode        `bunx tsgo --noEmit`                               exit 0
    packages/claxedo-server-core  `vitest run src/workspace/store`              12 pass / 0 fail
    packages/claxedo-app     `bun run test:architecture`                        258 pass / 0 fail
    packages/claxedo-app/perf-harness  `bun test`                               91 pass / 0 fail

`composer.tsx` is 799 lines and the size budget passes — the 801-line failure one agent reported was a
transient state of the concurrently-edited tree, which is the same point already recorded: in this
worktree "typecheck clean" and "guards green" are point-in-time claims with a shelf life of minutes.

**Expected occupancy from the landed stack, none of it converted to a gate delta and all of it awaiting
one packaged A/B:**

| slice | measured, in isolation | where it lands |
|---|---:|---|
| handler serves `State.catalog` | ~30-45 ms | inside every full-list `/provider` request |
| lazy `database` | ~16 ms | inside the initializer |
| workspace-store git short-circuit | ~50 ms x ~9 boot requests of subprocess time | off each directory-bearing request's own critical path |
| plugin init budget | 0 ms at the default | bounded degradation only |
| encoded-body memoization | ~60-75 ms per repeat full-list request | NOT on the desktop boot path (compat route asks for `view=index`) |

The honest summary of the stack against a ~171 ms gap: the two initializer-side slices are real but
small, the git fix is real but its shape is subprocess time rather than event-loop occupancy, and the
two largest measured terms — the plugin's 366-395 ms and the encode's 42-54 ms — turn out to be
respectively NOT OURS (operator config, removed by the isolation decision) and NOT ON THE BOOT PATH
(compat route). That is a materially different picture from the one this document held two hours ago,
and every correction came from an agent contradicting its own brief.

### Two shipped product defects found while checking whether a perf slice was even needed

The "make the app request `view=index`" slice was **correctly not built** — the boot path already asks
for it. `providerBody` sends `view=index` for opencode and never touches the engine for `harness=pi`;
the full-list ask was removed 252 commits ago in `c9d0a8051`. Verified by source AND by a live probe of
the compat route against a stub engine: a list request reached the engine as `/provider?view=index` and
the app-visible body for 183 providers was **7.7 KB**.

**But checking it surfaced two user-visible defects that were shipping.** `c9d0a8051` wired per-provider
detail loading into the manage-models and provider DIALOGS only:

1. **The main composer model picker opened showing ONE model per connected provider and stayed that
   way.** The index carries `models={}` except a single default per connected provider, and the picker
   never invoked the `providers.load(id)` seam that already existed. That is precisely the
   "opens and stays empty" failure mode — present in shipped code, not hypothetical.
2. **A saved NON-DEFAULT model selection silently failed validation at boot** and fell back to the
   provider default, because `session-selection`'s `validModel` requires `provider.models[modelID]`
   which the index lacks — until Manage Models happened to be opened.

Both fixed app-side: a `PickerState.hydrate` seam that loads connected-provider detail when the picker
CONTENT MOUNTS (i.e. on open), single-flighted per provider by the existing provider cache; and a
`selectionProviderDetailNeeded` predicate plus one effect that loads the single selected provider's
detail when the selection misses the index. Ablated: removing the `onMount` call fails the new test,
restoring passes. Zero boot-window change — no request added or removed before user interaction.

**And a measured shape fact that closes a line of inquiry:** the two engine-bound `/provider` requests
COMPLETE AT THE SAME INSTANT — 326.4 + 989.1 = 1,315.5 and 737.7 + 577.7 = 1,315.4. They are two waiters
on ONE shared instance initialization, so there is no "one request could serve both" win; they already
share. And `view=index` is consulted only AFTER `connected = yield* provider.list()`, with
instance-context middleware running `InstanceStore.load` before any handler — so the view skips the two
transform passes, `defaultModelIDs` and the 4.7 MB encode, but **cannot skip `InstanceStore.load`
(596-676 ms) or `Provider.list` (246-270 ms)**. The request shape was never the remaining cost.

Also newly attributed: `?harness=pi` at ~333 ms never touches the engine — it is first-touch of the
credential registry (`pi-credentials.ts:17-27`), which opens the claxedo DB and runs 37 migrations. It
completes at ~744 ms, well before the 1,315 ms barrier, so it is not the anchor.

### D.3 built: the readiness health check keeps its guarantee and loses its cold-start cost

`main/index.ts` awaited `fetch(<url>/api/claxedo/health)` between the child reporting listening and
`serverReady.resolve` — the FIRST fetch in the Electron main process, so it paid undici's one-time
client construction inside the window that gates the entire renderer.

**The check is load-bearing and was NOT removed.** History settles the intent: at `728cedf2a` main had
no IPC ready message and POLLED health 50 times; `claxedoServerReadyMessage` later replaced the
POLLING, not the CHECKING, and `startup-wiring.test.ts` already pins "waits for the exact listener
message and verifies health without polling". What the message cannot prove is that the child SERVES —
a socket that binds but has no route tree mounted, or a stranger holding the port, is still
listening-but-broken. On failure main closes the child and `ServerGate` renders its error branch, which
is a stronger guarantee than the renderer's own connection gate would give.

**So the COST moved, not the check.** New `main/server-readiness.ts` names the boundary with two
members: `verify()` (unchanged behaviour, unchanged placement) and `prepare()` (same GET, same URL,
issued before the child has bound, so it is refused immediately and discarded — it adds no exposure
`verify()` does not already have).

Priced with a standalone probe under the REAL shipped Electron, interleaved A/B, n=6 each:

    without prepare : 17.49 19.24 20.02 20.59 20.81 22.80   median 20.31
    with prepare    :  7.28  8.33  8.70  8.89  9.18  9.38   median  8.79

**Recovery ~11.5 ms, distributions non-overlapping.** Shape screen applied to its own result: min moves
10.2, max moves 13.4 — a constant ABSOLUTE shift at every order statistic, which is the signature of a
removed fixed one-time cost and matches the claimed mechanism. And the mechanism was isolated rather
than assumed: warming a DIFFERENT origin recovers only half, warming the SAME url recovers ~11.2, so it
is undici's per-origin client construction.
Expected cold-ready effect ~5-11 ms after the ~0.47 transfer. Small, nearly free, and explicitly not
the gate.

**And the prewarm is now dead by MECHANISM rather than by analogy.** `startOwned` is a SYNCHRONOUS
function and `withDataDirOwnership` is synchronous too; from `configureAgentConfig` (line 174) to
`serve()` (line 299) there is **not one `await` on the executing path** — all 11 in that span sit inside
callbacks stored for later, and everything genuinely async is fire-and-forget. So the head start
contains NO SUSPENSION POINT: a `void opencodeRequest(...)` at line 179 does nothing until `startOwned`
returns, and its first act then runs in the microtask drain — before the `listen()` callback — where its
first act is `embeddedHost()` -> a dynamic import of the 9.11 MB engine whose compile and evaluation are
a SYNCHRONOUS main-thread block, on the same single thread that must run `markReady`, answer main's
`verify()`, and serve the renderer.
The overlappable waits — the plugin's 366-395 ms and the git subprocesses — are all INSIDE the instance
init, i.e. downstream of that import. **You cannot reach the overlappable wait without first paying the
blocking one on the thread that owes readiness an answer.**
Asked to answer twice: ISOLATED, the overlappable wait collapses to <=115 ms of git subprocesses against
a ~370 ms front-load — strictly negative. AMBIENT, the overlappable wait rises to ~425-510 ms against the
same front-load, which looks favourable and **is precisely the arithmetic that already produced
+371 before readiness, -363 after, net +21**. The ambient case is not the untested one; it is the one
that was tested.

Recorded as process: the agent's ablation 3 PASSED on first attempt because two `expect(...).rejects`
assertions were not awaited and the test observed a cache before its microtask had run. It fixed both,
re-ran, confirmed the ablation now fails as it must, and flagged it — "a test that cannot fail is worse
than no test, and I nearly shipped one."

## BENCHMARK OF THE LANDED STACK — cold ready is UNDER BUDGET in 6 of 6 runs, and I do not yet believe it

Packaged build verified to contain every slice before running: `makeLazyDatabase` x4, `Provider.catalog`
x1, `PLUGIN_INIT_BUDGET` x2, `provider-list-cache` x1 in the engine artifact; `knownDirectory` x3,
`server-readiness` x1, `readiness.prepare` x1, `hydrateConnectedProviderDetails` x5 in the asar.
Host verified: AC power, load settled to 3.67 before the first run, zero stray Playwright/ffmpeg
processes.

    cold ready   1570.6  1448.0  1486.1  1468.4  1489.6  1447.6     median 1477.2
    budget 1750  -> ALL SIX RUNS PASS. Prior median (AC-postrevert, 4 valid samples): 1921.2

Other gates in the same six runs: cold open 143.4-158.0, warm switch 138.2-139.5, history 70.3-72.4,
stream 32, blocked frames 0, terminal input 28.3-37.7, terminal output 19.9-20.8, RSS 1887.7-1905.7,
quiescent CPU 3.0-5.0.

**THE MECHANISM IS VISIBLE, which is the only reason this is worth reporting at all:**

    /provider unqualified      989 -> 746 ms
    /provider ?harness=opencode 578 -> ~325 ms
    a FOURTH /provider now costs 68-76 ms (the memoized repeat)
    terminal response barrier   ~1,438 -> ~1,122 ms

**AND IT IS LARGER THAN THE ARITHMETIC SUPPORTS.** The predicted sum was ~30-45 ms (handler serves
`State.catalog`) + ~16 ms (lazy `database`) + ~11.5 ms (D.3 readiness prepare) + memoized repeats. The
observed move is -444 ms. By this document's own rule — **when the arithmetic cannot support the
magnitude, doubt the MEASUREMENT** — this is exactly the shape that produced the one retraction already
recorded here. The 1,921.2 baseline was also measured in a DIFFERENT SESSION WINDOW, and cross-window
comparison is the specific error that made the rail-clock win evaporate under a same-tree A/B.

**STATUS: PROVISIONAL. NOT A GATE PASS.** A same-session CONTROL BUILD is required before any claim,
and it has been requested from the four agents holding pre-edit byte snapshots. The control must be the
current tree with the slices' files restored, packaged and measured INTERLEAVED with the treatment in
one window. Until that exists, the honest statement is: six runs measured 1,447-1,571 ms on a build
containing the stack, and the attribution is unproven.

What would confirm it: the control arm reproducing ~1,900 in the same window, with `/provider` back at
~989 ms and the barrier back at ~1,438 ms. What would refute it: the control arm ALSO measuring
~1,477, which would mean the window moved and nothing was attributable.

## CONTROL BUILD RUN — the -444 ms was MOSTLY WINDOW DRIFT, and the real effect is ~79 ms

The provisional result (6 runs at median 1,477 against a remembered 1,921) has been tested against a
same-window control, exactly as this document's own rule requires. Three packaged builds, arms verified
in the SHIPPED BYTES each time, host settled below load 3.5 before every run, and the arm order chosen
to expose drift: CONTROL x3, TREATMENT x3, CONTROL x3.

    CONTROL   (S0: neither provider-route slice; engine artifact has `provider-list-cache` 0, `Provider.catalog` 0)
              1772  1548  1521  |  1594  1468  1480      n=6   median 1534.7
    TREATMENT (S2: both present; engine artifact has both markers 1 and 1)
              1496  1455  1437                            n=3   median 1455.4

    DELTA median 79.3 ms.   CONTROL p0 1468 / p50 1535 / p100 1772
                            TREATMENT p0 1437 / p50 1455 / p100 1496

**THE CONTROL ITSELF MEASURES 1,535, NOT 1,921.** So the baseline moved by roughly 390 ms between
windows on code that does not contain these slices, and the apparent -444 ms was overwhelmingly
BETWEEN-WINDOW DRIFT. The honest attributable effect of the two provider-route slices is **~79 ms**,
which sits comfortably inside what their authors predicted (~30-45 ms for serving `State.catalog` plus
the memoized repeats) rather than the 444 that arithmetic could not support.

This is the fourth time this effort has caught a flattering number by insisting on a same-session
control, and the second time the number would have been published as a gate pass. The rule earned it
again: **a control is a BUILD, not a remembered number.**

Two further observations, both stated as caveats rather than claims. n=3 on the treatment arm is below
the n>=15 this document specifies for cold ready, so 79.3 ms is an estimate with wide error bars — the
control arm's own spread is 1,468-1,772. And the treatment arm is TIGHTER than the control at every
order statistic (p100 1496 vs 1772), which is consistent with removing a variable per-request cost but
is not established at this n.

**Where the gate actually stands after the control:** cold ready is now measured at 1,455 (treatment,
n=3) and 1,535 (control, n=6) in this window, both under the 1,750 budget — but the control being under
budget is precisely the point. **The gate reading depends on the window as much as on the code, and no
pass can be claimed from either arm until the n>=15 protocol is run.**

### Coordination hazard that nearly invalidated the A/B

A forensic timeline reconstructed from file mtimes showed two ablation scripts writing the same files
concurrently: at 08:45:02 `handlers/provider.ts` reverted to the pre-both-slices bytes AND
`provider.ts` lost its `Provider.catalog` accessor, then at 08:47:53 both were restored. Between those
instants the tree contained NEITHER provider-route slice.

It also exposed a real DEPENDENCY rather than merely a shared file: the encode/memo slice's BOTH arms
require the handler-reuse slice's accessor, so only three coherent states exist —
`S0` (neither), `S1` (handler-reuse only), `S2` (both). **"Encode-memo present, handler-reuse absent"
cannot exist; it does not typecheck.** The scripts now enforce that precondition and print live sha and
mtime per file so a concurrent writer is visible as an mtime you did not cause.

All four ablation scripts now report `tree == treatment` and `opencode` typechecks clean, so the tree is
back in the full merged state.
