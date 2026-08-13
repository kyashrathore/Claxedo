# Claxedo five-times performance effort — HANDOFF

Read this first. The full evidence record is `docs/perf/u11-qualification-status.md` (3,494 lines);
this document is the entry point: where things stand, what was tried, what the tree contains, and how
to continue without repeating anything.

**Branch** `integrate/claxedo-memory-buckets` @ `daa87446e`
**Worktree** `/Users/yashvardhansingh/test/opencode/.worktrees/codex/memory-workgraph-perf/.worktrees/integrate/claxedo-memory-buckets`
**Tree state** 254 dirty paths (152 modified, 98 untracked, 4 deleted). NOTHING IS COMMITTED.
**Preserved** `stash@{0}` (`pre-dev-rebase-20260809-235919`), backup branches
`backup/integrate-claxedo-memory-buckets-pre-dev-20260809` and `-rebased`.
**Artifacts** 452 run directories under `artifacts/agent-app-benchmark/`, each with immutable
`summary.json`, `attempt.json`, `provenance.json` and diagnostics dumps.


### Where everything lives

| what | where |
|---|---|
| **This branch** | `integrate/claxedo-memory-buckets` @ `fb1ab0132`, 34 ahead of `dev` |
| **This worktree** | `.worktrees/codex/memory-workgraph-perf/.worktrees/integrate/claxedo-memory-buckets` |
| **Full evidence record** | `docs/perf/u11-qualification-status.md` (~3,600 lines, this worktree) |
| **Gate verdict table** | `docs/perf/gate-arithmetic-verdicts.md` (this worktree) |
| **Dependency decisions** | `docs/perf/u8-dependency-decision.md`, `vercel-labs-{scriptc,native-sdk}-spike.md` |
| **The plan being executed** | `docs/plans/2026-08-09-001-five-times-faster-than-t3-plan.md` |
| **PREDECESSOR worktree** | `/Users/yashvardhansingh/test/opencode/.worktrees/codex/memory-workgraph-perf` (branch `optimize/claxedo-sub60-under500`) |
| **PREDECESSOR experiment doc** | `docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md` in THAT worktree — 854 lines, a 43-row Memory Action Table and a 17-row Packaged Transcript Regression Ledger, measuring everything in NATIVE PHYSICAL FOOTPRINT |
| **Run artifacts** | `artifacts/agent-app-benchmark/` — 452+ directories, each with `summary.json`, `attempt.json`, `provenance.json`, diagnostics dumps |
| **This session's transcript** | `~/.prime/agent/sessions/019fe7c0-2b55-7448-bfb3-61762ae4e6f2.jsonl` (37.2 MB) |
| **Sub-agent transcripts** | `~/.prime/agent/session-artifacts/019fe7c0-.../sub-*/` — 103 files, 126.6 MB, 105 sub-sessions |
| **Ablation scripts** | `/tmp/ablate-{provider-lazy-database,provider-handler-reuse,provider-encode-raw,plugin-boot-defect}.py` with persisted arms |

**Read the predecessor doc before proposing any memory work.** It measures in physical footprint while
this record measures summed `ps rss`; the same change can be a large win in one and a regression in the
other, and that has already happened once (section 11.1).

---

## 1. WHERE THE GATES ACTUALLY STAND

| # | gate | budget | current | verdict |
|---|---|---:|---|---|
| M1 | `app.cold_ready_ms` | 1,750 | control 1,535 (n=6) vs treatment 1,455 (n=3) in one window — **provider-route slices are worth ~79 ms; the earlier -444 was WINDOW DRIFT**. Both arms under budget; needs n>=15 | **REACHABLE**, unproven |
| M2 | `work_item.cold_open_ms` | 55 | ~150 | reachable on arithmetic, no route found; needs 3.45x |
| M3 | `work_item.warm_switch_p95_ms` | 20 | ~138 | **UNREACHABLE** — measured 30.6 ms instrument floor ABOVE the budget |
| M4 | `history.navigate_p95_ms` | 100 | ~76 | passes, but the pass is UNSOUND (below) |
| M5 | `stream.interaction_p95_ms` | 16.67 | 32 | quantised to {16,24,32,40,48}; budget is "16 or bust"; has PASSED 4 of 57 runs |
| M6 | `stream.blocked_frame_ratio_pct` | 1 | 0.0 | passes, but VACUOUS — LoAF only fires above 50 ms |
| M7 | `terminal.input_to_paint_p95_ms` | 100 | ~33 | passes 3x over when valid; ~3 attempts in 7 discarded by an observer race |
| M8 | `terminal.output_mib_s` | 20 | ~20.8 | passes; structural ceiling is 21.0, so max possible win is 5% |
| M9 | `resource.peak_process_family_rss_mib` | 650 | ~1,900 | **UNREACHABLE** — see 1.1 |
| M10 | `resource.quiescent_cpu_p95_pct` | 5 | wanders 1.0-8.0 | **UNTESTABLE** — instrument least count is 1.0 pp = 20% of the budget |

**The plan as specified cannot succeed.** M3 and M9 are arithmetically unsatisfiable by application
work. M10 cannot adjudicate a change smaller than 20% of its own budget. That is a plan-amendment
decision, not a backlog.

### Cross-gate couplings that make "fix them one at a time" false
- **M3 <-> M9** a 20 ms switch requires reveals; reveals require ~20 retained live surfaces; M9 already
  fails by 3x with ONE.
- **M4 <-> M10** the only known correct fix for history navigation measured 9.98-22.98% CPU against a
  5.99 same-session control.
