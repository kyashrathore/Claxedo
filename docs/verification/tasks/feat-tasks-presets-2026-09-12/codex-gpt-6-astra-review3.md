# Codex (gpt-6-astra) third review at 822c4bf417, 2026-09-12

Orchestrator note: 8 closed, 5 partial, 2 new (R1, R2); a third fix round was launched against all seven. Line numbers are as of 822c4bf417.

**Request changes.** At `822c4bf417`, **8 items are CLOSED and 5 remain PARTIAL**. Round 2 fixes several concrete defects, but authorization-at-read, atomic settlement and first-message recovery remain incomplete.

Ran `git diff dev...HEAD --stat` and `git log dev..HEAD --oneline`, read the prior reports and round-2 changes, and inspected the implementation and tests. No files were modified. Paths below are relative to the repository; CLOSED describes the reported defect, not deployed acceptance.

| Item | Status | Current evidence and test |
|---|---|---|
| **1 — Session authorization** | **PARTIAL** | `packages/claxedo-tasks/src/tasks/service.ts:462` rechecks before calling the bridge. However, `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:318` awaits target resolution before the privileged transcript read at `:329` / `:253`. Revocation during that await still permits the read. **Test:** `tasks/service.test.ts:692` covers revocation before bridge entry, not inside it. An inline probe using the real service and bridge confirmed **one unauthorized transcript read**. |
| **2 — Immutable configuration race** | **CLOSED** | `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:426` serializes each origin; `:462` encloses reservation/probe/create/recovery, and `:582` rejects recovered configuration mismatches. **Tests:** `packages/claxedo-local-server/src/tasks/session-bridge.test.ts:354` races different configurations; hosted `session-bridge.test.ts:358` covers a competing creator winning after the probe. This closes the unsigned host’s single-process race. |
| **3 — Settlement** | **PARTIAL** | `packages/claxedo-tasks/src/tasks/service.ts:505` rereads the preset, `:516` compares session/workspace/digest, and `:524` guards the task revision. But the preset read adds **no D1 commit predicate**, and the matching-link branch at `:520` still bypasses task CAS. **Tests:** `tasks/service.test.ts:726` covers an edit before settlement; `:748` covers link identity comparisons. An actual-D1-adapter/in-memory-SQLite probe archived the preset after its settlement read: **Start still linked revision 1 and handed off with the preset archived at revision 2**. |
| **7 — Durable first-message recovery** | **PARTIAL** | Link persistence now precedes handoff: `packages/claxedo-tasks/src/tasks/service.ts:503`, `:536`. Unreadable history refuses at `packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:535`. But `:534`–`:555` remains read-then-submit; runtime admission is process-local at `packages/workspace-runtime/src/routes/session-core.ts:1209`, and the bridge does not request its restart-readback path at `:2080`. **Tests:** `tasks/service.test.ts:795` and local `session-bridge.test.ts:305` cover sequential retry, not durable admission across a real restart. See R1 below. |
| **9 — D1 conflicts/replay** | **CLOSED** | `packages/claxedo-tasks/src/commands.ts:131` checks the receipt inside the unit; `:158` recovers a stale-revision loser through the committed receipt. Replay still checks the hash and reauthorizes at `:108`–`:111`. **Tests:** `conformance/commands.ts:216`–`:224` covers concurrent edit/status/archive and late task reads; registered for memory at `stores/memory.test.ts:13`, SQLite at `sqlite-store.test.ts:56`, and D1 at `d1-store.test.ts:152`. |
| **13 — Worker/build selection** | **CLOSED** | `packages/claxedo-server/src/deployments/hosted-workerd/better-auth-d1-candidate-worker.agent-plugins.cf.ts:36` gates the dynamic import. `scripts/deploy/worker-build-selection.ts:23` renders the define; `:49` stages selected SQL; release `release-better-auth-d1.ts:1231` wires staging into the config. **Tests:** `core-resource-closure.test.ts:174`, `:198`, `:208`, `:221` pin emitted selection, define and migrations. Release uses a fresh directory; boundary builds clear theirs. The recorded Wrangler measurements were **not independently rerun** here. |
| **14 — Configuration fails open** | **CLOSED** | `packages/workspace-runtime/src/session/service.ts:325` throws a typed pre-execution refusal on configuration-read failure. `routes/session-core.ts:2172` releases that admission. **Test:** `routes/session-core.test.ts:2186` proves failure → same-ID recovery → exactly one execution with retained instructions. Passed here. |
| **15 — Misleading comments** | **PARTIAL** | The principal claim is corrected, but `packages/claxedo-tasks/src/ports/session-bridge.ts:71` still says every `currentLink` arrives authorized; `tasks/service.ts:188` deliberately bypasses authorization for deleted links and `:430` forwards them. The exactly-once wording at `ports/session-bridge.ts:67` also exceeds the recovery evidence above. **Pin:** manual contract inspection; no test establishes those claims. |
| **N1 — Refused `prompt_async` retry** | **PARTIAL** | Permanent same-ID suppression is fixed at `packages/workspace-runtime/src/routes/session-core.ts:2172`, pinned by the passing `session-core.test.ts:2186`. However, the adapter path still answers **204**, while `session-bridge-core.ts:554`–`:555` interprets that as successful handoff. The bridge does not consume the later refusal event. Thus the original “Tasks reports success although nothing executed” consequence remains. |
| **N2 — Deleted session blocks Start again** | **CLOSED** | `packages/claxedo-tasks/src/tasks/service.ts:188` allows replacement of deleted sessions; `:153` retains their links for attempt calculation. `session-bridge-core.ts:274` prevents transcript reads from those links. **Tests:** `tasks/service.test.ts:660` pins deleted replacement versus inaccessible-live refusal; local `session-bridge.test.ts:480` pins the deleted transcript exclusion. The service test uses row-like fake authority; a real signed delete→Start journey remains unverified. |
| **N3 — Duplicate edit replay** | **CLOSED** | Same fix and conformance evidence as item 9. The stale-revision recovery still goes through hash comparison and current authorization; it does not blindly return any receipt. |
| **N4 — Automatic pagination loop** | **CLOSED** | `packages/claxedo-app/src/features/tasks/data/queries.ts:121` stops following on next-page error; `:103` exposes explicit retry. **Tests:** `ui/tasks-pagination.vitest.tsx:231` and `:253` assert two requests before repair and three after a user retry, with existing rows retained. Inspected; execution blocked by Vitest startup permissions. |
| **N5 — Principal resolver documentation** | **CLOSED** | `packages/claxedo-server-core/src/tasks-host/authorization.ts:47` now correctly states human-only resolution and refusal otherwise. **Test:** `packages/claxedo-server/src/tasks/session-bridge.test.ts:428` asserts that an unanswered resolver causes refusal without reservation or creation. Broader comment defects remain under item 15. |

