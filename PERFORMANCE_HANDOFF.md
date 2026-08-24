---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-24T07:16:26Z"
updated_at: "2026-08-24T09:30:00Z"
title: "Claxedo performance architecture and release handoff"
summary: "Continuation state for cold-session, memory, Workspace disposal/reopen, Crabbox/AWS validation, merge, and push work."
keywords: ["claxedo", "performance", "cold-session", "workspace-reopen", "crabbox", "aws-windows", "merge-dev"]
cwd: "/Users/yashvardhansingh/test/opencode"
resume_focus: "Disposal steps 1-6 plus the step-7 windowed Review file list are implemented on claude/zen-faraday-v692mo; next: validate the windowed smoke, run the five-iteration disposal benchmark vs a03985db9 on an idle machine, then Crabbox/AWS validation and the dev merge."
repository: "kyashrathore/Claxedo"
repo_root_sha: "728cedf2a29e2f9da901c8c36620ce5efc09e6b2"
branch: "chore/crabbox-ci-matrix"
head: "ec7ee91ddfeebd2001b76f94d2f42c8643bf5370"
worktree_path: "/Users/yashvardhansingh/test/opencode"
---

# Performance and merge handoff

This captures the implementation and benchmark state before the remaining Workspace wiring and full validation. It is status, not authorization to merge or push before the gates pass.

## User requirements

- Benchmark and run causal experiments before broad tests.
- Use real load for product claims; report per-click CPU, JS, style, and layout.
- Keep cold session switches below 50 ms.
- Eliminate unnecessary global Solid reactivity and request waterfalls.
- Closed Workspace must own zero DOM/CPU after exit motion; only the active inner tab may be mounted.
- Same-workspace sessions should retain shared session/event/process/terminal providers.
- Substantial Workspace reopen must not regress: 500 Review files, one large expanded diff, three large open files, and semantic Review scroll.
- No shimmer/loader during the first 50 ms.
- Next profile context card, history minimap/direct jump, and the large composer.
- Run CI/E2E in parallel on Crabbox and native Windows on AWS.
- Commit slices, merge into dev, and push only after all acceptance gates.

## Bases and branch state

Three bases matter:

1. Local Git base: local dev and this branch merge at 94c110381a7ec6896a5fff2284d4949b0bd0284c. There are 36 implementation commits plus the initial handoff commit above it through ec7ee91dd.
2. Remote integration base: captured origin/dev is cf6bea4a8628532729028ec15651f6f2f5cf38c1. It merges with this branch at c97fe215f24112202e1378795f1962485a22d2ce. This branch is 108 ahead/55 behind origin/dev. Local dev is 73 ahead/55 behind its remote. Do not push local dev directly.
3. Retained Workspace benchmark base: exact commit a03985db951d33fcbd379cf6d11aecd5bb2ad5b3, tree 39bdbf87d8d17d55086d32754f0294cd9088c3d3. It is the last build before Workspace disposal.

Captured implementation HEAD: ec7ee91ddfeebd2001b76f94d2f42c8643bf5370. The feature branch tracks origin/chore/crabbox-ci-matrix and was pushed successfully after its pre-push hook passed in a clean detached worktree. Dev was not changed or pushed.

## Completed work and measured gains

### Cold session

The authoritative producer now returns the latest complete user turn; older history pages from the correct cursor. Pointer/focus intent starts only the canonical transcript request and does not mount a hidden timeline.

Experiment ledger: .context/compound-engineering/ce-optimize/cold-session-load/experiment-log.yaml.

Accepted exact-package result:

- 40/40 independent cold clicks below 50 ms;
- maxima 41.3 and 47.7 ms; combined mean 34.0125 ms;
- eventual history 5,765/5,765 parts;
- app.asar SHA-256 287c0c693ab4995adf2e63088f644a18a01b502aec6724712162f8e9c8dc2dd1.

The branch also stops background inline-code discovery, cancels rail status work on foreground activation, and shares canonical file-status data.

### Memory

Matched renderer experiment baseline 10a5907a8 versus candidate e353ef7ab: 60 clicks and five fresh Chromium repetitions each. Machine-local evidence: /tmp/claxedo-memory-matched.hp0Qk0.

- heap slope 978.841 -> 251.270 KiB/visit, -74.33%;
- settled heap 81.226 -> 49.673 MiB, -38.846%;
- detached nodes 12,828 -> 3,915, -69.481%;
- live DOM 23,733 -> 10,605, -55.315%;
- listeners +11,776 -> +3,958, -66.389%;
- both retained 40 cached sessions; all ten Chromium PIDs exited normally.

