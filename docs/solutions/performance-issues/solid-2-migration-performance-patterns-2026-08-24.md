---
module: claxedo-app
date: 2026-08-24
last_updated: 2026-08-24
problem_type: performance_issue
component: assistant
symptoms:
  - Solid 2 lost 15 of 16 primary benchmark rows against the Solid 1 baseline
  - Solid 2 produced intermittent session-switch stalls between 1.819 and 2.182 seconds
  - Hot UI paths contain broad synchronous flushes and compatibility-shaped tracked effects
  - Large hidden session trees and globally invalidated stores retain and recompute unnecessary work
root_cause: wrong_api
resolution_type: migration
severity: high
related_components:
  - workbench
  - session-ui
  - reactive-state
  - async-data
tags:
  - solidjs-2
  - migration
  - performance
  - reactivity
  - stores
  - async
  - ownership
  - benchmarking
category: docs/solutions/performance-issues
---

# Solid 2 migration patterns for exceeding Solid 1 performance

## Problem

Claxedo's current Solid 2 branch is a research-stage migration, not yet a Solid 2-native architecture. It pins `solid-js` and `@solidjs/web` to `2.0.0-rc.1`, and also carries a local `@solidjs/signals` scheduler patch. Results from this branch therefore describe **RC1 plus local scheduler changes**, not untouched upstream Solid 2.

The central migration mistake is treating Solid 2 as Solid 1 with renamed APIs. Solid 2 changes the execution model:

- Writes are staged and normally commit on the next microtask.
- Async values participate directly in the reactive graph.
- Effects split tracked computation from untracked application.
- Stores use draft-first mutation and property-level tracking.
- Projections are the store equivalent of memos.
- Ownership, laziness, and unobserved cleanup control expensive work's lifetime.
- Actions and optimistic state represent user intent and server mutations.

The useful state model is:

| State shape | Writable | Derived |
| --- | --- | --- |
| Immutable value | Signal | Memo |
| Mutable structure | Store | Projection |

Around those primitives:

```text
Reactive reads                 -> pure derivation
User and server mutations      -> actions
Initial unavailable data       -> <Loading>
Replacement answer pending     -> isPending(expression)
Expected temporary state       -> createOptimistic / createOptimisticStore
Resource lifetime              -> owners, lazy computations, unobserved cleanup
```

Claxedo currently pays Solid 2's runtime and async-graph costs while retaining Solid 1-shaped compatibility structure: broad tracked effects, resource-like wrappers, global invalidation signals, immutable reducer output reconciled through multiple stores, keyed remounts, and many retained hidden component trees.

This document records observed evidence, research-backed patterns, and experiments. It does **not** claim that a production fix has been implemented or verified.

## Symptoms

### Observed benchmark evidence

- Solid 1 won 15 of 16 primary comparison rows in the original Solid 1 versus Solid 2 snapshot.
- Solid 2 produced seven valid session-switch stalls between 1.819 and 2.182 seconds; Solid 1 produced no switch above one second in that run.
- The comparison used only two repetitions, so it identifies investigation targets but cannot support a final framework verdict.
- The production main entry changed from 960,457 raw / 291,584 gzip bytes on Solid 1 to 968,103 / 294,066 on Solid 2, about 0.8%. That is too small to explain multi-second latency by transfer size alone.

### Observed application structure

