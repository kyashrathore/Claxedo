# Claxedo harness

This package connects Claxedo to agent harnesses. The repo root `AGENTS.md` still applies; where the two differ, this file wins here.

## Parts

- **Core** (`src/contract/`, `src/broker/`, `src/registry/`, `src/capabilities/`, `src/translate/`): Claxedo's own concepts. It never imports a transport, a profile, or a vendor SDK.
- **Composition** (`src/compose.ts`): wires the registry to built-in and custom transport constructors. It may import the registry and every transport; only the package export imports it.
- **RPC** (`src/rpc/`): framing and request correlation over owned channels. It imports the contract and has no harness policy.
- **Transports** (`src/transports/<kind>/`): how we drive one kind of harness and read its events. A transport imports only `src/contract/`, `src/translate/`, `src/rpc/`, its profile, its own folder, its own vendor SDK, Node built-ins, `@claxedo/helpers` and `@claxedo/agent-runtime-contract`. `@claxedo/agent-runtime-contract` is the shared public contract. Each transport's translator lives in its `translate/` folder and the shared runner in `src/translate/`.
- **Profiles** (`src/profiles/<harness>/`): the documented format of a harness's skills, MCP config and plugins, and its delivery per transport. Every rule cites the doc it comes from. A profile never grants plugin authority.

## What a transport does and never does

- It implements `HarnessTransport` and the operation groups its harness supports, and declares its capabilities once.
- It starts every process through `services.spawn`.
- It never touches the store, answers a request, runs a goal loop, or decides when to title. It asks the broker.
- A native transport's `README.md` lists what it carries that ACP doesn't. When that list is empty, the transport goes.

## Remote harnesses

A harness Claxedo doesn't start gets only what its API accepts, through the one remote filter:
- never Claxedo's own MCP server or its bearer;
- never a stdio server;
- only HTTP or SSE servers the agent declares;
- no plugin tokens without the integration system's consent.

Never assume its files are ours, and never report a remote stop as proven.

## Areas that need extra care

- **Translators:** logic changes only in a corpus-proven slice with the owner's sign-off.
- **Requests:** the broker's contract is a security boundary. Who may answer is decided by the route; which request, which answer, grants and "save, then release" by the broker.
- **Credentials:** a transport reads credentials only from `StartInput`, which names the session's owner. Every turn in a session spends its owner's accounts, whoever sends it; the owner's own Pi profile runs for sessions owned by the machine owner on a desktop or loopback runtime, and its folder is never written.

## Process-wide state

None, except these owners, each with its reason in its folder's `README.md`:
- `src/translate/runtime.ts`: the constant set of event types that carry diagnostics;
- `src/transports/acp/translate/state.ts`: the process-wide sequence that names unserializable ACP content;

Adding an owner adds its exact path here; `bun run check` reads this list.

## No comments

Code carries no comments. Names, types and small functions say what the code does; each folder's `README.md` says why; the corpora and flows say how it behaves. Tool directives stay.

## Files and state

- A file stays under 300 lines and a function under 40. Split along responsibilities; never compress.
- No `utils`, `helpers`, `common` or `misc`.
- Any state with more than two values is an explicit machine.

## Errors

Typed errors from each transport's `errors.ts`, with a class, `retryable` and a cause. No `.catch(() => default)`, no empty `catch`, no silent fallback, no retry loop apart from a harness's own protocol recovery named in its `README.md`.

## Tests

Real stack first: flows against real harnesses and the scripted model server; the translator corpus at the provider boundary; the wire corpus at public entrypoints. Focused tests only where the invariant map says a flow can't reach an invariant deterministically. Every flow has a targeted red run.

## Checks

`bun run check` runs: no comments, size, core boundary, transport boundary, no policy in transports, process-wide state, no swallowed errors, no polling, one harness table, wire unchanged, budget. All at zero before a change is done. `bun run test:architecture-ratchets` after every import change.
