# Long user message folding

Owner: this chat. Scope: user-message bubbles only, as explicitly chosen by the user. Assistant replies, work-group folds, server messages and attachment content remain unchanged. Account/provider-card changes and the existing transcript-corpus reading-position work are separate working-tree slices.

- [x] Fold user text that exceeds an eight-line preview, using rendered height so plain text, markdown and narrow layouts agree.
- [x] Keep expansion local to the message, attachments visible and copy operating on the full original text. Preserve keyboard access and scrolling when collapsing.
- [x] Add desktop/phone acceptance and a transcript corpus case; prove the flow fails before the fix, then run the full corpus.
- [x] Run typechecks, package checks, architecture ratchets, emitted product closure and native smoke checks; record the remaining gates below.

The author's avatar retains its hover title and accessible name, with no caption underneath and smaller 9px initials. The fold button sits inside one card surface: the parent paints the background, and its text child is transparent, preventing translucent colors from stacking into a second footer. The preview has no fade or blur. The desktop button is 28px high; coarse pointers retain a 44px target. Plain text and markdown share one implementation, replacing their duplicated body markup.

Validation commands run from `packages/claxedo-app` unless stated otherwise:

- `bun run typecheck` and `bun run typecheck:e2e`: passed on the final implementation.
- `bun run test`: 406 passed, zero failures; `/tmp/claxedo-fold-last-unit.log`.
- `bun run check`: 18 of 19 steps passed, including E2E hygiene and all transcript rules. Existing Composer and Notifications line budgets fail; `/tmp/claxedo-fold-last-check.log`.
- Red proof: `bun run e2e --project=web --grep '30 long plain user messages'` failed because the actual long bubble had no Show all button, before implementation; `/tmp/claxedo-user-fold-red.log`.
- Final acceptance and corpus comparison: `bun run e2e --project=web --project=phone --grep '30 transcript corpus: long-user-message|30 long .* user messages' --update-snapshots=none --output=/tmp/claxedo-fold-last-compare --reporter=list`: six passed. Only the new case's 28 snapshots were recorded. Copy returns the full original prompt, reload starts folded, both themes render one surface, and phone targets retain their size. Logs: `/tmp/claxedo-fold-last-compare.log`; final theme captures: `/tmp/claxedo-fold-last/`.
- Whole existing corpus: `bun run e2e --project=web --grep '30 transcript corpus:' --grep-invert long-user-message --update-snapshots=none --reporter=list` and the same command with `--project=phone`: 18 passed/one failed on web, 14 passed/five failed on phone. The failure classes are the before-change failures below; the web limited-turns failure is intermittent. Independent compiled app directories and ports were used; logs `/tmp/claxedo-fold-one-surface-web.log` and `/tmp/claxedo-fold-one-surface-phone.log`. Existing snapshots were never refreshed.
- Before-change comparison: a temporary Vite load plugin built the four changed existing renderer/style files from `8c09462469`, retaining the same real runtime and test driver. `node --conditions=development ./node_modules/@playwright/test/cli.js test --config /tmp/claxedo-fold-before.playwright.config.mts --project=web --project=phone --grep '30 transcript corpus: (failed-turn|limited-turns|stream-rows-stable|thought-ends-before-reply|worked-turn-folds)' --update-snapshots=none --reporter=list` reproduced all seven failures from the first whole-corpus run. Logs `/tmp/claxedo-fold-before-build.log` and `/tmp/claxedo-fold-before.log`. This comparison does not alter production sources or add a fallback.
- Root `bun run test:architecture-ratchets`: 21 tests, all six source product policies, and helpers passed. The existing generated Storybook files fail the file-size scan; `/tmp/claxedo-fold-last-ratchets.log`.
- `bun run verify:closure` in `packages/claxedo-desktop`: final desktop production builds, 14 packaged-resource tests and all three emitted boundary policies passed; `/tmp/claxedo-fold-last-closure.log`. The exact renderer ceiling grows from the provider-card slice's 1246 to 1248 modules for the fold component and stylesheet, with 36 packages unchanged. The message-part ceiling falls from 2523 to 2516 lines.
- Native dev app was restarted with `bun run dev` and remains running; `/tmp/claxedo-user-fold-live-final.log`. A real long history bubble was observed folded, and the avatar caption was observed removed. Final refinements were inspected in desktop/phone Chromium theme captures; final native pixel inspection was not completed while the user was reviewing another pane.

Remaining gates:

| Gate | Evidence and owner | Follow-up |
| --- | --- | --- |
| Whole corpus clean | Existing failed-turn/limited-turns can lose assistant text before an ACP error: the real `/session/:id/outline` response carries empty assistant parts. This also occurs with the before-change renderer. Harness/runtime owner. | Preserve the canonical text at its producer; do not synthesize it in the renderer. |
| Phone reasoning corpus | Before-change phone stream-rows-stable/worked-turn-folds show an extra Thought row; thought-ends-before-reply has no phone baseline. Transcript/corpus owner. | Reconcile the established reasoning behavior and missing baseline in its own slice. |
| Package budgets | Composer 11326/11260 and Notifications 220/168, predating this slice. Respective domain owners. | Split the existing responsibilities without increasing ceilings. |
| Root file-size scan | Three generated `packages/storybook/storybook-static` JS files exceed 800 lines, predating this slice. Storybook/build tooling owner. | Resolve how generated outputs participate in the production scan. |
| Merge acceptance | One comparison run on the final presentation; no 20 consecutive local runs, three CI repeats, or cross-build benchmark. | Run the required repetition and benchmark gates before merging this slice. |

The initial corpus exposed a six-pixel short-bubble regression from an inline-block baseline inside the new wrapper; the content wrapper now uses flex, restoring the old short-message geometry. The corpus's fold interaction addresses stable visible message text, because position-based selection breaks when virtualization prunes earlier rows. All stopped runs and temporary before-change tooling are outside the repository.
