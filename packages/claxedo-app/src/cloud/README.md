# Cloud workspaces

Owns: the cloud workspace as a placement of a project, its lifecycle machine, and the create, start, stop and delete commands with their failures.

## Concepts

- **Cloud workspace** (`CloudWorkspace`): a placement (`id: PlacementId`) of a project, with a name, an optional branch and the server-reported `status`. The name is required: every create form asks for it and the server refuses a create without one (`workspace_name_required`). A row shows the name, with the id as its tooltip. A workspace with no name of its own (or whose stored name is its id) is decoded with no name (`src/server/wire/workspace-name.ts`, once for every cloud row and placement: `CloudWorkspace.name` and `Placement.label` are absent), and every view names it through `useWorkspaceName()` (`view/workspace-name.ts`), which reads the dictionary's "Cloud workspace" with its branch, never the id.
- **Row** (`CloudWorkspaceRow`): a workspace with its effective `state`, the machine state the views draw.

## One home

- The server's status lives in the query cache: `server.queries.cloud.list()`, invalidated by the adapter on `cloudWorkspaceChanged`.
- The store keeps only what the server does not know: one pending command per workspace (`startRequested`, `stopRequested`, or the `commandFailed(reason)` of the last command).
- A row's state is derived, never copied: `cloudWorkspaceTransition(serverStatus, pending.event)` while the server's status is still the one the command was sent against; once the server reports a different status the pending entry no longer applies. There is no effect that copies the query into the store.

## State machine

`CloudWorkspaceStatus` (from `@/server`): `provisioning(step)`, `starting`, `ready`, `stopping`, `stopped` (said "Asleep"), `failed(reason)`. The server owns the lifecycle; the adapter maps it. Local events are optimistic: `startRequested` moves `stopped | failed | provisioning → starting`, `stopRequested` moves `ready | starting | provisioning → stopping`, `commandFailed` moves any state to `failed(reason)`, shown on the row until the next command or a new server status.

A create failure is shown by the create form; the workspace does not exist yet, so it has no row. A created workspace is then started through `server.cloud.start`, the same start as the row's Start: a Worker cancels the provisioning the create began once its response has been gone 30 seconds, and only a start request carries the boot to ready. A provisioning row offers Start for the same reason. A stop or delete re-reads the workspace catalog, which re-reads this list, so the row shows the server's status without waiting for an event.

## API

`useRunningCloudWorkspaces(enabled)` returns the same list machine and Start/Stop/Delete for every running workspace across projects (Settings → Usage → Cloud). `useCloudStatusText()` says a status in words; a provisioning step the server names (`acquiring_sandbox`, `cloning`, `starting_runtime`, `waiting_health`) is said as what it does, never as the step id. `useCloudWorkspaces(projectId, enabled)` returns the list machine (`loading`, `ready(rows)`, `failed(error)`) and the commands. The first run places a new project in the cloud through `server.cloud.create({ source, name })` directly, on a hosted plane and on a signed desktop alike: the signed account creates it, and its control plane derives the project. Rows come from `server.queries.cloud.list()` and commands go through `server.cloud`.

## Wake progress

`useWakeProgress(runtime)` (`view/wake-progress.ts`) is the one wording of a cloud workspace's start, used by the session screen's placement notice, the first run's Opening line and the terminal creator. It reads `server.cloud.runtime(id)` alone. While the runtime is `waking` it says the step the start is on ("Starting the machine", "Resuming the machine" or "Restoring your files" by boot path until the provider reports its machine takes commands, then, on a first start, "Downloading the workspace image", or, on a resume or a restore, whose machine already holds the image, "Starting the workspace" (only a driver that tells the two apart, Boat, reaches that step), "Starting the agent runtime", then "Connecting to the workspace" while the server, its runtime up, still delivers the runtime its settings), that step's time, the steps done ("Done: machine, workspace image"), and the whole wake's time once it differs from the step's; a start the server retries says "Start failed, retrying: <reason>" with the whole wake's time. Every time is the server's own measure (`steps`, see `src/server/README.md`), ticked by the app's one second clock (`useSecondClock`) only while there are times to show. There is no percentage and no estimate: the server keeps no earlier start's durations to estimate from. A start whose lease has recorded nothing yet names its boot path and no time. The line it sits under says "Starting <name>" for a fresh start and "Waking <name>" otherwise (`isFreshStart` in `src/server/placement-runtime.ts`): a start is fresh when the server names its boot mode `cold-start`, or names none yet for a start this app follows rather than began (a create's cold boot, or a start another tab or a session's tool asked for, until its first answer says it resumes).

## Machine size

`createMachineSizeChoice()` and `MachineSizeField` (`view/machine-size.tsx`) are the one machine-size choice for a new cloud workspace, used by New cloud workspace and meant for any other create surface. The sizes are the `machine_classes` of the driver new workspaces get, read from the sandbox listing (`server.queries.accounts.sandbox()`, `GET /api/claxedo/credentials/sandbox-drivers`), in size order. With none (the driver has one size, the listing is loading, failed or unsupported) the field draws nothing and `chosen()` is undefined, so the create sends no `machineClass` and the provider uses its own size. Otherwise Default is chosen until the reader picks another; a driver without Default starts at its first size. The create sends the choice as `machineClass` on both paths (`/api/workspace/create` for a project, the account's `workspace.create` for a repository), and the control plane refuses a size its driver lacks (`machine_class_unsupported`).

## Flows

- Flow 24: create, start, turn, stop, delete, and the failure shown (Worker + local sandbox driver).
- Flow 32: a project placed in a cloud workspace at creation.
