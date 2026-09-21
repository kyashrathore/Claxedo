# Runtime recovery implementation — verification record

Tree: `~/test/opencode-recovery`, branch `refactor/runtime-recovery`, HEAD `8d5f006c09` plus the U8 commits this record accompanies. Branch base: `892ad3202c` on `dev`.
Machine: macOS 25.6.0, arm64, Bun 1.3.14. Every red below is classified against a detached throwaway worktree checked out at the branch base, with `bun install --frozen-lockfile` and the three dist-resolving packages (`claxedo-helpers`, `agent-runtime-contract`, `agent-event-runtime`) built, so the two trees resolve the same way.

The plan's §7 matrix is answered at the bottom. A row is `proven` only where a named test or command in this record passed; anything else is `partial` or `unmet`, with the reason.

## 1. Commands run

Each command was run from the package directory named, through that package's own script.

| Command | Where | Exit | Result |
|---|---|---|---|
| `bun run typecheck` | agent-runtime-contract | 0 | clean |
| `bun run typecheck` | agent-sdk-runtime | 0 | clean |
| `bun run typecheck` | workspace-runtime | 0 | clean |
| `bun run typecheck` | claxedo-server-core | 0 | clean |
| `bun run typecheck` | claxedo-host-serving | 0 | clean |
| `bun run typecheck` | claxedo-mcp | 0 | clean |
| `bun run typecheck` | claxedo-channels | 0 | clean |
| `bun run typecheck` | sandbox-manager | 0 | clean |
| `bun run typecheck` | claxedo-desktop | 0 | clean (`tsgo -b`) |
| `bun run typecheck` | cli | 2 | 3 errors — R-1 |
| `bun run typecheck` | opencode-server-adapter | 1 | 1 error — R-2 |
| `bun run typecheck` | claxedo-server | 1 | 3 errors — R-3 |
| `bun run typecheck` | claxedo-local-server | 1 | 4 errors — R-3 |
| `bun run typecheck` | claxedo-app | 1 | 0 TS errors; its `test:architecture` leg fails — R-4 |
| `bun run test` | agent-runtime-contract | 0 | 214 pass |
| `bun run test` | claxedo-server-core | 0 | pass |
| `bun run test` | claxedo-host-serving | 0 | pass |
| `bun run test` | claxedo-mcp | 0 | pass |
| `bun run test` | claxedo-channels | 0 | pass |
| `bun run test` | cli | 0 | 102 pass |
| `bun run test` | opencode-server-adapter | 0 | 55 pass |
| `bun run test` | sandbox-manager | 0 | 270 pass |
| `bun run test` | agent-sdk-runtime | 1 | 1078 pass / 6 fail — R-5, R-6, R-7 |
| `bun run test` | workspace-runtime | 1 | 1498 pass / 3 fail — R-8, R-9 |
| `bun run test` | claxedo-server | 1 | 3132 pass / 4 fail (295 files pass / 4 fail), 657 s — R-10 |
| `bun run test` | claxedo-app | 1 | 5923 pass / 24 fail — R-4, R-11, R-12 |
| `bun run test` | claxedo-local-server | 1 | 760 pass / 21 fail (81 files pass / 6 fail) — R-10, R-16 |
| `bun run test` | claxedo-desktop | 1 | 924 pass / 3 fail — R-17 |
| `bun run test:architecture-ratchets` | repo root | 1 | closure walker passes; helper-divergence ratchet reports 7 findings — R-13 |
| `bun run lint` | repo root | 1 | 288 errors — R-14 |
| `bun install --frozen-lockfile` | repo root | 0 | 2251 installs, no changes |
| `bun run verify:public-api` | agent-sdk-runtime | 0 | 4 pass |
| `bun run build` | agent-runtime-contract | 0 | built |
| `bun run build` | agent-sdk-runtime | 0 | built |
| `bun run build` | workspace-runtime | 0 | built |
| `bun test src/recovery.integration.test.ts --timeout 30000` | workspace-runtime | 0 | 9 pass, 99 assertions |
| `bun test src/server.test.ts --timeout 30000` | workspace-relay | 0 | 82 pass |
| `bun test ./scripts/runtime-recovery-smoke.test.ts` | claxedo-desktop | 0 | skipped — no server bundle, R-15 |
| `bun scripts/runtime-recovery-smoke.ts` | claxedo-desktop | — | **not executed** — R-15 |
| `bun run predev` | claxedo-desktop | 1 | blocked by R-2 and R-15 |

