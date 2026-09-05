# Performance consolidation

Implementation branch: `codex/performance-consolidation`.
Base: local `dev` at `bfe54683490bf94991d56a47f83f371da9e35cdb`.
The worktree initially started at `043a8858ed357ca7ee1c08bf909eb26ea1b8454a`.
When `dev` advanced during verification, the implementation was saved, rebased onto
the newer snapshot, and restored. Cleanup changes were carried into the moved owners.
Unrelated changes in the primary checkout were not copied or modified.

## Implemented ownership

- `perf-harness/src/catalog.ts` discovers browser flows, package-owned suites, packaged
  drivers, infrastructure measurements and attribution probes. Flow IDs derive from one registry.
- `browser/` owns process setup, fixtures, API contracts, reusable actions and scenario
  families. Core scheduling remains in `browser-runner.ts`. Probes are outside core source.
- `perf-record.ts`, `measurement-context.ts` and `measurement-provenance.ts` describe
  measurement semantics, comparison identity and source/build authority.
- `baseline-store.ts` and `run-log.ts` are the only active baseline and trend owners.
  Legacy files are retained as historical evidence; legacy writers and automatic budgets are removed.
- Renderer, diagnostics and attribution suites have explicit policies. GitHub and Crabbox
  use the same diagnostics command and fixed paired thresholds. Memory retains its own validity checks.
- Public framework conformance uses actual cases from its pinned dependency. Shared fixture
  preparation and registration serve public, internal and actual-session materializers.
- Production session timing remains in the app, with bounded event/open/User Timing retention
  and an explicit authoritative start before phase recording.

## Correctness covered

- Repeated metric samples represent complete flow repetitions, not task populations.
- Renderer tasks, attributed intervals, observed heap and forced-GC retained heap have distinct meanings.
- Empty/mixed/invalid repetitions and unstable source/build provenance cannot publish.
- Host, environment, headed/headless mode, workload, instrumentation and definition changes
  prevent an invalid baseline comparison. Renderer and diagnostics baselines have separate paths.
- Selected internal profiles score their selected required metrics; missing selected evidence fails.
- Frozen LCP aggregates its own population rather than a later unfrozen paint's ordering.
- Browser mock responses follow current canonical message watermarks, goal state and event envelopes.
- File and connection fixtures follow the mounted workspace-runtime routes and connection decoder.
- Heavy-panel reopening checks the intentional Review activation, then proves exact cached-file
  restoration through a separate physical file-tab activation outside the reopen timing.
- Session-switch cells distinguish first-visit closed panels from warm restoration of saved
  file/Review state, with independent readiness/release clocks and cache-read checks.
- The mock stream server preserves real SSE lifetimes. Page leases, cancellation and server
  shutdown own cleanup; artificial EOF/reconnect cycles cannot pollute resize measurements.
- Truncated layout-shift populations remain absent rather than producing a false improvement.

## Verification

Commands below ran in the isolated worktree. `app`, `desktop`, and `harness` mean
`packages/claxedo-app`, `packages/claxedo-desktop`, and `packages/claxedo-app/perf-harness`.

| Working directory | Command | Outcome |
| --- | --- | --- |
| root | `bun install --frozen-lockfile` | Passed; fresh workspace dependencies installed |
| harness | `bun install --frozen-lockfile` | Passed after updating the explicitly pinned public framework and nested lockfile |
| root | `bun run build:claxedo-runtime-deps` | Passed after rebase; all 13 required build tasks completed |
| desktop | `bun run build` | Passed after rebase, including the process-metrics worker and product boundary manifests |
| app | `bun run typecheck` | Passed after rebase: source/E2E TypeScript, theme checks, 261 architecture tests, 23 timeline tests, 38 workbench tests |
| app | `bun test --conditions=browser --preload ./happydom.ts src/platform/performance/session-perf.test.ts` | 11 passed |
| app | `bunx vitest run src/features/session/ui/session-open-perf.vitest.ts` | 2 passed |
| root | `bun run diagnostics:verify` | Final source passed: desktop 91 tests; app 13 Bun + 8 Vitest tests; harness typecheck + 278 passed, 1 existing skip, 0 failed |
| root | `bun run test:architecture-ratchets` | Final source passed all 8 policies across 5 products; no ceilings raised |
| root | `git diff --check` | Passed; no unresolved merge paths |
| harness | `bunx playwright install chromium` | Passed; Chromium 149.0.7827.55 installed |

