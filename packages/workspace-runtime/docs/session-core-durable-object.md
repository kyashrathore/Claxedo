# The session core in a Durable Object

The session core already runs inside a Cloudflare Durable Object under
workerd. [`src/session-core-durable-object.node-test.ts`](../src/session-core-durable-object.node-test.ts)
proves it end to end, through the object's `fetch`:

- it creates a session;
- it sends a prompt and streams the turn over SSE;
- it reads the transcript back;
- it restarts the workerd process on the same storage and finds the same
  session and transcript;
- it prompts that session again after the restart.

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
| 5 | Attachment bytes: `read(attachment)` returns bytes or missing | `routes/tool-image.ts` | `node:fs` open of a `tool-file` path | none today; R2 if tool images are kept | optional |
| 6 | Synchronous HMAC for idempotent child ids | `routes/session-children.ts` `createHmac` | `node:crypto` | `node:crypto` under `nodejs_compat`; Web Crypto's HMAC is asynchronous | required |
| 7 | Subagent key hashing and child ids | `harness/src/broker/subagents` `createHash`, `randomUUID` | `node:crypto` | `node:crypto` under `nodejs_compat` | required |
| 8 | Harness probe cache | `harness/src/contract/probe-cache.ts`, imported through the contract index | disk | none: imported, never called | optional |
| 9 | `TransportResolver` and `LaunchComposer` | `createAgentRuntime` input | the composed CLI and SDK transports; machine credentials and MCP projection | Pi in process; hosted credentials; placement `cloud` | required, exists |
| 10 | Boot: re-issue queued prompts | `SessionRoutes().recoverQueuedPrompts()` | `workspace/runtime.ts` when the runtime is admitted | the object's constructor, inside `blockConcurrencyWhile` | required, not exercised by the test |

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

## Not yet proven

These would block a production Durable Object host:

- **Node imports:** ports 3 to 8 still reach Node. A production object would
  either keep `nodejs_compat` and accept that closure, or move each reach
  behind its port so the session core bundles without it.
- **Placement:** port 3 works today only through `AsyncLocalStorage` and the
  module-level registry. It is not a real port.
- **Interrupted turns:** the test restarts between turns. It does not evict an
  object mid-turn. A turn interrupted that way goes to the recovery path, and
  the test does not exercise it.
- **Queued prompts on boot:** the object does not call port 10, so it does not
  re-issue prompts that were still queued when it was evicted.
