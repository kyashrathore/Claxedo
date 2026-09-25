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

`TranscriptConversation` (`@/transcript`): `messages` in transcript order, sorted by id so `Binary.search` works; `parts` keyed by message id; `fragmentParts`, the ids of messages whose parts are still a partial read; `partsWithText`, the ids of parts whose text has had a non-blank character. The timeline never mutates these; identities of unchanged messages and part arrays must be stable across updates, because the per-turn row memos are gated on identity (`timeline-row-equality.ts`).

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
- Mount snapshots (scroll, measurements, open and revealed tools, fold counts) are kept for 64 sessions; fold choices for 16. Both are module-level caches kept from today, listed as named exceptions in `scripts/checks/data/module-state-exceptions.ts`; they move to provider-owned stores after the swap.
- The message-navigation rail mounts only after the first reveal and only on an idle callback, and reserves its gutter through `data-session-timeline-nav-gutter` on the root.
- The column is 768 px wide and 880 px from 1536 px (`WIDE_VIEWPORT_MIN_WIDTH`, the `2xl:` classes on the same column); the rail needs 60 px on each side of it.
- File paths in the transcript resolve through `@/lib/workspace-file-focus`: `~`, traversal and out-of-placement paths never open; `:line[:col]` suffixes are parsed off.

## Why the rows are built this way

The row builder is `Timeline.constructMessageRows` (`message-timeline.data.ts`); the row union, keys and reuse are `timeline-row-model.ts`.

