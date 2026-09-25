# Composer

The prompt editor and everything that turns a draft into one `PromptInput` for `SessionView.send`.

## Owned concepts

- **Draft**: the prompt parts (text, `@file` and `@agent` pills, images with marks), the cursor, the context items (file comments and text mentions) and whether goal mode is armed. One draft per composer key: `session:<sessionId>` for an open session, `draft:<placementId>` for the workspace's one new-session draft. Drafts live in `ComposerStore`, capped at 20 keys in memory (keys a mounted composer retains are never evicted); each key's draft (without an armed Goal) and history are also written to localStorage per server (`persistence.ts`), so both survive a reload as they do today. The write is deferred (`deferred-persistence.ts`): the latest entry per key waits until typing has paused for 1 s, or the window blurs, the page hides or unloads, so a keystroke never serializes the whole entry. `ComposerStoreProvider` mounts the store once, above the workbench, so a draft survives pane switches.
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

## Constraints

### Harness and model picker (`view/harness-model-picker.tsx`, `view/agent-harness-selector.tsx`)

- The popover is placed `top-end`: the trigger sits in an `ml-auto` group whose right edge is fixed while its left edge moves with the model name, and a `top-start` popover followed the moving edge and was collision-shifted by the viewport on every harness switch.
- An open section gets a definite height (`h-[26rem]` for models, `h-80` for harnesses), not `max-h`: under `max-h` alone the flex child gets only its content height and the scrolling model list shrank to two rows. With no section open no height is set, so the headers hug.
- `onOpenAutoFocus` is prevented because `ModelList` focuses its own search box, and a focused Kobalte container swallows the first keystroke.
- The effort slider maps the pointer against the thumb's travel (the track minus `--effort-stop-inset` on each side), since the stops sit on that travel; the full track width lands clicks near either end on the wrong stop.
- The model section stays closed while options load, because a list that fills in under the cursor causes clicks on the wrong model. Its spinner sits in the section header, so it names what is loading.
- A failed model load replaces the list with a critical notice; a search box over zero rows would claim the harness has no models. A merely stale list keeps its rows and says so in a `title` hint, never in the notice row.
- The trigger may hold icon markup because it is a Popover trigger with its own `aria-label`. A Kobalte Select trigger is named by `aria-labelledby` pointing at its value span, and Chrome computes an empty name when that span holds markup.
- Harness rows are grouped by `harnessGroup`: the operator ACP and native SDK rows of Claude (and of Codex and Cursor) carry the same label.
- A Kobalte Select re-fires `onChange` with its current value when its options collection changes identity, and types ahead on a closed, focused trigger; a harness switch migrates the session, so `shouldApplyHarnessSelection` (`view/agent-harness-selection-guard.ts`) applies only changes made with the menu open.
- A backgrounded pane publishes no composer notice, so it cannot overwrite the visible pane's row.
- The fast toggle binds to the model's first service tier: Codex reports exactly one (`priority`, "Fast") on every model that has any.
- On a model change a selected effort the new model lacks is cleared before the model is set, or it would ride the next prompt behind a control that no longer offers it.

### Harness readiness (`harness/`)

- `statusReadiness` orders hard failure (`error`) before `ready:false` (`polling`, the Connecting pill) before degraded health (`degraded`). A harness that lost its process reports `ready:true`, so polling and degraded never coincide, and checking polling first avoids a flash of "The agent stopped responding" at start. Health moves a scope only between `ready` and `degraded`; `error` and `polling` belong to hydration and harness switch.
- Hydration (`harness/harness-hydrator.ts`) is one-shot per scope and stamp. A harness that first answers `ready:false` would show Connecting forever, so `harness/reprobe.ts` re-probes every 1,500 ms for at most 40 attempts (about 60 s), then marks it Unavailable. A re-probe clears the stamp first, and the run tracker drops a probe already in flight. The loop's `active` input is a boolean memo, so re-applying the same polling status cannot restart the loop and reset its cap.
- A user's pick cancels a hydration still waiting for its status read, so an older server snapshot never restores the previous harness after the click.
- An existing session's harness comes only from its saved config. A missing or failed config read keeps the scope polling with the session row's harness shown; the folder's harness status describes the workspace default and never stands in. A config answer without a harness is a contract violation and settles the scope as `error`.
- A hard-failed harness with config options clears `optionsLoading` itself: no options fetch follows, and "Loading models" would otherwise stay behind the error. An abandoned options load clears the flag only while its sequence number is still current.
- Effort is kept in every options branch, because a harness can report effort while its model list is still loading or empty. The harness's current effort seeds the level and never replaces a pick the model still accepts.
- An operator ACP agent need not expose a `model` option: a fresh live answer with other options proves it is up, and the agent keeps model ownership. A static catalog backstop for a native SDK harness fails at once, so SDK auth and connection errors show in the model section.
- A provider catalog restored from storage holds only each provider's default model, so its rows and effort levels wait for `hydrateConnectedProviderDetails`. The catalog query is keyed by the catalog harness, and an empty id disables it.
- `[]` in `thoughtLevels` or `serviceTiers` means the harness offers none; `null` means unknown.
- A held pick (`heldFrom`) on an existing session reads its options from the placement-scoped read, because the session-scoped read serves the harness the session still runs. The next send commits the pick with `updateSessionConfig`; a failed commit keeps the draft. A failed model save rolls the picker back, since the session runs its saved model.

