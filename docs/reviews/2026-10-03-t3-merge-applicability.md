# T3 merge applicability to Claxedo

This records the **pre-fix audit**. The seven defects below are now addressed on `dev`; see [the implementation and validation record](2026-10-03-t3-merge-fixes.md). The temporary defect-observation probes were replaced by package regression tests and browser flows.

Reviewed 2026-10-03 against `dev` at `0c272d491f115f4c7093889c2bf446cc365bc319`, including the working tree. Input: the user's 339-item pasted list. This is an applicability and defect review, not an implementation change or a verification of T3's implementation.

**Seven actionable defects were found in three areas: portable handoff, host-created child follow-ups, and queue editing.** Existing focused tests pass; they do not exercise the failing cases. All seven concern code already present before this review. No production code was changed.

The working tree already had edits in `session-core`'s delivery owner/queue/tests and the app's queued-message timeline/README. Those edits were preserved and are included in the reviewed behavior. In particular, queue restart/order improvements in that dirty tree must not be described as committed fixes.

## Bugs that need fixing

### B1 — P1: portable handoff exports private reasoning

**Trigger:** switch an existing session to another harness, then send a message.

`sessions.updateConfig` → `executeHandoffTransaction` → `renderSessionHandoff(store.getMessages(...))` → `resolveTurnSystem` supplies the resulting transcript to the new harness. In [`session-handoff.ts:20`](../../packages/agent-runtime-contract/src/session-handoff.ts#L20), `partText` accepts any part with a string `text` before checking its type. A `reasoning` part therefore becomes ordinary assistant context sent to another provider. Tool serialization also admits pending/running status rather than explicitly selecting safe completed history.

**Evidence:** the audit probe passes a reasoning part with a sentinel and observes the sentinel in the exported transcript. This is a local synthetic reproduction of the real serializer; no private production transcript was read or sent.

**Fix owner:** `agent-runtime-contract/session-handoff.ts`. Define a deliberate export policy by canonical part type; exclude reasoning and live tool state. Preserve useful completed tool evidence in a safe historical representation. Acceptance must cover text, reasoning, completed/failed/running tools, file/image parts and agent-authored messages. T3 item **19**.

### B2 — P1: failed/interrupted work disappears during handoff

[`session-handoff.ts:33`](../../packages/agent-runtime-contract/src/session-handoff.ts#L33) filters out every assistant message carrying `info.error`. A stopped turn may already have written files or produced useful text/tool results. The next provider sees the user's request with none of that progress and can repeat work or contradict the actual workspace.

**Evidence:** a real serializer probe containing `MessageAbortedError` and nonempty assistant output drops the output. The current tests cover a failed assistant with *no* parts, which misses this case.

**Fix owner:** the same serializer. Keep canonical partial content and label the terminal outcome; do not synthesize completion. Acceptance: completed tool effects followed by cancellation, provider error and usage limit. T3 item **13**.

### B3 — P2: handoff loses assistant sequence and author identity

[`session-handoff.ts:32`](../../packages/agent-runtime-contract/src/session-handoff.ts#L32) constructs a `Map(parentID → assistant)`, retaining only the last assistant row for each user. [`:41`](../../packages/agent-runtime-contract/src/session-handoff.ts#L41) prints every user-role row as `User`, even when `info.author.kind` is `agent`. Multiple assistant rows lose earlier steps; child completion wakes lose their source attribution.

**Evidence:** probes reproduce both an earlier assistant row disappearing and an agent-authored message becoming an unattributed `User` message.

**Fix owner:** the serializer. Walk the authoritative ordered history while preserving roles, author and outcome, then apply the history budget. Acceptance: multiple assistant rows per user, child wakes, unanswered users, failed partial turns and stable order. T3 items **10, 12**.

### B4 — P1: a finished child's follow-up never becomes active or wakes its parent again

The MCP [`session_send`](../../packages/claxedo-mcp/src/tools/sessions.ts#L185) operation permits sending to one's own child. However, [`onTurnStarted`](../../packages/session-core/src/routes/session-children.ts#L230) only transitions a child whose status is `pending`; a previously `completed` child stays completed. [`onTurnSettled`](../../packages/session-core/src/routes/session-children.ts#L249) then returns immediately for that terminal status. This affects Claxedo-created children, not the separately implemented Codex native-child path.

**Evidence:** a probe using `createChildSessionHost` and a real temporary SQLite `RuntimeStore` runs the lifecycle twice. The first run creates one wake. During the second run the child still reports `completed`, `activeChildren` returns zero, and its second completion produces no wake.

**Impact:** stale completion UI, missing follow-up results, and incorrect active-child admission accounting.

**Fix owner:** host child lifecycle plus its canonical subagent state machine. Represent later child runs explicitly, reset current-run state through the authoritative producer and retain previous result identity. Also check nested descendants before claiming whole-task completion. Acceptance must send two actual turns through the child prompt route and verify status, active-child limits, both parent wakes, restart recovery and preserved first results. T3 items **45, 47–50, 255** (the independent-children first-wake path already works).

### B5 — P2: editing a queued message drops its files/images

[`createQueueEdit`](../../packages/claxedo-app/src/session/view/queue-edit.ts#L15) hydrates only `queuedMessageText(record)` into a single text part. [`buildPromptInput`](../../packages/claxedo-app/src/composer/send.ts#L75) reconstructs attachments from the current draft, and [`replaceQueued`](../../packages/claxedo-app/src/server/session-queue.ts#L28) sends those replacement parts. `DeliveryQueue.replaceQueuedPromptParts` replaces the stored parts wholesale. There is no preservation of the original queued file/image parts.

**Evidence:** the source path is complete; a composer mechanism probe confirms text-only hydration produces no file/image attachments. The actual browser edit interaction was not run.

**Fix owner:** queue editor serialization/deserialization and composer draft ownership. Hydrate every supported queued part into the editor and round-trip it, including unchanged generic files and images. Do not repair this by silently merging attachments the user may intentionally remove. T3 items **208–209**.

### B6 — P2: queue editing overwrites the user's existing composer draft

The same [`queue-edit.ts:16`](../../packages/claxedo-app/src/session/view/queue-edit.ts#L16) writes into the ordinary session composer key without preserving its previous draft. Escape/cancel invokes `store.reset(key)` at line 34; successful replacement also resets the draft in `deliverDraft`. The queued message can replace an unrelated unsent draft, and cancelling does not restore it. The timeline's separate Cancel edit path releases the row without restoring that draft either.

**Evidence:** source inspection plus real composer-store replacement probe; browser interaction remains unverified.

**Fix owner:** the queue-edit lifecycle. Keep an edit draft and restore the complete previous draft, including context/attachments, on cancel or successful save. T3 item **211**.

### B7 — P1: a rejected queue edit is silently sent as a new prompt

If another client removes or claims the edited row, [`replaceQueued`](../../packages/claxedo-app/src/server/session-queue.ts#L34) returns false on a conflict. [`deliverDraft`](../../packages/claxedo-app/src/composer/send.ts#L170) returns early only when replacement succeeds. On false it falls through to `existing.send(...)`, creating new work, then clears the draft.

**Evidence:** the probe calls the real `createComposerSend` with a refused queue-replacement boundary. It observes one replacement attempt, one fresh send and an empty draft. The refusal is simulated at the server boundary; a live two-client race was not run.

**Fix owner:** composer submission. A failed edit must stay a failed edit with recoverable draft and conflict state; never reinterpret it as a new-send intent. Acceptance: row removed, row dispatched, provider ownership acquired, concurrent save and transport failure. T3 items **210, 212**.

## What we already have, and what is different

| Area | Current Claxedo position | Evidence owner |
| --- | --- | --- |
| Harness switching | Fresh target plus portable transcript; switch-back before sending restores the retained native session. Switching while busy is refused. No durable ordered switch queue. | [handoff](../../packages/session-core/src/host/handoff.ts), [session lifecycle](../../packages/session-core/src/host/sessions.ts) |
| Models and accounts | Live model/effort updates and owner-scoped credential selection exist. Full per-provider/per-model option retention and cross-account continuation need separate acceptance. | [model tests](../../packages/session-core/src/host/model-settings.test.ts), [credentials](../../packages/session-core/src/host/launch.ts), [account UI](../../packages/claxedo-app/src/accounts/README.md) |
| Handoff budgets | Fixed 60,000-character transcript/29,000-character side limits, newest suffix selection. No target-token-fit check or configurable/relevance budget. New prompt remains separate. | [serializer](../../packages/agent-runtime-contract/src/session-handoff.ts), [turnPrompt](../../packages/session-core/src/host/turn-record.ts) |
| Forks and rewind | Native fork operation for OpenCode and advertising ACP peers. Codex/Claude/Pi/Cursor native transports do not expose fork. No general portable cross-provider fork/merge-back workflow. ACP ignores the message boundary; selected-turn correctness needs a separate contract review before exposure. | [fork owner](../../packages/session-core/src/host/sessions.ts), [ACP fork](../../packages/harness/src/transports/acp/index.ts), [OpenCode fork](../../packages/harness/src/transports/opencode-sdk/transport.ts) |
| Delegation | Provider/model/role selection, explicit context, async/wait, timeout without cancellation, parent wakes, idempotent creation, permission ceiling and child inspection/cancellation exist. Follow-up lifecycle is broken (B4); batching and nested-work completion are not equivalent to T3. | [tools](../../packages/claxedo-mcp/src/tools/subagents.ts), [host](../../packages/session-core/src/routes/session-children.ts), [permission ceiling](../../packages/session-core/src/session/permission-ceiling.ts) |
| Agent thread tools | Create/list/read/page/send/cancel/handoff/rename plus worktree placement exist. Agent access is intentionally narrower than arbitrary cross-project thread management. Queue controls/fork tools are explicitly excluded from this inventory. | [inventory](../../packages/claxedo-mcp/src/tools/inventory.ts), [sessions](../../packages/claxedo-mcp/src/tools/sessions.ts), [reach](../../packages/claxedo-mcp/src/tools/session-reach.ts) |
| Pi | First-class RPC transport, 0.99–1.0 version gate, native profile/resume, model/thinking discovery, steering, extension dialogs/notices and context mapping. Declares no native subagents or permission requests; fork/rollback parity is absent. | [Pi](../../packages/harness/src/transports/pi-rpc/index.ts), [version](../../packages/harness/src/transports/pi-rpc/version.ts), [UI](../../packages/harness/src/transports/pi-rpc/ui.ts) |
| OpenCode | Uses the embedded SDK engine. Its server-launch/orphan-management and 1.x/2.x compatibility model differs from T3's external server integration. Native prompt cancellation already has deadline/signal tests. | [transport](../../packages/harness/src/transports/opencode-sdk/transport.ts), [cancel tests](../../packages/harness/src/transports/opencode-sdk/cancel.test.ts) |
| Cursor | Already uses official `@cursor/sdk`, not a CLI execution migration. Other login, sandbox, retry and recovery bullets require their specific acceptance scenarios. | [transport](../../packages/harness/src/transports/cursor-sdk/index.ts), [pinned SDK](../../packages/harness/package.json) |
| ACP | Negotiated capabilities, model/config/mode controls, request broker, resources, usage, child routing and restart handling. Missing native resume refuses; it does not fabricate a replacement conversation. Registry onboarding/install/checksum parity was not established. | [ACP](../../packages/harness/src/transports/acp/README.md) |
| Claude/Codex | Existing native child routing, child-owned usage, background delivery and bounded startup-stop recovery cover several T3 bug classes. Tests are focused boundary evidence, not a complete real-CLI/version matrix pass. | [Claude tests](../../packages/harness/src/transports/claude-sdk/child-delivery.test.ts), [Codex tests](../../packages/harness/src/transports/codex-app-server/native-children.test.ts), [recovery tests](../../packages/session-core/src/host/recovery.test.ts) |
| Grok/Antigravity-specific changes | No dedicated native transport for either in the harness registry. Generic ACP behavior can still matter; terminal status-hook support is not native chat integration. | [registry](../../packages/harness/src/registry/table.ts), [architecture](../harness/README.md) |
| Durable queue | SQLite queue, original requester/grant, ordered dispatch, held rows, uncertainty receipts, cancellation and steering incorporation exist. Current restart policy automatically resumes eligible rows; explicit hold survives restart. T3's hold-all-after-restart is a policy difference. | [queue](../../packages/session-core/src/session/delivery-queue.ts), [owner](../../packages/session-core/src/session/delivery-owner.ts), [tests](../../packages/session-core/src/session/delivery-owner.test.ts) |
| Requests | Broker checks live owner, retires stale requests, validates answers, persists before release, and routes child requests. Separate asynchronous questions answerable after provider exit are not established. | [request table](../../packages/harness/src/broker/requests/table.ts), [surface](../../packages/session-core/src/host/requests.ts) |
| Timeline/lineage | Durable events, server IDs, paged history, child projections and shared desktop/phone views exist. Exact scrolling, filtering, timer and result-retention claims need corpus/live acceptance, not keyword matches. | [writer](../../packages/session-core/src/projection/session-event-writer.ts), [paging](../../packages/claxedo-app/src/session/view/history-paging.ts), [subagents](../../packages/claxedo-app/src/session/view/subagent-views.ts) |
| Recovery/limits | Explicit stop outcomes, generations/fencing, reconciliation and background-task stop exist. Goal `limited` state and rate-limit diagnostics do not establish a general snooze/resume-at-reset continuation product. | [recovery](../../packages/session-core/src/host/recovery.ts), [background stop](../../packages/session-core/src/host/background-tasks.ts), [diagnostics](../../packages/session-core/src/projection/client-presentation/harness-diagnostics.ts) |
| Checkpoints/worktrees | Workspace checkpoint tools and worktree routes exist. They are not evidence of T3's per-run conversation/file rewind, overlap/symlink restore safety or fork merge-back. | [workspace tools](../../packages/claxedo-mcp/src/tools/workspaces.ts), [worktree routes](../../packages/workspace-runtime/src/routes/worktree.ts) |
| Tasks/schedules | Native Task/preset/session commands exist. Inspected live Task contracts/tool inventory do not expose T3-style scheduled automation CRUD. Design documents or a `wakes/dist` folder do not establish a live feature. | [Task tools](../../packages/claxedo-mcp/src/tools/tasks.ts), [Task package](../../packages/claxedo-tasks/src/contracts.ts) |
| T3 v2 migrations/native mobile builds | T3-specific database, browser-profile and native-client migrations are not Claxedo requirements. Our own protocol/cache/migration safety still needs its own tests. | [current architecture](../harness/README.md), [app rules](../../packages/claxedo-app/AGENTS.md) |

The [339-item checklist](2026-10-03-t3-merge-checklist.md) preserves the entire input and assigns each item an assessment. **Have** means a code counterpart exists, not full acceptance; **Partial** means only part of the combined claim exists; **Gap** means absent from the inspected authoritative surface; **Different** means T3-specific or a deliberate policy difference; **Bug** links to the findings above; **Verify** means insufficient evidence to make a positive or negative claim. Do not treat Verify rows as cleared bugs.

## Fix order and remaining acceptance

1. Fix B1–B3 together in the canonical handoff serializer, with actual switch acceptance on two different harnesses. This is one responsibility, not three fallback layers.
2. Fix B7, B5 and B6 as one queue-edit lifecycle slice. Prove files/images, draft restoration and a two-client conflict through the actual UI/server route.
3. Fix B4 in the host child lifecycle, checking permission/admission limits and per-run result identity rather than patching UI status.
4. Treat queued harness switches, portable cross-provider forks, fit-aware history budgets and reset-time automations as feature/policy decisions. Do not silently implement T3's fallback or old-version compatibility paths.

The remaining live acceptance belongs to the session/harness and app owners: real provider switch/resume, actual child follow-up prompt routes, browser queue edits, mobile/corpus rendering, authentication, checkpoint restores and packaged desktop behavior. Those environments were not launched in this review. Source plus focused tests cannot settle these criteria.

## Commands and results

All test commands ran from the named owning package, not the repository-root test script.

| Working directory | Command | Result |
| --- | --- | --- |
| `packages/session-core` | `bun test src/host/handoff.test.ts src/host/model-settings.test.ts src/host/recovery.test.ts src/routes/session-children.test.ts src/routes/child-requests.test.ts src/session/delivery-owner.test.ts src/session/permission-ceiling.test.ts` | 119 passed, 0 failed |
| `packages/agent-runtime-contract` | `bun test src/session-handoff.test.ts` | 3 passed, 0 failed |
| `packages/harness` | `bun test src/transports/opencode-sdk/cancel.test.ts src/transports/codex-app-server/native-children.test.ts src/transports/codex-app-server/usage.test.ts src/transports/claude-sdk/permissions.test.ts src/transports/claude-sdk/child-delivery.test.ts src/transports/claude-sdk/translate/usage-attribution.test.ts src/transports/pi-rpc/cancellation.test.ts` | 35 passed, 0 failed |
| `packages/claxedo-app` | `bun test --conditions browser src/composer/send.test.ts src/session/view/history-paging.test.ts src/session/requests/model.test.ts src/session/view/timeline/queued-message-status.test.ts src/server/session-stop.test.ts` | 21 passed, 0 failed |
| repository root | `bun docs/reviews/2026-10-03-t3-merge-probes.ts` | All defect-observation assertions passed; B1–B4 reproduced |
| `packages/claxedo-app` | `bun test --conditions browser ../../docs/reviews/2026-10-03-t3-composer-probes.ts` | Top-level assertions executed successfully; B7 reproduced, B5/B6 mechanism confirmed; runner reports 0 registered tests |

Total existing regression tests: **178 passed, 0 failed**. The audit probes assert observed bad behavior; they are diagnostic scripts, not passing desired-behavior regression coverage. Convert these cases into proper failing regression tests when fixing the owners.

Two preliminary attempts to run the composer probe as a plain `bun --conditions browser --tsconfig-override ...` script failed in Bun's JSX/tsconfig loader (`directory mismatch`, missing `react/jsx-dev-runtime`). Running it through the same browser-condition test loader as the app's tests executed the assertions successfully. No dependency or production-code change was made to bypass this.

No production imports changed, so architecture-ratchet/build/typecheck gates were not invoked for this documentation-only review. The review artifacts and their local links/checklist completeness were checked separately.
