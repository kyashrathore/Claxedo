# A lost part frame is repaired by the next read, not by the end of the turn

Status: implemented 2026-09-17 on `dev` (unpushed, `71504ab131`); one DoD
row open, see the list. Corrected the same day by the review of
`2026-09-17-002-refactor-two-event-streams.md`: static reading finds no
stream that carries a turn's parts to the desktop client (the runtime's
compat channel is served only by `/global/event` and `/event` on the
runtime app, which route ownership shadows on the local daemon), and the
live runs saw every transcript advance coincide with a REST read. The
proven defect is D.2; §1 is the fix that healed the rows. §2 and §3 stand
as transport hardening whose triggering scenario (C.1/C.2 on the parts
lane) is unproven until that plan's Phase 0.
Companion to `2026-09-16-001-fix-daemon-resource-waste.md` and
`2026-09-16-002-fix-opencode-engine-lifecycle.md`: those remove the daemon
stalls that lose frames; this plan makes a lost frame survivable. Neither
of them touches the paths below.

Observed 2026-09-17 11:23–11:29 on the dev install (`Claxedo Dev.app` built
2026-09-16 23:15, daemon pid 21513, `--max-old-space-size=512`) in session
`0032bfd4-338f-4a67-aae9-75e1e2b2fa42` (Claude harness, `~/test/opencode`).
The transcript showed three bash rows as "Running 1m 6s", "Running 38s",
"Running 29s" between rows that read "Ran …", while the turn kept going.

## The flow today, observed

**A. The store had already settled them.** `agent-core/…/state.db` `part`
rows for that message: 193 bash parts `completed`, 7 `error`, one `running`
(the tool actually executing at capture time). The three on-screen rows are
ords 31, 33, 36 of `msg_0ade9b1f…`, `completed` at 11:23:54, 11:24:03,
11:24:19. `GET /session/…/message` on the live daemon returned the same.

**B. The client held each part's FIRST frame.** The rows carried no command
text (the expanded one rendered an empty `$`), and their elapsed times
matched the parts' real starts (deltas 27.5 s and 8.5 s between the three,
against journal timestamps 413.3 s → 440.8 s → 449.3 s). So the client had
applied `tool-start` (status running, empty input) for each and never
applied its `tool-input` or `tool-output`. Neighbouring parts (32, 34, 38)
got theirs. `runtime_journal` keeps only the newest snapshot per part id
(`insertRuntimeJournal` deletes the part's older rows,
`workspace-runtime/src/store.ts:2002`), so the journal cannot say which
frame was lost; the client state says which was applied.

**C. Where a frame can be lost, silently.** A session's frames reach the
app on two lanes (`platform/runtime/session-event-scope.ts`):

- the central bus, `/api/claxedo/events` (`claxedo-events.tsx` reading
  `createGlobalEventsHandler`, `claxedo-local-server/src/shell/events.ts`;
  a local WebSocket on the desktop, SSE elsewhere, one writer for both,
  `event-stream-response.ts`). This is the lane that carries
  `message.part.updated` and `message.part.delta` — the embedded runtime
  bridges them onto `globalBus`. The client applies them through
  `routeDirectoryEvent` → `applyRegisteredConversationEvent`.
- `/api/wr/runtime-events?parentSessionId=…` (`provider.tsx`,
  `runtimeEventsHandler`, `workspace-runtime/src/routes/events.ts`), raw
  `AgentRuntimeEvent` envelopes. The provider projects only diagnostics,
  subagent and goal frames from it (`projectRuntimeDiagnosticEnvelope`,
  `applySubagentRuntimeEventEnvelope`); a `text-delta` or `tool-output`
  arriving there is dropped on the client, so this lane never carries a
  part to the transcript.

Both lanes are served by `attachSseFanout` (`agent-sdk-runtime/src/sse.ts`)
over a `createSseReplayBuffer` ring of 256 events plus a 64-event terminal
reserve, and both lose frames the same two ways:

- C.1 The fanout caps the per-connection pending queue at 256 frames and on
  overflow drops the oldest frame that is not terminal (`dropIndex`,
  `:156`). Terminal on the central lane is `isTerminalCentralFrame` →
  `isTerminalClaxedoEvent` plus `session.idle`/`session.error` for
  envelopes; a `message.part.updated` that closes a tool is shed like a
  token delta. `onDrop` exists on the fanout and is wired by no caller, so
  a shed frame leaves no trace in the daemon (stdio `ignore`) or on the
  wire. The handler's own comment claims those frames "self-heal — a missed
  part is reconciled by the next message refetch"; D.1 and D.2 are why that
  was not true mid-turn.
- C.2 The client aborts a stream after 30 s without a frame (both lanes:
  `HEARTBEAT_TIMEOUT_MS` = `EVENT_STREAM_STALL_MS`, producer heartbeat every
  10 s) and reconnects with `Last-Event-ID`. Token deltas fill the 256 ring
  in seconds, so `hasGap` is true and the route writes a gap notice and
  continues LIVE from `throughId` (`attachSseFanout`, `:196–213`). The
  central lane's notice is a `stream.replay-gap` frame; `claxedo-events.tsx`
  dispatches frames by type and has no handler for it, so the hole is
  simply not reported. The runtime lane's notice is a `harness-notice`
  `runtime.sse_replay_gap`; the provider answered it by clearing
  `lastRuntimeEventId` and ABORTING the connection (`provider.tsx:347–368`),
  so the cursor-less reconnect was served nothing from the ring
  (`routes/runtime-events.ts:89`) and every frame between abort and re-open
  was lost too.
- C.3 On the runtime lane the producer's `{type:"heartbeat"}` frame never
  reached the watchdog: `heartbeat.reset()` ran only for parsed envelopes,
  so any tool quieter than 30 s tripped a reconnect mid-tool — a reconnect
  that, under a stalled daemon, is served after the burst and lands on C.2.
  (Measured: `.6429` aborted 30 s after its gap frame with tool 2 sleeping.)

