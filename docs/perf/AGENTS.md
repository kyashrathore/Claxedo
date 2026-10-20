# Performance learnings for agents

Read [README.md](./README.md) for what shipped. This file is the ledger of what we already tried and should not retry without a new reason.

The old experiment logs, worktree handoffs, gate-arithmetic tables, idle-memory action table, and experiments index are gone. Git history still has them. Do not reconstruct them as working docs.

The machine-readable twin of this ledger was the old app's `perf-harness/evidence/prior-evidence.json`, deleted with that harness at the app swap. The harness rejected a duplicate experiment question unless you declared a new metric or an invalidated current-tree boundary.

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
| Renderer `js-flags=--optimize-for-size` (2026-10-18 Linux round) | Returns 82 → 97 ms (1 MiB) and 88 → 120 ms (8 MiB) against four pooled controls; RSS not lower. | A memory gate that outweighs switch time. |
| `NetworkServiceInProcess2` (in-process network service) | About −30 MiB family RSS in one run; switch and start rows inside control drift. Gives up the network process's isolation. | Isolation is explicitly traded for memory by the owner. |
| Synchronous `gc()` removal at daemon listen, early creation-identity read, lazy `electron-updater`, the local reader's 5 s renewal timer, a one-screen or viewport-only cold page | Every row within the ±10–20% drift measured between control runs at n=4 starts / 2 walks. | Measured at higher repetitions with a named row the mechanism reaches. |
| Rail mount after the reveal frame, keyed rail-row selection, projection cache across remounts | No row moved beyond control drift. | The benchmark gains a row these mechanisms reach (long transcripts with a rail, many visible rows). |
| Folded user prompt rendered as a 10-line prefix | Long-rows first visit 207 → 169 ms; overlaps zero first-view overscan, which reached the same row without hiding text from screen readers and find-in-page. Not merged. | Zero overscan is reverted, or scrolling through long prompts becomes a gate. |
| Sanitize transcript Markdown in place (DOMPurify `IN_PLACE` on a `div` of one reused inert template document) instead of DOMPurify's per-call `DOMParser` document (2026-10-18 main-thread lane) | `parseFromString` under `sanitizeMarkdown` is the largest self-time row while a turn streams (about 0.75 s of 7.1 s sampled script per 40 s report at 4× CPU), so document creation looked like the cost. In Chromium over every text and reasoning part of the transcript lab fixture plus 195 growing prefixes of one long part, in-place was 1.0–2.7× slower, and its output differed for `<title>` and `<template>` input. The cost is the parse of the growing block, not the document. Not merged. | A sanitizer that skips the parse (the platform `setHTML`, or sanitizing only marked's raw-HTML tokens), measured on the stream row and checked against the same corpus and an XSS list. |
| Skip `cancelAnimationFrame` of an already-fired delta-commit frame (`commitDeltasWhileShown`) | Per committed frame the effect's cleanup cancels the frame that just ran. Without stack capture neither `cancelAnimationFrame` nor `requestAnimationFrame` reached the stream's top 30 self-time rows (under about 30 ms per 40 s at 4×); stream task time 12,954 vs 14,005 ms median, inside the 12.2–17.0 s spread between runs of one build on the shared host. Not merged. | Tracing with `disabled-by-default-devtools.timeline.stack` is not the measurement: that category records a stack per timer and frame request and made these calls look 4–5× dearer. |
| Drop a session's cached entry by key instead of scanning every open-session entry on each server event (`forgetCached`) | One `Array.from` over at most the open and cached sessions per event. The stream row moved the wrong way inside drift (12,354 → 13,197 ms median task time, p0 11,466 → 12,783 ms at n=5) and `forgetCached` never reached the top self-time rows. Not merged. | A workload with many more retained sessions per event, measured on the stream row. |
| Minify the control plane Worker (`minify = true` in the hosted bundle contract) | 7,452 → 3,916 KiB (gzip 1,341 → 964); Node import 105 → 102 ms, workerd ready about 15 ms faster. Every logged stack becomes minified: Cloudflare remaps only uncaught exceptions with uploaded source maps ([source maps](https://developers.cloudflare.com/workers/observability/source-maps/)), and the Worker catches and logs its errors and sends them to PostHog. Not adopted. | Caught errors and PostHog's error tracking read remapped stacks, or the owner trades readable stacks for the bytes. |
| `keep_names = false` on the control plane Worker | Node import another 6–8 ms below minify alone; `/health` in workerd went from 3.3 to 6 ms on every boot, unexplained, and names some code reads (`constructor.name`, error names) would change. Not adopted. | The `/health` regression is explained and nothing reads a function or class name. |
| Lazy `import()` of zip.js in the GitHub plugin source | Main-thread import −2 ms under Node, bundle +117 KiB: a module behind `import()` is wrapped by esbuild and no longer tree-shaken. Reverted. | The Worker bundle splits lazy modules into chunks, so a lazy module's bytes leave the startup script. |
| Keep-warm requests or a cron against the control plane Worker (2026-10-19 cold-start lane) | Not built. Nothing on developers.cloudflare.com names a request or schedule as a way to keep an isolate resident; the one documented pre-warm is the ClientHello hint, which reaches the TLS-terminating edge and not a region-placed Worker. The staging probe showed warmth is per machine inside IAD (a request on a just-used connection landed cold 10 times in 126), so a ping warms one machine of the pool. [worker-cold-starts-2026-10-19](./worker-cold-starts-2026-10-19/README.md). | Cloudflare documents a pre-warm for placed Workers. |
| Sharing an in-flight composition among requests that arrive before its readiness settles | Not built: the saving is bounded to the readiness window of a cold isolate (two database rounds), the browser's first-wave requests often land on different machines anyway, and the module's rule is the one proven live on 2026-08-31. | The isolate start is gone and a cold isolate's wave is the remaining cost. |
| A lighter first request (`descriptor` and `bootstrap` without composing) | Not built: the first wave carries `get-session`, which needs Better Auth, so the isolate composes within the wave and the person's wait moves by nothing. | The boot's first wave no longer needs an authenticated answer. |
| Dynamic chunks for the plugin tooling, sandbox drivers, pricing and model tables | Not built: needs the Worker uploaded as several modules and the closure scanner taught the chunk graph; the prize is about 1.2 MB of the 7.4, about 9 ms of compile under Node and 1–2 ms of evaluation. | Cloudflare's reported startup for this Worker moves for a reason other than bytes, or the owner wants the 30 ms. |
| Better Auth's `session.cookieCache` for the control plane's cookie verification (2026-10-20 session-cache lane) | Not built: it caches the session row only, so the sign-in evidence and identity round stays, and every Better Auth route behind `sessionMiddleware` then reads the cached session, the OAuth provider's authorize and consent among them (`getSessionFromCtx` without `disableCookieCache` in `@better-auth/oauth-provider` 1.7.1), so a revoked browser session could approve a native client's refresh token for the cache's lifetime. The application's own principal cache was built instead ([session-cache-2026-10-20](./session-cache-2026-10-20/README.md)). | Better Auth lets the cookie cache apply to chosen routes only, and the evidence and identity can ride in it. |
| A principal cache in isolate memory | Not built: a client connection does not pin an isolate and half the requests after a 30 s pause land cold ([worker-cold-starts-2026-10-19](./worker-cold-starts-2026-10-19/README.md)), so its hit rate falls exactly when a person pauses; the signed cookie reaches every isolate. | Requests from one browser are pinned to one isolate. |

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
20. A build made by swapping only the renderer into a packaged app's `app.asar` measured 90 MiB more family RSS than a full package of the same commit. Compare RSS only between builds made the same way.
21. On a shared 4-core host, two control runs of the same build differed by up to 20% on a row with n=4. Pool several controls, and confirm a candidate at higher repetitions before calling it.
22. Cloudflare's `Worker Startup Time` tracks global-scope evaluation more than bytes: the 10.9 MB control plane reported 167–297 ms and the 5.4 MB session host 20–23 ms, while under Node the control plane evaluated for about 76 ms after an 82 ms compile and the session host imported whole in 47 ms. To attribute a Worker's startup, import its Wrangler bundle under Node with `cloudflare:workers` stubbed and time each esbuild module header (the `// path` line before every module); count lazily initialized modules through `__esm`/`__commonJS`, or their cost lands on whichever module first initialized them.

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

On the web build at 4× CPU (2026-10-18; `bun run e2e:perf-web -- --long=1,8 --stream --census --cpu=4` now measures these flows), a streamed 12k-character report keeps the main thread busy about 13 of its 41 s with no task over 50 ms: about 5 s script, 4 s paint, prepaint, layerize and commit, 1.5 s style and 1.3 s layout. Of the sampled script, about 4 s is the per-frame delta commit, of which re-rendering the growing Markdown block is most: DOMPurify's parse of the block (about 1.3 s), then `updateBlock`'s `innerHTML` and morphdom. The follow-scroll's forced layouts (TanStack `scrollToFn`, `getMaxScrollOffset`, the scroll handler's `scrollTop`) add about 0.4 s. Every mounted timeline row intersects the viewport while it follows, so containment or `content-visibility` on rows has nothing offscreen to skip, and the rail recreates no row on a switch or while a turn streams. Session switches are one 70–130 ms task of mostly script; their forced layouts are the first layout of the new screen done early, not a second one. CSS selector matching was at most 2 ms per selector and 25–35 ms in all on boot and on opening a long session, so no single selector is worth a rewrite.

## How to parallelize this kind of work

Narrow briefs work. "Read this 3,000-line document and survey the codebase" burns the budget and returns nothing. "Read these two files and answer these four questions" delivers.

Give every agent the falsifier that would kill its own slice, up front.

Serialize edits to a shared file. Re-read by content. Count occurrences after editing. Use absolute paths — relative paths in this repo have resolved into the wrong git tree.

Independent judgements from more than one model, on the **same** question, are worth it when the decision changes what a number means (isolated vs ambient, peak vs footprint, instrument vs product).