Base comparison runs (detached worktree at `892ad3202c`):

| Command | Exit | Result |
|---|---|---|
| `bun run test` (agent-sdk-runtime) | 1 | 939 pass / 6 fail |
| `bun run test` (claxedo-local-server) | 1 | 701 pass / 18 fail |
| `bun run test` (claxedo-desktop) | 1 | 891 pass / 3 fail |
| `bun run test` (workspace-runtime) | 1 | 1416 pass / 2 fail |
| `bun run test:architecture` (claxedo-app) | 1 | 254 pass / 6 fail |
| `bun run test:architecture-ratchets` (root) | **0** | passes |
| `bun run lint` (root) | 1 | 140 errors |
| `bun run typecheck` (opencode-server-adapter) | 1 | 2 errors |
| `bun run build` (opencode-server-adapter) | 2 | same 2 errors |

## 2. Every red, classified

### Pre-existing at `892ad3202c`

- **R-1 `cli` typecheck, 3 errors.** `src/commands/connect.test.ts:880,888,892` — a `fetch` double missing `preconnect`. Untouched by this branch.
- **R-2 `opencode-server-adapter` typecheck and build, `../agent-event-runtime/src/value.ts(42,3) TS2322`.** `value.ts` is byte-identical at base and HEAD and the error reproduces at base under both the old and the new `./harnesses/pi` export block (checked by restoring the old block and re-running `tsc -p tsconfig.build.json`). The cause is `Object.fromEntries` widening `V` to `V | undefined` in `boundKeyedRecord`, surfaced because the consumer compiles the dependency's source. At base this package reported **two** errors; the second, `TS2307: Cannot find module '@claxedo/agent-event-runtime/harnesses/pi'`, is closed by this branch's export fix.
- **R-3 `claxedo-local-server` / `claxedo-server` typecheck, 4 errors.** `browserOrigins` and `tasksGrants` are not on `StartLocalServerOptions`; `server-workspace-pty-proxy.ts:3` imports `connectEmbeddedWorkspacePty`, which `embedded-workspace-runtime.ts` stopped exporting on `dev` in `3b8650bfcb`. The importer is byte-identical at base.
- **R-4 `claxedo-app` architecture, 6 failures.** Identical set at base: `route-bridge.tsx` 821 > 800; `message-timeline.tsx` 2037 > 2018; the as-any justification scan; and the three unpinned debt metrics. Measured `directoryStringParams` 296 (base 298), `moduleScopeMutableState` 45 (base 45), `untrackCalls` 19 (base 19) — at or below base on every one, so the baseline is not touched. HEAD is strictly better than base here: base also failed on `session-controller.ts` 1152 > 1120, which HEAD no longer does.
- **R-5 agent-sdk-runtime, 3 of 6 failures.** `an ACP session/new logs the directory and ids, never the server headers`; `Claude SDK driver > keeps the query's input stream open…`; `the Claude turn input the driver holds open > carries a prompt sent mid-turn…`; `SdkRuntimeAdapter > a host-owned MCP child observation only binds the parent tool edge`. All four fail at base. Base additionally failed `agent-sdk-runtime public API manifest > reviewed value exports exactly match their source entrypoints` and `architecture ratchets > high-churn orchestration owners cannot grow`, both of which HEAD passes.
- **R-8 `workspace-runtime public API manifest > root runtime exports exactly match the manifest`.** `malformedEventStreamCursor` is exported from the root but absent from `docs/api-manifest.json`. `git log -S` puts the export in `e9e678acfa`, which is an ancestor of the base; the test fails at base.
- **R-9 `generateNotifyScript > reports failed delivery and sends a later completion again`.** Fails at base.
- **R-11 `claxedo-app` locale parity, 16 failures.** `session.requests.loadFailed` drift from `3b8650bfcb`; 16 failures at base.
- **R-12 `claxedo-app` workspace runtime route audit, 2 failures.** Same two at base.
- **R-16 `claxedo-local-server`, 18 of 21 failures.** The identical 18 fail at base, in five files: `daemon-admission.test.ts` (7 — the never-mounted middleware in §5), `first-party-mcp-tasks.live.test.ts` (4), `start-local-server.test.ts` (1, the `browserOrigins` option), `architecture/local-closure.test.ts` (1, closure 28 against a ceiling of 27) and `server-workspace-pty-proxy.test.ts` (5, the missing `connectEmbeddedWorkspacePty`).
- **R-17 `claxedo-desktop`, 3 failures.** The identical three at base: two spawn-inventory drift cases and `desktop server bundle emits the Agent Plugins route and activation authority`, which needs the bundle R-15 blocks.
- **R-15 the desktop server bundle cannot be built.** `bundleClaxedoServer` fails with `No matching export in "../claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts" for import "connectEmbeddedWorkspacePty"` — the same missing export as R-3, and `predev` first fails on R-2. Both blockers are present at base.