The existing skipped test is `Claxedo terminal workload > production contract pins the
canonical ten-second wire stream`. The stream transport tests use real native Bun HTTP
streams, including a full ten-second heartbeat interval, cancellation and lease isolation.

Final public browser entrypoints:

```sh
bun src/cli.ts run --all --suite renderer --iterations 1 --no-trend \
  --output /tmp/perf-consolidation-renderer-complete.json
bun src/cli.ts run --scenario launch-project --suite diagnostics --iterations 1 --no-trend \
  --output /tmp/perf-consolidation-diagnostics-complete.json
```

- Renderer: exit 1. All 11 scenarios completed with stable source/build provenance,
  valid whole-flow repetitions, and zero semantic or unexpected-resource failures.
  `large-diff-toggle` and `heavy-workspace-close` passed; the other nine failed only
  the unchanged 16.67 ms renderer-task gate. These are single-run observations,
  not evidence that consolidation improved or regressed product performance.
- Diagnostics: exit 0 with `warn`. The four ABBA executions produced two enabled
  repetitions, two controls, 67 real process samples, 16 collections and zero dropped
  ticks. Source/build provenance was stable. The overhead gate passed; the disabled
  control's worst task was 23.64 ms, so this is not a qualifying baseline.
- No baseline was promoted or historical trend data rewritten. Invalid measurements
  remain available as raw reports; they cannot silently become comparisons.

Primary verification logs are `/tmp/perf-consolidation-diagnostics-verify-final.log`,
`/tmp/perf-consolidation-ratchets-final.log`,
`/tmp/perf-consolidation-app-typecheck-rebased.log`, and
`/tmp/perf-consolidation-desktop-build-rebased.log`. The browser commands' `.json`
reports have matching `.md` reports and `.log` output alongside them.

## Remaining acceptance

The renderer performance gate is not green. Its owner is the app workload named in
each report; follow-up optimization needs paired measurements and attribution for
the actual over-budget task, without relaxing the gate or treating this refactor as a win.

Live memory acceptance was attempted with:

```sh
bun src/cli.ts memory --sessions 60 --iterations 5 --mode rapid
```

It exited 1 before any sweep: `chromium.connect(server.wsEndpoint())` timed out after
30 seconds. The isolated probe below also timed out under Bun with explicit IPv4,
while replacing `bun` with `node --input-type=module` succeeded (browser version
149.0.7827.55; page evaluation returned 2):

```sh
bun -e 'import {chromium} from "playwright-core"; const s=await chromium.launchServer({headless:true,host:"127.0.0.1",timeout:10000,args:["--js-flags=--expose-gc"]});try{const b=await chromium.connect(s.wsEndpoint(),{timeout:5000});const p=await b.newPage();console.log(JSON.stringify({endpoint:new URL(s.wsEndpoint()).hostname,browser:b.version(),evaluation:await p.evaluate(()=>1+1)}));}finally{await s.close()}'
```

The failed attempt is in `/tmp/perf-consolidation-memory-rebased.log`. Playwright
1.61.1 is unchanged from `dev`. Memory unit, provenance and cleanup contracts pass,
but a valid five-browser live sweep remains unverified. The harness's browser-control
owner needs to resolve Bun/Playwright server connectivity while preserving verified
Chromium process exit, then rerun the public memory command. No retention result is claimed.

Packaged public-framework scoring, packaged diagnostics smoke, and live relay/server
capacity were not run. Their cataloged owners retain those acceptance criteria and
their app-bundle or deployment setup; conformance tests do not replace live qualification.

## Public comparison against stock T3 Code (2026-09-05)