- `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx` forces whole-session activation through `flush()`.
- `packages/claxedo-app/src/platform/runtime/session-switch.ts` defines `FAST_SESSION_SWITCH_NETWORK_QUIET_MS = 2_000`.
- The gate fans into hydration, SDK events, files, review, process, and session-selection work.
- `packages/claxedo-app/src/app/workbench/workbench/provider.tsx` maintains published and same-microtask scratch state.
- `packages/claxedo-app/src/app/workbench/state/provider.tsx` deep-compares and reconciles the resulting state again into the persistent store.
- `packages/claxedo-app/src/app/workbench/state/metadata.ts` bumps one global version on every mutation; `ids()` remaps all keys and `all()` rebuilds `Object.values(...)`.
- `packages/claxedo-app/src/app/workbench/rail/rail-workbench-canvas.tsx` can retain 24 complete hidden session trees for 180 seconds.
- `packages/claxedo-app/src/features/session/ui/session-screen.tsx` uses keyed boundaries that remount conversation and timeline owners when session keys change.
- `packages/claxedo-app/src/features/session/ui/message-timeline.tsx` already uses per-message `mapArray`, equality gates, and row reuse. Preserve that useful localization while improving whole-list indexes and remount behavior.
- Production scans found roughly 200 `createTrackedEffect` calls, hundreds of `storePath` calls, and more than 30 custom `createAsyncState` uses, while direct use of `createProjection`, shallow stores, lazy memos, `unobserved`, and `<Repeat>` was essentially absent.

### Evidence status

Observed:

- The broad activation `flush()` exists.
- The two-second Claxedo gate exists and aligns with the stall duration.
- The gate also existed in Solid 1, where this run did not reproduce the stalls.
- The Workbench has multiple representations and reconciliation layers.
- Global invalidation and retained hidden owner trees widen work and lifetime.
- RC1 has documented store, projection, pending, and transition issues.

Evidence-based hypothesis:

```text
Broad synchronous activation or RC1 store work
-> destination prefetch misses a readiness threshold
-> the existing 2,000 ms quiet policy delays required hydration
-> the user sees an approximately two-second switch stall
```

Not yet proven:

- That the gate alone causes every stall.
- That removing the activation `flush()` alone restores parity.
- Exact gains from projections, shallow stores, owner disposal, or code splitting in Claxedo.

### What “two-second gate enabled” and “disabled” mean

This terminology refers to Claxedo's `FAST_SESSION_SWITCH_NETWORK_QUIET_MS = 2_000` policy. It is not a Solid 2 feature, compiler option, benchmark warm-up, or pass/fail timeout.

`markFastSessionSwitch(sessionId, now, { networkQuiet: true })` enables the network-quiet portion by recording:

```ts
{
  sessionId,
  until: now + 250,
  networkQuietUntil: now + 2_000,
}
```

For the next two seconds, consumers of `fastSessionSwitchQuietDelay()`, `fastSessionSwitchAnyQuietDelay()`, and the corresponding `NetworkQuiet` predicates can defer, skip, or reschedule hydration, runtime resolution, reconnects, process work, review work, and other network/background activity. The intent is to keep unrelated work away from the visible switch.

`markFastSessionSwitch(sessionId, now, { networkQuiet: false })` disables only that two-second portion. It omits `networkQuietUntil`, so those consumers see no extra network-quiet delay beyond any explicit base delay. It still records the separate 250 ms `until` window, which suppresses stale session and route work during a rapid switch. Therefore “gate disabled” does **not** mean all switch protection is disabled.

The current activation path is adaptive rather than a single global toggle:

- Before first-fold prefetch for a newly opened session, it marks the switch with `networkQuiet: false` and starts the required message prefetch with `bypassQuiet: true`.
- It then enables the quiet window only when the first-fold message data is already fresh or the required prefetch is successfully ready/in flight.
- For already-open content, it enables quieting only when fresh message-prefetch data exists.

An enabled/disabled benchmark is diagnostic only. Disabling the policy changes application scheduling and cannot be accepted as a Solid 2 framework optimization in this experiment. If disabling it removes an approximately two-second stall, the result says the policy amplified a missed readiness threshold; the durable fix is to make required first-fold work start immediately and complete before quieting background work.

### Experimental upgrade contract

This branch earns an upgrade only if Solid 2 beats the frozen Solid 1 control without changing application behavior. The current hard contract is:

