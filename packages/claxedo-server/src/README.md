# `claxedo-server/src`

This package is the composition point where several `@claxedo/*` packages
become one running product. Three roles, three directories:

| dir | role | contents |
| --- | --- | --- |
| `hosts/` | we **host** these packages | `workgraph/`, `wakes/`, `agent-extensions/`, `workspace-runtime/` — one dir per `@claxedo/<pkg>` |
| `adapters/` | we **adapt** these backends | `central-store/` — each adapts exactly one external thing. The Relay adapter moved to `@claxedo/server-core/adapters/relay`, which both products use. |
| `platform/` | layer-organized shared machinery | `auth/`, `db/`, `errors/`, `http/`, `runtime/`, `telemetry/`, `governance/` |
| `deployments/` | we **compose** these modes | `self-hosted-node/`, `hosted-node/`, `hosted-shared/`, `hosted-workerd/`, `shared-routes/` |

Everything else is a feature domain, flat at `src/` root — `documents/`,
`billing/`, `channels/`, `session/`, `workspace/`, `credentials/`, `sandbox/`,
`connections/`, `agent-config/`, `opencode/` — plus `authority/`, the
identity/authorization/tenancy layer.

## Vocabulary that is easy to get wrong

**`local` vs `hosted` is TRUST, not hosting.** `CLAXEDO_DEPLOYMENT_MODE` is
`local` (unsigned, loopback-only) or `hosted` (signed multi-tenant, fails
closed at boot). *Self-hosting* — a user running this themselves — is a
different axis entirely and is **not** a code value: a self-hosted box on a
public domain with signed auth is `trust=hosted, runtime=node`. See
``@claxedo/server-core/authority/deployment-mode``.

**`.cf.ts` means workerd-only.** A file that cannot run outside the Cloudflare
runtime (Durable Object classes, `cloudflare:workers`, KV/R2 bindings). `hosted-*` files are NOT marked, because hosted runs on Node too.
Enforced in both directions by `deployments/hosted-workerd/worker.import-graph.test.ts`.

**`authority/` is the identity/authorization/tenancy layer**, not "the control
plane" (that is the whole package). `authority/http/` is that layer's wire
protocol; `authority/routes/` holds the JWKS router; `platform/http/` is
generic transport middleware shared by every deployment; `routes/` is the
product HTTP surface.

## Rules with teeth

These are enforced by tests, not convention — see `tests/governance/codebase-shape.test.ts`
and `deployments/hosted-workerd/worker.import-graph.test.ts`:

- **All SQL goes through drizzle tables.** Each domain owns its own
  `*.sql.ts` table definitions; `platform/db/schema.ts` barrels them for the
  migration generator. Hand-written
  `ClaxedoDB.raw().prepare(...)` in feature code fails the suite. One
  documented exception (``@claxedo/server-core/session/meta/index``, a dynamic cursor query).
  `authority/adapters/sqlite/` is a *separate* Node-only database with its own
  hand-rolled schema, deliberately kept out of the Worker bundle.
- **`test-support/` may not be imported by production modules.**
- **No Node-only module or package may enter the Worker import graph.**
- **The generic control-plane core stays Convex-free** — that is what keeps
  `trust=local` working with no Convex and no Clerk.
- **Polar stays inside `billing/`**, and never reaches the local entrypoints.

## Test kinds

| pattern | what it is |
| --- | --- |
| `*.test.ts` beside its subject | unit test |
| `integration/*.integration.test.ts` | boots the composed local server, drives it over HTTP |
| `*.workerd.test.ts`, `*.miniflare.test.ts` | run in a real Worker runtime |
| `governance/*` | asserts the shape of the codebase, not runtime behavior |
| `test-support/` | shared test-only helpers; `*.fixture.ts` are spawned subprocesses |
| `scripts/` | operator commands, never part of `bun run test` — see `scripts/README.md` |

Four `.mjs` files at `src/` root (`*-relay-fixture.mjs`, `text-imports*.mjs`)
are e2e subprocess entrypoints whose paths are hardcoded as spawn strings in
this repo's root `script/` and in `claxedo-app`'s Playwright specs. They look
like production code and are not; they cannot move without updating those
external callers.
