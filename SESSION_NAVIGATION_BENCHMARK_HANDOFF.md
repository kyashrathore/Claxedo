# Session navigation benchmark continuation

This is the cloud-agent entry point for the current Claxedo vs T3 packaged-desktop comparison. It does not require Compound Engineering (`ce`) commands. Treat the Git branches and result manifests as authoritative; machine-local `/tmp` artifacts from the previous run are not available to a cloud agent.

## Current objective

Produce a fair, fresh, same-machine comparison of Claxedo and T3 using p95 for user-facing flows, including application start, session navigation, workspace-panel interactions, CPU, and memory. Record video while validating readiness so a fast number cannot be produced by measuring a blank/loading surface.

The user asked to pause the product flicker fix. Do not describe the current workbench preparation code as complete or benchmark-certified.

## Exact repository state

Use these three pushed branches together:

| Repository | Remote branch | Required commit | What matters |
| --- | --- | --- | --- |
| `kyashrathore/Claxedo` | `codex/session-navigation-benchmark` | `b9e2335814` or later | Claxedo V3 driver, corrected topmost transcript proof, and the paused WIP presentation handoff |
| `kyashrathore/agent-app-benchmark` | `codex/benchmark-v1` | `53c4f7550b89638346806e8f81a6f270c7f9c738` | Paired runner, p95-focused report, session/workspace user-flow scenarios, frame-health panel transitions |
| `kyashrathore/t3code` | `codex/agent-app-benchmark-v1` | `fbad1b120e56823260f64337a9ddc558928f9a8a` | T3 V3 driver with visible, active, hit-tested transcript readiness |

The T3 branch is intentionally on the fork. Do not open a new T3 pull request; the prior user direction was to push only to the existing closed PR branch.

## What is complete

- Both drivers support `app-start-v3`, `session-switch-v3`, `session-navigation-v1`, and `workspace-panel-v2`.
- The framework report uses p95 as the main comparison and presents workspace loads as one trend instead of separate light/moderate/heavy tables.
- `app-start-v3` measures first launch and repeat launch.
- `session-switch-v3` owns the progressive memory/CPU workload and the 1/8/32/128 MiB session-size trend.
- T3 no longer declares a switch complete while only the loading/blank layer is visible. Commit `fbad1b120` requires the exact active owner, a visible viewport row, topmost hit testing, and two stable presentation frames.
- Claxedo commit `da4c4abbca` applies the equivalent ancestor-visibility and topmost hit-test proof.
- Review-surface scrolling was removed from the timed workspace flows. Expand All is an ordinary `workspace-panel-v2` action; it has no special report section.
- Panel open/close is scored by frame health rather than intentional animation duration.

## Open integrity issues before publication

1. **Claxedo session-sidebar setup still recenters rows.** In the Claxedo public driver, `clickVisibleSessionActivation()` calls `scrollIntoView({ block: "center", inline: "center" })`. It is outside the action clock, but it visibly jumps a 53-session sidebar and contaminated the visual audit. Replace this with canonical reveal behavior: do nothing when the target is already visible; otherwise use the nearest minimal scroll and wait for that setup scroll to settle before pointerdown. Do not add Review scrolling back.
2. **Claxedo visual continuity is unresolved.** The sidebar, transcript, and composer visibly flicker together on session changes. The final readiness endpoint is real, but the benchmark currently does not prove continuous coverage between source and destination frames.
3. **The five-repetition corrected run was interrupted.** Never publish or merge partial output from `claxedo-vs-t3-p95-user-flows-corrected-20260826-r1`. Use a new immutable run ID such as `...-r2`.
4. **Old generated pages are stale evidence.** Rebuild a new site from the new comparison manifest. Do not overwrite an old site directory or infer that refreshing an old `file://` tab loaded new results.
5. **The paused product code is incomplete.** `b9e2335814` adds workbench preparation state and a `SessionPage` first-fold readiness callback. The rail/session activation path does not call `navigation.prepare()`, so it does not yet change user behavior. The WIP passes the repository's full typecheck after its size-boundary follow-up, but it has not passed the missing behavioral handoff tests or a packaged benchmark.

