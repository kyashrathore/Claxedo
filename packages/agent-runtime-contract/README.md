# `@claxedo/agent-runtime-contract`

Dependency-free canonical contracts for Claxedo agent sessions: execution
bindings, content and message shapes, capabilities, connection descriptors,
errors, file references, and the runtime event model. Every Claxedo runtime
package (`@claxedo/agent-event-runtime`, `@claxedo/agent-sdk-runtime`,
`@claxedo/workspace-runtime`) and every client that speaks to them imports
these types from here, so the wire contract has exactly one owner.

## Install

```sh
npm install @claxedo/agent-runtime-contract
```

## Usage

```ts
import { requireAgentExecutionBinding, AGENT_RUNTIME_CONTRACT_VERSION } from "@claxedo/agent-runtime-contract"

const binding = requireAgentExecutionBinding({
  sessionId: "session-1",
  workspaceId: "workspace-1",
  directory: "/work/one",
  connectionId: "native:pi",
  upstreamSessionId: "pi-1",
})
```

The package ships plain ESM plus type declarations and has no runtime
dependencies, so it loads under Node without a TypeScript loader.

## Versioning

`agent-runtime-contract` rides the runtime version track with the other
runtime packages (see `script/PUBLISH-ORDER.md` in the repository). A contract
change that consumers must react to bumps `AGENT_RUNTIME_CONTRACT_VERSION`.