### Heavy Workspace contract

Scenarios:

- heavy-workspace-close;
- heavy-workspace-reopen;
- heavy-workspace-review-resume.

Public UI controls build 500 Review rows, one expanded 480-line/>10 KB diff, three 320-line/>10 KB file tabs, three terminal identities, exact tabs/active file, and semantic anchor src/generated/file-350.ts. A 300 ms close dwell crosses the 120 ms motion + 20 ms grace.

The harness records completion, JS/style/layout, exact renderer tasks/intervals, requests, blank/loading/stable frames, and DOM ownership. Candidate env CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL=1 requires zero closed panel ownership, one active file root, and zero inactive Review/file roots.

Decision gate: packages/claxedo-app/perf-harness/src/heavy-workspace-noninferiority.ts.
CLI: packages/claxedo-app/perf-harness/src/compare-heavy-workspace.ts.

### Review restoration

Tab insertion could clamp a visible Review scroller to zero without an event. review-scroll-restoration.ts now rejects an unobserved clamp; a genuine user scroll-to-top remains authoritative. createReviewTabActivation enforces capture before tab insertion/activation.

Exact retained smoke at a03985db9 passes all correctness/readiness:

- file-350, offset 0;
- restored scroll 11,200 px;
- stable-ready 2/2;
- exit 0, WARN only for known absolute responsiveness debt.

Machine-local prior artifact:
- /tmp/claxedo-heavy-workspace-e353ef7ab.y6PebE/artifacts/3cb228ecd-causal-unthrottled/heavy-workspace-3cb228ecd-causal-unthrottled-artifacts.tar.gz
- SHA-256 66e9dfafb701382f8d964ea764ec294b83f679cfb00f9c22a9179762181beaa8

### Disposal and warm-remount foundations

- ae3086a88: Workspace opens/mounts synchronously; close retains nodes through 140 ms; rapid reopen cancels disposal; RailWorkbenchShell then unmounts the whole panel.
- 651e3725a: TabFile uses the canonical runtime request cache; watcher events force invalidation; tested remount reads once.
- 693c92588: 32-entry non-reactive provider-instance Review working-set LRU with clone isolation. Snapshot currently holds tab DTOs/order, active tab, and semantic scroll. ReviewWorkspace restores these and stays within its 800-line limit.
- ec7ee91dd: Removed the consumer-less type-only props module, returned ReviewWorkspaceProps to its owning component, and extracted the live process-tab section so ReviewWorkspace remains 755 lines without an import-graph exemption.

These are foundations only: the store is not wired through WorkspacePanelBody, and Review mode/refs/diff style/open diffs/forced paths are not externalized.

## Retained benchmark complete

Crabbox lease tidal-prawn is exact-clean a03985db9. The one-iteration smoke and all three five-iteration arms ran sequentially, exited 0, and reported no correctness or validation failures. WARN status is only the absolute 60 Hz renderer-task debt. Provenance-after remained clean.

Five-iteration retained headlines:

- Close enabled/control completion means 189.74/188.58 ms; enabled/control p95 task intervals 4.16/4.73 ms; worst 63.35/62.35 ms.
- Reopen enabled/control completion means 168.54/160.11 ms; p95 task intervals 41.88/41.11 ms; worst 143.03/127.63 ms.
- Review resume enabled/control completion means 591.86/577.79 ms; p95 task intervals 285.24/282.83 ms; worst 331.84/306.60 ms.
- Review-resume causal p50/p95: completion 586/632.90 ms; script 25.54/32.12; style 417.30/457.94; layout 35.67/40.09; task 585.93/632.82.
- Every sample restored four tabs, two stable frames, zero blank/loading frames, three file roots, all 500 Review files, one expanded diff body, exact scroll 11,200, and zero resource requests.
- Retained ownership intentionally includes one inactive Review root/500 files after reopen and three inactive file roots during Review resume. The disposal candidate must remove these while preserving restoration.

Downloaded, gzip/tar-verified evidence:

- /tmp/claxedo-heavy-workspace-e353ef7ab.y6PebE/artifacts/a03985db9/heavy-workspace-a03985db9-smoke-artifacts.tar.gz — SHA-256 8b7c814da31155ec4d5c4c71167e268f185a0730db71ff69b2d70970cc6cf7e7.
- /tmp/claxedo-heavy-workspace-e353ef7ab.y6PebE/artifacts/a03985db9/heavy-workspace-a03985db9-retained-5x-artifacts.tar.gz — SHA-256 70fafb1406c5e42783b95bda5c0eba9aff3b7a4147f05fc827378031657c3f38.

