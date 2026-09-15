# Live replay duplication and subagent completion rendering

Date: 2026-09-15. Worktree: `/Users/yashvardhansingh/test/opencode-session-rendering`.

## Confirmed causes and fixes

### Live-only duplicate paragraphs and chips

A session switch clears the client raw-event projection state. A retained runtime stream can replay from the middle of a turn, while the canonical message page already contains its text and tools. The client projection reconstructed those same parts using different ordinal IDs and merged them into the canonical transcript. Completion hydration then replaced the polluted client state, explaining why the copies vanished after streaming.

The authoritative REST transcript for session `cbf31c4f-3606-4dc9-8e78-09205d6f38b3` contained each passage once and one bound spawn. A browser regression reproduced duplicate text after raw replay: expected 1, received 2 (`/tmp/duplicate-live-red.log`).

`projectRuntimeDiagnosticEnvelope` now admits runtime-only diagnostics, with no transcript accumulator. Canonical server presentation events alone update text/tool/message rows. Raw subagent lifecycle, goals and replay-gap handling remain active. Child SDK/ACP projectors now publish their actual canonical events instead of discarding them; child turn start/finish events publish through the same bus. No content-based deduplication or synthetic replacement IDs were added.

### Child chip changes shape when the parent finishes

The recorded parent terminated its spawning script at 11:17:06 UTC; the child completed afterward. Its persisted wrapper is correctly `error: Tool execution interrupted`. The old UI assumed every failed wrapper meant no child had been created. It stopped treating that part as a child host and chose the generic tool-error renderer.

`ToolPartDisplay` now renders the real registry-bound child before considering the wrapper error. `isSubagentHostPart` includes interrupted spawns, so their child remains inline rather than also moving to the ambient section. An unbound failed spawn still shows its error. The native producer status is not changed or fabricated.

The actual completed session was opened in the rebuilt **Claxedo Dev (opencode-session-rendering)** app. Native screenshot and accessibility inspection showed one compact, truncated child chip labeled done in the transcript. Opening it loaded the real completed child transcript in the read-only workspace panel; the app was returned to the parent transcript.

## Verification

Commands below run in the named package directory, except architecture checks at the worktree root.

- `packages/claxedo-app`: `bun test --conditions=browser --preload ./happydom.ts ./src/app/providers/global-sdk/runtime-event-projection.test.ts ./src/app/providers/global-sdk/provider.test.ts` — 32 passed.
- `packages/agent-sdk-runtime`: `bun test ./src/harnesses/shared/sdk-runtime-adapter.test.ts ./src/harnesses/shared/turn-projection.test.ts ./src/harnesses/shared/child-event-routing.test.ts` — 51 passed.
- `packages/agent-sdk-runtime`: `bun test ./src/harnesses/acp/index.test.ts` — 31 passed.
- `packages/workspace-runtime`: `bun test ./src/routes/session-event-privacy.test.ts ./src/routes/events.test.ts` — 15 passed.
- `packages/claxedo-app`: `bun run test:vitest ./src/features/session/ui/subagent-wrapper-outcome.vitest.tsx` — 2 component tests passed (runner: Vitest with `vitest.config.ts`).
- `packages/session-ui`: `bun test ./src/components/part-groups.test.ts` — 27 passed.
- `packages/claxedo-app`, `packages/session-ui`, `packages/agent-sdk-runtime`: `bun run typecheck` — passed. App check includes its E2E typecheck and 38 performance tests.
- Root: `bun run test:architecture-ratchets` and `git diff --check` — passed.
- `packages/claxedo-desktop`: `bun run predev` — rebuilt the runtime bundle and verified compile cache. `bun run dev` — restarted the correct worktree app and server; health verified at port 2593. No active/rerunning turns were present before restart.

Browser commands use `PLAYWRIGHT_PORT=4471 PLAYWRIGHT_VIDEO=0 bunx playwright test --project=chromium` in `packages/claxedo-app`.

- `--grep 'interrupted Codex command stays|claude-sdk \(native\)|subagents — Claude native|below the md boundary|a live reply keeps|streaming interleaved|streamed tables' e2e/playwright/core-harness-rendering-matrix.spec.ts e2e/playwright/core-timeline-rendering-scroll.spec.ts` — 7 passed, 1 outdated narrow-screen expectation failed. Canonical replay, streaming interleaving and immediate streamed tables/lists passed.
- Initial full matrix: 35 passed, 5 failed. Four failures were obsolete test synchronization/Claude picker labels. The fifth assumed mobile child navigation still used a desktop panel, contrary to the committed narrow-screen policy. Tests now synchronize on real raw subagent lifecycle, use the current Claude Code label, and exercise read-only narrow child navigation plus return to parent. Hidden retained parent DOM is excluded from visible composer assertions.
- `e2e/playwright/core-harness-rendering-matrix.spec.ts` — final full matrix: **41 passed, 0 failed (4.4 minutes)**. Log: `/tmp/duplicate-matrix-final.log`.

Browser regressions assert one paragraph and one child chip across session switch/raw replay, canonical text continuation, interrupted wrapper handling, child navigation, and equal 28px pill height before/after child completion.

## Limits

This verifies the reported duplicate replay and child wrapper/rendering paths. It is not a claim that every earlier scrolling or virtualization issue is resolved. Streaming regressions use the real app event entrypoints with controlled transport fixtures; a new paid vendor turn was not run for this patch. The existing real completed session was inspected in the rebuilt native app.
