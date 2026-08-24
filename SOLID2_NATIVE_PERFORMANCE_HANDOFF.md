---
artifact_contract: "ce-handoff/v1"
created_at: "2026-08-24T07:18:46Z"
title: "Solid 2 native performance experiment handoff"
summary: "Resume the gated Solid 2-native refactor only after a fresh paired Solid 1 baseline, and accept the upgrade only if every hard benchmark row wins without application-logic changes."
keywords: ["solidjs-2", "performance", "benchmark", "claxedo", "web-cdp", "experiment"]
cwd: "/Users/yashvardhansingh/test/opencode/.worktrees/solid2-native-beat-solid1"
resume_focus: "Establish the five-sample paired baseline, obtain explicit approval at CP1, then test isolated Solid 2-native reactive refactors until the candidate strictly beats the frozen Solid 1 control or the experiment is rejected."
repository: "Claxedo"
repo_root_sha: "728cedf2a29e2f9da901c8c36620ce5efc09e6b2"
branch: "optimize/solid2-native-beat-solid1"
head: "1382cba82e133c8c5c403129dc525407f973bdcf"
worktree_path: "/Users/yashvardhansingh/test/opencode/.worktrees/solid2-native-beat-solid1"
---

# Solid 2 native performance experiment

## User mandate

This is an experimental branch. The user requires all of the following:

1. Refactor the application around Solid 2-native patterns, not Solid 1 compatibility patterns.
2. Preserve application behavior and user-visible logic.
3. Improve code quality and measured performance together.
4. Upgrade only if Solid 2 strictly beats the frozen Solid 1 control under the agreed benchmark contract. If it does not, reject the upgrade.

The user later paused the experiment and requested this committed handoff. Creating and pushing this file is the only work resumed after that pause. Do not restart measurements or source refactors until the current user explicitly resumes the experiment.

## Authoritative experiment state

- Experiment worktree: `.worktrees/solid2-native-beat-solid1`
- Branch: `optimize/solid2-native-beat-solid1`
- Solid 2 migration snapshot: `ff507c473fa166acfd35676277aa490ddc698582`
- Measurement-setup snapshot: `1382cba82e133c8c5c403129dc525407f973bdcf`
- Frozen Solid 1 control: `d631aad47c16f4d33e1dc64c3dfd3c5abbe3014b`
- Frozen agent-app benchmark framework: `76a27191120092d3972aab08ec480d8028078de4`
- Canonical contract: `.context/compound-engineering/ce-optimize/solid2-beat-solid1-v3/spec.yaml`
- Immutable wrapper: `.context/compound-engineering/ce-optimize/solid2-beat-solid1-v3/measure.ts`
- Official migration source supplied by the user: <https://v2.solidjs.com/migration/from-solid-1>

Before this handoff was added, the experiment worktree was clean. No Solid 2 optimization hypothesis or application-source refactor has been made on top of `1382cba82`. There is no valid fresh baseline and no `experiment-log.yaml`.

Do not benchmark `.worktrees/codex-solid-2-rc`; it contains unrelated and in-progress state. The branch and worktree named above are the canonical candidate.

## The non-negotiable win gate

The contract defines 23 hard values: 20 candidate/control performance ratios plus `worst_solid1_ratio`, `solid1_rows_lost`, and `switches_over_1000ms`.

Acceptance requires:

- Every one of the 20 latency and RSS ratios is at most `0.99`.
- `worst_solid1_ratio <= 0.99`.
- `solid1_rows_lost == 0`.
- `switches_over_1000ms == 0`.
- All 10 validity gates equal `1`.
- Each arm produces exactly four startup and 106 switch observations.
- All observations and process-family resource traces are complete and valid.
- Control, candidate, framework, corpus, schedule, browser, driver, build, and environment identities match the paired contract.
- Correctness checks pass through real public entrypoints.

CP1 requires five fresh paired wrapper samples. Each wrapper performs two repetitions per target. Aggregate with the median, report variance, persist every raw sample and identity, write and read-verify `experiment-log.yaml`, then stop for explicit user approval before generating or implementing optimization hypotheses.

Timed web/CDP lanes must be serial and exclusive on one quiet host. Parallelism is appropriate for research, builds, static analysis, and correctness shards, never for browsers or resource monitors competing for the same benchmark host.

