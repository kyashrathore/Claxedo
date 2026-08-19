# 2026-08-13 session — web bundle + app memory/size effort

Continuation of the five-times effort (see HANDOFF.md), run on a Linux cloud
container against `claude/claxedo-perf-optimization-1yzgej`. The macOS gate
suite cannot run here (HANDOFF §12.4); this session worked the two lanes that
CAN be measured headless — the web surface (never measured before, §1.2) and
everything server-side/build-time — plus renderer work that transfers to the
desktop per §1.2's transfer list.

## Headline results (all measured, commands in the commits)

| metric | before | after | delta |
|---|---:|---:|---:|
| Web eager main chunk (raw) | 2,585.3 kB | 959.7 kB | **−63%** |
| Web eager main chunk (gzip) | 748.4 kB | 292.4 kB | **−61%** |
| Main CSS (raw) | 475.1 kB | 441.4 kB | −7% |
| Embedded engine artifact | 23.08 MB | 9.96 MB + 3.66 MB sibling JSON | **−41% shipped** |
| Engine import (Node 22, n=3) | ~1,385 ms | ~1,118 ms | **−267 ms** |
| Server-child RSS after engine import | ~281.7 MiB | ~244.4 MiB | **−37 MiB** |
| sqlite page-cache ceilings (×2 DBs) | 64 MiB each | 8 MiB each | −112 MiB ceiling |
| Windows desktop download (node-pty removal + .pdb) | — | — | **~−33 MB** (est. from measured file sizes) |
| claxedo-app architecture suite | 245/260 | 260/260 | 15 pre-existing failures fixed |
| claxedo-app full bun suite | 5,148/5,173 | +14 fixed, 0 new | strictly better |
| repo-wide turbo typecheck | FAILED (opencode) | 37/37 | fixed |

## What landed (web bucket — transfers to desktop renderer)

- **Guard enforcement**: all five deps the repo's own forbidden-eager-deps
  guard flags were leaking (katex, marked, @pierre/diffs+shiki,
  @tanstack/ai-client, qrcode). All evicted; the static walker gained
  session-ui resolution (its blind spot) and a boot-closure scope that also
  covers the pre-first-paint chunks (`preloadRuntimeProviders` roots).
- **session-kit fan-out cut**: light boundaries (session-kit-prompt,
  session-kit-context) so the eager composer and boot-time directory-scope
  stop pulling pierre+shiki through the barrel. Eager closure 686 → 349 files.
- **Entry barrel trim**: `app/entry/index.tsx` re-exported settings, routes,
  dialogs, terminal, titlebar to nobody; now exports only what its three
  consumers import. This also severed the published entry's last hosted reach
  (login route) — boundary pin is now null.
- **zod eviction** (~252 kB): plain predicate in global-sdk, lazy boundaries at
  feature-ports/documents/workgraph/processes seams, guarded permanently.
- **katex dedupe**: one version (0.16.47) instead of two full copies.
- **luxon removal** (~70 kB): three call sites, replaced with Intl formatting
  (same output spellings, verified).
- **Highlight cache fix** (HANDOFF's recorded-UNFIXED defect): completed code
  blocks now render from a bounded module LRU on remount instead of re-paying
  the worker round trip (52–58 ms/switch measured in the desktop effort).
- **Idle periodics** now pause hidden windows (10 s wake detector, 20 s
  harness-health poll) — lands in the desktop quiescent-CPU window too.
- **Dead code**: legacy titlebar/menu cluster deleted (also resolved 11
  documented keybind collisions), orphan barrels removed.

## What landed (app bucket)

- **Engine artifact**: minified (the CLI build already was; the SHIPPED one
  wasn't) and the ~3.7 MB models.dev catalog de-inlined to a sibling JSON read
  lazily module-relative. Falsifier test boots the packaged layout cold.
- **Desktop build**: electron-vite main/preload/renderer now minify (the
  presets default OFF — nothing shipped minified before); ACP adapters,
  host-connector, engine worker minified; compression maximum; node-pty's
  27 MB of win32 .pdb and ~4.2 MB of node-gyp input trees excluded;
  out/**/*.map excluded from the asar; per-artifact size ratchet added to
  verify-package-contents.
- **One PTY module**: workspace-runtime migrated to @lydell/node-pty;
  node-pty (63 MB installed, 30 MB win32 prebuild) fully removed, with a real
  /bin/sh spawn/resize/exit falsifier under node --test.
- **Server child DB boot**: both `cache_size=-64000` → `-8000`; migration SQL
  reads are lazy (warm boot reads zero of 37 files); `repair()` gated on a
  sqlite_master fingerprint, failing open; two unconditional full-table
  UPDATEs no longer run per boot.

## Broken things fixed along the way (branch inherited a dirty-worktree handoff)

- `renderer-trace.ts` and `claxedo-server-lifecycle.ts` were imported but
  never committed — web build and desktop typecheck were broken at the branch
  point. Recreated as canonical modules.
- `bundle-single-instance.test` bundled the wrong entry (pre-boot-stub).
- Routed LOCAL sessions blocked on the directory cache warm and fell to the
  retry screen when it failed (both gating tests red at branch point).
- MCP SDK typing drift broke repo typecheck (9 errors); the two shipped
  defects HANDOFF names (model picker, saved model selection) were already
  committed on this branch.

## Still open, with pointers

- The remaining eager items: features/session app code (~241 kB),
  @kobalte/core (~90 kB), sdk.gen (~49 kB), icon.tsx (~45 kB — sprite
  experiment outcome recorded separately), i18n en fallback (~54 kB,
  inherent). CSS 441 kB is untouched.
- `test/mcp/session-recovery.test.ts` fails at the branch point (SDK retry
  drift) — not perf, not fixed here.
- 12 pre-existing claxedo-app test failures (upstream-contract pins,
  signed-transport suite) — red at branch point, unchanged.
- The macOS ten-gate suite still needs a run on real hardware to price the
  renderer-side wins in gate terms (M2/M3/M5), and the isolated-vs-ambient
  experiment (HANDOFF §7.2) remains the decisive one for M1.
- Renderer `--js-flags` (HANDOFF §1.1) deliberately NOT set: no way to
  measure renderer RSS here, and unmeasured flags on the interaction path
  violate the measurement rules.

## Addendum: the §11.5 icon-sprite outcome (recorded, closing the ledger)

The predecessor's "inline SVG sprite" prototype — the one idea in the WIP
archive with no recorded outcome — turned out to have LANDED in `7045033` +
`7e66409`: OpenCodeIcon injects one 110-symbol sprite and renders <use>, and
the codex/file/provider icons already lazy-materialize an external sprite
asset. Measured 2026-08-13 (happy-dom, 500 instances, 21 runs ×2): sprite is
36–38% faster warm / 13–18% cold than per-instance inline paths; DOM nodes
only −13% in-view and net-neutral counting the sprite root, so the render-cost
rationale holds and the DOM-memory rationale does not. Keep; no code change.
Remaining follow-up: icon.tsx still carries its ~42 kB icon record in the
eager chunk solely to build the sprite at runtime — externalizing it like the
codex sprite asset is the bundle-size item.

## Addendum 2: the founding web-vitals baseline (browser lane, headless Chromium 149)

The repo's own browser perf lane (`perf-harness` browser adapter, 5 scenarios,
paired diagnostics A/B) ran headless in this container — the first time the
web surface has real interaction numbers. A branch-point control is
IMPOSSIBLE: the base tree's production build fails outright (the missing
renderer-trace module), so these are the founding numbers, on commit a0d9bde:

| scenario | p95 frame | worst task | tasks >16.67ms | verdict |
|---|---:|---:|---:|---|
| launch-project | 0.64 ms | 63–71 ms | 24–26/~6k | tail only |
| session-switch | 0.02 ms | 37–43 ms | 20/~31k | tail only |
| live-terminal-switch | 6.15 ms | 39–41 ms | 9–10/~400 | tail only |
| large-diff-toggle | 8.09 ms | 73–91 ms | 7–12/~1k | tail only |
| workspace-switch | 0.02 ms | 27–33 ms | 3/~4k | tail only |

p95 frames are all comfortably 60Hz; every failure is a TAIL long task — the
same one-big-flush shape the desktop effort measured (M3 cold mounts, M5
first-replay render). Known harness caveat: every scenario also warns "only
1 of N seeded sessions visible in the session inventory" — the seeding
contract has drifted from the app's inventory path and needs its own fix
before the inventory-dependent assertions mean anything.

## Addendum 3: the 5x round — Suspense detach fix, Linux desktop app, honest nulls

- **Session-switch structural fix (a0b91a5)**: the app-shell's only Suspense
  detached the ENTIRE app DOM on every session switch. Pane-local Suspense +
  restore-first offset reconnect: switch completion 2,559/1,641 → 615/603 ms
  (2.6–4.2×), renderer tasks in the measured window ~37–55k → ~1.2k. The same
  commit dropped large-diff-toggle's worst task from 63.8–94.6 to
  22.4–38.1 ms (independent interleaved measurement by the other lane).
- **Diff-toggle lane: NULL, reverted** per the measurement rules — windowed
  header rendering beat the OLD baseline but regressed against the new HEAD
  in contamination-checked interleaved pairs. Mechanisms recorded for
  successors: requestIdleCallback admits heavy sticky accordion headers 2 at
  a time at 17–54 ms/tick (review-session.tsx:296), style recalc grows with
  sticky header count, and split/unified toggle rebuilds the FileDiff because
  the two modes use two worker pools (file.tsx:1086).
- **The Linux desktop app runs headless in this container** (xvfb-run,
  --no-sandbox/--disable-gpu): found and fixed a SHIPPED boot defect — the
  server child crashed on `server.ready` (undefined) right after listening,
  killing the embedded server in every packaged build. LocalServer now
  exposes a real listening-resolved `ready`. Shell stage: readyMs 5,036,
  settled family RSS ~1,007 MiB on this 4-core container. Full-stage numbers
  need a seeded project profile (fresh profiles have no rail).
- Browser-lane caveat for successors: identical builds swing up to 3× between
  runs on this container — use interleaved pairs, never single runs.

## Addendum 4: the reactivity-and-network-gates hunt (three-agent sweep)

The round the Suspense-detach fix predicted: systematic hunt over Solid
reactivity and network gating, all interleaved-pair measured.

**Workbench store replacement (6dc8e59, the big one).** Every reducer returns
fresh references and production applied them with plain setState — wholesale
node replacement. Every navigation.show destroyed/recreated every pane div
(the "slot move" relayout) and re-ran every focusedContent() reader (the
thousands-of-updates click flush). The workbench's own test harness already
used reconcile — production drifted from its own contract. Fixed with
reconcile(key:'id') + a falsifier vitest that drives the real provider
(verified red on the old wiring). Rail rows also rebuilt wholesale per switch
(eager active read at build time) — now lazy accessors over createSelector.
Pairs: session-switch completion 676→503/468 ms, workspace-switch 1090→657 ms.

**Streaming tick storm (6d9b5bb).** Every part delta re-ran row construction
for EVERY turn (O(all parts) per 60 Hz tick) — per-message equality gates now
lean on the projection's WeakMap identity stability, pinned by a tripwire
test. No lane scenario exercises streaming (gap recorded); the shiki warm-up
also moved to post-boot idle.

**Boot request graph (139ee05).** New request-log lane (JSONL + fetch-stack
attribution) mapped ~51 boot requests, zero fire-and-fail. Three duplicate
sources fixed (double provider catalog fetch, raw fallback resolve, split
runtime cache key): resolve 20→16, /provider 12→8 per 4-boot run, A-B-A
verified.

**Handoff queue (stack-attributed, fixes live in named files):**
H1 4× GET /api/claxedo/session per boot (global-sync snapshot Promise.all +
double reloadWorkspace; note HANDOFF lists "local inventory single-flight"
as tried-and-reverted — retry per protocol). H2 route-bridge /s/:id probes
fetch meta and config ×2 concurrently. H3 3× permission-mode (share one
query). H4 shell.ts/directory.ts call .queryFn() directly, bypassing the
cache. H5 session-environment-card raw /vcs beside the queryKeys.runtime.vcs
silo (2× per boot).

**Honest nulls, all with evidence:** global-sdk event path already coalesced
(16 ms frames + batch); composer grain keyed correctly; QueryClient defaults
storm-safe; retries capped/jittered; the two non-rail queryMirrorEffects are
guarded one-shot handoffs; bootstrapDirectory's serialization is a real data
dependency.

**H1–H5 closed (see final commit):** all five duplicate sources fixed and
A-B-A verified; total boot requests 48 → 39. The residual second /config GET
is a distinct consumer (agent-runtime-client session hydration), recorded as
an observation, not a dupe.

## Addendum 5: unused code, duplicate deps, critical rendering path

- **Duplicate deps**: sourcemap scan found 12 packages shipping in 2+
  versions; the six same-major ones unified (two @tanstack/query-cores
  collapsed via solid-query+persist 5.99.2; diff/dompurify/solid-primitives
  aligned with root overrides; bun needed install --force to relink stale
  nested store links). The six survivors are cross-major mermaid/cytoscape
  internals. drizzle-orm dropped from local-server (zero refs).
- **Critical rendering path**: the four boot chunks were a 3-hop discovery
  waterfall — a hash-safe transformIndexHtml plugin now modulepreloads them
  (+closure): fetchStart 810–1166 ms → 55–59 ms at 40 ms RTT (~1.1 s of
  serial discovery gone). KaTeX CSS (28.8 kB + 21 font faces) left the
  render-blocking stylesheet for the lazy math chunk: main.css 441→411 kB
  (66→58 kB gz). Tailwind stops scanning test files/doc comments (the
  .[file:...] garbage utilities; build warnings 3→0); terminal font gains
  font-display: swap. Theme-preload script inspected: minimal, correct,
  keep.
- **Unused code**: 22 zero-import dependencies removed across the three web
  packages (incl. effect and the motion pins that split framer-motion),
  ~15 dead files deleted, claxedo-app's export map cut 12→2 subpaths, and
  the standing desktop-menu test error removed. Story-only components and
  seven deployment-knob VITE_ flags recorded as risky-not-dead.

## Addendum 6: full verification pass vs baseline

**perf-harness unit suite: 64/68, 4 pre-existing errors** — two MORE
never-committed modules from the origin worktree (src/idle-process-family,
src/agent-browser-observer — the desktop lane's session-activation and
process-family instruments; git log --all confirms they never existed in any
commit). Unlike renderer-trace these are measurement instruments with
paid-for semantics; reconstructing them blind would fabricate the very
instruments HANDOFF documents. They must come from the origin macOS
worktree. Their absence only blocks the desktop (macOS) benchmark lane and
its two unit-test files — the browser lane and all product code are
unaffected.