### Introduced by this branch

- **R-6 `agent-sdk-runtime` — `an owner that dies before using the identity leaves no payload` times out.** `src/launch/launch-gate.test.ts:505` awaits `setTimeout(…, 5000)` while the package's `test` script passes no `--timeout`, so Bun's default 5000 ms budget expires first. The test is new on this branch and cannot pass as written. `bun test src/launch/launch-gate.test.ts --timeout 20000` → **25 pass, 0 fail**, which is the proof and the fix: give that one test an explicit budget. Owner: the launch-ownership lane. This is a test-budget defect, not a product defect.
- **R-7 `CodexHarnessAdapter > disposes an app-server whose startup is still pending`.** Fails deterministically at HEAD (twice in a row) with `Timed out waiting for fake Codex process <pid> to exit`, and **passes at base** with the same test file present. A Codex app-server whose startup has not completed is no longer terminated when the adapter disposes. This is a live containment regression in the class the refactor exists to close, and the matching `claxedo-server` failure below is the same defect reached through a real composition. Owner: the Codex harness lane.
- **R-10 the launch gate child cannot run under a Node host, so session creation answers 500.** This is one defect reached from two packages: `claxedo-server`'s `session-env-document-roundtrip.integration.test.ts`, and the three `claxedo-local-server` `embedded-workspace-runtime.test.ts` cases that are the whole difference between that package's 21 failures here and its 18 at base. Every one reports `session_create_failed` / `Launch gate exited (code 1, signal null) before reporting a payload`.

  Root cause: `resolveLaunchGateChild()` (`agent-sdk-runtime/src/launch/launch-gate.ts:244`) hands back the TypeScript source when the package-subpath resolve does not land on dist, and `runnerFor` (`:306`) then spawns it as `node --import tsx <file>.ts`. `--import tsx` is a bare specifier, and Node resolves it from the **child's** cwd — which `spawnLaunchGate` sets to the payload's workspace directory, a user folder with no `node_modules`. Reproduced directly:

  ```sh
  cd "$(mktemp -d)" && node --import tsx \
    packages/agent-sdk-runtime/src/launch/launch-gate-child.ts --activation-deadline-ms 1000
  # Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx' imported from /private/var/.../
  ```

  `tsx` is not resolvable from `agent-sdk-runtime` either, so the same command fails from the package directory. Bun is unaffected: `runnerFor` returns no runner when `process.versions.bun` is set, which is why every bun-run suite passes and only the two vitest packages fail.

  Proof that nothing else is wrong: pointing the gate at the built child makes all 29 cases pass.

  ```sh
  cd packages/claxedo-local-server
  CLAXEDO_LAUNCH_GATE_CHILD=../agent-sdk-runtime/dist/launch/launch-gate-child.mjs \
    bunx vitest run src/deployments/local/embedded-workspace-runtime.test.ts
  # Test Files  1 passed (1) · Tests  29 passed (29)
  ```

  This is not only a test-environment artifact. Any Node host that resolves `@claxedo/agent-sdk-runtime` through a source-first condition gets a gate child Node cannot execute, and the only thing the caller sees is a 500 — the child's real error is discarded rather than attached to the refusal. Owner: the launch-ownership lane. Three things to fix: prefer the built child under a non-Bun host, resolve the TypeScript runner to an absolute path from the package that owns it rather than by bare specifier, and carry the child's stderr into `LaunchRefusedError` so this never again surfaces as a bare 500.
