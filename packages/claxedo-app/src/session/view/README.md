# Session screen

The pane that shows one session: the moved timeline (`timeline/`, owned by the transcript rules), the docks, and the composer (`@/composer`). It reads one `SessionView` from `useSessionStores().open(ref)` and never fetches or caches session data itself.

## Exports (`index.ts`)

- `sessionPaneKind`: pane kind `session`, state `SessionRef`, routed at `/w/:placementId/session/:sessionId`.
- `draftSessionPaneKind`: pane kind `draftSession`, state `{ projectId, placementId }`, routed at `/w/:placementId/session`. A workspace has one draft, as in today's app: New Session, the landing and a reload all show the same draft with its unsent text (the composer keys it `draft:<placementId>`). Its composer's first send is one request: `SessionList.create` carries the harness, the model and the prompt, and the runtime creates the session and admits the prompt together. The draft draws the sent message at once with the timeline's own `TimelineUserMessage` (`SentMessage`), under the message id the create sends; on the answer it opens the session, shows the same message there (`showSent`), and replaces its own pane with the `session` pane once that view has loaded, so the message never leaves the screen. A refused create leaves no session; the draft drops the message and the composer gets the text back.

## Owned concepts

| Concept | Home |
| --- | --- |
| The screen's load states: loading (placeholder after 150 ms), missing, failed with retry, ready. While the session loads, the screen holds the workbench's reveal, so a switch keeps the previous session on screen instead of the placeholder | `session-screen.tsx`, from `SessionView.state` |
| The first view: the session shows as soon as the first page its first read answered is laid out, bottom-anchored at the end of the view where it stays. The nav rail lists the session's turns from its outline (`SessionView.outline`, which arrives with that read) merged with the loaded user messages (`nav-turns.ts`), so it shows in the frame the outline lands, above ten turns, with no older page read before the first paint. After it nothing is read and nothing moves until the reader acts: a scroll within one screen of the top, a pull or a pick pages the turns before the oldest loaded one in above the prepend anchor, so no painted row moves. Until the latest turn is ready a pane with nothing to hand over shows the transcript placeholder | `nav-turns.ts`, `session-timeline.tsx`, `timeline/message-timeline.tsx` |
| Subagent placement: a subagent with a tool-call edge renders as a chip on that call's part once the turn holding the part is loaded, and is never background; a subagent with no edge draws in Background subagents from the first paint | `subagent-views.ts` |
| The `TimelineHost` the moved timeline reads | `timeline-host.ts` |
| Following the end of a streaming turn, the jump button state, message selection from the nav rail, paging older history | `auto-scroll.ts`, `timeline-scroll.ts`, `history-paging.ts`, `scroll-anchor.ts` |
| Which dock shows: the first open request (permission or question), the goal, the todo list. The todo list shows only while a turn runs and the list is unfinished, so a finished list goes away (the owner's rule; today's app keeps it). Its collapsed state is kept per session in sessionStorage: it survives a reload and nothing longer. While a request is open the todo list and the composer are hidden, as today, but stay mounted, so a request dock mounts and leaves alone; the hidden composer offers no palette commands and takes no dropped files. The todo list's lift under the composer is its own negative bottom margin (`session-screen.css`), none when floating | `session-docks.tsx`, `docks/`, `session-screen.tsx` |
| Floating over a maximized workspace panel, as today: while `usePanel().maximized()` holds, the focused session pane goes transparent and keeps a bottom card: "N previous messages" (shown once the session has a message) peeks the transcript open (collapsed by default, opened by a send or a turn from elsewhere), and the composer folds to one row while idle and blank. The column carries `data-floating-host`, so the app shell's rules lift it above the panel and hide every other pane | `session-screen.tsx`, `floating-peek.ts`, `session-floating.css` |
| Editing a queued prompt: the held record's text is loaded into the composer; sending it cancels the held record | `queue-edit.ts` |
| A stopped cloud workspace above the composer (`WorkspaceSleepCard`): while the catalog says the session's cloud sandbox is stopped (`isStoppedCloud`), the transcript reads from the control plane and a card above the composer says the next message wakes it; the composer stays, and its send is not gated on a harness it cannot read (`workspaceAsleep`). The card draws `server.cloud.runtime(placementId)`: asleep, then "Waking up the workspace…" with the server's boot mode (restore or resume) while the send wakes the sandbox, and the message is sent once it is up; a refused wake shows "Couldn't wake the workspace." with the server's reason and Try again, and the draft stays in the composer. Nothing on these screens wakes a sandbox but a send (DECISIONS, owner 16:20) | `workspace-sleep/` |
| The old-kit contexts the moved renderers still read (`DialogProvider`, `MarkedProvider`, `FileComponentProvider`) | `TranscriptKitProviders` from `@/transcript`, until the transcript swaps them for v2 twins |