- Compare the same production web target, corpus, backend, browser protocol, schedule, and host conditions.
- Freeze the Solid 1 control, Solid 2 RC1 runtime and scheduler patch, lockfile, manifests, benchmark driver, harness, two-second policy, fixtures, cache policy, timers, pagination, retention, virtualization, and CSS.
- Permit only Solid 2-native reactive graph, ownership, store, effect, async, and batching refactors plus colocated correctness tests.
- Require all 20 candidate/control rows—the 16 published primary rows plus four switch-p95 rows—to beat Solid 1 by the configured noise buffer; the current target is a ratio of at most `0.99` for every row.
- Require zero valid switches above one second, complete observations and resource traces, matching identities, a clean in-scope diff, and no correctness regression.
- Run timed browser lanes serially on an exclusive host. Use parallelism for analysis, builds, and correctness shards, never for competing latency measurements.
- Use at least five paired confirmation samples, yielding ten alternating repetitions per target, before accepting a win.

The original comparison is prioritization evidence, not the final gate: Solid 1 won 15 of 16 published primary rows and 18 of the 20 hard rows after switch p95 was included. It also ran on battery with only two repetitions. A new isolated baseline and confirmation run are required.

### Rewind state for the active optimization run

As of 2026-08-24:

- The clean experiment worktree is `.worktrees/solid2-native-beat-solid1` on `optimize/solid2-native-beat-solid1`.
- Its base snapshot is `ff507c473fa166acfd35676277aa490ddc698582`; its measured-source setup commit is `1382cba82e133c8c5c403129dc525407f973bdcf` (`test(perf): parameterize paired web app identity`). No Solid 2 optimization experiment has been implemented in this worktree yet.
- The frozen Solid 1 control is `d631aad47c16f4d33e1dc64c3dfd3c5abbe3014b`. The benchmark-driver source is identical between the control and candidate.
- The immutable measurement contract lives at `.context/compound-engineering/ce-optimize/solid2-beat-solid1-v3/spec.yaml`; its wrapper is `measure.ts` in the same directory.
- CP0 contract validation passed: 23 hard metrics, 10 validity gates, and 18 diagnostics are defined and parse correctly. Parsing the historical result reproduced its published ratios and loss counts.
- The hard performance contract includes 20 candidate/control rows. Every ratio must be at most `0.99`; `solid1_rows_lost` and `switches_over_1000ms` must both be zero.
- The fresh CP1 baseline has **not** been completed. No valid paired sample or `experiment-log.yaml` exists. Do not generate, implement, or accept optimization hypotheses as benchmark winners until five fresh paired wrapper samples are persisted, aggregated by median, and explicitly approved.
- Do not measure the heavily dirty `.worktrees/codex-solid-2-rc` tree directly; it mixes the migration with extensive unrelated and in-progress changes.

#### Volatile AWS/Crabbox checkpoint

Re-inspect this state before reuse because retained leases expire. Do not persist private-key contents or rely on temporary SSH paths.

- The dedicated baseline lease is `cbx_9e6f32932efd` (`solid2-native-baseline`), an on-demand AWS `m7i.2xlarge` with 8 vCPU and 32 GiB in `eu-west-1`.
- Remote roots are `/mnt/benchmark/candidate`, `/mnt/benchmark/control`, `/mnt/benchmark/framework`, `/mnt/benchmark/playwright`, and `/mnt/benchmark/tmp`.
- The framework is frozen at `76a27191120092d3972aab08ec480d8028078de4`.
- The canonical corpus is `opencode-completed-sessions-v3`, digest `8807d1dd81afb33fc6b22b457c4353298d21697421b509f77cc28e7f353c9dfc`.
- The browser is Playwright Chromium v1228 / Chrome `149.0.7827.55`. The toolchain is Node `24.15.0`, Bun `1.3.14`, and Rust `1.93.1`.
- Framework registry validation, resource-monitor build, corpus verification, dependencies, package builds, and both production `build:local` runs passed.
- The Solid 1 production tree is `88,267,770` bytes; the Solid 2 tree is `92,777,949` bytes.
- Both driver handshakes passed. Their identical driver digest is `5c0c41cd92bb8c5fb9936ea4c15a3bae93677159b85472978faf6fe4bcd30c34`; the control and candidate build digests are `6d46e464082fca46e53e95a18fbc528028729c55449e81c85e6f9c26aee45940` and `7bf49d61c0dc64991347b4680b9455f0a6bd58743855024d6f8b9f8465ea9dd4` respectively.
- The candidate remote tree is clean. The control contains only the expected identical performance-harness source overlay. The framework contains only the two expected application registry files.
- Timed browser lanes must remain serial and host-exclusive. Parallel agents are appropriate for research, builds, analysis, and correctness shards, not competing latency or resource measurements.

