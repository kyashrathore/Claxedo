# The session core in a Durable Object

The session core runs inside a Cloudflare Durable Object under workerd, with
no Node compatibility layer.
[`src/durable-object.node-test.ts`](../src/durable-object.node-test.ts)
bundles the object without `nodejs_compat` and fails if any Node builtin enters
the bundle. Through the object's `fetch` it proves five things:

- it creates a session;
- it sends a prompt and streams the turn over SSE;
- it reads the transcript back;
- it restarts the workerd process on the same storage and finds the same
  session and transcript, then prompts that session again;
- it evicts the object while a turn is streaming, and while a prompt is queued
  behind that turn, and reopens it (see [Eviction and boot](#eviction-and-boot)).

The production object is `SessionDO` in
[`packages/session-host`](../../session-host/README.md): one top-level Pi
session per object, Pi in process on Cloudflare's `PiHarness`, its tools on the
workspace machine. It composes the same pieces as the fixture below, with the
relay host token in front and the control plane as its access policy, and its
own test boots the bundled Worker under workerd with `nodejs_compat`.

The ports themselves are defined in the
[`@claxedo/session-core` README](../README.md). This note
records what a Durable Object supplies for each one, and what is still unproven.

## What the object composes

[`src/test-support/durable-object-host.ts`](../src/test-support/durable-object-host.ts)
builds one workspace's core in the object's constructor from this package
alone. It reuses three Node-free pieces of the core's test support:
`composeHost`, the scripted `FakeTransport`, which echoes each prompt, and the
Web Crypto child identity `hmacChildSessionId`.

1. `RuntimeStore` runs over `durableObjectSqliteDatabase(ctx.storage)`.
2. `composeHost` ([`src/test-support/host-composition.ts`](../src/test-support/host-composition.ts))
   builds the store's broker ports, its `RuntimeEventHub` and the agent runtime.
   It is the same composition `createHostFixture` wraps for the Node tests.
3. `createSessionCore` takes that event hub and the object's placement. It owns
   its own bus and placement registry.
4. `composeSessionRoutes(...)` builds the session routes from
   `storeSessionRoutes(...)`: the listings, transcript reads, queue and
   child-session records every host answers from its store. The machine
   runtime calls the same function and adds its `machine` port.
5. `core.events(...)` serves `GET /api/wr/events`.

The object never enters `AsyncLocalStorage` and never reads a process global.
Its workspace is the object's name, and placement comes from its own port.

## What each port is, per host

| Port | Machine (`workspace-runtime`) | Durable Object | Required |
|---|---|---|---|
| `SqliteDatabase` | `openNativeSqliteDatabase` (better-sqlite3 under Node) through `workspace-runtime/src/store-file.ts`, with file root, backups and PRAGMAs | `durableObjectSqliteDatabase(ctx.storage)` | required |
| Bus | the core's own; PTY and agent hooks publish on the bus of the core that created them | the core's own | required, by construction |
| Placement: `workspaceId`, `directory` | the runtime's target | the object's name; one synthetic directory | required |
| Placement: `normalizeDirectory`, `canonicalDirectory`, `containsDirectory` | `path.resolve`, `realpath`, path containment | trim, identity, `/`-prefix containment | required |
| Placement: `sessionIdWorkspace` | the control plane's session index, or the runtime's own store for a self-placed runtime (`storeBackedSessionPlacement`) | none: the object owns every session in its store | required |
| `childSessions.deriveSessionId` | HMAC with `node:crypto` (`host/child-identity.ts`) | HMAC with Web Crypto, asynchronously | required |
| `transports`, `launch` | the composed CLI and SDK transports, machine credentials | scripted in the fixture; in `SessionDO`, Pi in process with credentials, plugins and provider definitions held only for the turn they were delivered for (`launch.credentials()` answers none between turns) | required |
| `readAttachment` | bounded filesystem reads that never follow a link (`host/attachment-files.ts` through `workspace-files/open-without-following.ts`) | not supplied: tool images answer unavailable | optional |
| `flushSessionDocuments`, `disposeSessionDocuments` | Pages hydration (`routes/document-hydration.ts`) | not supplied | optional |
| Boot | `recoverBusySessions` when the store opens, then `recoverQueuedPrompts` once admitted | both, inside one `blockConcurrencyWhile` in the fixture; in `SessionDO`, inside `PiHarness`'s factory with lease adoption and `resumeDurableRuns` between them (see below) | required |

Each core owns its bus. Durable Objects of one class share an isolate, so a
process-wide bus would offer every workspace's stream every other workspace's
frames, including another workspace's queued prompts. The isolation case in
the test runs two workspaces in one isolate and asserts that neither sees the
other's frames.

## Eviction and boot

An evicted object loses everything in memory: the turn's admission, its
producer and the harness behind it. Its store keeps the session `busy` and
the turn lease the dead owner never released. The machine runtime has the
same problem after a crash, and the same two calls answer it at boot. The
object makes them in its constructor, inside `blockConcurrencyWhile`, so no
request reaches it before they finish:

1. `store.recoverBusySessions()` deletes every turn lease, settles every
   queued row still `dispatching` to `unknown` (no operation is left to report
   its outcome, so it is never resent and Remove can delete it), and commits a
   `session.interrupted` row for each busy or retrying session. That row moves
   the session to `interrupted` with a message explaining that the runtime
   restarted and a new message can continue the work. It ends the session's
   running tool calls with "Tool execution interrupted" and marks its pending
   permissions and questions stale. The text the turn had already streamed
   stays in the transcript. Last, every host child (a Claxedo child session)
   whose row still says a run is in progress is settled as `interrupted`
   under its parent, so it no longer counts toward the parent's active
   children. Unless the parent is archived, that result is owed to the parent
   as a wake naming the reply the child's newest turn opened, and is delivered
   like any other child result.
2. `sessions.recoverQueuedPrompts()` wakes every session that has an eligible
   queued row: one not held, and with no delivery attempt still outstanding.
   Each one runs as its own turn once the session is idle.

Deleting every lease is safe only because no turn from the previous owner can
still be running. A Durable Object gives that guarantee: Cloudflare runs at
most one instance of an object at a time.

The tests check the outcome at each boundary:

- A turn evicted mid-stream reads back as `interrupted`, with its partial text
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

### A run that survives eviction

`SessionDO`'s Pi run is durable: Pi committed each tool call before running
it, and `PiHarness` keeps a wake job whose alarm restarts an evicted object
while Pi has work. `PiHarness` resumes Pi as soon as its factory returns, so
the object boots inside the factory: `recoverBusySessions` ends the interrupted
turn as above, the control plane's turn lease the object stored is adopted
(`adoptSessionTurnLease`) and the turn's delivery fetched with it, and
`runtime.resumeDurableRuns` attaches the session, which installs Pi's
extensions and admits the live run as a continuation turn. The continuation
runs under the adopted lease, which is released when Pi goes idle; a refused
renewal aborts the run. Queued prompts are re-issued after that, from the
object's `onStart`.

## Not yet proven

These would block a production Durable Object host:

- **A delivery in flight at eviction:** a queued row that a delivery attempt
  had already claimed is not re-issued. Its outcome is unknown, so it stays
  ineligible until someone reconciles it. The tests don't cover this.
- **Stream continuity across an eviction:** the replay ring does not survive
  an eviction. A client must re-read the transcript after it reconnects.
- **Pages documents and tool images:** a Durable Object supplies neither
  port, so a hosted session has no Pages hydration and its tool images
  answer unavailable.
