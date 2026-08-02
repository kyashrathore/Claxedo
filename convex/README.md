# `convex/`

The Convex backend: schema plus the function modules that run on Convex's
servers. This is the multi-tenant database layer — orgs, users, sessions,
billing, sandbox leases, workgraph.

## Tests live here

`*.policy.test.ts` beside the functions they test, per
[Convex's testing guidance](https://docs.convex.dev/testing/convex-test). They
drive the real function pipeline through `convex-test`, which means they go
**through** the builders in `model.ts` — `authedMutation`, `serviceMutation`,
`webhookMutation` — so identity requirements and internal-vs-public visibility
are exercised, not bypassed.

That matters because of where these tests used to live. They sat in
`packages/claxedo-server/src/`, imported these modules across five directory
levels, reached past the builders into `._handler`, and ran against a
hand-written `db` double. The double validated nothing, so several suites were
seeding rows the real schema rejects (missing `created_at`/`updated_at`, missing
`orgs.name`) and asserting authorization behavior against data that could never
exist in production.

## Running them

```sh
cd packages/claxedo-server && bun run test:convex
```

The config is `packages/claxedo-server/vitest.convex.config.ts`, not here,
because `convex/` has no `package.json` and is not a workspace member — it
cannot resolve `vitest` on its own. That package owns `vitest`, `convex-test`,
and `@edge-runtime/vm`, and points the runner at this directory via `root`.
`bun run test` in that package runs this suite after its own.

## Things convex-test does not do

It mocks the runtime rather than being it:

- **No cron support** — trigger scheduled functions directly from the test.
- Document and storage ID formats are not the production ones; don't assert on
  their shape.
- Text search is simplified prefix-matching with no relevance sorting; vector
  search sorts by cosine similarity without an index.

`environment: "edge-runtime"` is deliberate: it matches the Convex runtime more
closely than node, so a Node-only builtin fails in tests instead of on deploy.
For anything runtime-sensitive, still verify against a real deployment.

## Guards that scan this directory

Several suites enumerate `convex/*.ts` to assert repo-wide rules (every function
uses a mandatory builder; no unauthenticated public functions; every `.collect()`
is index-bounded; codegen lists every module). They all skip `*.test.ts` — the
test files are not function modules and Convex codegen never lists them.