#### Current CP1 stop point

No timed observation has completed, so there is no new Solid 1 versus Solid 2 result to interpret.

1. The first measurement attempt failed before application launch because `/mnt/benchmark/tmp` did not exist. It was created with mode `0700`.
2. The second attempt failed before application launch with `driver-handler-error: BuildMessage: ENOENT reading "/mnt/benchmark/control/packages/claxedo-server-core/node_modules/better-sqlite3"`.
3. Root `bun install --frozen-lockfile` succeeded, but the Linux workspace did not materialize the package-local native dependency path expected by the public corpus materializer. `claxedo-server-core` declares `better-sqlite3` directly, so the authoritative Bun workspace installation and linking topology is the next investigation point.
4. Do not repair this with synthesized artifacts, fallback loading, or an arbitrary benchmark-only symlink. Correct the canonical install/build path identically for both arms.

Resume in this exact order:

1. Inspect package-local and root `better-sqlite3` resolution in both remote arms and fix its canonical workspace materialization.
2. Run one complete paired wrapper and validate all 51 emitted values and all 10 gates.
3. If valid, run four more paired wrappers serially on the same exclusive host.
4. Persist raw samples, medians, variance, gates, diagnostics, identities, and clean-tree evidence to `experiment-log.yaml` before interpreting or presenting CP1.
5. Stop for explicit approval before generating or implementing isolated Solid 2-native optimization hypotheses.

## What Didn't Work

### Mechanical `batch()` to `flush()` migration

Solid 2 batches automatically. `flush()` forces affected reactive work to catch up synchronously. Replacing a Solid 1 batch with `flush()` moves propagation into the input path and can destroy staged-write composition.

### Wrapping complete navigation in `flush()`

Selection, Workbench mutation, prefetching, layout, URL replacement, and downstream effects all become part of one synchronous click task. A valid `flush()` should surround only the exact DOM read, focus, selection, or measurement that requires committed state.

### Using tracked effects as a default compatibility primitive

`createTrackedEffect` is specialized and cannot safely consume pending async state. Broad effects also hide graph width and encourage copying derived state instead of deriving it.

### Recreating `createResource` with signals and effects

`packages/claxedo-app/src/lib/async-state.ts` wraps async work in parallel `data`, `error`, `loading`, `refresh`, and `mutate` state. For cached server data, this duplicates the authoritative query/cache instead of putting its Promise into the Solid graph.

### Duplicating authoritative Workbench state

The published store, scratch cache, immutable reducer result, deep comparison, and final reconciliation create multiple representations of one responsibility. They compensate for staged writes instead of using one draft-first owner.

### Using global invalidation for keyed entities

Updating one metadata item wakes collection-level readers and reconstructs complete arrays, defeating property-level store tracking.

### Keeping full hidden applications mounted as a cache

Hidden session trees still own DOM, timers, query observers, timeline indexes, clients, and computations. Hidden is not frozen; Solid 2 RC1 has no production `<Freeze>` boundary.

### Deferring both essential and background work behind one timer

The two-second gate is a Claxedo prioritization policy, not a Solid feature or benchmark flag. A policy meant to protect first paint can postpone the request needed to produce first paint.

### Maximizing concurrency during latency measurements

