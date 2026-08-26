GATE ARITHMETIC — is the plan's target achievable, gate by gate?

Read-only. I edited nothing; `docs/perf/u11-qualification-status.md` sha256
26858b0d06af698944d6e5ffd17fa7cfa75b1b4ea78c27184c65db1fb4b4874d unchanged.
Worktree confirmed: .worktrees/integrate/claxedo-memory-buckets.

I did NOT take the status doc's numbers on trust. I re-derived every one from the
immutable artifacts under the ABSOLUTE path
<root>/artifacts/agent-app-benchmark/ — 412 run directories, 411 with summary.json,
4,110 metric rows (count sanity-checked). Two of the doc's headline numbers do not
survive that check; both are flagged below.

===============================================================================
HEADLINE
===============================================================================
2 gates are UNREACHABLE as specified (warm switch, RSS) — both by measured
arithmetic, both confirmed independently by me from the artifacts.
1 gate is reachable but has NEVER been demonstrated and has no candidate
(cold open).
1 gate is reachable AND has 4x more named, un-attacked headroom than the gap
(cold ready) — this is the best target in the set and the effort has been
attacking the wrong half of it.
1 gate is DEMONSTRATED reachable on the current build and is being written off
wrongly (stream interaction — it has PASSED 4 times in 57 post-fix runs).
1 "passing" gate is passing on a defect and its correct fix breaks another gate
(history navigate vs quiescent CPU).
1 gate has an instrument least-count of 20% of its own budget (quiescent CPU).

The plan as specified CANNOT succeed. Two of the ten thresholds are arithmetically
unsatisfiable by any application change. That is a plan-amendment decision, not an
engineering backlog.