## Application behavior that is frozen

Do not change any of these to manufacture a win:

- Product policy, readiness semantics, user-visible output, or application logic.
- Timers, delays, the two-second network-quiet policy, prefetch, cache, retention, pagination, CSS, animation, or virtualization policy.
- Benchmark framework, public driver, observer, materializer, corpus, fixtures, schedule, or result validation.
- Solid versions, manifests, lockfile, or the local scheduler patch.
- `packages/claxedo-app/src/platform/runtime/session-switch.ts`.
- Any benchmark-only application branch, fallback state, synthesized event, or synthesized readiness value.

The mutable and immutable path lists in `spec.yaml` are authoritative. Fix canonical producers; never compensate in a consumer or harness.

## What “the two-second gate” means

`FAST_SESSION_SWITCH_NETWORK_QUIET_MS = 2_000` is a Claxedo scheduling policy, not a Solid feature or benchmark timeout. Enabling it records `networkQuietUntil` and can delay independent hydration, reconnect, review, process, or other background work for two seconds. Disabling that portion still leaves the separate 250 ms stale-session protection.

The likely performance cliff is that broad synchronous Solid 2 work causes required destination data to miss its readiness threshold, after which the existing quiet policy amplifies the miss into an approximately two-second stall. That is a hypothesis, not yet a proven cause. The valid experiment must improve the Solid 2 reactive graph while leaving this policy unchanged.

## Solid 2-native patterns to test

The migration opportunity is work avoidance, graph locality, and correct ownership—not assuming every Solid 2 primitive is intrinsically faster.

1. **Let automatic batching commit related writes.** Remove navigation-wide `flush()` usage. Keep `flush()` only around the smallest imperative DOM read, focus, selection, or measurement that truly requires committed state. Return action results directly instead of rereading staged signals.
2. **Derive instead of synchronizing.** Prefer direct derivation, memo, or projection over copying reactive state through `createTrackedEffect`. For an actual external effect, track narrow inputs and apply them untracked.
3. **Use one draft-first authoritative store.** Eliminate scratch state, immutable reducer output, deep comparison, and repeated reconciliation when they represent the same responsibility. Related mutations should occur through one action and owner.
4. **Localize mutable collections.** Use shallow stores for wholesale record replacement, `markRaw()` for opaque objects, stable logical IDs for list identity, and entity-local projections so one entity update does not wake the entire collection.
5. **Put async reads in the graph.** Keep the query/cache authoritative, read reactive dependencies before the first `await`, keep settled UI mounted during revalidation, and use narrow loading/error boundaries. Do not recreate resources with parallel `data/error/loading` signals.
6. **Use actions for mutation intent.** Apply optimistic state only where it models expected user-visible state. After an async boundary, explicitly re-enter the action transaction when the API requires it.
7. **Own and dispose expensive work narrowly.** Prefer cached inactive data over retaining complete hidden UI trees. Use narrow owners, lazy computations, and unobserved cleanup for streams, timers, observers, indexes, and large caches.
8. **Prioritize first-fold data.** Required destination work starts immediately; only independent background enrichment is quieted. Do not “optimize” by deleting or shortening the existing policy.
9. **Avoid startup work.** Code-split inactive editor, terminal, review, graph, settings, and similar surfaces; do not construct providers or projections without an observer.
10. **Respect RC1 limitations.** The installed runtime is Solid `2.0.0-rc.1` plus a local scheduler patch. Keep projections entity-local and add browser regressions around pending, nested projections, shared async memos, and rapid switches instead of relying on fixes that landed after RC1.

High-value code locations to inspect after CP1 approval:

- `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx`: broad session activation and `flush()`.
- `packages/claxedo-app/src/app/workbench/workbench/provider.tsx`: published versus same-task scratch state.
- `packages/claxedo-app/src/app/workbench/state/provider.tsx`: deep comparison and reconciliation.
- `packages/claxedo-app/src/app/workbench/state/metadata.ts`: global invalidation and whole-collection rebuilding.
- `packages/claxedo-app/src/app/workbench/rail/rail-workbench-canvas.tsx`: retained hidden session owners.
- `packages/claxedo-app/src/features/session/ui/session-screen.tsx`: keyed remount boundaries.
- `packages/claxedo-app/src/features/session/ui/message-timeline.tsx`: existing row-local reuse worth preserving.
- `packages/claxedo-app/src/lib/async-state.ts`: compatibility-shaped async state.