## Paused flicker implementation: where to resume later

The partial implementation is in:

- `packages/claxedo-app/src/app/workbench/workbench/provider.tsx`: owns presentation preparations and readiness promises.
- `packages/claxedo-app/src/app/workbench/workbench/workbench.tsx`: can mount a destination behind the current opaque surface at final geometry.
- `packages/claxedo-app/src/features/session/ui/content/session-content.tsx`: lets a preparing session hydrate without becoming visible.
- `packages/claxedo-app/src/features/session/ui/session-screen.tsx`: reports first-fold readiness.

The missing canonical change point is the session activation path in `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx`. A correct implementation must keep the old session painted, prepare only the latest requested destination, wait for real first-fold presentation, atomically promote it, and cancel stale preparation on rapid clicks. Do not repair the contract with a timer, synthetic readiness event, or fallback transcript.

Before continuing that code, add tests for prepare/cancel/promote and rapid successive activations. Expect `PaneCtx` test fixtures to need the new fields or the interface to need a deliberately optional compatibility boundary.

## Required comparison metric inventory

The final comparison must contain every metric below for both applications. Both registered drivers advertise all four scenarios, so a normal complete run should not contain `Unsupported` rows. `Unsupported` is acceptable only for a genuinely absent product capability; invalid or missing evidence must remain `Invalid`/`Withheld` with its reason and must never be converted to zero.

### 1. Application start

Report p95 wall-clock latency from process spawn to the correct 1 MiB transcript being painted across two presentation opportunities with the composer accepting trusted input:

- **Cold app start / first launch:** new application state that the application has never launched with.
- **Initialized app start / repeat launch:** a new process using state initialized by exactly one earlier untimed launch. This is not revealing a hidden process.

For both rows show p95 milliseconds, valid/attempted launches, relative difference, build digest, and launch order. Keep sampled maximum as diagnostic context when p95 is based on only five observations.

### 2. Historical session switching

At the fixed 1 MiB history size, report p95 trusted activation-to-painted-and-input-ready latency for all four lanes:

- cold destination within the same workspace;
- returning/warm destination within the same workspace;
- cold destination across workspaces;
- returning/warm destination across workspaces.

Also report a p95 cold-open size trend at `1`, `8`, `32`, and `128 MiB`. “Cold” means the destination has never become active in that measured process. “Returning/warm” means it was activated once to full readiness, the driver returned to control, and the revisit is measured.

### 3. User-facing session navigation

Report these separately so cold-open and return behavior are not hidden inside one generic switch number:

- **First visit, panel closed:** p95 by `1/8/32/128 MiB` history size.
- **Return to previously visited session, panel closed:** p95 by the same history sizes.
- **Return to previously visited session with workspace panel already open:** p95 across light, moderate, and heavy retained panel load.

For the panel-open return, also report p95 renderer work from the same measured interval:

- JavaScript/script duration;
- style-recalculation duration;
- layout duration;
- total renderer task duration;
- worst and p95 frame interval;
- frames over the `16.667 ms` budget;
- long-animation-frame count, worst duration, and worst blocking duration.

The endpoint must require both the destination transcript and seeded panel state to be correct, painted, topmost, and interactive. A loading message or blank surface is not completion.

### 4. Workspace-panel user flows

Measure every action independently across light, moderate, and heavy retained loads:

- open panel;
- close panel;
- Files → Review;
- Review → Files;
- open file, with bytes data-warm but its surface never previously mounted;
- switch an already-open file tab;
- Expand All;
- Collapse All.

For every action/load point show:

- p95 user-visible response or interactive-completion latency;
- p95 frame interval;
- p95 count of frames over `16.667 ms`;
- p95 JavaScript, style recalculation, layout, and total task duration;
- p95 long-animation-frame count, worst duration, and worst blocking duration;
- valid/attempted count and relative result.

