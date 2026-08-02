# Claxedo Server Scripts

Scripts are operator commands. Behavior proof belongs in Vitest or Playwright,
not in source-text audits or evidence manifests.

## `release/`

Publishes the pinned runtime npm package graph. Sandbox images consume these npm
artifacts; they must never copy workspace `src` into Docker.

## `sandbox/`

Builds sandbox images from already-published runtime packages.

## `deploy/`

Runs hosted deploy commands and Worker-safety checks. These scripts deploy or
dry-run deploy targets; they do not run smoke tests or browser tests.

## `smoke/`

Small live probes for deployed central/runtime contracts.

`smoke-workgraph.ts` verifies the deployed signed-auth boundary with three
short-lived Clerk Sessions: user A in organization A, that same user A in
organization B, and user B in organization A. It creates one disposable Stream
and Task for user A in organization A, then proves snapshot listing, guessed-ID
reads and mutations, and snapshot resume cursors are isolated across both the
organization and user boundaries. It runs the configured no-op execution profile
to a durable Attempt result and deletes the Stream through the public command
contract:

```sh
BASE_URL=https://central.example.com \
CLERK_SECRET_KEY=... \
WORKGRAPH_SMOKE_USER_A_ID=user_... \
WORKGRAPH_SMOKE_USER_B_ID=user_... \
WORKGRAPH_SMOKE_ORGANIZATION_A_ID=org_... \
WORKGRAPH_SMOKE_ORGANIZATION_B_ID=org_... \
WORKGRAPH_SMOKE_RECONCILE_TOKEN=... \
WORKGRAPH_SMOKE_HARNESS=opencode \
WORKGRAPH_SMOKE_AGENT=smoke \
WORKGRAPH_SMOKE_PROVIDER_ID=... \
WORKGRAPH_SMOKE_MODEL_ID=... \
WORKGRAPH_SMOKE_EFFORT=low \
WORKGRAPH_SMOKE_TOOLS_JSON='[]' \
bun run smoke:workgraph
```



## `maintenance/`

Package boundary guards. These prevent secrets, generated files, dependency
directories, nested deploy packages, and source-tree Dockerfiles from entering a
package archive.

`normalize-convex-sandbox-leases.ts` calls the service-token protected Convex
sandbox lease cleanup mutation. Use it during the sandbox-manager migration window:
deploy a build that still includes the cleanup mutation, run the command below,
then deploy the canonical schema that contains only `driver` /
`driver_resource_id` lease fields.

```sh
CLAXEDO_WORKSPACE_AUTHORITY_URL=... \
CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN=... \
bun run maintenance:normalize-sandbox-manager-leases
```
