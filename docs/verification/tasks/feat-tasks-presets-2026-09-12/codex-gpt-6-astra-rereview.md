# Codex (gpt-6-astra) re-review at 32a8a23cb0, 2026-09-12

Orchestrator note: 7 closed, 8 partial, 5 new; a second fix round was launched against every partial and new item. The line numbers below are as of 32a8a23cb0.

**Request changes.** At `32a8a23cb0`, **7 findings are CLOSED and 8 are PARTIAL**. The fix-wave claim that all fifteen are addressed is too strong.

Reviewed `dev...HEAD` and the fix commits in `/Users/yashvardhansingh/test/opencode-tasks`, branch `feat/tasks-presets`. No files were modified; no builds ran. Paths below are relative to the repository.

| # | Status | Current code and regression coverage |
|---|---|---|
| 1 | **PARTIAL** | `packages/claxedo-tasks/src/tasks/service.ts:171` authorizes the current session before returning it or entering the bridge. `tasks/service.test.ts:457` pins denied Start, Continue and preview. However, `session-bridge-core.ts:323` subsequently reads the transcript through the privileged host without rechecking session authority before copying it. The original revocation/recheck requirement remains. The gate also introduces N2 below. |
| 2 | **PARTIAL** | `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:412` binds the configuration digest into the managed reservation; `:503` rejects mismatched recovered configuration. Local `session-bridge.test.ts:363` and hosted `session-bridge.test.ts:284` pin sequential recovery. **Unsigned local creation still has no atomic reservation:** two requests can both observe absence at `:423` and enter creation with different configurations. Runtime creation checks an existing session’s harness, but does not atomically compare immutable configuration (`packages/workspace-runtime/src/routes/session-core.ts:1353`). Sequential tests do not pin this race. |
| 3 | **PARTIAL** | `packages/claxedo-tasks/src/tasks/service.ts:463` couples a new link with the original task revision and advances that revision. Tests at `tasks/service.test.ts:424`, `:435` and `:569` cover revision advancement, workspace changes and archival. But settlement never revalidates the preset, and the existing-link return at `:460` bypasses the task CAS and compares only session ID—not workspace or configuration digest. The admitting-state contract is therefore incomplete. |
| 4 | **CLOSED** | `packages/claxedo-tasks/src/tasks/service.ts:108` takes the validated parent snapshot; `touchParent` writes against that snapshot’s revision. Create, restore, reopening and reparenting pass their validated parent through. `tasks/service.test.ts:119` pins the parent-going-Done race; `conformance/store.ts:222` pins atomic parent/child persistence. |
| 5 | **CLOSED** | `packages/claxedo-server-core/src/tasks-host/sqlite-store.ts:327` obtains a dedicated Tasks connection, and `:349` serializes transactions across adapter instances. `sqlite-store.test.ts:82` pins an unrelated shared-connection write surviving rollback; `:109` pins overlapping adapter instances. This closes the reported shared-connection rollback defect. |
| 6 | **CLOSED** | `packages/claxedo-tasks/src/stores/memory.ts:181` serializes transaction units before snapshot/rollback. `conformance/store.ts:388` pins overlapping rollback/success and `:422` pins competing revision bumps. Both cases ran in the passing package suite. |
| 7 | **PARTIAL** | `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:450` distinguishes unreadable history and refuses to resend. Hosted `session-bridge.test.ts:310` pins that specific failure. However, durable first-message admission was not added, and submission still precedes link persistence. The runtime’s `promptAdmissions` map is process-local; the bridge also does not request the route’s restart-readback path. The original durable recovery requirement remains. |
| 8 | **CLOSED** | `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:515` reconciles missing metadata when recovering an existing session, before returning success. Hosted `session-bridge.test.ts:330` removes metadata, retries and verifies liveness becomes live. |
| 9 | **PARTIAL** | `packages/claxedo-server/src/tasks/d1-store.ts:238` classifies batch failures; `packages/claxedo-tasks/src/commands.ts:149` recognizes duplicate receipts. D1 tests at `d1-store.test.ts:192`, `:210` and `:233` cover commit-time revision/link conflicts and duplicate **creates**. Duplicate revision-bearing commands can still fail before receipt detection; see N3. |
| 10 | **CLOSED** | `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:323` computes readability independently of the checkbox; `:326` includes the transcript only when selected. Local `session-bridge.test.ts:321` pins the producer; app `start-task-flow.vitest.tsx:195` pins checkbox retention, re-preview and submission. These remain separate producer/consumer tests, rather than one mounted real-bridge journey. |
| 11 | **CLOSED** | `packages/claxedo-app/src/features/tasks/data/queries.ts:56` retains `nextCursor`; task lists expose Load more, while presets/children follow pages automatically. `tasks-pagination.vitest.tsx:101` covers list/board pagination and `:120` covers children. The cursor-dropping defect is closed, but automatic following introduces N4. |
| 12 | **CLOSED** | `packages/claxedo-server/src/deployments/self-hosted-node/start.ts:114` gates selection and chooses composition from the composed authentication posture. `tasks/self-hosted-composition.ts:76` supplies signed session reservation. `self-hosted-composition.test.ts:152` pins organization isolation and `:182` pins the starter’s principal; `start-tasks-selection.test.ts` covers composition selection. |
| 13 | **PARTIAL** | Renderer, desktop and self-hosted gates exist; SQLite staging callers clear their destinations before copying selected migrations. Source guards and selection tests cover those paths. **The hosted Worker still imports and mounts Tasks unconditionally:** `packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts:4` and `:47`. D1 migration selection is also absent. No builds were run to independently verify emitted artifacts. |
| 14 | **PARTIAL** | `packages/workspace-runtime/src/session/service.ts:276` propagates configuration-read failure before adapter execution. `session/service.test.ts:64` and `routes/session-core.test.ts:2127` pin refusal. They do not pin failure followed by recovery through `prompt_async`; that entrypoint retains a false admission marker, described in N1. |
| 15 | **PARTIAL** | The effort comment now acknowledges missing preview validation (`packages/claxedo-server-core/src/tasks-host/host-ports.ts:22`), and hosted capabilities advertise local-only placement, pinned by `hosted-composition.test.ts:207`. Comment quality is not closed: a new authorization comment directly contradicts the refusal path, and several file headers still document the broader system despite `CLAUDE.md` prohibiting that style. See N5. |

