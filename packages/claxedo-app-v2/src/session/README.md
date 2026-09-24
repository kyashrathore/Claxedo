# Session data

## Reconcile rules of the session list

`src/session/list/transition.ts` is the one owner of rows, order and status in the rail. Nothing else fetches, caches or patches rows. These rules are the contract; a change here changes the transition and flow 31 in the same change.

1. **Subscribe, then fetch, holding events.** The stores subscribe to the server stream before the first list read. A `sessionUpserted`, `sessionRemoved` or `statusChanged` that arrives while a list read is in flight (`fetching`, `rereading`, or a `loadMore` page) is held and replayed on top of the response.
2. **The newer `updatedAt` wins.** A row is replaced only by a version whose `updatedAt` is not older. `lastHumanTurnAt` never moves backwards, because the server row can be written by a title change after the turn that ordered it.
3. **Tombstones.** A `sessionRemoved` leaves a tombstone keyed by the session id, timestamped at receipt. A list response or event that carries the row again is ignored while the tombstone stands. A response sent after the tombstone prunes it.
4. **A replay gap re-reads.** A `streamGap` re-reads the first page and the bulk statuses, replacing the window; rows outside the first page are dropped, except open sessions, and `loadMore` pages them back. A gap during a read is remembered and the re-read follows the read.
5. **Own create and send are pending entries keyed by `clientRequestId`.** A create shows a pending row (`pending: true`, a `pending:` session id) until the server's row confirms it or the request fails; like the server's row, it has no human turn, so it sorts where the server will put it. A send stamps the row with the send time so it moves to the top now. A server `lastHumanTurnAt` newer than the one the row had when the send started confirms the stamp, so a server clock behind the browser's still confirms it; a failed send removes it. Only the reader's own send moves a row before the server says so.
6. **No guessed status.** Status comes from `statusChanged` events, the bulk status read and the snapshot's status, each stamped with the time it was sent. An event at or after a read's send time beats the read. A session with no status fact is `{ kind: "unknown" }`; nothing derives status from timing or message contents.

Order is flat and is the server's `human_turn_desc`: `lastHumanTurnAt` descending, where a session without a human turn counts as 0 and sorts below every session with one; then `createdAt` descending; then the session id descending. The fetched window ends at the order key of its last row. A confirmed row after that key stays hidden until `loadMore` reaches it, even while it is open. Archived rows and subagents (`parentSessionId`) are not shown.

## Owned concepts

| Concept | Home |
| --- | --- |
| Session rows, tombstones, pending entries, the fetch window and status per session | `list/` (`model.ts`, `rows.ts`, `statuses.ts`, `transition.ts`, `visible-rows.ts`, `store.ts`) |
| Agent requests (permissions and questions) and their reply machine | `requests/` |
| One session's transcript, todos, diff, goal, older pages, the optimistic user message and the queue | `transcript/` |
| The LRU of open sessions, the one stream dispatch and the provider | `store/` |

Fetched data never enters these stores and pushed data never enters the query cache. Deltas are coalesced per animation frame (`transcript/deltas.ts`) and appended in place on the part's field; a message or part upsert replaces only that message's parts array or the messages array, so unchanged messages and part arrays keep their identity for the timeline's row memos.

## State machines

| Machine | States | Where |
| --- | --- | --- |
| Session list | `subscribing`, `fetching(held)`, `live(more: idle / loading(held) / failed)`, `rereading(held)`, `failed(error)`; each entry `confirmed`, `pending` or `tombstone` | `list/model.ts`, `list/transition.ts` |
| Session read | `loading(held)`, `ready`, `rereading(held)`, `missing`, `failed(error)`; shown as `SessionLoadState` (`rereading` shows as `ready`) | `transcript/model.ts` |
| Older page | `idle`, `loading`, `failed(error)` | `transcript/model.ts` |
| Request | `open`, `answering`, `answered`, `expired`, `failed(error)` | `requests/model.ts` |

## The per-session store

- `open(ref)` returns the session's view and keeps the 8 most recently opened sessions; the ninth evicts the least recent, disposing its root and telling the list it closed.
- The snapshot read lands the row and status into the list, the requests into the requests store, and replaces the newest page of the transcript. Messages older than that page (loaded with `loadOlder`) stay. Transcript events that arrive during a read are held and replayed after it; a held upsert never un-settles a completed assistant message or a finished part. Deltas are never held: buffered deltas are dropped when the snapshot lands, because the snapshot already carries their text.
- `send` mints the user message id from the adapter, inserts the optimistic stub under that id (sorted last), stamps the list, and sends the prompt with `messageId`; the runtime echoes the user message under the same id, which replaces the stub. A failed send removes the stub and the stamp and rejects with the `AppError`.
- `turnSettlePending(userMessageId)` is true while a snapshot read is in flight and that id is the last user message.
- `queue` reads the runtime's held prompts through the adapter, re-read on: own send accepted, `statusChanged`, a user `messageUpserted`, and a stream gap. No timer. A queued record whose `messageId` matches an optimistic stub replaces the stub, so the prompt shows as queued and editable. `beginEdit` holds the record and sets `editing`; the composer owner loads its text (`queuedMessageText`) into the composer and calls `cancelEdit` to release it.
- `goal` comes from the snapshot's goal read and `goalChanged` events, which are held during a read like the transcript's. A goal fact older than the one held is dropped: a different goal is ordered by `createdAt`, the same goal by `updatedAt`. A removal records the removed goal's `createdAt`, so a late update of that goal can't bring it back. `goalActions` are the actions the session's harness supports; `controlGoal` applies the server's answer.
- `status` and `row` are read from the list store, `requests` from the requests store: one home per fact.

## Flows

Flow 31 (`e2e/flows/31-session-list-races.spec.ts`): the race cases from the plan; at the end of each case the visible rail rows equal the server's list and statuses.