Remote roots remain /tmp/heavy-workspace-a03985db9-causal-unthrottled/ and /tmp/heavy-workspace-a03985db9-retained-baseline/. The Crabbox lease is held idle; preserve or upload evidence before releasing it. Do not parallelize candidate benchmark arms.

## Absolute debt versus architecture verdict

Noninferiority must not be described as “fast.”

Retained Review-resume has real long tasks in the completed five-iteration baseline:

- control p95 282.83 ms, worst 306.60 ms, 30/142 >16.67 ms;
- enabled p95 285.24 ms, worst 331.84 ms, 30/135 >16.67 ms;
- causal p95 attribution: completion 632.90 ms, style 457.94 ms, script 32.12 ms, layout 40.09 ms.

These are exact CrRendererMain RunTask intervals, not cumulative clicks. Keep two verdicts:

1. Architecture noninferiority: did unmount remove hidden ownership and avoid worsening reopen versus a03985db9?
2. Absolute responsiveness: does Review meet the 16.67 ms task floor and future <50 ms target? It does not.

Ignore the auto-generated 397 ms stored budget as a product target; it is 150% of an early measurement.

## Continuation 2026-08-24 (branch claude/zen-faraday-v692mo)

Steps 1-6 below are implemented, on `claude/zen-faraday-v692mo` (based on
`fcce68e`, one commit past the captured HEAD ec7ee91dd). All work is committed
and pushed there; nothing was merged and dev was not touched.

### What landed

1. Working-set store (step 1): `createReviewWorkspaceWorkingSetStore` now lives
   on the workspace-panel slice (provider-owned, next to the per-session panel
   snapshots). `reviewWorkspaceWorkingSetKey` keys by normalized server URL +
   runtime workspaceId + workspaceDir + review target, never session id.
   `WorkspacePanelBody` wires `initialWorkingSet`/`onWorkingSetChange`.
2. Review surface externalized (step 2): `ReviewSurfaceState`
   (`features/review/review-surface-state.ts`) carries mode, from/to refs, diff
   style, open diffs, focused file, forced-large-diff paths, and
   `renderedFileLimit` (see below). ReviewTab seeds from `retained` and
   publishes through `onRetainedChange`; ClaxedoSessionReview's forced set is
   now controllable like `open`. `restoredOpenDiffs` intersects retained
   expansions with the reloaded changeset.
3. Active-tab-only mounting (step 3): `retainMountedTabsPolicy` is removed;
   `reviewWorkspaceMountedTabs` mounts only the active inner tab (plus a
   prepared-activation tab for one frame). The Review body unmounts while a
   file tab is active. The harness inactive-Review check now counts the new
   `workspace-review-body` marker instead of `review-pane-root` (which hosts
   the tab header and can never reach zero).
4. Invalidation outside review DOM (step 4): `reviewVcsInvalidationFromEvent`
   (pure classifier) + `createReviewWorkspaceVcsStaleness` on ReviewWorkspace
   hold the one runtime subscription for the panel's lifetime; it drops the
   directory's entries from the module-scoped review query cache
   (`invalidateReviewVcsDirectory`) and bumps stale versions a mounted
   ReviewTab reloads on.
5. Integration tests (step 5): `workspace-panel-disposal.vitest.tsx` drives the
   real AppShellLayout through close-past-grace/reopen (working set restored,
   genuinely new mount), rapid reopen inside the grace (same mount), and
   WorkGraph portal slot cleanup/recreation without duplicates.
