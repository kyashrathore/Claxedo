---
title: Pi Durable and Boat review by Claude Opus 5.5
date: 2026-10-03
status: reviewed
reviewer: claude-opus-5-5
effort: high
---

# Pi Durable and Boat: Claude CLI review

Requested review of the [active HLD](../architecture/pi-durable-boat-hld.md) and [implementation plan](../plans/2026-10-02-2031-feat-pi-durable-boat-plan.md). The superseded Cloudflare plan was excluded from the review.

## Run provenance

- CLI: `2.1.287 (Claude Code)`. Requested model: `claude-opus-5-5`; requested effort: `high`. All reviewer assistant messages confirmed that model.
- Review started on `dev` at `e7955cd10a5f2d3adec130bba7964e46289269d0`. A concurrent branch switch ended on `codex/fix-desktop-quit-lease` at the same commit; the observed tracked change was an unrelated desktop test. The reviewed documents were uncommitted; their SHA-256 values below identify the exact inputs.
- Result: success, process exit 0, 926.67 seconds, no permission denials.
- Available tools were Read, Glob, Grep, WebFetch and WebSearch. No command execution, file editing, delegates or MCP tools were available to the reviewer. The CLI also reported Haiku usage for auxiliary web tooling; the reviewer itself was Opus 5.5.
- The HLD, implementation plan and superseded draft matched their original hashes after the review. No production files were changed. No application tests or live-provider acceptance were run.
- The CLI findings below retain their original priorities and recommendations. One long external quotation was paraphrased. Codex verification notes follow separately. Corrections had not been adopted at review completion; the dated documentation follow-up below records the subsequent revision.

Exact invocation, with the review prompt supplied on stdin:

```sh
claude -p --model claude-opus-5-5 --effort high --output-format stream-json --verbose --safe-mode --strict-mcp-config --disable-slash-commands --no-chrome --no-session-persistence --permission-mode dontAsk --tools Read,Glob,Grep,WebFetch,WebSearch --allowedTools Read,Glob,Grep,WebFetch,WebSearch
```

| Input | SHA-256 |
|---|---|
| `docs/architecture/pi-durable-boat-hld.md` | `68c75138336395cb09c272592760dff3ee76dd644f8a5235c6de08466e861ecf` |
| `docs/plans/2026-10-02-2031-feat-pi-durable-boat-plan.md` | `febef84e8af7c949288d7a28fafbb6b595501e910d81550e168f918a5dee34d3` |

## Claude review

## Verdict

- **U1: ready to start, but its scope needs widening first.** The gates G1–G4 are the right kind of gate. Three of them can't settle the properties they're meant to settle without design decisions the documents haven't made (findings 1–3). U1 should carry those decisions so its evidence actually answers them.
- **Full implementation and release: not ready.** Four P1 problems show up in concrete failure sequences against the current code and the official provider docs:
  - The design doesn't integrate with the existing CP turn lease, grant and credential authority.
  - Pi Durable's built-in crash behaviour defeats R10's "pause".
  - Boat's command API has no idempotent start and no kill.
  - Archiving the VM can race with a session starting new work, and nothing fences them.

  The 16–25 day estimate isn't credible for the scope the documents define.

## Findings

### P1-1 — The proposed "host generation" authority ignores the existing turn lease, grant and credential authority

**Where in the documents.** HLD `pi-durable-boat-hld.md:120, 126, 130, 213, 222`. Plan `2026-10-02-2031-feat-pi-durable-boat-plan.md:234, 268, 306–308`.

**What the code does today:**
- **Turns need a CP lease.** A managed prompt takes a lease in CP's `session_turn_leases` table. The fencing token increments whenever an expired or released lease is re-acquired (`session-authority.ts:596–654`). The lease TTL is 60 s (`workspace-relay-protocol/src/index.ts:5`).
- **The lease lives in memory.** Renewal and expiry run on in-memory `setTimeout`s, and the lease proof is held only in memory. When the lease is lost, `onLost` aborts the turn (`session-core/src/routes/session-turn-lease.ts:58–206`).
- **Re-acquiring needs a proof.** That proof is a Relay Host Token, an owner grant, or a deferred grant (`runtime-session-authority.ts:464–592`). Deferred grants exist only for `child_completion` and `queued_prompt` (`0001_baseline.sql:554`, `session-access-policy.ts:65`).
- **Model credentials are tied to the same chain.** They are served only to a Relay Host Token with `backing: "cloud-vm"` or to a turn lease (`runtime-connection-secrets.ts:43–84`).
- **Queued prompts carry a provenance.** They are re-issued only for `relay-replayed` or `loopback-direct` (`delivery-owner.ts:249–253`), and grants are minted only for `relay-replayed` (`session-prompt-admission.ts:150–152`).

