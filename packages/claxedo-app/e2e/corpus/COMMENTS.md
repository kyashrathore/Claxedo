# Comment triage

Every comment in the moved transcript and timeline was read before it was stripped. Each one ends in a corpus case (when it encodes a rendering behavior), in its domain README (the why: a constraint, a failure mode, a measured number, an ordering), or is deleted because the code already says it or it only recorded history. A README outcome names the section that now carries it; a case outcome names the case that renders the behavior.

Line numbers are the comment's first line before the strip. A block of consecutive `//` lines is one row; `Lines` is how many source lines it spanned.

## Timeline (`src/session/view/timeline`, at `43466d8ee6`)

No case renders an interrupted turn: the ACP harness finalizes a cancelled prompt as `completed` (the ACP turn runner at that commit; the stop reason is now mapped by `translateStopReason` in `packages/harness/src/transports/acp/translate/stop-reason.ts`), so the scripted agent cannot produce the interrupted divider in either app. Those comments are carried by the README alone.

| Where | Lines | Comment | Outcome |
| --- | --- | --- | --- |
| `active-pane-projection.ts:3` | 9 | /** * A pane-owned view of an authoritative reactive source. * * Retai… | README, Why scrolling works this way |
| `first-turn-recovery-card.tsx:6` | 2 | // Raw-detail disclosure: collapsed by default, chevron-gated, copyabl… | README, Why failed turns read this way; case `failed-turn` |
| `first-turn-recovery-card.tsx:136` | 4 | /** * The already-composed human sentence. Passed in by the timeline s… | README, Why failed turns read this way; case `failed-turn` |
| `first-turn-recovery-card.tsx:141` | 1 | /** The raw wire error, so the description can name the provider's own… | deleted: the name, type or signature says it |
| `markdown-surfaces.css:1` | 7 | /* * Prose remains in the readable timeline column. A table or diagram… | README, Why links and files open this way; case `markdown-blocks` |
| `markdown-viewer.css:1` | 1 | /* Full-screen presentation shared by Markdown tables and Mermaid diag… | deleted: the name, type or signature says it |
| `mermaid-timeline.ts:6` | 7 | /** * Hands the shared '@/ui/mermaid' renderer (strict mode, 'base' th… | README, Why links and files open this way; case `math-and-mermaid` |
| `message-gesture.ts:25` | 3 | // Wheel/drag gestures inside a NESTED scroller (a capped tool output)… | README, Why gestures work this way |
| `message-nav-deferred-mount.ts:41` | 2 | // Idle readiness is optional presentation state. Keep its latest valu… | README, Why the rail works this way |
| `message-nav-gutter.css:1` | 18 | /* * The compact rail reaches 48px into the pane ('left-3' plus its 36… | README, Why the rail works this way |
| `message-nav-layout.ts:22` | 4 | // Decide the gutter BEFORE first paint: the observer's initial callba… | README, Why the rail works this way |
| `message-timeline-list-gestures.ts:4` | 4 | /** * The scroller a gesture belongs to: 'root' unless the event start… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:39` | 6 | /** * The timeline list's wheel, touch, pointer and scroll handlers. *… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:103` | 4 | // A pointer press on a control is an action, not a scroll gesture. Ex… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:113` | 1 | // Drag-to-select starts on a child node, not the list — mark it so au… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:124` | 1 | // The virtualizer and resizeItem re-anchor own bottom-following. | README, Why gestures work this way |
| `message-timeline-observe-offset.ts:29` | 14 | // Ported from upstream packages/app/src/pages/session/timeline/observ… | README, Why scrolling works this way |
| `message-timeline-observe-offset.ts:106` | 5 | // The observer has to live at the persistent route root so it can see… | README, Why scrolling works this way |
| `message-timeline-observe-offset.ts:131` | 1 | // Session routes are replaced below persistent main; body is the fall… | README, Why scrolling works this way |
| `message-timeline-turn-rows.tsx:1` | 5 | // Standalone presentational rows for the message timeline: the thinki… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `message-timeline-turn-rows.tsx:27` | 1 | /** Stands in for a turn body held back until its full read lands; its… | README, Why the rows are built this way |
| `message-timeline-turn-rows.tsx:39` | 1 | /** When set, the row is a toggle: 'true' shows the collapse label ins… | deleted: the name, type or signature says it |
| `message-timeline-turn-rows.tsx:58` | 4 | // Chromium focuses a button on mousedown. In the floating card that /… | README, Why gestures work this way |
| `message-timeline.data.ts:14` | 3 | // The row builder reads a user message's 'id', 'time' and optional 's… | README, Why the rows are built this way; case `two-turns` |
| `message-timeline.data.ts:41` | 2 | // Keeps the last diff per file in display order. Set-based so large /… | README, Why the rows are built this way |
| `message-timeline.data.ts:76` | 8 | /** * How many of a turn's groups the fold would hide, over whatever m… | README, Why the rows are built this way; case `worked-turn-folds` |
| `message-timeline.data.ts:112` | 3 | // 'session.idle' lands before the final transcript read does; while t… | README, Invariants (already stated there) |
| `message-timeline.data.ts:126` | 4 | // OpenCode-native aborts are durable on the message itself. SDK-runti… | README, Why the rows are built this way |
| `message-timeline.data.ts:138` | 2 | // Keep the message, not just its error: its providerID/modelID are wh… | README, Why the rows are built this way; case `failed-turn` |
| `message-timeline.data.ts:151` | 4 | // Turn semantics always come from every canonical assistant sibling. … | README, Why the rows are built this way |
| `message-timeline.data.ts:158` | 2 | // A run of tools cannot span the interruption row: grouping the refs … | README, Why the rows are built this way |
| `message-timeline.data.ts:211` | 5 | // A switched-to session is seeded with two messages — the turn's owni… | README, Why the rows are built this way |
| `message-timeline.data.ts:220` | 2 | // SDK cancellation carries the canonical completion timestamp. Native… | README, Why the rows are built this way |
| `message-timeline.data.ts:246` | 6 | // A settled turn that would paint open from the first-paint surface —… | README, Why the rows are built this way |
| `message-timeline.data.ts:272` | 5 | // The fold row is the turn's header: it sits above the turn's content… | README, Why the rows are built this way; case `worked-turn-folds` |
| `message-timeline.data.ts:316` | 9 | // The turn's trailing group is its live row while a tool runs or a th… | README, Why the rows are built this way |
| `message-timeline.data.ts:362` | 5 | // Upstream relays prefix the provider's message with their own // "Er… | README, Why failed turns read this way |
| `message-timeline.data.ts:368` | 5 | // The provider's response body carries the machine-readable code the … | README, Why failed turns read this way |
| `message-timeline.data.ts:381` | 4 | // Attach the recovery class on every turn, not just index 0. The clas… | README, Why failed turns read this way; case `failed-turn` |
| `message-timeline.data.ts:386` | 3 | // Composed here, not at mount: the row already carries the human // s… | README, Why failed turns read this way; case `failed-turn` |
| `message-timeline.data.ts:491` | 3 | // The turn's start is the only thing read off the user message, so th… | README, Why the rows are built this way |
| `message-timeline.data.ts:525` | 3 | // Mirrors PART_MAPPING's registered part types (message-part.tsx): no… | README, Why the rows are built this way; case `edit-plan-image` |
| `message-timeline.data.ts:548` | 1 | // Best-effort stop timestamp for native aborts whose message has no c… | README, Why the rows are built this way |
| `message-timeline.tsx:101` | 1 | // Keep parity with the upstream session row model. | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `message-timeline.tsx:117` | 10 | /** * A tag-narrowed view of the row accessor, seeded with the row the… | README, Invariants (already stated there) |
| `message-timeline.tsx:166` | 2 | // A reveal click resizes the row at the reader's position; the gestur… | README, Why scrolling works this way |
| `message-timeline.tsx:174` | 2 | // A subagent's transcript is a workspace-panel tab, not a second pane… | README, Why links and files open this way |
| `message-timeline.tsx:189` | 3 | // Shared with the terminal's file links (timeline-file-paths.ts): // … | README, Invariants (already stated there) |
| `message-timeline.tsx:194` | 4 | // Open a file in the workspace side panel (same path terminal file li… | README, Why links and files open this way |
| `message-timeline.tsx:204` | 4 | // Path-kind inline-code chips in assistant markdown. Anchors are hand… | README, Why links and files open this way |
| `message-timeline.tsx:217` | 1 | // don't hijack a text-selection click | README, Why links and files open this way |
| `message-timeline.tsx:218` | 1 | // anchors → capture handler below | deleted: the name, type or signature says it |
| `message-timeline.tsx:239` | 1 | // Capture phase runs before the link's default action (see above). | README, Why links and files open this way |
| `message-timeline.tsx:242` | 3 | // One memo drives BOTH the rail's mount and 'data-session-timeline-na… | README, Why the rail works this way |
| `message-timeline.tsx:255` | 2 | // The detail rides on a DOM CustomEvent, so it is read structurally r… | README, Why links and files open this way |
| `message-timeline.tsx:315` | 3 | // An admitted prompt reaches the transcript over events before the ne… | README, Why the rows are built this way |
| `message-timeline.tsx:321` | 5 | // Both indexes are keyed by, and answer questions about, the parent/c… | README, Why the rows are built this way |
| `message-timeline.tsx:346` | 6 | // A 'session.idle' lands before the final transcript read does: the t… | README, Invariants (already stated there) |
| `message-timeline.tsx:380` | 4 | // A stale un-completed assistant anchors on its parent only while tha… | README, Why the rows are built this way |
| `message-timeline.tsx:389` | 3 | // An idle that lands before the turn's transcript read keeps the newe… | README, Invariants (already stated there) |
| `message-timeline.tsx:432` | 7 | // Per-message inputs are equality-gated so a streaming part event (wh… | README, Why the rows are built this way |
| `message-timeline.tsx:500` | 2 | // Status can blip off "busy" for a frame mid-stream; dropping Thinkin… | README, Invariants (already stated there) |
| `message-timeline.tsx:566` | 1 | // 6 rows: a flick leaves 0 blank px at 1400px/frame and 802 at 5600, … | README, Why scrolling works this way |
| `message-timeline.tsx:579` | 6 | // Opening at the end and staying at the end are different promises. T… | README, Why scrolling works this way |
| `message-timeline.tsx:615` | 1 | // In-view insert holds and gesture windows mean the reader owns the v… | README, Why scrolling works this way |
| `message-timeline.tsx:621` | 8 | // A getter, not a stable closure: the virtualizer memoizes the extrac… | README, Why scrolling works this way |
| `message-timeline.tsx:663` | 3 | // The prepend-anchor loop parks itself while stashed (it reads // 'pr… | README, Why scrolling works this way |
| `message-timeline.tsx:713` | 1 | // getOffsetForIndex reads a lazily-refreshed cache; refresh it first. | README, Why scrolling works this way |
| `message-timeline.tsx:737` | 2 | // Force the capped fold's virtual measurements while the surface is /… | README, Why scrolling works this way |
| `message-timeline.tsx:855` | 2 | // The newest message says whether the turn is open: a step-per-messag… | README, Why the rows are built this way |
| `message-timeline.tsx:966` | 3 | // The predicate below used to claim 'AssistantMessage' for whatever /… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `message-timeline.tsx:1190` | 3 | // D§3.6 / C4: terminal states are a centred hairline divider, a peer … | README, Why the rows are built this way |
| `message-timeline.tsx:1341` | 3 | // Latch the last defined entry: the virtualizer can publish an item l… | README, Why the rows are built this way |
| `message-timeline.tsx:1381` | 1 | // JSX applies 'data-index' after refs and measureElement drops (warns… | README, Why the rows are built this way |
| `message-timeline.tsx:1500` | 3 | /* The content ref wraps the queued bubbles too: the auto-scroll and s… | README, Why the rows are built this way |
| `provider-error-detail.ts:1` | 10 | // A failed turn's wire error carries more than 'data.message': the en… | README, Why failed turns read this way |
| `provider-error-detail.ts:15` | 4 | /** * One human sentence naming what failed, why, and what to do. Alwa… | README, Why failed turns read this way |
| `provider-error-detail.ts:20` | 1 | /** The provider's own status/message/body, verbatim. Collapsed in the… | README, Why failed turns read this way |
| `provider-error-detail.ts:22` | 4 | /** * The provider's HTTP status when it reported one. Its presence me… | README, Why failed turns read this way |
| `provider-error-detail.ts:29` | 7 | // Upstream relays (the opencode gateway among them) prefix the provid… | README, Why failed turns read this way |
| `provider-error-detail.ts:67` | 1 | // The third thing every failure must say: what the user can actually … | README, Why failed turns read this way |
| `provider-error-detail.ts:92` | 6 | /** * Names the provider that actually served (or refused) the turn. P… | README, Why failed turns read this way |
| `provider-error-detail.ts:100` | 3 | // Operator ACP connections dispatch with their 'acp:<slug>' key as th… | README, Why failed turns read this way |
| `provider-error-detail.ts:153` | 5 | /** * A non-string 'message' still has to reach the user as something … | README, Why failed turns read this way |
| `provider-error-detail.ts:170` | 5 | /** * Splits a wire turn error into the human summary and the verbatim… | deleted: the name, type or signature says it |
| `provider-error-detail.ts:188` | 3 | // Detail: the provider's own words, verbatim, nothing re-derived. Mes… | README, Why failed turns read this way |
| `provider-error-detail.ts:196` | 3 | // Summary: who failed, what kind of failure, and what to do about it.… | README, Why failed turns read this way |
| `session-message-scroll-position.ts:17` | 1 | /** Resume bottom anchoring before and after the virtualizer's next la… | deleted: the name, type or signature says it |
| `subagent-parts.ts:4` | 7 | /** * The call ids a subagent edge can hang a chip on — spawn parts th… | README, Why the smaller pieces work this way; case `subagent-chip` |
| `table-timeline.ts:6` | 1 | /** Registers Claxedo's full-screen table viewer at the shared Markdow… | deleted: the name, type or signature says it |
| `thinking-visibility-hold.ts:1` | 8 | /** * Hide hysteresis for the timeline Thinking row. * * Status can bl… | README, Why the smaller pieces work this way |
| `thinking-visibility-hold.ts:13` | 1 | /** Epoch-ms deadline while a hide is being held; cleared once the row… | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:3` | 23 | /** * A per-frame loop that only spends frames while its surface is DI… | README, Why scrolling works this way |
| `timeline-displayed-frames.ts:27` | 1 | /** Whether this loop's surface is the one being shown. */ | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:29` | 1 | /** Frame seam for tests; tokens are opaque to the loop. */ | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:43` | 2 | // Re-checked here as well as in 'arm': the surface can be stashed aft… | README, Why scrolling works this way |
| `timeline-displayed-frames.ts:46` | 2 | // The step decides when the work is finished; the loop only decides /… | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:57` | 1 | /** Replace any running loop with 'next', which returns false when don… | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:66` | 1 | /** Spend frames again on a parked step. No-op unless parked and displ… | README, Why scrolling works this way |
| `timeline-displayed-frames.ts:70` | 1 | /** Drop the loop entirely — the work is no longer wanted. */ | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:77` | 1 | /** True while a step is owned, whether or not a frame is currently ar… | deleted: the name, type or signature says it |
| `timeline-displayed-frames.ts:81` | 1 | /** True only while a frame is actually scheduled. */ | deleted: the name, type or signature says it |
| `timeline-file-context-menu.tsx:1` | 2 | // Pure overlay UI over injected callbacks: path resolution and panel … | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `timeline-file-paths.ts:6` | 3 | // Path chips render opencode mentions as '@path'; strip the mention s… | README, Why links and files open this way |
| `timeline-file-paths.ts:11` | 5 | /** * Shared with the terminal's file links: normalizes './', relativi… | README, Invariants (already stated there) |
| `timeline-file-paths.ts:23` | 1 | /** Resolve an ambiguous inline-code value against exact workspace fil… | deleted: the name, type or signature says it |
| `timeline-file-paths.ts:42` | 1 | /** Absolute form for the OS-level desktop actions (Copy path / Reveal… | deleted: the name, type or signature says it |
| `timeline-file-paths.ts:49` | 8 | /** * File-path href of a timeline markdown anchor, or undefined for g… | README, Why links and files open this way |
| `timeline-file-paths.ts:68` | 6 | /** * File href of the anchor a plain left-click targets, or undefined… | README, Why links and files open this way |
| `timeline-file-paths.ts:77` | 1 | // Markdown tiles own full-image preview, including when wrapped in a … | README, Why links and files open this way |
| `timeline-file-paths.ts:85` | 1 | /** External image or source-attachment URL targeted by a plain left-c… | deleted: the name, type or signature says it |
| `timeline-file-paths.ts:89` | 1 | // Markdown tiles own full-image preview, including when wrapped in a … | README, Why links and files open this way |
| `timeline-file-paths.ts:106` | 7 | /** * Resolve the file path a context-menu event targets. Inline-code … | README, Why links and files open this way |
| `timeline-first-fold-reveal.ts:1` | 9 | /** * Finish a cold timeline's synchronous first-fold mount before the… | README, Why scrolling works this way |
| `timeline-link-open.ts:4` | 5 | /** * A dev server the agent just started is work in progress, not som… | README, Why links and files open this way |
| `timeline-link-open.ts:18` | 1 | // A Windows file URL carries the drive letter inside the path ('/C:/…… | README, Why links and files open this way |
| `timeline-link-open.ts:22` | 5 | /** * Where a link in the transcript opens. Leaving the event uncancel… | README, Why links and files open this way |
| `timeline-prepend-anchor.ts:28` | 8 | // The anchored row can be virtualized out entirely — e.g. a reveal th… | README, Why scrolling works this way |
| `timeline-prepend-anchor.ts:57` | 1 | /** Keeps the same row in view while history or a retained surface is … | deleted: the name, type or signature says it |
| `timeline-prepend-anchor.ts:93` | 7 | /** * Hand the viewport to the reader's gesture without dropping the r… | README, Why scrolling works this way |
| `timeline-queued-messages.tsx:6` | 7 | /** * Prompts the runtime is holding for the next turn, drawn where th… | README, Why the smaller pieces work this way |
| `timeline-queued-messages.tsx:15` | 1 | /** The controller's records minus those the transcript already shows.… | deleted: the name, type or signature says it |
| `timeline-queued-messages.tsx:35` | 2 | /* Indexed, not keyed: every poll returns fresh record objects, and a … | README, Why the smaller pieces work this way |
| `timeline-queued-messages.tsx:50` | 1 | // Held by another client's edit: shown as editing, releasable, not ed… | README, Why the smaller pieces work this way |
| `timeline-queued-messages.tsx:110` | 2 | /* Opts out of the narrow-viewport 40px tap floor: three floored ghost… | README, Why the smaller pieces work this way |
| `timeline-row-equality.ts:1` | 4 | // Identity-based equality gates for the per-message timeline row memo… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `timeline-row-equality.ts:8` | 3 | // Identity-based equality gates for the per-message row memos. Unchan… | README, Why the rows are built this way |
| `timeline-row-equality.ts:29` | 3 | // 'lastTurn' rides on the directory session-cache row, whose object i… | README, Why the rows are built this way |
| `timeline-row-model.ts:1` | 6 | // The message timeline's row model: the tagged TimelineRow union, its… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `timeline-row-model.ts:12` | 1 | /** Sits above the first rendered turn ('userMessageID') while 'count'… | deleted: the name, type or signature says it |
| `timeline-row-model.ts:36` | 1 | /** The turn's body is held back until its full read lands; drawn as a… | deleted: the name, type or signature says it |
| `timeline-row-model.ts:51` | 5 | /** * The human sentence for the row's PRIMARY line, composed here alo… | README, Why failed turns read this way |
| `timeline-row-model.ts:66` | 8 | /** * A constructor for one tagged row. * * Rows are plain frozen-shap… | README, Why the rows are built this way |
| `timeline-row-model.ts:98` | 6 | /** * 'SummaryDiff' is 'AgentSnapshotFileDiff & { file: string }', a c… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `timeline-row-model.ts:249` | 7 | /** * The row's OWN message id, distinct from the turn key: a UserMess… | README, Why the rows are built this way |
| `timeline-row-model.ts:256` | 5 | /** * Rows a reading position can be restored against. The previous-me… | README, Why the rows are built this way |
| `timeline-row-model.ts:265` | 1 | /** Rows that anchor a user-message position (scroll targets, row inde… | deleted: the name, type or signature says it |
| `timeline-row-model.ts:281` | 5 | /** * Part-level identity beside the message-level one: assistant mess… | README, Why the rows are built this way |
| `timeline-scroll-memory.ts:6` | 1 | /** The last displayed reading position, shared by retained returns an… | deleted: the name, type or signature says it |
| `timeline-scroll-memory.ts:34` | 2 | // Hidden surfaces may report a clamped offset or zero geometry. Neith… | README, Why scrolling works this way |
| `timeline-virtualization.ts:6` | 3 | // Short responses stay on the virtualizer default. Avoid any further … | README, Why scrolling works this way |
| `timeline-virtualization.ts:11` | 9 | // Calibrated against rendered transcripts (live measurement, 2026-09-… | README, Why scrolling works this way |
| `timeline-virtualization.ts:38` | 8 | /** * Whether this timeline's surface is the one being shown. A stashe… | README, Why scrolling works this way |
| `timeline-virtualization.ts:50` | 6 | /** * Whether an insert beside the row with this key is content the re… | README, Why scrolling works this way |
| `timeline-virtualization.ts:66` | 4 | // Initial bottom-anchored layout only needs precise estimates around … | README, Why scrolling works this way |
| `timeline-virtualization.ts:83` | 4 | // A row inserted inside the viewport (a reply's first part landing ab… | README, Why scrolling works this way |
| `timeline-virtualization.ts:96` | 6 | /** * Scroll compensation for a resized row, installed onto the virtua… | README, Why scrolling works this way |
| `timeline-virtualization.ts:118` | 3 | // The insert lands where the row it displaced used to start, or after… | README, Why scrolling works this way |
| `timeline-virtualization.ts:123` | 5 | // Only a near-tail insert beside a visible row can push the anchored … | README, Why scrolling works this way |
| `timeline-virtualization.ts:131` | 5 | // The hold only covers the insert's own measure pass. When it lifts, … | README, Why scrolling works this way |
| `timeline-virtualization.ts:141` | 2 | // measurementsCache is memoized — materialize it before reading the /… | README, Why scrolling works this way |
| `timeline-virtualization.ts:145` | 2 | // Follow only when the insert pushed the tail row below the fold; a /… | README, Why scrolling works this way |
| `timeline-virtualization.ts:168` | 9 | // A rendered row is never 0px. A zero measurement means the element w… | README, Why scrolling works this way |
| `timeline-virtualization.ts:181` | 5 | // Pinning exists to keep the rows a mid-history reader is looking at … | README, Why scrolling works this way |
| `timeline-virtualization.ts:213` | 12 | /** * Per-row frame styles for a virtualized timeline row. Rows render… | README, Why scrolling works this way |
| `turn-fold-store.ts:3` | 7 | /** * The reader's own fold choices, per turn, kept for 16 sessions so… | README, Invariants (already stated there) |
| `turn-fold-store.ts:16` | 1 | /** Explicit user choice for a turn, or 'undefined' when still on auto… | README, Why the smaller pieces work this way |
| `turn-fold-store.ts:18` | 1 | /** Record an explicit user toggle. */ | deleted: the name, type or signature says it |
| `turn-fold-store.ts:20` | 1 | /** Reset a turn back to auto. */ | deleted: the name, type or signature says it |
| `turn-fold-store.ts:22` | 1 | /** Write the current state back to the module cache (call from onClea… | deleted: the name, type or signature says it |
| `turn-recovery.ts:1` | 8 | // Client-side mirror of the server classifier in // packages/agent-sd… | README, Why failed turns read this way |
| `turn-recovery.ts:18` | 3 | // Copy is position-independent — descriptions must not reference "fir… | README, Why failed turns read this way |
| `turn-recovery.ts:28` | 4 | // No generic-shrug copy: the description is always derived from the w… | README, Why failed turns read this way |
| `turn-recovery.ts:47` | 12 | /** * The description to render for a failed turn. Never a generic shr… | README, Why failed turns read this way |
| `turn-recovery.ts:80` | 3 | // The broker's own vocabulary, from the table the broker writes it ou… | README, Why failed turns read this way |
| `turn-recovery.ts:95` | 1 | /** A completed tool step can precede the turn's actual answer under t… | README, Why failed turns read this way |

## Transcript (`src/transcript`, at `a7f5ecc83b`)

| Where | Lines | Comment | Outcome |
| --- | --- | --- | --- |
| `activity-row.css:1` | 7 | /* * ActivityRow — the muted activity-row primitive (Codex timeline de… | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:18` | 1 | /* One dim tone for the whole row; hover lifts the text only. */ | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:44` | 1 | /* Content sits above the overlay hit target but stays click-through e… | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:45` | 1 | /* Icon inherits the row's dim tone (see .activity-row) so icon + text… | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:123` | 1 | /* Real interactive descendants opt back into pointer events. */ | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:131` | 1 | /* Hover gate — mouse-capable devices only. */ | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:143` | 1 | /* Keyboard focus mirrors hover for the brighten + chevron reveal. */ | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.css:157` | 1 | /* Nested rows inside a WorkGroup: dimmer, icon-less, depth by dimming… | README, Why tool rows read this way; case `worked-turn-folds` |
| `activity-row.tsx:5` | 1 | /** Category icon (muted); hidden when nested inside a group. */ | deleted: the name, type or signature says it |
| `activity-row.tsx:7` | 1 | /** Leading verb — reads at --text-base, brightens to --text-strong on… | deleted: the name, type or signature says it |
| `activity-row.tsx:9` | 1 | /** Trailing detail — single line, truncated, whispers at --text-weak.… | deleted: the name, type or signature says it |
| `activity-row.tsx:11` | 1 | /** Right-aligned accessory (diffstat, elapsed, status dot). */ | deleted: the name, type or signature says it |
| `activity-row.tsx:13` | 1 | /** Expanded state — rotates the chevron, mirrors aria-expanded. */ | deleted: the name, type or signature says it |
| `activity-row.tsx:15` | 1 | /** Toggle handler; when present the overlay button toggles and shows … | deleted: the name, type or signature says it |
| `activity-row.tsx:17` | 1 | /** Whether the row has expandable content (controls chevron visibilit… | deleted: the name, type or signature says it |
| `activity-row.tsx:19` | 1 | /** Marks the row as active/running (data-active for callers to style)… | deleted: the name, type or signature says it |
| `activity-row.tsx:21` | 1 | /** Nested inside a WorkGroup — dimmer, icon-less. */ | deleted: the name, type or signature says it |
| `activity-row.tsx:23` | 1 | /** Extra class on the row shell. */ | deleted: the name, type or signature says it |
| `activity-row.tsx:25` | 1 | /** Accessible label for the overlay toggle button. */ | deleted: the name, type or signature says it |
| `activity-row.tsx:29` | 5 | /** * ActivityRow — the muted activity-row primitive (T0.1). One anato… | README, Why tool rows read this way |
| `agent-glyph.css:1` | 1 | /* AgentGlyph (T12) — stable per-agent mark; slow scan while the child… | README, Why subagent chips work this way; case `subagent-chip` |
| `agent-glyph.tsx:3` | 6 | /** * AgentGlyph (T12) — a deterministic little two-tone mark that giv… | README, Why subagent chips work this way; case `subagent-chip` |
| `agent-glyph.tsx:18` | 1 | // Ten tiny glyph paths on a 0 0 16 16 viewBox — gems, flowers, and st… | deleted: the name, type or signature says it |
| `attachment-card-v2.tsx:4` | 1 | /** Shared 160px two-line card used by v2 file and comment attachments… | README, Why the file and diff viewers work this way |
| `attachment-card-v2.tsx:11` | 1 | /** native title attribute */ | deleted: the name, type or signature says it |
| `basic-tool.css:39` | 5 | /* * Category icon (T1). Sized down to 14px and made to INHERIT the ro… | README, Why tool rows read this way |
| `basic-tool.css:140` | 6 | /* * text-overflow cannot elide an atomic inline, so a subtitle whose … | README, Why tool rows read this way |
| `basic-tool.css:212` | 1 | /* Live elapsed while running (T6) — muted, tabular so ticks don't shi… | README, Why tool rows read this way |
| `basic-tool.css:226` | 7 | /* * Muted row (T1, D§3.3). One uniform dim tone at rest across icon +… | README, Why tool rows read this way |
| `basic-tool.tsx:61` | 1 | /** Epoch ms the tool started running; drives the live "for Xs" elapse… | deleted: the name, type or signature says it |
| `basic-tool.tsx:71` | 2 | // Timeline tools are mounted top-to-bottom, but the viewport starts a… | README, Why tool rows read this way |
| `basic-tool.tsx:104` | 5 | /** * Whether resolved children amount to anything on screen. A render… | README, Why tool rows read this way |
| `basic-tool.tsx:109` | 1 | /** The exit status a shell completion carried, once the process ended… | deleted: the name, type or signature says it |
| `basic-tool.tsx:115` | 1 | /** A non-zero exit beside the command, so "Ran" alone never reads as … | README, Why tool rows read this way |
| `basic-tool.tsx:141` | 5 | /** * Resolved once and reused by the body below, so asking what the r… | README, Why tool rows read this way |
| `basic-tool.tsx:149` | 1 | // Live elapsed: tick once a second only while the tool is running. | deleted: the name, type or signature says it |
| `basic-tool.tsx:160` | 1 | /** The trigger when it is neither a render function nor a structured … | deleted: the name, type or signature says it |
| `basic-tool.tsx:218` | 1 | // Animated height for collapsible open/close | deleted: the name, type or signature says it |
| `basic-tool.tsx:250` | 6 | /** * A running tool is the one a reader most wants to open — streamin… | README, Why tool rows read this way |
| `basic-tool.tsx:261` | 1 | /** Caller-supplied trigger link, dropped unless it survives the schem… | README, Why links carry a scheme policy |
| `basic-tool.tsx:291` | 4 | /* The subtitle and args are what name the call — the file being read,… | README, Why tool rows read this way |
| `basic-tool.tsx:397` | 1 | /** The input a tool row is about, and the key it came from — the key … | deleted: the name, type or signature says it |
| `basic-tool.tsx:398` | 8 | /** * Collapses a JSON payload embedded in a subtitle to '{…}'. * * A … | README, Why tool rows read this way |
| `basic-tool.tsx:439` | 5 | /** * Arg chips for tools with no registered renderer. Short scalars o… | README, Why tool rows read this way |
| `basic-tool.tsx:461` | 11 | /** * Whether a tool row is an MCP operation, for any harness. * * 'in… | README, Why tool rows read this way |
| `basic-tool.tsx:477` | 15 | /** * Icon by canonical tool intent — the only classification every ha… | README, Why tool rows read this way |
| `basic-tool.tsx:507` | 2 | // Name fallbacks, for parts that reach the timeline without a classif… | README, Why tool rows read this way |
| `basic-tool.tsx:515` | 1 | // 'web_fetch' has no alias: no harness that sends it also sends 'webf… | README, Why tool rows read this way |
| `basic-tool.tsx:521` | 2 | // A wrench, not 'mcp': the fallback covers every unrecognised tool, a… | README, Why tool rows read this way |
| `basic-tool.tsx:527` | 5 | /** * Tool names that reach the timeline as one lowercased token ('Sen… | README, Why tool rows read this way |
| `basic-tool.tsx:540` | 1 | /** Input keys that are themselves the preposition joining the action … | deleted: the name, type or signature says it |
| `basic-tool.tsx:572` | 4 | /** * 'plugin_posthog_posthog' is a plugin name followed by the server… | README, Why tool rows read this way |
| `basic-tool.tsx:581` | 4 | /** * A single word says nothing the raw name did not, so it becomes a… | README, Why tool rows read this way |
| `basic-tool.tsx:593` | 4 | /** * The action a tool name reads as, or nothing when the name yields… | deleted: the name, type or signature says it |
| `basic-tool.tsx:605` | 1 | /** The MCP server, shown beside the row as secondary context. */ | deleted: the name, type or signature says it |
| `basic-tool.tsx:609` | 4 | /** * A tool row with no registered renderer, read as a sentence: the … | README, Why tool rows read this way |
| `basic-tool.tsx:650` | 2 | // The marker is the only thing that tells a generic row from a regist… | README, Why tool rows read this way |
| `basic-tool.tsx:664` | 2 | /* Only pass children when there is output, so BasicTool's chevron sta… | README, Why tool rows read this way |
| `claxedo-tool-view.ts:9` | 6 | /** * Every tool the first-party MCP registers, with the row title eac… | README, Why first-party tool rows read this way |
| `claxedo-tool-view.ts:60` | 1 | /** Resolve the server identity carried by each harness without claimi… | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:63` | 1 | // Both names are used by first-party MCP registrations and persisted … | README, Why first-party tool rows read this way |
| `claxedo-tool-view.ts:79` | 5 | /** * The arguments the tool was called with. Codex reports an MCP cal… | README, Why first-party tool rows read this way |
| `claxedo-tool-view.ts:90` | 6 | /** * The tool's JSON answer, or nothing when the output is prose or a… | README, Why first-party tool rows read this way |
| `claxedo-tool-view.ts:101` | 2 | // A tool that answers in prose and payload marks the payload's line, … | README, Why first-party tool rows read this way |
| `claxedo-tool-view.ts:116` | 1 | /** What the call was about, when it is not a link. */ | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:118` | 1 | /** What the call was about, as a link to the task or session. */ | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:120` | 1 | /** A task status, shown as a pill beside the subject. */ | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:122` | 1 | /** A trailing aside: the call was replayed, the session was already r… | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:126` | 1 | /** What the row list leaves out: a count past the cap, or a further p… | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:128` | 1 | /** A prose answer, shown as it came. */ | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:137` | 1 | /** A session's title when the transcript already knows it, so a link … | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:154` | 1 | /** Rows a task list shows before folding the rest behind a count. */ | deleted: the name, type or signature says it |
| `claxedo-tool-view.ts:376` | 8 | /** * The card reads the contract's own test rather than the operation… | README, Why first-party tool rows read this way |
| `claxedo-tool-view.ts:420` | 1 | /** Output that is prose, or JSON the card has no shape for: shown as … | deleted: the name, type or signature says it |
| `claxedo-tool.css:1` | 2 | /* A first-party tool row: the same muted voice as every other tool ro… | README, Why first-party tool rows read this way |
| `claxedo-tool.css:16` | 2 | /* The list row's only sign of its state at rest is this 16px mark; th… | README, Why first-party tool rows read this way |
| `claxedo-tool.css:53` | 2 | /* 22px = the 14px leading icon plus its 8px gap, so the body's left e… | README, Why first-party tool rows read this way |
| `claxedo-tool.tsx:18` | 8 | /** * A link in a tool row: a plain anchor to the surface's own route … | README, Why first-party tool rows read this way |
| `claxedo-tool.tsx:64` | 5 | /** * One first-party tool call as a transcript row: the Claxedo mark,… | deleted: the name, type or signature says it |
| `data.tsx:21` | 7 | /** * A session row as this view needs one. * * 'slug' and 'version' a… | README, Other shapes |
| `data.tsx:92` | 4 | /** * A workspace-relative path to a URL the browser can fetch. Tool a… | README, Why tool rows read this way |
| `diff/comment-hover.ts:42` | 5 | // The hovered line changes when the pointer moves or when content scr… | README, Why the file and diff viewers work this way |
| `diff/diff-selection.ts:3` | 4 | /** * Which column of a split diff a selection belongs to. '@pierre/di… | deleted: the name, type or signature says it |
| `diff/diff-selection.ts:21` | 1 | /** Maps a 'data-line-type' attribute to the side it belongs to, or 'u… | deleted: the name, type or signature says it |
| `diff/file-find-content.ts:1` | 14 | /** * Where a find query matches, read from the file's own text. * * A… | README, Why the file and diff viewers work this way |
| `diff/file-find-content.ts:17` | 1 | /** 1-based, the same numbering 'data-line' carries. */ | deleted: the name, type or signature says it |
| `diff/file-find-content.ts:19` | 1 | /** Character offset of the match inside its line. */ | deleted: the name, type or signature says it |
| `diff/file-find-content.ts:24` | 1 | /** The lines a file's contents are rendered as, 1-based by index + 1.… | deleted: the name, type or signature says it |
| `diff/file-find-content.ts:27` | 2 | // A trailing newline ends the last line, it does not begin another on… | README, Why the file and diff viewers work this way |
| `diff/file-find-content.ts:51` | 1 | /** Which match indexes fall on each line, in the order they were foun… | deleted: the name, type or signature says it |
| `diff/file-find-content.ts:63` | 9 | /** * Line up what the rendered rows can paint with what the file says… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:16` | 5 | /** * How many frames a reveal is followed for before find gives up on… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:92` | 5 | /** * The CSS Custom Highlight registry, or 'undefined' where the API … | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:117` | 8 | /** * The file's own lines, when this viewer renders a WINDOW over the… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:126` | 1 | /** Bring 'line' into the rendered window; the rows arrive asynchronou… | deleted: the name, type or signature says it |
| `diff/file-find.ts:136` | 2 | // Set when the active match's row is not rendered yet: the reveal is … | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:190` | 1 | // A match whose row the window does not hold has no range to draw. | deleted: the name, type or signature says it |
| `diff/file-find.ts:272` | 1 | /** Every occurrence of 'value' inside one rendered row, as DOM ranges… | deleted: the name, type or signature says it |
| `diff/file-find.ts:326` | 9 | /** * The file's matches, paired with a range for each one whose row i… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:394` | 2 | // A match the window does not hold yet is still the active one: ask f… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:423` | 10 | /** * Catch up with the rows a reveal is bringing in. * * A windowed v… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:441` | 1 | /** Re-apply once on the next frame, coalescing a burst of scroll even… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:466` | 1 | /** Ask the viewer for 'line''s row, then follow it in until it is dra… | deleted: the name, type or signature says it |
| `diff/file-find.ts:506` | 2 | // The match is outside the rendered window. Ask for its row; the wind… | README, Why the file and diff viewers work this way |
| `diff/file-find.ts:569` | 4 | // A windowed viewer's rendered rows are a function of this scroller's… | README, Why the file and diff viewers work this way |
| `diff/file-runtime.ts:15` | 6 | /** * The nearest ancestor that scrolls 'el' vertically, or 'undefined… | README, Why the file and diff viewers work this way |
| `diff/index.ts:164` | 2 | // 'diffStyle' is declared on the non-generic 'BaseDiffOptions', so th… | deleted: the name, type or signature says it |
| `diff/lru-map.ts:1` | 11 | /** * Insertion-ordered map with a most-recently-used eviction bound, … | README, Why the file and diff viewers work this way |
| `diff/lru-map.ts:23` | 1 | /** Read 'key' and mark it most-recently-used. */ | deleted: the name, type or signature says it |
| `diff/lru-map.ts:52` | 1 | /** Evict the least-recently-used entry and return it. */ | deleted: the name, type or signature says it |
| `diff/lru-map.ts:65` | 1 | /** Read 'key' without changing its recency. */ | deleted: the name, type or signature says it |
| `diff/selection-bridge.ts:67` | 5 | /** * 'ShadowRoot.getSelection()' is a Chromium extension that lib.dom… | README, Why the file and diff viewers work this way |
| `diff/selection-bridge.ts:76` | 1 | /** The selection scoped to 'root' where the browser supports it, othe… | README, Why the file and diff viewers work this way |
| `diff/virtualizer.ts:16` | 1 | /** A ref-counted lease on a shared virtualizer. 'release' is idempote… | deleted: the name, type or signature says it |
| `diff/virtualizer.ts:30` | 9 | /** * Rows a panel-hosted virtual view keeps around the visible range.… | README, Why the file and diff viewers work this way |
| `diff/worker.ts:15` | 5 | // poolSize defaults to 8. More workers = more parallelism but // also… | README, Why the file and diff viewers work this way |
| `diff/worker.ts:48` | 20 | /** * The pool for a surface that highlights a WHOLE FILE rather than … | README, Why the file and diff viewers work this way |
| `file-media.tsx:100` | 2 | // Keep the previous media visible while re-reading the same file (e.g… | README, Why the file and diff viewers work this way |
| `file.tsx:83` | 5 | /** * Scrolling a file view to one line. The viewer owns this because … | README, Why the file and diff viewers work this way |
| `file.tsx:150` | 3 | // -------------------------------------------------------------------… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:166` | 1 | // mode-specific callbacks | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:177` | 3 | // Find. A whole-file view windows its rows, so find reads the file's … | README, Why the file and diff viewers work this way |
| `file.tsx:211` | 1 | // -- selection scheduling -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:234` | 1 | // -- mouse handlers -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:312` | 1 | // -- shared effects -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:509` | 2 | // renderViewer always draws with empty annotations, so skip the extra… | README, Why the file and diff viewers work this way |
| `file.tsx:608` | 3 | // A text view rooted in an element is rooted in a panel scroller, whi… | README, Why the file and diff viewers work this way |
| `file.tsx:697` | 3 | // -------------------------------------------------------------------… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:743` | 3 | // -------------------------------------------------------------------… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:754` | 5 | // 'FileContents.contents' is declared 'string', but the value reachin… | README, Why the file and diff viewers work this way |
| `file.tsx:771` | 8 | // A text view windows its rows, exactly like DiffViewer below: a work… | README, Why the file and diff viewers work this way |
| `file.tsx:864` | 3 | // The rows are a window over the file; its text is what find counts a… | README, Why the file and diff viewers work this way |
| `file.tsx:914` | 7 | /** * Scroll one line into view. A rendered row is scrolled to exactly… | README, Why the file and diff viewers work this way |
| `file.tsx:922` | 2 | // Find reveals by line number now, so a line the file does not have h… | README, Why the file and diff viewers work this way |
| `file.tsx:942` | 1 | // -- render instance -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:946` | 4 | // A text view highlights a whole file, so the pools' one difference /… | README, Why the file and diff viewers work this way |
| `file.tsx:983` | 1 | // -- cleanup -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:994` | 3 | // -------------------------------------------------------------------… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:1152` | 1 | // -- render instance -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:1185` | 2 | // Pierre beta virtualized instances retain their first diff target an… | README, Why the file and diff viewers work this way |
| `file.tsx:1243` | 1 | // -- cleanup -- | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `file.tsx:1262` | 3 | // -------------------------------------------------------------------… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `format-duration.ts:1` | 8 | /** * Shared duration formatter for the timeline (D§3.6): * <60s → "5s… | README, Why tool rows read this way |
| `line-comment-annotations.tsx:51` | 1 | /** Retain draft text and edit identity while a virtualized row releas… | README, Why the file and diff viewers work this way |
| `line-comment-annotations.tsx:112` | 3 | // Generic host machinery shared by the v1 and v2 annotation renderers… | README, Why the file and diff viewers work this way |
| `line-comment-annotations.tsx:121` | 1 | /** One annotation's detached host plus the handles that keep it alive… | deleted: the name, type or signature says it |
| `line-comment-annotations.tsx:546` | 1 | // Stable identity for unchanged annotations avoids no-op diff rerende… | README, Why the file and diff viewers work this way |
| `line-comment.tsx:38` | 4 | // These are attached through Solid's 'on:' namespace (a direct addEve… | README, Why the file and diff viewers work this way |
| `local-preview.ts:1` | 8 | /** * A loopback URL worth a "Local preview" row, or undefined. * * Ba… | README, Why tool rows read this way |
| `markdown-cache.tsx:11` | 6 | // Sized to the workbench's visible working set, not to one component:… | README, Why markdown renders this way |
| `markdown-cache.tsx:18` | 3 | // Entries sized so the byte budget is the binding cap: typical parsed… | README, Why markdown renders this way |
| `markdown-cache.tsx:32` | 4 | // The same schemes the transcript's own linkifier recognises, so a ta… | README, Why markdown renders this way |
| `markdown-cache.tsx:62` | 16 | /** * SVG sanitization for rendered mermaid diagrams. * * 'renderMerma… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:79` | 5 | // Same-document fragments, relative paths, and http(s)/mailto only: D… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:86` | 3 | // Mirrors DOMPurify's own ATTR_WHITESPACE: the characters a browser d… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:98` | 8 | /** * Mermaid ships a diagram's entire theme in a single '<style>' ele… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:115` | 1 | // Mermaid's theme lives here; the hook below hardens its contents. | deleted: the name, type or signature says it |
| `markdown-cache.tsx:117` | 12 | // Most of these already sit outside DOMPurify's 'svg' profile; naming… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:141` | 2 | // Drop the subtree as well, so a stripped 'foreignObject' cannot spil… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:144` | 3 | // DOMPurify drops every 'on*' handler already (they appear in no allo… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:148` | 3 | // Must stay off. It rewrites 'id'/'name' to 'user-content-*', which w… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:159` | 2 | // A dedicated instance, not the shared one: the '<style>' hook below … | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:167` | 1 | // SVG elements report a lowercase 'nodeName'; HTML ones report upperc… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:172` | 5 | /** * Returns "" when the SVG cannot be safely rendered. Callers must … | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:193` | 2 | // An entry larger than the whole budget would evict everything and st… | README, Why markdown renders this way |
| `markdown-cache.tsx:216` | 6 | /** * Sanitized mermaid SVG keyed by diagram source. Remounted rows ar… | README, Why Mermaid is rendered and sanitized this way |
| `markdown-cache.tsx:270` | 2 | // This module sits on the boot path through session-kit-loaders; the … | README, Why markdown renders this way |
| `markdown-code-cache.ts:4` | 23 | /** * Module-scope cache for COMPLETED code-block highlights. * * The … | README, Why markdown renders this way |
| `markdown-code-cache.ts:42` | 5 | // Sized to the workbench's visible working set: up to MAX_OPEN_SURFAC… | README, Why markdown renders this way |
| `markdown-code-cache.ts:48` | 3 | // UTF-16 code units of cached text (source + token content + token st… | README, Why markdown renders this way |
| `markdown-code-cache.ts:80` | 2 | // An entry larger than the whole budget would evict everything and st… | README, Why markdown renders this way |
| `markdown-code-cache.ts:99` | 6 | /** * Read-through used by markdown.tsx's 'code()': serve completed bl… | README, Why markdown renders this way |
| `markdown-inline-code-kind.ts:1` | 2 | // One-off copy from GitHub Linguist languages.yml (e9fe3c9f230cd9220a… | README, Why markdown renders this way |
| `markdown-inline-code-kind.ts:1896` | 2 | // '~/…' can't be expanded client-side, so the file panel refuses it /… | README, Why markdown renders this way |
| `markdown-inline-code-kind.ts:1902` | 7 | /** * Known filenames can be styled immediately. Ambiguous slash-shape… | README, Why markdown renders this way |
| `markdown-inline-code-kind.ts:1910` | 2 | // Chips carry the timeline's ':line[:col]' suffix ('src/foo.ts:42'); … | README, Why markdown renders this way |
| `markdown-shiki-language.ts:3` | 5 | /** * Shiki's grammar names, plus the built-in plain-text pseudo-langu… | README, Why markdown renders this way |
| `markdown-shiki-language.ts:14` | 1 | /** The language a fence resolves to; anything shiki does not bundle f… | deleted: the name, type or signature says it |
| `markdown-shiki-language.ts:19` | 8 | /** * The grammar to load before tokenizing, or 'undefined' when the l… | README, Why markdown renders this way |
| `markdown-stream.ts:22` | 13 | /** * Reference-link support without collapsing the block projection. … | README, Why markdown renders this way |
| `markdown-stream.ts:55` | 7 | /** * The fenced-code fields a block projection needs, or 'undefined' … | README, Why markdown renders this way |
| `markdown-stream.ts:154` | 2 | // Render the available rows now. Waiting for another token or message… | README, Why markdown renders this way |
| `markdown-stream.ts:179` | 6 | // TODO: streaming 'Run the 'config' then '# User Guide' / '#userconfi… | README, Why markdown renders this way |
| `markdown-table.ts:13` | 5 | /** * Clipboard text for a rendered Markdown table. Tabs and newlines … | README, Why markdown renders this way; case `markdown-blocks` |
| `markdown-worker-queue.ts:61` | 2 | // 'schedule' can start a fresh run from inside the previous run's 'fi… | README, Why markdown renders this way |
| `markdown.css:8` | 1 | /* Reset & Base Typography */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:22` | 1 | /* Spacing for flow */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:36` | 1 | /* Headings: Sized by level, distinguished by color and spacing */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:88` | 1 | /* Emphasis & Strong: Neutral strong color */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:95` | 1 | /* Paragraphs */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:100` | 1 | /* Links */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:112` | 1 | /* Lists */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:174` | 1 | /* Blockquotes */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:317` | 1 | /* Mermaid (T14): once rendered, hide the source <pre> and show the th… | README, Why Mermaid is rendered and sanitized this way; case `markdown-blocks` |
| `markdown.css:342` | 2 | /* Pill (D§3.12): hairline inset ring on a legacy token so it reads as… | README, Why markdown renders this way; case `markdown-blocks` |
| `markdown.css:352` | 5 | /* * Path/url inline code keeps the neutral pill — no accent tint. Tin… | README, Why markdown renders this way; case `markdown-blocks` |
| `markdown.css:377` | 1 | /* Tables */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `markdown.css:439` | 3 | /* Images render as fixed compact tiles: loading, loaded, and failed s… | README, Why markdown renders this way; case `markdown-blocks` |
| `markdown.css:569` | 6 | /* * Inline code reads as an object, not as syntax (T15/D§3.12). This … | README, Why markdown renders this way; case `markdown-blocks` |
| `markdown.tsx:83` | 1 | /** First-frame HTML for live tokens and cold remounts. Escaped source… | README, Why markdown renders this way |
| `markdown.tsx:240` | 13 | /** * Mermaid — the app registers a renderer (it owns the 'mermaid' de… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `markdown.tsx:255` | 6 | /** * Renders in flight, by source. A rich pass can replace a fenced b… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `markdown.tsx:374` | 3 | // Marked/Shiki preserve the fence-closing line break for nested block… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `markdown.tsx:416` | 1 | // Guard against streaming: skip if the source changed while rendering… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `markdown.tsx:418` | 4 | // Fail closed. 'sanitizeSvg' returns "" when it cannot vouch for the … | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `markdown.tsx:433` | 1 | // Fallback: keep the code block, clear the marker so a later retry is… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `markdown.tsx:494` | 1 | /** The debug hooks the perf harness hangs off 'window'; absent in a n… | deleted: the name, type or signature says it |
| `markdown.tsx:612` | 9 | /** * Per-URL image fetch outcomes, shared across every markdown rende… | README, Why markdown renders this way |
| `markdown.tsx:657` | 8 | /** * Transcript markdown can name a workspace file ('file://' URL, ab… | README, Why markdown renders this way |
| `markdown.tsx:712` | 3 | // The img has to stay where it is until the tile takes its place — //… | README, Why markdown renders this way |
| `markdown.tsx:752` | 2 | // Capture, so no descendant can stop a click before the link is offer… | README, Why markdown renders this way |
| `markdown.tsx:760` | 2 | // Read the live DOM: morphdom preserves nodes but does not replace th… | README, Why markdown renders this way |
| `markdown.tsx:849` | 1 | // A partial hit is no hit: the caller falls back to a synchronous ren… | README, Why markdown renders this way |
| `markdown.tsx:876` | 1 | /** Delay rich work for a newly mounted completed body. Set to 0 for a… | README, Why markdown renders this way |
| `markdown.tsx:887` | 2 | // Hosts without the session data provider cannot resolve workspace-re… | README, Why markdown renders this way |
| `markdown.tsx:893` | 3 | // Completed and streaming bodies both commit real markdown on the fir… | README, Why markdown renders this way |
| `markdown.tsx:938` | 2 | // Completed blocks read through the module-scope highlight cache // i… | README, Why markdown renders this way |
| `markdown.tsx:991` | 4 | // This owns the Markdown DOM itself, so its initial commit belongs to… | README, Why markdown renders this way |
| `markdown.tsx:1006` | 3 | // 'html()' suspends while the asynchronous parser is pending. Suspend… | README, Why markdown renders this way |
| `markdown.tsx:1010` | 2 | // First paint is cache or sync-parsed HTML. Do not commit escaped sou… | README, Why markdown renders this way |
| `markdown.tsx:1020` | 3 | // End-of-stream and cold completed waits must not wipe tokens that //… | README, Why markdown renders this way |
| `markdown.tsx:1116` | 5 | // A top-level '''mermaid fence is *always* a 'mode: "code"' block, an… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `mermaid.ts:3` | 7 | /** * Shared mermaid loader and renderer configuration for every surfa… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `mermaid.ts:56` | 9 | // Defense in depth, paired with 'sanitizeSvg' in session-ui. With HTM… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `mermaid.ts:80` | 5 | /** * Renders the diagram source to raw (unsanitized) SVG. Callers tha… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `mermaid.ts:90` | 5 | /** * Renders and sanitizes in one step. Throws when the sanitizer can… | README, Why Mermaid is rendered and sanitized this way; case `math-and-mermaid` |
| `message-file.ts:18` | 1 | // language metadata only; grammars stay behind shiki's lazy imports | README, Why markdown renders this way |
| `message-file.ts:25` | 2 | // attachments carry text/plain for all text files, so the label comes… | README, Why markdown renders this way |
| `message-file.ts:30` | 1 | // idx 0 is a dotfile like .gitignore, not an extension | README, Why markdown renders this way |
| `message-nav.css:102` | 1 | /* text-14-regular */ | deleted: the name, type or signature says it |
| `message-nav.css:140` | 7 | /* * Overlay edge, same recipe as 'hover-card-content' / 'popover-cont… | README, Why the rail works this way |
| `message-nav.tsx:25` | 9 | /** * What this nav reads off a turn's user message: its id, and the s… | README, Why the rail works this way |
| `message-nav.tsx:39` | 5 | /** * Generic over the row type so the callbacks hand back what the ca… | README, Why the rail works this way |
| `message-nav.tsx:195` | 2 | // 'relatedTarget' is an 'EventTarget'; kobalte compares it against it… | README, Why the rail works this way |
| `message-nav.tsx:213` | 2 | // Preview text joins every part of the turn — compute it only for // … | README, Why the rail works this way |
| `message-part-text.ts:5` | 1 | /** A single line's worth of a value that may arrive as prose: whitesp… | deleted: the name, type or signature says it |
| `message-part.css:65` | 1 | /* inset box-shadows do not paint over <img> content, so the hairline … | README, Why tool rows read this way |
| `message-part.css:285` | 1 | /* Both image surfaces — an attachment on a message, and an image a 'r… | deleted: the name, type or signature says it |
| `message-part.css:289` | 3 | /* Thumbnail, not the artefact: 320px is the bounded-block width alrea… | README, Why tool rows read this way |
| `message-part.css:421` | 1 | /* Collapsed "Thought for Ns" body (T18): muted 13px, no big top margi… | README, Why grouping and the fold work this way |
| `message-part.css:636` | 1 | /* No text-transform - preserve original filename casing */ | deleted: the name, type or signature says it |
| `message-part.css:642` | 1 | /* File-link affordance (T8, D§3.5): dotted underline reads as an open… | README, Why markdown renders this way |
| `message-part.css:709` | 1 | /* Hide scrollbar */ | deleted: the name, type or signature says it |
| `message-part.css:848` | 1 | /* Severity is carried by this 16px glyph, not by colouring the text (… | README, Why tool rows read this way |
| `message-part.css:1639` | 1 | /* Uniform dim for edit/write rows (T1) — matches the tool-row tone; h… | README, Why tool rows read this way |
| `message-part.css:1804` | 1 | /* Every capped tool result exposes its scroll range without requiring… | README, Why tool rows read this way |
| `message-part.css:1827` | 1 | /* 240px shows a dozen lines of output before the reader has to scroll… | README, Why tool rows read this way |
| `message-part.tsx:134` | 1 | /** Total error-severity diagnostics before the cap was applied. */ | deleted: the name, type or signature says it |
| `message-part.tsx:218` | 6 | /** * Turn-level abort signal supplied by the timeline. SDK-runtime ha… | README, Why tool rows read this way |
| `message-part.tsx:278` | 6 | /** * Every renderer below is registered under exactly one 'part.type'… | README, Other shapes |
| `message-part.tsx:408` | 1 | /** Secondary 'key=value' chips, shown after the subtitle. */ | deleted: the name, type or signature says it |
| `message-part.tsx:735` | 1 | /** Folds a settled turn's machinery behind one "Worked for Xs" divide… | deleted: the name, type or signature says it |
| `message-part.tsx:926` | 5 | /** * A run of read/list/glob/grep folded to one "Explored" line. 'par… | README, Why grouping and the fold work this way |
| `message-part.tsx:1014` | 7 | /** * WorkGroup — generalizes ContextToolGroup for a run of anything t… | README, Why grouping and the fold work this way |
| `message-part.tsx:1024` | 1 | /** A member row is open: the list grows to fit it instead of scrollin… | README, Why grouping and the fold work this way |
| `message-part.tsx:1041` | 1 | // Stay active between members until execution moves past this group. | README, Why grouping and the fold work this way |
| `message-part.tsx:1518` | 2 | // The child registry owns whether delegation happened. A wrapper can … | README, Why tool rows read this way |
| `message-part.tsx:1524` | 1 | /** The failure text of an errored tool call. */ | deleted: the name, type or signature says it |
| `message-part.tsx:1530` | 1 | /** When the call began. A pending call has not started, so it has no … | deleted: the name, type or signature says it |
| `message-part.tsx:1540` | 6 | /** * A pending call has not run, so it carries no metadata at all -- … | README, Why tool rows read this way |
| `message-part.tsx:1551` | 1 | /** Output exists only once the call completes; every earlier status h… | README, Why tool rows read this way |
| `message-part.tsx:1556` | 1 | /** Like 'output', the contract carries attachments only on a complete… | README, Why tool rows read this way |
| `message-part.tsx:1578` | 1 | /** An explicit first-party server identity takes precedence over bare… | README, Why first-party tool rows read this way |
| `message-part.tsx:1580` | 1 | /** What a refused first-party call was about, for the error card's su… | deleted: the name, type or signature says it |
| `message-part.tsx:1842` | 5 | /** * Opens an image in the full-view dialog. 'show' resolves when Sol… | deleted: the name, type or signature says it |
| `message-part.tsx:1922` | 8 | /** * The images a tool call produced. Every adapter harvests an image… | README, Why tool rows read this way |
| `message-part.tsx:2000` | 2 | // part.url is tool/agent output — a rejected scheme renders the label… | README, Why tool rows read this way |
| `message-part.tsx:2054` | 1 | // The registered name, not props.tool: an alias ('read_file') renders… | README, Why tool rows read this way |
| `message-part.tsx:2150` | 2 | // input.url is the tool call's argument — a rejected scheme renders t… | README, Why tool rows read this way |
| `message-part.tsx:2244` | 2 | // Row reads "Ran <command>" — verb + the real command, not a static "… | README, Why tool rows read this way |
| `message-part.tsx:2256` | 2 | // Dev-server preview row: surface a "Local preview · 127.0.0.1:port" … | README, Why tool rows read this way |
| `message-part.tsx:2284` | 4 | /* Keep the command in the header while running and while expanded — t… | README, Why tool rows read this way |
| `message-part.tsx:2485` | 1 | /* <DiffChanges diff={diff} /> */ | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `message-part.tsx:2797` | 2 | // Claude's dynamic-tool lane persists the skill id on 'input.skill'; … | README, Why tool rows read this way |
| `message-part.tsx:2815` | 2 | // A completed skill whose frame carried no output still names its cal… | README, Why tool rows read this way |
| `message-part.tsx:2889` | 9 | /** * Harness tool-name aliases. The registry above uses OpenCode's vo… | README, Why tool rows read this way |
| `part-groups.ts:10` | 4 | /** * How a run of work rows is categorised for group identity. Nothin… | deleted: the name, type or signature says it |
| `part-groups.ts:41` | 5 | /* * Canonical spellings only. Harness variants ('command', 'read_file… | README, Why grouping and the fold work this way |
| `part-groups.ts:48` | 5 | /** * Tools that address the reader rather than doing work on their be… | README, Why tool rows read this way |
| `part-groups.ts:61` | 1 | /** A tool whose call renders no row, in whichever spelling the harnes… | deleted: the name, type or signature says it |
| `part-groups.ts:66` | 6 | /** * A context group is collapsed until a reader opens it, and it sum… | README, Why grouping and the fold work this way |
| `part-groups.ts:82` | 4 | /** * A question renders nothing until it is answered, so until then i… | README, Why tool rows read this way |
| `part-groups.ts:97` | 5 | /** * Work is everything the agent did that is not context-gathering, … | README, Why grouping and the fold work this way |
| `part-groups.ts:108` | 5 | /** * A call to Claxedo's own MCP, in whichever spelling the harness g… | README, Why first-party tool rows read this way |
| `part-groups.ts:118` | 5 | /** * A tool part that is a subagent spawn. The name is the primary si… | README, Why grouping and the fold work this way |
| `part-groups.ts:130` | 5 | /** * A failed spawn stays individually renderable so it can show the … | README, Why grouping and the fold work this way |
| `part-groups.ts:139` | 1 | /** The parts a subagent chip can hang on — a spawn row in the transcr… | deleted: the name, type or signature says it |
| `part-groups.ts:154` | 6 | /** * Consecutive context tools fold into a context group at any lengt… | README, Why grouping and the fold work this way |
| `part-groups.ts:211` | 1 | // A lone spawn makes an agents group too: the chip row is the only sh… | README, Why grouping and the fold work this way |
| `plan-tool.ts:6` | 5 | /** * Claude's 'ExitPlanMode' sends '{plan, planFilePath}'. The file l… | README, Why tool rows read this way |
| `plan-tool.ts:33` | 1 | /** True when a host surface took the plan; an unhandled event leaves … | README, Why tool rows read this way |
| `question-card.tsx:8` | 1 | /** The reader typed this rather than picking a declared option. */ | deleted: the name, type or signature says it |
| `question-result.ts:3` | 5 | /** * Whether a 'question' tool's error is the user declining rather t… | README, Why tool rows read this way |
| `review-code-view-items.ts:13` | 1 | /** Files whose body the caller supplies instead of a parsed text diff… | deleted: the name, type or signature says it |
| `review-code-view-items.ts:15` | 6 | /** * A file's comment annotations. Read for every file, not just rend… | README, Why the Review code view works this way |
| `review-code-view-items.ts:24` | 1 | /** Retain parsed content for the current document, independently of r… | README, Why the Review code view works this way |
| `review-code-view-items.ts:55` | 2 | // Copy the fields: callers can supply reactive store proxies whose va… | README, Why the Review code view works this way |
| `review-code-view.tsx:1` | 15 | /** * ReviewCodeView — the Review surface boundary around Pierre's Cod… | README, Why the Review code view works this way |
| `review-code-view.tsx:32` | 4 | // CodeView never measures a collapsed file: its height IS 'diffHeader… | README, Why the Review code view works this way |
| `review-code-view.tsx:48` | 5 | /** * One file's comment UI. Built on first use and released when the … | README, Why the Review code view works this way |
| `review-code-view.tsx:61` | 6 | /** * A file's annotations. Data only — this is read for every file in… | README, Why the Review code view works this way |
| `review-code-view.tsx:68` | 5 | /** * The file's comment owner. Only ever called from inside a render,… | README, Why the Review code view works this way |
| `review-code-view.tsx:74` | 4 | /** * The expanded files Pierre paints right now. Every other owner ca… | README, Why the Review code view works this way |
| `review-code-view.tsx:84` | 1 | /** Expanded file paths; every other file renders collapsed. */ | deleted: the name, type or signature says it |
| `review-code-view.tsx:87` | 8 | /** * Header row content for a file (the accordion trigger-content mar… | README, Why the Review code view works this way |
| `review-code-view.tsx:96` | 1 | /** Test id for the header trigger button. */ | deleted: the name, type or signature says it |
| `review-code-view.tsx:98` | 1 | /** File whose header row shows the selected highlight. */ | deleted: the name, type or signature says it |
| `review-code-view.tsx:100` | 1 | /** Receives the live scroll element for scroll capture/restoration. *… | deleted: the name, type or signature says it |
| `review-code-view.tsx:102` | 6 | /** * Receives a reader for where a file sits in the document, in the … | README, Why the Review code view works this way |
| `review-code-view.tsx:109` | 10 | /** * Somewhere to bring into view, held until the engine can actually… | README, Why the Review code view works this way |
| `review-code-view.tsx:121` | 10 | /** * Native scroll events from the scroll element. * * Typed as Solid… | README, Why the Review code view works this way |
| `review-code-view.tsx:132` | 1 | /** Fired after CodeView commits a render pass with visible content. *… | deleted: the name, type or signature says it |
| `review-code-view.tsx:134` | 1 | /** Current rendered files first, followed by nearby content prefetch … | deleted: the name, type or signature says it |
| `review-code-view.tsx:136` | 1 | /** Files whose body is supplied by the caller, without parsing a text… | deleted: the name, type or signature says it |
| `review-code-view.tsx:138` | 1 | /** Loading, error, or other custom body; mounted only while Pierre re… | deleted: the name, type or signature says it |
| `review-code-view.tsx:140` | 1 | /** Line comments, selection and the gutter utility. Omit to render re… | deleted: the name, type or signature says it |
| `review-code-view.tsx:142` | 4 | /** * The selection the caller considers current. CodeView runs in con… | README, Why the Review code view works this way |
| `review-code-view.tsx:150` | 5 | /** * Somewhere to bring into view. A file alone resolves as soon as t… | README, Why the Review code view works this way |
| `review-code-view.tsx:161` | 5 | /** * The event shape Solid's scroll handlers receive. Derived from 'J… | README, Why the Review code view works this way |
| `review-code-view.tsx:168` | 8 | /** * Check the handler contract instead of asserting it. * * DOM list… | README, Why the Review code view works this way |
| `review-code-view.tsx:189` | 9 | /** * Which header row shows its hover-only controls. * * Armed by poi… | README, Why the Review code view works this way |
| `review-code-view.tsx:204` | 4 | // Per-file light-DOM hosts for the engine's custom-header slots. The … | README, Why the Review code view works this way |
| `review-code-view.tsx:241` | 5 | /** * Light-DOM review identities on CodeView's rendered item containe… | README, Why the Review code view works this way |
| `review-code-view.tsx:258` | 3 | // A custom element defaults to display:inline, which computes a zero … | README, Why the Review code view works this way |
| `review-code-view.tsx:274` | 7 | /** * Apply a held target, and report it only if the engine took it. *… | README, Why the Review code view works this way |
| `review-code-view.tsx:290` | 4 | // Compared by reference, not by value: a target stays published until… | README, Why the Review code view works this way |
| `review-code-view.tsx:330` | 2 | // Comment wiring is fixed for this mount: it decides which slot rende… | README, Why the Review code view works this way |
| `review-code-view.tsx:334` | 3 | // The app's one Pierre style owner: the OpenCode theme, the shared //… | README, Why the Review code view works this way |
| `review-code-view.tsx:338` | 2 | // Long lines scroll inside their own row rather than wrapping, and a … | README, Why the Review code view works this way |
| `review-code-view.tsx:342` | 5 | // 'none' for BOTH diff styles, because this option has to agree with … | README, Why the Review code view works this way |
| `review-code-view.tsx:348` | 4 | // createDefaultOptions turns the file header off for the inline viewe… | README, Why the Review code view works this way |
| `review-code-view.tsx:354` | 2 | // The engine's own 8px gap and document padding read as loose next to… | README, Why the Review code view works this way |
| `review-code-view.tsx:359` | 4 | // Keyed by the item id, never 'fileDiff.name': Pierre names a parsed … | README, Why the Review code view works this way |
| `review-code-view.tsx:370` | 2 | // The app's store is the one selection anyone reads; leaving the // e… | README, Why the Review code view works this way |
| `review-code-view.tsx:383` | 2 | // The engine types the hovered row by its own mode; only the // side-… | deleted: the name, type or signature says it |
| `review-code-view.tsx:400` | 7 | // NOT container-managed: the managed mode is the React wrapper's port… | README, Why the Review code view works this way |
| `review-code-view.tsx:424` | 2 | // A collapsed row is a header; it paints no lines, so it owns no // a… | README, Why the Review code view works this way |
| `review-code-view.tsx:432` | 3 | // setItems queues its own pass; this one is synchronous because 'tryR… | README, Why the Review code view works this way |
| `review-code-view.tsx:439` | 3 | // CodeView.setup owns this root's scrolling and ResizeObserver. Its n… | README, Why the Review code view works this way |
| `review-code-view.tsx:446` | 2 | // The row under the pointer just changed without a pointer event, so … | README, Why the Review code view works this way |
| `review-code-view.tsx:475` | 4 | // setItems queues its own pass, which is all an ordinary content arri… | README, Why the Review code view works this way |
| `review-code-view.tsx:487` | 2 | // Only a surface with comment wiring has a selection to own; a read-o… | README, Why the Review code view works this way |
| `review-code-view.tsx:502` | 2 | // setOptions replaces the complete options object, including callback… | README, Why the Review code view works this way |
| `safe-link.ts:1` | 8 | /** * A caller-supplied href checked against the card-link scheme poli… | README, Why links carry a scheme policy |
| `safe-link.ts:13` | 6 | /** * Absolute schemes a host can hand to a browser or OS open path — … | README, Why links carry a scheme policy |
| `safe-link.ts:25` | 2 | // A second separator — "//host", "/\host" — rebases the URL onto that… | README, Why links carry a scheme policy |
| `scrollable-output.tsx:4` | 1 | /** Whether the box holds more than its cap shows; a revealed box keep… | deleted: the name, type or signature says it |
| `scrollable-output.tsx:9` | 5 | /** * A tool's output inside a capped, scrolling box, with a control t… | README, Why tool rows read this way |
| `scrollable-output.tsx:20` | 1 | /** Controlled expansion — callers pass it so the state outlives a vir… | README, Why tool rows read this way |
| `scrollable-output.tsx:76` | 7 | // Lifting the cap deletes this box's own scroll range, so the line //… | README, Why tool rows read this way |
| `scrollable-output.tsx:94` | 4 | // Re-assert across the next few frames: the list's own resize and // … | README, Why tool rows read this way |
| `scrollable-output.tsx:105` | 3 | // A pointerdown beyond the content box is the scrollbar itself — // a… | README, Why tool rows read this way |
| `session-diff.ts:3` | 3 | // The parsed-diff contract downstream surfaces program against. Re-ex… | deleted: history, a section banner, commented-out code or a file-layout note; no constraint |
| `session-diff.ts:24` | 4 | /** * Serial for the 'cacheKey' stamped on every resolved diff, minted… | deleted: the name, type or signature says it |
| `session-diff.ts:30` | 26 | /** * Parse one review/tool diff into the metadata '@pierre/diffs' ren… | README, Why the file and diff viewers work this way |
| `session-diff.ts:72` | 6 | /** * Exact content identity of a diff source, so no two different sou… | README, Why the file and diff viewers work this way |
| `session-diff.ts:104` | 2 | /** A diff's text for one side. Parsed content is all this needs, so a… | deleted: the name, type or signature says it |
| `session-diff.ts:122` | 1 | // Snapshot and VCS producers request full context. Tool patches use j… | README, Why the file and diff viewers work this way |
| `session-diff.ts:126` | 1 | // Full patches collapse into one leading hunk. Separated hunks omit r… | README, Why the file and diff viewers work this way |
| `session-review.css:13` | 3 | /* One flex line: icon, directory, filename, actions. The directory an… | README, Why the Review code view works this way |
| `session-review.css:28` | 7 | /* Both spans truncate from the START — the tail of a path identifies … | README, Why the Review code view works this way |
| `session-review.css:83` | 4 | /* Positioning parent for the hover control cluster, and wide enough t… | README, Why the Review code view works this way |
| `session-review.css:108` | 2 | /* Keep controls out of flow. A mount animation would override opacity… | README, Why the Review code view works this way |
| `session-review.css:122` | 1 | /* Explicit hover clears on scroll; focus keeps keyboard controls avai… | README, Why the Review code view works this way |
| `session-review.css:165` | 3 | /* Calmer, denser change counts in the file list: muted + tabular at r… | README, Why the Review code view works this way |
| `session-turn.css:66` | 3 | /* Nothing for the first 100ms: a full read that lands within that win… | README, Why turn-body loading looks this way |
| `shell-wrapper.ts:9` | 6 | /** * Harnesses run shell tools through a login-shell wrapper — Codex … | README, Why tool rows read this way |
| `subagent-chip.css:1` | 1 | /* Delegated work as glyph pills, one per subagent. */ | deleted: the name, type or signature says it |
| `subagent-chip.css:28` | 2 | /* Shrink weights are scaled by each slot's width, so the summary and … | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.css:43` | 2 | /* The configuration and model sit beside the name at the summary's si… | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:11` | 8 | /** * The one line under a subagent's name. 'description' is whatever … | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:28` | 5 | /** * One row of delegated work: a deterministic glyph, the agent's na… | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:37` | 1 | /** What the child runs: its configuration slot or harness, model and … | deleted: the name, type or signature says it |
| `subagent-chip.tsx:51` | 1 | /** The agent's name, so the surface that opens the transcript can tit… | deleted: the name, type or signature says it |
| `subagent-chip.tsx:53` | 1 | /** The row's one-line summary, for that surface's header. */ | deleted: the name, type or signature says it |
| `subagent-chip.tsx:71` | 7 | /** * What a spawn asked the child to run, read from the spawn call's … | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:102` | 7 | /** * One chip per row. The same subagent resolves from more than one … | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:119` | 5 | /** * An interaction row is not its own transcript — it reports a mess… | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:149` | 6 | /** * A chip the surface gave a session href to is an anchor, so cmd/m… | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:159` | 6 | /** * Where a click goes once neither the scroll-to-spawn nor the surr… | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:178` | 1 | /** The spawn input behind 'subagents', when the caller holds it rathe… | deleted: the name, type or signature says it |
| `subagent-chip.tsx:227` | 2 | // An interaction row is a pointer back into this transcript, not a //… | README, Why subagent chips work this way; case `subagent-chip` |
| `subagent-chip.tsx:254` | 4 | // No surface claimed the open — a standalone reader, where following … | README, Why subagent chips work this way; case `subagent-chip` |
| `tool-error-card.css:30` | 3 | /* The dim end of the critical ramp, the same step 'success' and 'info… | README, Why tool rows read this way; case `failed-turn` |
| `tool-error-card.tsx:64` | 1 | /** The subtitle link a caller supplied, dropped unless it survives th… | README, Why links carry a scheme policy; case `failed-turn` |
| `tool-error-card.tsx:83` | 6 | /** * With no subtitle given, the text before the first ": " has becom… | README, Why tool rows read this way; case `failed-turn` |
| `transcript-link.ts:7` | 1 | /** Not 'transcriptLinkRunSource': an exact match ends at a paren, a r… | README, Why markdown renders this way |
| `transcript-link.ts:14` | 5 | /** * The href for a value that is meant to BE a link — a markdown cod… | README, Why markdown renders this way |
| `transcript-link.ts:26` | 1 | /** Distinct links embedded in prose or tool output, in the order they… | deleted: the name, type or signature says it |
| `transcript-link.ts:37` | 6 | /** * Hands the link to whatever surface is hosting the transcript. A … | README, Why markdown renders this way |
| `transcript-link.ts:56` | 4 | // A target the sanitizer would refuse never reaches default navigatio… | README, Why markdown renders this way |
| `turn-fold.ts:4` | 4 | /** * Resolves a group member to the part it renders: a group carries … | deleted: the name, type or signature says it |
| `turn-fold.ts:12` | 3 | // A single tool is already one compact, useful row: folding it replac… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:23` | 8 | /** * The turn's answer: its last text group. No harness marks which t… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:35` | 4 | /** * Machinery — everything a turn did that is not its answer: tool r… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:54` | 1 | /** Some assistant message of the turn completed or failed. Per messag… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:58` | 1 | /** The session is mid-turn on THIS turn. */ | deleted: the name, type or signature says it |
| `turn-fold.ts:60` | 4 | /** * The parts held are a first-paint subset of the turn (the 'latest… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:65` | 1 | /** Folding a settled turn is the product rule, so omitting this opts … | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:67` | 1 | /** An explicit user toggle. 'undefined' leaves the turn on auto. */ | deleted: the name, type or signature says it |
| `turn-fold.ts:74` | 1 | /** The reader folded this turn themselves, rather than it folding on … | deleted: the name, type or signature says it |
| `turn-fold.ts:78` | 20 | /** * A finished turn folds its machinery behind one "Worked for Xs" d… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:113` | 6 | /** * The groups the fold hides, keyed by 'PartGroup.key'. * * A reade… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `turn-fold.ts:133` | 2 | // An automatic fold must not take a row the reader opened themselves;… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group-summary.ts:14` | 1 | /** Members no named bucket claims, in order, so the summary can still… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group-summary.ts:52` | 1 | /** How a row names one call: the action its name reads as, or the nam… | deleted: the name, type or signature says it |
| `work-group-summary.ts:57` | 5 | /** * The members the named buckets leave over. A single call is named… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group-summary.ts:72` | 2 | // A run of one tool counts by that tool: a pluralizable name keeps th… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group-summary.ts:82` | 2 | // Segmented summary: present-continuous while running, past tense whe… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group-summary.ts:104` | 5 | /** * "active" header kind: while a member is still running, the group… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group-summary.ts:112` | 2 | // 'busy' belongs to the trailing group of the active turn. A complete… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group.css:1` | 5 | /* * WorkGroup (T4) — collapsed run of bash/edit/write/apply_patch/web… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group.css:15` | 2 | /* Same uniform dim + 14px icon as the tool rows, so a group header an… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group.css:78` | 2 | /* An open member (a diff, a file, an output) is read in place: the ca… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
| `work-group.css:85` | 1 | /* Edge fades only when the body actually overflows (data-overflowing)… | README, Why grouping and the fold work this way; case `worked-turn-folds` |