- **M7 <-> M8/M9** all three available observer fixes launder themselves through another gate.
- **M2 <-> M3** one instrument (`measureSessionActivation`) sits inside both measured windows.


### 1.1 What "736 MiB non-renderer floor" means

The gate sums `ps rss` across the app's whole process family and takes the single highest 1 Hz sample.
The family is five processes: **renderer, server child, Electron main, GPU, and a network utility.**

"Non-renderer floor" = the other FOUR added together, measured at the FIRST ownership snapshot of a run
— immediately after launch, before the benchmark has opened a session, switched a tab, or streamed
anything. Across **379 recorded launches** that number has never been below **676.0 MiB**, with a median
of **745.3 MiB**.

So even if the renderer used **zero bytes**, the app would still measure ~676-745 MiB against a 650 MiB
budget, at the moment it finishes starting. Cold first-snapshot breakdown: server child 391.6, Electron
main 200.1, GPU 105.3, network utility 49.9.

Three of those four are Electron's own processes with **zero app payload** — the utility is
`network.mojom.NetworkService` and measures 49.5-50.2 across all 379 runs regardless of what the app
does, and main's RSS varies by under 8 MiB across wildly different runs, which is what proves it is
browser-process baseline rather than our 1.4 MB of code.

That is why it is called UNREACHABLE rather than "hard": no amount of application work can subtract
from a floor that is already over budget before the application does anything. The remaining ~1,150 MiB
on top of it is renderer and is real, but closing the gate needs the floor to move, and the floor is
Electron's process topology. See section 3 of `u11-qualification-status.md` for the per-process
derivation and the ~950 MiB figure that IS reachable.


### 1.2 Scope note: this effort measured the DESKTOP app only

Every gate, artifact and finding in this document is the packaged macOS Electron app driven through
CDP. **The web app was never measured.** That is a real gap in the goal rather than an oversight to
paper over: the product ships a web surface (`packages/claxedo-web`, and the browser flow lane
`perf-harness/src/browser-runner.ts` with its own fixture server on port 4455) and none of the ten gates
covers it.

What transfers and what does not, so a successor does not re-derive it:
- **Transfers:** everything renderer-side and algorithmic — the provider catalogue passes, markdown
  highlighting off-thread, the 4-turn history window, `renderOverscan` starting at 1, the query cache
  having no byte cap, the per-instance completed-code cache that a remount discards.
- **Does NOT transfer:** every process-level finding. There is no server child, no Electron main, no GPU
  process and no network utility, so the 736 MiB non-renderer floor, the worker-transport result and the
  compile-cache work are all desktop-only. `peak_process_family_rss_mib` has no meaning in a browser tab.
- **Different instrument entirely:** the browser lane already exists and already fixtures
  `/api/claxedo/session-list`, `/api/claxedo/session`, `POST /api/claxedo/usage/sync` and
  `/api/claxedo/workspace/resolve`, so its numbers are NOT comparable to the packaged app's and must not
  be pooled with them.

A web-app performance goal needs its own gate set, its own budgets and its own corpus digest. The
measurement rules in section 6 apply unchanged.

---

## 2. THE TWO FACTS THAT DECIDE M1

**(a) The binding constraint is `/provider`,** median 1,121 ms, the longest request in all 7 analysed
runs, anchoring the terminal response barrier in 5. Its split, from the app's own Effect tracer:

    InstanceStore.load .................. 596-676 ms
      Plugin.init ....................... 458-538 ms   <- 366-395 ms of it is ONE THIRD-PARTY PLUGIN
      Project.fromDirectory ............. 58-115 ms    (git subprocesses)
      Config.get ........................ 25-28 ms
    Provider.list ....................... 246-270 ms
    handler body ........................ 100-120 ms

**(b) The largest single term is not ours.** `opencode-antigravity-auth`, installed from the
OPERATOR'S `~/.config/opencode/opencode.json`, awaits an **uncached network fetch with a 5,000 ms
timeout** in its constructor, on every boot, with a second fetch as its timeout fallback. The harness
pinned the profile, data dir and corpus by SHA but spawned the app with the operator's full
environment, so this has been inside every measured boot for the entire effort.


### 2.1 Two questions this raises, both fair, one of which is a real defect

**"Why load a huge provider list when the selected harness is not opencode?"** — It does not, and that
was checked rather than assumed. `providerBody` (both the compat route and the server's own bootstrap
route) reads `resolveHarnessId(...)` FIRST and returns `piProviderCatalog(env)` or
`localProviderCatalog(harnessId, options)` without touching the engine unless the resolved harness IS
opencode. And when it is opencode, it asks the engine for `?view=index`, not the full catalogue — the
app-visible body is **7.7 KB**, not 4.7 MB. The full-list ask was removed 252 commits ago in
`c9d0a8051`.

What remains true and IS a cost: the DEFAULT harness on a machine with no user config is opencode
(`defaultHarness` falls back to `{ id: "opencode" }`), so on the benchmark profile that branch is always
taken. And `view=index` still requires `State`, so the engine still pays the full initializer —
`InstanceStore.load` 596-676 ms plus `Provider.list` 246-270 ms — regardless of how little of the
catalogue is returned. **The request shape was never the cost; the initializer is.**

**"Why is a plugin inside a harness a blocker for us before that harness is even selected?"** — THIS ONE
IS A REAL DEFECT, and it is the sharper version of the finding in section 2.