Parallel agents and hosts are valuable for builds, correctness shards, and independent experiments. Performance runs sharing a CPU, browser, or host must be serialized to avoid contention. Parallelize preparation and validation, not competing timed browser lanes.

### Treating infrastructure failures as performance samples

Both current CP1 attempts stopped before application launch: first because the benchmark temporary directory was absent, then because the control workspace lacked the package-local `better-sqlite3` path expected by corpus materialization. Neither attempt contains a performance observation. Setup and dependency failures must be fixed at their canonical producer and recorded as invalid infrastructure runs, never interpreted as a framework regression.

## Solution

### 1. Let automatic batching work

Run one authoritative session-activation action, perform its related mutations, return the resulting content or navigation ID directly, and allow the staged writes to commit together on the next microtask.

Use `flush()` only immediately before an unavoidable imperative boundary:

```ts
const contentId = activateSession(session)

onSettled(() => {
  focusVisibleContent(contentId)
})
```

Do not reread a signal merely to rediscover a value the action just wrote. Return that value from the canonical action.

Audit every existing `flush()` individually. Pointer drag, focus, and layout measurement can be valid; navigation-wide flushing is the suspect.

### 2. Derive instead of synchronizing through effects

Use this preference order:

1. Direct function derivation.
2. Memo when reused, expensive, lazy, or requiring equality suppression.
3. Projection or function-form store for derived mutable collections.
4. Split effect only for a real imperative boundary.

For an external effect, track exact inputs and apply them untracked:

```ts
createEffect(
  () => [sessionId(), title()] as const,
  ([id, title]) => {
    externalWindow.setTitle(id, title)
    return () => externalWindow.release(id)
  },
)
```

Do not pass a broad store proxy into the apply phase and traverse it there. Do not write ordinary derived reactive state from an effect.

### 3. Make one draft-first store authoritative

Replace this compatibility path:

```text
immutable reducer
-> scratch state
-> published store reconcile
-> controlled onChange
-> deep comparison
-> persistent store reconcile
```

with one owner:

```ts
const openAndFocusSession = (input: OpenSessionInput) => {
  let contentId = ""

  setState((draft) => {
    contentId = ensureSessionContent(draft, input)
    focusContent(draft, contentId)
  })

  return contentId
}
```

Sequential mutations see the current draft before commit. No shadow store or same-task fallback should remain once the authoritative action owns the contract.

### 4. Choose stores and list identity by mutation semantics

- Use a deep store when nested fields are patched independently.
- Use `createStore(value, { shallow: true })` when complete server records are replaced.
- Use `markRaw()` for editor models, SDK clients, DOM objects, syntax trees, and other opaque objects.
- Use stable-ID `<For>` keying when a server or query layer rebuilds record objects.
- Use `createProjection` for filtered, reordered, selected, or async-derived collections that must preserve entity identity.
- Use `<Repeat>` for fixed count, range, or virtualized slots where list diffing is unnecessary.

Prefer an entity-local graph:

```text
workspace index
-> session projection keyed by session ID
  -> message projection keyed by message ID
    -> row-local property reads
```

Avoid one projection containing every session, message, and property ever materialized. On RC1, explicitly inspect `updateChildCompanions`: upstream issue #3038 reports 17.6 ms for a broad update versus 1.37 ms after splitting the graph per row.

### 5. Put async reads in the graph and keep the cache authoritative

The query client remains the authoritative keyed cache. Solid owns readiness and reactive dependency propagation:

```ts
const session = createMemo(async () => {
  const id = sessionId()
  const workspace = workspaceId()

  await transportReady()
  return queryClient.fetchSession({ id, workspace })
})
```

Read every reactive dependency before the first `await`.

- Initial missing value: use a narrow `<Loading>` fallback.
- Revalidation: keep settled UI visible.
- Pending replacement: optionally decorate the specific answer with `isPending` when the installed version supports the composition.
- Error: contain it in a narrow `<Errored>` boundary.
- Refresh: invalidate the canonical query rather than copied signals.
- Mutation: use an action and optimistic state.

