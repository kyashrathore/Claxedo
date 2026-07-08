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
