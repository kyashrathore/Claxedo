# Supported Surfaces

This page separates code-supported package/runtime surfaces from product-owned
control-plane concerns.

## Supported Today

| Surface | Supported today | Source |
| --- | --- | --- |
| Standalone workspace runtime | `startServer(port, options)` | `packages/workspace-runtime/src/server.ts` |
| Embedded runtime Hono app | `createWorkspaceRuntimeApp(options)` | `packages/workspace-runtime/src/server.ts` |
| Low-level Workspace Host | `createWorkspaceHost(options)` | `packages/workspace-runtime/src/workspace/runtime.ts` |
| Core route mounting | `mountWorkspaceCore(app, upgradeWebSocket, { eventHub })` | `packages/workspace-runtime/src/workspace/core.ts` |
| Runtime config apply | `POST /api/wr/config`, `host.apply(snapshot)` | `packages/workspace-runtime/src/routes/config.ts`, `packages/workspace-runtime/src/workspace/runtime.ts` |
| Harness switching | Adapter is replaced when harness id, access, or connection changes | `packages/workspace-runtime/src/workspace/runtime.ts` |
| ACP harnesses | `AcpHarnessAdapter` | `packages/agent-sdk-runtime/src/harnesses/acp/index.ts` |
| Native Claude, Codex, Cursor, and Pi | `ClaudeHarnessAdapter`, `CodexHarnessAdapter`, `CursorHarnessAdapter`, `PiHarnessAdapter` | `packages/agent-sdk-runtime/src/harnesses/{claude,codex,cursor,pi}/index.ts` |
| OpenCode harness | `OpenCodeHarnessAdapter` | `packages/agent-sdk-runtime/src/harnesses/opencode/index.ts` |
| Agent event runtime | `createAgentEventRuntime`, harness adapters, projections | `packages/agent-event-runtime/src/index.ts` |
| Agent Extensions package | `@claxedo/agent-extensions` discovery, lifecycle, policy, materialization, and replay helpers | `packages/agent-extensions/src/index.ts` |
| Agent Extensions replay | `applyRuntimeAgentExtensions` during host config apply | `packages/workspace-runtime/src/workspace/runtime.ts`, `packages/agent-extensions/src/replay.ts` |
| Agent Extensions materializers | Exported from `@claxedo/agent-extensions`; compatibility re-exports remain in `workspace-runtime` | `packages/agent-extensions/src/materialize.ts`, `packages/agent-extensions/src/materializers/*`, `packages/workspace-runtime/src/index.ts` |
| Relay-attached runtime options | `workspaceRelayRuntimeOptionsFromEnv` | `packages/workspace-runtime/src/workspace-relay-env.ts` |
| MCP runtime tools | `@claxedo/mcp` CLI package | `packages/claxedo-mcp/package.json`, `packages/claxedo-mcp/src/server.ts` |
| Embedded personal WorkGraph core | Owner-scoped application service, `/api/workgraph` commands/snapshots/ordered changes, SQLite local adapter, hosted Convex core adapter, and MCP tools | `packages/workgraph/src/application`, `packages/workgraph/src/http`, `packages/workgraph/src/adapters`, `packages/claxedo-server/src/server.ts`, `packages/claxedo-server/src/hosted-app.ts` |

## Present But Not A Public Package Surface Yet

| Surface | Current status |
| --- | --- |
| `@claxedo/workgraph` npm package | Published at `0.1.0`. The package contains the personal contracts, embedded service/router, SQLite adapter, connector interfaces, and execution foundation. The control plane owns the Convex adapter. Hosted Source View/intake parity, the public adapter conformance kit, and deployed Cloud acceptance remain in progress. |

## Product-Owned Boundaries

| Surface | Current status |
| --- | --- |
| Agent Extension catalog policy | Curated catalog data and marketplace UX live in the product/control plane, not in `@claxedo/agent-extensions`. |
| Agent Extension auth and org UX | Workspace/user/org authorization and team-wide activation UX live in the control plane. The package exposes desired state and policy primitives. |
| Agent Extension fan-out | Server/supervisor code decides which connected workspace runtimes receive snapshots. The package materializes the snapshot it is given. |

## Example Packages In This Repo

| Example | Purpose |
| --- | --- |
| `examples/runtime-only-host` | Starts `@claxedo/workspace-runtime` with relay env options. |
| `examples/local-single-user` | Starts the local Claxedo server package. |
| `examples/headless-client` | Headless client for local smoke flows. |
| `examples/extension-client` | Exercises Agent Extension routes through the server package. |
| `examples/hosted-team` | Demonstrates hosted control-plane composition with Better Auth-style auth. |