`isPending` describes whether a particular reactive answer is settled. It is not generic network, saving, process, or retry state.

### 6. Use actions and optimistic state for mutations

Actions own mutation intent and consistency. Expected UI appears immediately, the server operation runs, and the canonical query reconciles afterward.

For an async-generator action, a bare `yield` after internal `await` re-enters the action transaction before subsequent writes. JavaScript does not provide ambient async context; do not assume post-`await` writes remain in the transaction.

Good optimistic candidates include message submission; session rename, pin, archive, and delete; process start/stop; and immediately expected composer or review state.

### 7. Keep inactive data warm, not complete hidden UI trees

Prefer:

- A fully mounted tree for the active session and, only if measured useful, a very small MRU set.
- Canonical cached data for inactive sessions.
- Narrow owners per session and pane.
- `{ lazy: true }` memos for transcript indexes, diffs, search, previews, and inactive panes.
- `unobserved` cleanup for streams, subscriptions, timers, observers, and large caches.
- Owner disposal as the authoritative teardown boundary.

This is the strongest route to beating Solid 1's long-run memory curve. There is no shipped production freeze primitive; hidden owners keep updating.

### 8. Separate first-fold work from background work

Required destination data must start immediately:

1. Read canonical cache or prefetch data.
2. Join an existing request if one is running.
3. Start a missing first-fold request immediately.
4. Keep the previous settled view or show the narrowest fallback.
5. Reveal the destination when required data is ready.

Only independent metadata, status, review, process, sidebar enrichment, and housekeeping work should be quieted. The durable fix is explicit priority and ownership, not simply deleting all throttling.

### 9. Beat Solid 1 startup through avoided work

Solid 2 has a larger minimum runtime floor because async and transition machinery are load-bearing. OXC improvements are build-time wins, not browser runtime wins.

A full application can still win by loading and constructing less:

- Code-split editor, terminal, review, graph, settings, and other inactive surfaces.
- Use lazy client-only loading where appropriate.
- Do not construct inactive providers and owner trees.
- Do not eagerly compute indexes or projections with no mounted observer.

Judge startup by executed JavaScript and mounted graph size, not bundle bytes alone.

### 10. Respect the RC1 versus `next` boundary

Status researched on 2026-08-24:

| Area | RC1 status | Guidance |
| --- | --- | --- |
| Automatic batching, split effects, async graph, actions, optimistic state | Present | Adopt the native model |
| Shallow stores and `markRaw` from #2931 | Present | Use for wholesale rows and opaque values |
| Single-home copy-on-write store from #3019 | Present | Prefer one authoritative store owner |
| Materialized child companion walk #3038 | Bug present; #3045 proposed | Localize projections and profile `updateChildCompanions` |
| Nested projection dependency registration #3037 | Fixed after RC1 | Upgrade or protect adoption with browser regressions |
| `isPending` through wrapper memo or `<Show>` #3028 | Fixed by #3030 after RC1 | Avoid this composition on RC1 |
| Conditional first use of `latest()` #3041 | Unresolved in RC1 | Avoid conditional first-use `latest` |
| Shared uninitialized async memo across transitions #3043 | Proposed fix after RC1 | Test rapid concurrent switches |
| Thousands of setter-plus-flush cycles #3044 | Open | Never force repetitive flush loops |
| DEV attribution, unstable-memo, and wide-write diagnostics | Added after RC1 | Use CDP/manual counters on RC1 |

Do not attribute a `next` fix to the installed RC1 runtime. Reassess on the next release candidate before making a final Solid 1 versus Solid 2 verdict.

### 11. Refactor and measure in isolated slices