**New findings in the fix wave**

1. **High — Configuration-read refusal permanently suppresses same-ID retries in `prompt_async`.**

   **Location:** [session-core.ts:2062](/Users/yashvardhansingh/test/opencode-tasks/packages/workspace-runtime/src/routes/session-core.ts:2062), [service.ts:458](/Users/yashvardhansingh/test/opencode-tasks/packages/workspace-runtime/src/session/service.ts:458).

   **Failure scenario:** On the adapter-backed path, `prompt_async` adds the message ID to `promptAdmissions`, then the new configuration read throws before execution. The asynchronous catch publishes an error but leaves the admission marker; the route returns 204. After configuration access recovers, retrying that message ID immediately returns 204 without executing. A Tasks Start can consequently link a session whose first task message never ran.

   The added route test uses the synchronous prompt path and checks only refusal, so it misses this recovery failure.

   **Fix:** Make admission distinguish accepted execution from pre-execution failure. Remove the marker on a configuration-read refusal and expose that refusal to the submitting caller. Add a real `prompt_async` failure/recovery test using the same message ID, asserting exactly one eventual execution with retained instructions.

2. **Medium — Signed users cannot Start again after deleting the previous session.**

   **Location:** [tasks/service.ts:171](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/tasks/service.ts:171).

   **Failure scenario:** A signed user starts a task, deletes its session, then requests the next attempt. The new unconditional session-open check runs before liveness classification. Signed session authority rejects deleted rows at [private-session-authority.ts:172](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/authority/adapters/sqlite/private-session-authority.ts:172), so the request receives `forbidden` and never reaches the deleted-session attempt rule.

   The new denial test uses a Boolean authorization fake; it does not distinguish inaccessible live sessions from an authorized user’s deleted session.

   **Fix:** Have the authority provide an explicit, authorized deleted-session outcome. Permit replacement from that outcome while continuing to refuse opening or copying inaccessible transcripts. Pin delete → Start again through signed composition.

3. **Medium — Transaction serialization breaks duplicate edit replay.**

   **Location:** [commands.ts:131](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-tasks/src/commands.ts:131).

   **Failure scenario:** Two identical edit requests both pass the receipt check outside the transaction. Memory/SQLite serialization lets the first commit before the second starts. The second runs the command against the old requested revision and throws `stale_revision` **before** reaching `receipts.put`. Neither `raced` nor duplicate-receipt classification applies, so an identical committed request receives an error instead of replay.

   D1 has the equivalent scheduling window if the first request commits before the second command reads its task. The new duplicate test covers creation, which has no input revision and can reach receipt insertion.

   **Fix:** Check the receipt inside the transaction before running the command; also recover matching committed receipts when concurrent execution loses its revision. Preserve hash comparison and reauthorization. Add identical edit/status/archive replay cases to all three adapters.

4. **Medium — Failed automatic pagination retries indefinitely.**

   **Location:** [queries.ts:72](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-app/src/features/tasks/data/queries.ts:72).

   **Failure scenario:** The first preset or children page succeeds with a cursor; the next page repeatedly fails. After each exhausted fetch, `isFetchingNextPage` becomes false while `hasNextPage` remains true. The effect starts another fetch cycle, bypassing the intended retry limit and continuing requests while the view remains mounted.

   Current pagination tests supply successful pages only, including when their query client has `retry: false`.

   **Fix:** Stop automatic following on a next-page error and provide explicit retry. Test a successful first page followed by a failed second page, asserting bounded requests and successful user-triggered recovery.

5. **Low — New principal documentation describes a fallback that is explicitly refused.**

   **Location:** [authorization.ts:53](/Users/yashvardhansingh/test/opencode-tasks/packages/claxedo-server-core/src/tasks-host/authorization.ts:53).

   **Failure scenario:** The comment says a non-human principal reserves as its own service actor. The resolver returns `undefined`, and `createTasksSessionReserve` explicitly refuses when a supplied resolver cannot answer. A maintainer following the comment would expect support that does not exist.

   **Fix:** State that this resolver supports human principals and otherwise causes refusal. Remove broader system-documentation headers and narration prohibited by `CLAUDE.md`; retain only actual constraints and ordering invariants.

**Verification**

- `packages/claxedo-tasks`: `bun run test` — **162 passed, 0 failed**. JUnit output failed with `EPERM`; the command nevertheless exited 0.
- `packages/claxedo-server-core`: `node ./node_modules/vitest/vitest.mjs run src/tasks-host/sqlite-store.test.ts --reporter=default` — blocked before test collection by temporary-directory permissions.
- `packages/claxedo-server`: `node ./node_modules/vitest/vitest.mjs run src/tasks --reporter=default` — blocked while writing Vite’s temporary configuration.
- `packages/claxedo-app`: `node ./node_modules/vitest/vitest.mjs run --config vitest.config.ts src/features/tasks --reporter=default` — same startup restriction.

**Verdict:** The fixes materially improve transaction isolation and authorization, but immutable Start reservation, recovery and replay remain incomplete. Resolve the high-priority recovery gaps and add failure/recovery and concurrent revision-bearing command tests before approval.