# Groups, output cards, assistant images and queued messages

Worktree: `/Users/yashvardhansingh/test/opencode-session-rendering`.

## Implemented

- Trailing active work group keeps its Running/Editing/Fetching summary and shimmer between completed calls. Each completed shell member still says Ran. A later transcript group or turn completion settles the aggregate. Existing caller-owned group boundary remains authoritative.
- Restored member icons; search/web/fetch use a magnifying glass, shell uses terminal, edits use pencil, writes use file. Non-expandable tool rows keep their icon too.
- Output/group scrollbars have explicit visible track/thumb styling. Removed app-wide scrollbar hiding for the existing data-scrollable regions; kept other surface rules. Light/dark browser checks verified actual scrollbar display and scrollability.
- Assistant Markdown previews read the displayed source after streaming updates. Linked-image labels now parse inline tokens. Timeline click interception leaves image tiles to the preview owner instead of navigating first.
- Busy submissions go to the runtime-owned queue without inserting optimistic normal transcript messages. Queued records render in the timeline after the last row as dimmed user-message bubbles; Edit / Send now / Remove sit in the hover row under the bubble like a sent message's copy button, and the composer's old `Queued` chip is gone. Edit holds the record on the runtime (`POST …/queue/:seq/hold`; a held record waits past the next idle instead of auto-sending under the edit) and loads its text into the composer; the next send replaces the record's parts in place and releases it (`…/replace`, durable row updated before the waiting turn); Escape in the composer or the bubble's Cancel edit releases it untouched (`…/release`) and clears the draft; a 409 on replace — the runtime admitted it meanwhile — sends the draft as a new message. Holds live with the process, not the row. Automatic admission clears pending records. Controls respect idle-handoff races; cancelled/steered waiters abandon prior reservations. A newly admitted queued turn subscribes afresh to avoid replaying the preceding turn's buffered terminal events.
- Queue queries include server/session/workspace identity; only visible busy sessions or visible sessions with pending records poll. Removed unused old followup dock rather than increasing module ceilings.
- Desktop development session URLs now serve the existing canonical renderer document, preserving missing assets/API errors. This fixes the observed blank dev window after session-path reload; it is separate from the reported blank shell body.

## Focused automated checks

All commands run in their named package.

- claxedo-app: `bun test --conditions=browser --preload ./happydom.ts ../session-ui/src/components/work-group-summary.test.ts ../session-ui/src/components/message-part.test.ts` — 34 passed.
- workspace-runtime: `bun test src/routes/session-queued-prompts.test.ts src/routes/session-prompt-delivery.test.ts src/session/service.test.ts` — 30 passed.
- ui: `bun test src/context/marked-link.test.ts src/context/marked-autolink.test.ts src/context/marked-code-span.test.ts src/context/marked-raw-html.test.ts src/context/marked-native.test.ts src/context/marked-autolink-native-parity.test.ts` — 16 passed.
- claxedo-app: `bun test --conditions=browser --preload ./happydom.ts src/features/session/ui/timeline-external-image.test.ts` — 8 passed.
- claxedo-app: `bunx vitest run --config vitest.config.ts src/features/session/ui/markdown-image-tile.vitest.tsx` — 6 passed.
- claxedo-desktop: `bun test ./scripts/renderer-document-routes.test.ts` — 2 passed, using a local Vite HTTP server.
- `bun run typecheck` — claxedo-app, workspace-runtime, session-ui, ui and claxedo-desktop passed. Final app log: `/tmp/queue-app-typecheck-final.log`.
- Root `bun run test:architecture-ratchets` — passed, unchanged ceilings. Log: `/tmp/queue-ratchets.log`.
- Root `git diff --check` — passed.
- claxedo-desktop `bun run predev` — passed; published package builds and runtime artifacts current. Log: `/tmp/rendering-final-predev.log`.

## Browser evidence and explicit limits

Before the user requested stopping live testing:

- Command-group streaming boundary regression passed (1): `/tmp/group-live-browser.log`.
- Light/dark output plus Show all anchoring passed (3): `/tmp/output-cards-green.log`.
- Queue browser check passed on the live worktree app (Opus turn on the Claxedo project): the queued bubble rendered under Thinking; Edit pulled the text into the composer and the bubble read Editing; send replaced it in place (`POST …/queue/1/replace → 200`, one bubble, edited text, composer cleared); Send now removed it and the steered message appeared as a normal user message. Playwright `core-queued-messages.spec.ts` (mock runtime) covers two queued rows, dashed border, 0.7 text opacity, one transcript user message, Remove, Edit → replace with the edited parts, Send now.
- Assistant image browser confirmed streaming source update and keyboard preview. Its completed-image click exposed timeline interception; the final interception fix has focused automated coverage but has not been rerun live.

No further browser/native testing was performed after the user's stop instruction.

The entirely empty shell body in light theme remains **unreproduced and unconfirmed fixed**. Tested light-theme shells rendered actual output with readable contrast. No speculative theme patch was added. User testing is required for this reported case and the final combined behavior.

## User acceptance checklist

1. Let multiple shell commands run: group header stays shimmering between calls; expand it and completed members say Ran. After the assistant moves on, the group settles.
2. Expand shell/group output in light theme; inspect body, icons, and visible scrollbars.
3. Open assistant images during and after streaming, including linked images.
4. Open completed subagent chips, then switch away/back and try again.
5. Queue multiple messages during a turn: dim bubbles under the running turn with controls on hover; edit one, let the turn end while editing (it stays queued), Escape to cancel or send to change it in place; remove one, Send now another, and let another auto-send on the next turn.