- **R-13 root `test:architecture-ratchets` — 7 helper-divergence findings; base passes with exit 0.** The closure half passes (`product boundary holds — 5 products, 8 policies`; `server-self-hosted` 124 modules / 41 packages, `desktop-main-composition` 94 / 26, `app-local` 1120 / 58). The 7 findings and the new definition site of each, established by diffing definition sites between the two trees:

  | Finding | New site |
  |---|---|
  | `decoded` 3 → 4 | `packages/workspace-runtime/src/client/request.ts` (`WorkspaceRuntimeCaller.decoded`) |
  | `errorText` 5 → 6 | `packages/workspace-runtime/src/opencode/harness-adapter.ts` |
  | `scopeKey` 2 → 3 | `packages/claxedo-app/src/features/session/store/accepted-prompt-refresh.ts` |
  | `tableColumns` 2 → 3 | `packages/workspace-runtime/src/ownership/launch-ownership-sqlite.ts` |
  | `text` 16 → 17 | `packages/agent-runtime-contract/src/recovery.ts` |
  | `isCreationIdentity` in 2 shipped files | `packages/claxedo-desktop/src/main/server-daemon-discovery.ts:146`, beside `main/diagnostics/process-metrics-worker.ts:96` |
  | `sameCreationIdentity` in 2 shipped files | `packages/agent-sdk-runtime/src/launch/identity.ts:186`, beside `claxedo-desktop/src/main/diagnostics/process-identity.ts:104` |

  The last two are the substantive ones: one concept — whether a pid is still the process that was launched — with two implementations across the authority boundary and the diagnostics boundary. The contract's §4 asks that observation stay distinct from authority, so the duplication may be deliberate; if it is, the two need names that say which is which. The baseline was **not** re-recorded, because re-recording is how this finding would stop being visible.
- **R-14 root `lint`: 288 errors at HEAD against 140 at base.** Both exit 1, so the gate was already red, but the branch roughly doubled it. The dominant rules are `no-unnecessary-type-assertion` (117), `no-unused-vars` (48), `no-floating-promises` (30) and `no-unsafe-type-assertion` (29). Seven of the new errors were in the U8 files and are fixed; the rest belong to the lanes that wrote them.

### Environment

None. Every red above is either a repository defect or a pre-existing one; no failure in this run was caused by the machine, the network or a missing credential.

## 3. Acceptance matrix (plan §7)

`proven` cites a test that passed in this run. `attributed` means a lane reported it and the suite containing it passed here, but this record did not isolate and re-run it. `unmet` names what is missing.

