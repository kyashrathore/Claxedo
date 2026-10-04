# `claxedo-server/src`

This package is the composition point where several `@claxedo/*` packages
become one running product. Three roles, three directories:

| dir | role | contents |
| --- | --- | --- |
| `hosts/` | we **host** these packages | `workspace-runtime/` — one dir per hosted `@claxedo/<pkg>` |
| `platform/` | layer-organized shared machinery | `auth/`, `db/`, `http/`, `runtime/`, `telemetry/`, `governance/` |
| `deployments/` | we **compose** these modes | `hosted-workerd/` (the deployed Workers), `hosted-shared/`, `shared-routes/` |

Everything else is a feature domain, flat at `src/` root — `documents/`,
`channels/`, `session/`, `workspace/`, `credentials/`, `sandbox/`,
`connections/`, `agent-config/` — plus `authority/`, the
identity/authorization/tenancy layer.

## Vocabulary that is easy to get wrong

**`local` vs `hosted` is TRUST, not who operates it.** `CLAXEDO_DEPLOYMENT_MODE`
is `local` (unsigned, loopback-only) or `hosted` (signed multi-tenant, fails
closed at boot). A user running their own Cloudflare deployment is `hosted`
too; the operator is not a code value. See
``@claxedo/server-core/authority/deployment-mode``.

**`.cf.ts` means workerd-only.** A file that cannot run outside the Cloudflare
runtime (Durable Object classes, `cloudflare:workers`, KV/R2 bindings). `deployments/hosted-shared/` contains the portable Hono composition that the Worker calls.

**`authority/` is the identity/authorization/tenancy layer**, not "the control
plane" (that is the whole package). `authority/routes/` holds the JWKS router; `platform/http/` is
generic transport middleware shared by every deployment; `routes/` is the
product HTTP surface.

## Rules with teeth

These are enforced by tests, not convention — see `tests/governance/codebase-shape.test.ts`:

- **All SQL goes through drizzle tables.** Each domain owns its own
  `*.sql.ts` table definitions. Hand-written
  `ClaxedoDB.raw().prepare(...)` in feature code fails the suite. One
  documented exception (``@claxedo/server-core/session/meta/index``, a dynamic cursor query).
- **`test-support/` may not be imported by production modules.**
- **No Node-only module or package may enter the Worker import graph.**
- **The generic control-plane core stays storage-agnostic** — that is what keeps
  `trust=local` working with no hosted authority and no hosted identity provider.

## Test kinds

| pattern | what it is |
| --- | --- |
| `*.test.ts` beside its subject | unit test |
| `integration/*.integration.test.ts` | drives composed routes over HTTP |
| `*.workerd.test.ts`, `*.miniflare.test.ts` | run in a real Worker runtime |
| `governance/*` | asserts the shape of the codebase, not runtime behavior |
| `test-support/` | shared test-only helpers; `*.fixture.ts` are spawned subprocesses |
| `scripts/` | operator commands, never part of `bun run test` — see `scripts/README.md` |
