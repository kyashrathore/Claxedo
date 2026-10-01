# @claxedo/server

Claxedo's control plane. It deploys to Cloudflare as the Workers in
`src/deployments/hosted-workerd/`. `src/deployments/self-hosted-node/` is a
Node composition that is not deployed: the app and harness e2e suites and this
package's integration tests boot it.

## Machine operators in the Node composition

When the Node composition runs signed, machine-wide plugin configuration, machine enrollment and deleting a
workspace placed on this machine require an authenticated subject listed in
`CLAXEDO_OPERATOR_SUBJECTS` (comma-separated).
Use the stable user ID returned by the embedded issuer's signup/signin response,
not an email address or organization role. Configure this on the server and
restart it after adding or removing an operator. An empty list denies plugin
reads, activation, source management, signed-runtime handoff, enrollment and machine-placed
workspace deletion to all signed users. Ordinary workspace membership grants no machine
configuration authority. A provisioned cloud workspace is different: its deletion is the
control plane's decision about that stored workspace, and operating this machine does not
grant it.
The unsigned single-user deployment continues to require a loopback peer.

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

`migrations/control-plane/0001_baseline.sql` is the whole control-plane
schema, generated rather than written. To change the schema, add a numbered
migration beside it (for example `0002_task_labels.sql`), then fold it in:

```sh
bun run d1:baseline:generate
git diff migrations/control-plane/
```

The generator applies the baseline and every numbered migration to an empty
SQLite database, rewrites the baseline from `sqlite_master` (tables in
foreign-key order, then views, indexes and triggers, each sorted by name), checks
that the rewrite rebuilds the identical `sqlite_master`, and deletes the folded
migrations. Identical input gives identical bytes, so the diff shows only the
new columns, tables, indexes and triggers. No rows survive generation:
`insert` and `update` statements in a migration have nothing to convert.

`bun run d1:baseline:check`, also run by `scripts/control-plane-baseline.test.ts`,
fails while a numbered migration sits beside the baseline or the baseline is
not byte-for-byte the generator's output. When a merge deletes a migration
another branch edited, keep the deletion and restate the edit as a new numbered
migration before generating.

A deploy admits an empty control-plane D1 or one holding exactly the current
baseline. A database recording older migrations, holding an earlier baseline,
or carrying tables without a `d1_migrations` record is refused with the reset
command (`docs/deploy/staging-branch.md`).

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
- **`tsx` already handles TypeScript loading** where the e2e suites boot the
  Node composition, and Vitest's built-in TS support matches that toolchain without an
  extra preload step.

## Why a different runner from `claxedo-app`

The sibling `packages/claxedo-app` uses **`bun test`**, deliberately. The
mixed setup is intentional: each package picks the runner that fits its
constraints. See
[`packages/claxedo-app/README.md`](../claxedo-app/README.md) for the
frontend-side rationale (SolidJS `--conditions=browser`, override-resolver
reuse, speed).