The plugin does not belong to a harness the user picked. It is installed in the OPERATOR'S GLOBAL
OpenCode config (`~/.config/opencode/opencode.json`), and it is constructed by
`InstanceBootstrap -> config.get() -> plugin.init()` as part of bringing up the OpenCode INSTANCE — not
as part of selecting a harness. `/provider` carries `InstanceContextMiddleware`, which AWAITS
`store.load({directory})` before the handler body runs, so ANY engine-bound request pays the whole
plugin set, in construction order, before it can be answered.

That means a plugin whose constructor does an uncached network fetch with a 5,000 ms timeout —
measured at 366-395 ms typical, >5 s worst case — sits in front of the first engine request of every
boot, whether or not the user ever uses the provider that plugin exists to authenticate.

Three separate things follow, and they are deliberately kept apart:

1. **Bounded degradation (SHIPPED).** `PLUGIN_INIT_BUDGET_MS = 1_000` stops the sum growing without
   limit and stops a hung plugin wedging the app. It buys 0 ms in the normal case by design.
2. **Reclaiming the 366-395 ms (NOT AVAILABLE TODAY).** A budget short enough to cut it would race the
   first `/provider` and could silently omit a configured provider, because `Provider.state` and
   `ProviderAuth.state` derive from `list()` ONCE and `InstanceState.invalidate` has ZERO call sites in
   src. Reclaiming it needs three pieces of machinery that do not exist, and even then MOVES the cost
   rather than removing it.
3. **Lazy plugin construction per harness — NOT TRIED, and the most promising unexplored direction.**
   Nothing in the current design ties a plugin's construction to whether its harness or provider is
   ever used. If plugins could be constructed on first USE of the thing they extend, rather than during
   instance bootstrap, the boot path would not pay for a provider the session never selects. That is a
   design change in the engine, it interacts with the same no-invalidation problem as (2), and it is
   recorded here as an open direction rather than a scoped slice.

---

## 3. THE ISOLATION DECISION (adopted, with conditions)

Put independently to three models. Two returned and converged: **measure BOTH, publish ISOLATED as the
gate, keep AMBIENT as a tracked non-gating companion.** Conditions, all adopted:

- **A — re-baseline everything.** Isolated mode applies to ALL TEN gates and the historical series is
  re-measured. "A gate series measured half one way and half the other is not a series."
- **B — the gate TEXT changes**, not just the number: "cold ready, pinned ambient environment", the
  same class of pin as corpus/profile/data-dir.
- **C — no defect is retired.** Isolation removes the plugin from the MEASUREMENT, not the DEFECT.
  Shipping isolation without the plugin-boot fix would be laundering. (That fix is landed — sec. 4.)

**The legitimacy test a reviewer should demand:** whether the previously-PASSING gates were also
re-measured under isolation. If isolated mode appears only on the failing gate, it is number-shopping.
And the paired same-commit A/B must show the isolated-minus-ambient delta landing almost entirely
inside `/provider` on the plugin's own span (~366-395 ms); if the delta EXCEEDS what the plugin span
explains, isolation also hid product cost.

Mechanically ready: `CLAXEDO_BENCH_ISOLATE_AMBIENT=1` pins `XDG_CONFIG_HOME`/`XDG_CACHE_HOME`/`HOME`
to an empty dir under the run's own profile; **off by default**; `provenance.json` always records
`ambientEnvironment: "isolated" | "operator-ambient"`.

---

## 4. WHAT IS IN THE TREE — RETAINED

Each of these is implemented, tested with a red/green ablation, and typechecked. **None is committed.**

| slice | files | measured | gate effect |
|---|---|---|---|
| PTY disk-history compaction (bounded, hard UTF-8 cap) | `workspace-runtime/src/pty/history-disk.ts`, `safe-slice.ts` | quiescent CPU 334.5% -> ~4% | **real, huge** |
| Shell-bootstrap receiver fix | `global-sync/shell-bootstrap.ts` | `globalSync.ready` 1,405 -> 346 ms | real |
| Reconnect-repair presentation gate | reconnect offset repair | warm p95 188.5 -> 138.8 across 181/114 runs, **0 of 114 later runs ever returned to >=180** | **real, survives both screens** |
| Workspace-resolve single-flight v2 | `workspace-resolve-read.ts`, `http-backend.ts` | cold ready 2,142 -> 1,985 | real |
| PTY query-suppression span slicing | pty | 196.9M -> 13.3M appends, byte-identical across 263,089,171 differential calls | merit, gate-null |
| Session-metadata reconcile generation gate | 3 files, `claxedo-local-server` | **CPU claim WITHDRAWN by audit** | **merit, gate-null** |
| Rail clock scoping | `rail-sidebar.tsx` | **win RETRACTED** — same-tree A/B gave 0.1 ms | merit, gate-null |
| Composer Suspense read guard | `suspense-safe-resource.ts`, 2 readers | re-suspension 75.1 -> 15.5 ms median | merit, gate-null (-2.1 ms) |
| Slice A: empty catalogue never replaces populated | `provider-list.ts`, `control-plane.ts`, `bootstrap.ts` | correctness — 3 of 4 writers were unguarded, one clobber reachable | zero by design |
| Engine compile cache (shipped, seeded) | `opencode-compile-cache.ts`, generator, wiring | **134.3 ms** of loop-blocking occupancy, isolated on the packaged artifact | null (masked) |
| Server-bundle compile cache | `claxedo-server-boot.ts` + generator | 41.0 ms compile - 5.5 ms seed = **+35.5 ms** | **null under the current binding constraint** |
| Workspace-store git short-circuit | `workspace/store/index.ts` | 4 `execFile("git")` (47-53 ms) skipped per already-known workspace, ~9 boot requests | unmeasured |
| Plugin init budget | `plugin/index.ts`, `runtime-flags.ts` | 0 ms at default; >5 s -> 1 s in the degraded case | robustness |
| Lazy `database` in Provider init | `provider.ts` | ~16 ms | unmeasured |
| Handler serves `State.catalog` | `handlers/provider.ts` + `Provider.catalog` accessor | ~30-45 ms, **byte-identical golden test passes** | unmeasured |
| `/provider` encoded-body memoization (+ disk layer) | `provider-list-cache.ts` | ~60-75 ms per repeat request | **not on the desktop boot path** |
| Readiness `prepare()` (D.3) | `main/server-readiness.ts` | **11.5 ms**, non-overlapping arms | unmeasured, ~5-11 ms expected |
| Model picker hydration + saved-selection heal | `models.tsx`, `select-model.tsx`, `session-selection.tsx` | **two shipped user-visible defects** | zero |
| Harness: ambient isolation + `physFootprintBytes` + quiet-host preflight + startup clock | perf-harness, `agent-host-preflight.ts` | instrument only | — |

