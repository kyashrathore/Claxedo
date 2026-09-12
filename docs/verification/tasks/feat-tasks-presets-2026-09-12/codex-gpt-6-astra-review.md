# Codex (gpt-6-astra) review of feat/tasks-presets at 867fd4b116, 2026-09-12

Orchestrator verification: findings 1–8, 10–12, 14 and the host-ports comment in 15 confirmed by reading the cited lines; 9 and the hosted-composition claim in 15 not yet verified; 13 was already recorded in index.md. No fixes applied yet.

**Request changes.** The branch has authorization and transaction bugs that the passing tests do not cover.

Reviewed `feat/tasks-presets` against `dev` in `/Users/yashvardhansingh/test/opencode-tasks`. No files were modified. `bun test src` in `packages/claxedo-tasks` passed: **151 tests, 0 failures**. Additional inline probes reproduced findings 1, 2, 4 and 6. The D1 probe ran the actual adapter and migration against in-memory SQLite; deployed D1 and native-harness resume remain unverified.

1. **High — Start bypasses session authorization.**  
   [tasks/service.ts:377](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/tasks/service.ts:377)

   Detail filters links through `authorizeSessionOpen`, but Start returns an existing live link without that check. Continue also passes the previous session to the privileged bridge without authorization; `readHandoff` reads its messages using the host runtime client.

   **Failure:** A project writer who cannot read another member’s linked session can request Continue after archival and copy that private conversation into a new session they own. The probe confirmed that detail hid a denied session while Start returned it and Continue forwarded it.

   **Fix:** Authorize session access before returning a link, probing transcript readability, or reading the previous transcript. Recheck before copying it into the new session.

2. **High — An origin does not reserve immutable configuration.**  
   [session-bridge-core.ts:367](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:367)

   The deterministic ID binds scope/task/slot/attempt, but neither the reservation nor existing-session lookup compares the resolved configuration digest. A successful GET skips creation regardless of which preset created that session.

   **Failure:** Start with preset A creates a session but loses the response before linking. Retrying the same attempt with preset B succeeds against A’s session; the resulting link can claim B’s provenance. The bridge probe reproduced this: the second preset was accepted while the stored instructions remained A’s.

   **Fix:** Atomically reserve origin plus resolved configuration hash in the session owner before creation. Recover matching reservations and reject competing settings.

3. **High — Link insertion does not enforce the state that authorized Start.**  
   [tasks/service.ts:412](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/tasks/service.ts:412)

   Settlement checks only task existence, archival and project. It does not compare the original revision or workspace, revalidate the preset, or guard the current attempt. In D1, the task reread itself adds no commit-time predicate.

   **Failure:** While creation is pending, another request changes the task’s workspace. The old workspace’s session is still linked. On D1, archival or project movement after the reread can also commit before an unguarded link insertion.

   **Fix:** Make link insertion conditional on the expected task revision, target and current attempt within the same commit. Retain and compare the preset/configuration reservation. Advance the task revision so concurrent edits cannot miss a newly inserted link.

4. **High — D1 can commit an unfinished child under a Done parent.**  
   [tasks/service.ts:100](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/tasks/service.ts:100)

   `requireOpenParent` validates one parent revision, but `touchParent` rereads the parent and uses its newer revision for CAS. D1 reads are not a transaction snapshot, so the second read can discard the evidence underlying the first check.

   **Failure:** Child creation validates a Todo parent. Another request marks it Done. Creation then rereads that Done parent, bumps its revision and commits the unfinished child. The D1 adapter probe reproduced exactly this outcome.

   **Fix:** Carry the validated parent snapshot through the mutation and guard that revision at commit. Apply the same rule to restore, reopening children and reparenting.

5. **High — SQLite holds a transaction open across awaits on the shared database connection.**  
   [sqlite-store.ts:308](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/tasks-host/sqlite-store.ts:308)

   `BEGIN IMMEDIATE` wraps asynchronous work on `ClaxedoDB.raw()`. The queue protects only transactions through this particular adapter instance. Other `ClaxedoDB.use` callers and other adapter instances use the same connection outside that queue.

   **Failure:** An unrelated write executes while Tasks awaits authorization, then Tasks rolls back and also removes that unrelated write. Two adapter instances can instead fail with nested `BEGIN` errors.

   **Fix:** Put transaction ownership at the database owner: use an isolated connection or prepare asynchronous decisions before a synchronous, guarded commit. An adapter-local queue cannot isolate the shared connection.

6. **Medium — Memory rollback erases other committed transactions.**  
   [memory.ts:172](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/stores/memory.ts:172)

   Transactions mutate shared state directly and restore a whole-store snapshot on failure.

   **Failure:** Transaction A suspends; B commits; A fails and restores its earlier snapshot, deleting B. The probe printed `B after commit true`, then `B after A rollback false`.

   **Fix:** Serialize all participating operations or use isolated transaction state with conflict detection. Add overlapping success/rollback cases to shared conformance; its current manifest explicitly leaves concurrent arbitration untested.

7. **High — Recovery treats an unreadable message history as permission to resend.**  
   [session-bridge-core.ts:432](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:432)

   `readMessages` returns `null` for request failures, and `alreadySent` converts that uncertainty into `false`. The bridge then submits the first message again. The runtime’s admission map protects retries within one process, but it is not durable across restart.

   **Failure:** The first turn executes, the response/link is lost, and the runtime restarts. A transient failure reading messages causes the bridge to submit the same task again, potentially repeating external actions.

   **Fix:** Use durable first-message admission/replay in the runtime owner. Treat failed readback as uncertainty, not absence. Persist the link before submission, with submission recovery owned by the runtime.