- A turn's rows depend on whether each text part has text, not on the text itself. That fact is the transcript store's `partsWithText`, recorded when the part's first non-blank text lands, so the row memo reads one key per part and the deltas after it wake nothing. The fold count copies a part untracked. When the row memo read the text, every delta of a streaming reply rebuilt every row of its turn (0.8 s per 12k-character reply at 4x CPU); a per-part memo over the text instead lived in an undisposed root and trimmed the whole reply on every delta (1,551 runs per streamed turn).
- The builder reads only a user message's `id`, `time` and optional `summary`, all of which the optimistic stub carries, so a just-typed turn renders before the runtime echoes it. A turn's duration reads only the user message's creation stamp, so a turn opened by a prompt that never reached the runtime still has one.
- Turn semantics (error, interruption, settlement, fold, tokens, cost) always come from every assistant sibling of the turn. The optional visibility set only bounds the part rows built for the first cold frame.
- A run of tools cannot span the interruption row: grouping the refs whole would merge the runs either side into one group, which the fold counts as one where the turn draws two.
- `turnFoldableCount` is a floor. It counts unsegmented, so an interrupted turn counts one lower than it renders, and it counts reasoning as hidden, where showing it splits a run into more groups. A floor is the safe direction for deciding whether a fold exists.
- A switched-to session is seeded with two messages (the turn's user message and its tail assistant message); the messages holding the rest of its groups arrive about 900 ms later. Counting only what is present would fold the turn on that later pass, so a count the caller already knows stands until they arrive. A fold decided on pending parts records the minimum as its count, and the caller hands it back as `priorFoldableCount`.
- The fold row is the turn's header: it sits above the turn's content, not wherever the first tool landed.
- A working turn paints its fragment now: its rows grow as the harness writes them, and a loader in place of its Thinking row reads as a stop. A settled turn that would paint open (interrupted, failed, or unfolded by the reader) holds its body until the full read, because painting the surface's texts and then the tools under them moves what the reader was given. The loader's reveal delay lives in `session-turn.css`.
- The live row: while a tool runs or a thought streams, the turn's trailing group is live (the work-group header reads "Running <command>", the reasoning row shimmers). The Thinking row fills every other stretch of a working turn, before the first part and between groups, so the live row flips between "Running …" and "Thinking" rather than stacking both. Only the newest message says whether the turn is open and only its groups can be live: a step-per-message harness completes each earlier step while the next streams, and a stale busy status must not hang the row under a completed answer.
- Aborts: OpenCode-native aborts are recorded on the message itself; SDK-runtime aborts on the session's turn outcome, which must match the exact assistant message. Missing completion metadata is not an abort: a normal turn can be observed between its idle event and its completion checkpoint. The interrupted row's duration uses the SDK's cancellation timestamp; a native abort may have none, so it falls back to the latest activity on the interrupted message's parts.
- Terminal states (interrupted, failed) are a centred hairline divider, a peer of the "Worked for" row, never a card; the interrupted duration uses the same `formatDuration` wording as "Worked for {duration}".
- A failed turn keeps its assistant message, not only the error: that message's provider and model are what the turn dispatched with, and the error card names that provider.
- Part rows mirror the renderer's registered part types (`PART_MAPPING` in `@/transcript`): a part other than text, reasoning or a tool renders only when a component exists for it; `file` carries assistant image, audio and resource-link attachments.
- The turn's summary diffs keep the last diff per file in display order, with a Set so a large summary stays linear.
- The indexes of assistant messages by parent and by pending completion exclude optimistic rows, which have no parent id and no completion time.
- A stale uncompleted assistant message anchors on its parent only while that parent is the newest prompt; once a follow-up lands, the new user message owns the turn even if the old completion frame is still in flight.
- An admitted prompt reaches the transcript over events before the next queue poll drops its record. The record carries the id the turn's user message gets, so the queued bubble yields to the row as soon as the row exists.
- Per-message row inputs are equality-gated (`timeline-row-equality.ts`): a streaming part event produces a new conversation snapshot and a new by-parent map every tick, and identity comparisons turn that into work proportional to the changed turn. A session row's `lastTurn` is compared by the fields the timeline reads, because the session-cache row changes identity on every cache write.
- Rows are plain records built by a factory, not class instances: nothing asks `instanceof`, and a class could only be typed by asserting through `unknown`.
- A row carries its own message id beside the turn key: a user-message row is its user message; an assistant-part row belongs to the assistant message its parts came from (`data-message-id` carries the turn key, `data-content-message-id` the row's own message, for observers verifying that an exact message painted). Assistant messages render one row per part group, so a row also carries the part it shows.
- The previous-messages row is not a restore anchor: it is keyed by the first rendered turn, so the reveal it anchors re-keys or removes it.
- The virtualizer can publish an item list that briefly omits a key while its row is still mounted (`<For>` disposes it a tick later). A non-keyed `<Show>` accessor read in that window throws Solid's stale-value error and takes down the pane boundary, so the row entry is latched and renders its closing frame.
- `data-index` is stamped on a row element before `measureElement`, because JSX applies it after refs and `measureElement` drops unindexed elements; that call is also the mount measurement.
- The content element wraps the queued bubbles too: the auto-scroll and scroll-state observers watch it, and a bubble mounting below the virtual rows counts as content growth.

## Why scrolling works this way

- Overscan is 6 rows: a flick leaves 0 blank px at 1400 px/frame and 802 px at 5600 px/frame; 12 rows still leave 443 px and take the worst renderer task from 16 ms to 31 ms (perf-harness `transcript-flick`).
- Opening at the end and staying at the end are different promises. `shouldAnchorBottom` opens a session on its latest turn; `followsEnd` holds only while a turn streams, because on a settled transcript a size change is the reader opening a fold or tool row, and re-pinning to the new end (by the row's estimate, before it measures) takes them away from what they clicked.
- Insert holds and gesture windows mean the reader owns the viewport. A reveal click resizes a row at the reader's position, and its gesture mark keeps the resize anchor from pinning the growth to the bottom.
- The virtualizer's index extractor is a getter, not a stable closure. The virtualizer memoizes the extractor's output on the extractor's identity plus range and count (virtual-core `getVirtualIndexes`); Solid signals read while the extractor runs are invisible to that memo, so a stable closure serves stale indexes (it once left the timeline mounting one row forever after a reload). Reading the signals at option-read time, inside the adapter's tracked `setOptions`, subscribes the virtualizer and mints a new identity.
- The prepend-anchor loop parks while its surface is stashed, and a return nudges it: a parked loop has no frame on which to notice that its surface came back.
- `getOffsetForIndex` reads a lazily refreshed measurement cache, so it is refreshed first; the in-view insert check materializes `measurementsCache` too, or pre-insert positions make the overflow check miss.
- A capped first fold forces its virtual measurements while the surface is still hidden and makes the bottom-anchor write before paint. `timeline-first-fold-reveal.ts` finishes that mount in a microtask after Solid commits the rows, before the next paint, rather than hiding a ready surface for another frame; its activation key and cancel flag stop a retained surface's queued task from revealing or scrolling a different session.
- Size estimates (`timeline-virtualization.ts`): short responses keep the virtualizer default. Long markdown renders at about 28 px per source line at p50 (headings and lists about 35, dense code about 20; measured 2026-09-01); a 1,849-line part rendered at 52,961 px, and a low cap made the anchored viewport chase a 9x correction, showing a blank viewport after a session switch. Overestimating is the cheaper error, so the cap only bounds adversarial payloads. Initial layout computes precise estimates only around the first visible fold; older rows are measured when the reader approaches them.
- A stashed surface stays mounted under a display lock where `scrollToEnd` cannot land, and the virtualizer's scroll reconcile would re-arm every frame until its multi-second safety valve, once per retained session; the surface re-anchors on its way back in instead.
- A row inserted inside the viewport (a reply's first part landing above the busy tail) is already revealed: pinning the bottom would shift every visible row by the insert's height. The hold covers the insert's own measure pass and the deferred anchor microtask. The insert lands where the displaced row started, or after the tail for an append, found by key because index-keyed measurements are mid-flush. Only a near-tail insert beside a visible row is held; history prepends land far above with their own compensation. An append is held the same way, because the reader at the end of a working turn is reading its last row. When the hold lifts, the timeline follows once if the insert pushed the tail row below the fold; that promise is made at insert time, because a reply landing in the same batch as the idle no longer reads as working (the insert-beside-a-waiting-row check).
- Resize compensation (`shouldAdjustScrollPositionOnItemSizeChange`) stands down while bottom-anchored: `wasAtEnd` already moves the viewport by the total-size delta, and a second compensation doubles it.
- A zero-height measurement is dropped: a rendered row is never 0 px, so zero means it was measured display-locked or detached, and caching it collapses the total size to `paddingEnd`, painting the last turn at the top with a gap above the composer.
- The pin scan (keeping a mid-history reader's rows mounted through a huge resize) is skipped while bottom-anchored: the anchor re-scroll wins anyway, and the scan forces a layout per rendered row inside the resize flush.
- Rows render fully at mount, with no `content-visibility: auto`: a cold overscan row in skip state measures at its `contain-intrinsic-size` (a 24 px turn gap measured and painted as the 180 px placeholder), and a fast flick shows estimate-sized blank boxes. The overscan band is at most 6 rows, so eager rendering is cheap.
- History prepend (`timeline-prepend-anchor.ts`): when the anchored row is virtualized out (a reveal that prepends more than a viewport while the scroller is at the top), the DOM measurement has nothing to correct against, so the loop falls back to the virtualizer's own offset for the row; once that write brings the row into range, the DOM path takes over. A reader's gesture takes the viewport without dropping the restore the loop owes: a gesture often arrives before the loop's first frame, and the virtualizer anchors a settled transcript to its start, so a cleared restore would leave the reader at the top of the revealed history, where the next scroll reveals the batch above.
- Scroll memory ignores a hidden surface's clamped offset or zero geometry, and intermediate restoration frames: none is a new reading position.
- `message-timeline-observe-offset.ts` wraps the virtualizer's offset observer (ported from upstream `observe-element-offset.ts`, #36643) with restore-first reconnect. When the scroll element is detached and re-inserted under a persistent host (a workbench slot move, a suspense re-attach), the browser resets its scroll position while the virtualizer's `scrollOffset` still holds the place, and the stock observer never re-fires. The wrapper writes the stored offset back to the element; delivering the reset offset instead would render the range at the top and then re-anchor at the bottom, two row-set rebuilds in one long task. Only when the write does not stick is the native offset delivered. Its mutation observer lives at the persistent route root (`main`, or `body` for isolated hosts) to see a slot move, and reacts only to a removal of one of the viewport's captured ancestors that actually removes the viewport; additions matter only after such a removal.
- `timeline-displayed-frames.ts`: session surfaces stay mounted after the workbench stashes them, hidden with `content-visibility: hidden` and `contain: strict`. That stops style, layout and paint, not JavaScript: a stashed timeline's `requestAnimationFrame` loop keeps running against an element with no layout, never reaches the settled measurement that would end it, and runs its whole frame budget; across retained sessions this was the dominant term in the packaged app's idle CPU after a session-switch workload. The loop reads the displayed state on every arm and every frame (a surface can be stashed after a frame was scheduled), parks a stashed step rather than dropping it (restoring the reader's row is what a return needs), and `resume()` restarts a parked step.
- `active-pane-projection.ts`: retained panes stay mounted while hidden, and reading a query or store from them keeps the whole projection graph subscribed to background updates. The projection keeps the last published value while inactive and stops reading the source; the active edge reads it once and publishes.

## Why gestures work this way

- A wheel, touch or drag inside a nested `[data-scrollable]` box (a capped tool output) belongs to that box, not the transcript; counting it would leave follow-bottom mode on every output scroll.
- The list's handlers carry `props` rather than spreading it, so every read is a reactive prop access at dispatch time.
- A pointer press on a control is an action, not a scroll gesture: expanding the cold virtual range on pointerdown replaces the pressed row before click, so WorkGroup and recovery-card buttons never receive the click.
- Drag-to-select starts on a child node, so the handler marks a gesture and autoscroll yields. Bottom-following itself belongs to the virtualizer and `resizeItem`'s re-anchor.
- The previous-messages row keeps focus off itself on mousedown: in the floating card, a focused button blurs the composer, the composer folds, and the bottom-anchored row moves about 52 px under the pointer before mouseup, so the click lands behind the card.

## Why the rail and gutter work this way

- The compact rail reaches 48 px into the pane (`left-3` plus its 36 px width); the viewport reserves 60 px so every row, including a wide table or diagram, has 12 px after it. The rail mounts only when its ResizeObserver confirms the pane can afford the gutter.
- The gutter is keyed off `data-session-timeline-nav-gutter`, set from the same memo that mounts the rail, never a `:has()` on the rail's own element. A `:has()` makes the timeline root a Blink invalidation anchor over the most mutated subtree in the app; on the session-switch perf flow, that root plus `.session-envcard-shell` caused 3426 of 3756 style invalidations and about 21% of RecalcStyleDuration. No `:has()` may have an ancestor of the timeline as its subject.
- The gutter is decided before first paint: the observer's first callback lands a frame late, and a late flip shifts the whole column and restarts every pending paint-stability wait.
- The rail's idle readiness stays reactive without enrolling the pending idle promise in the pane's Suspense.

## Why links and files open this way

- A subagent's transcript opens as a workspace-panel tab, not a second pane: splitting took the reader's turn down to half width. Below the `md` boundary the panel would cover that turn, so there the child takes the pane.
- A file opens in the workspace side panel (the same path terminal file links take), not `platform.openPath`, which is desktop-only and hands the file to the OS; without `navigator: "files"`, which would slide the tree drawer over the tab just opened.
- Anchors are handled in the capture phase so `preventDefault` beats the markdown's `target="_blank"`: in Electron a bubble-phase handler opened the link in both a browser and the panel. A click that ends a text selection is not a navigation. The renderer marks every link `_blank`, including scheme-less local paths like `[README.md](/Users/…/README.md)`, which the browser would open as a dead tab on the app origin; links with a scheme, protocol-relative links and in-page anchors keep browser behavior, and modifier or middle clicks are left alone. Markdown image tiles own the full-image preview, even inside a link.
- Leaving the event uncancelled hands the link back to the anchor's own `_blank`, so a target this host has no route for behaves as before. A loopback URL is a dev server of this workspace (the "Local preview" chip treats it so), whatever its spelling. A Windows file URL carries the drive letter inside the path (`/C:/…`).
- Path chips render mentions as `@path`, and the sigil is stripped before resolving; a path that really starts with `@` (an npm scope folder) is indistinguishable, and the mention reading wins.
- The context menu's path comes from the chip's text or, for filename slots that render only the basename, from `data-path`; falling back to the slot text would fabricate `<placement>/<basename>` for Open, Copy and Reveal.
- The open-file event's detail rides on a DOM `CustomEvent`, so it is read structurally.
- Mermaid rendering is registered once at app start; the session-ui decorator re-sanitizes its output through `sanitizeSvg` before it reaches `innerHTML`.
- A wide table or diagram borrows the pane gutters only when its content is wider than the column, at most 20% of the column on either side, and never beyond the scroll viewport's content box after the rail and environment-card gutters, so shrinking the pane removes bleed first (`markdown-surfaces.css`).

## Why failed turns read this way

- A failed turn's wire error carries more than `data.message`: the engine's `APIError` also has `statusCode`, `responseBody` and `responseHeaders`. `providerErrorDetail` splits it into `summary`, one sentence naming who failed, what kind of failure and what to do, and `detail`, the provider's own status, message and body verbatim for the collapsed disclosure (collapsed by default, chevron-gated, copyable, as in session-ui's tool error card). There is no generic-shrug branch, and a real HTTP status means there is something more specific to say than a class sentence; a status-less error does not prove the provider was unreachable.
- The summary is composed when the row is built, not at mount, so the primary line never paints raw provider bytes first; the card derives it only when a caller has none.
- Relays (the opencode gateway among them) prefix the provider's message with `Error from provider (<label>): `, where the label is the relay's upstream account ("Console" is the Anthropic Console account, not a provider). The prefix is stripped and the summary names the provider the turn was dispatched to; the detail keeps the original line.
- The response body often carries the machine-readable code the message omits (auth vs capacity vs rate limit). It rides in the detail, never the summary, kept beside the message but not duplicated when the message is the body. `responseBody` exists on only some members of the wire error union, so it is read structurally. A non-string `message` is serialized, since `String(value)` would show "[object Object]".
- An operator ACP connection dispatches with `acp:<slug>` as its provider id; its label is derived as the harness selector derives it.
- The recovery class is attached on every turn, not only the first: it is position-independent, the card mounts on its presence, and retry is registered on every submit. The `firstTurnRecovery` prop remains for telemetry gating.
- `turn-recovery.ts` mirrors the server classifier `classifyFirstTurnError` (`packages/agent-sdk-runtime/src/first-turn-error.ts`), which is the source of truth and is not browser-safe. The server stamps `error.data.firstTurnErrorClass`, which wins; the regexes are a fallback for class-less errors and must stay in lockstep with that file. The credential broker's codes come from `@claxedo/agent-runtime-contract` on both sides, and are read first: without them a 403 naming a route the binding does not allow reads as `credential` and asks the user to reconnect a working account.
- Recovery copy is position-independent (never "first turn") and says "agent", never "harness", "ACP" or "adapter". The provider's own sentence wins whenever the error carried an HTTP status, for every class (a 401 classifies as `credential`, and the class copy is vaguer than "Anthropic rejected the credential (401)…"); without a status the class keeps its repair sentence, and `unknown` falls through to error-derived wording, ending at a last-resort sentence that still says what is known.
- A completed tool step can precede the turn's answer under the same parent.

## Why the smaller pieces work this way

- Queued prompts are drawn after the last row in the user-message bubble with the transcript's own `ui-user-message` classes, dimmed until admitted, so the hover action row behaves like a sent message's. The list is indexed, not keyed: every poll returns fresh records, and a keyed list would rebuild each bubble every second under the pointer. A prompt held by another client's edit shows as editing, releasable but not editable here. Its action buttons opt out of the narrow-viewport 40 px tap floor, since three floored buttons read as a toolbar.
- Turn fold choices: `undefined` leaves a turn on auto, where the row builder decides; an explicit choice always wins.
- A subagent chip hangs on a spawn part the transcript renders, including an interrupted wrapper with an admitted child. Lanes spawned inside a skill's forked execution link to calls that never land as parts, so the ambient row is their only surface.
- The Thinking row shows as soon as it is wanted and stays painted for a short hold after whatever clears it (`thinking-visibility-hold.ts`); dropping it at once collapses the virtualizer and jumps the composer.

## Flows

Flow 30 (`e2e/flows/30-transcript-corpus.spec.ts`) replays every corpus case through the scripted agent and compares v1 and v2: screenshots, the accessibility tree, and the scroll position after scroll, prepend, find and reload.

## Pending v2 twins

Kept on `@opencode-ai/ui` until the kit lists a twin and the corpus shows no difference: `button`, `card`, `spinner`, `scroll-view`, `dropdown-menu`, `dialog`, `context/dialog`, `inline-input`, `tooltip`, `accordion`, `sticky-accordion-header`, `text-reveal`, `text-shimmer`, `diff-changes`, `file-icon`, `context/file`, `toast`, `theme/transcript-typography`, `utils/binary`, `utils/path`, and `@kobalte/core/tooltip`.

## Diagram colors

Mermaid takes its theme colors from the app's CSS variables. The contrast theme's surface tokens are `color-mix(...)` expressions, which mermaid's color parser rejects, and an element's computed color serializes a mixed color as `color(srgb …)`, which it rejects too. `mermaidThemeVariables` resolves each token through an element's computed color and rewrites that form as `rgba(…)`; without it every diagram falls back to its code block.
