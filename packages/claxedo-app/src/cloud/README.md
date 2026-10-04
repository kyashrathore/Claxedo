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

`CloudWorkspaceStatus` (from `@/server`): `provisioning(step)`, `starting`, `ready`, `stopping`, `stopped`, `failed(reason)`. The server owns the lifecycle; the adapter maps it. Local events are optimistic: `startRequested` moves `stopped | failed | provisioning → starting`, `stopRequested` moves `ready | starting | provisioning → stopping`, `commandFailed` moves any state to `failed(reason)`, shown on the row until the next command or a new server status. A provisioning row permits an explicit Start so a browser reload or interrupted background boot can continue on the existing lease.

A create failure is shown by the create form. Once a project workspace is created, the store starts it through the shared wake owner and displays boot failures on that workspace's row, so retry uses the existing workspace. The form remains busy through startup. Workspace refresh invalidates the cloud list as well as placements and projects, so the created row and final runtime status appear without a page reload.

Successful stop also awaits the shared workspace refresh. The list reads the resulting authoritative status instead of remaining on its optimistic `stopping` state when no lifecycle event arrives. Deletion uses that same refresh; it does not invalidate the cloud list a second time.

The stop regression adds 19 counted test lines while the shared refresh removes two production lines. The aggregate app budget is the exact resulting 97,203 lines; file-size limits are unchanged.

The explicit startup flow and its transition regression bring Projects and cloud to 3,026 counted lines. Together with the explicit draft wake action and cloud-list refresh regression, the app measures 96,766 lines. Aggregate budgets use those exact measurements; no file-size limit changed.

## API

`useCloudWorkspaces(projectId, enabled)` returns the list machine (`loading`, `ready(rows)`, `failed(error)`) and the commands. The first run places a new project in the cloud through `server.cloud.create({ source })` directly, on a hosted plane and on a signed desktop alike: the signed account creates it, and its control plane derives the project. Rows come from `server.queries.cloud.list()` and commands go through `server.cloud`.

## Flows

- Flow 24: create, start, turn, stop, delete, and the failure shown (Worker + local sandbox driver).
- Flow 32: a project placed in a cloud workspace at creation.