===============================================================================
CORRECTIONS TO THE STATUS DOC'S OWN v5 TABLE (both verifiable from artifacts)
===============================================================================
1. COLD READY 1,875 IS NOT THE MEDIAN OF THE v5 CONTROL.
   AC-postrevert-all-{1..4}/summary.json: 1975.271, 4984.696, 1867.228, 1753.242.
   All four are `validSamples: 1, excludedInvalidSamples: 0` — the 4,984.7 was
   VALID and was dropped from the headline without being classified invalid.
   Honest median of the four valid samples = 1,921.3 ms. Gap = 171 ms, not 125.
   (The doc does acknowledge the 4,984.7 tail at status.md "Measurement rules
   added" — but then reports a range that excludes it. Fix the headline.)

2. TERMINAL OUTPUT DID NOT PASS THE v5 CONTROL UNIFORMLY.
   AC-postrevert-all-1 summary.json: `terminal.output_mib_s = 19.153,
   passed: false`. 2 of 3 valid runs passed. Doc says "pass".

Both are small; I raise them because the effort's own rule is that a flattering
selection is the error mode that costs the most.

===============================================================================
THE TABLE. Newest full-profile family = AC-composer-{1..4}
(2026-08-11T20:11-20:16Z, n=4, the newest build carrying every retained slice).
"pop" = the post-2026-08-11T16:00Z population across all builds on this host.
===============================================================================

M1 app.cold_ready_ms
  current  median 1,885.9 (min 1,768.6, max 2,796.0); pop n=52 median 1,908.5,
           9.6% of runs already <= 1,750
  budget   1,750 ms          gap  +135.9 (newest) / +158.5 (pop median)
  LARGEST NAMED COMPONENT: 655 ms — a SECOND embedded-server request wave that
  runs entirely AFTER the first session row is visible, and which nothing in this
  effort has attacked.
  Evidence, re-derived by me from run/cold-ready-diagnostics-000-*.json in
  AC-postrevert-all-{1..4} and AC-composer-{1..4} (8 runs, shape reproducible):
      spawn -> renderer timeOrigin      196.6-265.2   (median ~213)
      timeOrigin -> globalSync.ready    309.6-355.1   (median ~321)
      ready -> sessionList dispatch     ~35
      sessionList dispatch -> response  396-482       <- engine-load wave (KNOWN)
      response -> first row visible     ~35-50
      first row visible -> cold ready   726.5-1,013   <- 41-44% OF THE METRIC
  Inside that last segment, AC-composer-2 (a fast 1,768.6 run): row visible 783.5,
  last blocking response 1,438.9, cold ready ends 1,567.6. So 655.4 ms is the
  renderer waiting on the server for session content and 128.7 ms is the
  activation + harness tail. 28 boot requests sum to 8,780 ms of duration inside
  a 1,137 ms wall window — mean concurrency 7.6, max 13. That is the
  request-serialisation finding the doc filed as "Open, with owners" and never
  costed.
  VERDICT: REACHABLE. 655 ms of named, evidenced, un-attacked cost against a
  136-159 ms gap — 4x the required headroom.
  WHAT IT REQUIRES: attack the SECOND wave, not the engine. The engine wave
  (396-482 ms) is closed by proof — pre-load is zero-sum (+371/-363, net +21),
  the worker transport measured +129 ms and +130 MiB, and the compile cache's
  entire mechanism budget is 134.3 ms of which the cold-ready share is
  statistically unsupported (exact permutation p = 0.262). The second wave is a
  different mechanism (concurrent requests serialising, consistent with file I/O
  under a lock) and is untouched.
  MEASUREMENT WARNING: pop IQR is 283 ms and the right tail reaches 5,099.6 ms.
  The gap is SMALLER THAN THE NOISE. Any cold-ready claim needs n>=15 per arm and
  a stated robust test, exactly as the doc's own audit concluded.

M2 work_item.cold_open_ms
  current  median 150.4 (145.1-153.5)
  budget   55 ms             gap  +95.4
  LARGEST NAMED COMPONENT: ~140 ms of the ~184 ms window elapses BEFORE the
  predicate can be evaluated at all (status.md "Cold open segmented", 4 runs:
  first evaluable frame at 101.4 / 174.3 / 134.0 / 141.9 ms). `targetRow` is the
  binding conjunct in every run in which it appeared.
  Instrument floor is only 14.9 ms (measured), so 138 ms of the 153 is genuinely
  the app. Available budget after the floor: 40.1 ms. Required: a 3.45x reduction
  in app work.
  It is NOT a throughput problem: inter-frame gaps 8.0-8.7 ms, zero long
  animation frames, sampleMs 0.0-0.4. The renderer is producing frames at full
  rate doing almost nothing. The gate measures how long a CONJUNCTION of
  readiness predicates takes to become simultaneously true.
  VERDICT: REACHABLE ON ARITHMETIC, UNDEMONSTRATED. 3.45x is a large but not
  absurd factor and 138 ms of attackable app work exists. But every candidate so
  far has moved it by noise: composer re-suspension -2.1 ms, reconcile-generation
  claim WITHDRAWN by the doc's own audit. Nothing in the record has moved this
  gate.
  WHAT IT REQUIRES: name and remove whatever holds `targetRow` false for ~140 ms.
  That has never been instrumented at the level "which conjunct, which frame, why"
  — only "targetRow was still blocking".

M3 work_item.warm_switch_p95_ms
  current  median 138.8 (138.3-145.6); per-switch n=20 in AC-postrevert-all-3:
           92.3 ... 145.0, p50 121.4, p95 139.4
  budget   20 ms             gap  +118.8
  VERDICT: UNREACHABLE. I checked the doc's argument rather than repeating it,
  and it is right, but its stated reason is only half the proof. Full arithmetic:
  (a) AS INSTRUMENTED: floor 30.6 ms > 20 ms budget. Mechanism verified in source:
      `measureSessionActivation` cannot install its in-page rAF predicate until
      `root.waitFor({state:"visible"})` resolves, and agent-cdp-page.ts:182 polls
      that at 16 ms granularity, then agent-cdp-page.ts:207 costs one more
      `evaluate` RTT. Measured split: waitFor 22.9 + evalRoundTrip 7.2 = 30.1.
      The predicate's own per-frame work is 0.60 ms across all frames — negligible.
  (b) THE FLOOR IS FIXABLE WITHOUT WEAKENING R3/R4, and it still does not save the
      gate. The duration is a pure renderer-clock quantity —
      agent-browser-observer.ts:971 `durationMs = paintedAtMs - trustedEventAtMs`,
      both `performance.now()` in-page. Arming the SAME predicate loop at
      `armAction` time, before the click, would remove the CDP transport from the
      window while changing nothing about what is asserted. With that fix the
      ideal floor is one-to-two vsync: at the provenance-confirmed 120.00 Hz
      (AC-postrevert-all-3/provenance.json preflight.displays: "1512 x 982 @
      120.00Hz"), two-identical-consecutive-frames costs (0, 8.33] + 8.333, so
      p95 ~= 16.3 ms. That leaves 3.7 ms of the 20 ms budget for the application.
      The app portion today is 139.4 - 30.6 = 108.8 ms. Required: 29x.
  (c) THE ONLY SHAPE THAT COULD BE THAT CHEAP IS A REVEAL, AND IT COSTS M9.
      0 of 20 measured switches are reveals: rail-workbench-canvas.tsx:15-18 sets
      `SESSION_DOM_RETENTION_TIERS.warmHidden = 1`, passed at :64 as
      `maxRetainedMountedContents`, while agent-browser-observer.ts:456 asserts
      exactly 20 targets and shuffles among them. Making ~19 of 20 reveals means
      retaining ~20 live session surfaces in a renderer that already peaks at
      1,167.7 MiB inside a family that fails M9 by 3x. A 32-entry
      snapshot-and-reveal LRU was already tried and made warm switch AND history
      worse.
  So: 20 ms is unreachable with the current instrument by 10.6 ms of pure
  transport, and unreachable with a PERFECT instrument by a required 29x cut in
  app work whose only known mechanism regresses M9.

M4 history.navigate_p95_ms
  current  median 75.9 (71.4-79.8)     budget 100 ms     margin -24.1  PASSES
  VERDICT: PASSES TODAY, BUT THE PASS IS NOT SOUND, AND FIXING IT BREAKS M10.
  The gate scores a navigation that deterministically fails: 10 of 10
  fresh-process traces end at 33,688 px (the bottom) with the target out of view,
  and in 8 of those 10 the runaway lands AFTER `waitForStableScroll` stops the
  clock. Root-caused to `applyHash -> forceScrollToBottom`. The fix WORKED
  (0 force-scrolls in 10/10) and was REVERTED because quiescent CPU went
  5.99 -> 9.982 / 17.968 / 7.994 / 22.978 against a control measured in the same
  session at 5.994 / 5.989 / 6.000 — and the navigation still landed 931 px short.
  Correcting M4 is expected to make M4 itself WORSE (the clock then runs until a
  navigation that stays on target settles) and currently costs M10 outright.
  This is the one gate where "passing" and "correct" point in opposite directions.

M5 stream.interaction_p95_ms
  current  median 32.0 (32,32,32,40)   budget 16.67 ms   gap +15.3
  VERDICT: DEMONSTRATED REACHABLE — and the doc is writing it off on evidence
  collected under an instrument defect that has since been FIXED.
  The status doc's "Evidence-backed non-candidates" says no product-owned change
  can force this under 16.67. That paragraph rests on "handler processing 0-0.2 ms,
  ZERO DOM MUTATIONS, blocked-frame ratio 0%" — but those observations were taken
  while the 40 ArrowDown probes were scrolling the RAIL SIDEBAR, which is exactly
  the defect the doc itself later documents and fixes. It has never been
  re-derived post-fix. Meanwhile the artifacts say the gate is winnable:
      warmed lane (`--profiles all`), post-2026-08-11: n=57
      value 16 -> 4 runs (PASS), 32 -> 46, 40 -> 6, 48 -> 1
      pass rate 7.0% ON THE CURRENT BUILD
      (AC-worker-all-5, AC-sliceB-5, AC-ccache-3, AC-ccache-off-2 all scored 16.0)
  A metric that has passed four times cannot be structurally impossible.
  THE ARITHMETIC OF THE PASS CONDITION, from source: `durationThresholdMs = 16`
  (agent-browser-observer.ts:762), Chrome Event Timing rounds `duration` to 8 ms,
  and agent-metrics.ts:62-74 gives rank = ceil(40*0.95) = 38 with censoring. So
  PASS <=> at most 2 of 40 probes report >= 24 ms, i.e. >= 38 of 40 keydowns must
  present within 2 vsync. Observed values are exactly {16,24,32,40,48} — the
  quantization is confirmed, and 16 <= 16.67 is inside it.
  LARGEST NAMED COMPONENT: the first streaming replay's render work —
  144 style recalcs / 58 layouts / 197 ms task time (doc, "Open, with owners").
  WHAT IT REQUIRES: cut ~2 quanta (16 ms) of presentation latency off the
  streaming replay's render path. One A/B caveat that will otherwise waste runs:
  `runControlledStreamScenario` PATCHes parts to their FINAL content, so only the
  FIRST replay in a process mutates the DOM — one fresh process per measurement or
  you are measuring an idempotent no-op.

M6 stream.blocked_frame_ratio_pct
  current  0.0 in 132 of 132 measured runs    budget 1.0%    PASSES
  VERDICT: PASSES, BUT IT IS A VACUOUS GATE. LoAF only emits above 50 ms, so the
  24-40 ms interactions that fail M5 are invisible to it. 0% has never been
  evidence of anything. It cannot regress and cannot corroborate. Worth saying
  plainly in the report rather than counting it as one of the six passes.

M7 terminal.input_to_paint_p95_ms
  current  median 33.1 (31.2-34.2)    budget 100 ms   margin -66.9   PASSES ~3x
  VERDICT: PASSES ON VALUE, UNRELIABLE ON ATTEMPT. Roughly 3 warmed attempts in 7
  are discarded by an observer race (AC-postrevert-all-2: `excludedInvalidSamples:
  1`, no value). Root-caused and quantified in the doc: production
  `scrollback: 5000` (verified at features/terminal/core/config.ts:25) turns over
  every 15.5 ms at 322,560 lines/s, the observer's 64 KiB `parsedTail` holds ~3 ms,
  and observed parsed batches (655-852 KB) are 1.9-2.5x the ~341 KB eviction
  threshold. All three available fixes are disqualified — two of them launder
  themselves through M8 or M9. Costs runs, not qualification.

M8 terminal.output_mib_s
  current  median 20.806 (20.786-20.823); pop post-08-11 n=53, 51 in
           20.29-20.86, 2 outliers (19.15, 9.24)
  budget   >= 20 MiB/s        margin +4.0%           PASSES
  VERDICT: PASSES, WITH A STRUCTURAL CEILING WORTH KNOWING. I decoded the workload
  (AC-postrevert-all-3/run/terminal-workloads/terminal-00.json): 64 chunks x
  131,072 B x repeatCount 1,680 = 220,200,960 B = 210.0 MiB over a durationMs of
  10,000. So the metric's THEORETICAL CEILING is 21.0 MiB/s and the budget of 20
  allows the app exactly 5.0% of total slippage. Measured 20.806 = 0.93% slippage.
  The app is using under a fifth of the only headroom that exists. This gate is
  safe but it can never show more than a 5% win — do not spend a slice on it.

M9 resource.peak_process_family_rss_mib
  current  median 1,897.5 (1,891.0-1,915.9)   budget 650 MiB   gap +1,247.5 (2.9x)
  VERDICT: UNREACHABLE. I checked this one rather than repeating it, decoding all
  18 `processOwnership.snapshots` of AC-postrevert-all-3/attempt.json myself and
  classifying each process by its `--type=` argument. The doc's finding reproduces
  exactly:
      non-renderer total, per snapshot: 736.1 MiB minimum, 740.9 MiB at the FIRST
      snapshot (before any session work), 773.4 MiB at peak
      peak family 1,941.1 = renderer 1,167.7 + server 374.6 + main 217.1 +
      GPU 130.5 + utility 51.2
  With a renderer of literally zero bytes the gate fails by 86.1 MiB, and it fails
  at process start. Electron's own three processes are 359.5 MiB before Claxedo
  runs. This is not improvable by any renderer work, and the doc's forced-GC
  result corroborates it: removing 93.2% of a measured allocation moved peak RSS
  by -1 to -15 MiB inside a control span of 1,909-2,031.
  One structural addition the doc makes and I want to underline, because it kills
  a whole class of future proposals: M9 is a PEAK, so a process that exits when
  idle cannot reduce it — moving memory into an idle-exiting process can only ADD
  baseline. Measured: wiring the worker transport cost +130 MiB and +129 ms.
  650 MiB is unsatisfiable under this process topology. Changing it is a plan
  decision, not a slice.

M10 resource.quiescent_cpu_p95_pct
  current  median 4.50 (3.999-4.999) in the newest family; pop post-08-11 n=57,
           17.5% of runs EXCEED 5.0
  budget   5.0%              margin  0.001 in the worst newest run
  VERDICT: UNKNOWN — AND UNTESTABLE AT THIS RESOLUTION. This is the finding I most
  want on the record, because it is arithmetic and it is not yet in the doc.
  The instrument's LEAST COUNT IS 1.0 PERCENTAGE POINT — 20% OF THE BUDGET.
  Chain, verified in source: idle-process-family.ts:139 reads cpuSeconds via
  `parseCpuTime` of `ps -axo ... time=`, which macOS reports as MM:SS.ss, i.e.
  10 ms resolution; :77 divides the family delta by a 1-second interval. 10 ms /
  1 s = 1.0 pp per quantum. The observed population is exactly that: 100 CPU
  samples across all runs take values 2.99x, 3.99x, 4.32, 4.99x, 5.99x, 6.99x,
  7.99x, 9.99x — clean multiples of ~0.999.
  So the gate admits exactly ONE passing step below its budget (4.995) and the
  next step up (5.994) fails. There is no sub-quantum margin and no way to
  demonstrate an improvement smaller than 20% of the budget.
  This is also why the doc's audit was right to withdraw the reconcile-generation
  CPU claim: a one-quantization-step "win" whose post-fix population reproduces
  the alleged pre-fix value at will (5.989, 5.993, 5.994, 7.993 all measured WITH
  the fix in) is not a win.
  The honest statement is the doc's: wanders 1.0-8.0 on identical code, no
  retained slice shown to move it. My addition: at 1.0 pp granularity it CANNOT be
  shown to move by less than 1.0 pp, so "prove this slice improved quiescent CPU"
  is not a question this instrument can answer.

===============================================================================
CROSS-GATE COUPLINGS THAT MAKE "FIX THEM ONE AT A TIME" FALSE
===============================================================================
  M3 <-> M9  a 20 ms switch requires reveals; reveals require ~20 retained live
             surfaces; M9 already fails by 3x with ONE.
  M4 <-> M10 the only known correct fix for history navigation measured
             9.98-22.98 CPU against a 5.99 same-session control.
  M7 <-> M8/M9 all three available observer fixes launder themselves through
             another gate (scrollback -> M9, smaller batches -> M8).
  M2 <-> M3  one instrument (`measureSessionActivation`) sits inside the measured
             window of both, so an instrument correction moves both at once and
             neither result is independent of it.

===============================================================================
ANSWER TO THE QUESTION AS ASKED
===============================================================================
NO. The plan's target is not achievable as specified.

Two of ten thresholds are arithmetically unsatisfiable by application work:
  M9  650 MiB  vs a 736.1 MiB non-renderer floor    (fails by 86 MiB at t=0)
  M3   20 ms   vs a 30.6 ms instrument floor, and vs a required 29x app-work cut
               with a perfect instrument whose only mechanism regresses M9
Both are structural. Neither is a backlog item.

Of the remaining eight:
  reachable with headroom            M1  (655 ms named, 136-159 ms needed)
  reachable, demonstrated, misfiled  M5  (already passes 7% of runs)
  reachable on arithmetic, no route  M2  (needs 3.45x; nothing has moved it)
  passing but unsound                M4  (correct fix breaks M10)
  passing, vacuous                   M6
  passing, attempt-flaky             M7
  passing, near its structural cap   M8  (ceiling 21.0, budget 20.0)
  unknown at instrument resolution   M10 (least count = 20% of budget)

WHAT I RECOMMEND THE PLAN AMENDMENT SAY (your decision, not mine):
1. M9: replace or supplement the 650 MiB peak with a budget that names Electron's
   measured non-renderer baseline, plus the idle-measured metric the doc already
   proposes (`resource.idle_foreign_process_rss_mib`). A peak metric structurally
   cannot reward the lifecycle work that is actually correct here.
2. M3: correct the instrument FIRST (arm the predicate before the click — this
   does not weaken R3/R4, since agent-browser-observer.ts:971 already computes a
   pure renderer-clock duration), then re-declare the budget against the measured
   two-frame floor at 120 Hz. 20 ms against a 16.3 ms ideal floor leaves 3.7 ms
   for an application and is not a product statement.
3. M10: either lengthen the sampling interval or read a finer CPU counter. A gate
   whose least count is 20% of its budget cannot adjudicate anything.
4. M1: redirect the effort from the engine wave (closed by three proofs) to the
   post-row-visible request wave (655 ms, un-attacked, mean concurrency 7.6).
5. M5: withdraw the "presentation-quantized, not product-owned" non-candidate. It
   was concluded from data taken under the rail-scroll instrument defect, and the
   artifacts contain four passing runs on the current build.

LABELLING, per your rules:
  MEASURED by me from artifacts: every "current" value, the 8-run cold-ready
  segmentation, the 655 ms second wave and 28-request/8,780 ms concurrency figure,
  the 736.1 MiB non-renderer floor, the 210.0 MiB / 21.0 MiB/s M8 ceiling, the
  {16,24,32,40,48} stream quantization and its 4/57 pass rate, the 1.0 pp CPU
  least count, the two v5-table corrections.
  VERIFIED IN SOURCE (file:line quoted above, not run): the 16 ms and 50 ms CDP
  poll granularities, durationThreshold 16, the p95 censoring rule, the
  renderer-clock duration, retention tier 1, scrollback 5000, the per-instance
  markdown code cache, cold_ready's span including a full activation.
  INFERENCE, labelled: that ~20 retained surfaces would push M9 further (direction
  certain, magnitude not measured); that the second server wave is reducible by
  removing serialisation (the concurrency shape supports it, no candidate built);
  that arming the predicate pre-click would recover ~30.6 ms on M3 and ~14.9 ms on
  M2 (mechanism verified in source, not measured).
  NOT MEASURED BY ME: I ran no packaged build, no benchmark, no app. Everything
  above is source reading plus re-analysis of artifacts you already own.
