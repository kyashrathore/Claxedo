# Performance learnings for agents

Read [README.md](./README.md) for what shipped. This file is the ledger of what we already tried and should not retry without a new reason.

The old experiment logs, worktree handoffs, gate-arithmetic tables, idle-memory action table, and experiments index are gone. Git history still has them. Do not reconstruct them as working docs.

The machine-readable twin of this ledger is `packages/claxedo-app/perf-harness/evidence/prior-evidence.json`. The harness rejects a duplicate experiment question unless you declare a new metric or an invalidated current-tree boundary.

## Do not retry unless the condition has changed

If you retry any of these, say so in the work: the same idea has now been tried in more than one effort without either knowing about the other.

| Attempt | What happened | Retry only if |
|---|---|---|
| Engine in a disposable worker / `utilityProcess` | Later campaign: +129 ms cold ready, +130 MiB peak family RSS, CPU failing 2 of 6. Engine moved (server child 375 → ~190 MiB) but the worker costs ~310. Idle-exit never fired. Earlier campaign, **native physical footprint**: 406 → 292 MiB median, a real win in that unit. | The gate is no longer a `Math.max` peak, **or** the published metric is native physical footprint and you are not also gated on peak family RSS. Peak RSS cannot, even in principle, reward a process that exits later. Do not cite the 292 MiB number against an RSS budget. |
| Engine pre-load on the server thread | `/provider` −356 ms, `globalSync.ready` +371 ms. Cluster ends at the same instant. | Readiness no longer runs on the same thread as a synchronous engine import. |
| Prewarm `/provider` at `startOwned` | Dead by mechanism: `startOwned` is synchronous through `serve()`, so the prewarm's first act is a ~370 ms import on the thread that owes readiness an answer. Negative isolated and ambient. | `startOwned` gains a real suspension point before `serve()`, or the import moves off that thread. |
| `/provider` raw encode (`handleRaw` + `jsonUnsafe`) | Killed at its own byte gate. Effect Struct encode reorders keys into schema declaration order; construction order differs. Same bytes, same values, different key order. | Construction order is aligned to schema order at every `Info` site, **or** the bar is deliberately relaxed from byte equality to key-order-canonical (that changes ETag/hash consumers). |
| Make the app request `view=index` | Already true. Full-list ask was removed long ago. Two `/provider` waiters complete at the same instant on one shared init — no dedupe win. | A client is found that still hits the engine's full-list branch on the boot path. |
| Reclaim the ~370 ms third-party plugin on boot | Needs machinery that does not exist: split volatile identity out of derived state, a non-destructive refresh, a generation counter. `InstanceState.invalidate` has no call sites; `ScopedCache.invalidate` closes the entry under in-flight readers. Even then the cost moves, it does not vanish. | Plugin construction becomes lazy per harness, **or** `InstanceState` gains a non-destructive refresh. Do not "fix" this by isolating the operator's `~/.config` in the product — that is a measurement pin. |
| `content-visibility: hidden` on stashed surfaces | Saved 55 MiB. Stream 24 → 32/40 ms, a 105 ms history sample. Reverted. Stashed surfaces stay `content-visibility: visible` on purpose. | You have a way to hide without paying stream and history, measured on those two gates in the same session. |
| Timeline warm-snapshot reveal (32-entry LRU) | Made warm switch **and** history worse. | Retention work is budgeted against peak RSS at the same time; a 20 ms switch via reveals needs ~20 live surfaces. |
| History hash-scroll / `forceScrollToBottom` fix | Works (0 force-scrolls in 10/10). Quiescent CPU 6% → 10–23% against a same-session control. Navigation still landed 931 px short. Reverted. | The CPU instrument is finer than 1.0 pp **and** the remaining short-scroll is owned. |
| `scriptc` native compile of the embedded server | Real entry not analyzable (17 type errors). Leaf helper: 95% less RSS, 2.3× slower. | The real server entry is analyzable without a compatibility fork, **and** a runnable candidate improves packaged cold ready or peak RSS without a long-task regression. |
| Shiki 4.4.2, or the JS regex engine | 4.4.2 is 21–38% slower on tokenize. JS engine: 4–16× slower; RSS drop does not pay for that. Fine-grained grammar map is small only by deleting supported languages. | Interactive highlighting is no longer on the switch/stream path, **or** product policy allows dropping grammars. |
| Pierre 1.3.5 | Compatible. Parse flat or slower, RSS up, used UI entry +15 kB gzip. | You are upgrading for correctness, not for this performance program. Do not fold it into a perf lockfile diff. |
| One mutable Pierre worker pool | `lineDiffType` is pool-global. Split and unified viewers race, or word-diff has to die. | Pierre makes render options task-local. |
| Unpatched TanStack Virtual latest | Fails the oversized initial-offset/padding regression. Advance only with a semantic port of the range-clamp patch. | Upstream ships the clamp. |
| Identity CSS filters (`saturate-100`) on workbench slots | Forced a compositing surface per slot. Resize improved; terminal **switch** got slower (cached surface was preserving pixels). Reverted. | The surface exists only during the switch (transient `will-change`), not on every slot. |
| Skip glyph-atlas rebuild on terminal settle | p95 frame 17 → 14 ms, fewer over-budget tasks. `core-terminal.spec.ts` 11/11 → 9/11, order/state-dependent, both failing tests pass in isolation. Reverted. | Agent-status detection is decoupled from repaint side effects. |
| Synchronous count-only cache trim at 2× ceiling | Slope and plateau both **worse**. Peak cached sessions stayed at 200. Reverted. | You have a byte-aware pass (the 128 MiB budget already exists) and you do not run it on the hydration critical path. |
| Windowed sticky accordion headers / `requestIdleCallback` for review | Beat an old baseline, lost to then-HEAD in interleaved pairs. Reverted. | Independent of the current FileDiff remount (split/unified use two worker pools). |
| Markdown batch parse, cross-mount highlight reuse, completed-code cache as a per-instance map | Per-instance cache dies on remount — that is why the module LRU exists. Batch parse and cross-mount reuse did not beat it. | You have a new sharing story that survives remount **and** a byte cap. |
| Query-persister coalescing, local inventory single-flight, terminal-stream byte cache, session-owner retarget, cold-activation first-fold hydration, Bun server sidecar (NAPI panic), `adoptNode`, mode-scan guards, Markdown pending-resource no-op, provider dedupe Slice B | Implemented, packaged, measured, lost. | Same-session control, n≥15 for cold ready or n≥5 for RSS, and a named reason the old result no longer applies. |
| Rail-clock scoping | Same-tree A/B: 0.1 ms. The "10 ms" figure was baseline drift. | You are not claiming a cold-ready or switch win from a 10 s label tick. |
| Dispose OpenCode state inside the long-lived server | No attributable saving. The module graph stays until the process exits. | You are actually exiting the process, not hoping `dispose()` drops the isolate. |
| Custom OpenCode child vs Workspace Runtime spawning `opencode serve` | Post-idle medians 278 vs 277 MiB native footprint. Ownership placement has no settled-idle effect once the harness exits. | You are optimizing the **active-harness** transient (WR + native serve was +610 MiB while running), not idle. |
| Lazy-load broader shared-server imports | +25 MiB native footprint. Bundle-shape evidence only. | You have a new closure measurement, not a remembered "lazy is smaller." |
| Move unused OpenCode fallback icon catalog off the startup graph | Main chunk −44 KiB. Launch worst task 22.76 → 23.55 ms. Reverted. | You are attacking the named `v8.evaluateModule` task with attribution, not bundle bytes. |
| Lazy-load signed auth/cloud UI providers | Main chunk −4 KiB. Launch worst 23.27 ms. Shared local/remote event transport still held the graph. Reverted. | Loopback events and local workspace connection are split from signed relay/cloud **first**. Auth UI is a leaf after that. |
| Serial-split feature-port wiring into progressive module graphs | Repeatable misses 12 → 6. Completion +74 ms in the serial-fetch variant. Failed launch. | Concurrent fetch is measured, not assumed, and completion is a gate alongside misses. |
| Progressive transcript as plain-text preview then canonical Markdown | Packaged Electron blinked and swapped representation. Passed the headless browser lane. V17/V18 are regression evidence. V19 always mounts the canonical row. | Progressive state may only admit rows and inner enhancements. Never a second visible renderer for the same message. |
| Cached-history backfill via next-frame `scrollHeight` delta | Viewport jumped to the first message in transcripts >10 turns. V20 uses the timeline's stable row-key prepend anchor. | You have a new anchor that survives late Markdown measurement, proven in packaged Electron, not only in happy-dom. |
| One-turn initial history over a 10k-message conversation | 181.9 ms pooled p95, 232.7 ms worst. | The four-turn window is the rendering basis because it keeps reactive commits and scroll anchoring stable. |
| Native Comrak / `mmdr` / packaged `mermaid-rs-renderer` as idle-memory work | Valid SVGs and HTML. No idle-footprint delta. +disk. Child exits. Web still uses Marked and Mermaid.js. | You are moving **interactive** diagram/Markdown cost, and you accept the packaged helper on desktop only. |
| Pierre's default 1,000 px nested-diff buffer | 48,704 Chromium nodes on an expanded inline edit. 240 px + token limit: 29k nodes, faster completion. | Do not restore the 1,000 px default to "match upstream." |
| Browser-lane pass as packaged transcript acceptance | V18 passed frames and failed manual Electron. The browser lane has no Electron compositor, native input, or restored-state remount. | Packaged Electron with a restored long transcript is the acceptance lane for timeline behavior. |