| Scenario | Verdict | Evidence |
|---|---|---|
| Session Stop arrives inside daemon drain | attributed | `local-daemon-lifecycle.test.ts` cancel-during-drain case, in a suite that passes. The packaged half is R-15. |
| Machine crashes after gating some workspaces | attributed | `reconcile-launch-ownership.test.ts`, `launch-ownership-sqlite.test.ts` |
| Remote lease reassigned while old containment is pending | partial | The generation half is proven — `recovery.integration.test.ts`, "a cancellation for a replaced turn is refused against the turn that replaced it, whose lease it never touches", and `recovery.test.ts`, "a lease that moved to another owner … is terminal for this owner". No remote authority was driven; the reassignment here is local. |
| Idle fast path while recovery is gated | proven | `agent-sdk-runtime/src/runtime/recovery.test.ts` — "a recovering session neither wakes its own waiters nor touches another session" |
| User-deployed old app meets upgraded authority | attributed | `local-app.ts` answers 426 `version_update_required`; covered by the local-server behaviour suite |
| Concurrent Stop from different callers/runtime instances | proven | `recovery.integration.test.ts` — "two runtime owners sharing one store root answer one request id with one operation, and the second owner hands back its receipt" |
| Recovery gate races a handed queue token | proven | `recovery.test.ts` — "a waiter whose lease acquisition fails hands the session to the next one" |
| Prepared launch without activation | proven | `launch-gate.test.ts` — full file passes at `--timeout 20000`, including "an owner that dies before using the identity leaves no payload" (R-6 is the default budget, not the behaviour) |
| Ownership persistence unavailable before PTY launch | attributed | `pty/identity.test.ts`, `ownership/launch-ownership-sqlite.test.ts`. Note R-10: when the launch **gate** cannot run, the refusal a caller sees is a bare 500 rather than the named reason this row asks for. |
| Emergency stop with blocked daemon and storage unavailable | **unmet** | Needs the packaged negative flow; R-15 |
| Delayed A cancellation arrives during B | proven | `recovery.integration.test.ts`, case (b) — refusal is `generation_conflict` with `current` = B, B's lease, status and harness untouched |
| Stop rejects while producer hangs | proven | `recovery.integration.test.ts`, case (c) |
| Provider never answers cancellation | partial | proven for a fake harness by case (c); no real provider was driven here |
| Permission projection/response fails | attributed | `store.test.ts` projection cases; `acp/permission-reply` tests |
| Process refuses TERM/KILL or descendants survive | partial | `acp/transport-retirement.test.ts` and `launch/retirement.test.ts` pass on macOS; Linux and Windows unmeasured |
| Crash during launch/ownership handoff | proven | `launch-gate.test.ts` — "an owner that dies before the acknowledgement leaves a reacquirable launch" |
| Finalization fails after accepted turn | proven | `recovery.integration.test.ts`, case (d) — no idle, degraded health, one reconciliation finishes the same turn once |
| Crash after terminal append / before lease release | attributed | `store.test.ts` — durable lease across two instances |
| Malformed or failed projection entry | proven | `recovery.integration.test.ts`, case (i) — the sibling session keeps answering; one rebuild repairs the projection and not the journal |
| Checkpoint interrupt cannot drain | proven | `recovery.integration.test.ts`, case (g) — 409 with the blocking turn named, and no checkpoint taken |
| First retirement fails, next succeeds | attributed | `claxedo-host-serving/src/runtime.test.ts`, `embedded-workspace-runtime.test.ts` |
| Impact changes after shared preview | attributed | `agent-runtime-contract/src/recovery.test.ts` scope-revision cases |
| Daemon synchronous event-loop stall | **unmet** | Needs the packaged app plus a disposable daemon; R-15 |
| Adopted daemon on macOS cannot be re-identified for signalling | partial | `daemon-recovery` unit coverage passes; the packaged half is R-15, and the architecture question is still a user decision |
| Non-owning route during storage outage | partial | Case (d) proves the owning route stays inspectable and refuses to claim a commit while the store is unwritable. A second, non-owning instance during the same outage was not driven. |
| Stale PID/discovery after restart | attributed | `server-daemon-discovery.test.ts`; the packaged half is R-15 |
| Lost Stop response / renderer relaunch | partial | The receipt half is proven — `recovery.integration.test.ts` case (f), and `workspace-relay/src/server.test.ts`, "answers an upstream that never replies with a transport failure, never a recovery outcome". The renderer-relaunch half is the UI lane's e2e, run in §9. |
| Healthy silent/background/approval work | **unmet** | Needs the packaged positive control; R-15 |
| Remote authority unavailable | attributed | `opencode-server-adapter` and ACP adapter cancellation tests |
| Queued B begins before A refresh | attributed | `session-controller.test.ts`, `accepted-prompt-refresh.test.ts` |