6. Disposal smoke (step 6, in-container only): one-iteration
   `heavy-workspace-close` with `CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL=1`
   passes every validation gate: all `workspace_closed_*_after_dwell` = 0,
   reopen inactive Review roots/files = 0 with exactly 1 file root, resume
   inactive file roots = 0, all 500 Review files, expanded body, semantic
   anchor and scroll restored. Two resume fixes were required and landed:
   - Progressive admission (8 rows, then 2 per idle callback) could never
     rebuild a 500-row corpus or reach the deep anchor inside the resume
     budget. The interim fix retained the admitted-row count
     (`renderedFileLimit`); it is SUPERSEDED by the step-7 windowing below,
     which removed that field again.
   - ReviewTab seeds `remoteDiffs` synchronously from the shared cache
     (`peekReviewVcsDiff`), so a resumed Review paints in the mount pass
     instead of blanking until the deferred load runs.
   The scroll diagnostic is additionally exposed on `review-pane-root`
   (`bindDiagnosticHost`) because the scroll element no longer exists while a
   file tab is active; `readHeavyWorkspaceScrollDiagnostic` falls back to it.

   Final in-container smoke (one ABBA iteration, functional evidence only —
   this shared container fails the base-app 60 Hz gate by itself): exit 0,
   status WARN (absolute responsiveness debt only), zero validation failures.
   Close completion mean 154.6 ms with zero requests; reopen 473.5 ms, zero
   blank/loading frames, 1 request (the SessionPaneScope refetch below);
   Review resume 2784.7 ms, zero blank/loading frames, zero requests, 500/500
   files, anchor and scroll restored. The resume completion is dominated by
   rebuilding 500 header rows in the mount pass — the cost step 7's
   virtualization exists to remove — and is not comparable to the retained
   591 ms from the idle Crabbox machine.

### Step 7: windowed Review file list

The 500-row header list was the remaining corpus-proportional cost: every
admitted file was a live accordion row (the retained baseline's 222-313 ms
tasks and 417-458 ms style work), re-paid on every resume once disposal
landed. Diff content was already lazy -- bodies mount per expanded row and
@pierre/diffs windows the visible lines -- but the header rows were not.

`features/review/ui/review-window.ts` now materializes at most
`REVIEW_MAX_WINDOW_ROWS` (20) viewport rows plus required rows (the semantic
scroll anchor, the focused file), with height-preserving gap divs keeping
scroll geometry honest; measured row heights refine the estimates as rows
visit the window. Scroll restoration parks on the recorded pixel top while
waiting for its anchor (that scroll is what mounts the anchor's
neighborhood), and the anchor path is threaded to the window as a required
row so the precise offset correction lands immediately. `renderedFileLimit`
and the progressive/idle admission are removed with their tests
(effectStateWrites baseline 100 -> 98).

The harness contract changed in the same slice, because it literally
demanded 500 mounted rows: `heavyWorkspaceWindowedCorpusFailures` pins
model = 500 with 0 < rows <= 24; the corpus waiter and setup gates match;
expansion evidence is read before the deep scroll (the expanded row leaves
the DOM once the window moves away); the deep scroll hops toward the target
from the nearest materialized row (a plain proportional jump lands a window
short when an expanded row above distorts the estimate) and then aligns; and
hunk counters compare only when an expanded body is inside the restored
window.

Verified: review-window unit tests 6/6; workbench+review bun suites 531
pass; review + disposal + restoration vitest 13/13; test:performance 37/37;
architecture 261/261; heavy-workspace contract tests 8/8; app typecheck
pass.

Windowed smoke (one ABBA iteration, same shared container as the earlier
smokes, functional evidence only): exit 0, status WARN, zero validation
failures. Close 174.6 ms; reopen 698.8 ms (this container fluctuates;
pre-windowing runs measured 444-487 ms on the same phase); Review resume
990.5 ms with exactly 20 materialized rows, zero blank/loading frames, zero
requests, anchor and scroll restored -- versus 2,784.7 ms for the same phase
when resume rebuilt all 500 rows. All closed/inactive ownership gates remain
0 with exactly 1 reopen file root. The idle-machine five-iteration ABBA
comparison against a03985db9 remains the acceptance gate for any timing
claim.

### Known deltas and gaps (in noninferiority terms)

- Reopen makes 1 resource request the retained baseline did not: the panel
  body's `SessionPaneScope` re-activation refetches session
  status/permission/question. Fix belongs to the shared same-workspace
  providers work (step 8), not to review.
- While the panel is fully closed, the workspace runtime event stream and the
  staleness watcher are gone, so a change landing then is not observed and a
  reopen can serve the stale cache. This is not a regression (a remount always
  read the infinite-stale cache), but the durable fix is registering review
  invalidation with the app-level `ClaxedoEventsProvider` ingress, which
  survives the panel.
- In-container numbers are functional evidence only; the container is shared
  and fails the base-app 60Hz gate on its own. The five-iteration ABBA
  comparison against a03985db9 must run on an idle machine per the commands
  below.

### Environment note

This container's Playwright pin (1.61.1) expects Chromium revision 1228 while
/opt/pw-browsers ships 1194; the smoke ran with a filesystem shim mapping the
1228 layout onto the 1194 binaries. Recreate it or run on a machine with the
right revision before trusting timings.