Open and close must not rank products by intentional animation length. For open, report input → shell visible; data ready → above-fold paint; data ready → interactive; paint → interactive; and total animation duration as diagnostic context. For close, report input → closed paint and frame health, with animation duration diagnostic-only. Transition mode (`animated`, `none`, or mixed) must be disclosed.

Expand All receives no special report or setup treatment. It is an ordinary workspace action whose measured result is the CPU/rendering spike, visual completion, frame health, and continued responsiveness after the trusted click. Setup must not scroll Review; verifying the complete model uses authoritative identities/state rather than walking virtualized rows.

### 5. Memory and CPU

Memory and CPU are app-level process-family measurements from `session-switch-v3`; do not split them into misleading per-component headline scores. Report:

- baseline-idle p95 summed RSS with the ready 1 MiB control session visible;
- active-workload p95 summed RSS;
- active sampled maximum RSS as diagnostic context, explicitly not an OS true peak;
- ending-idle p95 summed RSS after returning to the same control session;
- retained RSS growth, defined from ending-idle p95 minus baseline-idle p95;
- p95 RSS trend after `1/8/32/128 MiB` history steps;
- baseline-idle, active-workload, and ending-idle p95 process-family CPU percentage;
- p95 CPU trend across the same history-size steps.

`100% CPU` means one fully occupied logical core. RSS must sum the exact driver-declared application process family. Where stable process identities exist, include a secondary p95 breakdown for renderer, Electron main/browser, GPU, network utility, server/sidecar, and harness child; the whole-family total remains the comparable headline.

The report must show sample interval, raw sample count, idle-window duration, process-family definition, inaccessible/missing-process evidence, and host memory-pressure/power-state metadata. A memory or CPU row is invalid if the monitor lost the root process or a required window contains no samples.

### 6. Presentation and statistics contract

- Use nearest-rank **p95 for every distributional comparison**, not p50. Show valid/attempted counts beside every value.
- The user capped the run at five top-level repetitions. At `n=5`, nearest-rank p95 equals the sampled maximum; disclose this plainly rather than relabeling the result as p50.
- The current framework at `53c4f755` does **not** yet satisfy this: `src/report/model.mjs` selects p50 below 20 repetitions, `src/summarize.mjs` withholds p95 below 20 valid observations, and the generated memory section omits the complete CPU and idle/active/ending tables. The next agent must update the framework and tests before the fresh comparison, push that change to `codex/benchmark-v1`, and put the new exact framework commit in the paired config.
- Keep p50, average, maximum, raw observations, and traces only as diagnostic drill-down. The comparison table and trend charts use p95.
- Display both absolute values and relative difference (`Claxedo ÷ T3`, percentage faster/slower); lower is better for latency, CPU, RSS, renderer work, and frame intervals.
- Never pool unlike states, loads, workspace relations, or scenario versions to manufacture a larger sample.

### Required page structure

Use one compact p95 comparison table per flow family and trend charts rather than separate light/moderate/heavy tables:

1. application start;
2. historical session-switch lanes and cold-open size trend;
3. first-visit/return session navigation and panel-open return trend;
4. all workspace actions with load trend and 60 Hz health;
5. memory envelope and size trend;
6. CPU envelope and size trend;
7. expandable renderer/frame diagnostics and the fairness/provenance ledger.

## Fresh cloud checkout

```bash
git clone https://github.com/kyashrathore/Claxedo.git claxedo
git -C claxedo checkout codex/session-navigation-benchmark
git -C claxedo rev-parse HEAD

git clone https://github.com/kyashrathore/agent-app-benchmark.git agent-app-benchmark
git -C agent-app-benchmark checkout codex/benchmark-v1
git -C agent-app-benchmark rev-parse HEAD

git clone https://github.com/kyashrathore/t3code.git t3code
git -C t3code checkout codex/agent-app-benchmark-v1
git -C t3code rev-parse HEAD
```

