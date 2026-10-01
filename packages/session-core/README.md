# Session core

`@claxedo/session-core` owns session storage, harness orchestration, projection,
session HTTP routes and event delivery. Its composition entry is `.`;
`./access-policy` exports only the session route classification and access
policy, for readers such as the MCP tool inventory that must not load the core.
`createSessionCore(ports)` creates the bus, placement registry and event hub for
one owner. `workspace-runtime` supplies machine capabilities and mounts the
core's routes; a Durable Object host supplies its own ports.

A host creates a `RuntimeStore` with an injected `SqliteDatabase`, then calls
`core.createRuntime({ store, transports, launch, ... })`. The SQLite adapter owns
transaction mechanics: Node supplies its driver, and Cloudflare supplies
`durableObjectSqliteDatabase(storage)`. The core neither opens a database file
nor migrates stored state. Worktree and launch-ownership rows remain plain
records in the declared schema; machine code owns checkout creation, process
identity and retirement.

`core.sessionRoutes(runtime, options)` and `core.events(options)` share the
instance's bus, event hub and placement registry. Control frames and registered
worktrees cannot cross core instances, including instances serving the same
workspace id. A machine request enters its core through the machine host's
`AsyncLocalStorage` context; asynchronous PTY callbacks retain the bus of the
core that created that PTY.

| Port | Host responsibility |
| --- | --- |
| `placement.workspaceId`, `placement.directory` | Declare the owner and its root. |
| `placement.sessionIdWorkspace(id)` | Read authoritative placement before explicit-id creation; return the existing owner or no record. Required. |
| `placement.normalizeDirectory(path)` | Normalize the path spelling used in session rows and registered worktrees. |
| `placement.canonicalDirectory(path)` | Canonicalize path identity for event filtering, including machine symlink aliases. |
| `placement.containsDirectory(root, path)` | Define containment for the host's directory namespace. |
| `transports`, `launch` | Supply harness resolution, launch configuration, credentials and execution bindings. |
| `childSessions.deriveSessionId(identity)` | Derive a stable keyed child id synchronously or asynchronously. The machine adapter supplies HMAC; the core receives no key or synchronous crypto implementation. |
| `readAttachment(key, maximumBytes)` | Read bounded bytes as `Uint8Array`. Optional; absent capability answers image unavailable. The machine adapter validates filesystem reads; other hosts may use object keys. |
| `flushSessionDocuments`, `disposeSessionDocuments` | Optional Pages lifecycle capabilities. There is no machine implementation selected by the core. |
| `log.warn` | Optional diagnostic sink. |

`storeSessionRoutes({ store, subagentAdmission, deriveChildSessionId })` returns
the session route options every host answers from its own store: listings,
transcript reads, turn coverage, configuration, the durable prompt queue and
child-session records. A host spreads it into `core.sessionRoutes(...)` and adds
only what it alone supplies. A host boots in two steps once its store is open:
`store.recoverBusySessions()` ends the turns its previous instance left running,
then `recoverQueuedPrompts()` on the session routes re-issues the prompts still
queued.

IDs use Web Crypto. Harness child admission derives its deterministic key with
Web Crypto before lending the key to its synchronous admission store. The
harness contract does not export machine probe-cache storage.

`script/session-core-node-free.test.ts` scans every production source file and
the public entry's transitive first-party closure for Node imports, machine
globals and process-wide pins. Test fixtures may use machine adapters. Builds,
package suites and workerd acceptance are separate checks; the Node-free
ratchet alone does not prove a Durable Object host can launch a harness.
