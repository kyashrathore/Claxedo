# Composer

The prompt editor and everything that turns a draft into one `PromptInput` for `SessionView.send`.

## Owned concepts

- **Draft**: the prompt parts (text, `@file` and `@agent` pills, images with marks), the cursor, the context items (file comments and text mentions) and whether goal mode is armed. One draft per composer key: `session:<sessionId>` for an open session, `draft:<placementId>:<draftId>` for a session that does not exist yet. Drafts live in `ComposerStore`, in memory, capped at 20 keys; keys a mounted composer retains are never evicted.
- **Selection**: the harness ("agent" in the UI), model, effort and permission mode chosen for a key. The options come only from `Capabilities.harnesses`; an open session's harness is fixed by its row.
- **History**: the last 100 sent prompts per key and editor mode, navigated with the arrow keys from an empty draft or from a history entry.
- **Attachments**: files read into image parts. `attachments/files.ts` decides the mime an attachment travels under and whether the target harness can take it.
- **Image marks**: boxes and pins the user draws on an image. Marks are drawn onto a PNG copy only when the prompt is sent (`marks/flatten.ts`); the draft keeps the original.
- **Send**: `send.ts` builds the `PromptInput` from the draft and the selection, sends it over `SessionView.send` (creating the session first for a draft key), records history and clears the draft.

## State machines

- **Composer send**: `editing → sending(clientRequestId) → accepted | rejected(error)`; `edited` returns to `editing`. A rejected send shows its `AppError` by class (`composer.error.<class>`), with a retry when the error is retryable. Nothing retries on its own.
- **Attachment**: `reading → ready(part) | failed(error)`. A ready part joins the draft at the cursor; a failed one stays listed until dismissed or the next add.
- **Editor interaction** (`controller.ts`): the editor mode (`normal | shell`), the popover (`closed | at(query) | slash(query)`) and the history position.

## Invariants

- The draft is the only copy of what the user typed; the contenteditable is rendered from it and parsed back into it on input.
- `!` at the start of an empty prompt enters shell mode; the text is sent as a prompt beginning with `!` because today's contract has no shell route.
- `/goal` arms goal mode; `/goal <objective>` and an armed send carry `goal: { objective }`. Only a harness whose `goalMode` is not `none` offers it.
- Slash entries come from the shell's command registry (`ComposerServices.commands`) plus `/goal`; `@` entries come from the placement's file search and the shell's mention sources.
- No comments, no polling, no second copy of server data: the composer reads session status and requests through `SessionView` only.

## Flows

- 3 (send a turn), 4 (stop and queued messages), 5 (errors by class), 6 (attachments, marks, `@file`, slash commands, pickers, permission mode), 7 (goal mode), 33 (phone).