## Next steps in dependency order

1. Instantiate the working-set store outside disposable DOM. Key by normalized server/runtime identity + workspace + review, not session ID. Wire initialWorkingSet/onWorkingSetChange through RailWorkspacePanelShell and WorkspacePanelBody. Do not put scroll into global reactive WorkspacePanelState.
2. Externalize Review mode/from/to refs, diff style, open diffs, focused file if needed, and forced-large-diff paths. Never snapshot VCS/file payloads, loaders, hunks, mounted IDs, timers, or DOM.
3. Remove retainMountedTabsPolicy for Workspace tabs after restoration is authoritative; mount only the active tab.
4. Keep shared workspace event/watcher invalidation alive outside panel DOM. File cache last-ref release clears queries, and Review VCS watchers currently live in Review UI.
5. Add integration tests for disposal after 140 ms, rapid-reopen identity, post-disposal reconstruction, and WorkGraph portal cleanup/recreation without duplicate slots.
6. Run disposal benchmark with CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL=1 and compare to a03985db9.
7. Make 500-row Review incremental/virtualized to remove 222–313 ms tasks and 423–448 ms style work.
8. Continue context card, minimap direct jump, composer splitting, early shell render, shared same-workspace providers, and no loader in first 50 ms.
9. Run complete Crabbox/AWS validation only after experiments stabilize.
10. Fetch current origin/dev, merge in a clean integration worktree, rerun acceptance, then push.

## Exact benchmark commands

Run from packages/claxedo-app/perf-harness on one idle machine. Five iterations means five ABBA iterations: ten control and ten diagnostics-enabled observations.

### Retained base a03985db9

~~~sh
cd packages/claxedo-app/perf-harness
for scenario in heavy-workspace-close heavy-workspace-reopen heavy-workspace-review-resume; do
  CLAXEDO_PERF_CAUSAL=1 CLAXEDO_PERF_REQUEST_LOG="/tmp/heavy-workspace-a03985db9-retained-baseline/$scenario-requests.jsonl" bun src/cli.ts run --scenario "$scenario" --iterations 5 --profile unthrottled --stack solid-1 --no-trend --debug --output "/tmp/retained-$scenario.json" || exit
done
~~~

Do not add CPU-profile, broad-trace, style-dump, or video flags.

### Disposal candidate

~~~sh
cd packages/claxedo-app/perf-harness
for scenario in heavy-workspace-close heavy-workspace-reopen heavy-workspace-review-resume; do
  CLAXEDO_PERF_CAUSAL=1 CLAXEDO_PERF_REQUIRE_WORKSPACE_DISPOSAL=1 CLAXEDO_PERF_REQUEST_LOG="/tmp/heavy-workspace-disposal/$scenario-requests.jsonl" bun src/cli.ts run --scenario "$scenario" --iterations 5 --profile unthrottled --stack solid-1 --no-trend --debug --output "/tmp/disposal-$scenario.json" || exit
done
~~~

### Compare

~~~sh
cd packages/claxedo-app/perf-harness
for scenario in heavy-workspace-close heavy-workspace-reopen heavy-workspace-review-resume; do
  bun src/compare-heavy-workspace.ts "/tmp/retained-$scenario.json" "/tmp/disposal-$scenario.json" > "/tmp/noninferiority-$scenario.json" || exit
done
~~~

Persist accepted results into the experiment ledger before making final claims.

## Verification already run

- Review scroll Vitest 4/4.
- Review activation Bun 3/3.
- Working-set + activation Bun 8/8, 21 assertions.
- TabFile Vitest 6/6; expected jsdom SVG URL warning only.
- Workspace motion 6/6, 39 assertions.
- Heavy contract + comparator 8/8, 36 assertions.
- Perf harness whole source suite before latest slices: 174 pass, 1 skip.
- App typecheck after latest slices: pass.
- Layout architecture 4/4; exact workspace chrome audit 1/1.
- Full route-audit currently has unrelated failures from concurrent uncommitted session/runtime changes.
- Clean detached pre-push validation at ec7ee91dd: `bun turbo typecheck` passed 37/37 tasks; app architecture 261/261; focused performance Bun 19/19; performance Vitest 37/37.

## Shared dirty worktree warning

Performance work through 693c92588 is committed. Other concurrent work remains dirty. Do not stage, revert, stash, or overwrite:

- .agents/skills/crabbox/SKILL.md and .crabbox.yaml;
- agent-sdk-runtime Codex idle-reaping/workspace-behavior tests;
- claxedo-app rail session-status/sidebar files and agent-status-listener files;
- session-controller.ts, message-timeline files, session-identity files, session-screen.tsx;
- claxedo-server authority hosted-session-pull/http session-pull/projection files;
- script/cbx-ci-macos.sh and script/cbx-ci-remote.sh;
- untracked docs/solutions/.

Always use exact-path git add and rerun git status.

## Crabbox and AWS Windows

Current runbook: .agents/skills/crabbox/SKILL.md.

~~~sh
./script/cbx doctor
./script/cbx-ci.ts list
./script/cbx-ci.ts dry-run pr-linux
./script/cbx-ci.ts dry-run pr-native
./script/cbx-ci.ts run pr-linux
./script/cbx-ci.ts run pr-unit-windows
./script/cbx-ci.ts run pr-agent-runtime-stats-windows
~~~

Use ./script/cbx-ci.ts retry for failed lanes. Focused Windows jobs are diagnostic only and must be followed by the blocking full Windows lane. Use ./script/cbx-ci.ts run pr only when native providers are ready. Do not stop tidal-prawn until artifacts are preserved.

## Push and merge

The feature upstream exists and currently contains ec7ee91dd. Push later continuation commits with:

~~~sh
git push -u origin chore/crabbox-ci-matrix
~~~

Local dev is divergent and this worktree is dirty. Integrate from freshly fetched origin/dev in a clean worktree:

~~~sh
git fetch origin
git worktree add ../opencode-perf-dev-integration -b codex/perf-dev-integration origin/dev
git -C ../opencode-perf-dev-integration merge --no-ff origin/chore/crabbox-ci-matrix
~~~

Resolve canonical-producer conflicts, rerun all acceptance on the merge commit, and only with explicit authorization and green evidence:

~~~sh
git -C ../opencode-perf-dev-integration push origin HEAD:dev
~~~

Never force-push dev or reset this shared worktree.

## All 37 commits through captured implementation HEAD over local dev

~~~text
77fb92d14 perf(harness): attribute cold session CPU costs
ad707c196 perf: make cold session loading deterministic
60cbc3cc5 test(windows): scope compatibility ownership scan
855f6993c test(architecture): account for local app closure
0223de1e4 test(desktop): account for renderer closure
db5925585 fix(app): preserve initial draft session surface
10a5907a8 perf(app): cancel stale subagent hydration
a682f8ad2 fix(app): preserve routed and rich session surfaces
95d90b689 perf(app): bound rail metadata ownership
a25bd4b5d perf(app): scope and bound session query state
0e0173cf8 test(perf): make memory evidence publishable
28b9bfb5f test(ci): harden remote e2e lanes
e353ef7ab test(perf): benchmark heavy workspace reopen
6270c1834 test(perf): own Chromium memory teardown
25464ed18 test(perf): separate workspace reopen and review resume
04c8aa163 fix(app): preserve workspace context on reopen
a30546ff3 test(perf): gate heavy workspace resume
7cd8751c2 test(perf): target review scroll viewport
4a94542ca fix(app): preserve review scroll across workspace tabs
58262dc84 test(perf): render substantial review diff on reopen
eab8fe677 test(perf): load substantial workspace file tabs
1e507c38d fix(app): restore review by semantic scroll anchor
1e8d0a226 test(perf): measure exact trusted renderer work
3e5daf282 test(perf): gate substantial workspace disposal and reopen
dec8d5ec4 test(perf): expose review scroll restoration evidence
731feade3 fix(app): capture review scroll before tab deactivation
f65946a56 test(perf): enforce workspace disposal ownership
2e6388c02 test(perf): localize workspace scroll overwrite
c72b642df fix(app): snapshot review before tab insertion
a6069d6ea test(perf): gate heavy workspace noninferiority
3cb228ecd fix(app): reject unobserved review scroll clamps
a03985db9 test(perf): accept semantic scroll enrichment
ae3086a88 fix(app): dispose workspace panel after close motion
651e3725a perf(app): reuse file reads across tab remounts
693c92588 perf(app): externalize review working set
878f13d7a docs(perf): add implementation and release handoff
ec7ee91dd refactor(app): keep review workspace contract reachable
~~~

Use git log --stat 94c110381..HEAD and git diff --stat 94c110381..HEAD for the authoritative file-level delta. Review the full diff against fresh origin/dev before landing.
