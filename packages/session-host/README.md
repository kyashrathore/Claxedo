# @claxedo/session-host

The Cloudflare Worker whose `SessionDO` runs one top-level Pi session. The object is named by the session's id; its agent loop is Pi on `@earendil-works/pi-durable`, hosted by Cloudflare's `PiHarness` (`agents/harness/pi`), and its tools run on the workspace's machine, whatever sandbox driver serves it.

## Request path

Clients reach the object through the workspace relay: a Runtime Access Token for host `session-do:<root>` becomes a Relay Host Token, and the relay forwards to `SESSION_HOST.getByName(root)`. The object verifies that token with the shared relay-host middleware and serves the shared session routes (`composeSessionRoutes`) and the workspace event stream, authorized by the control plane's `/session-authorize` over the `CONTROL_PLANE` service binding (`remoteWorkspaceSessionAccessPolicy`). The first verified token names the object's workspace, which it keeps (`session_host_meta`). Transcripts are read from the object; nothing is copied to the control plane at turn end.

## A turn

1. The session routes acquire the control plane's turn lease. `TurnLeases` records each lease the authority issues or renews in `session_host_turn_lease`, and forgets it when the turn ends.
2. Before the transport submits, `prepareTurn` posts the lease to `/turn-delivery` once per lease (`turnId:fencingToken`): the provider accounts of the session's creator as direct secrets, whoever sends the turn, the Pi plugin launch and provider definitions. Pi calls the provider directly with them; no control-plane call is made per model request. An OAuth refresh, or a delivery past its `expiresAt`, repeats the delivery.
3. Pi's first file or command call, or a plugin's stdio MCP server starting, posts the lease to `/turn-execution` for a session-scoped token for the workspace machine; a `409 cloud_runtime_unavailable` is waited out for its `retryAfterMs`, until the turn ends or is stopped. The answer's `directory` is the session's machine directory: another directory from the same machine (host and routing id) is refused, and one from a sandbox provisioned again replaces it.
4. `RemoteExecutionEnv` serves Pi's `ExecutionEnv` over the machine's `/api/wr/execution-env/fs` and `/exec` routes through the relay; aborting a command aborts its request, which ends the command. A plugin's stdio MCP server runs on the machine and is reached over one WebSocket to `/api/wr/execution-env/mcp/<name>`; HTTP MCP servers are called directly.

## Claxedo's first-party MCP

For a turn the workspace owner drives in their own session, while the project has a first-party tool group on, `/turn-delivery` names the control plane's `/api/claxedo/mcp?session=<root>`, the tool groups on, and a bearer minted for that turn (`firstPartyMcp`). The server's name, URL and groups are part of the delivery's projection generation, so a turn after a group is turned on or off lists the tools again; the bearer is not, since it changes every turn. The host offers it to Pi as the `claxedo` server and calls it over the `CONTROL_PLANE` binding, asking the current delivery for the bearer on every request (`authProvider`), so a turn's renewal reaches a connected client and the bearer never enters the projection, a header map or the store. The endpoint answers each of these requests on its own, with no MCP session, because the bearer rotates and the hosted worker's isolates share no memory. The control plane verifies it on each request (`claxedo-server/src/mcp/session-mcp-credentials.ts`): bound to owner, session and workspace, at most ten minutes, under an audience only that endpoint pins, and refused once the session is deleted, moved off its host, or the workspace changes owner. Its tools reach only the session's own workspace machine, with an owner editor token the control plane records for that live session. A tool naming the session itself reaches the machine, which does not hold this session.

Pi runs one round's tool calls together, so commands of one round reach the machine with no ordering between them.

## Durable runs

`PiHarness` resumes pi-durable as soon as its factory returns, and pi-durable fixes its `models` and registry when it opens. So the factory (`DurablePiPlacement.factory`) opens the one Harness with the object's registry and a `Models` that forwards to the session's own credentials, then boots the session core before returning: busy sessions are marked interrupted, a stored lease is adopted (`adoptSessionTurnLease`) and its delivery fetched, and the session is attached, which installs Pi's extensions and continues a live run as a continuation turn. The adopted lease is released when Pi goes idle. When its renewal is refused, or there is no lease to take over, the run is aborted.

An evicted object is restarted by Pi's own wake job and alarm, so a run continues without any request. Commands that were running are not rerun: Pi gives the model an interrupted result.

## Deletion

`DELETE /session/<root>` runs the shared delete route, whose first step posts the request's own relay host token to the control plane's `/session-host-delete`: the control plane deletes the session's row as that request's actor, or refuses, and then nothing is deleted. Once it has deleted the row, the object's whole storage is deleted after the request, and the object restarts empty.

## A store this build does not read

The object starts its Lifecycle before it answers anything. When that fails, a request with a valid relay host token is answered `409 session_host_unsupported_store` for a runtime store written by another schema, else `503 session_host_unavailable`, without a stack; nothing is cached, so the next request starts again. Deletion still works: the control plane's delete, then the storage.

## Configuration

| Binding | |
|---|---|
| `CONTROL_PLANE` | service binding to the control-plane Worker |
| `WORKSPACE_RUNTIME_SESSION_AUTHORITY_URL` | the control plane's `/api/runtime-authority/session-authorize`; `/turn-delivery` and `/turn-execution` are its siblings |
| `WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM` or `WORKSPACE_RUNTIME_RELAY_JWKS_URL` | the relay host token verification key |

The Worker needs `nodejs_compat` (the Lifecycle uses `node:async_hooks`; pi-ai's providers reference Node built-ins). `claxedo-server/scripts/deploy/wrangler-config.ts` renders its config, and the control-plane deploy publishes it after the control-plane Worker. Tests: `bun run test` boots the bundled Worker in workerd with a control-plane stand-in, the real `execution-env` routes and a scripted model.
