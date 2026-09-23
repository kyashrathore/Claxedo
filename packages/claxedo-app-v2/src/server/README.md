# server

The only module that knows today's server: its routes, its OpenCode-shaped payloads and event names, and how to reach the daemon, the control plane and the relay. Everything else in the app imports `src/server/index.ts` and speaks Claxedo types.

## Owned concepts

- `ServerConfig` (`config.ts`): the server URL the client is attached to (the daemon, or the hosted control plane on signed web) and the auth source (`none`, `basic`, `bearer`).
- `Transport` (`transport.ts`): authenticated requests to the server, and to the runtime serving a placement. A local placement is reached on the same origin with `?directory=`; a remote one through the daemon's `/workspaces/<id>` proxy on loopback, else through the relay (`relay.ts`) with a Runtime Access Token minted from the control plane and refreshed a minute before expiry.
- `ServerError` (`errors.ts`): the one table from responses to `AppError` classes. `network` and `rate_limit` are retryable; nothing else is. TanStack Query's default error type is registered here.
- The event stream (`stream.ts`, `streams.ts`): `cp/events` and, when the server declares `events.hostAggregate`, the host aggregate `wr/events`. Parsed by `eventsource-parser`; resumed by `Last-Event-ID`; a `stream.replay-gap` frame becomes `streamGap`. On the desktop `cp/events` can ride a WebSocket so it holds no HTTP/1.1 slot.
- Placements (`workspaces.ts`, `wire/placements.ts`): from the bootstrap catalog. A placement id is the workspace store id; a `SessionRef` is turned into a directory only here.
- Projects (`projects.ts`): records by id from `/api/claxedo/projects`.
- Sessions (`sessions.ts`): list through `/api/claxedo/session-list` (or `/api/control/session-list` when signed), snapshot from messages `{view:"latest-surface"}` plus status, requests, todos and the row's diff summary, older pages through `{before,limit}`, prompt through `prompt_async`, stop through a `cancel_turn` recovery request.
- Status (`status.ts`): the one owner of session status. Read from `/session/status` and the row's `lastTurn`; fed by `session.status`, `session.idle` and `session.error` frames. An idle that follows a failure keeps the failure until the next working status. No timer invents a status.
- Capabilities (`capabilities.ts`): one value from the provider catalog per harness, the bootstrap declaration and the tasks and documents probes.
- Queries (`queries.ts` and one file per area): TanStack Query options for fetched data. Keys come only from `query-keys.ts`. Events invalidate through `invalidationKeys`. `setQueryData` is used only for a mutation's own result.

## State machines

- Connection (`stream.ts`): `connecting → connected`, `connected → reconnecting(attempt)` on a drop, `reconnecting → offline(reason)` past the attempt bound, `offline → connecting` on `retry`. Backoff doubles from 250 ms to a 15 s ceiling with jitter in the top half. A stream with no frame for 30 s (three heartbeats) is dropped and reopened.
- `server.connection` aggregates the open streams: offline if any is offline, reconnecting if any is reconnecting, else connecting, else connected.

## Invariants

- Frames are mapped in arrival order through one serial queue; a frame naming a directory the catalog does not know re-reads the catalog once before it is mapped.
- Deltas are coalesced per animation frame (`wire/coalesce.ts`): consecutive `partDelta` frames for one field merge, and a `partUpserted` that carries text supersedes the deltas queued before it.
- Nothing outside `src/server/` imports `src/server/wire/`.

## Additive contract changes

- `ServerEvent` gained `sessionsChanged`, `placementsChanged`, `documentsChanged`, `usageChanged`, `terminalChanged` and `agentActivity`.
- `AgentRequestReply`'s `dismiss` arm gained an optional `request` kind.
- `Server` gained `queries`.
