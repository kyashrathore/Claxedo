# Agent Notes For Workspace Runtime

`@claxedo/workspace-runtime` is reusable workspace infrastructure. Keep runtime-owned APIs neutral and put Claxedo product policy in integration adapters outside this package.

## Boundaries

- Runtime HTTP paths use `/api/wr/*`; do not add runtime-owned product-prefixed routes.
- Management mutation goes through `WorkspaceRuntimeManagementAuth` and currently uses `POST /api/wr/config`.
- Public mounting must choose an explicit exposure from `exposure.ts`.
- Runtime core may consume neutral `WORKSPACE_RUNTIME_*` environment variables. Translate Claxedo deployment env in `claxedo-server` before launching the runtime.
- Neutral defaults should write under `~/.workspace-runtime`, not legacy Claxedo home directories.
- Config apply status files under `.workspace-runtime/runtime-config/` are observability records. Keep them redacted: auth key names are okay, auth values and raw credential payloads are not.

## Public API

The public entrypoints are recorded in `docs/api-manifest.json` and enforced by `src/public-api.test.ts`.

- Keep the root import small: startup, host creation, exposure/management contracts, routes, and stable config types.
- Put lower-level host utilities under `@claxedo/workspace-runtime/host`.
- Put config apply and management-auth helpers under `@claxedo/workspace-runtime/config`.
- Put route constants and compatibility route helpers under `@claxedo/workspace-runtime/routes`.
- Do not grow the root export list without updating the manifest and explaining why a new OSS host author needs that symbol from the root.

## Verification

Before claiming a runtime boundary change is complete, run package-local checks from `packages/workspace-runtime`:

```sh
bun typecheck
bun test src/public-api.test.ts src/server.test.ts src/workspace-relay-env.test.ts src/workspace-host-service-auth.test.ts src/target.test.ts
bun run build
npm pack --dry-run --json
```

For the standalone OSS example:

```sh
bun --cwd ../../examples/runtime-only-host typecheck
bun --cwd ../../examples/runtime-only-host smoke
```

Run broader app/server checks when Claxedo integration code changes.
