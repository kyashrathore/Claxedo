# Message timeline

The session transcript's list: the rows built from one session's messages and parts, their virtualization, the prepend anchor that keeps older turns from shifting the reader, the scroll memory and mount cache that make a session switch land where the reader left it, the turn fold, the message-navigation rail, the queued-prompt bubbles, and the opening of files, links, plans and subagents from the transcript.

It is today's timeline, **moved, not rebuilt**. Its logic does not change in this rebuild: only import paths, Claxedo names, a v2 twin where the corpus (flow 30, `e2e/corpus/`) shows no visible difference, and the seam below. A logic change is its own slice, proven by the corpus and signed off by the owner.

## What changed in the move

Today's component reached into the app through context hooks: the SDK client, the conversation registry, the directory session cache, the query client, the settings, i18n, platform and workbench providers. Those reads are now one prop, `host: TimelineHost` (`model.ts`), and the session screen supplies it. Nothing else in the component moved or changed.

| Today | Now (`TimelineHost`) |
| --- | --- |
| `useSessionKey().sessionKey` / `.params.id` | `sessionKey`, `sessionId` |
| `useSDK().directory` | `placementPath`: the placement's folder, used only to relativize file paths and to build absolute paths for Copy path / Reveal |
| `createActiveConversationSnapshot(...)` for the session and its parent | `conversation`, `parentConversation` (`TranscriptConversation` from `@/transcript`) |
| `props.directorySessions` (`ClaxedoSession[]`) | `sessions: Accessor<readonly TimelineSessionRow[]>` (`id`, `title`, `parentId`, `archived`, `lastTurn`) |
| `props.status()` (`AgentRuntimeStatus`) | `status: Accessor<SessionStatus>` from `@/server` (see the status table) |
| `turnCoverageInFlight(userMessageId)` | `turnSettlePending(userMessageId)`: true while the post-acceptance transcript read for that turn is still in flight |
| the first-fold prefetch page read inside the mount cache | `seededTurnFoldableCounts?`: the counts of a prefetched first-fold page, computed by the host with `pageTurnFoldableCounts(page)` |
| `useSessionSyncOptional().syncSession` | `syncSession?`: fetch a session's conversation (used for the parent of a subagent when its transcript is not loaded) |
| `useSettings().general.*` | `settings`: the five accessors the timeline reads |
| `useTranscriptTypography().typography` | `transcriptTypography` |
| `useLanguage().t` | `t: TimelineTranslate`, typed on the 38 keys the timeline uses (`TimelineTextKey`) |
| `usePlatform()` | `platform`: `openLink`, `openPath?`, `showItemInFolder?`, `renderMermaid?` |
| `useClaxedoState().workspacePanel.open(...)` with `workspaceDir`, `targetPaneId`, `navigator: null` | `openFocus(focus)`: the host opens each focus as a workspace-panel tab; a `subagent` tab belongs to the session holding the pane |
| `layout.showContent(layout.openSession(...))` at phone width | `openSessionInPane(sessionId, label?)` |
| `sdk.client.find.files({ query, dirs: "false" })` | `findFiles(query, signal)`: exact-path candidates; resolves to `[]` on a failed lookup, never rejects |
| `useNavigate()` with `sessionRoute` / `workspaceSessionRoute` | `navigation.toSession(id)` |

Still read from context: `useData()` (`@/transcript`, the `DataProvider` the renderers also need: `store.agent` for the progress-bar tint and `resolveSubagents` for background subagents), `useDialog()` and `showToast` from the kit.

Removed with the move: the renderer-phase perf marks (`window.__claxedoPerf*` hooks are test-only paths) and the `harnessRecoveryModels` picker helper, which the onboarding flow owns.

## Props (`message-timeline-props.ts`)

Today's props keep their names, except `parentID` → `parentId`, and `status`, `directorySessions`, `workspaceId` and `sessionRef` moved into the host. `userMessages`, `navMessages` and `currentMessage` are `TranscriptUserMessage[]`: a runtime user message, or the optimistic stub the store keeps for a prompt the runtime has not echoed yet (`origin: "optimistic"`, `id`, `role`, `time.created`, no `summary`). `queued` is the runtime's held prompts (`QueuedMessages`), which the timeline draws after the last row until the admitted message appears in the conversation.