1. Capture normal and stalled CDP session-switch traces.
2. Remove or narrowly relocate whole-session activation `flush()`.
3. A/B the two-second network-quiet gate.
4. Replace Workbench shadow, scratch, and double reconciliation with one draft-first action.
5. Make required destination first-fold work immediate.
6. Replace global metadata invalidation with keyed subscriptions.
7. Stop retaining 24 complete hidden session owners.
8. Convert read-only `createAsyncState` consumers to graph-native async reads.
9. Convert measured hot tracked effects to derivations or split effects.
10. Make timeline indexes lazy, incremental, or entity-local.
11. Introduce shallow row stores and stable-ID `<For>` keying.
12. Upgrade beyond RC1 before relying broadly on fixed projection and pending behavior.
13. Code-split inactive modules.
14. Re-run the same isolated benchmark after every slice.

Do not combine a runtime upgrade, architecture rewrite, and measurement-harness change into one result. Each slice should produce causal evidence.

## Why This Works

Solid 2's performance opportunity is work avoidance, not uniformly faster synchronous primitives.

```text
many action writes
-> one committed graph update

one canonical draft-first store
-> no duplicate representations
-> changed properties notify once

one changed message
-> one entity-local projection
-> affected rows only

inactive pane loses observers
-> expensive work goes cold or disposes
-> streams, timers, and caches release

destination requested
-> settled UI remains visible
-> only the changed answer is pending

user intent
-> optimistic result appears immediately
-> server action runs
-> canonical query reconciles
```

These patterns can surpass Solid 1 in switch latency by removing whole-graph synchronous work and two-second cliffs; in large-list updates by preserving entity and DOM identity; in retained memory by disposing unobserved graphs; in perceived mutation latency through optimistic actions; and in startup by not loading or initializing inactive features.

## Prevention

### Code-review guardrails

- Keep one authoritative producer per responsibility; do not retain shadow or synthesized fallback state.
- Do not copy one reactive value into another writable value through an effect unless there is a documented override contract.
- Keep the query/cache authoritative for server data.
- Assume writes commit on the next microtask.
- Never mechanically replace `batch()` with `flush()`.
- Require every `flush()` to name its exact imperative boundary.
- Return needed results from actions instead of rereading staged state.
- Prefer derivations; require justification for `createTrackedEffect`.
- Choose deep versus shallow stores from the actual mutation shape.
- Mark opaque values raw and preserve logical identity with stable keys.
- Capture async dependencies before the first `await`.
- Use actions for mutations and re-enter action context after async work.
- Keep first-fold and background work in separate priority classes.
- Record exact Solid versions and local patches in every report.

### Benchmark guardrails

- Use production builds and a fixed browser version, flags, viewport, fixture, hardware, and power mode.
- Warm up before recording and alternate Solid 1/Solid 2 run order.
- Use at least 10 valid repetitions for interaction claims and more for noisy startup measurements.
- Report median, p95, maximum, variation, and every switch above one second.
- Separate cold launch, warm launch, switch, steady-state update, and retained-memory measurements.
- Run latency lanes in isolation; parallelize builds and correctness shards, not competing browsers.
- Capture CDP traces for both normal and stalled switches.
- Mark action start, automatic commit, destination first paint, async settle, and background hydration.
- On RC1, inspect flush count/duration, long tasks, prefetch readiness, DOM creation, timers, and `updateChildCompanions`.
- Do not make a final framework verdict from the current two-repetition RC benchmark.

### Success criteria

- Zero unexplained switches above one second.
- Solid 2 p50 and p95 at or below Solid 1 on the target flows.
- No broad `flush()` around navigation or ordinary mutations.
- Required first-fold work is never delayed by background quieting.
- Selecting one session does not invalidate every session row.
- Inactive sessions retain cached data without retaining complete owner and DOM trees.
- Stable per-entity DOM identity survives collection replacement.
- Lower retained-memory growth across repeated switching.
- Correctness, failure, recovery, persistence, and isolation checks pass through real public entrypoints.

### Rewind checklist

When returning to this work, ask:

