# @claxedo/server

Claxedo's control-plane / gateway server. Node-only Hono app.

## Package Boundary

This package is intentionally private while the public control-plane contract is
being split from the product server surface. The root source entrypoint still
exports app bootstrap, hosted control-plane composition, auth adapters, relay
helpers, tunnel/process utilities, telemetry, storage, and local paths for
first-party integration. Do not treat those root exports as a stable public
framework API.

A future public package should use the `@claxedo/control-plane` name or a thin
wrapper package with explicit stable exports. Until then, publish/release checks
must keep `private: true`, run `bun run check:package-boundary`, and inspect
`npm pack --dry-run` before any archive leaves a developer machine.

## Workspace-Runtime Host Composition And Sandbox Image

claxedo-server owns the runnable **host composition** for the workspace
runtime. `@claxedo/workspace-runtime` ships primitives and an env-driven
composition seam; claxedo-server composes it with the kit's `startServer` in
`src/hosts/workspace-runtime/host-entry.ts`. Local/embedded launches and
in-sandbox launches share that single entrypoint, so composition cannot drift.

claxedo-server also owns the **sandbox image** (`scripts/sandbox`). Delivery is
bundle-first: `scripts/sandbox/build-sandbox-image.ts` esbuilds the host
entrypoint into a single artifact under `.build/`, both Dockerfiles `COPY
.build/` and symlink the bundle to `/usr/local/bin/workspace-runtime` (so the
sandbox-manager drivers' `ensureHost` command is unchanged). ACP executables
are operator dependencies: an image or VM installs the command named by its
runtime `harnesses` descriptor. An `npm publish` of
`@claxedo/workspace-runtime` no longer gates image builds; image/snapshot
versioning keys off the bundle build plus `SNAPSHOT_SCHEMA_VERSION`
(`packages/sandbox-manager/src/image.ts`).

## Local Env Files And Release Artifacts

Local `.env` and `.env.local` files are ignored in this package. Keep real
values local; use `.env.example` for placeholder names only.

The package manifest uses a `files` allowlist and `scripts/maintenance/check-package-boundary.ts`
fails if `npm pack --dry-run` would include non-example env files, generated
build output, package test artifacts, dependency directories, nested deploy
packages, lockfiles under `src`, or Dockerfiles under `src`.

## Test runner: Vitest

`package.json` `scripts.test` runs:

```sh
node ./node_modules/vitest/vitest.mjs run
```

This package uses **Vitest**, not `bun test`. The choice is intentional and
the rubric item Q13 ("pick one test runner per package") landed on this
combination for the following reasons:

- **Node-only target.** This package targets `node >=22 <25` (see
  `engines` in `package.json`). It is started in production with
  `node --import tsx src/main.ts`. There is no browser-condition concern
  here, so the main reason `claxedo-app` reaches for `bun test` does not
  apply.
- **`vi.mock` / `vi.hoisted` ergonomics match how this code is tested.**
  Several route tests rely on hoisted module mocks — see for example the
  workspace, provider-auth, and bootstrap route suites, which compose
  `vi.hoisted(() => ({ ... }))` with targeted `vi.mock(...)` calls for
  individual test files in isolation. Bun's `mock.module` is per-suite-run
  rather than per-file:
  a module mock installed by one test leaks into every other test that
  runs in the same `bun test` invocation unless every export of the
  mocked module is re-enumerated in every test that touches it. The
  existing tests would each need to grow into kitchen-sink mock
  declarations to be safe under `bun test`, which is an outsized cost
  to switch runners.
- **`tsx` already handles TypeScript loading** for the dev/start scripts,
  and Vitest's built-in TS support matches that toolchain without an
  extra preload step.

## Why a different runner from `claxedo-app`

The sibling `packages/claxedo-app` uses **`bun test`**, deliberately. The
mixed setup is intentional: each package picks the runner that fits its
constraints. See
[`packages/claxedo-app/README.md`](../claxedo-app/README.md) for the
frontend-side rationale (SolidJS `--conditions=browser`, override-resolver
reuse, speed).
