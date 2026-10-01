# The session core in a Durable Object

The session core already runs inside a Cloudflare Durable Object under
workerd. [`src/session-core-durable-object.node-test.ts`](../src/session-core-durable-object.node-test.ts)
proves it end to end, through the object's `fetch`:

- it creates a session;
- it sends a prompt and streams the turn over SSE;
- it reads the transcript back;
- it restarts the workerd process on the same storage and finds the same
  session and transcript;
- it prompts that session again after the restart;
- it evicts the object while a turn is streaming, and while a prompt is queued
  behind that turn, and reopens it (see [Eviction and boot](#eviction-and-boot)).

It runs only because the worker is built with `nodejs_compat`. This note lists
every place the core still reaches Node or a process-wide global, as a port the
host supplies, and says which host supplies each one.

## What the object composes

[`src/test-support/session-core-durable-object.ts`](../src/test-support/session-core-durable-object.ts)
builds one workspace's core in the object's constructor. It uses the same
pieces the machine runtime uses:

1. `RuntimeStore` runs over `durableObjectSqliteDatabase(ctx.storage)`.
2. `composeHost` ([`src/test-support/host-composition.ts`](../src/test-support/host-composition.ts))
   builds the store's broker ports, its `RuntimeEventHub` and
   `createAgentRuntime`. It is the same composition `createHostFixture` wraps
   for the Node tests.
3. `mountSessionRoutes` provides the session routes, the way
   `workspace/runtime.ts` mounts them.
4. `workspaceEventsHandler` with `sessionEventDeliveryPolicy` serves
   `GET /api/wr/events`.
5. A `FakeTransport` stands in for the harness and echoes each prompt.

Every `fetch` runs inside `withWorkspaceTarget({ workspaceId: ctx.id.name,
directory: "/workspace" })`. That is how the routes' `workspaceId()` and
`assertTarget()` learn which workspace this object is.

The test also checks the bundle's Node imports against a list. The worker
bundle must import only the Node builtins on that list. A new import fails the
test, and so does an import that disappears.

## Ports

Required means a Durable Object host must supply the port. Optional means the
object leaves it out and the feature is absent.

| # | Port | Reached from | Machine (Node) supplies | Durable Object supplies | DO |
|---|---|---|---|---|---|
| 1 | `SqliteDatabase`: `exec`, `prepare`, `transaction` | `store.ts` | better-sqlite3 through `store-file.ts`, with file root, backups and PRAGMAs | `durableObjectSqliteDatabase(ctx.storage)` | required, exists |
| 2 | Runtime bus (`publish`, `subscribe`) | `routes/session.ts` publishes `session.queue`, the `agent.lifecycle` bridge and `session.lifecycle`; `routes/events.ts` subscribes | `workspaceRuntimeBus`, pinned on `globalThis`, which PTY and agent hooks also publish to | its own `createBus()`, passed to `mountSessionRoutes` and to `workspaceEventsHandler` | required |
| 3 | Workspace placement: id, directory, request directory, served directories, canonical directory | `target.ts` through `routes/session.ts` `dir()`, `workspaceId()`, and `routes/events.ts` `ownsControlFrames` | `WORKSPACE_RUNTIME_*` env, `process.cwd()`, `AsyncLocalStorage`, the module-level worktree registry, `realpathSync` | today `withWorkspaceTarget` over `AsyncLocalStorage`; as a port, a fixed id from the object's name, one synthetic directory, no worktrees and identity canonicalization | required |
| 4 | Session documents: `flush(sessionId)`, `dispose(sessionId)` | `routes/document-hydration.ts` through `session-prompt-admission.ts`, `session.ts` and `session-core.ts` | the Pages hydration routes: files under the workspace, control-plane URL from env, module-level document maps | none | optional |
| 5 | Attachment bytes: `read(attachment)` returns bytes or missing | `routes/tool-image.ts` | `node:fs` open of a `tool-file` path, through `workspace-files/open-without-following.ts` | none today; R2 if tool images are kept | optional |
| 6 | Synchronous HMAC for idempotent child ids | `routes/session-children.ts` `createHmac` | `node:crypto` | `node:crypto` under `nodejs_compat`; Web Crypto's HMAC is asynchronous | required |
| 7 | Subagent key hashing and child ids | `harness/src/broker/subagents` `createHash`, `randomUUID` | `node:crypto` | `node:crypto` under `nodejs_compat` | required |
| 8 | Harness probe cache | `harness/src/contract/probe-cache.ts`, imported through the contract index | disk | none: imported, never called | optional |
| 9 | `TransportResolver` and `LaunchComposer` | `createAgentRuntime` input | the composed CLI and SDK transports; machine credentials and MCP projection | Pi in process; hosted credentials; placement `cloud` | required, exists |
| 10 | Boot: end the previous owner's turns, then re-issue queued prompts | `RuntimeStore.recoverBusySessions()`, then `SessionRoutes().recoverQueuedPrompts()` | `workspace/durable-state.ts` when the store opens, then `workspace/runtime.ts` once it is admitted | the object's constructor, both inside one `blockConcurrencyWhile` | required |

Some reaches need no port, because both hosts already provide them:

- **Ids:** the core calls the global `crypto.randomUUID()`, which Web Crypto
  provides in workerd. Only `host/home-use.ts` imports `node:crypto`, and it
  runs on the machine only.
- **`Buffer`:** no core file uses it. It arrives only through ports 4 and 5,
  from `@claxedo/helpers/fs`, which also imports `node:child_process`.
- **Timers:** the event delivery renewal `setInterval` and the SSE heartbeat
  run unchanged in an object. The heartbeat's clock is already injectable.
- **Checkpoint:** `createWorkspaceCheckpoint` is Node-free, and the object
  uses it as is.

Launch-ownership and worktree records, PTY, files and git are never reached
from the session routes or the event stream.

## The bus: why it is per instance

One isolate hosts many objects of the same class. A module-level value is
shared by all of them, and the runtime bus is pinned on `globalThis`.

When one workspace's routes publish a frame, every workspace's event stream in
that isolate is offered the frame. `ownsControlFrames` admits a frame by
directory, and every object serves the same synthetic directory. So
workspace A's `session.queue` frame passes the check in workspace B's stream,
and that frame carries A's queued prompt text.

On workerd the delivery then fails rather than leaks. B's stream reads B's
storage while deciding the frame, and workerd refuses I/O on behalf of another
object. The bus logs `workspaceRuntimeBus subscriber failed` once per frame.
The isolation case in the test asserts that this line never appears.

`SessionRoutes` and `mountSessionRoutes` now take an optional `bus`.
`workspaceEventsHandler` already took one. The object hands each workspace its
own bus, and the machine runtime keeps the global one. The machine needs the
global bus because PTY and agent hooks publish to it from separate bundles.

## Eviction and boot

An evicted object loses everything in memory: the turn's admission, its
producer and the harness behind it. Its store keeps the session `busy` and
the turn lease the dead owner never released. The machine runtime has the
same problem after a crash, and the same two calls answer it at boot. The
object makes them in its constructor, inside `blockConcurrencyWhile`, so no
request reaches it before they finish:

1. `store.recoverBusySessions()` deletes every turn lease and commits a
   `session.interrupted` row for each busy session. That row moves the session
   to `recovering` with the message "ACP process restarted; pending
   interactive state must be rerun". It ends the session's running tool calls
   with "Tool execution interrupted by ACP restart" and marks its pending
   permissions and questions stale. The text the turn had already streamed
   stays in the transcript.
2. `sessions.recoverQueuedPrompts()` wakes every session that has an eligible
   queued row: one not held, and with no delivery attempt still outstanding.
   Each one runs as its own turn once the session is idle.

Deleting every lease is safe only because no turn from the previous owner can
still be running. A Durable Object gives that guarantee: Cloudflare runs at
most one instance of an object at a time.

The tests check the outcome at each boundary:

- A turn evicted mid-stream reads back as `recovering`, with its partial text
  and its tool call ended as above, and the next prompt runs normally.
- A prompt queued behind that turn runs exactly once after the reopen, and its
  row is deleted. A third boot runs nothing and leaves the transcript as it
  was.
- Removing either call turns a test red. Without the first, the dead owner's
  lease refuses every new turn. Without the second, the queued row waits for a
  prompt that may never come.

A queued prompt re-issued at boot runs before the request that woke the
object can subscribe to its stream. The SSE replay ring lives in memory and
dies with the object. A client that reconnects after an eviction therefore
learns about that turn from the transcript, not from the stream.

## Not yet proven

These would block a production Durable Object host:

- **Node imports:** ports 3 to 8 still reach Node. A production object would
  either keep `nodejs_compat` and accept that closure, or move each reach
  behind its port so the session core bundles without it.
- **Placement:** port 3 works today only through `AsyncLocalStorage` and the
  module-level registry. It is not a real port.
- **A delivery in flight at eviction:** a queued row that a delivery attempt
  had already claimed is not re-issued. Its outcome is unknown, so it stays
  ineligible until someone reconciles it. The tests don't cover this.
- **Stream continuity across an eviction:** the replay ring does not survive
  an eviction. A client must re-read the transcript after it reconnects.