### Two shipped product defects found and fixed
1. **The main composer model picker opened showing ONE model per connected provider and stayed that
   way.** `c9d0a8051` wired per-provider detail loading into the manage-models and provider DIALOGS
   only; the main picker never invoked the `providers.load(id)` seam that already existed.
2. **A saved NON-DEFAULT model selection silently failed validation at boot** and fell back to the
   provider default, because `validModel` requires `provider.models[modelID]` which the index lacks.

---

## 5. WHAT WAS TRIED — WHAT I OBSERVED, AND WHAT WOULD MAKE IT WORTH RETRYING

Nothing here is forbidden. Each entry is what was measured and the condition under which the result
would no longer hold. **If that condition has changed, retry it — and if you do, say so, because the
same idea has now been tried twice in two efforts without either knowing about the other.**

**Reverted after packaged measurement** — each was implemented, packaged and measured, and each lost. Retry any of them only with a same-session control and n>=15 for cold ready or n>=5 for RSS: session-owner retarget (2 steps), local inventory
single-flight, terminal-stream byte cache, timeline warm-snapshot reveal (32-entry LRU — made warm
switch AND history worse), cold-activation first-fold hydration, Bun server sidecar (NAPI panic),
markdown batch parse, cross-mount highlight reuse, `content-visibility: hidden` (saved 55 MiB, cost
stream and history), `adoptNode`, shell-bootstrap warm + rail gate, mode-scan guards, history
hash-scroll fix (CPU 5.99 -> 9.98-22.98), Markdown pending-resource no-op, query-persister coalescing,
engine pre-load, worker transport, provider dedupe (Slice B), markdown completed-code cache.

**Killed by proof rather than measurement — with what would change the answer:**

- **Engine pre-load — ZERO-SUM, proven arithmetically.** RETRY IF: the readiness path stops running on the same thread as the engine import, or the import stops being synchronous.
  OBSERVED: `/provider` -356 ms but `globalSync.ready`
  +371; the cluster ends at the same instant (841.3 vs 849.1). And no placement exists: 663-698 ms of
  blocking against a ~330 ms quiet window.
- **Prewarming `/provider` at server start — dead by MECHANISM.** RETRY IF: `startOwned` gains a real suspension point before `serve()`, or the engine import moves off the server child's main thread.
  OBSERVED: `startOwned` is synchronous; from
  `configureAgentConfig` to `serve()` there is **not one `await` on the executing path**, so the
  prewarm's first act runs in the microtask drain BEFORE the listen callback, and that act is a
  synchronous ~370 ms engine import on the one thread that owes readiness an answer. The overlappable
  waits are all downstream of it. Negative isolated AND ambient.
- **Worker transport.** RETRY IF: the gate stops being a `Math.max` peak, or the metric moves to physical footprint — the predecessor effort measured this SAME idea as a large WIN on native footprint (315/290/292 MiB, section 11.1).
  OBSERVED: +129 ms cold ready, +130 MiB RSS, CPU failing 2 of 6. The engine did
  move (server child 374.6 -> ~190 MiB) but the worker costs 310, so one process became two for
  +125 net, and the idle-exit never fired. **`peak_process_family_rss_mib` is a PEAK, so a process that
  exits later cannot reduce it even in principle.**
- **`/provider` raw encode (`handleRaw` + `jsonUnsafe`).** RETRY IF: construction order is aligned to schema declaration order at every `Info` site, or the acceptance bar is deliberately relaxed from byte to key-order-canonical equality (which changes bytes for any ETag/hash consumer).
  OBSERVED: killed at its own byte gate. Effect's
  Struct encode REORDERS keys into schema declaration order; `Info` declares
  `(id, name, source, ...)` while `fromModelsDevProvider` constructs `(id, source, name, ...)`. Same
  byte count, same values, pure ordering. The transform argument HELD and it still died.
- **Making the app request `view=index`.** RETRY IF: a client is found that hits the engine's FULL-list branch on the boot path — none was.
  OBSERVED: already true. The compat route
  (`provider-config.ts:30-48`) already sends `view=index`; the full-list ask was removed 252 commits
  ago. The two engine `/provider` requests COMPLETE AT THE SAME INSTANT (1,315.5 / 1,315.4) — two
  waiters on ONE shared init, so there is no dedupe win either.
