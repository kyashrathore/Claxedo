# Composer

The prompt editor and everything that turns a draft into one `PromptInput` for `SessionView.send`.

## Owned concepts

- **Draft**: the prompt parts (text, `@file` and `@agent` pills, images with marks), the cursor, the context items (file comments and text mentions) and whether goal mode is armed. One draft per composer key: `session:<sessionId>` for an open session, `draft:<placementId>` for the workspace's one new-session draft. Drafts live in `ComposerStore`, capped at 20 keys in memory (keys a mounted composer retains are never evicted); each key's draft (without an armed Goal) and history are also written to localStorage per server (`persistence.ts`), so both survive a reload as they do today. `ComposerStoreProvider` mounts the store once, above the workbench, so a draft survives pane switches.
- **Harness selection** (`harness/`, today's app's harness store moved unchanged apart from its data access): the harness, model, effort and fast tier for a key, read by the harness → model picker (`view/agent-harness-selector.tsx`, `view/harness-model-picker.tsx`) and by the send. `harness/harness-config-store.ts` composes the store over `server.harnessConfig` and is mounted once by `ComposerStoreProvider`.
- **Model visibility** (`harness/model-visibility.ts`): the per-browser on/off state Settings → Models writes. A model is visible by its own switch, else by its group's Enable all / Disable all (`modelGroupKey`: the provider, or Pi's vendor), else by default. The picker lists a catalog harness's model only when it is visible (by default each provider's default model), and hides a harness-reported model that is not visible unless it is the selected one.
- **Provider catalog** (`harness/provider-catalog.ts`): one cached query per catalog harness (`server.queries.providerCatalogs`), read on demand: when the picker opens, when a new OpenCode draft chooses its default model, and by Settings → Models and the first run. An existing session's pane never reads it at mount; every catalog-derived state waits for it.
- **Model display names** (`harness/model-names.ts`): a display-name cache, not state. A per-browser map of provider/model → name, written when the picker resolves a model from a loaded catalog or the user picks one, kept to the last 100 entries, and read only for the closed picker's label while the catalog is unloaded; the catalog's name wins whenever it is loaded.
  - A draft opens on the harness last used for a draft in its workspace (localStorage `session.draft-default.v1`, keyed by server URL and workspace: the folder when this machine serves it, the workspace id otherwise), else on the folder's harness from the server (`agent-config/harness`, not for cloud placements), else on none: "Select agent", and Send is blocked with "Choose a model to continue".
  - Its model is that harness's remembered model for the workspace, else the harness's current model from its options. Effort is whatever the harness's options name as current for that model, else none. Switching harness clears the model, effort and fast tier and restores the picked harness's remembered model.
  - An open session reads its own config (`/session/<id>/config`). Picking a model there saves it to the session config; picking another harness is held until the next send, which saves the harness to the session config first.
- **Harness health** (`harness/session-harness.ts`, `view/health-peek.tsx`): whether a session's harness lost its process and whether its connection is up. The session's harness read gives the first value; after that the runtime pushes `harnessHealthChanged` when either changes, and the harness store applies it to the `session:<sessionId>` scope bound to that harness. Nothing polls. "Check again" is the one read on demand. While a turn runs on a degraded harness, the peek says "The agent stopped responding".
- **History**: the last 100 sent prompts per key and editor mode, navigated with the arrow keys from an empty draft or from a history entry; an entry brings its review-comment chips back.
- **Attachments**: files read into image parts. `attachments/files.ts` decides the mime an attachment travels under and whether the target harness can take it.
- **Image marks**: boxes and pins the user draws on an image. Marks are drawn onto a PNG copy only when the prompt is sent (`marks/flatten.ts`); the draft keeps the original. The badge and its colours are `@/lib/image-mark-badge`, shared with the transcript.
- **Send**: `send.ts` builds the `PromptInput` from the draft and the harness submission (harness, model, effort as `variant`, fast tier), sends it over `SessionView.send` (creating the session first for a draft key), records history and clears the draft. File comments and mark comments travel as `text` attachments worded by `@/lib/comment-note`, the same sentences the transcript parses back into chips.

## State machines

- **Composer send**: `editing → sending(clientRequestId) → accepted | rejected(error)`; `edited` returns to `editing`. A rejected send raises today's toast ("Failed to send prompt" and the error's message) and keeps the draft. Nothing retries on its own. A draft's first send reports its boot phase (`Booting <harness>...`, then `Sending first message...`) on the Send button.
- **Attachment**: `reading → ready(part) | failed(error)`. A reading file shows a "Reading <file>…" row above the card; a ready part joins the draft at the cursor; a failed one raises today's toast and leaves the list.
- **Editor interaction** (`controller.ts`): the editor mode (`normal | shell`), the popover (`closed | at(query) | slash(query)`) and the history position.

## View

`view/frame.tsx` is today's `PromptInputFrame` with its toolbar (`+` menu, permission chip, harness → model chip), Send control, drag overlay, context chips, image tiles and `/`/`@` popover, all moved from today's app; `view/composer.tsx` feeds it from the controller, the draft store and the harness store. The Send control reads `submit-block-reason.ts`: an empty idle draft, a missing model, a harness that is not ready. With a blank draft during a turn it is Stop.

## Invariants

- The draft is the only copy of what the user typed; the contenteditable is rendered from it and parsed back into it on input.
- `!` at the start of an empty prompt enters shell mode; the command is sent as an ordinary prompt and the composer returns to normal mode, as today.
- `/goal` arms goal mode; `/goal <objective>` and an armed send carry `goal: { objective }`. Only a harness whose `goalMode` is not `none` offers it.
- Slash entries are the palette's commands that carry a slash alias (`useCommands().slashOptions()`), including the composer's own `/goal`; `@` entries come from the placement's file search (`server.queries.files.search`) and the shell's mention sources (`useShellRegistries()`). The `+` menu's Commands and Context open their popover without touching the draft.
- No second copy of server data: the composer reads session status and requests through `SessionView` only. The harness store keeps only what today's app keeps: per-scope picks in memory and the draft default in localStorage.

## Flows

- 3 (send a turn), 4 (stop and queued messages), 5 (errors by class), 6 (attachments, marks, `@file`, slash commands, a new session's harness default), 7 (goal mode), 33 (phone).
