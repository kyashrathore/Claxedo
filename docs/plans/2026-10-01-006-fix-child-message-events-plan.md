# Child messages and completion events

Owner: this chat. Scope: Claude child reports, completion notices, and autonomous parent continuation. Earlier UI/account edits belong to their existing plans and are preserved.

- [x] Prove the dropped report and synthetic prompt failures.
- [x] Capture completion and child-message events, including between turns.
- [x] Parent each distinct continuation execution to the latest real prompt and preserve paging.
- [x] Render child reports through the transcript event pattern.
- [x] Verify targeted units, types, native flows, theme behavior, and desktop closure.
- [ ] Clear the broader corpus, repository budgets, performance acceptance, version matrix, and CI merge gates.

## Evidence and ownership

The original native parent transcript contains a delivered child report and the parent’s later acknowledgement. The adapter’s user-frame path discarded report text, while `ClaudeHeldFrames.notice()` joined task summaries into the synthetic user opening written by `BrokerProviderTurns.admit()`. Claude owned both delivery and continuation; the host did not send those joined summaries back to the model.

The new real entrypoint uses Claude CLI 2.1.286 against a scripted model boundary. A native background `Agent` calls `SendMessage(to: main)`. Claude prints a replayed synthetic SDK user frame with `origin.kind: peer`, harness-stamped `senderTaskId`, sender name, decoded `body`, and `uuid`. These structured fields are declared in the installed SDK 0.3.285 types. The test uses the native CLI and its real delivery loop; no peer frame is fabricated at the application boundary.

`ClaudeQueryInput.observe()` leaves peer replays for `claudeAgentMessage()`, which emits the canonical report as `agent-message`. `task_notification` produces a separate `harness-notice`. Between turns, `ClaudeLiveQuery` freezes the query’s transcript owner at ingress and queues delivery through `claudeOutsideTurnDelivery()`; end-of-query waits for that delivery. Reports bypass the bounded held-frame queue.

A native `system/init` announces a continuation. `BrokerProviderTurns.admit()` takes the session lease, checks that announcement is still current, creates a fresh assistant execution id, and supplies the latest real prompt as `startTurn.parentMessageId`. It writes no user row and sends no SDK input. Usage, cancellation and failure still belong to that distinct execution. Missing prompt ownership rejects admission and releases the lease. Session-scoped SDK event identity prevents replay from moving or duplicating a persisted notice across executions or broker recreation.

`NoticePartDisplay` renders the report as an expandable “Message from” event. `Timeline.coldFinalVisibleAssistantMessageIds()` retains notice-bearing replies beside the final reply. The native test first exposed a real visibility failure: the report was persisted correctly in an intermediate continuation but hidden by cold final rendering. The visibility fix made that same public flow pass.

After restart, the user's existing `Goal blocked immediately` conversation still showed CC bubbles. Read-only inspection found eight stored user-role rows with canonical `claxedo.author.kind: agent`, authored by `harness:claude`. The producer correction changes future delivery, while `TimelineUserMessage` still rendered these existing rows through `MessageAuthorLane` and the human `Message` renderer. Its presentation now branches on the canonical author kind. `AgentMessageEvent` owns the same event chrome for both stored agent-authored rows and typed incoming reports. Stored text is preserved, other parts use `Part`, and agent rows have no human avatar or user actions. `messageAuthor` moved into the transcript model so attribution has one parser. No stored row is rewritten and no notice is synthesized from message text. Historical bodies remain the old host's summaries; this change does not reconstruct the original report.

Live desktop inspection of the exact historical `claude-lifecycle-audit` row showed “Message from Claude Code” with its existing report-delivered text inside the disclosure, with no CC bubble or user controls. The nearby real human prompt “do same research for codex now” retained its bubble and copy action. The event presentation remained after reloading the native window.

The replaced summary-joining path was removed. `projectSessionCommands` moved into its own owner when projection growth hit its file budget; the reviewed projection ceiling decreased from 1380 to 1370. The intentional renderer CSS module first increased desktop closure to 1249 modules/36 packages. Extracting the shared `AgentMessageEvent` added exactly one module, for a final 1250 modules/36 packages; its adjacent policy comment names the shared owner, and the full desktop closure build and emitted manifests pass. No package edge was added.

## Opus review and spawn verification

All calls used the installed Claude CLI, with explicit `--model claude-opus-5-5`. They did not use Codex collaboration agents.

A fresh one-turn, tool-free smoke call returned `OPUS_SPAWN_CHECK_OK` in 1921 ms. Both the assistant model field and result `modelUsage.canonicalModel` were `claude-opus-5-5`; provider was `firstParty`, status success, `is_error: false`. The proof is `/tmp/claxedo-opus-spawn-check.md`.