## State machines

- **Request reply**: the session store owns it, and the permission and question docks only read it (`SessionView.requestState`): `open → answering → answered | failed(error)`, and a failed reply can be sent again. A failed reply therefore re-enables its dock and shows the error, instead of leaving every button disabled.
- **Dock action** (`docks/model.ts`): `idle → running(action) → idle | failed(action, error)`, for stop and the goal's pause, resume and remove.
- The screen's load state is the store's `SessionLoadState`; the send machine is the composer's.

## Keys

- The screen's document keydown (`session-screen-keydown.ts`, classified by `session-keydown.ts`) leaves alone any key aimed at an editable element or inside `[data-prevent-autofocus]`, including inside shadow roots, and any key while a dialog is open. Escape in the composer blurs it. PageUp, PageDown, Home and End count as a reader's scroll gesture. A printable key without Ctrl or Meta focuses the composer and puts the caret back where the prompt store says it was, because the blur may have destroyed the DOM selection when the editor re-rendered.

## Placeholders

- The transcript's loading placeholder (`session-timeline-skeleton.tsx`) borrows the timeline's geometry instead of inventing one: `TimelineRowFrame`'s centred column and breakpoints, the `px-4 md:px-5` row padding, the 24 px assistant offset, and the user bubble's chrome (the real bubble is `fit-content`, at most `min(82%, 64ch)`). It anchors to the bottom as a restored conversation does, so the real messages land where it sat instead of the view jumping when they arrive, and its top dissolves under a mask so it reads as the tail of a conversation rather than a card floating in empty space.
- The todo dock hides its list with `visibility: hidden` and otherwise leaves `visibility` unset, never `visible`: an explicit value would override the hidden a docked pane inherits under the full-view panel.

## Following the end

- The timeline follows the end only while a turn is active (`turnActive(status)`) or for 300 ms after it ends, so the finished turn's trailing layout still lands at the bottom.
- The browser can deliver a scroll event after our own `scrollTop` write; a scroll that lands within 2 px of our last write inside 1.5 s is ours, not the reader's.
- A wheel or swipe inside a nested scroller (`[data-scrollable]`) never counts as leaving the end.
- The resize observer watches the scroller as well as the content: the viewport's own height moves the bottom as much as the content does, and a transient viewport change (a dock line appearing and going) would otherwise strand the reader one line above the end.
- A selected text range or a click during the settle window stops following.
- An older page (the turns before the oldest loaded one, as tall as the first page) loads when the reader scrolls within one screen of the top, or pulls at the top of a list too short to scroll; the timeline's prepend anchor keeps the reader's row in place.
- A message picked from the nav rail, a `#message-` link or mod+arrow is loaded before it is sought: older pages load until its turn is in the transcript (`history-paging.ts`, the prepend anchor holding the reader's row meanwhile), and a turn no page brings ends the pick. A resume, another pick, a view change or the view unmounting stops a pick before its next page (`turn-pick.ts`). A failed page ends that pick; the next pick, scroll or pull asks again. Then it is sought, not scrolled to once: the first scroll lands on the virtualizer's estimate for unmeasured rows, so the seek scrolls again every second frame (at most 30 times) until the row's top is in the viewport. The first step always scrolls, because a row can report itself in view before the jump that brings it there.
- The moved timeline still renders the old kit's ScrollView; `transcript-kit.css` carries that view's layout, scoped to the session screen, until the transcript swaps it for the v2 twin.

## Flows

## Subagent panel tab

A subagent opens as a workspace-panel tab (`subagent-panel.tsx`), registered in the shell's `panelViews`: the child's session read-only, with its docks and the "cannot be prompted" notice but no composer or keys. The tab's parent is the session holding the pane, so a subagent opened from inside the tab stays visible. On open, focus moves to the child's heading; the heading only exists once the child's first messages render, so the panel retries each frame for 30 frames and a newer open cancels an older wait.

Flows 3 (send a turn), 4 (stop, queue, reload mid-turn), 5 (errors by class), 6 (composer), 7 (goal mode), 8 (permissions and questions), 9 (subagents), 11 (long transcript); 3, 6 and 8 run in the phone project too.