**What the documents propose:** a new "root-host generation", stored in D1 and bound into tickets. A fresh "fence" is claimed on every DO restart. A service binding authenticated by that generation resolves the stored owner. None of this mentions `session_turn_leases`, grants, or the credential-lease proof chain.

**Failure sequences:**
1. **Long approval wait.** A turn waits hours for an approval. Pending timers are not among the things that keep a DO active (Cloudflare lists requests, RPC, response streams, WebSockets and pending I/O; [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)). So the DO is evicted:
   - the in-memory lease proof is gone;
   - the CP lease expires;
   - the answered approval has no proof to re-acquire the same turn.

   The result is either a containment cancel (contradicts R8) or a new authority that bypasses the lease.
2. **Revoked sender.** A sender's share is revoked mid-turn. Today, renewal re-checks `requireSessionAccess(actor, …, "agent_turn")` and fails, which contains the turn. Under HLD:130, CP checks only the host generation and the owner. The revoked sender's turn keeps running and keeps spending the owner's account, which violates R5.
3. **Routine restarts.** If the restart "fence" (HLD:222) is the same thing as the ticket-bound generation (HLD:126), every idle eviction or deploy invalidates all live tickets and costs a D1 write per wake-up. If the two are different, the documents don't say what the restart fence actually guards: Boat has no fencing input, and CP already has one (the lease's fencing token).

**What the plan already covers:** it intends to change `private-session-authority.ts` and `runtime-access-token.ts`, and it says an expired browser ticket must not halt continuation.

**Smallest correction (decide in U2, prove in U1/G3):**
- Make the CP turn lease's fencing token the per-session turn fence. Persist the lease proof in DO storage.
- Add a durable-continuation grant intent, minted at admission and bound to (session, turnId, actor). A reset DO redeems it with `turn_acquire` for the same turn, under the original actor's *current* access.
- Have the connection-secrets route accept that lease.
- Define what happens to the lease while a turn is parked (release, then re-acquire via grant when woken). Drive renewal from alarms, not timers.
- Give CP-dispatched requests their own provenance value so queued prompts can be re-issued.
- Treat "host generation" as at most a re-placement epoch, not a per-activation value.

### P1-2 — Pi's crash semantics let the model repeat a mutation, which R10 forbids

**Where.** HLD `:226, :235`. Plan `:270, :282`. G1 at HLD `:285`.

**Evidence ([Pi 1.0.0 README](https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/README.md)):**
- Pi retries an interrupted tool only when its registration declares `replay: "safe"`; other calls produce an interruption result containing already-committed output.
- `resume()` starts the task scheduler for the whole harness. No per-conversation hold is documented.

**Failure sequence:**
1. The DO resets while `bash "npm publish"` (or `git push`) is in flight.
2. Recovery calls `resume()`. Pi commits an `interrupted` result itself and keeps the model loop going.
3. The model re-issues the same command under a new tool-call ID.

The plan says this must not happen but names no mechanism. Pi's default does exactly this.

**Smallest correction:** Declare the Boat-backed mutating tools `replay: "safe"`, where "replay" means reconciling against the Claxedo operation journal, keyed by Pi's tool-call ID, and never re-dispatching. If the dispatch was never acknowledged, the replayed `execute()` blocks on reconciliation or an authorized decision. Make this an explicit G1 acceptance case. G1 also needs to prove that a blocked replay doesn't stall unrelated tasks or the alarm budget.

**Uncertainty:** the README does not document how a replayed execution can park.

### P1-3 — Boat has no idempotent command start and no kill, so G2 can't establish safe cancellation or reconciliation "using the actual Boat API"

**Where.** HLD `:233, :240–242, :260, :288`. Plan `:74, :116, :189`.

