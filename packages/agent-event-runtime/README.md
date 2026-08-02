# Agent Event Runtime

Normalize Claude SDK, Codex, Cursor, and ACP event streams into one canonical,
replayable event model.

`@claxedo/agent-event-runtime` owns harness event normalization and projection.
It turns harness-native event frames from external agent harnesses into
canonical `AgentRuntimeEvent` values, then lets host packages project those
events into UI, compatibility, replay, or diagnostic formats.

The package is intentionally browser-safe. Hosts still own process management,
stdio, WebSocket, EventSource, storage, HTTP routes, and persistence.

## Install

```sh
npm install @claxedo/agent-event-runtime
```

## Quickstart

```ts
import { createAgentEventRuntime, type RawHarnessEvent } from "@claxedo/agent-event-runtime"
import { claudeSdkAdapter } from "@claxedo/agent-event-runtime/harnesses/claude"

const runtime = createAgentEventRuntime({
  harness: "claude-sdk",
  threadId: "thread_123",
  adapter: claudeSdkAdapter(),
})

const raw: RawHarnessEvent = {
  source: "claude-sdk",
  payload: { type: "result", subtype: "success" },
}

for (const event of runtime.ingest(raw).events) console.log(event.type)
```

`runtime.ingest()` translates one raw harness frame into zero or more
canonical `AgentRuntimeEvent` values. Swap in `codexAppServerAdapter()` or
`cursorSdkAdapter()` from the matching `harnesses/*` subpath to translate a
different harness's event stream the same way; the ACP harness adapter is
`createAcpEventTranslator()` from `harnesses/acp`.

## Agent-First Public Docs

Coding agents and host integrators should start with
[docs/agent.md](./docs/agent.md). If the model is not obvious yet, read
[docs/concepts.md](./docs/concepts.md) next. These docs define the package job,
mental model, stability labels, boundaries, recipes, and public API.

## Public Entry Points

The package ships public docs under `docs/`. Use
[docs/recipes.md](./docs/recipes.md) for import examples and
[docs/api.md](./docs/api.md) for the intended stable root API.

Entry point status:

- Stable: `@claxedo/agent-event-runtime`,
  `@claxedo/agent-event-runtime/contracts`
- Integration: `@claxedo/agent-event-runtime/harnesses/acp`,
  `@claxedo/agent-event-runtime/harnesses/claude`,
  `@claxedo/agent-event-runtime/harnesses/codex`,
  `@claxedo/agent-event-runtime/harnesses/cursor`,
  `@claxedo/agent-event-runtime/projections/debug-trace`
- Compatibility:
  `@claxedo/agent-event-runtime/projections/opencode-compat`

The package publishes built ESM and declaration files from `dist`.

## Architecture

For the data-flow model, the contract/core/harness/projection layers,
snapshot boundaries, determinism guarantees, and guides for adding a new
harness adapter or projection, see
[docs/architecture.md](./docs/architecture.md).

## Verification

Run package checks from the package directory:

```sh
cd packages/agent-event-runtime
bun test src
bun typecheck
bun run build
```

Do not run tests from the repository root. This workspace guards against root
test execution.
