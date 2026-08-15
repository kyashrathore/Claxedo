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
flows. Debug sub-metrics at 6cd6a05 pin the launch delta entirely to
`transcript_render_ms` (2,411 ms of the 2,429 completion;
`launch_first_window_ms` 302, `launch_workspace_ready_ms` 412) — the shell
did not get slower; the transcript now actually renders. Founding-baseline
comparisons that remain honest: session-switch is still ~1.6x faster than
a0d9bde WITH full rendering; large-diff worst task still ~2x better.
Rows marked * carry the Addendum 6 seeded-content caveat.

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