The daemon's own log shows the stalls: `daemon lease renewal failed:
TimeoutError` continuously 11:27:36–11:28:54 (`~/Library/Logs/Claxedo
Dev/main.log`). The installed bundle still runs `reconcileSessionMetadata`
on every cache-hit `ensureEmbeddedWorkspaceRuntime` (plan 001 item 5:
106 ms CPU + 1.1 MB write per proxied request) and booted the OpenCode
engine (`opencode-runtime/opencode.db` present; plan 002). Those are the
stall; they are not this plan.

**D. Why nothing repaired it until the turn ended.**

- D.1 No lane's gap notice re-reads history. The central lane ignores its
  notice (C.2). The runtime lane's `resetRuntimeReplayGapState`
  (`runtime-event-projection.ts:110`) invalidates `queryKeys.session.messages`,
  `.todo` and `.diff`, keys with no producer and no observer outside tests
  (`session.row` is the only live one, `session-pane-queries.ts:114`);
  history is read through `syncSessionHistory` under
  `sessionTransportRequestKey` with `gcTime: 0` (`session-controller.ts:522`).
  The ingress `repair` action for the same code (`event-ingress.ts:747`) is
  a control-plane projection pull (`scheduleSessionProjectionPull`), cloud
  workspaces only.
- D.2 A mid-turn history read cannot advance a part the client already
  has. `hydrateConversationPage` (`conversation-hydrator.ts:135`) marks
  parts canonical only for SETTLED messages (`canonicalPartMessageIds`,
  `:124`); the in-flight message's parts go through `resolveStoredParts` →
  `mergeStoredItems` (`store/message-page.ts:40`), a union that skips every
  id it already holds (`if (ids.has(item.id)) continue`). The stale
  `running` row wins over the server's `completed` row before
  `mergeChatPart` (`agent-conversation.ts:305`) — the one place with a
  freshness policy (tool-call rank, text length) — ever sees it. The only
  mid-turn reads that exist are the accepted-prompt refresh, seven attempts
  in the first 28 s of a turn (`session-controller.ts:120,747`).
- D.3 The heal is turn settlement: `syncSessionHistory(force)` on
  `transition.settled` (`session-controller.ts:1078`) → settled message →
  `reconcileStoredParts`. A long turn shows stale rows for its whole life.

Not the cause, checked: the uncommitted timeline row-reuse work (rows are
`(messageID, partID)` refs reading live store state through `getMsgPart`);
the client coalescer (keeps the newest frame per part id,
`event-coalescer.ts:92`); `upsertPart`'s terminal-state guard (only refuses
a NON-terminal frame over a terminal part).

## Goal

- A `message.part.updated` that closes a tool reaches every connected
  client or the client is told it did not. Shedding never eats a frame that
  settles a tool, and a shed non-terminal frame produces the same gap
  notice a rolled replay ring does.
- A gap notice on either lane repairs the sessions that lane feeds by
  re-reading their history through the real owner, while the stream that
  carried the notice stays open. No reconnect, no window.
- A quiet tool does not trip a reconnect: the producer's heartbeat is what
  the stall budget measures.
- A history read taken mid-turn can advance a part the client already
  holds, and can never regress one: `completed` beats `running`, longer
  text beats shorter. One freshness policy, in `mergeChatPart`.

## Design

### 1. The hydrator carries the server's row; `mergeChatPart` decides

`resolveStoredParts` (non-canonical rows: unsettled messages and
`latest-surface` fragments) stops being a set union. For an id both sides
carry it yields the SERVER row in the client's position; ids only the
client holds stay where they are; ids only the server lists are appended.
Membership is unchanged — the fragment still cannot prune — but content now
reaches `mergeChatMessage` → `mergeChatParts` → `mergeChatPart`, which keeps
the client's part when it is fresher (tool-call rank `complete` >
`input-complete` > `awaiting-input`; text/thinking by length) and takes the
server's otherwise. `first-fold-hydration.ts` and the `latest-surface`
activation read use the same path and gain the same behaviour.

`mergeStoredItems` keeps its union semantics for its other callers
(`mergeParts`, message rows); it is not the part policy.

### 2. A gap notice re-reads history on the live stream

- `features/session/store/session-history-resync.ts` (new): a request
  signal in the shape of `accepted-prompt-refresh.ts`,
  `requestSessionHistoryResync({ directory?, sessionID?, reason: "sse-gap" })`.
  The central lane is workspace-wide and its notice names no session, so a
  request may leave both unset and every mounted controller answers for its
  own session; each controller tracks the last sequence it handled. The
  session controller runs `syncSessionHistory(id, { force: true, view:
  "latest-turn", mode: "replace-window", bypassQuiet: true, silent: true })`
  and `syncSessionTodo(id, { force: true })`. A request no controller
  matches is dropped: that pane's activation read loads history anyway.
- `claxedo-events.tsx` `emitEvent`: a `stream.replay-gap` frame raises a
  workspace-wide request and is not emitted further. The stream stays open.
- `provider.tsx`: on `runtimeReplayGap(envelope)` the provider publishes the
  `runtime.diagnostic` (`runtime.sse_replay_gap`) for the live session and
  runs `resetRuntimeReplayGapState`; it no longer clears `lastRuntimeEventId`
  or aborts the attempt. `routeDirectoryEvent` raises a session-scoped
  request for that diagnostic. A `{type:"heartbeat"}` frame resets the
  watchdog before envelope parsing (C.3).
- `resetRuntimeReplayGapState` drops the dead `session.messages/todo/diff`
  invalidations, keeps `subagents.replayGap()`, `session.row`,
  `shell.sessionInventory` and the goal invalidation, and invalidates the
  real diff key (`shellDataKeys.sessionId(id, "diff")`).
- The control-plane `repair` pull in `event-ingress.ts` stays; it answers a
  different question (the cloud store's copy of the session).

Known limit: text parts are append-only and a delta carries no offset. A
re-read replaces the client's text when the server's is at least as long;
a hole smaller than the live tail that arrives while the read is in flight
can survive until the turn settles (canonical reconcile). Tool parts, the
symptom here, compare by state rank and are hole-proof.

### 3. Shedding cannot eat a settlement, and never hides

- Central lane: `isTerminalCentralFrame` (`shell/events.ts`) treats a
  `message.part.updated` envelope whose tool state is `completed`/`error`
  as terminal (`settlesToolPart`). Runtime lane: `isTerminalRuntimeEvent`
  (`routes/events.ts`) adds `tool-output`, `tool-error`, and `tool-status`
  `completed`/`failed`. Both join the fanout's protected set and the replay
  buffer's terminal reserve. The reserve does not change what `hasGap`
  reports — a missing seq is a gap regardless — so the effect is on
  shedding only.
- `attachSseFanout`: when overflow drops a non-heartbeat frame, the fanout
  puts ONE `replayGap({ lastEventId: <dropped id>, throughId:
  replay.lastId() })` frame at the head of the queue, marked terminal and
  not counted against the cap, and raises no other until that one has been
  written. Every caller already passes `replayGap`, so the notice reaches
  the client through the same path a rolled ring does (§2). `onDrop` stays
  as the observation seam and is called before the notice.

## Change points

- `packages/claxedo-app/src/features/session/conversation/conversation-hydrator.ts`
  — `resolveStoredParts` (§1).
- `packages/claxedo-app/src/features/session/store/session-history-resync.ts`
  (new) + test; `session-controller.ts` effect (§2).
- `packages/claxedo-app/src/app/integrations/claxedo-events.tsx` —
  `isStreamReplayGap`, the `emitEvent` hook (§2).
- `packages/claxedo-app/src/app/integrations/session-events/event-router.ts`
  — session-scoped request on the runtime-lane diagnostic (§2).
- `packages/claxedo-app/src/app/providers/global-sdk/provider.tsx`,
  `runtime-event-projection.ts` — no abort on gap; heartbeat resets the
  watchdog; dead keys removed; real diff key (§2).
- `packages/claxedo-local-server/src/shell/events.ts`,
  `packages/workspace-runtime/src/routes/events.ts` — terminal sets (§3).
- `packages/agent-sdk-runtime/src/sse.ts` — overflow gap notice (§3).
- Tests: `conversation-hydrator.test.ts` (the unit-level "streamed survives
  stale" case becomes the registry-level running→completed advance and the
  never-regress guard), `session-history-resync.test.ts`,
  `event-router.test.ts`, `claxedo-events.test.ts`, `provider.test.ts`
  (dead-key expectations replaced by the diff key; heartbeat predicate),
  `sse.test.ts` (overflow notice once per episode, terminal),
  `routes/events.test.ts`, `shell/events.test.ts` (tool settlement survives
  a 300-frame burst; its start snapshot does not).

## Definition of done

Each row verified through the real entrypoint named, commands and results
written into the row.

- [x] Hydrator: `hydrateConversationPage` with a canonical rows page advances
      a `running` part the client holds to the server's `completed` row on
      an UNSETTLED message; the reverse keeps `completed`; longer client
      text is kept; client-only parts stay. Progress: `bun test
      --conditions=browser --preload ./happydom.ts src/features/session/
      conversation/conversation-hydrator.test.ts src/features/session/store/
      message-page.test.ts` → 25 pass. The two new cases are red against the
      old union (2 fail / 15 pass with `mergeStoredItems` restored).
- [x] Gap keeps the stream and re-reads: the central-lane `stream.replay-gap`
      frame raises a workspace-wide resync (`isStreamReplayGap`); the
      runtime-lane diagnostic raises a session-scoped one (`event-router`);
      the controller runs `syncSessionHistory(latest-turn, replace-window)`
      + `syncSessionTodo` once per request. Progress: `session-history-
      resync.test.ts`, `event-router.test.ts`, `claxedo-events.test.ts`,
      `provider.test.ts` → 63 pass across the five touched app suites. Live
      on the desktop daemon (packaged build 2026-09-16 23:15 + this tree's
      app on `vite` 4444), session `17adece3…`, `kill -STOP` 12:16:26 →
      `CONT` 12:17:02 mid-essay: runtime-events `.6375` aborted by the
      watchdog, `.6429` reconnected with a stale cursor, and immediately
      after it `subagents` + `goal/state` (`resetRuntimeReplayGapState`) +
      `message?view=latest-turn` + `todo` (the resync) — no third stream
      request. The central lane's part of the same row is NOT live-verified:
      that daemon was replaced by the desktop's lease takeover during a
      later 55 s stall, and a standalone daemon (`resources/claxedo-server/
      index.js`, dev data dir) does not bridge part frames onto its central
      bus without the desktop lease (ring cursor stayed at 1363 while the
      essay grew to 17 KB). Owner: next desktop session; procedure below.
- [x] Shedding: `attachSseFanout` with `maxPending: 2`, a stalled writer, a
      queued `tool-output` and deltas: the settlement is never the dropped
      frame; the first drop enqueues exactly one gap frame; no second until
      it is written; then a fresh one. Progress: `bun test src/sse.test.ts`
      → 13 pass. `routes/events.test.ts` + `runtime-events.test.ts` → 20
      pass (`bun test … --timeout 30000`). `shell/events.test.ts` under
      vitest → 20 pass (a tool's settling part survives 300 deltas; its
      start snapshot is evicted).
- [ ] End to end on the installed desktop build: a Claude turn with a
      ≥ 10 s foreground tool (`python3 -c 'import time; time.sleep(40)'` —
      Claude Code runs a bare `sleep` in the background and ends the turn)
      followed by a long streamed answer and a second long tool; `kill
      -STOP` the daemon for ≤ 36 s spanning the first tool's completion
      (≥ 45 s trips the desktop's lease takeover, which replaces the daemon
      and kills the turn); after `CONT`, the first tool's row reads "Ran …"
      and the transcript catches up to `GET /session/:id/message` within
      one resync (`message?view=latest-turn` + `todo` right after the
      central WebSocket reconnects), while the second tool is still running.
      Progress: not verified — see the row above for why; the runtime-lane
      half of the same sequence was observed.
- [x] Repository searches: no reference to `queryKeys.session.messages`,
      `.todo`, `.diff` outside `keys.ts` and the persister; the provider
      has no `lastRuntimeEventId = undefined` on the gap path (the one left
      is the session retarget). Progress: `grep -rn` → none; `provider.tsx`
      line 230 only.
- [x] `bun run test:architecture-ratchets` passes; typecheck green for
      `claxedo-app` (`tsgo -b`), `workspace-runtime`, `agent-sdk-runtime`;
      `oxlint --type-aware` on the touched files → 0. Progress: all run
      2026-09-17 12:00–12:30, exit 0.

## Non-goals

- The daemon stalls themselves (plans 001, 002).
- Journal snapshot pruning (`insertRuntimeJournal`): correct for the
  store; it only removes the forensic trail, which the gap notice now
  replaces.
- `queryKeys.session.messages/todo/diff` definitions and the persister's
  filter on them — dead, tracked for removal with the persister.
- Resuming from `throughId` after a gap instead of re-reading: would
  double-apply `message.part.delta` frames the REST read already folded in.
- A cursor-less FIRST open served nothing while the daemon is stalled
  (observed 12:06: the reply's `message.updated` fell in the window and
  every later part frame for it was dropped by `upsertPart`'s
  `index === -1`). Same repair (a history read after the stream opens),
  different trigger; not wired here.
- Heartbeat frames on the central lane already reset its watchdog.

## Execution

Three lanes with disjoint files; §1 and §3 have no dependency on §2.

- **Lane 1 — hydrator** (`conversation-hydrator.ts`, its test,
  `message-page.test.ts`).
- **Lane 2 — gap repair** (`provider.tsx`, `runtime-event-projection.ts`,
  `event-router.ts`, `session-history-resync.ts`, `session-controller.ts`,
  their tests).
- **Lane 3 — transport** (`sse.ts`, `routes/events.ts`, their tests).

Shared tree with other active lanes: commit with `git commit -- <paths>`
only. One adversarial review on the combined diff, one re-review after
fixes, then the installed-build DoD row.