### Draft defaults (`harness/draft-default*.ts`)

- Defaults are kept per harness, because harnesses share no model namespace: one slot would let a Claude pick overwrite the Codex model.
- The record key and its `providerID`/`modelID` fields are today's app's, so a draft default carries over between the two apps.
- A fresh options answer keeps only a user-chosen model, including one the catalog no longer offers, so "Saved model unavailable" can name it; a model the harness resolved is re-answered on every load.
- A catalog harness opens on a provider's default only when exactly one provider default is eligible.

### Permission modes (`permission/`, `view/permission-control.tsx`)

- The composer renders the modes the runtime reports and never decides from the harness id what a mode does: a static table of SDK behavior drifts from the installed packages.
- A row is selectable only when `permissionModeDeliverable` says Claxedo can send its delivery kind, and `applyPermissionMode` implements exactly those kinds, so a mode is never shown as applied while nothing was sent. `kept` is the harness's read-back: an ACP agent can clamp the mode.
- An undefined report is loading; an empty one is a harness with no modes. A stored mode the harness no longer offers leaves the trigger reading "Permissions" rather than another row's label.
- The default is the harness's own current mode (on a resumed session, the mode in force), then its `auto` rung, then its first option. A prompt carries only an explicit, still-offered choice; resending the derived default races a harness switch.
- A draft sends nothing on select; its first session starts under the stored mode, so the "applies to the next agent" caveat is hidden there.
- `defaultPermissionSelection` runs inside a render memo and tolerates an unreadable report, so one bad report degrades one control instead of the whole shell.
- The draft's mode list is a recorded table, so it answers even for a harness that failed to start; the picker also gates on `error` readiness and on a rejected config.
- Delivery by harness (read against `@anthropic-ai/claude-agent-sdk` 0.3.215, `@cursor/sdk` 1.0.23 and `@agentclientprotocol/sdk` 1.2.1):
  - Claude: `permissionMode` is set per `query()`, `bypassPermissions` also needs `allowDangerouslySkipPermissions`, and the settings deny list outranks every mode. The driver holds no streaming query open, so a change applies from the next turn.
  - ACP: modes arrive through `configOptions` (`category === "mode"`) or the older `SessionModeState`; the spec makes `category` UX-only and mode ids open strings, so the set is discovered per session. Agent selection shares the mode channel.
  - Codex: the approval policy is re-sent on every `turn/start`, so the `thread/start` default never outlives the first turn.
  - Cursor: sandbox and `autoReview` are read only at `Agent.create`, so a change applies from the next session, and the SDK cannot confirm `autoReview` took effect.
  - Pi and OpenCode report no standing mode. There is no generic "none" mechanism, so an unexamined harness is never filed as having nothing. An operator ACP connection without an entry uses `acp-session-mode`.

### Send and notices