- **Reclaiming the plugin's 366-395 ms.** RETRY IF: `InstanceState` gains a non-destructive refresh and a generation counter, or plugin construction becomes lazy per harness (section 2.1).
  OBSERVED: needs three pieces of machinery that do not exist
  (split volatile identity out of derived state; a non-destructive refresh; a generation counter), and
  even then it MOVES the cost rather than removing it, with duplicate token refreshes.
  `InstanceState.invalidate` has ZERO call sites in src, and `ScopedCache.invalidate` closes the entry
  scope out from under in-flight readers.

---

## 6. MEASUREMENT RULES — EVERY ONE PAID FOR

These are not style. Each was learned by getting a number wrong and having to withdraw it.

1. **A control is a BUILD measured in the SAME session window, never a remembered number.** Violating
   this produced the one published win that had to be retracted: rail-clock "138.5 -> 128.5, uniform
   across the distribution" was baseline drift; the same-tree A/B later gave **0.1 ms**.
2. **Screen A/B shape before interpreting.** Constant ABSOLUTE shift at all percentiles including the
   fastest -> suspect DRIFT. Constant RATIO -> real per-unit cost. Tail-only -> rare collision.
3. **Compare p0/p10 first.** If the BEST case moved, the arms are not comparable and nothing
   downstream is interpretable.
4. **PERSISTENCE is the strongest screen for a retained slice**: does the metric ever return to the
   pre-fix level across all later runs? Drift is transient; a real fix is a level change. This is what
   confirmed reconnect-repair (0 of 114) and withdrew the reconcile CPU claim (post-fix runs reproduce
   5.989, 5.993, 5.994, 7.993 WITH the fix in).
5. **When the arithmetic cannot support the magnitude, doubt the MEASUREMENT.** A -197 ms cold-ready
   move against a 134.3 ms mechanism budget is not a win; it is a noisy comparison.
6. **Reducing total work is NOT making the measured window cheaper.** Seven candidates died to this.
7. **A candidate disproved in one lifecycle phase is not disproved globally.** The composer
   re-suspension was disproved for warm switch and was real for cold open.
8. **Never generalise from PASSING runs about a failure mechanism.** Survivorship hid the terminal
   defect for 23 trials — all 14 "echoes arrive in tiny batches" observations came from runs that
   passed.
9. **A NULL cannot distinguish "no change" from "no contact."** Show a positive control from the same
   harness proving it saw your work — e.g. a pass-count delta.
10. **Verify what is IN the build.** Extract the packaged artifact and grep before drawing conclusions.
11. **Cold ready needs n>=15 per arm** or a stated robust test: population IQR is 283 ms, the tail
    reaches 5,099 ms, and there is ~85 ms of between-window drift on identical bytes.
12. **RSS needs ~198 MiB to be resolvable at n=3** (pooled SD 50-100 MiB). Six candidates worth
    -1 to -15 MiB were not null results — they were UNMEASURABLE ones.

### Instrument defects found (three gates measure something other than their name)
- **Warm switch** measures a COLD MOUNT 20 times out of 20 (`warmHidden = 1` against a 20-session
  shuffle) and carries a 30.6 ms floor of CDP round trips.
- **Terminal input** discards correct echoes: the observer's 64 KiB `parsedTail` gate evicts an echo
  that arrived in a large batch, so `serialize()` is never called. Two adjacent windows —
  `bytesFromEnd < 65,536` to open the gate, `< ~339,788` to still be in the scrollback. Both gate
  clauses are now fixed; the residual above ~340 KB is genuinely unknowable.
- **Stream** is left-censored at 16 and quantised to 8 ms, so the budget of 16.67 admits exactly one
  passing value.

### Host hazards that corrupted real runs
- **Two orphaned Playwright suites ran for 3h08m at load 11.73** through fourteen packaged runs, with
  ffmpeg encoders at 171% CPU. Now guarded: `assertQuietHost` refuses a 1-minute load average above 4.
- **Relative paths resolve into the WRONG GIT TREE.** The kernel cwd silently reverts to the main repo;
  three agents were affected and one wrote three edits there. Use ABSOLUTE paths for reads AND writes,
  read back through an independently derived path, and sanity-check row COUNTS after any bulk load.
- **Concurrent edits to one file race.** Two agents editing `provider.ts` produced a duplicated
  declaration that existed for ~24 seconds. Re-read by content, count occurrences after editing,
  announce before and after.

---

## 7. HOW TO CONTINUE — THE QUEUE, IN ORDER

Everything below is blocked ONLY on the host being on AC and quiet. The preflight now enforces both.

### 7.1 Measure the landed stack (one packaged build, already built and verified)
Four slices are confirmed present in the shipped bytes: `makeLazyDatabase` (engine x4),
`Provider.catalog` (x1), `PLUGIN_INIT_BUDGET` (x2), `knownDirectory` (asar x3), plus D.3.

    bun run --cwd packages/claxedo-desktop package:mac -- --arm64
    # then, interleaved, n>=15 per arm for cold ready:
    <benchmark> --profiles workspace-core-v1 --output artifacts/agent-app-benchmark/<name>

Expected, none of it converted to a gate delta: handler catalog reuse ~30-45 ms, lazy database ~16 ms,
D.3 ~5-11 ms, git short-circuit ~9 x 50 ms of subprocess time off request critical paths.

### 7.2 THE DECISIVE EXPERIMENT — paired isolated vs ambient
    CLAXEDO_BENCH_ISOLATE_AMBIENT=1 <benchmark ...>     # arm A
    <benchmark ...>                                     # arm B
