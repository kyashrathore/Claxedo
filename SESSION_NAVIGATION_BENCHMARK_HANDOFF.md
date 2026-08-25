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

Five repetitions are sufficient. Do not increase repetition count to compensate for invalid samples; investigate invalid readiness or environment evidence instead.

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

- one p95 comparison table rather than separate light/moderate/heavy tables;
- a load/size trend graph for session navigation and workspace actions;
- first launch and repeat launch;
- session first visit and return visit;
- return visit with the workspace panel already open;
- workspace actions including open/close, Files/Review navigation, file opening/tab switching, Expand All, and Collapse All;
- baseline/active/ending RSS, retained RSS growth, and sampled CPU;
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
