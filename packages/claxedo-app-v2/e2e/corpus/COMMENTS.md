# Comment triage

Every comment in the moved transcript and timeline was read before it was stripped. Each one ends in a corpus case (when it encodes a rendering behavior), in its domain README (the why: a constraint, a failure mode, a measured number, an ordering), or is deleted because the code already says it or it only recorded history. A README outcome names the section that now carries it; a case outcome names the case that renders the behavior.

Line numbers are the comment's first line before the strip. A block of consecutive `//` lines is one row; `Lines` is how many source lines it spanned.

## Timeline (`src/session/view/timeline`, at `43466d8ee6`)

No case renders an interrupted turn: the ACP harness finalizes a cancelled prompt as `completed` (`finalizeAuthoredTurn` in `agent-sdk-runtime/src/harnesses/acp/turn-runner.ts`), so the scripted agent cannot produce the interrupted divider in either app. Those comments are carried by the README alone.

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
| `message-nav-deferred-mount.ts:41` | 2 | // Idle readiness is optional presentation state. Keep its latest valu… | README, Why the rail and gutter work this way |
| `message-nav-gutter.css:1` | 18 | /* * The compact rail reaches 48px into the pane ('left-3' plus its 36… | README, Why the rail and gutter work this way |
| `message-nav-layout.ts:22` | 4 | // Decide the gutter BEFORE first paint: the observer's initial callba… | README, Why the rail and gutter work this way |
| `message-timeline-list-gestures.ts:4` | 4 | /** * The scroller a gesture belongs to: 'root' unless the event start… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:39` | 6 | /** * The timeline list's wheel, touch, pointer and scroll handlers. *… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:103` | 4 | // A pointer press on a control is an action, not a scroll gesture. Ex… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:113` | 1 | // Drag-to-select starts on a child node, not the list — mark it so au… | README, Why gestures work this way |
| `message-timeline-list-gestures.ts:124` | 1 | // The virtualizer and resizeItem re-anchor own bottom-following. | README, Why gestures work this way |
| `message-timeline-observe-offset.ts:29` | 14 | // Ported from upstream packages/app/src/pages/session/timeline/observ… | README, Why scrolling works this way |
| `message-timeline-observe-offset.ts:106` | 5 | // The observer has to live at the persistent route root so it can see… | README, Why scrolling works this way |
| `message-timeline-observe-offset.ts:131` | 1 | // Session routes are replaced below persistent main; body is the fall… | README, Why scrolling works this way |
| `message-timeline-turn-rows.tsx:1` | 5 | // Standalone presentational rows for the message timeline: the thinki… | deleted: history, a plan reference or a file-layout note; no constraint |
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
| `message-timeline.tsx:101` | 1 | // Keep parity with the upstream session row model. | deleted: history, a plan reference or a file-layout note; no constraint |
| `message-timeline.tsx:117` | 10 | /** * A tag-narrowed view of the row accessor, seeded with the row the… | README, Invariants (already stated there) |
| `message-timeline.tsx:166` | 2 | // A reveal click resizes the row at the reader's position; the gestur… | README, Why scrolling works this way |
| `message-timeline.tsx:174` | 2 | // A subagent's transcript is a workspace-panel tab, not a second pane… | README, Why links and files open this way |
| `message-timeline.tsx:189` | 3 | // Shared with the terminal's file links (timeline-file-paths.ts): // … | README, Invariants (already stated there) |
| `message-timeline.tsx:194` | 4 | // Open a file in the workspace side panel (same path terminal file li… | README, Why links and files open this way |
| `message-timeline.tsx:204` | 4 | // Path-kind inline-code chips in assistant markdown. Anchors are hand… | README, Why links and files open this way |
| `message-timeline.tsx:217` | 1 | // don't hijack a text-selection click | README, Why links and files open this way |
| `message-timeline.tsx:218` | 1 | // anchors → capture handler below | deleted: the name, type or signature says it |
| `message-timeline.tsx:239` | 1 | // Capture phase runs before the link's default action (see above). | README, Why links and files open this way |
| `message-timeline.tsx:242` | 3 | // One memo drives BOTH the rail's mount and 'data-session-timeline-na… | README, Why the rail and gutter work this way |
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
| `message-timeline.tsx:966` | 3 | // The predicate below used to claim 'AssistantMessage' for whatever /… | deleted: history, a plan reference or a file-layout note; no constraint |
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
| `timeline-file-context-menu.tsx:1` | 2 | // Pure overlay UI over injected callbacks: path resolution and panel … | deleted: history, a plan reference or a file-layout note; no constraint |
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
| `timeline-row-equality.ts:1` | 4 | // Identity-based equality gates for the per-message timeline row memo… | deleted: history, a plan reference or a file-layout note; no constraint |
| `timeline-row-equality.ts:8` | 3 | // Identity-based equality gates for the per-message row memos. Unchan… | README, Why the rows are built this way |
| `timeline-row-equality.ts:29` | 3 | // 'lastTurn' rides on the directory session-cache row, whose object i… | README, Why the rows are built this way |
| `timeline-row-model.ts:1` | 6 | // The message timeline's row model: the tagged TimelineRow union, its… | deleted: history, a plan reference or a file-layout note; no constraint |
| `timeline-row-model.ts:12` | 1 | /** Sits above the first rendered turn ('userMessageID') while 'count'… | deleted: the name, type or signature says it |
| `timeline-row-model.ts:36` | 1 | /** The turn's body is held back until its full read lands; drawn as a… | deleted: the name, type or signature says it |
| `timeline-row-model.ts:51` | 5 | /** * The human sentence for the row's PRIMARY line, composed here alo… | README, Why failed turns read this way |
| `timeline-row-model.ts:66` | 8 | /** * A constructor for one tagged row. * * Rows are plain frozen-shap… | README, Why the rows are built this way |
| `timeline-row-model.ts:98` | 6 | /** * 'SummaryDiff' is 'AgentSnapshotFileDiff & { file: string }', a c… | deleted: history, a plan reference or a file-layout note; no constraint |
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