The first full source review completed on that model. It agreed with event presentation and raised concerns about the proposed removal of user boundaries, paging, event ownership, and admission races. It inspected an intermediate implementation, so its missing factory/renderer and type errors were subsequently resolved. A shorter source packet review recommended fresh continuation IDs and explicit latest-prompt parentage. Tests now cover both those contracts, cold final visibility, stale admission, and persisted replay identity.

A later tool-free source-packet rereview failed to complete: it emitted attempted tool calls as text despite the disabled tool set and was stopped. It is not counted as successful review evidence.

The final architecture decision review completed successfully in 8979 ms with canonical model `claude-opus-5-5`, provider `firstParty`. Its verdict supports the choice: SDK user role describes model input, while peer origin describes authorship; event presentation and execution tracking are separate. It cautioned about attribution concurrency, stable replay ids, owner availability, ordering, multi-child delivery, and SDK drift. Ingress ownership, latest-prompt admission, persisted replay, mid-claimed-turn delivery, and multi-child/notice ordering have targeted coverage. The complete supported CLI version matrix remains unverified. This final review judged the supplied architecture and evidence; it was not a new full current-diff audit. Result: `/tmp/claxedo-child-events-opus-decision-review.md`.

## Commands and outcomes

- `cd packages/harness && bun test src/transports/claude-sdk`: 206 passed, 0 failed.
- `cd packages/workspace-runtime && bun test src/broker-ports/index.test.ts src/broker-ports/continuations.test.ts src/broker-ports/session-events.test.ts src/projection/client-presentation`: 250 passed, 0 failed.
- `cd packages/claxedo-app && bun run test`: 408 passed, 0 failed. A later targeted timeline run also passed all 5 cases.
- `cd packages/agent-runtime-contract && bun test src/agent-runtime-event.test.ts`: 4 passed, 0 failed.
- `bun run --cwd packages/harness typecheck`, `bun run --cwd packages/workspace-runtime typecheck`, `bun run --cwd packages/claxedo-app typecheck`, `bun run --cwd packages/claxedo-app typecheck:e2e`: passed.
- `cd packages/claxedo-app && bun run e2e e2e/flows/45-child-message-events.spec.ts --project=web --project=phone --repeat-each=10`: 20 consecutive passes. Separate build/port/output directories isolated the run. The flow asserts exactly one human prompt, multiple replies parented to it, one canonical report, expansion/collapse and persistence after reload.
- `cd packages/claxedo-app && bun run e2e e2e/flows/45-child-message-events.spec.ts --project=web --project=phone`: 2 passed with additional dark/light checks and phone 44px targets.
- The new `child-message-event` corpus baseline was recorded for web/phone. Native-run timing uses the corpus’s existing duration normalization, after a first comparison differed only by 0s/1s. Other case baselines were not refreshed.
- `cd packages/claxedo-desktop && bun run verify:closure`: production build, 14 packaged-resource tests, emitted manifests and authoritative closure checks passed.
- `bun run test:architecture-ratchets`: source dependency/product checks and helpers passed; final command fails on three pre-existing generated Storybook assets over the file limit.
- `cd packages/claxedo-app && bun run check`: 18/19 steps pass; Composer 11326/11260 and Notifications 220/168 budgets remain over. No ceiling was raised for them.
- `cd packages/harness && bun run check`: fails existing transport/profile budget and policy/size violations. Claude transport is 3499 production lines against 2969; HEAD was already 3457. This slice adds 42 lines, so its aggregate budget is not accepted. Owner/follow-up: harness reduction work, without hiding code or raising the budget.
- `git diff --check`: passed.

Two parallel browser runs initially shared `dist-e2e`; a concurrent build removed files used by another run. Those interrupted runs are discarded acceptance evidence. Final runs use separate `CLAXEDO_E2E_DIST_DIR`, port ranges, and output paths.

## Remaining acceptance

### Stored-author rendering follow-up

The follow-up full comparison completed with 43 passes and 7 failures in 8.7 minutes. Six failures belong to previously reproduced cases: failed-turn on web/phone, plus limited-turns, stream-rows-stable, thought-ends-before-reply, and worked-turn-folds on phone. Their baselines are unchanged. The seventh was the new web fixture's changing auto-mode port notice, corrected by the explicit permission setup and verified by the final separate web/phone comparison (2 passes). The full run's phone event case also passed. Command: `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-stored-agent-corpus-dist CLAXEDO_E2E_PORT_RANGE=47500-47599 bun run e2e e2e/flows/30-transcript-corpus.spec.ts --project=web --project=phone --update-snapshots=none --output=e2e/results/stored-agent-corpus`. Log: `/tmp/claxedo-stored-agent-corpus.log`. Artifacts: `packages/claxedo-app/e2e/results/stored-agent-corpus/`. Failed/limited rows again miss their expected starting text; stream-rows-stable has the same extra phone row and screenshot height mismatch. The user-visible history correction is verified; the broader integration gates above remain open.

