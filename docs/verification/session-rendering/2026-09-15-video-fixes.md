# Video rendering fixes — 2026-09-15

Worktree: `/Users/yashvardhansingh/test/opencode-session-rendering`.
This records the changes made after reviewing the 45.875-second recording. It does not certify every earlier change in this worktree.

## Changes and ownership

1. **Each central text delta is applied once.** `ClaxedoEventsProvider` publishes the event's actual origin to typed subscribers. `createGlobalSyncEventIngress` accepts central directory events through GlobalSDK and workspace events through its direct handler. Previously a central frame reached both paths: the browser regression received three table rows after a single delta should have grown one row to two. The correction selects the owning path; it does not deduplicate text or invent events. Two identical legitimate deltas still both apply. Workspace-scoped title metadata is preserved on the global path.
2. **Lists and tables grow visibly.** `markdown-stream.ts` no longer discards a live trailing list/table. Completed earlier parts therefore do not suddenly acquire a previously withheld block at message completion. `message-part.tsx` also honors an explicit text-part `time.end`; later siblings do not synthesize completion.
3. **Immediate and enhanced Markdown share syntax rules.** The synchronous renderer previously used default Marked while the asynchronous renderer used custom raw-HTML, code-span and link rules. Both now use the same `transcriptMarkdownExtensions`. Raw HTML remains literal according to the existing product policy, but no longer briefly renders as HTML before changing presentation.
4. **Image loading differs from failure.** Pending HTTP images reserve the thumbnail box with a loading visual and accessible description. Alt text appears visibly only on failure. Pending, loaded and failed geometry is tested through a real browser HTTP image load and decode failures.
5. **Returning preserves reading position and following intent.** Removed the idle-return policy that assigned `scrollTop = 0`. Timeline mount snapshots now include offset, row anchor and following intent. Retained returns and remounts use that state. Hidden auto-scroll observers cannot clear paused reading intent or write unusable geometry. The existing prepend-anchor machinery now lives with its helper rather than expanding the large timeline component.
6. **The header spinner keeps its allocated space during its hide transition.** Its wrapper now follows the same visibility state as the spinner itself.

## Browser acceptance

Chromium, real app entrypoint, controlled runtime/event fixtures:

| Scenario | Result |
| --- | --- |
| Return to an idle 61-turn session | Passed; 117 visible frames, 0px drift |
| Return while the session continues streaming and receives hidden output | Passed; 118 visible frames, 0px drift |
| Return after the session finishes while hidden | Passed; 114 visible frames, 0px drift |
| Live table/list before completion, delta growth, explicit part end, later part, message end | Passed |
| Delayed HTTP image, corrupt image and missing image | Passed; reserved geometry retained |

The streaming fixture was corrected to announce its text part before deltas. The live-block test now pauses the producer at each checkpoint and asserts before sending the next event. This prevents a final snapshot from hiding a broken intermediate state. Return tests use actual wheel gestures, sample every animation frame, and select the visible composer rather than a retained hidden one.

## Commands and outcomes

From `packages/session-ui`:

```sh
bun test ./src/components/markdown-stream.test.ts
```

25 passed.

From `packages/claxedo-app`:

```sh
bun test --conditions=browser --preload ./happydom.ts \
  ./src/features/session/ui/timeline-scroll-memory.test.ts \
  ./src/features/session/ui/timeline-mount-cache.test.ts \
  ./src/features/session/ui/auto-scroll-viewport-resize.test.ts \
  ./src/features/session/ui/timeline-virtualization.test.ts \
  ./src/features/session/ui/timeline-working-status.test.ts \
  ./src/features/session/ui/message-timeline-virtualizer-quiescence.test.ts \
  ./src/app/integrations/session-events/event-ingress.test.ts \
  ./src/app/integrations/claxedo-events.test.ts

bun run test:vitest \
  ./src/features/session/ui/markdown-rich-stage.vitest.tsx \
  ./src/features/session/ui/markdown-progressive.vitest.tsx \
  ./src/features/session/ui/markdown-image-tile.vitest.tsx \
  ./src/features/session/ui/text-part-lifecycle.vitest.tsx

bun run typecheck
bun run typecheck:e2e

PLAYWRIGHT_PORT=4470 PLAYWRIGHT_VIDEO=0 bunx playwright test --project=chromium \
  --grep 'returning to a .*heavy session|streamed tables and ordered|loading a user Markdown image' \
  e2e/playwright/core-timeline-rendering-scroll.spec.ts

PLAYWRIGHT_PORT=4470 PLAYWRIGHT_VIDEO=0 bunx playwright test --project=chromium \
  --grep 'returning to a .*heavy session' \
  e2e/playwright/core-timeline-rendering-scroll.spec.ts
```

73 focused Bun tests and 16 component tests passed. Typecheck passed, including architecture and performance checks. The five browser scenarios passed; the subsequent three-case run added the frame-level assertions and passed. Early red runs identified the list/table omission, duplicate event routing, and invalid test assumptions; those failures were investigated rather than retried unchanged.

From the worktree root:

```sh
bun run test:architecture-ratchets
git diff --check
```

Both passed. No ceiling was raised.

## Remaining acceptance limits

- Packaged desktop with a real Codex harness has not been rerun. Owner: desktop/harness QA. Repeat the recording's workload and rapid session switches against this worktree's build.
- Full remount restoration has focused state coverage; the browser cases exercise retained session switches. They do not exercise eviction beyond cache limits or process restart.
- The source text and event identities from the original two recorded sessions were not captured. The verified mechanisms above do not attribute every visible transition in that recording.
- Codex permission policy/reconciliation and the separately reviewed turn/group-folding issues were not changed by this slice.
- Existing unrelated dirty changes remain in place. No commit, push or deployment was performed.
