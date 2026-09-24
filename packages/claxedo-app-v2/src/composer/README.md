# Composer

The prompt editor and everything that turns a draft into one `PromptInput` for `SessionView.send`.

## Owned concepts

- **Draft**: the prompt parts (text, `@file` and `@agent` pills, images with marks), the cursor, the context items (file comments and text mentions) and whether goal mode is armed. One draft per composer key: `session:<sessionId>` for an open session, `draft:<placementId>:<draftId>` for a session that does not exist yet. Drafts live in `ComposerStore`, in memory, capped at 20 keys; keys a mounted composer retains are never evicted. `ComposerStoreProvider` mounts the store once, above the workbench, so a draft survives pane switches.
- **Harness selection** (`harness/`, today's app's harness store moved unchanged apart from its data access): the harness, model, effort and fast tier for a key, read by the harness → model picker (`view/agent-harness-selector.tsx`, `view/harness-model-picker.tsx`) and by the send. `harness/harness-config-store.ts` composes the store over `server.harnessConfig` and is mounted once by `ComposerStoreProvider`.
  - A draft opens on the harness last used for a draft in its workspace (localStorage `session.draft-default.v1`, keyed by server URL and workspace: the folder when this machine serves it, the workspace id otherwise), else on the folder's harness from the server (`agent-config/harness`, not for cloud placements), else on none: "Select agent", and Send is blocked with "Choose a model to continue".
  - Its model is that harness's remembered model for the workspace, else the harness's current model from its options. Effort is whatever the harness's options name as current for that model, else none. Switching harness clears the model, effort and fast tier and restores the picked harness's remembered model.
  - An open session reads its own config (`/session/<id>/config`). Picking a model there saves it to the session config; picking another harness is held until the next send, which saves the harness to the session config first.
- **History**: the last 100 sent prompts per key and editor mode, navigated with the arrow keys from an empty draft or from a history entry.
- **Attachments**: files read into image parts. `attachments/files.ts` decides the mime an attachment travels under and whether the target harness can take it.
- **Image marks**: boxes and pins the user draws on an image. Marks are drawn onto a PNG copy only when the prompt is sent (`marks/flatten.ts`); the draft keeps the original. The badge and its colours are `@/lib/image-mark-badge`, shared with the transcript.
- **Send**: `send.ts` builds the `PromptInput` from the draft and the harness submission (harness, model, effort as `variant`, fast tier), sends it over `SessionView.send` (creating the session first for a draft key), records history and clears the draft. File comments and mark comments travel as `text` attachments worded by `@/lib/comment-note`, the same sentences the transcript parses back into chips.

## State machines

- **Composer send**: `editing → sending(clientRequestId) → accepted | rejected(error)`; `edited` returns to `editing`. A rejected send shows its `AppError` by class (`composer.error.<class>`), with a retry when the error is retryable. Nothing retries on its own.
- **Attachment**: `reading → ready(part) | failed(error)`. A ready part joins the draft at the cursor; a failed one stays listed until dismissed or the next add.
- **Editor interaction** (`controller.ts`): the editor mode (`normal | shell`), the popover (`closed | at(query) | slash(query)`) and the history position.

## Invariants

- The draft is the only copy of what the user typed; the contenteditable is rendered from it and parsed back into it on input.
- `!` at the start of an empty prompt enters shell mode; the text is sent as a prompt beginning with `!` because today's contract has no shell route.
- `/goal` arms goal mode; `/goal <objective>` and an armed send carry `goal: { objective }`. Only a harness whose `goalMode` is not `none` offers it.
- Slash entries come from the shell's command registry plus `/goal`; `@` entries come from the placement's file search (`server.queries.files.search`) and the shell's mention sources. Both registries are read through the shell's `useShellRegistries()`.
- No second copy of server data: the composer reads session status and requests through `SessionView` only. The harness store keeps only what today's app keeps: per-scope picks in memory and the draft default in localStorage.

## Flows

- 3 (send a turn), 4 (stop and queued messages), 5 (errors by class), 6 (attachments, marks, `@file`, slash commands, a new session's harness default), 7 (goal mode), 33 (phone).