- `submitDisabled`, the placeholder and the explain-on-intent copy all come from `submitBlockReason`, ordered most specific first, so they never name different reasons. An empty composer during a turn is Stop, ahead of every readiness gate, because stopping needs no ready harness.
- Actionable reasons (`harness-degraded`, `harness-error`, `no-model`) keep Send dimmed but clickable: `no-model` opens the model picker, and the others hold the tooltip open for 3,200 ms, since touch has no hover. `workspace-role` and `session-share` hard-disable Send, as nothing in the composer can fix them. A draft-default "choose a model" blocks only while the model is also blocked.
- The harness notice (`view/harness-notice.ts`) reports one failure, in the order connection, dead runtime, setup required, models failed, saved model unavailable: a dead runtime also fails option discovery and loses the saved model, and naming a downstream symptom sends the user to the wrong fix.
- The notice travels through a context channel, since its producer sits deep in the toolbar and its row renders outside the composer card. The frame makes a channel only when none is inherited, because the new-session screen hosts the row above its context row. A composer clears its notice on unmount. A critical notice is an assertive alert; others are polite status.
- The thought level reaches the harness only as the model's `variant` on the next prompt, so choosing it writes local state only. A service tier chosen under another model is dropped.

### Frame (`view/frame.tsx` and its parts)

- `data-component="composer-frame"` is the `prompt-composer` container root in `shell/styles/index.css`; without it the toolbar never collapses at narrow widths.
- The card takes its elevation from `data-dock-border-underlay="v2"`, never a `shadow-*` utility: utilities sit in a later layer than `dock-surface.css` and would drop its 0.5 px ring.
- With a popover open the editor (`view/editor-surface.tsx`) is a `combobox` with `aria-expanded` and `aria-controls`, which axe requires together; closed, it is a multiline `textbox`, since a combobox cannot be `aria-multiline`. `PROMPT_POPOVER_LISTBOX_ID` ties the two halves.
- Kobalte re-fires the add menu's `RadioGroup.onChange` with the unchanged value when its options settle; the handler ignores it, or focus would jump into the composer.
- The `+` menu fits the space above the composer rather than clipping its first entry off the top of the window.

## State machines

- **Composer send**: `editing → sending(clientRequestId) → accepted | rejected(error)`; `edited` returns to `editing`. A rejected send raises today's toast ("Failed to send prompt" and the error's message) and keeps the draft. Nothing retries on its own. A draft's first send reports its boot phase (`Booting <harness>...`, then `Sending first message...`) on the Send button.
- **Attachment**: `reading → ready(part) | failed(error)`. A reading file shows a "Reading <file>…" row above the card; a ready part joins the draft at the cursor; a failed one raises today's toast and leaves the list.
- **Editor interaction** (`controller.ts`): the editor mode (`normal | shell`), the popover (`closed | at(query) | slash(query)`) and the history position.

## View

`view/frame.tsx` is today's `PromptInputFrame`, moved from today's app: the card, the drag overlay and the `/`/`@` popover, composed from `view/context-strip.tsx` (context chips, mark chips and image tiles), `view/editor-surface.tsx` (the contenteditable and its placeholder) and `view/toolbar.tsx` (`+` menu, permission chip, harness → model chip, Send control). `view/composer.tsx` feeds it from the controller, the draft store and the harness store through `view/popover-bindings.ts`, `view/context-bindings.ts`, `view/image-mark-bindings.tsx` and `view/editor-placeholder.ts`. The harness → model chip is `view/agent-harness-selector.tsx` over `view/harness-model-picker.tsx`; the selector's scope, catalog, rows, pick, switch, trigger, notice and effort each have their own file beside it. The Send control reads `submit-block-reason.ts`: an empty idle draft, a missing model, a harness that is not ready. With a blank draft during a turn it is Stop.

## Invariants

- The draft is the only copy of what the user typed; the contenteditable is rendered from it and parsed back into it on input.
- `!` at the start of an empty prompt enters shell mode; the command is sent as an ordinary prompt and the composer returns to normal mode, as today.
- `/goal` arms goal mode; `/goal <objective>` and an armed send carry `goal: { objective }`. Only a harness whose `goalMode` is not `none` offers it.
- Slash entries are the palette's commands that carry a slash alias (`useCommands().slashOptions()`), including the composer's own `/goal`; `@` entries come from the placement's file search (`server.queries.files.search`) and the shell's mention sources (`useShellRegistries()`). The `+` menu's Commands and Context open their popover without touching the draft.
- A `hidden` composer (the session screen hides it behind a request dock rather than unmounting it) registers no palette or slash commands and listens for no dropped files, so it acts as if it were not there.
- No second copy of server data: the composer reads session status and requests through `SessionView` only. The harness store keeps only what today's app keeps: per-scope picks in memory and the draft default in localStorage.

## Flows

- 3 (send a turn), 4 (stop and queued messages), 5 (errors by class), 6 (attachments, marks, `@file`, slash commands, a new session's harness default), 7 (goal mode), 33 (phone).
