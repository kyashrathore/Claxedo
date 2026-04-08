# Cloud Workspace vs Local Workspace Routing

Status: current as of 2026-03-20.

This doc describes the live routing split in `packages/claxedo-server`, not the older `SANDBOX_ENABLED` gateway architecture.

## Core Idea

`claxedo-server` is always the browser-facing entrypoint.

For each request it does one of two things:

- handles the request itself for control-plane and local-workspace behavior
- proxies the request to a per-workspace `workspace-runtime` when the route is runtime-owned and the resolved workspace is `kind: "cloud"`

There is no single global cloud/local flag anymore. The split is per workspace and per route.

## Current Request Flow

```text
browser
  -> claxedo-server
    -> local handlers or opencode compat
    -> workspaceRuntimeProxy
      -> workspace-runtime for cloud workspaces
        -> OpenCodeAdapter or ACPAdapter
```

## How `claxedo-server` Decides

Workspace resolution keys:

- `x-workspace-id`
- `x-opencode-directory`
- `?workspaceId=...`
- `?workspace=...`
- `?directory=...`

`packages/claxedo-server/src/workspace-store.ts` resolves or creates a workspace record. That record decides whether the target is:

- `kind: "local"`
- `kind: "cloud"`

## Route Ownership

`packages/claxedo-server/src/proxy.ts` splits incoming paths into two buckets.

### Always handled by `claxedo-server`

Exact paths:

- `/global/event`
- `/global/health`
- `/path`
- `/config`
- `/global/config`
- `/agent`
- `/command`
- `/api/claxedo/health`
- `/api/claxedo/track`
- `/api/claxedo/events`
- `/api/claxedo/bootstrap`

Path prefixes:

- `/provider`
- `/project`
- `/experimental`
- `/api/claxedo/agent-config`
- `/api/claxedo/session`
- `/api/claxedo/hook`
- `/api/claxedo/pty`
- `/pages`
- `/api/workgraph`

### Proxied to `workspace-runtime` for cloud workspaces

Exact paths:

- `/file`
- `/api/wr/health`
- `/api/wr/config`
- `/api/wr/acp-config-options`

Path prefixes:

- `/api/claxedo/process`
- `/api/claxedo/diff`
- `/api/claxedo/tunnel`
- `/session`
- `/permission`
- `/question`
- `/event`
- `/find`

If the resolved workspace is local, those routes stay in-process.

## Local Workspace Flow

Local workspaces are registered in `workspaces.json` with `kind: "local"`.

For local workspaces:

- session routes are handled inside `claxedo-server` via `AgentSessionRoutes`
- local agent execution comes from the local agent engine
- OpenCode-compatible config, provider, project, and command routes still live on `claxedo-server`
- some compat routes proxy to the upstream OpenCode server at `OPENCODE_URL`

## Cloud Workspace Flow

Cloud workspaces are registered in `workspaces.json` with `kind: "cloud"`.

For cloud workspaces:

1. `claxedo-server` resolves the workspace from `workspaceId` or directory
2. `workspaceRuntimeProxy` asks the workspace supervisor for a runtime
3. the supervisor ensures that runtime exists and has a URL
4. `claxedo-server` forwards the original request with:
   - `x-workspace-id`
   - `x-opencode-directory`
5. `workspace-runtime` handles the runtime-owned route
6. `workspace-runtime` talks to either:
   - OpenCode through `OpenCodeAdapter`, or
   - an ACP agent through `ACPAdapter`

Streaming responses such as SSE keep the runtime pinned until the stream closes.

## Relevant Files

- `packages/claxedo-server/src/server.ts`
- `packages/claxedo-server/src/proxy.ts`
- `packages/claxedo-server/src/workspace-store.ts`
- `packages/claxedo-server/src/workspace-supervisor.ts`
- `packages/workspace-runtime/src/server.ts`
- `packages/workspace-runtime/src/target.ts`

## Useful Environment Variables

Server:

- `CLAXEDO_SERVER_PORT`
- `OPENCODE_URL`
- `CLAXEDO_DATA_DIR`

Workspace runtime:

- `CLAXEDO_WR_PORT`
- `CLAXEDO_WR_DIRECTORY`
- `CLAXEDO_WR_WORKSPACE_ID`
- `CLAXEDO_AGENT_TYPE`
- `CLAXEDO_ACP_BINARY`
- `CLAXEDO_ACP_MODEL`

Cloud provider auth:

- `DAYTONA_API_KEY`
- `MODAL_TOKEN_ID`
- `MODAL_TOKEN_SECRET`