n>=8 per arm, **interleaved A,B,A,B**, same build, same session window, host verified quiet by `ps`
before and after. Read `provenance.json` `ambientEnvironment` on every run.
**Acceptance:** the isolated-minus-ambient delta must land almost entirely inside `/provider` on the
plugin's span (~366-395 ms). If it EXCEEDS what the plugin explains, isolation also hid product cost —
that is gate-shopping and must be reported as such.
Then **re-measure ALL TEN gates isolated**, including the ones already passing (Condition A).

### 7.3 The startup-clock instrument (one run, settles two open questions)
    CLAXEDO_BENCH_STARTUP_CLOCK=1 <benchmark ...>
    # read <run>/startup-clock-lead.json
`leadToFirstProviderRequestMs` prices the prewarm ceiling for good; the four handoff stamps
(`server-listening` -> `main-server-ready-message` -> `main-server-health-verified` ->
`main-server-ready-published`) price D.3 in situ. It also TEES the child's stdio to `app-stdout.log`
instead of dropping it — the blindness that hid the engine compile for five retained changes.

### 7.4 The initializer intercept discriminator
Instrument `provider.ts:1402-1712` with two timestamps and read the INTERCEPT against catalogue size.
Standalone intercept is 6.25 ms. **~18 ms in situ means the statements are simply costlier; ~115 ms
means the true slope is ~12 us/model and the residual is CONSTANT effectful work misread as
per-model.** One number decides which.

### 7.5 Terminal residual rate
`bytesFromEnd` is now recorded per echo in the artifacts, so every future run contributes to the
denominator at zero marginal cost. Do NOT hunt failures; read the distribution after a few dozen runs.

### 7.6 Still unowned
- **M2 cold open**: `targetRow` is the binding conjunct; 15 rows rendered with NONE intersecting the
  viewport for ~60 ms. The one-line discriminator (`targetInDom`) is built and unrun — `0` means a
  windowing bug, `>=1` means scroll position.
- **M9**: the isolated-vs-full carry-over is **716 MiB** (measured, pre-registered claim SUPPORTED),
  ~85-90% renderer. Deciding whether the resource sweep should run on a fresh app is a metric-scope
  contract change, not a product change, and must be argued as one.
- **M4**: the history force-scroll fix works (0 force-scrolls in 10/10) and costs M10 outright.

---

## 8. HOW TO PARALLELISE — WHAT CAN AND CANNOT

**SERIAL, always.** The packaged benchmark. It measures wall-clock latency, vsync-quantised frames,
GPU compositing and process-family RSS on ONE machine. Parallel runs do not speed it up, they
invalidate it — proven twice here: two orphaned e2e suites corrupted fourteen runs, and the terminal
defect ONLY reproduces under the harness's own per-second load. Budget ~65 s to package plus 1-3 min
per run.

**MASSIVELY PARALLEL, and under-used.** Everything headless and server-side. Demonstrated:
**140 measurements — 20 catalogue sizes x 7 replicates — sharded across three AWS Graviton instances
and collected in 2.0 seconds of wall time**, giving 8.75 us/model at R^2 0.9995. That is the right
division: absolute gate values on the reference machine, per-unit costs and algorithmic deltas on as
many cheap machines as the question needs.

    Remote hosts used: c7g.2xlarge + 2 x c7g.xlarge, ap-south-1, ~$0.30/hr total.
    Key at /tmp/<name>.pem, IPs in /tmp/claxedo-ec2-ip.txt and /tmp/sweep-ips.txt.
    TERMINATE THEM when done: aws ec2 terminate-instances --region ap-south-1 --instance-ids ...
    Gotchas hit: vCPU limit 16 in this account; EC2 Mac needs a dedicated-host quota that is 0;
    and the operator's public IP changed mid-session, silently breaking SSH until the security
    group was re-authorised.

**PARALLEL BUT BOUNDED — sub-agents.** What worked and what did not:
- **Narrow briefs work; broad ones return nothing.** Six agents given "read this 2,900-line document
  and survey the codebase" completed WITHOUT REPLYING, having burned their budget reading. Agents told
  "read exactly these two files and answer these four questions" delivered every time.
- **Give every agent the falsifier that would kill its own slice, up front.** The byte gate killed the
  raw-encode slice; the lead gate stopped the prewarm; the "if lead < 120 ms, stop" instruction was
  obeyed. Agents stop correctly when told what would disqualify them.
- **Serialise edits to a shared file.** Announce before and after; re-read by content; count
  occurrences.
- **Model routing used here:** `anthropic/claude-fable-5` for the hardest analysis,
  `anthropic/claude-opus-5` for implementation with heavy invariants, `prime-inference/openai/gpt-5.6-sol`
  available. Independent judgements from multiple models on the SAME question converged and produced
  the conditions in section 3 — worth repeating for any decision that changes what a number means.

---

## 9. THE HONEST SUMMARY

Two gates are arithmetically unreachable, one is untestable at its instrument's resolution, one passes
vacuously, and one passes on a defect. The single largest term in the only reachable gate belongs to a
third-party plugin the product does not own. Seven candidates removed real, measured work and moved no
gate, each for a reason now written down.

What that leaves is not "keep optimising". It is: **publish the isolated number with the ambient number
beside it, re-baseline all ten gates, amend M3/M9/M10 with the measured impossibility arguments, and
ship the correctness fixes** — the plugin boot budget, the two picker defects, the empty-catalogue
guard, the git short-circuit — which are worth having whether or not any gate moves.