**New round-2 findings**

1. **R1 — High: A committed link can strand an unsubmitted task after reload.**

   **Location:** [tasks/service.ts:536](packages/claxedo-tasks/src/tasks/service.ts:536), packages/claxedo-tasks/src/solid/task-detail.tsx:134, packages/claxedo-app/src/features/tasks/ui/task-detail-panel.tsx:95.

   **Failure scenario:** The link commits, then the process stops or handoff fails before submission. After reload, the session is live, so the detail view offers **Open**; Start requires no current link, and Start again requires non-live liveness. Open only navigates—it does not retry handoff. No background recovery owns the missing message.

   The new service test manually invokes Start again with the updated revision, bypassing this UI dead end. The asynchronous configuration refusal in N1 reaches the same state despite a successful Start response.

   **Fix:** Persist the first-message intent and let the runtime own durable admission/recovery. Expose an authoritative pending/refused state and a recovery action through the real UI. Preserve the original task text and handoff text across reload. Add a mounted link-committed→handoff-failed→reload→recovery test asserting one eventual execution.

2. **R2 — High: Preset-change refusal leaves the attempt occupied but unlinked.**

   **Location:** [tasks/service.ts:505](packages/claxedo-tasks/src/tasks/service.ts:505), [session-bridge-core.ts:582](packages/claxedo-server-core/src/tasks-host/session-bridge-core.ts:582), [tasks/service.ts:200](packages/claxedo-tasks/src/tasks/service.ts:200).

   **Failure scenario:** Start creates the session using preset A. The preset’s instructions change before settlement, so the new check rejects the link. Retrying with the current preset cannot adopt the old configuration; requesting attempt 2 fails because no attempt-1 link exists.

   An inline probe using the real service and bridge produced:

   ```text
   First: Preset changed while its session was being created
   Retry: Session is already running another configuration
   Next:  Slot has no session yet; the first attempt is 1, not 2
   Links: 0
   ```

   **Fix:** Give rejected settlement an explicit recovery/compensation path at the reservation/session owner. Either retain an authoritative admitted snapshot that can complete, or safely compensate the unsubmitted session and reservation so the origin can retry. Extend `tasks/service.test.ts:726` beyond initial refusal to prove recovery through the real bridge.

**What is solid**

- The per-origin queue covers creation and recovery, releases after failures, and prevents competing unsigned starts from overwriting configuration within the supported process boundary.
- Receipt lookup, rollback and replay now compose correctly for the reviewed revision-bearing commands. Hash comparison and reauthorization remain intact.
- The configuration-read refusal test exercises the actual `prompt_async` route and proves same-ID recovery with standing instructions.
- Pagination now has bounded failure behavior and explicit recovery. Refused preset reads also have separate UI coverage instead of appearing as an empty catalog.
- Worker code selection and staged migration selection use the same build flag. I found no additional production-caller regression in the define/staging wiring.

**Verification**

| Working directory | Command | Outcome |
|---|---|---|
| `packages/claxedo-tasks` | `bun test src` | **176 passed, 0 failed** |
| `packages/workspace-runtime` | `bun test src/routes/session-core.test.ts src/session/service.test.ts` | **75 passed, 0 failed** |
| `packages/claxedo-server-core` | `node ./node_modules/vitest/vitest.mjs run src/tasks-host/sqlite-store.test.ts --reporter=default` | Blocked before collection: temporary-directory `EPERM` |
| `packages/claxedo-server` | `node ./node_modules/vitest/vitest.mjs run src/tasks src/deployments/hosted-workerd/core-resource-closure.test.ts --reporter=default` | Blocked writing Vite’s temporary config |
| `packages/claxedo-app` | `node ./node_modules/vitest/vitest.mjs run --config vitest.config.ts src/features/tasks --reporter=default` | Same startup restriction |

Three inline `bun -e` probes confirmed the authorization race, D1 settlement race and stranded-origin recovery failure without writing files. The D1 probe used the actual adapter and migration over in-memory SQLite; it was not deployed D1. Builds, packaged desktop and deployed Worker acceptance remain unverified in this review.