**Browser lane vs the founding baseline** (two fresh --all passes at HEAD;
note the baseline predates the seed fix, so baseline scenarios rendered ONE
session where current runs render all seeded sessions — the comparison is
conservative against current numbers):

| scenario | metric | baseline (a0d9bde) | now (2 runs) |
|---|---|---:|---:|
| session-switch | completion | 1,272.8 ms | 502.4 / 505.0 ms (**2.5x**) |
| session-switch | tasks in window | ~31k | 820 / 862 (**~36x fewer**) |
| large-diff-toggle | worst task | 73–91 ms | 19.9 / 42.5 ms |
| large-diff-toggle | tasks >16.67ms | 7–12 | 2 / 2 |
| launch-project | completion | 1,123 ms | 1,065 / 1,083 ms |
| live-terminal-switch | worst task | 39–41 ms | 84.6–85.3 ms* |
| workspace-switch | completion | 203.9 ms | 313.6 ms* |

*terminal and workspace-switch now render 3 terminals / 5 workspaces of
seeded content the baseline never displayed (broken inventory) — these two
rows are not comparable and need a fresh like-for-like baseline.

## Addendum 7: post-e2e-repair benchmark round (2026-08-15, this container)

Context: between Addendum 6 and this round, the e2e suite went 75-failed →
335/337 (two load-flakes), fixing among other things the progressive-reveal
cap that silently dropped timeline rows (2a54c64's renderRangeLimit latch),
the lazy-CSS pane collapse, dialog-suspense remounts, and the solid-query
client-suspension trap (vendored patch). Full commit trail e61d2f8..6cd6a05.

### Browser lane (two full --all passes at 6cd6a05, ABBA per pass)

| flow | metric | founding baseline (a0d9bde) | Addendum 6 "now" | this round (2 passes) |
|---|---|---:|---:|---:|
| launch-project | completion | 1,123 ms | 1,065 / 1,083 ms† | 2,399 / 2,418 ms |
| session-switch | completion | 1,272.8 ms | 502.4 / 505.0 ms† | 831 / 760 ms |
| session-switch | tasks in window | ~31k | 820 / 862 | 926 / 1,072 |
| large-diff-toggle | worst task | 73–91 ms | 19.9 / 42.5 ms | 31.8 / 39.4 ms |
| live-terminal-switch | worst task | 39–41 ms* | 84.6–85.3 ms* | 67.3 / 65.5 ms |
| workspace-switch | completion | 203.9 ms* | 313.6 ms* | 443.8 / 415.4 ms |

† **The Addendum 6 timeline numbers are invalid as a baseline.** They were
measured while the progressive-reveal cap latched `renderRangeLimit` at its
first-paint value, so those runs silently rendered a FRACTION of each
transcript (the same defect the e2e oracle caught as "assistant reply never
appeared"). This round is the first correct-rendering measurement of these
flows. Founding-baseline comparisons that remain honest: session-switch is
still ~1.6x faster than a0d9bde WITH full rendering; large-diff worst task
still ~2x better. Rows marked * carry the Addendum 6 seeded-content caveat.

> **[CORRECTED 2026-08-16 — the launch-project row above is a MEASUREMENT
> ARTIFACT, and the explanation this addendum originally gave for it was
> wrong.]** This addendum claimed the 1,123 -> 2,4xx ms launch change was
> "the shell did not get slower; the transcript now actually renders". That
> attribution does not survive checking. `transcript_render_ms` was pinned to
> a wall-clock SSE reconnect timer, not to rendering: the harness's readiness
> clause required THE FIRST `[data-timeline-key]` row in DOM order to carry
> text, and `TurnGap` (an aria-hidden, deliberately empty spacer row) leads
> the list on a cold mount, so readiness waited ~1.25 s past a transcript
> that was already rendered and visible, until the 2 s reconnect advisory
> vanished and grew the scroller. Fixed in 9d16de0 (some mounted row must
> have content; the expected-text proof is unchanged). With the corrected
> instrument the same tree measures **completion 1,118 ms and
> `transcript_render_ms` 1,094 ms** — i.e. essentially the founding
> baseline's 1,123 ms, with no launch regression to explain.
> The tell was in this addendum's own data and was missed: `transcript_
> render_ms` reproduced at 0.2-0.9% relative stddev while
> `launch_workspace_ready_ms` beside it scattered 7-19% on the same host.
> Sub-1% reproducibility on a 3x-swinging container is a clock, not work.
> The causal chain is worth keeping: releasing the reveal cap (af356f8,
> correct and necessary) changed which rows mount, a spacer started leading
> the list, and that tripped the latent gate defect. Pre-9d16de0 and
> post-9d16de0 `transcript_render_ms` values are NOT comparable.

Known gap in the harness fixture, same drift family as the e2e round:
`GET /api/claxedo/extensions` is unmatched ([perf-mock] log line) — one
fixture line when this lane is next touched.

### Server child (same method as the headline table: Node 22, n=3)

| metric | pre-effort | Addendum-era | this round |
|---|---:|---:|---:|
| engine artifact (shipped) | 23.08 MB | 9.96 MB + 3.66 MB JSON | unchanged (9,955,488 B + 3,658,251 B) |
| import time | ~1,385 ms | ~1,118 ms | 1,261 / 1,366 / 1,390 ms |
| RSS after import | ~281.7 MiB | ~244.4 MiB | 241.9 / 243.2 / 245.0 MiB |

The −41% artifact and −37 MiB RSS wins hold exactly; import time sits
between the two prior marks (same-container noise band).

### Bundle (final HEAD build)

| asset | pre-effort | Addendum 6 | this round |
|---|---:|---:|---:|
| main JS raw / gzip | 2,585.3 / 748.4 kB | 959.7 / 292.4 kB | 939 / 286 kB |
| main CSS raw | 475.1 kB | 441.4 kB | 417 kB |

The e2e round deliberately moved CSS back into the eager bundle
(envcard shell, menu/select/tooltip v2 sheets — all load-bearing for
always-rendered markup); net bundle still shrank below Addendum 6.

### Desktop lane (packaged Linux app, xvfb, this container)

Packaged at 6cd6a05 (`bun run package:linux`; the unpacked binary — the
distributable target step fails in this container, irrelevant to
measurement), fresh profile, `CLAXEDO_PERF_READY_SELECTOR="[data-claxedo]"`,
`xvfb-run --no-sandbox --disable-gpu`:

| metric | Addendum 3 | this round |
|---|---:|---:|
| session list ready (after-renderer) | 5,036 ms | 5,273 ms |
| settled process-family RSS | ~1,007 MiB | 1,023 MiB @ ~15s / 915 MiB @ ~40s |

Both within same-container noise of the Addendum 3 marks — the e2e-repair
round did not move desktop cold start or idle memory.

### Gate-harness lane (M2/M3/M9/M10 instruments)

Still blocked in this container: `idle-process-family.ts` and
`agent-browser-observer.ts` exist in no commit (macOS-origin worktree only,
per HANDOFF); the four perf-harness unit errors are their unresolvable
imports. Not reconstructed — fabricating measurement instruments would
fabricate their evidence.

## Addendum 8: is core navigation 60hz? (measured at b19a085, two interleaved passes)

**No flow earns the badge; every flow's typical frame is nonetheless inside
the 60hz budget.** The badge (`verdictFor`, frame-sampler.ts:110) turns red
if ANY single renderer interval exceeds 16.67 ms — allowance zero — so one
mount spike in twenty thousand frames reads the same as a sustained stall.
Reported separately below: the distribution (what the user feels while
moving) and the tail (what the gate fails on).

Method: `bun run run:debug` twice (pass B with `CLAXEDO_PERF_SKIP_BUILD=1`,
same bundle), 4 ABBA contexts per flow, quiet 4-core container. App-
attributable = `headline.mainThreadTasksMs` (what the app gate counts);
host gaps = `unattributedSchedulingGapsMs`, which the harness already
excludes from the app verdict — they are container noise, listed only to
show how much of it there was.

| flow (pass A / pass B) | p95 frame (ms) | steady-state class | worst app task (ms) | app tasks >16.67 | samples | frames within 60hz | host gaps >16.67 |
|---|---:|---|---:|---:|---:|---:|---:|
| launch-project | 0.39 / 0.35 | 120hz | 81.2 / 83.1 | 30 / 36 | 18,693 / 17,980 | 99.84% / 99.80% | 45 / 46 |
| session-switch | 8.72 / 4.88 | 120hz (straddles) | 47.3 / 68.3 | 24 / 26 | 722 / 941 | 96.68% / 97.24% | 19 / 20 |
| live-terminal-switch | 14.52 / 15.60 | 60hz | 42.9 / 37.4 | 8 / 7 | 216 / 190 | 96.30% / 96.32% | 8 / 8 |
| large-diff-toggle | 6.60 / 6.02 | 120hz | 32.2 / 33.5 | 3 / 3 | 964 / 987 | 99.69% / 99.70% | 8 / 16 |
| workspace-switch | 0.48 / 1.75 | 120hz | 75.5 / 53.3 | 11 / 11 | 1,764 / 895 | 99.38% / 98.77% | 8 / 6 |

> **[CORRECTED 2026-08-16 — launch-project's sample count and miss density
> above are inflated by the same artifact.]** ~1.25 s of that flow was the
> harness polling a transcript that had already rendered (see the correction
> in Addendum 7), and the frame sampler recorded throughout, so the ~18k
> denominator contains ~13k phantom idle samples. With the corrected gate
> (9d16de0) the same tree measures **31 misses in 5,226 samples = 0.59%**,
> not 0.16%. The p95 conclusion is unaffected (0.74 ms measured after the
> fix), and no other flow is affected — the artifact was specific to
> launch-project's readiness clause.

Reading it:
- **p95 is under 16.67 ms in all five flows**, and under 8.33 ms in four —
  ordinary frames during navigation are 60hz-capable, mostly 120hz-capable.
- **What fails is the tail**: 0.3–3.7% of intervals miss the deadline
  (launch-project 0.59% after the correction above),
  concentrated at mount/transition boundaries (worst tasks 32–83 ms).
- **Highest risk is `live-terminal-switch`**: it has both the highest miss
  density (3.7%) and a p95 (14.5–15.6 ms) sitting just under the ceiling —
  the only flow where ordinary frames are near the edge rather than an
  order of magnitude clear of it. `terminal_resize_ms` p95 ~101 ms.
- **Best behaved is `large-diff-toggle`**: 3 misses per ~1,000 frames.
  Addendum 6 recorded 7–12 over-budget tasks here; this is a real
  improvement, not noise.
- `session-switch` p95 swings 4.88↔8.72 between passes — the container's
  documented ~3x variance; treat its class as "120hz on a quiet host,
  60hz under load".

Named sub-metrics (pass A p50/p95, ms): launch_first_window 219/250,
launch_workspace_ready 312/357, transcript_render 2,310/2,320;
single_switch 300/305; terminal_switch 25/28, terminal_resize 95/101;
review_panel_open 30/35, vcs_load 65/114, first_hunk_ready 408/442;
file_tree_load 29/34, file_tree_data 53/54.

If the zero-allowance badge is to go green, the work is tail-shaped, not
throughput-shaped: attack the 30–80 ms mount/transition tasks (the
transcript first-render dominating launch, the terminal resize path), not
the steady-state render loop, which is already comfortably inside budget.

## Addendum 9: terminal-tail attempt — NULL, with two mechanisms recorded

Attacked the worst 60hz flow from Addendum 8 (`live-terminal-switch`: highest
miss density, p95 nearest the ceiling). **Nothing landed.** Both candidate
changes were reverted; the tree is unchanged. The profiling below is the
deliverable — it is what a successor would otherwise have to re-derive.

### Where the tail actually comes from

`CLAXEDO_PERF_CAUSAL=1` populates `headline.causal.traceTasks` with real
trace-event attribution. Across the 20 long tasks of one flow:
**Commit 240 ms · JS (rAF + calls) 137 ms · other 66 ms**, with the worst
tasks 52/43/32 ms of pure `Commit`. Whole-flow app script is only 105 ms,
layout 2.4 ms, style recalc 21 ms. Per-thread totals confirm the shape:

```
149.7 ms CrRendererMain RunTask   86.2 ms CrRendererMain Commit
 94.9 ms VizCompositorThread       71.4 ms CrGpuMain (70.9 GPUTask)
  9.2 ms RasterTask   <- rasterization is NOT the cost
```

So the flow's misses are the main thread blocking on GPU-side surface and
texture work, not on application JavaScript. **Optimising app logic cannot
move this flow.** Two contributors were found and measured:

**M1 — identity filters force per-slot render surfaces.** Every workbench
content slot carried Tailwind `saturate-100` → `filter: saturate(1)`:
visually identity, but any non-`none` filter gives the slot its own cc render
surface, so a 1160x912 xterm WebGL canvas is rasterized into a separate
texture and filtered every commit instead of being composited as a plain
texture quad. Removing it measured `terminal_resize_ms` 98 -> 78 ms (no
overlap across runs) and, combined with M2, worst task 41 -> 28 ms and
Commit 196 -> 163 ms.
**Why it did not land:** it also made terminal switching reproducibly
SLOWER, 27.6 -> 41 ms with zero overlap — that cached surface was preserving
the newly-shown terminal's pixels across a switch. Paying certain, felt
latency on a frequent interaction to improve a gate that stays red either way
is the wrong trade (same discipline as Addendum 3's diff-toggle NULL). A
successor wanting M1 needs the surface only DURING the switch (e.g. a
transient `will-change`/containment applied to the incoming slot), not
permanently on every slot.

**M2 — the glyph atlas was rebuilt on every resize settle, per terminal.**
`clearTextureAtlas()` ran unconditionally in the coordinator's `refresh()`,
for all three attached terminals (the two inactive ones are stashed
`visibility:hidden` + `contain:strict`, NOT `display:none`, so they keep
settling). Instrumented: 781 glyph `fillText` + 781 `fillRect` and 14 atlas
clears per flow, for a terminal showing one seeded line. Guarding the rebuild
(recovery sources `mount`/`visibility`/`retry-fit`, plus a
`dpr|fontSize|fontFamily|letterSpacing|lineHeight|cellW|cellH` signature, and
first-settle) cut it to 7 clears / 677 rasterizations and measured, over 3
runs vs a 5-run baseline (medians): **p95 frame 17.16 -> 13.60 ms** (below
the 60hz ceiling), over-budget tasks **10 -> 7** with clean separation
(9,9,10,10,12 vs 7,7,7), miss density 5.13% -> 3.83%, script 83 -> 68 ms,
switch and resize unchanged.
**Why it did not land:** `core-terminal.spec.ts` goes **11/11 -> 9/11**,
reproducibly, on a quiet host, in the same serving mode — `:933` (an
externally exited PTY clears its tracked agent status) and `:977` (the
sidebar status dot mirrors agent.lifecycle). Both PASS in isolation with the
change applied, and pristine HEAD passes the full spec in the same mode, so
this is an order/state-dependent coupling, not flake or contention. The
coordinator half of the change is inert (it only threads the coalesced
request sources through to `refresh`); `xterm.refresh()` still runs first on
every settle, so the observable difference is the skipped atlas rebuild
itself. Unproven hypothesis for the successor: terminal agent-status
detection is coupled to the full re-render an atlas clear forces. If that is
real, the correct fix is decoupling status detection from repaint side
effects — after which M2 becomes bankable.

### Also true, deliberately not pursued
- Hidden terminals still repaint. Skipping them needs a "became visible"
  signal that does not exist: stashed slots keep their full rect under
  `contain:strict` (no ResizeObserver on return) and
  `requestTerminalFitOnPaneChange` fires only on pane-count/split-root
  change, not a tab swap. Emitting one is a cross-feature workbench contract
  change, too big to justify on measurement alone.
- `SETTLE_MS`/eager-rAF: verified the burst→one-settle design works as
  documented; `terminal_resize_ms` tracked compositing (M1), never
  scheduling, so the 80 ms debounce is not the resize cost.
- `cursorBlink: true` on three attached terminals — plausible additional GPU
  churn, unmeasured.

## Addendum 10: baseline on the CORRECTED instrument (two passes, ba4c74f)

Both readiness clauses that sampled an arbitrary first row are fixed
(9d16de0, ba4c74f), so these are the first numbers where flow completion
reflects rendering rather than whichever row happened to lead the list.
**These are not app improvements** — the app is unchanged from Addendum 8
apart from the one-pass mount, which measured NULL. The instrument got more
accurate; the numbers moved because they were wrong before.

| flow | completion (Add. 8 -> now) | p95 | worst | misses / samples | miss % |
|---|---|---:|---:|---|---:|
| launch-project | 2,399/2,418 -> **1,275 / 1,056** | 0.75 / 0.68 | 95 / 79 | 35/5,169 · 31/4,664 | 0.68 / 0.66 |
| session-switch | 831/760 -> **632 / 505** | 10.38 / 6.82 | 70 / 58 | 27/807 · 23/837 | 3.35 / 2.75 |
| live-terminal-switch | 181/218 -> **131 / 150** | 14.89 / 15.24 | 30 / 41 | 7/179 · 9/195 | 3.91 / 4.62 |
| large-diff-toggle | 477/524 -> **350 / 406** | 5.15 / 6.73 | 18 / 35 | 3/1,102 · 5/1,026 | 0.27 / 0.49 |
| workspace-switch | 444/415 -> **234 / 281** | 1.96 / 1.56 | 76 / 65 | 10/982 · 11/1,253 | 1.02 / 0.88 |

Every flow moved, not just launch-project: both patched clauses sit on
readiness paths that several flows wait through.

What survives from Addendum 8's conclusions, now on trustworthy data:
- **p95 is still inside the 16.67 ms budget in all five flows**, and inside
  8.33 ms in four (session-switch straddles: 6.82-10.38).
- **The failure is still tail-shaped**: 0.27-4.62% of intervals miss.
- **`live-terminal-switch` is still the highest-risk flow** — highest miss
  density (3.9-4.6%) and the p95 nearest the ceiling (14.9-15.2 ms). That
  conclusion has now held across two independent instrument states, which is
  the strongest evidence in this document for where to spend next.
- `large-diff-toggle` read 18.1 ms worst in pass 1 — a hair over the line and
  briefly the cheapest-looking green. Pass 2 read 35.0 ms. A single run is
  not a result; recorded here because the wrong read was tempting.

Method note for successors: read the RELATIVE STDDEV before the median.
Both defects corrected in this round were visible as variance anomalies in
data already collected (a "render" metric reproducing to 0.2% beside a boot
metric scattering 19%), and both were missed for exactly as long as nobody
looked at the spread.

## Addendum 11: memory bounds under mixed load — the inventory, and a dead cap

Audit of every per-N structure the renderer retains under the load that
matters: many sessions, several harnesses, multiple active workspaces,
terminals. Read from source; the measurement of the resulting ceiling is
tracked separately (harness at scratchpad/mem-mixed.mjs).

| dimension | bound | enforced? | notes |
|---|---|---|---|
| workbench tabs (surfaces) | 10, LRU | yes | `MAX_OPEN_SURFACES`; contents mounted in a pane are EXEMPT, so splits raise the effective floor |
| conversation chat clients | 32, LRU | yes | only UNMOUNTED entries evictable (`refs > 0` pins) |
| **per-session shell caches** | **40, LRU** | **NO -> now yes** | `SESSION_CACHE_LIMIT` + `pickSessionCacheEvictions` shipped in 2531335 with zero callers and no tests. Wired in 004375f |
| WebGL terminal renderers | 12 | yes | `MAX_WEBGL_RENDERERS`; beyond it terminals fall back to the DOM renderer |
| terminal scrollback | 5,000 lines PER terminal | per-instance only | no global budget across terminals |
| workspace connection runtimes | released on teardown | yes | bounded by ACTIVE workspaces |
| query cache (all keys) | `gcTime` 30 min | time only | no entry-count cap; every refetch resets the clock |
| workspace/directory-scoped caches | none by count | no | pruned only by explicit project removal (`project-actions.tsx:372-374`) |

### The structural problem the dead cap created

The two structures that ARE capped both spill into the uncapped one **by
design**. The workbench evicts a tab but its caches remain; the conversation
registry's own comment says eviction "loses no data: the message snapshot
persists in the query cache". So the caps relieved the cheap structures by
moving data into the one with no ceiling — and the ceiling that was supposed
to catch it never ran. Under mixed load every session touched left
status/requests/todo/diff behind, bounded only by a 30-minute clock that its
own refetches reset.

Wired at hydration (the moment a session's shell caches come alive), with
recency derived from the query cache's own `dataUpdatedAt` rather than a
parallel set — the cache already knows what it holds and when each entry was
written, so the ranking cannot drift from the thing it ranks. Exemptions:
OPEN sessions (a mounted tab must not lose what it renders from) and BUSY
sessions (a background turn is exactly what a recency-ranked eviction hits
first).

### Remaining gaps, in priority order

1. **Workspace/directory-scoped caches have no count bound.** Same shape as
   the session gap, one level up: bounded only by how many workspaces a user
   visits inside `gcTime`. No `WORKSPACE_CACHE_LIMIT` exists to wire.
2. **Terminal scrollback has no global budget.** 5,000 lines each is fine for
   one terminal and is ~12x that with the WebGL cap saturated; nothing caps
   the aggregate.
3. **Pane-mounted surfaces are exempt from the tab cap**, so a split
   workbench can hold more live surfaces than `MAX_OPEN_SURFACES` suggests.

### Method note

The dead cap was found by grepping for callers of an exported limit, not by
measurement — a policy can be perfectly written, tested-looking and entirely
inert. Worth repeating for the other limits in this table: `MAX_OPEN_SURFACES`
and `MAX_WEBGL_RENDERERS` were both verified to have live call sites.

---

## Addendum 12 — the count caps do not bound the load (2026-08-16)

Addendum 11 closed the "no count bound" gap on per-session caches. Measuring
what those counts actually admit showed the count was the wrong dimension.

### What one session weighs

Measured with the app's own `estimateConversationMemory` on representative
transcripts:

| transcript | per message | 20k messages |
| --- | ---: | ---: |
| plain text | ~677 B | 12.9 MB |
| tool calls | ~2.1 kB | 39.4 MB |

`SESSION_CACHE_LIMIT` retains 40 sessions, so forty heavy ones is ~1.6 GB
with every documented limit reading green: 3/40 sessions used, 32 conversation
clients free, 10 tabs free. The other two caps cannot cover it — both are also
counts, and evicting a `ChatClient` deliberately LEAVES its transcript in the
query cache, so the bytes outlive the structure that is capped.

`SESSION_CACHE_BYTE_BUDGET` (128 MiB of estimated payload) now runs alongside
the count ceiling. Eviction stays lossless: transcripts persist per session in
IndexedDB and rehydrate on reopen.

### Two ceilings need two passes

A single loop over `count > limit || bytes > budget` evicts coldest-first
regardless of weight, so one huge session sweeps away every cheap session the
user is cycling between while freeing nothing. A test caught it. The count
pass takes any cold session; the byte pass only considers sessions that
actually hold a transcript.

### The measurement nearly cost more than it saved

Sizing is a deep walk proportional to the bytes it counts, and the first
implementation ran it synchronously at hydration:

| cache state | cold pass | warm pass |
| --- | ---: | ---: |
| 2 sessions x 20k messages | 189 ms | 0.27 ms |
| 10 sessions x 20k messages | 868 ms | 0.56 ms |
| 40 sessions x 20k messages | 3325 ms | 0.25 ms |

Next to a ~257 ms session switch that is a far larger regression than the
51 ms Addendum 10's style fix bought. Two changes fixed it:

- **Memoize** on the snapshot array, keyed by identity AND the query's
  `dataUpdatedAt`. Neither alone is sufficient: `compactConversationSnapshot`
  returns the caller's array untouched when there is nothing to dedupe, so a
  transcript can grow behind a stable reference. 215x on the warm path.
- **Defer** the whole pass to `requestIdleCallback`. Hydration is the right
  trigger and the wrong place — nothing about reclaiming memory has to happen
  before the pane paints. This also makes the cost self-limiting: sessions
  enter the cache one hydration at a time and every hydration schedules a
  pass, so each pass finds at most one unmeasured transcript.

Sessions that cannot be evicted (OPEN or BUSY) are sized from their last
measurement — a streaming turn rewrites its transcript on every delta and
would otherwise miss the memo on every pass, paying a full re-walk to refine
a number that changes no decision.

### Verification

`session-switch` on the perf harness, HEAD vs `dd43725` (the commit before
the byte budget), one interleaved ABBA run each plus a repeat on HEAD:

| build | pooled p95 (ms) | worst task (ms) | completion (ms) |
| --- | ---: | ---: | ---: |
| dd43725 (pre-budget) | 5.35 | 47.28 | 418.20 |
| HEAD | 7.53 | 44.17 | 415.78 |
| HEAD (repeat) | 2.59 | 56.63 | 419.76 |

Completion is indistinguishable, and the baseline's p95 sits inside HEAD's
own 2.59–7.53 range — the memory ceiling costs nothing measurable on the
switch flow. The flow's 60Hz verdict stays red for the pre-existing
tail-shaped reason documented in Addendum 10; that is unchanged by this work.

Two runs per side at this machine's ~3x run-to-run variance is weak evidence
for a small regression and adequate for "no large one". A tighter bound would
need the interleaved-pair protocol used for the style fix.

### Correction to Addendum 11's gap list

Gap 1 ("workspace/directory-scoped caches have no count bound") is not a
memory growth source: `workspaceQueryOptions` and `shellDataKeys.workspaceForSession`
have zero callers in the tree, so that key family stores nothing. It is dead
code, not an unbounded cache. Gaps 2 (terminal scrollback) and 3 (pane-mounted
surfaces) stand.

---

## Addendum 13 — instrument build-out, and the experiments behind it (2026-08-17/18)

Addenda 1-12 recorded findings. This one also records EXPERIMENTS THAT WERE
ONLY EVER REPORTED IN CONVERSATION, which is how a measurement gets repeated
six months later by someone who has no way to know it was already run.

### The baseline comparison, and why the first run was thrown out

All five flows against their stored budgets (captured 2026-08-13, so a genuine
before/after). The first run said 4 of 5 breached. It was discarded:

  launch-project control 293.66ms  vs diagnostics-ENABLED 77.87ms

Enabled carries profiler overhead and is the slower side by construction, so a
4x inversion is not a property of the code. The container had just restarted;
re-running warm gave 80.52ms for the same control — a 3.6x swing on identical
code. The harness independently flagged 49 host-level rAF scheduling gaps it
excluded from the app gate.

Warm, only two flows breach:

| flow | budget | control worst, warm | verdict |
| --- | ---: | --- | --- |
| launch-project | 96ms | 80.5 | within |
| session-switch | 56ms | 56.1 / 56.7 / 54.4 | on the line |
| live-terminal-switch | 62ms | passes | within |
| large-diff-toggle | 138ms | 21.2 / 34.5 | well within |
| workspace-switch | 50ms | 62.7 / 72.4 / 79.3 / 69.6 | over, ~1.4x |

**A single cold run would have reported a four-flow regression that does not
exist.** Never gate on one run on a freshly booted container.

### workspace-switch: the breach predates the memory work

A/B against `dd43725` (the commit before the byte budget, deferral, terminal
and rail fixes) to test whether that work caused it:

  dd43725   control worst 67.03 / 70.06 ms
  HEAD      control worst 62.66 / 72.36 / 79.27 / 69.57 ms

Fully overlapping. The breach came from somewhere earlier in the effort and is
still unattributed.

### workspace-switch attribution — NULL result

The invalidation trace showed layout, not style, dominating (523 layout
invalidations vs 101 style; this is not another `:has()` case). Top sources by
sourcemap: `getMaxScrollOffset` in @tanstack/virtual-core 174,
`message-timeline.tsx:941` 123, `scroll-view.tsx:175` 77.

`updateTitleMetrics` re-read `head.clientWidth` inside a ResizeObserver
callback — forcing layout when the entry already carries `contentRect` — then
wrote a store value consumed only as an inline `animation` duration. Fixed.
That stack went 123 -> 0 invalidations, and **the flow total held at 523 -> 522
with worst frame unchanged**: 437 of those have reason "Added to layout", node
insertions that happen regardless, so the attribution simply moved to the next
frame on the stack (scroll-view's `scrollTop` read went 77 -> 199). The flow is
insertion bound, not read bound. The fix was kept as strictly less work, not
as a speedup.

### Core Web Vitals on a reference machine

The harness measured renderer scheduling only, on whatever hardware the
container happened to be. Added LCP/INP/CLS/FCP/TTFB using the platform's own
definitions, and `--profile` naming the machine. Reference: `laptop-broadband`
(4x CPU, 10/3 Mbps, 40ms) — an Electron workbench never runs on a phone, so
Lighthouse's mobile preset would model a user who does not exist.

First baseline:

| flow | LCP | INP | CLS | FCP |
| --- | ---: | ---: | ---: | ---: |
| launch-project | 6752 | n/a | 0.038 | 1320 |
| session-switch | 6188 | n/a | 0.031 | 1384 |
| live-terminal-switch | 2848 | 176 | 0.000 | 924 |
| large-diff-toggle | 5416 | 240 | 0.119 | 1260 |
| workspace-switch | 5824 | n/a | **0.377** | 1276 |

FCP is good everywhere and LCP poor everywhere: the shell paints in ~1.3s and
the largest content lands 4-5s later. workspace-switch's CLS of 0.377 is ~4x
the "poor" threshold — that flow visibly reflows under the user, and no
worst-frame number would ever have shown it.

Verified rather than assumed, since each could have made the feature fiction:
Playwright's `route.fulfill` does NOT defeat network emulation (FCP 296ms
unthrottled, 700 at 10Mbps, 3380 at 1.6Mbps, 3392 at 1.6Mbps with interception
active); the `latency` term never reaches the loopback document (TTFB 4-13ms
under every profile, so that column is an artifact); mocked API responses
cannot be throttled by CDP at all and get the profile's RTT added by hand.
INP reports `n/a` on flows driven by synthetic in-page clicks, which carry no
`interactionId` — reporting 0 there would read as instant.

### Memory lane: three instrument defects, two wrong theories

Built the missing lane. Everything it first reported was wrong, in instructive
ways:

1. `page.goto` between visits reloads the document and discards the heap.
   Retention read flat at 22MB with one mounted tab and no rendered session —
   a perfect plateau measuring nothing. Sweeps navigate via pushState.
2. `performance.memory` is quantised and cached by Chrome for privacy. A sweep
   whose DOM doubled and whose query cache went 125 -> 428 reported an
   identical 31.6MB at all eight samples. Heap now comes from CDP
   `Runtime.getHeapUsage`.
3. The "did this sweep accumulate" caveat compared `cachedSessions` first vs
   last — a deliberately BOUNDED counter that a working ceiling drives back
   down — and fired on a run that had grown 173 -> 388 queries. It judges peak
   query count now.

Wrong theory one: "1.1MB per visit, no plateau." Measured over 60 visits.
Over 200 the slope falls to ~200-237 kB/visit — sub-linear and decelerating,
so the caps do engage.

Wrong theory two: a synchronous count-only trim when the cache drifts past
twice its ceiling. Two sweeps each side:

  without   slope 201 / 237 kB per visit   plateau 94.8 / 97.8 MB
  with      slope 396 / 403 kB per visit   plateau 121.9 / 118.7 MB

Consistently worse AND peak cached sessions stayed at 200, so it did not even
reduce the overshoot it targeted. Reverted.

### The actual leak: detached DOM

Query families gained ~2 entries per visit while the heap gained ~200kB, which
never added up. Sampling what the page cannot see about itself:

  live nodes (CDP)   6431 -> 16986   +10555
  attached (page)    3821 ->  5530   +1709
  listeners           409 ->  4214   +3805

~8800 nodes removed from the document and still referenced. Invisible to
`document.getElementsByTagName`, which sees 3821 -> 5530 and calls it healthy.

This retires the structure the preceding work assumed. Every module cache
suspected is correctly bounded: `timelineCache` and `turnFoldCache` at 16, the
prompt-handoff index at 40, `SESSION_CACHE_LIMIT` at 40. The session-cache
ceiling work was not wrong; it was aimed at a structure that was not the
problem.

Heap-snapshot retainer analysis (`memory --snapshot`) attributes detached DOM
to bound functions and Solid reactive getters holding it in arrays and maps.
It does NOT name a source line: against the minified production bundle the
chain resolves to generic containers and mangled names (`s`, `ref`,
`get role`). Pinning it to a component needs a sweep against an unminified
build. Two bugs were found building it — `to_node` is an offset into the flat
nodes array, not an ordinal; and node index 0 is a real node, so a plain
retainer index made "retained by node 0" indistinguishable from "no retainer"
and broke every climb at its first step.

### Standardisation

Measurements now share one contract (`perf-record.ts`) so a REWRITE is
comparable: an experiment holds flow and profile fixed and varies `stack`
(`solid-1`, `solid-2`, `gpui`). Metrics are named for what the user
experiences, not the API reporting them — `largest_content_ms`, not `lcp_ms` —
because a native stack has no LCP. Absent is a first-class state that the
comparison refuses to score, so a port cannot win a metric it never measured.
Baselines are tracked in git at
`data/baselines/<profile>/<stack>/<lane>/<flow>.json`.

### Recording gap this addendum closes

Raw evidence in `perf-harness/reports/` is gitignored — sweeps, style dumps
and snapshots do not survive a container reset, and several results above
existed only in conversation until now. Tracked baselines carry the headline
numbers; the supporting traces do not survive. Worth deciding whether the
sweep JSON should join the baselines under version control.

---

## Addendum 14 — LCP and CLS were measuring the harness (2026-08-19)

Addendum 13 opened with LCP "poor everywhere" and workspace-switch's CLS at
0.377, ~4x the poor threshold, as the two highest-value open items. Both are
substantially instrument defects, and they are the SAME defect one metric
apart — the one Addendum 13 already identified for INP and did not carry
across.

### The mechanism

The platform stops revising LCP at the first **trusted** input, and excuses a
layout shift from CLS when trusted input landed in the previous 500ms. Neither
rule fires for synthetic in-page `element.click()`, because untrusted events
carry no `interactionId` and do not count as user input.

`browser-records.ts` already said so, about INP:

> INP needs a trusted interaction. A flow driven by synthetic in-page clicks
> produces none, and reporting 0 there would read as instant.

The same sentence is true of LCP and of CLS, and neither was guarded. So:

- **LCP never finalised** on a synthetically driven flow. It kept accepting
  candidates until the flow ended, and settled on whatever the flow itself had
  painted — routinely a chat transcript message — reported under a metric
  whose 2500/4000 ms bands mean "when the page finished loading".
- **CLS charged each flow** for the rearrangement its own click asked for. A
  real user clicking "switch workspace" gets those 500ms excused; the harness
  did not.

### Evidence

`bun src/cli.ts run --all --profile laptop-broadband --no-trend`, two full
passes, on darwin-arm64 (Apple M4 Pro, 12 cores, 24 GB), macOS 26.2. **These
absolute timings are NOT comparable to Addenda 10-13**, which ran on the Linux
container; that is the point of the host field added below. What IS comparable
across machines is the categorical result — whether LCP froze, and how much of
CLS survives the excusal rule.

| flow | trusted input | LCP revisions | LCP froze | last LCP element |
| --- | --- | ---: | --- | --- |
| launch-project | none | 4 | never | `user-message-text "user message 1998…"` |
| session-switch | none | 5 | never | `p "sample output sample output…"` |
| live-terminal-switch | 2009ms | 1 | 1364ms | `session-navigation-title "…session 1"` |
| large-diff-toggle | 2296ms | 4 | 1892ms | `user-message-text "user message 498…"` |
| workspace-switch | none | 4 | never | `user-message-text "user message 998…"` |

The one flow that delivers real input early has **one** LCP candidate and
freezes on a navigation title — a genuine load measurement. The three flows
with no trusted input accumulate four or five candidates and land on transcript
content that only exists because the flow scrolled a session into view. Run 2
reproduced the froze/never-froze split and every element identity exactly.

CLS, same runs, rescored with the platform's 500ms rule applied to each flow's
synthetic clicks:

| flow | CLS observed | CLS under real input | excused | shifts |
| --- | ---: | ---: | ---: | ---: |
| launch-project | 0.017 / 0.020 | 0.017 / 0.020 | 0% / 0% | 4 / 5 |
| session-switch | 0.012 / 0.030 | 0.010 / 0.010 | 21% / 67% | 3 / 5 |
| live-terminal-switch | 0.000 / 0.000 | 0.000 / 0.000 | 0% / 0% | 1 / 1 |
| large-diff-toggle | 0.188 / 0.195 | 0.010 / 0.010 | **95% / 95%** | 16 / 17 |
| workspace-switch | 0.319 / 0.315 | 0.013 / 0.014 | **96% / 96%** | 34 / 30 |

Both passes shown (run 1 / run 2). The two large excusals reproduce to the
percentage point. `session-switch` swings 21% -> 67% on a CLS of 0.012-0.030,
which is three to five shifts of a few thousandths each — too small to read as
anything, and recorded rather than smoothed.

### Auditing the excusal, rather than trusting it

A 96% correction is exactly the size of claim that should not be believed
because a function returned it. The raw shifts and synthetic input times are
now kept in the run's vitals so the rule can be checked by hand. A third
workspace-switch pass, CLS 0.3255 observed against 0.0125 under real input,
23 shifts, synthetic clicks at 2101 ms and 2532 ms:

| shift (ms) | value | after synthetic click |
| ---: | ---: | --- |
| 2020 | 0.0049 | — (before any input) — kept |
| 2052 | 0.0025 | — (before any input) — kept |
| 2542 | 0.0410 | 10 ms — excused |
| 2600 | 0.0887 | 69 ms — excused |
| 2602 | 0.0878 | 70 ms — excused |
| 2613 | 0.0826 | 82 ms — excused |
| …17 more | ≤0.0006 each | 84-348 ms — excused |

Four shifts inside 82 ms of one click carry 0.300 of the 0.3255. That is the
workspace repainting in direct response to the click that asked for it — the
textbook case the `hadRecentInput` rule exists to exclude — and the only shift
that survives the rule is 0.0074 spread over the two that preceded any input at
all.

workspace-switch reproduced at 0.319 here against 0.377 on the container, so
the observed score is machine-robust and the excusal is a property of how the
flow drives input, not of the hardware. **Item 2 of the open list — "that flow
visibly reflows" — does not survive.** Under real input it scores 0.013, well
inside "good". The content does move, but it moves because the user asked it
to, which is the exact case the metric is defined to exclude.

### What this does and does not retire

Retired: the "LCP poor on every flow" finding for launch-project,
session-switch and workspace-switch, and the workspace-switch CLS breach.
Those numbers were not measuring the app.

**Not retired**: `large-diff-toggle` read 5640 ms on the container and DOES
freeze its LCP properly, so that one is a real load measurement and a real
"poor". It is now the only LCP result on the board worth chasing. Whether the
container's other numbers hide a genuine problem underneath the artifact can
only be answered by re-running there with this instrument.

### Changes

- `largest_content_ms` records the FROZEN LCP, and is absent with a reason
  where LCP never finalised — the same treatment `interaction_latency_ms`
  already had. Absent is a state the comparison refuses to score, which is
  correct: there is no load measurement to report, and inventing one is what
  produced the original finding.
- `visual_stability` records the excused CLS. The contract defines the metric
  as movement "without them causing it", and a synthetic click stands in for a
  real one everywhere else in the flow.
- Vitals scoring moved out of `page.evaluate` into pure exported functions, so
  the CLS session-window rule has ONE implementation and a test can call it.
  Positive control for the refactor: the recomputed observed CLS reproduces the
  previous inline accumulator's value (0.319 both ways on workspace-switch).
- The shift buffer is capped at 2000 and truncation is recorded, never silent.
  An under-reported CLS reads as stability the flow does not have.

### The run log could not tell two machines apart

`run-log.ts` promised in its own doc comment that every line carries "the
reference machine", and `run-log.test.ts` asserted it under the name
`machine` — but the field it recorded was `profile`, which is EMULATION: a 4x
CPU multiplier applied to whatever silicon is underneath. Eleven runs from this
laptop landed in the tracked log labelled `laptop-broadband`, indistinguishable
from the container's, reporting "improved" on every metric purely because an
M4 Pro is faster than the container. Those lines were removed rather than
committed. The log now records a coarse host fingerprint (platform, CPU model,
core count, memory) alongside the profile.

This is the failure mode Addendum 13 warned about — "never gate on one run on a
freshly booted container" — with the machine varying instead of the warmth, and
the log had no field that could have caught it.

### Method note

Both defects were found by asking what the metric's DEFINITION requires and
comparing it to what the code collects, not by measuring harder. The numbers
had been stable and reproducible across machines for weeks; reproducibility was
never the problem. A metric can be perfectly repeatable and still measure the
instrument.

### Pre-existing, found in passing: the agent-app lane was never committed

**Sixteen** modules the perf-harness imports were never committed on any
branch. They are not gitignored, simply absent, so `bun run typecheck` reported
23 errors and `bun test` 2 failures, both pre-existing.

I first wrote this up as dead code and recommended deleting it. **That was
wrong**, and the correction is the more useful finding.

`e8fc016c3` (2026-08-13) committed four source files and three tests of the
lane and none of the modules they import. Its own message discusses
`idle-process-family.ts` as "byte-identical" — which is what a partial
`git add` looks like from the inside: the author was describing a file that
existed only in their working tree. The lane's entry points
(`benchmark:agent-app`, `agent-driver`, `check:agent-experiment`) were missing
from `package.json` too, which is the only reason it looked unreachable from
`cli.ts`.

It is load-bearing. HANDOFF.md counts 452 run directories under
`artifacts/agent-app-benchmark/`; u11-qualification-status.md cites
`agent-app-benchmark.ts` by line number in five places; claxedo-desktop's
`startup-clock-probe.ts` names it as the consumer contract. This is the macOS
gate suite that HANDOFF §12.4 says the Linux container cannot run — which is
exactly how it came to be developed on a Mac and only half committed.

Recovered from untracked files in the sibling worktree for
`integrate/claxedo-memory-buckets`; four also survived in `stash@{1}^3`.
**Nothing was in this repository's object store, reachable or not.** A
`git clean` in that worktree would have destroyed roughly 4,700 lines of source
and tests permanently.

  bun run typecheck   23 errors -> 0
  bun test            63 pass / 2 fail -> 121 pass / 1 fail

Two decisions are left for the owner. `agent-terminal-scenario` pins exact byte
counts and SHA-256 digests against a 5.6 MB generated corpus under the
gitignored `.artifacts/`, so it can only pass where that corpus was
materialised. And `perf-harness` sits below the `packages/*` workspace glob, so
it resolves neither `catalog:` nor `workspace:*`; `@opencode-ai/core` is left
undeclared and resolves by walking up to the root `node_modules`, which works
in-repo and would not survive a standalone checkout.

#### Method note

The claim that killed the first, wrong conclusion was cheap and I skipped it:
grep the whole repository for the thing before calling it unused. `cli.ts` and
`runner.ts` were the only files I checked. One `grep -rn agent-app-benchmark`
across the tree returns HANDOFF.md's 452 run directories on the first page.
"Not reachable from the entry point I looked at" is not "dead" — and the cost
of the difference here was a recommendation to delete unrecoverable work.