The packaged consolidation build was compared with upstream T3 Code `c1d27e593b`
through `agent-app-benchmark` `f8cc01d8…` (comparison root
`~/test/agent-app-comparison-20260905`; ledger `provenance/claxedo-comparison-fixes.md`).
The first complete smoke (`smoke-03`) exposed two product defects that the packaged
driver had never reached before: the desktop's root-surface route ownership omitted the
`/api/wr/file` and `/api/wr/find` prefixes the typed workspace-runtime client requests,
and the SDK's runtime file client no longer stamped the `directory` scope. Both are fixed
in this worktree (`route-ownership.ts` + contract tests; `runtime-request.ts`
`scopeRuntimeRequestUrl` + `sdk.test.ts`), the app was repackaged, and the
workspace-panel reproduction is valid again. Cold session opens on current `dev`
measure roughly ten times the 2026-09-02 build (see the ledger); that regression is
reported with the comparison and remains an app-owned follow-up.

The cold-open regression was then attributed and fixed here as well: every `RuntimeStore`
session projection ran `lastTurn`, a backward walk over the session's whole
`runtime_journal` (twice per row), and the embedded runtime awaits a full session listing
on every request, so a cold activation paid roughly 1.3 s of serialized journal scans on the
benchmark corpus (80 ms per listing warm, 15 ms per `getSession`). `store.ts` gains the
partial index `runtime_journal_turn_outcome_idx` and computes `lastTurn` once
(`listSessions` 80 ms → 0.4 ms on the materialized 1.6 GB store); covered by a planner
contract test in `store.test.ts` and a 100k-row read-cost test in
`perf/runtime-store.perf.ts`. Per-request reconciliation in
`ensureEmbeddedWorkspaceRuntime` is unchanged and now cheap; whether reads should await it
at all remains a local-server ownership question.


App start was then attributed and fixed as well (ledger: "App start: root cause and fixes"):
the embedded OpenCode SDK — now staged unbundled with no shipped compile cache — was booted
on the request path by every read that resolved an adapter (`applyConfig` → launch policy
→ `model.list`), and the local runtime port forced a config sync per request; the stalled
server then tripped a latent shell race that replaced the restored session with a workspace
draft. `OpenCodeSdkHarnessAdapter` applies its launch document lazily and the port skips
config on reads; startup now has no request above 150 ms and the restored session is
message-ready at ~0.37 s. The unbundled SDK's import cost (0.6–1.3 s) still exists off the
critical path; restoring a shipped bundle or compile cache for the staged SDK is the
desktop packaging owner's follow-up.

A pre-listen engine warm-up was tried and reverted: the desktop verifies the server's health
within one second of its ready IPC and then its published daemon identity, so any boot of the
unbundled SDK before the first answer fails the launch or pushes app start to 3 s. The shipped
state is the lazy launch document plus the read-safe port; one or two one-time 100–1,000 ms
stalls per process remain in the first seconds after launch and are recorded in the ledger
for the packaging owner (bundle the SDK with a shipped compile cache, then boot at startup).

The residual first-seconds stall was attributed with a held-app experiment and a V8 CPU
profile of the packaged server child (env-gated `CLAXEDO_SERVER_V8_PROF_DIR` in
`server-runtime-policy.ts`, flushed through the entry's graceful SIGTERM stop). The rail's
per-workspace `/permission` and `/question` reads were the first `host.client()` of the
process: they booted the embedded OpenCode SDK on the server's main thread — 730 ms of ESM
loading over the unbundled package plus ~840 ms of `OpenCode.create()` — and every request
behind them waited, including the benchmark's first activations (publication-06: cold-switch
p95 807/791 ms with medians 49/41 ms; navigation first-visit up to 916 ms). Since app start now
completes at ~1.0 s instead of ~1.9 s, those activations land inside that window. Two reads
were made launch-free (`harness-adapter.ts`: pending-interaction reads and `applyConfig` no
longer apply the workspace launch document), and the interaction port now answers empty
unless the host is `ready` — a pending request exists only inside a turn, and turns run only
on a serving host (`interaction-port.test.ts`). On the final package no startup request
exceeds 25 ms after readiness and the server child has no busy window above 250 ms. The SDK
now boots on the first engine use; that first-prompt cost is the packaging follow-up (bundle
the SDK with a shipped compile cache and boot it off the request thread, as the 2026-09-02
build did with its engine worker).