## Benchmark infrastructure checkpoint

This infrastructure is volatile and must be re-inspected before reuse. No credential or private-key path belongs in the repository.

At `2026-08-24T07:18:46Z`, Crabbox lease `cbx_9e6f32932efd` (`solid2-native-baseline`) was `ready`. It is an on-demand AWS `m7i.2xlarge` in `eu-west-1`, with eight vCPUs and 32 GiB RAM, and was scheduled to expire at `2026-08-24T08:38:26Z`.

Remote roots:

- Candidate: `/mnt/benchmark/candidate`
- Control: `/mnt/benchmark/control`
- Framework: `/mnt/benchmark/framework`
- Playwright browsers: `/mnt/benchmark/playwright`
- Temporary data: `/mnt/benchmark/tmp`

Frozen runtime identities:

- Corpus: `opencode-completed-sessions-v3`
- Corpus digest: `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`
- Browser: Playwright Chromium v1228 / Chrome `149.0.7827.55`
- Node: `24.15.0`
- Bun: `1.3.14`
- Rust: `1.93.1`
- Backend port: `41593`

The dependency and build setup was repaired identically for both arms without modifying source contracts:

- The original Bun hardlink install shared mutable postinstall files with its cache, leaving missing native packages and zero-byte package manifests.
- Both roots and both nested performance-harness installs were rebuilt serially with a fresh shared cache, `--backend=copyfile`, `--linker=isolated`, `--force`, and the frozen lockfile.
- `better-sqlite3` loaded and executed `select 42` in both arms; full server database imports passed.
- Both production web bundles were rebuilt with the backend URL set at Vite compile time to `http://127.0.0.1:41593`. Preview-time environment injection is too late for `import.meta.env.VITE_*`.
- The active Solid 1 and Solid 2 artifact sizes were `88,268,119` and `92,778,266` bytes respectively.
- Candidate focused harness tests passed 12/12. Control focused driver/materializer tests passed 5/5. Local bundle identity checks passed for both builds.
- When reusing these configured bundles, set `CE_OPTIMIZE_SKIP_BUILD=1`; a bare rebuild would overwrite the assigned compile-time backend URL.

## Invalid attempts—do not reuse as samples

No attempt produced a complete paired result:

1. One setup run failed because `/mnt/benchmark/tmp` was absent.
2. One setup run failed because `better-sqlite3` was not canonically materialized.
3. One run failed readiness because the frontend bundle still contained the default port `2593`; the backend correctly used `41593`.
4. A corrected run passed that readiness point and entered the switch scenario, but the user requested a hold. It was cancelled and all browser, preview, backend, driver, and resource-monitor processes were stopped.

These are infrastructure or aborted runs, not performance evidence. Sample 1 must restart from scratch.

## Resume sequence

After the current user explicitly resumes:

1. Read this file, `spec.yaml`, `measure.ts`, and the official Solid 2 migration guide.
2. Re-inspect the branch, lease, remote processes/listeners, dependency smoke tests, bundle-embedded backend URL, and host load. Provision a fresh equivalent host if the lease expired or its state is suspect.
3. Run five complete paired wrappers serially with `CE_OPTIMIZE_EXCLUSIVE_HOST=1`, `CE_OPTIMIZE_SKIP_BUILD=1`, and `CE_OPTIMIZE_BENCHMARK_REPETITIONS=2`.
4. Reject any run with an incomplete observation, invalid trace, identity mismatch, dirty immutable path, or failed validity gate.
5. Persist raw samples, medians, variance, diagnostics, identities, and clean-tree evidence to `experiment-log.yaml`; write-read verify it.
6. Present CP1 and wait for explicit user approval.
7. After approval, change one Solid 2-native responsibility at a time. Run focused correctness tests first, then one paired exploratory sample. Revert or discard losers; preserve only causal winners.
8. When all hard rows appear to win, repeat the five-sample confirmation ladder and the full relevant correctness/E2E suite on clean infrastructure.
9. Recommend the upgrade only if every hard requirement is proven. Otherwise retain Solid 1 and document the experiment result.

The next agent must not infer that this handoff authorizes infrastructure use, refactoring, or an upgrade decision; the current user must resume and approve the applicable gate.