Four rows are unmet and all four have the same cause: the packaged desktop acceptance flow cannot run because the desktop server bundle does not build (R-15). The smoke that would answer them is written, typechecks and lints clean, and is committed at `packages/claxedo-desktop/scripts/runtime-recovery-smoke.ts`; it has never been executed.

## 4. Platform capability matrix

| Capability | macOS (measured here) | Linux | Windows |
|---|---|---|---|
| Creation identity for a pid | yes — `ps` start second plus boot time | unmeasured (`/proc` path exists in code) | unmeasured (CIM path exists in code) |
| Leader exit verified after TERM/KILL | yes | unmeasured | unmeasured |
| Descendants enumerated after retirement | **no** — a descendant that called `setsid` leaves the process group and neither platform offers an enumeration that finds it again; the result is `descendants: "unknown"` and the owner keeps the obligation | same limitation expected, unmeasured | unmeasured |
| Process-group containment | yes | unmeasured | not applicable — the code takes the `taskkill /T` path |
| Packaged desktop daemon recovery | **unmeasured** — R-15 | unmeasured | unmeasured |
| Real provider cancellation (Codex, Claude, Pi, ACP, Cursor) | unmeasured — every harness test here drives a fake | unmeasured | unmeasured |

## 5. User decisions owed

1. **macOS G6 scope.** Leader containment plus `(pid, start second, boot time)` identity is race-safe by allocator arithmetic, and descendants stay permanently `unknown`. Accept that, or approve a native addon or a different architecture.
2. **Linux and Windows are unqualified.** Neither was measured. This is an acceptance gap until a machine is available, not a claim that they work.
3. **Desktop machine-scope recovery view** was deferred by the UI lane.
4. **`daemonAdmission` has never been mounted.** `claxedo-local-server/src/app/daemon-admission.ts`, added on `dev` in `3b8650bfcb`, is not wired into any composition; a loopback page reaches `/api/claxedo/projects` with 200, and its seven "hostile page" tests fail at the branch base. Pre-existing and outside this plan's scope; it needs an owner.
5. **`connectEmbeddedWorkspacePty`** was removed from `embedded-workspace-runtime.ts` on `dev` while `server-workspace-pty-proxy.ts` still imports it. Restore the export or migrate the proxy — either way the desktop server bundle cannot be built until one of them happens.
6. **Helper divergence (R-13).** `sameCreationIdentity` and `isCreationIdentity` each have two implementations. Unify them under one owner, or name each for what it actually does; do not re-baseline them silently.

## 6. Removal audit

Run at HEAD over `packages/**/*.{ts,tsx,json}`, excluding `node_modules`, `dist`, `build`, `.turbo` and `.artifacts`:

```sh
grep -rnE '<pattern>' packages --include='*.ts' --include='*.tsx' --include='*.json' \
  | grep -vE '/(node_modules|dist|build|\.turbo|\.artifacts)/'
```