8. **Medium — Recovery never repairs missing session metadata.**  
   [session-bridge-core.ts:398](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:398)

   `projectSessionMeta` runs only when this request creates the runtime session.

   **Failure:** Creation succeeds, then the process crashes or metadata persistence fails. Retry finds the existing session and permanently skips projection. `sessionStates` interprets missing metadata as deletion, allowing another attempt while the original session exists.

   **Fix:** Reconcile the canonical projection when recovering an existing reserved session, before reporting success or calculating liveness.

9. **Medium — D1 commit conflicts bypass command replay and typed refusals.**  
   [d1-store.ts:471](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server/src/tasks/d1-store.ts:471)

   Receipt/link collisions and revision guards can fail during `database.batch`, after operations have already returned success. `commands.execute` recognizes a duplicate only when `receipts.put` returns `false`; its `raced` flag remains false for batch failures.

   **Failure:** Two identical requests both see no receipt and queue writes. One commits; the other receives an unclassified database error instead of replaying the committed result. Concurrent revision failures likewise escape the intended 409 contract.

   **Fix:** Classify commit-time conflicts at the adapter boundary. Recover and reauthorize matching receipts; return typed stale/conflict errors for genuine competing writes.

10. **Medium — Continue is unreachable through the real dialog.**  
    [start-task-dialog.tsx:107](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/solid/start-task-dialog.tsx:107)

    The checkbox appears only when `previousTranscriptReadable` is true. The real bridge sets that from a handoff it reads only when `continueFromPrevious` is already true. The initial draft sets it false.

    **Failure:** Restarting an archived session never displays Continue. The mounted test supplies `previousTranscriptReadable: true` directly, bypassing this producer/consumer mismatch.

    **Fix:** Probe authorized transcript availability independently of the selected checkbox; include transcript content only after explicit selection. Test the complete flow against the real preview producer.

11. **Medium — The Solid surface silently discards pagination.**  
    [queries.ts:34](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/queries.ts:34)

    Preset, task and child queries return only `page.items`, discarding `nextCursor`, with no pagination control or subsequent fetch.

    **Failure:** Older presets become unavailable in Start; older tasks and subtasks disappear. A parent may refuse Done because of unfinished children the detail view never loads.

    **Fix:** Preserve cursors and provide pagination or fetch subsequent pages through the existing query owner.

12. **Medium — Signed self-hosting mounts unsigned-local Tasks composition.**  
    [start.ts:78](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server/src/deployments/self-hosted-node/start.ts:78)

    Self-hosting supports embedded multi-user authentication, but always mounts `local-composition`, which uses loopback authentication, a single local owner and unconditional project/session authorization.

    **Failure:** A legitimate signed remote user gets 403 regardless of their permissions. Requests admitted over loopback all operate on the same “personal” preset catalog rather than their signed identities.

    **Fix:** Compose signed authentication and authority with SQLite for signed self-hosting. Restrict the local composition to the unsigned single-user posture.

13. **Medium — Required build-time optionality is absent.**  
    [secondary-feature-ports.ts:141](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/app/integrations/secondary-feature-ports.ts:141)

    Tasks registers unconditionally in the renderer and is imported unconditionally by desktop/self-hosted entries. The design’s `CLAXEDO_BUILD_TASKS` exclusion path is not wired.

    **Failure:** An intended Tasks-off build still includes its surface, package and routes; migrations are added to host migration locations without the specified feature selection.

    **Fix:** Carry the build selection through renderer registration, host composition and migration staging. Verify enabled and disabled emitted artifacts, including reused staging directories.

14. **Medium — Standing instructions fail open when configuration cannot be read.**  
    [service.ts:269](/Users/yashvardhansingh/test/opencode-tasks/packages/workspace-runtime/src/session/service.ts:269)

    Removing the prompt short-circuit is necessary, but the newly essential configuration read still catches every error and substitutes `undefined`.

    **Failure:** On the adapter-backed prompt path, a configuration-read failure during resume allows execution without the session’s standing instructions. A caller supplying model/agent/variant does not restore those instructions.

    **Fix:** Propagate configuration-read failures and refuse admission until authoritative configuration is available. Test failure and recovery, not only successful persistence and prompt serialization.

15. **Low — Comments claim guarantees the implementation does not provide.**  
    [host-ports.ts:22](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/tasks-host/host-ports.ts:22)

    This comment says preview validates model-specific effort, but `configurationBlocker` checks only model availability. The hosted composition also claims selected-only cloud capability support while `resolveStart` unconditionally blocks cloud placement.

    **Failure:** A preset using an unsupported effort can pass preview; maintainers are directed toward checks that do not exist. These are contradictory behavioral claims, beyond the numerous narration/plan-reference comments prohibited by `CLAUDE.md`.

    **Fix:** Implement the capability checks or remove the claims and advertise unsupported behavior accurately. Keep comments limited to actual constraints and ordering invariants.

What looked solid:

- Preset reads enforce ownership; ordinary task detail filters inaccessible session links.
- SQL predicates consistently include scope, and stored rows pass through shared decoders.
- D1 guard statements correctly roll back a batch when an explicitly guarded revision changes.
- Instruction composition bounds UTF-8 content, reports truncation and stays independent of Tasks in the runtime.
- Hosted production composition resolves the human actor for reservations; unsupported cloud starts are refused before creation.