Lazy-load remote sandbox drivers **was** measured in the idle-memory campaign (−22 MiB native footprint) and was not re-tested against peak RSS. Suspend idle host metrics (10 s / 20 s / 60 s periodics) was never varied as an experiment; too rare per switch, they do sit in the quiescent-CPU window. Hidden terminals still repaint; skipping them needs a "became visible" signal the workbench does not emit on a tab swap.

## Measurement rules that were paid for

Each of these is a retracted number, not a style preference.

1. A control is a **build measured in the same session window**, never a remembered number.
2. Screen A/B **shape** before interpreting. Constant absolute shift at all percentiles, including the fastest → suspect drift. Constant ratio → real per-unit cost. Tail-only → rare collision.
3. Compare p0/p10 first. If the best case moved, the arms are not comparable.
4. **Persistence** is the strongest screen: does the metric ever return to the pre-fix level across later runs? Drift is transient; a real fix is a level change.
5. When the arithmetic cannot support the magnitude, doubt the measurement. A −197 ms cold-ready move against a 134 ms mechanism budget is noise.
6. Reducing total work is **not** making the measured window cheaper.
7. A candidate disproved in one lifecycle phase is not disproved globally.
8. Never generalize from passing runs about a failure mechanism. Survivorship hid the terminal echo defect for 23 trials.
9. A null cannot distinguish "no change" from "no contact." Show a positive control that the harness saw your work.
10. Verify what is **in the build**. Extract the packaged artifact and grep it.
11. Cold ready needs n≥15 per arm, or a stated robust test. Population IQR was 283 ms; the tail reached 5 s.
12. RSS needs tens of MiB to be resolvable at small n. A −1 to −15 MiB candidate at n=3 is unmeasurable, not null.
13. Read **relative stddev** before the median. A "render" metric reproducing to 0.2% beside a boot metric scattering 19% is a clock, not work.
14. Never gate on one run on a freshly booted machine. Never compare two hosts that the log cannot tell apart (emulation profile ≠ silicon).
15. Ask what the metric's **definition** requires. Repeatable LCP/CLS on synthetic clicks was the harness: untrusted events do not freeze LCP and do not excuse the shift the click asked for.
16. Grep the whole repository before calling a module dead. "Not reachable from the entry point I looked at" is not unused — that mistake almost deleted the desktop gate suite.
17. Native physical footprint, summed RSS, and Activity Monitor are different units. The same change can win in one and lose in another. Never merge them into one claim.
18. A headless browser-lane pass is not packaged-Electron acceptance for transcript, compositor, or restored-state behavior.
19. Bundle-byte reduction does not identify a long `v8.evaluateModule` task. Attribute the task, then cut that graph.