**Evidence:**
- Command execution accepts `command, cwd, timeoutSeconds (1–600, default 30), detached, stream`. There is no client request or idempotency ID ([execute](https://docs.boat.dev/api/reference/agent/execute-sandbox-command)).
- A detached start returns its `processId` only in the response.
- Status is `running | exited | lost`, and `lost` is described as a "best-effort probe". No kill or signal endpoint is documented ([status](https://docs.boat.dev/api/reference/agent/get-command-status)).

**Failure sequences:**
- **(a) Lost start response.** A detached start's response is lost, so there is no `processId` and no way to look the command up. The turn is permanently "unknown". With TTL disabled (HLD:184), that unknown work blocks idle archive indefinitely, and the VM stays billed until a human acts.
- **(b) Stop can't stop a command.** The user presses Stop on a running `npm run dev`. There is no way to terminate it, and session-core finalizes a cancel only on `execution === "terminal"` (`host/recovery.ts:321–334`). The session stays busy and its queue stays blocked until the command exits or the whole VM is stopped, which affects every root.

**Smallest correction:** Decide in U1 that Pi shell and process execution goes through the guest execution service the plan already introduces for the PTY (plan `:74`, U7). That service would provide:
- a start keyed by an operation ID that Claxedo supplies (idempotent);
- status by operation ID;
- process-group kill;
- a generation stamp on every operation.

Use Boat commands only to bootstrap and health-check that service. This moves the service's dependency ahead of U3/U5, which changes the delivery graph at plan `:86–97`. If this is rejected, the documents must state the product limits explicitly: Stop of a running command becomes "termination unknown" or a whole-VM archive.

### P1-4 — Archiving the VM can race with new execution; nothing fences them

**Where.** HLD `:182, :200` ("Ready → Archiving: Idle policy and no owned work"). Plan `:191, :206`.

**What the code does today:**
- `SandboxManager` serializes stop and ensure through an in-memory per-instance map (`manager.ts:214–226`). In a CP Worker, each isolate and the cron sweep get their own map.
- `stop()` checks only `target.status === "ready"` before suspending (`manager.ts:543–556`).
- `ensure()` on a ready lease calls `provision` again (`manager.ts:468–471`).
- Session DOs will dispatch to Boat directly using a cached binding.

**Failure sequence:**
1. The sweep in isolate Y reads "no live activity".
2. DO A acquires activity and dispatches a quiet command.
3. Y calls Boat stop. The command dies.
4. A's operation becomes `lost`/unknown, even though the policy was supposed to block exactly this.

**Smallest correction:** Put both transitions behind D1 conditional writes:
- `ready → archiving` succeeds only for the current epoch and only when no live activity rows exist;
- acquiring activity inserts a row conditioned on `status = 'ready'` and the same epoch;
- a DO must hold its row *before* it dispatches anything, and must treat a refused or failed acquisition as "wait for resume".

Add the interleaving above as a U3 test. This doesn't depend on the in-memory lifecycle map.

### P2-1 — One statically selected sandbox driver per deployment conflicts with "existing placements continue under one lifecycle owner"

**Where.** HLD `:15, :103, :110`. Plan `:75, :182`.

**Evidence.**
- `CLAXEDO_SANDBOX_DRIVER` must exactly match the single injected driver (`provider-neutral-hosted-services.ts:156–183`).
- `hostedSandboxDriver` builds exactly one of Cloudflare or the fetch bridge (`hosted-sandbox-driver.ts:66–94`).
- `sandbox_leases.driver` exists but isn't used for dispatch.

**Failure:** A deployment that serves existing Cloudflare-Sandbox `cloud-vm` workspaces and switches its driver to Boat breaks those leases. The alternative, a second manager, is a second lifecycle owner.

**Correction:** In U2/U3, decide that the one manager dispatches by `lease.driver` with per-driver policy, or explicitly scope V1 to deployments that run only Boat.

### P2-2 — Pi's file-mutation queue is shared across DOs on workerd, not "local to one runtime"

**Where.** HLD `:168, :170`. Plan `:193`.

**Evidence.**
- The queue is a module-level `Map` keyed by `env.id` and path ([Pi source](https://github.com/earendil-works/pi/blob/v1.0.0/packages/durable/src/tools/file-mutation-queue.ts)).
- "A single isolate can host multiple Durable Objects of the same class … they all share that isolate's memory" ([CF in-memory state](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)).

**Failure:** HLD:168 requires the env ID to identify the shared filesystem. Two co-resident root DOs then chain edits on the same file across DO contexts. If one DO resets mid-edit, the other may wait on a promise from a dead context.

**Uncertainty:** I didn't verify the cross-context hang behaviour.

**Correction:** Use a DO-unique `ExecutionEnv.id`, since the documents don't promise cross-session serialization anyway. Add a co-resident-DO case to G1.

### P2-3 — "Activity" is undefined for processes Claxedo doesn't track, and unknown outcomes have no bound

**Where.** HLD `:39 (R11), :182, :184`. Plan `:191, :205`.

**Gaps:**
- `npm run dev &` started through bash, or a dev server left running in a terminal, is not an admitted operation. One policy reading pins the VM forever; the other silently kills the server at idle.
- Terminal and preview leases held by a CP isolate that dies are never released. The rule that "an expired heartbeat is not proof" leaves no defined resolver for them.
- Boat's stop "saves the sandbox's disk first" and processes don't survive stop ([platform guide](https://docs.boat.dev/platform-guide), [lifetime](https://docs.boat.dev/long-running-tasks)). So a confirmed archive is itself proof that processes ended, though not proof of what their effects were.

**Correction:**
- Define what counts as quiescent separately for tracked operations, interactive leases, and untracked guest processes.
- Let heartbeat expiry resolve interactive leases.
- Add a bounded unknown-outcome policy: after a deadline, escalate to an owner-visible archive, recorded as "terminated, effects unknown".

### P2-4 — Workspace-scoped runtime routes without a session have no owner; CP-over-Boat would duplicate workspace-runtime logic

**Where.** HLD `:134`. Plan `:80, :310`.

**Evidence.** The current frontend calls these workspace runtime routes before or without a session:
- `/api/wr/harness-config-options` for draft model options (`claxedo-app/src/server/harness-options.ts:26–28`);
- `/permission/modes`, harness commands, `/pty/agents`, terminal hooks (`terminals.ts:88–93`).

The HLD gives owners only for lists, files and Git. If file, Git and search are reimplemented at CP over Boat's command API, that's a second implementation of the Node logic in workspace-runtime, which runs against AGENTS.md's one-implementation rule.

**Correction:** Name an owner for each route in U2. Prefer hosting the file/search/Git routes inside the guest execution service (shared with PTY and P1-3) over porting them to CP.

### P2-5 — Preview origin granularity is unspecified

**Where.** HLD `:178`. Plan `:353`.

**Failure:** If one preview origin is shared across workspaces and uses a cookie bootstrap, hostile preview JavaScript from workspace A can read workspace B's previews with the same user's cookie.

**Correction:** Use a per-workspace (or per-workspace-and-port) origin with host-only credentials bound to that origin.

**Related scope issue:** no hosted preview feature exists today. The only match is `localPreviewUrl` in `claxedo-app/src/transcript/local-preview.ts`, and plan `:346` refers to "existing preview/exposure callers" that don't exist. Previews are a net-new surface: UI, gateway, DNS and certificates.

### P2-6 — The guest's own Boat credential can run Boat's hosted agent and publish ports

**Where.** HLD `:256`. Plan `:127`.

**Evidence.** The in-sandbox credential "can prompt, exec, read and write files, SSH, desktop, host, and snapshot itself" ([API keys](https://docs.boat.dev/api-keys)). The docs don't say whether `noEnv` suppresses it, or who is billed for its prompts.

**Failure:** Hostile guest code can spend the platform's Boat account on hosted-agent prompts, or publish public `*.on.boat.dev` ports under the platform's account.

**Correction:** Add these checks to U1/G3: does the credential exist under `noEnv`, can it be disabled, who is billed, and can it host ports. Then set a refuse-or-accept policy.

### P3 (brief)

- **Restart gating.** HLD `:222–227` orders reconciliation before serving. The existing DO fixture runs store-wide `recoverBusySessions()` inside `blockConcurrencyWhile` on every cold start (`test-support/durable-object-host.ts:89–92`, `store.ts:1336–1343`).
  - Awaiting Boat or CP inside that gate blocks reads and Stop, and Cloudflare resets the object after 30 s ([state API](https://developers.cloudflare.com/durable-objects/api/state/)).
  - `recoverBusySessions` also clears all turn leases and interrupts every busy session regardless of transport, so the transport-specific recovery branch has to live in `store.ts`.
  - Plan `:263` cites `host/…store.ts`; the file is actually `src/store.ts`.
- **Child vs fork in CP.** CP records both children and forks as `operation_kind = 'fork'` (`0001_baseline.sql:508–522`, `session-authority.ts:238`). U2's root binding needs an explicit child/fork discriminant at reservation.
- **Terminal scope.** "Workspace-level terminals without a session" (HLD `:174`) contradicts the current remote contract, `terminal_session_required` (`terminals.ts:39–43`). R5 says followers get "no terminal" access, but today a follower's `pty_read` passes session read. Pick one rule for each.
- **CP list freshness.** HLD `:134` relies on CP lists, but no producer publishes DO title, status or awaiting-input into `sessions` (`host-session-rows.ts` covers enrolled hosts only).
- **Credential rotation.** Rotating a Boat scoped key "immediately revokes the old secret", which hits every root at once. Prefer overlapping issuance.

## Open feasibility questions (not defects)

- **Pi on DO SQLite.** Can Pi's async transaction facade be built over DO SQLite (`transactionSync` can't span awaits)? Does Pi expose a stable committed-entry identity to use as a cursor? The README documents no sequence or IDs, and its `watch` coalesces after 100 frames.
- **CPU and eviction.** "More than 30 seconds of compute between incoming network requests" raises the eviction risk, and alarms get 15 minutes of wall time. Can Pi's scheduler yield to alarms within those budgets?
- **Outgoing connections.** The limit is 6 simultaneous outgoing connections. Can parallel children, model streams and Boat streams stay under it while still leaving room for a Stop?
- **Deploys.** Does deploying the session-host Worker reset every active DO? I didn't verify this. If it does, A3 should include a deploy mid-turn.
- **Boat command details:**
  - what `timedOut` does to the process;
  - whether `processId` is unique across agent restarts and resume;
  - whether file PUT supports conditional writes or binary content.
- **Boat hosting:** WebSocket support, and how the `_token` query parameter behaves for sub-resources and HMR.

## What held up, and the estimate

**Design choices that held up against the code:**
- One DO per root, routed by CP's binding, with Pi-owned children kept co-resident.
- No workspace DO.
- CP stays a Worker with direct DO bindings.
- Session readiness is separate from VM readiness.
- Model and provider credentials stay out of the VM.
- `SandboxManager` and D1 leases are reused, with no command retries.
- The D1 baseline-only deploy guard is diagnosed correctly (`control-plane-schema.ts:38–41`).
- The frontend already opens per-session `/api/wr/events?sessionID=` streams (`placement-streams.ts:59`), so per-root DOs need no workspace-wide event fan-in.

**Estimate.** 16–25 days doesn't fit this scope. The plan's own lines budget 2–3 days for CP, contracts and frontend, and 2–3 for Boat; those cover:
- a new row-preserving D1 migration mechanism;
- a new ticket variant and continuation authority (P1-1);
- multi-driver support;
- activity CAS plus the cron sweep;
- a Boat v1 client;
- a session-core resume-turn path (the transport contract only has `send` streams);
- a new projection cursor;
- PTY extraction plus a guest service that also does process supervision and file/Git;
- net-new previews;
- live acceptance.

A realistic range is about 45–70 engineer-days. The guest-service decision and the turn-authority redesign should both land before U3/U4 begin.

## Coverage

**Repository files inspected:**
- Both active documents, and `AGENTS.md`.
- session-core:
  - `host/runtime.ts`, `turn-admission.ts`, `recovery.ts`
  - `sqlite/durable-object.ts`, `database.ts`
  - `session/delivery-owner.ts`, `session-access-policy.ts`
  - `routes/session-turn-lease.ts`, `routes/session-prompt-admission.ts`
  - `test-support/durable-object-host.ts`, `store.ts`
- `workspace-runtime/src/remote-session-authority.ts`, `routes/pty.ts`, `routes/host-capability-access.ts`
- claxedo-server:
  - `routes/runtime-session-authority.ts`, `routes/runtime-connection-secrets.ts`
  - `connections/hosted-connection-info.ts`, `connections/turn-credentials.ts`
  - `authority/adapters/d1/session-authority.ts`, `authority/adapters/d1/host-session-rows.ts`
  - `authority/provider-neutral-hosted-services.ts`, `authority/adapters/worker/hosted-sandbox-driver.ts`
  - `deployments/hosted-shared/hosted-core-app.ts`
  - `migrations/control-plane/0001_baseline.sql`, `scripts/control-plane-schema.ts`
- sandbox-manager: `manager.ts`, `lease-policy.ts`, `contract.ts`, `drivers/box.ts`, `service-url-exposure.ts`
- claxedo-app: `transport.ts`, `relay.ts`, `sessions.ts`, `terminals.ts`, `harness-options.ts`, `placement-streams.ts`, `streams.ts`, `wire/connection.ts`
- `harness/src/contract/transport.ts`
- I confirmed that the files the plan cites exist.
- I did not read the superseded plan.

**Official sources checked:**
- Pi 1.0.0: the README and `file-mutation-queue.ts`.
- Boat: `api/v1`, execute-command, command-status, `api-keys`, `platform-guide`, `long-running-tasks`, `hosting`.
- Cloudflare: Wrangler DO bindings, DO limits, DO state API, and a docs search on shared isolates.

**Evidence I couldn't get:**
- The Pi `ExecutionEnv` interface and its cancellation mechanism (not in the README).
- Boat: WebSocket support in hosting, `noEnv` effect on the in-sandbox key, kill/list endpoints, `processId` scope (none documented).
- `getByName` and deploy-reset behaviour (not on the pages I fetched).

**Not run:** no tests, typechecks, builds, ratchets or live provider calls were run. Per the instructions, I made no repository changes.

## Codex verification notes

The report supports the agreed root-session ownership boundary. Its strongest findings identify work that must be made explicit before U2–U5 proceed. Several other findings are provider proof requirements or architectural options, rather than established defects. The review does not authorize a topology change or automatic adoption of every proposed fix.

| Finding | Assessment after checking evidence |
|---|---|
| P1-1: durable turn authority | Retain. `packages/session-core/src/routes/session-turn-lease.ts` keeps the live proof and renewal timers in memory. `packages/claxedo-server/src/authority/adapters/d1/session-authority.ts:555` and `:807` acquire/renew under the original actor's current access; existing redeemed grants cannot simply be reused after lease expiry. `packages/session-core/src/session/delivery-owner.ts:249` recognizes only the existing request provenances. Specify parked-turn and restart authorization, credential proof, and the distinction between a host-placement epoch and a turn fence. Claude's proposed new grant is an option to design and test, not a completed contract. |
| P1-2: Pi interruption and reissue | Retain as a concrete U1 proof requirement. Pi's pinned README describes interrupted results, and its built-in bash registration does not declare replay safety. The plan already requires a paused uncertain turn; U1 must demonstrate how that requirement is enforced before Pi restarts scheduling. Marking a tool replay-safe is valid only if its wrapper actually reconciles durable identity and cannot repeat the effect. Merely changing the flag or waiting on a promise is insufficient. |
| P1-3: Boat operation control | Narrow the conclusion. The inspected execute/status contracts do not document an idempotent command-start identity or a dedicated cancellation API. That supports an unresolved G2, not proof that no workable primitive exists. The plan already requires unknown outcomes to remain visible and retained. Moving execution to a guest supervisor is a proposed scope change; its start/journal crash window, process-generation control and hostile-guest trust limits also need proof. Guest assertions cannot establish that hostile execution has stopped. |
| P1-4: acquisition versus archive | Retain. `packages/sandbox-manager/src/manager.ts:220` serializes in memory, and `:543` performs the provider stop before updating the lease. This does not supply a cross-Worker activity barrier. Add a durable conditional transition that makes acquiring activity and entering archive mutually exclusive, plus the exact racing-request acceptance test. |
| P2-1: deployment driver selection | Retain as a rollout decision. Current hosted composition injects one statically selected driver. Explicitly choose whether the release serves mixed existing placements through one dispatch owner or is restricted to a Boat deployment. Do not add multi-provider work by assumption. |
| P2-2: process-wide file queue | Keep as a hypothesis to test. The queue is module-global and multiple DOs can share an isolate, but the alleged cross-context hang was not reproduced. Do not claim that failure or change environment identity solely on this finding. A co-resident-object test should establish the required queue/identity behavior. |
| P2-3: activity classes and unknown work | Define tracked operations, connection activity and untracked guest processes separately. Expiring an interactive connection lease does not establish process termination. The proposed deadline-triggered archive would change the agreed R10/R11 policy; unknown execution must retain its obligation until reconciliation or an explicit authorized recovery action. |
| P2-4: sessionless routes | Retain the route inventory concern. `packages/claxedo-app/src/server/harness-options.ts:26` has a sessionless remote model-options route, and terminals have additional workspace queries. U6 already calls for an inventory; move ownership decisions for required pre-session routes early enough to inform U2/U4. Reusing file/Git implementation does not by itself require moving every route into the guest. |
| P2-5: preview origins | Specify isolation between different untrusted workspaces, not only separation from the app origin. Confirm the actual preview entrypoint and gateway scope before sizing U7. The report's full net-new UI/DNS scope claim was not independently exhaustively verified. |
| P2-6: guest Boat identity | Add explicit G3 checks for the credential exposed inside a `noEnv` VM, allowed prompt/hosting actions and who pays. The inspected key documentation lists those actions; no live `noEnv` exposure or billing exploit was demonstrated. |

Additional implementation details to retain from the P3 notes: bounded local initialization before asynchronous reconciliation; explicit owned-child versus independent-fork registration; deliberate terminal access policy; and an authorized producer for DO session titles/status in CP's index. `packages/claxedo-server/src/authority/adapters/d1/host-session-rows.ts` currently authorizes enrolled-host publications, so a DO needs an explicitly fenced publication path. The frontend already subscribes to remote session events individually; a new workspace-wide session event aggregator is not required by that flow.

The key-rotation concern is supported by Boat's documentation: rotation revokes the previous secret immediately, while creating a replacement permits a coordinated cutover. Rotation/revocation authorization and expiry policy must be proved rather than assumed to work with an admin API key alone.

**Estimate:** Claude's 45–70 engineer-day range is reviewer judgment, not a measured forecast. It also includes proposed additions such as a supervisor, multi-driver dispatch and wider execution-service responsibilities. Re-estimate after U1 and those scope decisions. The existing 16–25 day range should not be treated as a commitment either.

**Readiness:** proceed with the feasibility work, extending its acceptance cases for turn reauthorization, interrupted-tool recovery and atomic activity admission. Dependent implementation remains gated on that evidence. Keep the agreed SessionDO/CP boundary while those contracts are made concrete.

### Additional evidence checked by Codex

- [Pi 1.0.0 persistence/tool contract](https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/README.md) and [built-in bash registration](https://raw.githubusercontent.com/earendil-works/pi/v1.0.0/packages/durable/src/tools/bash.ts).
- [Cloudflare per-isolate memory](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/).
- [Boat command execution](https://docs.boat.dev/api/reference/agent/execute-sandbox-command), [command status](https://docs.boat.dev/api/reference/agent/get-command-status), [API keys and rotation](https://docs.boat.dev/api-keys), and [documentation index](https://docs.boat.dev/llms.txt).
- Repository source at the locations cited in the table. These were code/document inspections, not live failure reproductions.

### Validation

- Claude CLI invocation above: exit 0, successful result, expected reviewer model, no permission denials.
- Input-document SHA-256 comparison: all three original documents unchanged.
- Saved report: local links, code fences and whitespace checked. `git diff --no-index --check /dev/null docs/reviews/2026-10-03-pi-durable-boat-opus-5-5-review.md` produced no diagnostics; exit 1 indicates the newly added file. A Python check validated the links, fences, model/effort provenance and input hashes.
- No tests, typechecks, builds, architecture ratchets, deployments or provisioning were run for this review.

## Documentation follow-up — 2026-10-03

After discussing the purpose of turn leases, the user requested a document update. The active [HLD](../architecture/pi-durable-boat-hld.md#turn-ownership-and-continuing-authorization) now assigns durable active-turn ownership to SessionDO, while CP retains continuing authorization, revocation and credential issuance. Pi Durable does not use CP's existing turn-lease row as a second ownership lock; existing placements keep their current protocol. This preserves the behavior identified in P1-1 without adopting its exact proposed mechanism.

The [plan's review disposition](../plans/2026-10-02-2031-feat-pi-durable-boat-plan.md#review-disposition) maps the remaining findings to units and proof gates. It adds atomic activity/archive admission, explicit interrupted-tool recovery proof, early route/provider decisions, CP summary publication, scoped preview origins and guest-key checks. Acceptance now includes A13–A15 for continuing authorization, lifecycle races and metadata/index delivery.

These are document corrections and planned acceptance criteria, not implemented fixes. The original review above applies to the recorded input hashes and original line numbers. Claude has not reviewed this later revision; provider/supervisor feasibility and the revised implementation estimate remain open.