Run the paired packaged-desktop comparison only on the same quiet Apple Silicon macOS host. A Linux cloud agent can review code, fix drivers, run unit tests, and prepare the config, but cannot produce comparable macOS Electron numbers.

## Install and build

The benchmark framework requires Node 22 or newer. T3 currently declares Node `24.13.1` and pnpm `11.10.0`; use those exact versions for its build. Claxedo uses Bun.

```bash
cd /absolute/path/to/agent-app-benchmark
npm ci
cargo build --release --manifest-path native/resource-monitor/Cargo.toml
node bin/agent-app-benchmark.mjs corpus generate \
  --corpus opencode-completed-sessions-v3 \
  --output artifacts/corpora/opencode-completed-sessions-v3
node bin/agent-app-benchmark.mjs corpus verify \
  --input artifacts/corpora/opencode-completed-sessions-v3
```

Build Claxedo after every product-source change; the driver launches the packaged application, not Vite source:

```bash
cd /absolute/path/to/claxedo
bun install --frozen-lockfile
bun --cwd packages/claxedo-desktop run package:mac -- --dir --publish never
```

The executable is normally:

```text
/absolute/path/to/claxedo/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app/Contents/MacOS/Claxedo Dev
```

Build T3 and retain its temporary stage so the paired driver can launch the `.app` directly:

```bash
cd /absolute/path/to/t3code
corepack enable
pnpm install --frozen-lockfile
mkdir -p /tmp/t3-benchmark-stage
TMPDIR=/tmp/t3-benchmark-stage T3CODE_DESKTOP_KEEP_STAGE=1 pnpm dist:desktop:dmg:arm64
find /tmp/t3-benchmark-stage -type f -path '*T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)' -print
```

Use the executable printed by the final command. Do not reuse an application package built from a different commit.

## Validate before measuring

Framework:

```bash
cd /absolute/path/to/agent-app-benchmark
npm test
npm run lint
npm run validate
cargo test --manifest-path native/resource-monitor/Cargo.toml
```

Driver-focused checks:

```bash
cd /absolute/path/to/claxedo
bun test packages/claxedo-app/perf-harness

cd /absolute/path/to/t3code
pnpm exec vitest run scripts/lib/agent-app-benchmark/drivers/t3.test.ts
```

After changing the paused Claxedo product code, also rerun the Claxedo app typecheck and focused workbench/session tests before packaging. The pushed WIP passed `bun turbo typecheck`; prepare/cancel/promote behavior remains unimplemented and therefore untested.

## Paired comparison config

Create an ignored JSON config in `agent-app-benchmark/artifacts/configs/`. Use absolute paths and set `frameworkRevision` to the exact output of `git rev-parse HEAD` in the benchmark repository.

```json
{
  "id": "claxedo-vs-t3-p95-user-flows-corrected-20260826-r2",
  "title": "Claxedo and T3 — corrected user-flow p95",
  "description": "Five-repetition same-host packaged-desktop comparison with visible, active, topmost transcript readiness.",
  "provenance": "community-self-attested",
  "frameworkRevision": "REPLACE_WITH_AGENT_APP_BENCHMARK_HEAD",
  "runProfile": "publication",
  "repetitions": 5,
  "scenarioIds": [
    "app-start-v3",
    "session-switch-v3",
    "session-navigation-v1",
    "workspace-panel-v2"
  ],
  "resourceMonitor": "/absolute/path/to/agent-app-benchmark/native/resource-monitor/target/release/agent-app-resource-monitor",
  "corpusDirectory": "/absolute/path/to/agent-app-benchmark/artifacts/corpora/opencode-completed-sessions-v3",
  "outputRoot": "/absolute/path/to/agent-app-benchmark/artifacts/comparisons/claxedo-vs-t3-p95-user-flows-corrected-20260826-r2",
  "apps": [
    {
      "id": "t3",
      "driver": "/absolute/path/to/node",
      "args": ["/absolute/path/to/t3code/scripts/lib/agent-app-benchmark/drivers/t3.ts"],
      "cwd": "/absolute/path/to/t3code",
      "env": {
        "T3_BENCHMARK_EXECUTABLE": "/absolute/path/to/T3 Code (Alpha).app/Contents/MacOS/T3 Code (Alpha)"
      }
    },
    {
      "id": "claxedo",
      "driver": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/claxedo/packages/claxedo-app/perf-harness/src/public-agent-app-driver.ts"],
      "cwd": "/absolute/path/to/claxedo",
      "env": {
        "CLAXEDO_BENCHMARK_EXECUTABLE": "/absolute/path/to/claxedo/packages/claxedo-desktop/dist/mac-arm64/Claxedo Dev.app/Contents/MacOS/Claxedo Dev"
      }
    }
  ]
}
```

