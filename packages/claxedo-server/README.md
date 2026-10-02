# @claxedo/server

Claxedo's control plane. It deploys to Cloudflare as the Workers in
`src/deployments/hosted-workerd/`. The app and harness e2e suites boot the Worker.

Workspace runtime control tokens are generated separately for each workspace.
Setting `WORKSPACE_RUNTIME_CONFIG_TOKEN` in the control-plane environment no
longer overrides those credentials. The supervisor still delivers the generated
token to its own runtime through that runtime's environment.

## Package Boundary

This package is intentionally private while the public control-plane contract is
being split from the product server surface. The root source entrypoint still
exports app bootstrap, hosted control-plane composition, auth adapters, relay
helpers, tunnel/process utilities, telemetry, storage, and local paths for
first-party integration. Do not treat those root exports as a stable public
framework API.

A future public package should use the `@claxedo/control-plane` name or a thin
wrapper package with explicit stable exports. Until then the manifest keeps
`private: true` and the package is never packed or published.

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

## Control-plane D1 schema

`migrations/control-plane/0001_baseline.sql` is the whole control-plane schema,
generated, never hand-edited. To change it, add a numbered migration beside it,
run `bun run d1:baseline:generate`, and review `git diff migrations/control-plane/`:
the generator applies everything to an empty SQLite database, rewrites the
baseline from `sqlite_master` (sorted, so the diff shows only the new schema),
and deletes the folded files. No rows survive. `bun run d1:baseline:check`, run
by the package suite, fails while a migration sits unfolded or the baseline is
not the generator's output.

A deploy installs the baseline into an empty database and refuses any other
(older history, an earlier baseline, untracked tables), since rows are never
converted: delete that database with `wrangler d1 delete <name>` and deploy again.

## Local Env Files

Local `.env` and `.env.local` files are ignored in this package. Keep real
values local; use `.env.example` for placeholder names only.

## Test runner: Vitest

`package.json` `scripts.test` runs:

```sh
node ./node_modules/vitest/vitest.mjs run
```

This package uses **Vitest**, not `bun test`. The choice is intentional and
the rubric item Q13 ("pick one test runner per package") landed on this
combination for the following reasons:

- **No browser target.** The suite runs under Node (`engines` in
  `package.json`), and the Worker code runs in its own `*.workerd.test.ts`
  and `*.miniflare.test.ts` files. There is no browser-condition concern
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

## Why a different runner from `claxedo-app`

The sibling `packages/claxedo-app` uses **`bun test`**, deliberately. The
mixed setup is intentional: each package picks the runner that fits its
constraints. See
[`packages/claxedo-app/README.md`](../claxedo-app/README.md) for the
frontend-side rationale (SolidJS `--conditions=browser`, override-resolver
reuse, speed).