**The goal as specified is not achievable. That conclusion is measured, not asserted, and every number
behind it is reproducible from `artifacts/agent-app-benchmark/`.**

And the goal as specified is also INCOMPLETE: it covers the desktop app only. A five-times claim for the
product needs the web surface measured too, on its own gates, and none of that work exists (section 1.2).

---

## 10. PREDECESSOR WORK — `backup/claxedo-sub60-pre-dev-rebase-2026080{8,9}`

An earlier idle-memory/footprint effort (7-8 August), snapshotted twice before its own rebase. Its
commits exist ONLY on these two branches — 14 unique on `-20260809`, 2 on `-20260808` (a one-day-older
copy of two of them; the branches are divergent, not ancestor/descendant). Patch-id comparison against
this branch: **1 of 14 survived** — `defer provider bootstrap`, now `44b0b3fa0`.

Recorded here so the branches can be deleted without losing what they mean.

| commit | this effort's finding |
|---|---|
| `optimize(claxedo-idle-memory): unmount hidden non-terminal surfaces` **+ its Revert** | Tried and reverted THERE too. Re-tested here as `content-visibility: hidden`: saved 55 MiB, cost stream 24 -> 32/40 ms and produced a 104.7 ms history sample. Reverted. The stashed surface is deliberately `content-visibility: visible` and the comment records why. |
| `optimize(claxedo-idle-footprint): host server in node mode` | The desktop already forks the server child with `ELECTRON_RUN_AS_NODE=1` — same Mach-O as main, not node, not bun. Measured consequence: there is no "already-loaded Node runtime" to share, so a `utilityProcess` buys lifecycle ergonomics, not RSS. |
| `refactor(desktop): unload idle embedded engine` | Re-tested as the worker transport. **Measured +129 ms cold ready, +130 MiB RSS, CPU failing 2 of 6.** The engine did move (server child 374.6 -> ~190 MiB) but the worker costs 310, so one process became two for +125 net — and the idle-exit never fired. **`peak_process_family_rss_mib` is a PEAK, so a process that exits later cannot reduce it even in principle.** Do not retry. |
| `optimize(claxedo-idle-footprint): bound server heap` | Now shipping as `claxedoServerExecArgv()` = `--expose-gc --optimize-for-size --max-old-space-size=512`. Note the side effect nobody had modelled: those flags are in the V8 FLAG HASH, so the compile-cache directory tag differs (`ff1546d9` vs `f02d4d51`) and a cache generated without them is never read. |
| `perf(server): lazy-load remote sandbox drivers` | **NOT re-tested here.** Still open. Cheap to check whether the drivers are in the server child's static closure — the 9.11 MB closure is now enumerated (23 files) by the compile-cache generator, so this is a grep. |
| `optimize(claxedo-idle-footprint): suspend idle host metrics` | **NOT re-tested here.** Adjacent to a measured finding: the always-armed periodics are a 10 s wake detector, a 20 s health peek and a 60 s workgraph poll — all far too infrequent to matter per-switch, but they do land in the quiescent-CPU window, which has a 1.0 pp least count. |
| `optimize(claxedo-idle-memory): defer provider bootstrap` | The ONLY one that survived into this branch (`44b0b3fa0`). |
| `feat(desktop): lazy-load optional work surfaces` | Superseded: progressive loading is now measured to ship at every level — a 4-turn initial history window, `renderOverscan` starting at 1, off-thread markdown, lazily imported timeline/composer. Twelve rendered rows against a 217-row conversation. "Render less up front" is not available. |
| `test(desktop)`: restored-state memory benchmark, empty-shell distinction, fixture validation, core-runtime gating | Superseded by the agent-app benchmark and its 452 artifact runs, but the INTENT is worth keeping: an "empty shell" cohort is exactly what would separate the ~1,380 MiB architectural floor from the ~540 MiB of per-scenario carry-over measured here at **716 MiB**. |

**Two ideas from that branch remain untested here** — lazy remote sandbox drivers and suspending idle
host metrics. Both are cheap to check and neither is likely to move a gate: server-child work is masked
by the `/provider` barrier for time, and by the renderer's >=83% share for memory.

---

## 11. COMPLETE IDEA LEDGER — including the predecessor effort

Scanned to build this: the predecessor plan
`docs/plans/2026-08-07-003-refactor-claxedo-idle-memory-plan.md` in the PARENT worktree
`/Users/yashvardhansingh/test/opencode/.worktrees/codex/memory-workgraph-perf` (854 lines, a 43-row
Memory Action Table and a 17-row Packaged Transcript Regression Ledger), this session's own log
(37.2 MB), and all 103 sub-agent transcripts (126.6 MB across 105 sub-sessions). Decision-language
scan returned 5,053 distinct snippets across 92 sub-sessions; an idea-phrase scan returned 4,852
distinct phrases, of which **only 9 recurred without any trace in these docs** and are resolved below.

### 11.1 Predecessor effort — the idle-memory campaign (7-8 August)

Its own ledger is the authority and it is NOT reproduced here line by line; it lives in the plan file
above and measures everything in NATIVE PHYSICAL FOOTPRINT, not summed RSS — which is the origin of
the 650 MiB budget mismatch documented in this record. Trajectory it records:
**1,040.8 MB observed -> 865 MiB controlled baseline -> 643 -> 465 -> 431 -> 315/290/292 MiB median.**

Stages this record had NOT previously carried, now added:

| stage | action | measured result |
|---|---|---|
| 0B | manual checkpoint on the packaged app | 1,450.6 MB over eight rows; renderer 758.3 MB |
| 7 | WorkGraph and Documents default-off, lazy, absent from unsigned composition (`9774813b0`) | 643 -> 465 MiB restored-state median; 440 MiB clean profile |
| 10 | lazy-load broader shared-server imports | 431 MiB median |
| 12 | run OpenCode in a DISPOSABLE CHILD PROCESS (`1ae63e856`) | 315 / 290 / 292 MiB, median 292 |
| V1 | revalidate default-off WorkGraph/Documents against clean `dev`, three fresh paired runs | post-idle 556 -> 469 MiB; empty-shell 743 -> 712 |

**Stage 12 is the one to read before anyone proposes it again.** "OpenCode in a disposable child
process" measured a large win THERE, on native footprint. Re-tested in THIS effort as the worker
transport it measured **+129 ms cold ready, +130 MiB summed RSS, quiescent CPU failing 2 of 6**, and
the idle-exit never fired. The two results are not contradictory: they are measured in different UNITS
on different METRICS. Footprint rewards a process that exits; `peak_process_family_rss_mib` is a
`Math.max` over a 1 Hz sample and cannot, even in principle.

### 11.2 The 17-row Packaged Transcript Regression Ledger

A structured hypothesis table for a rendering regression (preview-versus-rich rows, range admission,
initial reveal and bottom settlement, and so on), each row carrying a candidate behaviour, how it could
contribute, and a priority. Not re-tested here — this effort measured latency and memory gates, not
that regression — but it is the right shape for a hypothesis ledger and it remains open.

### 11.3 Ideas found ONLY in sub-agent transcripts

The phrase scan surfaced nine recurring items with no trace in either doc. Seven are not performance
candidates at all — capability-graph acyclicity, capability acquisition and intersection, prewarmed
Hetzner/AWS leases, PTY capability replies — they belong to other work. The two that are real:

- **Terminal backpressure and batching ceilings.** `features/terminal/ui/terminal-limits.ts` exists and
  holds the tuning constants for the write path (`pending`, `pendingBytes`, `overloaded`, a frame
  cancel and a write timeout), extracted from `terminal.tsx` to bring that file under its size ceiling.
  **Never varied as an experiment in this effort.** It is directly adjacent to two measured findings:
  the terminal echo race, whose whole mechanism is parsed-batch SIZE against a 64 KiB observer window;
  and `terminal.output_mib_s`, which passes at 20.8 against a structural ceiling of 21.0. Anyone tuning
  those constants must screen BOTH — the batching ceiling is the variable the echo defect is measured
  in.
- **Packaging-time skips** (`skipping icon copy`, `skipping react-grab inline`) are build-script warning
  paths, not runtime candidates. Recorded so the scan is complete, not because they are levers.

### 11.4 Completeness statement

Every idea from this session with an outcome is in `u11-qualification-status.md`; the retained and
rejected sets are summarised in sections 4 and 5 above. The predecessor's ideas are in its own plan file
plus 11.1. **Two ideas remain untested anywhere**: `perf(server): lazy-load remote sandbox drivers` and
`optimize(claxedo-idle-footprint): suspend idle host metrics` (section 10), plus the terminal batching
ceilings above. Nothing else surfaced by the scan lacks a recorded outcome.

### 11.5 The `wip: preserve renderer memory and performance experiments` commits

`99b93d31c` (on the 0809 snapshot) and `da90f885a` (0808) are two near-identical WIP checkpoints —
**82 files / +3,630 -1,007** and **84 files / +3,623 -1,031** — and they are NOT represented by
patch-id on the live `optimize/claxedo-sub60-under500` branch. They are the largest unrecorded thing
in the archive, so their content is summarised here before the branches are dropped.

What they touch, from the diffstat:

- `packages/ui/src/context/marked.tsx` (+227/+235) and a new `marked-native.test.ts` — a MARKDOWN
  RENDERING experiment, and the largest single hunk. Directly adjacent to this effort's measured
  finding that markdown highlighting is a worker round trip whose phases are wall-clock across an
  `await`, not main-thread CPU, and that the completed-code cache is per-component-instance so every
  remount re-does it (recorded as UNFIXED).
- `packages/session-ui/src/components/markdown.tsx` (+170/+179) and `message-part.tsx` (+58) — the same
  surface this effort measured at 52-58 ms per switch for three code blocks.
- `packages/session-ui/src/pierre/virtualizer.ts` (+11) — the virtualizer whose `renderOverscan`
  starting at 1 was later measured and documented here.
- A new `packages/ui/src/components/inline-svg-sprite.ts` (+46) plus changes to `icon.tsx`,
  `file-icon.tsx`, `provider-icon.tsx`, `codex-icons.tsx` — an ICON SPRITE INLINING experiment. **This
  one has no counterpart anywhere in this effort and no recorded outcome.** It is a plausible
  bundle-size and first-paint lever that was never measured under the current gates.

So of the five 0809 commits absent from the live branch: `defer provider bootstrap` survives in this
branch as `44b0b3fa0`; `host server in node mode` and `unload idle embedded engine` were re-tested here
and REJECTED with numbers (worker transport: +129 ms, +130 MiB, CPU failing 2 of 6); `lazy-load optional
work surfaces` is superseded by progressive loading that measurably already ships; and the WIP pair is
summarised above. **The one idea in them with no recorded outcome is the inline SVG sprite.**