Run it once. The framework owns the mirrored schedule; do not manually run one app's complete suite and then the other's.

```bash
cd /absolute/path/to/agent-app-benchmark
node bin/agent-app-benchmark.mjs comparison run \
  --config artifacts/configs/claxedo-vs-t3-p95-user-flows-corrected-20260826-r2.json
```

Five repetitions are the requested cap. Do not increase repetition count to compensate for invalid samples; investigate invalid readiness or environment evidence instead. Before running, implement the documented five-sample p95 presentation rule in the framework so the site does not silently fall back to p50 or label the required rows unsupported.

## Visual audit

Record at least one full-screen session-navigation pass for each app. Check the video frame by frame for:

- no measured loop beginning while the initial app window is blank;
- the destination transcript, not a loading message, satisfying completion;
- no source/destination transcript being painted on top of one another;
- Claxedo sidebar, transcript, and composer continuity;
- no benchmark-created sidebar recenter jump;
- no stale or blocked overlay passing hit testing.

The prior local audit found that Claxedo's first measured switch started only after startup content appeared, but it also found visible sidebar/transcript/composer flicker. That video is machine-local evidence and must be re-recorded by a cloud agent that needs to verify the behavior.

## Build the comparison page

Only after every scenario result is valid, build a new immutable site directory:

```bash
cd /absolute/path/to/agent-app-benchmark
node bin/agent-app-benchmark.mjs site build \
  --comparison artifacts/comparisons/claxedo-vs-t3-p95-user-flows-corrected-20260826-r2/comparison.json \
  --output artifacts/sites/claxedo-vs-t3-p95-user-flows-corrected-20260826-r2
```

The final page should show:

- every row and diagnostic in **Required comparison metric inventory** above;
- one p95 comparison table per flow family rather than separate light/moderate/heavy tables;
- load/size trend graphs for session switching, session navigation, workspace actions, RSS, and CPU;
- valid/attempted counts and an explicit non-comparable state for genuinely unsupported or invalid rows.

Do not fill missing metrics with zero or infer values from another scenario.

## Prior diagnostic baseline, not a publication result

The final one-repetition corrected-readiness preflight on the previous host reported:

- Claxedo isolated session switching: median `39.3 ms`, p95 `40.9 ms` across 40 samples.
- T3 isolated session switching: median `153.6 ms`, p95 `186.0 ms` across 40 samples.
- Claxedo first/repeat app start: about `6711/2001 ms`.
- T3 first/repeat app start: about `3224/3104 ms`.

Those numbers are useful only as a regression alarm. They are not the requested five-repetition comparison, and they do not resolve Claxedo's continuity flicker.

## Completion standard

The continuation is complete only when:

1. all three exact revisions are recorded in result provenance;
2. both apps use the same verified corpus and resource monitor on the same quiet host;
3. all four scenarios complete five paired repetitions with valid readiness evidence;
4. the session-sidebar setup jump is gone;
5. video confirms the predicates match what a user sees;
6. the new p95 page includes app start, session/workspace trends, CPU, and memory;
7. code changes are committed and pushed to the existing branches; and
8. results are reported with explicit caveats for any remaining visual continuity defect.