| Pattern | Hits | Verdict |
|---|---|---|
| `turns\.abort` | 0 | gone |
| `session\.abort` | 2 | `opencode-server-adapter/src/adapter.ts:267,269` — the label and path of the **upstream OpenCode engine's** own API, reached through the new `cancelTurn`. Not Claxedo's route. |
| `"/abort"`, `/session/:id/abort` | 3 files | the same upstream adapter and its fake, plus `workspace-runtime/src/routes/session-recovery.test.ts`, whose `test("the abort route is gone")` asserts 404 |
| `AbortResult`, `AgentRuntimeAbortResult`, `SupportsAbort` | 0 | gone. `ChannelAbortResult` in `claxedo-channels` survives by name only — it wraps a `RecoveryOutcome` from the new contract. |
| `completeCancellation` | 0 | gone |
| `admissions.discard` | 0 | gone. `registry.discard` in `runtime/recovery.ts` is the new target-and-action-scoped registry, not the removed session-scoped call. |
| `useLaunchOwnership` | 0 | gone |
| `stopUnhealthyPublishedDaemon` | 0 | replaced by `recoverPublishedDaemon` |
| `POST /shutdown` daemon route, `requestShutdown` | 0 | gone. `daemon-exit-lifecycle.ts` now calls `stop()` (lease release) on a handoff and `drain()` (a real `drain_daemon` submission) on a quit; no caller of the deleted route survives. |
| optimistic idle | 0 on the Stop path | `submit-abort.ts` reads canonical status and writes `source: "server"`. The two surviving optimistic writes — `submit/send.ts:65` (send-failure) and the dispatcher's optimistic-meta helper — are byte-identical at base and outside this plan's scope. |
| `catch(() => {})` around cancellation/retirement in `harnesses/**`, `pty/**`, `managed-processes/**`, `routes/session*` | 0 on ownership persistence | `pty/index.ts` now awaits `recordRetirement` and `recordIdentity` plainly. The `catch` sites that remain in those directories are documented unhandled-rejection guards whose result is read elsewhere, or telemetry. Three lease-release and `after()` swallows in `routes/session-core.ts` are byte-identical to base. |
| `exitCode ?? 0` | 1 | `sandbox-manager/src/drivers/box.ts:232` — a Box response that omits `exitCode` becomes success. Pre-existing, unrelated to recovery, and worth its own fix. |
| `exitCode \|\| 0` | 0 | gone |
| `Promise.race` used as cancellation of a transport request | 3, all correct | `sdk-runtime-cancellation.ts:44` and `acp/cancellation.ts:66` return `execution: "running"` with `cancellation_timeout` on loss; `runtime/recovery.ts:254` returns `{ status: "pending" }`, an explicit unknown |
| feature flag or compat branch keeping old behaviour | 0 | `compat-events.ts` is the provider-to-canonical normalizer the plan permits; the `fallback` hits in this domain are a parameter name for a default error **code** |
| `bun run check:package` (agent-sdk-runtime), `bun run verify:public-api` | exit 0 | manifest clean; its only cancellation-domain entry is `RecoveryOperationIdCollisionError` |

## 7. Deployment and forwarding inventory

Read and verified, not re-implemented. Every hop preserves method, path, query, request body, response status and response body on the success path:

- `claxedo-server/src/deployments/self-hosted-node/app.ts` dispatches `/session/**` through the `/session` prefix rule in `claxedo-server-core/src/platform/governance/route-ownership.ts:149`; no rule names `recovery` or `abort`, so no ownership change was needed. The embedded hop (`claxedo-local-server/.../runtime-dispatch/internals.ts:447-485`) and the forward hop (`:239-369`) both stream the body and re-emit the upstream status verbatim.
- The hosted compositions (`hosted-shared/*`, `hosted-workerd/core-worker.cf.ts`) mount no session routes at all; hosted clients reach recovery through the relay.
- `claxedo-server/src/session/machine-dispatch.ts:308` returns the upstream `Response` unwrapped. `channels/control-plane.ts:180,188` submits recovery through it.
- `workspace-runtime/src/cli.ts` serves all three recovery routes through the same `createSessionRoutes`; the refusal-to-status table lives only in `routes/session-core.ts:1154-1163` and includes 410 `receipt_expired`.
- `workspace-relay`: `git diff 892ad3202c...HEAD -- packages/workspace-relay` and the same for `workspace-relay-protocol` are both **empty**. `TUNNEL_PROTOCOL_VERSION` is still 1. Nothing bumped a protocol version because a forwarded body changed. The one bump on this branch is `CLAXEDO_DAEMON_PROTOCOL` 1 → 2, which carries a real shape change: the discovery record gained `identity`, requests carry `x-claxedo-daemon-protocol`, and mismatches answer 426.