`e2e/flows/46-agent-authored-messages.spec.ts` and corpus case `agent-authored-message` exercise the same stored shape through the public Goal route and the authoritative `BrokerProviderTurns` producer. The native Claude CLI runs against the existing scripted model boundary; neither a database row nor a runtime event is fabricated. A preceding human prompt deliberately includes agent-report wording to prove that text cannot select event presentation. The flow checks exact preserved opening text, collapse/expand, reload, absence of human copy controls, transparent surfaces in both themes, and phone targets.

- `cd packages/claxedo-app && bun run test`: 411 passed, 0 failed; canonical-author coverage includes human, agent, missing, incomplete, unknown-kind, and assistant-role cases.
- `cd packages/claxedo-app && bun run typecheck && bun run typecheck:e2e`: passed.
- `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-stored-agent-flow-dist CLAXEDO_E2E_PORT_RANGE=47300-47399 bun run e2e e2e/flows/45-child-message-events.spec.ts e2e/flows/46-agent-authored-messages.spec.ts --project=web --project=phone --repeat-each=10 --output=e2e/results/stored-agent-repeat`: 40 passed in 5.2 minutes, 20 per flow across desktop and phone. Log: `/tmp/claxedo-stored-agent-repeat.log`.
- `cd packages/claxedo-desktop && bun run verify:closure`: passed, including production build, 14 packaged-resource checks, emitted manifests, and the exact reviewed 1250/36 renderer closure.
- `bun run test:architecture-ratchets`: source closures and helpers pass; final file-size scan still fails the same three generated Storybook assets.
- `cd packages/claxedo-app && bun run check`: 18/19 steps pass; the same existing Composer 11326/11260 and Notifications 220/168 budgets fail. No renderer policy, ownership, CSS, or hygiene check fails.
- `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-stored-agent-baseline-dist CLAXEDO_E2E_PORT_RANGE=47400-47499 bun run e2e e2e/flows/30-transcript-corpus.spec.ts --project=web --project=phone --grep agent-authored-message --update-snapshots=none --output=e2e/results/stored-agent-compare`: 2 passed. Only this new case's baseline was recorded.

The first focused run failed because its body locator matched the outer body and nested text block; the corrected direct-child locator checks the actual event body. The first corpus comparison also exposed a fixture nondeterminism: Claude's auto-mode notice included the stack's changing port number. The test now uses the same explicit native bypass permission mode as the existing child-report fixture, removing classifier notices from this unrelated renderer scenario. The notice producer and renderer remain intact. Final comparison log: `/tmp/claxedo-stored-agent-compare.log`.

### Earlier producer-only full comparison

The isolated full web/phone corpus comparison completed: 41 passed and 7 failed. The child-message-event case passes in both projects. Failures: failed-turn and limited-turns on web and phone, plus stream-rows-stable, thought-ends-before-reply, and worked-turn-folds on phone. These seven failures were also reproduced in the preceding folding investigation’s HEAD control run; this slice does not refresh their baselines. The full comparison command was `CLAXEDO_E2E_DIST_DIR=/tmp/claxedo-child-corpus-dist CLAXEDO_E2E_PORT_RANGE=46900-46999 bun run e2e e2e/flows/30-transcript-corpus.spec.ts --project=web --project=phone --update-snapshots=none --output=e2e/results/child-corpus-final`. Log: `/tmp/claxedo-child-events-full-corpus-final.log`; failure artifacts: `packages/claxedo-app/e2e/results/child-corpus-final/`. Owner/follow-up: app transcript acceptance and authoritative failed/limited-turn producers; fix and compare the existing cases without synthesizing transcript content. Performance benchmark parity, the supported CLI version matrix, and 3 CI repetitions remain unverified. These belong to their harness/app acceptance owners before merging. Native acceptance used fresh source-built test stacks. After the user requested a restart, `bun run dev` rebuilt the runtime/server artifacts and launched new renderer/server processes. The server reported healthy on 2593, the UI listened on 5173, and the Claxedo window loaded successfully. Restart log: `/tmp/claxedo-child-events-live-restart.log`; running exec session: 94566. No commit or merge is performed for this slice.
