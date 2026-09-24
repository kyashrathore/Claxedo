# Cloud workspaces

Owns: the cloud workspace as a placement of a project, its lifecycle machine, and the create, start, stop and delete commands with their failures.

## Concepts

- **Cloud workspace** (`CloudWorkspace`): a placement (`id: PlacementId`) of a project, with a name, an optional branch and the server-reported `status`.
- **Row** (`CloudWorkspaceRow`): a workspace with its effective `state`, the machine state the views draw.

## One home

- The server's status lives in the query cache: `server.queries.cloud.list()`, invalidated by the adapter on `cloudWorkspaceChanged`.
- The store keeps only what the server does not know: one pending command per workspace (`startRequested`, `stopRequested`, or the `commandFailed(reason)` of the last command).
- A row's state is derived, never copied: `cloudWorkspaceTransition(serverStatus, pending.event)` while the server's status is still the one the command was sent against; once the server reports a different status the pending entry no longer applies. There is no effect that copies the query into the store.

## State machine

`CloudWorkspaceState`: `provisioning(step)`, `starting`, `ready`, `stopping`, `stopped`, `failed(reason)`. The server owns the lifecycle; the adapter maps it. Local events are optimistic: `startRequested` moves `stopped | failed → starting`, `stopRequested` moves `ready | starting | provisioning → stopping`, `commandFailed` moves any state to `failed(reason)`, shown on the row until the next command or a new server status.

A create failure is shown by the create form; the workspace does not exist yet, so it has no row.

## API

`useCloudWorkspaces(projectId, enabled)` returns the list machine (`loading`, `ready(rows)`, `failed(error)`) and the commands. `useCloudPlacer()` is what the add-project flow calls to place a new project in the cloud. `api.ts` types `server.cloud` and `server.queries.cloud` as a cast over `Server` until the adapter lands them.

## Flows

- Flow 24: create, start, turn, stop, delete, and the failure shown (Worker + local sandbox driver).
- Flow 32: a project placed in a cloud workspace at creation.