Packaged desktop benchmarks are serial. Parallel runs on one machine do not speed them up; they invalidate them. Headless server-side probes (catalogue slope, import RSS, unit suites) can shard.

## Couplings that make "fix them one at a time" false

- A 20 ms session switch via reveals wants ~20 live surfaces. Peak process-family RSS already fails with one.
- The only known correct history-navigation fix broke quiescent CPU.
- Terminal observer fixes launder through output throughput or RSS (scrollback size, batch size).
- One instrument (`measureSessionActivation`) sat inside both cold-open and warm-switch windows. An instrument correction moves both.

## Where the remaining cost actually is

Do not spend a slice on terminal output throughput. The workload is 210 MiB in 10 s, so the structural ceiling is 21.0 MiB/s against a 20 MiB/s budget.

Do not attack Electron's network-utility or GPU processes as if they were app payload. Three of the four non-renderer processes have essentially no Claxedo code in them.

Do not attack the engine-import wave for cold ready as if it were still open. Pre-load, worker transport, and compile-cache were all closed by proof. The named leftover on that metric was a **second** request wave after the first session row is visible (~650 ms, high concurrency), plus whatever the operator's plugins still cost when isolation is off.

Do not treat `peak_process_family_rss_mib` as a reason to spawn an idle-exiting process. Use a byte budget on the structures the renderer retains (session cache already has one), or change the metric.

Do not assign idle-memory credit for choosing which process **owns** an OpenCode child. Once the harness exits, custom child vs Workspace Runtime was a 1 MiB settled difference.

`stream.interaction_p95_ms` was never measured on the packaged embedded composition. The existing stream scenario PATCHes an engine HTTP `updatePart` route that the in-process transport does not expose. A fake engine behind `OPENCODE_URL` is the T3-equivalent seam; that arm was designed and not built.

Detached DOM, not the session-count caps, was the mixed-load heap slope once those caps actually ran. Heap snapshots against a minified production bundle will not name a component. Pin leaks on an unminified build.

## How to parallelize this kind of work

Narrow briefs work. "Read this 3,000-line document and survey the codebase" burns the budget and returns nothing. "Read these two files and answer these four questions" delivers.

Give every agent the falsifier that would kill its own slice, up front.

Serialize edits to a shared file. Re-read by content. Count occurrences after editing. Use absolute paths — relative paths in this repo have resolved into the wrong git tree.

Independent judgements from more than one model, on the **same** question, are worth it when the decision changes what a number means (isolated vs ambient, peak vs footprint, instrument vs product).