## Data shapes

`TranscriptConversation` (`@/transcript`): `messages` in transcript order, sorted by id so `Binary.search` works; `parts` keyed by message id; `fragmentParts`, the ids of messages whose parts are still a partial read. The timeline never mutates these; identities of unchanged messages and part arrays must be stable across updates, because the per-turn row memos are gated on identity (`timeline-row-equality.ts`).

## Status

| `SessionStatus.kind` | Today's runtime status | Timeline meaning |
| --- | --- | --- |
| `idle` | `idle` | turn over; diff summaries show |
| `working` | `busy` | active turn: Thinking row, jump-button dot wave |
| `retrying` | `retry` | Retry row with the card's countdown; `attempt`, `message`, `nextAt` (`action` is requested on the contract) |
| `recovering` | `recovering` | the recovery card; `reason: "uncertainExecution"` keeps the turn active (requested on the contract, read structurally until it lands) |
| `failed` | — | treated as `idle`; the failed turn's error row comes from the assistant message's `error` |

## Invariants

- A `session.idle` can land before the turn's final transcript read. While `turnSettlePending(userMessageId)` is true the turn is still working: its Thinking row stays and its rows are not folded.
- A settled turn whose body is still a fragment (`fragmentParts`) holds a loading row instead of painting the surface and then the tools under it; a folded or working turn paints now.
- The fold count only rises across reads: a count shown, or seeded from a prefetched page, stands until the full read arrives, so a turn never loses rows the reader was given.
- The Thinking row is held for a short hide delay when status blips off `working` mid-stream, so the virtualizer does not collapse.
- A row's key is stable across rebuilds (`TimelineRow.reuse`), and a tag-narrowed row accessor latches the last matching row for the tick before Solid disposes the branch.
- `followsEnd` holds only while a turn streams; on a settled transcript a size change (a fold or a tool row opening) never re-pins the viewport to the end.
- Mount snapshots (scroll, measurements, open and revealed tools, fold counts) are kept for 64 sessions; fold choices for 16. Both are module-level caches kept from today; their home is an open ruling.
- The message-navigation rail mounts only after the first reveal and only on an idle callback, and reserves its gutter through `data-session-timeline-nav-gutter` on the root.
- The column is 768 px wide and 880 px from 1536 px (`WIDE_VIEWPORT_MIN_WIDTH`, the `2xl:` classes on the same column); the rail needs 60 px on each side of it.
- File paths in the transcript resolve through `@/lib/workspace-file-focus`: `~`, traversal and out-of-placement paths never open; `:line[:col]` suffixes are parsed off.

## Flows

Flow 30 (`e2e/flows/30-transcript-corpus.spec.ts`) replays every corpus case through the scripted agent and compares v1 and v2: screenshots, the accessibility tree, and the scroll position after scroll, prepend, find and reload.

## Pending v2 twins

Kept on `@opencode-ai/ui` until the kit lists a twin and the corpus shows no difference: `button`, `card`, `spinner`, `scroll-view`, `dropdown-menu`, `dialog`, `context/dialog`, `inline-input`, `tooltip`, `accordion`, `sticky-accordion-header`, `text-reveal`, `text-shimmer`, `diff-changes`, `file-icon`, `context/file`, `toast`, `theme/transcript-typography`, `utils/binary`, `utils/path`, and `@kobalte/core/tooltip`.

## Diagram colors

Mermaid takes its theme colors from the app's CSS variables. The contrast theme's surface tokens are `color-mix(...)` expressions, which mermaid's color parser rejects, and an element's computed color serializes a mixed color as `color(srgb …)`, which it rejects too. `mermaidThemeVariables` resolves each token through an element's computed color and rewrites that form as `rgba(…)`; without it every diagram falls back to its code block.
