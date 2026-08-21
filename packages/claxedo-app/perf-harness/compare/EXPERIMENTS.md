# T3 vs Claxedo benchmark — experiment log

Chronological record of every comparison experiment, what it found, and where
its raw artifacts live. Companion to [README.md](./README.md) (the rerun
runbook). All runs: same M-series mac, quiet-host + AC-power + app-singleton
gates, seed 1, one launch per run.

Artifact roots:
- Claxedo: `.artifacts/agent-app-benchmark/` in the perf worktree
- T3: `artifacts/agent-app-benchmark/` in the t3code repo

## 2026-08-21 morning — first valid light-corpus comparison (`core-v1`)

After making T3's settled threads render transcripts (`settledOverride:
"active"` in its materializer — auto-settled threads render an un-settle
placeholder, so open/switch was measuring a placeholder), and diagnosing a
dual-instance trap (a running T3 Nightly made the benchmark instance's
backend unreachable; single-variable isolation proved it).

| metric | T3 | Claxedo |
|---|---|---|
| cold_ready_ms | 3227 | 1963 |
| cold_open_ms | 170 | 258 |
| warm_switch_p95_ms | 38.3 | 118.6 |
| peak RSS MiB | 1271 | 1266 |
| idle CPU p95 % | 11.7 | 19.0 |

Artifacts: `compare-20260821T1144-*` (Claxedo), T3 attempts 04:50–06:14.
history/stream/terminal not comparable (T3 driver scenarios written but never
live-validated). Claxedo light resource ticks never backfilled.

## 2026-08-21 midday — heavy corpus (`heavy-v1`, 4×400-turn sessions, weight 3)

Purpose: user suspicion that virtualization/lazy-hydration regimes were
untested. Corpus sha `ddea801…`. Two honesty audits ran alongside:

- **Gate integrity**: T3's readiness gate probed honest on both corpora —
  zero placeholder rows at gate-pass and through 10×PageUp + Home. Its deep
  history WINDOWS (~turn 250 reachable on Home in an 800-message session).
- **Model/harness loading**: T3 does NOT skip model loading — the app wrote
  claudeAgent.json (145KB) / codex.json mid-run; the "No provider" screen was
  an archived dead-replay home. Claxedo boots embedded engine + server +
  provider catalog and still cold-starts faster.

| metric | T3 | Claxedo |
|---|---|---|
| cold_ready_ms | 2105–2172 | 1721–1982 |
| cold_open_ms | 94–103 | ~109 |
| warm_switch_p95_ms | ~88 | INITIALLY INVALID → 145–221 after harness fix |
| history_navigate_p95_ms | not measured | never-valid → 3.2–6.6 s after app fixes |
| peak RSS MiB | 1517–1542 | 1135 |
| idle CPU p95 % | 11.2–13.3 | 6.0 |

Resource matrix (family sums): T3 active 206/135 % cpu peak/avg,
1545/1354 MiB rss; T3 idle p95 13.6 %. Claxedo active 223/172 % (only ~3
ticks — weak), 1135/1082 MiB; idle p95 6.0 %.

**Defects found and fixed by this experiment** (commits `f95403c30` app,
`331e4ff5f` harness on the perf branch):

1. Warm-switch structurally invalid on heavy: the observer hashed the whole
   innerText of the first visible row against a sha of the FIRST text part —
   a one-row-per-message assumption. Fixed with part-granular verification
   (`data-content-part-id`, per-part shas for plain-text corpus parts,
   identity+painted for transformed parts).
2. `history.navigate_p95_ms` had NEVER produced a valid sample in any run —
   nav buttons lacked `data-message-id`.
3. Four real app bugs in message-nav jumps in huge sessions
   (`use-session-hash-scroll.ts` / `message-timeline.tsx`): 4-attempt seek
   budget too small for drifting virtualizer estimates → progress-based
   convergence + stall nudge + scrollend timeout; empty-hash effect
   force-scrolled to bottom on spurious re-runs; hidden workbench surfaces
   wrote/reacted to the global location hash; `getOffsetForIndex` reads a
   stale measurementsCache (fixed via `getTotalSize()` refresh).

   After fixes: 7/7 consecutive fully-valid heavy workspace runs
   (`heavy-1518` … `heavy-153606`). History honest-but-slow (3.2–6.6 s —
   architecture: converge-by-scrolling over estimated row heights).

## 2026-08-21 evening — graded multi-workspace corpus (`graded-v1`) — CURRENT CONTRACT

Redesign per user direction: ONE corpus replaces light/heavy (20 sessions,
turns 12→400 geometric, part weight 1→3), sessions round-robin across THREE
workspaces (cross-workspace switching measured), `history.navigate_p95_ms`
REMOVED from the contract (9 metrics), memory reported as whole-app /
app-excluding-harness / harness-owned rows. Corpus sha `0357c2497a28…`.

**Defects found and fixed while landing it:**

- A Claxedo workspace registered but never opened lists NO sessions on a
  virgin boot: the rail's project-scoped query reads `claxedo_session_meta`
  filtered by `project_id`, imports only happen when a workspace's runtime
  first starts, and there is no live doorbell when they land. The
  materializer now finishes the import itself via the server's
  `putSessionMeta` (the `ws.project_id` argument is load-bearing — without
  it groups render "No sessions match the current filter").
- Closed rail project groups do not mount their session-list queries at all;
  `revealSessionRows` now opens them via their headers, then round-robin
  load-more (clicking only `last()` starves other groups' pages).

**Results (both arms fully valid):**

| metric | T3 | Claxedo |
|---|---|---|
| cold_ready_ms | 3210–3250 | 1942 |
| cold_open_ms | 102–170 | 109 |
| warm_switch_p95_ms (cross-workspace) | 79.9 | 145.4 |
| switch avg light/mid/heavy turns | 64/61/56 (flat) | 102/107/127 (climbs; 400t = 171) |
| RSS whole peak/avg active MiB | 1742/1480 | 1744/1345 |
| RSS whole peak/avg idle MiB | 1761/1423 | 1614/1360 |
| CPU peak/avg active % | 195/143 | 274–282/245 |
| idle CPU p95 % | 16–21 | 7.0 |
| harness-owned RSS | ~0 | ~0–8 |

Key readings: T3's switch cost is flat in session size (frame-quantized
38/63/80 ms samples); Claxedo's climbs ~25 % light→heavy — the optimization
target. Memory is now a near-tie (Claxedo's heavy-corpus 400 MiB advantage
did not survive the 3-workspace layout). Harness-owned ≈ 0 because replayed
corpora run no live agents.

Artifacts: Claxedo `graded-185715-workspace-core-v1` /
`graded-185715-resource-core-v1`; T3 `attempt-2026-08-21T13-29-04-815Z-82cbc9f0`
(workspace) / `attempt-2026-08-21T13-31-31-696Z-42fd63fe` (resource).
T3 fixture verified: 3 projects, 7/7/6 threads.

## 2026-08-21 night — warm-switch optimization campaign (goal: beat T3 on every metric)

Profile-guided loop against the graded corpus (CDP CPU profiles resolved
through sourcemaps, Performance.getMetrics deltas, per-frame signature logs,
40-switch leak-ramp and mounted-surface probes). Mechanism findings:

- Switch cost is BIMODAL: a session still inside the 10-surface workbench MRU
  re-shows in ~46-54ms; an evicted one remounts in ~100-160ms. The benchmark
  plan crosses 20 sessions, so ~half are remounts (session weight was a
  secondary factor; plan position/mounted-state dominates).
- No per-activation leak: 40 alternating switches are flat at ~46ms.
- Folds are small (~1.7k DOM nodes; the unfolded diff code block is 396 of
  them); wall time is script (~39ms/switch) + style recalcs (~52/switch,
  ~17ms) + waiting out stability-breaking wobbles, not raw mount CPU.
- Re-show drift: display:none discarded hidden tabs' layout, so re-shows
  re-measured and drifted (+403/-30/-19px) until ~80ms.

Landed (commit 0b5babd6b, probe p95 for the exact plan 175 -> ~126ms):
merge indexing + reference-preserving no-op hydrates; lazy nav previews;
scroll-thumb rAF coalescing; content-visibility:hidden pane tabs; slot
transition removal; 100ms-grace static skeleton (user directive: no shimmer,
nothing under 100ms); row-model extraction of content-id/anchor predicates.

Measured but NOT landed: MAX_OPEN_SURFACES 10 -> 24 (another ~30ms p95;
guarded product contract in surface-budget tests — needs a product decision).
Diagnostic-only: global animation kill (p95 -> ~119) — the targeted slot fix
took part of it; rail-neutralization diagnostic broke the click machinery.

Same-day standings after the campaign (T3 from attempts 16-10/16-12; Claxedo
official workspace runs kept invalidating on postflight host load — probe
figures marked *): cold_ready 1986 vs 3205-3325 WIN; cold_open 115.7 vs
95-170 mixed; warm_switch ~119-126* vs 79.8 BEHIND; peak RSS 1619-1629 vs
1552-1727 comparable-to-better; idle CPU p95 8.0 vs 12.1-15.4 WIN.

Remaining for the goal: ~40ms more off remount p95 (next leads: the ~39ms
per-switch script — screen chrome mount deferral; re-show measurement-drift
suppression; rail row cost), quiet-host certification runs, and the four
stream/terminal metrics (T3 driver live-validation) still unmeasured.

## 2026-08-22 early hours — drift class solved (markdown re-parse) + T3 stream gate

**T3 conversation profile unblocked honestly** (t3code `3643c8506`): T3
persists NOTHING for non-tool item events (`ProviderRuntimeIngestion`
returns `[]`), so reasoning never reaches settled-thread history by product
design — while the stream replay renders reasoning live via the provider
adapter (`reasoning_text`), and the generated corpora stream only text
revisions + tool lifecycles anyway. The materializer now computes the
conversation profile's coverage from the shapes the replay actually plays
(`streamedUnsupportedShapes`); the history drops stay declared on the
workspace/resource entries. Unit tests pin both directions; the stale units
literal and committed JSON-schema artifacts from the graded redesign were
also finished. The four stream/terminal metrics now need only a live run
(blocked while the user's own T3 Nightly is open — dual-instance trap).

**Warm-switch drift class root-caused and fixed** (perf branch `d86dc72ec`).
Instrumentation: an in-page per-frame wobble recorder (scrollTop/scrollHeight
deltas with per-row culprit heights, then full-row HTML first-difference,
then per-row [t, htmlLen, contentHeight, wrapperHeight] series) plus
cache-miss reason tracing behind `__claxedoPerfTrace`. Findings:

- Every post-paint shrink (-19/-30/-231/-327px) was a row whose markdown
  had never been parsed at that mount: raw-text fallback paints taller,
  gets measured, the persisted snapshot carries the stale height, and every
  later visit re-corrects after the async parse lands (~40-160ms wall).
- The misses were structural: markdown HTML cache 200 entries, code
  highlight cache 256/2MB, timeline measurement-snapshot cache 16 sessions
  — all far below a 20-session sweep's working set (~25 blocks per visit).
  Raising alone did NOT fix boundary rows (visit 2's restored-measurement
  overscan mounts rows visit 1 never parsed) — the durable fix is the
  previously-dead `preloadMarkdown` API, now wired as bounded newest-first
  idle preloading per session (rIC with timeout; runs to completion).
- `virtual-core.measure()` wipes restored snapshots wholesale; the mount
  effect already guards against that (initialized to the mount key).
- RO measurements are DROPPED (not deferred) during smooth scrolls
  (`shouldMeasureDuringScroll`) — explains rare 124ms adoption lags.

Probe trend (same graded plan, diagnostic host): p95 175 (pre-campaign) ->
~145-154 (first landed slice) -> **137, max 137** (this slice). T3 target:
79.8. Remaining per-switch cost is activation infrastructure
(openSession.metaUpsert ~13ms + addContent ~12ms + showContent ~15ms per
remount) and the user-blocked MAX_OPEN_SURFACES 10->24 decision — with
re-shows now ~50ms, a 24-surface MRU would make nearly every plan switch a
re-show.

**Claxedo stream + terminal arms — first-ever deep exercise** (perf branch
`285461189`):

- Stream (`controlled-stream-v1`): fixed the replay PATCH to carry the
  stream session's own workspace directory (multi-workspace corpora 404 on
  the root), but the scenario is structurally unusable against the packaged
  app: it PATCHes the engine's `updatePart` HTTP surface, and the embedded
  composition uses an in-process transport — no engine HTTP exists, and the
  claxedo server surface exposes only `/session` list/create + message
  prompt. DESIGNED NEXT STEP: a harness-hosted deterministic model provider
  (the same seam T3's replay server fakes for its architecture), so the
  scenario sends a real prompt and the full engine -> events -> renderer
  pipeline streams the corpus turn.
- Terminal (`terminal-core-v1`): the app half of the benchmark contract
  (data-terminal-connected, data-terminal-benchmark-instance-id,
  terminalWriteAccepted/Parsed receipts) had been LOST in the same
  partial-commit incident b7d5b8bf7 recovered the harness from; recovered
  from `stash@{1}^3`, extended with instanceId, wired, tested (994/994
  terminal core tests). Live validation pending a user-idle window — runs
  invalidate on "application lost foreground" while the user works, which
  is the guard behaving correctly.

## Open items

- T3's stream + terminal driver scenarios: implemented, never live-validated
  → the four `stream.*` / `terminal.*` metrics have no comparison yet.
- Single run per configuration; add repetitions before calling close races.
- Remote-hydration-latency scenario class (the "loading message" regime the
  user observed in real use) is unmodeled in both drivers.
- Claxedo deep-history jump is honest but seconds-slow; the designed fix is
  a target-anchored jump + content-aware height estimates (deferred by user).

## 2026-08-22 — parallel optimization lines merged; corpus v2 (graded-v1 regenerated)

**Merged** `optimize/claxedo-beat-t3-graded` (six commits from the parallel
perf-beat-t3 session, reviewed) onto the campaign branch: row-level
`content-visibility:auto` with virtualizer-sized intrinsic boxes; nav-gutter
and env-card gutters reserved before first paint (their paired A/B: pooled
p95 161 -> 137 on their baseline); single-step settled turns fold (T3
presentation parity); env card defaults collapsed; the 150ms gutter
transition removed; and the warm-switch/LoAF probe tooling committed under
`perf-harness/probes/`. Zero new test failures (the 9 bun + 131 vitest
failures reproduce exactly at the pre-merge commit; the vitest breakage is a
pre-existing `localStorage.clear` environment fault). The two lines'
mechanisms are disjoint (their render-cost cuts vs this session's
cache/preload/cap/idle-governor work), so gains are expected to stack.

**Corpus v2**: t3code `480e77cf0` moved diffs out of inline markdown prose
into completed `apply_patch` tool calls (real transcripts never paint diffs
as assistant markdown), but landed without re-embedding the expected
manifest — every T3 arm refused with a manifest mismatch. Regenerated:
graded-v1 sha is now `6a020d15cf40e2497aadbfb699be0e9c7ef8940d4e41d5d441195f0a3da077df`
(diffParts 0, toolParts 8038, reasoningParts 471 unchanged); manifest
re-embedded in the t3code corpus config; every sha pin updated (targets,
runbook, probes) on both sides. ALL graded numbers earlier in this ledger
are non-comparable with corpus-v2 runs.

**First full 8-arm certification attempt** (cert-010801, user at keyboard by
request): all four Claxedo arms invalid environmentally (occluded-window CDP
stalls / lost foreground) — but the terminal arm passed PTY connection,
output observation, and workload start for the first time ever before
stalling on a paint-gated stage while hidden. One REAL defect surfaced: the
stream arm's prompt never reached the fake engine's `prompt_async`
(`cert-010801-conversation-rich-v1`) — the app-side prompt path is the open
bug. T3 arms all refused on the corpus manifest mismatch above (now fixed).

## 2026-08-22 ~01:45 — first corpus-v2 certified comparison (cert-014344 / T3 19-53, 19-55)

Merged build (both optimization lines + cap-24 + idle governor) vs T3 on the
regenerated corpus. Claxedo workspace/resource/conversation valid; T3
workspace/resource valid.

| metric | T3 | Claxedo | verdict |
|---|---|---|---|
| cold_ready_ms | 3287 | 2189 | WIN |
| cold_open_ms | 169.5 | 94.9 | WIN |
| warm_switch_p95_ms | 54.9 | 119.4 | BEHIND (T3 improved on v2: collapsed tool cards) |
| peak RSS MiB | 1619.8 | 1699.6 | BEHIND ~80 MiB (cap-24 cost suspect) |
| idle CPU p95 % | 16.85 | 19.96 | BEHIND — preloader regression, fix landed 0d508aa30 |
| stream.interaction_p95_ms | arm broken | 24 | Claxedo-only (FIRST valid stream attempt) |
| stream.blocked_frame_ratio_pct | arm broken | 0 (passes budget) | Claxedo-only |
| terminal (both metrics) | raw-log gap | sustained-progress stall at INPUT-00-A | both broken |

Findings this round:
- Stream arm end-to-end WORKS after routing the fake-engine URL through
  CLAXEDO_CHILD_OPENCODE_URL (9afe0c26d) — the desktop child only reads its
  own startup names, bare OPENCODE_URL is forwarded but never consumed.
- resource `complete-process-ownership` (expected 0, actual 7) = a SIBLING
  Claxedo Dev instance from another worktree in the family scan; the same
  instance also polluted a 3046ms cold_ready (2189 clean). Any second
  Claxedo instance invalidates the resource arm — the guard's Claxedo-Dev
  exemption cannot distinguish ours from a stray.
- Idle CPU regression was the per-surface preload loops (forced 100ms ticks
  x 20 sessions); serialized into one deadline-aware queue (0d508aa30) —
  burst when idle, one part per forced tick under load. Unmeasured yet.
- T3 conversation arm: times out waiting for its own replay warmup session
  on corpus v2 (new failure, T3-side). T3 terminal: the parked raw-log gap.
- Claxedo terminal stalls at "sustained progress INPUT-00-A" even unoccluded
  — first genuinely reproducible terminal-scenario failure to debug.
