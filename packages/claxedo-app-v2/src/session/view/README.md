# Session screen

The pane that shows one session: the moved timeline (`timeline/`, owned by the transcript rules), the docks, and the composer (`@/composer`). It reads one `SessionView` from `useSessionStores().open(ref)` and never fetches or caches session data itself.

## Exports (`index.ts`)

- `sessionPaneKind`: pane kind `session`, state `SessionRef`, routed at `/w/:placementId/session/:sessionId`.
- `draftSessionPaneKind`: pane kind `draftSession`, state `{ projectId, placementId }`, routed at `/w/:placementId/session`. A workspace has one draft, as in today's app: New Session, the landing and a reload all show the same draft with its unsent text (the composer keys it `draft:<placementId>`). Its composer creates the session on the first send (`SessionList.create`, with the harness and model chosen in the draft), sends, and then replaces its own pane with a `session` pane (`useWorkbench().replacePane`).

## Owned concepts

| Concept | Home |
| --- | --- |
| The screen's load states: loading (placeholder after 150 ms), missing, failed with retry, ready | `session-screen.tsx`, from `SessionView.state` |
| The `TimelineHost` the moved timeline reads | `timeline-host.ts` |
| Following the end of a streaming turn, the jump button state, message selection from the nav rail, paging older history | `auto-scroll.ts`, `timeline-scroll.ts`, `history-paging.ts`, `scroll-anchor.ts` |
| Which dock shows: the first open request (permission or question), the goal, the todo list. The todo list shows only while a turn runs and the list is unfinished, so a finished list goes away (the owner's rule; today's app keeps it). Its collapsed state is kept per session in sessionStorage: it survives a reload and nothing longer | `session-docks.tsx`, `docks/` |
| Floating over a maximized workspace panel, as today: while `usePanel().maximized()` holds, the focused session pane goes transparent and keeps a bottom card: "N previous messages" peeks the transcript open (collapsed by default, opened by a send or a turn from elsewhere), and the composer folds to one row while idle and blank. The column carries `data-floating-host`, so the app shell's rules lift it above the panel and hide every other pane | `session-screen.tsx`, `floating-peek.ts`, `session-floating.css` |
| Editing a queued prompt: the held record's text is loaded into the composer; sending it cancels the held record | `queue-edit.ts` |
| The old-kit contexts the moved renderers still read (`DialogProvider`, `MarkedProvider`, `FileComponentProvider`) | `TranscriptKitProviders` from `@/transcript`, until the transcript swaps them for v2 twins |

## State machines

- **Request reply**: the session store owns it, and the permission and question docks only read it (`SessionView.requestState`): `open → answering → answered | failed(error)`, and a failed reply can be sent again. A failed reply therefore re-enables its dock and shows the error, instead of leaving every button disabled.
- **Dock action** (`docks/model.ts`): `idle → running(action) → idle | failed(action, error)`, for stop and the goal's pause, resume and remove.
- The screen's load state is the store's `SessionLoadState`; the send machine is the composer's.

## Following the end

- The timeline follows the end only while a turn is active (`turnActive(status)`) or for 300 ms after it ends, so the finished turn's trailing layout still lands at the bottom.
- The browser can deliver a scroll event after our own `scrollTop` write; a scroll that lands within 2 px of our last write inside 1.5 s is ours, not the reader's.
- A wheel or swipe inside a nested scroller (`[data-scrollable]`) never counts as leaving the end.
- The resize observer watches the scroller as well as the content: the viewport's own height moves the bottom as much as the content does, and a transient viewport change (a dock line appearing and going) would otherwise strand the reader one line above the end.
- A selected text range or a click during the settle window stops following.
- Older pages load when the reader scrolls within 200 px of the top, or pulls at the top of a list too short to scroll; the timeline's prepend anchor keeps the reader's row in place.
- A message picked from the nav rail is sought, not scrolled to once: the first scroll lands on the virtualizer's estimate for unmeasured rows, so the seek scrolls again every second frame (at most 30 times) until the row's top is in the viewport. The first step always scrolls, because a row can report itself in view before the jump that brings it there.
- The moved timeline still renders the old kit's ScrollView; `transcript-kit.css` carries that view's layout, scoped to the session screen, until the transcript swaps it for the v2 twin.

## Flows

Flows 3 (send a turn), 4 (stop, queue, reload mid-turn), 5 (errors by class), 6 (composer), 7 (goal mode), 8 (permissions and questions), 9 (subagents), 11 (long transcript); 3, 6 and 8 run in the phone project too.
