# claxedo-server: platform layers + feature domains

Date: 2026-08-02. Supersedes the layout half of `2026-08-02-001`. Written after
the owner named the defect directly: *"storage, network, server, host, route,
deploy target all are entangled everywhere"* — verified true, see Evidence.

## The rule

Two buckets, each organized on a DIFFERENT axis. This is the whole plan:

- **`platform/` is LAYER-organized.** Reusable machinery grouped by what kind
  of thing it is. Knows nothing about any feature.
- **Domains are FEATURE-organized**, flat at `src/` root. Each owns its port,
  routes, service, and store, and CONSUMES platform layers.
- **`deployments/` composes** a chosen set of domains + platform per target.

One enforceable sentence:

> **platform never imports a domain. domains import platform. deployments
> compose both.**

That becomes a governance test (same shape as the existing Worker-boundary
guard), so the rule cannot rot the way the current implicit one did.

### Naming, decided

| question | answer |
|---|---|
| domains flat at root, or under `domains/`? | **flat** — `src/documents/`, `src/connections/` |
| shared bucket name | **`platform/`** |
| scope | **full re-cut**, planned then executed in gated waves |

## Evidence — why the current tree is entangled

Every item below was verified against the tree, not asserted:

- **`connections` lives in 3 places**: `hosts/connections` (5 files),
  `routes/workspace` (4), `adapters/storage` (1).
- **`store` means 4 things across 11 directories**: `adapters/credentials/store.ts`
  (backend selector), `hosts/connections/store-adapter.ts` (port impl),
  `documents/index-store.ts` (domain persistence), `channels/access-store.ts`
  (raw table access), plus 7 more.
- **`network/resolve.ts` is sandbox-driver code.** Its own header: *"converts
  hostnames and policy entries to CIDR blocks for sandbox driver APIs —
  Daytona: `networkAllowList`, Modal: `cidr_allowlist`."* It is in a
  domain-less `network/` directory.
- **`documents/` names its layers** (`port.ts`, `backend.ts`, `hosted-backend.ts`)
  while its ROUTES sit in `routes/documents.ts` — one column escaped the domain.
- **`credentials/` mixes axes in one flat dir**: backends (`local.ts`,
  `cloudflare.ts`, `envelope.ts`) beside operations (`rotate.ts`, `sync.ts`,
  `probe.ts`, `discovery.ts`) beside a non-credential feature (`pi-*.ts`).
- **`opencode` has two homes** (`opencode/` engine seam, `routes/opencode-compat/`)
  with no name saying which is which.
- **`hosts/` is neither axis.** It groups by "we compose a `@claxedo/*` package"
  — an implementation detail. That is why `connections` is split from its own
  routes and store.

Root cause: three prior passes each optimized a DIFFERENT axis (architectural
role, then filename family, then justification). No pass wrote down which axis
wins, so each left the previous one half-applied.

## Target

```
src/
  index.ts  central-runtime.ts          ← package exports pins, stay

  platform/                             ← LAYER-organized, no domain knowledge
    http/        proxy, security-headers, cors, sandbox-target-fetch, response
    db/          drizzle schema, migrations, ClaxedoDB, per-backend adapters
    auth/        identity, tokens, request guards, rate limit, web-crypto
    telemetry/   observability (error plane) + product events
    runtime/     bus, log, paths, lazy, region, process-events
    governance/  the codebase-shape tests

  workspace/     port routes service store  (+ supervisor, worktree, checkpoints)
  session/       port routes service store  (+ meta, harness, list, global)
  documents/     port routes service store  backends/{local,hosted}
  credentials/   port routes service store  backends/{local,cloudflare,envelope}
  connections/   port routes service store
  channels/      port routes service store
  billing/       port routes service store
  sandbox/       drivers, leases, network policy + CIDR resolution
  agent-config/  the 30-importer service + fanout
  opencode/      engine seam + compat routes
  tenancy/       orgs, memberships, org resolution (the "authority" domain half)

  deployments/   local/ hosted-node/ hosted-shared/ hosted-workerd/
  integration/   whole-server tests
  test-support/  test-only helpers
```

`authority/` SPLITS — that is the key move. Identity/tokens/guards are platform
machinery; org/tenancy resolution is a domain. Today they are one directory,
which is why "is this a layer or a feature" has no answer there.

`hosts/` DISSOLVES. `connections`, `wakes`, `agent-extensions`
become domains; that they wrap a `@claxedo/*` package stops being a directory
and becomes what it is — an implementation detail of that domain.
`workspace-runtime` folds into `workspace/`.

`cloud/` folds into the domains it projects for (`session/`, `workspace/`).
`network/` splits: policy CRUD to `sandbox/`, CIDR resolution to `sandbox/`.

## Wave plan

Each wave: typecheck → three sweeps (vi.mock, dirname/join/URL, stale-basename)
→ full suite → commit. Guards edited in a wave get fault-injected. See
`2026-08-02-001` for the nine string-path forms that bite on every move.

**W10.1 — build `platform/`, leave domains alone.** Prove the boundary on the
shared layer first:
- `http/` → `platform/http/` (already coherent)
- `lib/` + `region/` + `process-events` → `platform/runtime/`
- `observability/` + `telemetry/` → `platform/telemetry/{errors,product}/`
  (they are genuinely two planes with a Worker-safety boundary between them —
  keep the split, put them under one roof)
- `adapters/storage/` → `platform/db/`, with per-backend subdirs
- `authority/{auth,tokens,guards,web-crypto,request-*,rate-limit}` →
  `platform/auth/`
- `governance/` → `platform/governance/`

**W10.2 — add the boundary guard.** `platform/**` must not import any domain.
Fault-inject before trusting. This lands BEFORE the domain moves so every later
wave is checked as it goes.

**W10.3 — domains, one per commit**, cheapest first: `channels`, `billing`,
`connections`, `agent-config`, `documents`, `credentials`, `sandbox`,
`session`, `workspace`. Each pulls in its routes from `routes/`, its store, and
its backends.

**W10.4 — `authority/` split** into `platform/auth/` + `tenancy/`. Left late:
highest registry-pin density.

**W10.5 — dissolve `routes/`.** Whatever remains after domains have taken their
own is genuinely cross-cutting (bootstrap, events, internal-relay) — those go
to `platform/http/routes/` or a deployment.

**W10.6 — README + registry sweep.** `src/README.md` states the rule; every
`architecture-ownership.ts` path updated; final full gate.

## Cost, stated honestly

This is larger than every prior wave combined — it re-cuts `hosts/`,
`adapters/`, `routes/`, `authority/`, and every feature directory at once.
~700 files move. The mitigations are the ones that worked all session: one
domain per commit, a full-suite gate on each, and the boundary guard landing
early so the rule is enforced during the move rather than asserted after it.