1. Is this value authoritative or copied from another reactive source?
2. Is an effect synchronizing state that should be derived?
3. Is `flush()` compensating for an unclear action contract?
4. Does this write invalidate one entity or an entire collection?
5. Does this list preserve logical identity with a stable key?
6. Does pending async work keep settled UI mounted?
7. Does inactive UI retain a complete owner tree unnecessarily?
8. Can this memo or projection be lazy and disposed when unobserved?
9. Are all async reactive dependencies read before the first `await`?
10. After an action's `await`, does mutation re-enter through `yield`?
11. Is the observed behavior Claxedo policy, RC1 behavior, or a Solid invariant?
12. What isolated benchmark or trace would prove the proposed cause?

## Related Issues

### Solid 2 design and documentation

- [Solid 1 to Solid 2 migration guide](https://v2.solidjs.com/migration/from-solid-1)
- [Avoid unnecessary effects](https://v2.solidjs.com/guides/avoid-unnecessary-effects)
- [Reactivity](https://v2.solidjs.com/concepts/reactivity)
- [Stores](https://v2.solidjs.com/concepts/stores)
- [Async reactivity](https://v2.solidjs.com/concepts/async-reactivity)
- [Boundaries](https://v2.solidjs.com/concepts/boundaries)
- [`<For>` keying](https://v2.solidjs.com/reference/solid-js/components-jsx/for)
- [The Road to Solid 2, discussion #2425](https://github.com/solidjs/solid/discussions/2425)
- [Solid 2 async system, discussion #2791](https://github.com/solidjs/solid/discussions/2791)
- [Solid 2 RC announcement, discussion #2995](https://github.com/solidjs/solid/discussions/2995)
- [Optimistic state and `flush`, discussion #3032](https://github.com/solidjs/solid/discussions/3032)

### Store and performance work

- [PR #2931: shallow stores, `markRaw`, and store hot paths](https://github.com/solidjs/solid/pull/2931)
- [PR #3019: single-home copy-on-write store](https://github.com/solidjs/solid/pull/3019)
- [Issue #3038: store companion-walk performance](https://github.com/solidjs/solid/issues/3038)
- [PR #3045: proposed companion-walk optimization](https://github.com/solidjs/solid/pull/3045)
- [Issue #3044: repeated setter-plus-flush performance](https://github.com/solidjs/solid/issues/3044)
- [Issue #2883: Solid 2 bundle/runtime audit](https://github.com/solidjs/solid/issues/2883)
- [Development diagnostics](https://github.com/solidjs/solid/blob/next/documentation/solid-2.0/08-dev-diagnostics.md)

### Async and transition correctness

- [Issue #2987: dependencies first discovered after `await`](https://github.com/solidjs/solid/issues/2987)
- [Issue #2913: action context after async boundaries](https://github.com/solidjs/solid/issues/2913)
- [Issue #3037: nested projection dependency registration](https://github.com/solidjs/solid/issues/3037)
- [Issue #3028 and PR #3030: `isPending` composition](https://github.com/solidjs/solid/issues/3028)
- [Issue #3041 and PR #3042: conditional first `latest()` read](https://github.com/solidjs/solid/issues/3041)
- [PR #3043: shared async memo transition fix](https://github.com/solidjs/solid/pull/3043)
- [Issue #2714: proposed freeze/propagation boundary](https://github.com/solidjs/solid/issues/2714)

### Claxedo investigation points

- `packages/claxedo-app/src/app/workbench/rail/rail-sidebar.tsx`
- `packages/claxedo-app/src/platform/runtime/session-switch.ts`
- `packages/claxedo-app/src/features/session/store/session-controller.ts`
- `packages/claxedo-app/src/app/workbench/workbench/provider.tsx`
- `packages/claxedo-app/src/app/workbench/state/provider.tsx`
- `packages/claxedo-app/src/app/workbench/state/metadata.ts`
- `packages/claxedo-app/src/features/session/ui/session-screen.tsx`
- `packages/claxedo-app/src/features/session/ui/message-timeline.tsx`
- `packages/claxedo-app/src/app/workbench/rail/rail-workbench-canvas.tsx`
- `packages/claxedo-app/src/lib/async-state.ts`