One gap is now pinned rather than latent: ten relay and proxy failure paths synthesize `{error:{code,message}}` under statuses a caller reaches by decoding every non-200 as a `RecoveryOutcome` (`routes/session-core.ts:1211`). `workspace-relay/src/server.test.ts` now asserts that a 504 `upstream_timeout` and a 503 `upstream_unavailable` are transport failures and carry no `kind`, alongside byte-for-byte forwarding of a `POST .../recovery` body and a 409 refusal. A second preservation caveat, unchanged by this branch: `claxedo-server-core/src/workspace/http/workspace-runtime-client.ts:214-231` discards a **GET** `.../recovery` that answers ≥500 and re-dispatches against a fresh generation; POST is never retried.

## 8. Cross-lane incidents, for attribution only

Nothing below lost work; each is recorded so the history reads correctly.

- A no-op `git stash push` followed by `git pop` applied `dev`'s `stash@{0}` into the worktree (81 conflicts), reversed from stage 2. Nothing was lost.
- Six orphaned launch-gate children were observed. The gates were behaving correctly — an activated gate outlives a dead parent by design — but two tests leaked payloads; fixed in `87c5203e36`.
- Three commits swept files belonging to another lane: `2a8d6302db` (store hunks), `a22e72a4f8` (desktop diagnostics files), `51bb40f5cd` (one import). Attribution only.

## 9. The recovery e2e suite

Run here, not carried from a report:

```sh
cd packages/claxedo-app
VITE_CLAXEDO_SETTINGS_CONNECTIONS_ENABLED=true CLAXEDO_E2E_SUITE=core \
  npx playwright test --config playwright.config.ts \
  e2e/playwright/core-busy-abort-errors.spec.ts --workers=1 --retries=0
```

Exit 1 — **16 passed, 3 failed** in 3.6 minutes, which reproduces the UI lane's reported 16/19 exactly, including which three fail:

- `Thinking stays painted until the follow-up reply begins`
- `Thinking stays with the new prompt while the previous turn's completion envelope is in flight`
- `a message sent mid-turn joins the running turn instead of stopping it`

The lane attributes the two `Thinking` failures to running with transcript reconstruction disabled rather than to isolation, and `mid-turn joins` to the branch base. Neither attribution was re-derived here: the base tree has no built e2e application, so a base e2e run was not attempted. The thirteen recovery-specific specs in this file — among them `a Stop still in flight keeps the last execution the runtime reported`, `a cancellation the harness never answered leaves the turn running and offers recovery`, and `a turn that ended but was never written down says so, and does not claim the transcript changed` — all pass.

## 10. Residual gaps

- The packaged desktop acceptance flow is unexecuted (R-15), which leaves four §7 rows unmet.
- No real provider was driven: every harness test in this run uses a fake.
- Linux and Windows are unmeasured for every process-ownership capability.
- R-6, R-7, R-10, R-13 and R-14 are branch-introduced and open. R-7 and R-10 describe product behaviour rather than a test or a ratchet, and R-10 is the one a user would meet: session creation answering 500 on a Node host.
- Three e2e specs fail (§9); two are attributed to a disabled reconstruction path and one to the branch base, and neither attribution was re-derived here.
