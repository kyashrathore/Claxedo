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
import { agentRuntimeEvent, type AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import { createClientPresentationProjection } from "@claxedo/agent-event-runtime/client-presentation"

const projection = createClientPresentationProjection({ sessionId: "ses_1", directory: "/work", assistantMessageId: "msg_1" })
const event: AgentRuntimeEvent = agentRuntimeEvent.textDelta({ delta: "hello" })
for (const frame of projection.ingest(event)) console.log(frame.payload.type)
```

The harness translators and the translation runner (`createAgentEventRuntime`)
live in `@claxedo/harness`: each transport's `translate/` folder and
`@claxedo/harness/translate`. This package keeps the event contracts, the
snapshot helpers and the projections.

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
- Integration: `@claxedo/agent-event-runtime/projections/debug-trace`
- Compatibility:
  `@claxedo/agent-event-runtime/client-presentation`

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
