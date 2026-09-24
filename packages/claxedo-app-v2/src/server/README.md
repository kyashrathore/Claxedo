# server

The only module that knows today's server: its routes, its OpenCode-shaped payloads and event names, and how to reach the daemon, the control plane and the relay. Everything else in the app imports `src/server/index.ts` and speaks Claxedo types.

## Owned concepts

- The contract: `index.ts` (the public surface), `api.ts` (the APIs and `Server`), `types.ts` (sessions, projects, placements, status, harness options, capabilities), `terminal-types.ts`, `git-types.ts`, `cloud-types.ts`, `account-types.ts`, `usage-types.ts`, `marketplace-types.ts`, `events.ts` and `ids.ts`. `api.ts` holds the contract rather than `index.ts` so the e2e program can typecheck the adapter without the provider's JSX.
- `ServerConfig` (`config.ts`): the server URL (explicit, else `VITE_CLAXEDO_SERVER_URL`, else the page's own origin when the daemon serves the app) and the auth source (`none`, `basic`, `bearer`).
- `Transport` (`transport.ts`): authenticated requests to the server, and to the runtime serving a placement. A local placement is reached on the same origin with `?directory=`; a remote one through the daemon's `/workspaces/<id>` proxy on loopback, else through the relay (`relay.ts`) with a Runtime Access Token minted from the control plane and refreshed a minute before expiry.
- `ServerError` (`errors.ts`): the one table from responses and turn failures to `AppError` classes. `network` and `rate_limit` are retryable; nothing else is. TanStack Query's default error type is registered here.
- The event stream (`stream.ts`, `streams.ts`): `cp/events` and, when the server declares `events.hostAggregate`, the host aggregate `wr/events`. Parsed by `eventsource-parser`; resumed by `Last-Event-ID`; a `stream.replay-gap` frame becomes `streamGap`. On the desktop `cp/events` can ride a WebSocket so it holds no HTTP/1.1 slot.
- The event intake (`event-intake.ts`): maps frames to `ServerEvent`s in arrival order, lets the status owner admit them, invalidates queries through the event table and hands each event to the subscribers.
- Placements (`workspaces.ts`, `wire/placements.ts`): the bootstrap catalog, held in the query cache and read reactively. A placement id is the workspace store id; a `SessionRef` becomes a runtime route only here. Worktrees are created through the local server (`worktrees.ts`).
- Projects (`projects.ts`, `wire/projects.ts`): records by id from `/api/claxedo/projects`.
- Sessions (`sessions.ts` composes the calls over one `SessionContext` from `session-context.ts`): the list through `/api/claxedo/session-list` (or `/api/control/session-list` when not on loopback) with `scope=workspace` and no workspace, which is every workspace's top-level sessions (`scope=global` is only the global chats); the snapshot from messages `{view:"latest-surface"}` plus status, requests, todos, goal and the row's diff summary, and older pages through `{before,limit}` (`session-reads.ts`; a page is a JSON list with the older cursor in `X-Next-Cursor`); create with the harness in the query and the body; prompt through `prompt_async` with a client-minted ascending message id, where `delivery` (`queue` or `steer`) hands a prompt sent during a running turn to the runtime's queue and the answer says how it was admitted (`start`, `queue` or `steer`); a prompt with a `goal` starts the goal (`POST /session/:id/goal`) instead; stop through a `cancel_turn` recovery request (`session-stop.ts`); the held and queued prompts (`session-queue.ts`); the goal (`session-goal.ts`); and the status read across placements (`session-statuses.ts`).
- Harness options (`harness-options.ts`, `wire/harness-options.ts`): a placement's models and efforts per harness from `/api/claxedo/agent-config/harness/options`. A model is `{ providerId: <harness id>, modelId: <option id> }`. `wire/harness-selection.ts` is the one place that turns a harness id into `nativeHarness` or `connectionId`.
- Status (`status.ts`): the one owner of session status. A session that is not running is failed when its `lastTurn` failed, else idle; a placement read takes `lastTurn` from its root sessions (`GET /session?roots=true`). Fed by `session.status`, `session.idle` and `session.error` frames; a turn error named `MessageAbortedError` is a cancelled turn, not a failure. An idle that follows a failure is held and settled from the session's `lastTurn` (a refused delete aborts the turn with an error, but the turn is recorded as completed). No timer invents a status.
- Capabilities (`capabilities.ts`): one value from the bootstrap declaration, each harness's availability and the tasks and documents probes (`availability.ts`). Claude, Codex and Cursor are available when their machine login is signed in or a stored credential serves one of their providers; Pi when its provider catalog lists a connected provider; OpenCode on a loopback daemon. Capabilities carry no model lists: models come from harness options per placement, and opencode's provider catalog alone is 2.3 MB. Each source is read on its own; a failed one makes only its harness or feature unavailable, with the reason in `unavailableReason`. A loopback daemon is this machine even before enrollment, and its placements carry this machine's id.
- Queries (`queries.ts` and one file per area): TanStack Query options for fetched data. Keys come only from `query-keys.ts`. Events invalidate through `invalidationKeys`. `setQueryData` is used only for a mutation's own result.
- Plugin host calls: `request` is an authenticated request to the server for the routes a plugin's manifest names (the plugin host checks the manifest first); `livePlugins.remove` (`live-plugins.ts`) unregisters a live plugin through `/api/claxedo/live-plugins/:id`. Hosted operations are not the adapter's: they need the account layer.
- Terminals (`terminals.ts`, `wire/terminals.ts`): the runtime's pty routes and socket. Text frames are output; a binary frame whose first byte is 0 carries `{cursor, checkpoint?}`; other binary frames are output decoded as one UTF-8 stream. A malformed meta frame closes the socket with 1002.

## State machines

- Connection (`stream.ts`): `connecting → connected`, `connected → reconnecting(attempt)` on a drop, `reconnecting → offline(reason)` past the attempt bound, `offline → connecting` on `retry`. Backoff doubles from 250 ms to a 15 s ceiling with jitter in the top half. A stream with no frame for 30 s (three heartbeats) is dropped and reopened.
- `server.connection` aggregates the open streams: offline if any is offline, reconnecting if any is reconnecting, else connecting, else connected. A bootstrap read that fails before any stream opens is offline with its reason; `retryConnection` reads it again.

## Invariants

- A frame that is not JSON, or has no type, is logged and dropped; the stream stays open.
- Frames are mapped in arrival order through one serial queue. A frame naming a directory the catalog does not place re-reads the catalog once per directory until the next refresh; a failed re-read becomes a `streamGap`.
- Deltas are coalesced per animation frame (`wire/coalesce.ts`): consecutive `partDelta` frames for one field merge, and a `partUpserted` that carries text supersedes the deltas queued before it. A hidden page gets no animation frames, so a batch also flushes after 250 ms; otherwise a background tab would hold every event until it is shown.
- A status read across placements reports each placement that could not be read in `failures`; `unreported` holds only for the placements that were read.
- Nothing outside `src/server/` imports `src/server/wire/`.
- `ServerProvider` owns the handle it is given: it provides the query client, retries the connection when the browser comes online or the page becomes visible, and disposes the handle on cleanup.

## Additive contract changes

- `ServerEvent` gained `sessionsChanged`, `placementsChanged`, `documentsChanged`, `usageChanged`, `cloudWorkspaceChanged` and the terminal events.
- `AgentRequestReply`'s `dismiss` arm gained an optional `request` kind.
- `Server` gained `queries` and `cloud`; `PlacementsApi` gained `list`; `SessionStatusRead` gained `failures`; `ServerQueries` gained `harnesses.options`; `HarnessInfo` gained `unavailableReason`; `PromptInput` gained `delivery`, and `prompt` answers the `PromptDelivery`; `Server` gained `request` and `livePlugins`.

## Known limits

- The hosted `/api/control/session-list` needs a workspace id or a project id, so the one flat list works only against a daemon; a hosted list needs one read per project, merged by `lastHumanTurnAt`.
- The relay path (remote placements off loopback) and the hosted control plane are not exercised by the probe.

## Proof

`CLAXEDO_E2E_PORT_RANGE=46800-46899 bun e2e/probes/adapter-smoke.ts` runs the adapter against a real daemon started by the e2e harness, through a TCP proxy it can cut: projects, placements, files, git, terminals, harness options, create, snapshot, a streamed turn, list, statuses, queue, stop, resume by `Last-Event-ID` and a forced replay gap.
