# claxedo-server source organization

Date: 2026-08-02. Derived from a nine-agent read-only review covering every
file in `packages/claxedo-server` (666 files). Every claim marked **[verified]**
was independently re-checked against the tree; `file:line` citations were
correct once — re-cite before implementing, this repo moves fast.

## Goal

Make the tree state what the package **is**. `claxedo-server` is not a feature
app — it is the composition point where many `@claxedo/*` packages become one
running product. It plays three roles, and none of them is visible today:

1. **Host** — of `workspace-runtime`, `wakes`, `connections`,
   `agent-extensions`
2. **Adapter** — of storage, auth, credentials, sandbox, relay
   (SQLite ↔ D1 ↔ Cloudflare KV)
3. **Deployment-mode composer** — local ↔ hosted trust, Node ↔ workerd runtime

Today's `src/` is ~23 sibling directories in which
`sandbox-manager-adapters/`, `workspace-runtime-integration/`, and
`relay-provider/` are **three different names for the same architectural role**.
A newcomer cannot infer the thesis from the tree.

Nothing here changes runtime behavior. Every wave is a `git mv` + import
rewrite, or a deletion of verified-dead code.

**Dependency:** plan `2026-08-02-002` (deployment-mode vocabulary) must land
**before Wave 4**, because the `deployments/` directory names encode its
`Trust`/`Runtime` split. Waves 0–3 are independent and may proceed in parallel
with it.

### Target layout

```
src/
  index.ts            ← PINNED (package.json exports ".")
  central-runtime.ts  ← PINNED (exports "./central-runtime")

  hosts/         connections/ wakes/ agent-extensions/
                 workspace-runtime/
                 ← "we host these @claxedo packages"
  adapters/      storage/ auth/ credentials/ sandbox/ relay/
                 ← "we adapt these backends"
  deployments/   local/ hosted-node/ hosted-workerd/
                 ← "we compose these modes"

  routes/ documents/ billing/ lib/ session/ workspace/ channels/
```

**The package root is not the problem** — 11 files, all tool-convention
anchored. No build output committed; `.env`/`.env.local` gitignored with only
`.env.example` tracked **[verified]**. Do not move root config:
`Dockerfile`/`fly.toml`/`wrangler.toml` paths are hardcoded in
`.github/workflows/deploy-control-plane.yml` and `deploy-worker-migration.yml`.

The problem is `src/`: **152 loose files** at top level (80 source + 72 test),
and flatness repeating one level down — `routes/` 100 files, `documents/` 45,
`credentials/` 37, all with zero subdirectories.
`control-plane/` is the one area already shaped right (ports at top,
`adapters/{d1,sqlite,worker}/`, `routes/`); its port layer imports **zero**
adapter code **[verified by grep]**. It is the proof the pattern works here.

## Vocabulary — what the directory names mean

These definitions belong in `src/README.md` as part of Wave 5. Getting them
wrong is how the current tree drifted.

**Two orthogonal axes, per plan `2026-08-02-002`** (execute that plan first —
this plan's directory names follow from it):

```ts
type Trust   = "local" | "hosted"     // unsigned-loopback ↔ signed multi-tenant
type Runtime = "node"  | "workerd"
```

- **`local`** — zero-config boot, unsigned, loopback-guarded. Default when the
  env var is absent; the OSS quickstart never sets it. *(Currently misnamed
  `self-host` in code — see 002.)*
- **`hosted`** — signed multi-tenant. Fails **closed** at boot unless signed
  auth, the token issuer, workspace authority, and service token are all
  configured:
  "A hosted deployment that cannot authenticate must be DOWN, not open."

**`hosted` ≠ Cloudflare, and `hosted` ≠ Claxedo-operated.** `hosted-node.ts:10`
imports the same `createHostedApp` as `worker.ts` **[verified]** — hosted runs on
workerd *and* in a Node container, and a user self-hosting on a public domain
with signed auth is `trust=hosted, runtime=node`. **"Self-hosting" describes who
operates the deployment, not its auth posture**, and is docs vocabulary only —
never a code value. Conflating these axes is the single biggest source of
confusion in the current tree.

That is why `deployments/` splits by **runtime within hosted**
(`hosted-node/`, `hosted-workerd/`) rather than by operator.

**`.cf.ts` = workerd runtime only.** Three tiers hide under "Cloudflare" today;
only one cannot run outside workerd:

| Tier | Meaning | Count | Marker |
|---|---|---|---|
| **workerd-only** | Durable Object classes, `cloudflare:workers`, KV/R2 bindings | ~7 | `.cf.ts` |
| **hosted** | Worker-safe subset; runs on both workerd and Node | ~57 | `hosted-` |
| **CF-service client** | Talks to a CF product over HTTP; runtime-agnostic | 1 | no marker |

`credentials/cloudflare.ts` is tier 3: it reaches Workers KV over
`CLAXEDO_CF_KV_URL` via **HTTP, not a Worker binding** **[verified]**. Its name
is already accurate; do not add `.cf.ts`.

### Why a suffix, and why `deployments/hosted-workerd/` still earns its place

`.cf.ts` sorts a file next to its `local-*` twin
(`documents/hosted-managed.ts` ↔ `local-managed.ts`); a `cf-` *prefix* would
re-scatter files alphabetically out of their feature group — the exact problem
being fixed. The suffix also composes with the existing `.workerd.test.ts` /
`.miniflare.test.ts` convention already in the tree.

`deployments/hosted-workerd/` is a *central* CF directory, and it earns that
because it sits beside `local/` and `hosted-node/`, making both axes legible in
one glance rather than singling one mode out. It holds composition roots and
runtime-specific infrastructure only — **not** every file that touches CF.

**The rule:** feature-internal deployment pairs stay with their feature
(`documents/{core,local,hosted}/`); `deployments/` holds composition roots,
entrypoints, and runtime-specific infra (the Durable Object classes,
`hosted-app.ts`, boot assertions).

`hosted-app.ts` gets its own `hosted-shared/` because it is mounted by **both**
hosted runtimes — filing it under either would misrepresent it, and it is one of
the two names pinned by `worker.import-graph.test.ts` (gate 3).

### The boundary is already machine-enforced

`worker.import-graph.test.ts` statically walks the transitive import graph from
`worker.ts`/`hosted-app.ts` and fails if a Node-only module enters. Its
`FORBIDDEN_BARE` list (`better-sqlite3`, `node:fs`, `node-pty`,
`@hono/node-server`, `posthog-node`, `modal`, `tokentracker-cli`…) and
`FORBIDDEN_LOCAL` list (`workspace-store`, `workspace-supervisor`,
`credentials/local`, `server.ts`, `central-runtime`…) are the real contract
**[verified]**. **The suffix is a comment; that test is the enforcement.**
Wave 3 makes the two agree mechanically.

## Move gates — what breaks when a file moves

Four mechanisms pin paths. `route-ownership.ts` is **not** one (it maps URL
prefixes, not file paths — move-safe) **[verified]**.

1. **`architecture-ownership.ts`** — 53 `module:` entries are root-relative path
   *strings*, existence-checked by `architecture.test.ts` via
   `fs.existsSync(path.resolve(import.meta.dirname, entry.module))`.
2. **`architecture.test.ts`** — 272 hardcoded path literals **[verified]**. Also
   string-*content* asserts against exact files, e.g. asserting that `server.ts`
   contains a specific lazy `import("./…")` literal at `:1261`; reads
   `server.ts`, `hosted-app.ts`, and `routes/documents.ts` by literal path at
   `:1057-1060`.
3. **`worker.import-graph.test.ts`** — `SRC = path.resolve(import.meta.dirname)`
   and `ENTRYPOINTS = ["worker.ts","hosted-app.ts"]` at `:21-22`. **Fails
   silently-wrong** (walks a stale directory) rather than red.
4. **External config** — `package.json` `exports` pins `src/index.ts` and
   `src/central-runtime.ts`; `scripts` pin `src/main.ts` and `src/hosted-node.ts`;
   `wrangler.toml main` and `Dockerfile CMD` pin `src/worker.ts` / `src/main.ts`.

Also: `src/billing/` must keep that literal directory name —
`billing-architecture.test.ts` matches `path.sep + "billing" + path.sep`.
Subdirectories under it are fine.

**Fan-in is low, so moves are cheap.** Only five root modules exceed 10
importers: `workspace-store` 47, `bus` 25, `log` 24, `paths` 22, `agent-config`
20; everything else is 1–3 **[verified]**. Registry updates, not moves, are the
cost — which is why Wave 1 precedes every move.

---

## Wave 0 — delete verified-dead code

Zero dependencies. Each confirmed by repo-wide grep on the *exported symbol*,
not just the import path.

| File | Evidence |
|---|---|
| `src/text-imports.mjs` | consumers use `../workspace-runtime/src/text-imports.mjs` (package.json scripts + `Dockerfile:79`) |
| `src/text-imports-loader.mjs` | only referenced by the above |
| `src/public-api.d.ts` | zero references in the package |
| `src/execution-reconciler.ts` + `.test.ts` | its only exported reconciler is used solely by its own test |
| `src/user-hosted-relay-fixture.ts` | dead twin; the spawned one is the `.mjs` |
| `src/workspace-runtime-integration/index.ts` | 6-line barrel, zero importers |

Also drop the stale `src/cloud/cloudflare-worker/.sandbox-build/**` exclude in
`vitest.config.ts` — that path does not exist.

**DoD:** `bun run typecheck` clean; suite green; ~8 files gone.

## Wave 1 — shrink `architecture.test.ts` (the unlock)

**Before any move.** ~30 of 43 tests are text-greps over source; removing them
drops most of the 272 path literals and much of the 53-entry registry, making
every later wave dramatically cheaper. Reversing this order means paying
registry tax on every single file moved.

**Delete (~30 tests).** The tell is at `:783` — banned words written as
`filesContaining("ensure" + "WorkspaceRuntime")`, string-split so the test does
not match *itself*. That is a grep with a self-collision workaround. It cannot
distinguish an import from a comment from a variable name; a legitimate rename
turns it red. Same category:

- `:190` tombstone list asserting ~55 retired paths don't exist (`harness/*`,
  `process/*`, `pty/*`, `mcp/*`) — absent from git history (squashed at the
  hard-fork) **[verified]**, so it asserts the absence of things no current
  contributor has seen. A file that does not exist cannot be imported.
- `:968` hardcodes a full alphabetical listing of every file in `routes/`.
  Adding one route breaks it — a lockfile for a directory listing.
- The vocabulary tests must exempt their own registry:
  `expect(filesContaining("cloud/lifecycle")).toEqual(["architecture-ownership.ts"])`.

**Keep (~8), rewritten as import-graph assertions.** These encode constraints
TypeScript cannot express, where violation costs real money — a Worker
importing `better-sqlite3` fails at *deploy time*, not compile time:

- `:139` workspace-runtime must not import claxedo-server (circular package dep)
- `:361` generic control-plane core stays free of hosted-only storage adapters
  (what keeps self-host working on plain SQLite)
- `billing-architecture.test.ts` Polar confinement to `src/billing/**`
- the Worker-safety guards

`worker.import-graph.test.ts` is the model — it walks the real graph and follows
renames (a comment documents it surviving `sync-db.ts` → `central-store.ts`).

**Caveat, stated honestly:** this repo has exactly one commit touching
`architecture.test.ts` (`728cedf2a "Initial release"`) **[verified]** — history
was squashed, so there is no evidence these guards ever fired. Judge on
mechanism, not track record.

**DoD:** 1263 lines → ~300. Each kept invariant fails when deliberately
violated — inject the violation and watch it go red; a green suite is not proof.

## Wave 2 — mark the workerd-only tier

Six files. Both Durable Object classes defined in this package get `.cf.ts`
(`ClaxedoWakeLane` in `worker.ts:73` is a subclass of the local `WakeLane`,
imported at `worker.ts:47` **[verified]**).

| Old | New |
|---|---|
| `live-sync-room.ts` | `deployments/hosted-workerd/live-sync-room.cf.ts` |
| `live-sync-room.test.ts` | `deployments/hosted-workerd/live-sync-room.cf.test.ts` |
| `live-sync-room.workerd.test.ts` | `deployments/hosted-workerd/live-sync-room.workerd.test.ts` |
| `wakes-host/wake-lane.ts` | `deployments/hosted-workerd/wake-lane.cf.ts` |
| `control-plane/http-idempotency.ts` | *assess — CF types only; may not qualify* |
| `documents/r2-conditional-object-store.miniflare.test.ts` | unchanged (already marked) |

**`wrangler.toml` binds on `class_name`, not file path** **[verified — lines
156/162 name `ClaxedoWakeLane` and `LiveSyncRoom`]**, so these renames touch only
TypeScript imports. `live-sync-room.ts` has 3 importers: `worker.ts`,
`hosted-app.ts`, `routes/hosted-shell.ts`.

Do **not** rename `worker.ts` or `hosted-app.ts` (gate 3). Do **not** mark the
57 `hosted-*` files — they run on Node too.

**DoD:** `wrangler deploy --dry-run` succeeds; DO migrations untouched;
typecheck clean.

## Wave 3 — enforce the marker

Extend `worker.import-graph.test.ts`: a `.cf.ts` file must be reachable **only**
from the Worker entrypoint graph, and any file declaring a DO class or importing
`cloudflare:workers` must carry `.cf.ts`. The suffix becomes a checked
invariant instead of a comment.

**DoD:** adding a DO class without `.cf.ts` fails; importing a `.cf.ts` from
`server.ts` fails. Verify both by injecting the violation.

## Wave 4 — flatten `src/` root

Land the loose 152 into their homes. `index.ts` and `central-runtime.ts` stay
at root (exports pins).

```
deployments/local/           main.ts, server.ts, embedded-auth.ts,
                             embedded-workspace-runtime.ts
deployments/hosted-node/     hosted-node.ts
deployments/hosted-workerd/  worker.ts + Wave 2 arrivals
deployments/hosted-shared/   hosted-app.ts  ← mounted by BOTH hosted runtimes
adapters/auth/           opencode-auth.ts, security-headers.ts, cors-origins.ts
lib/                     bus.ts, log.ts, paths.ts, lazy.ts
opencode/                opencode-{engine,events,mcp-sync}.ts + compat tests
session/                 meta/ (7), harness/ (2), global/, list.ts,
                         central-session-runtime.ts, config-fanout.ts
workspace/               supervisor/ (11), store/ (3), backing, runtime-startup
channels/                channel-*.ts, channels-*.ts, whatsapp-*.ts   (7)
worktree/                worktree-service.ts
governance/              architecture*.ts, route-ownership.ts + surviving meta tests
```

**Caution:** `worker.ts`, `hosted-app.ts`, `main.ts`, `hosted-node.ts` moving
into `deployments/` requires the 5 external-config edits (`wrangler.toml`,
`Dockerfile`, 3 `package.json` scripts) **plus** `worker.import-graph.test.ts`'s
`SRC`/`ENTRYPOINTS` constants — all in the same commit. This is the one wave
where a partial rename fails silently rather than loudly.

Order, cheapest first, **one cluster per commit**: `channels/` → `worktree/` →
`opencode/` → `lib/` → `session/` → `workspace/` → `deployments/` (last, with
config). Do `workspace-store.ts` **alone** — 47 importers, the largest diff in
the package.

**Stays at root deliberately:** `server-usage-limits.ts`,
`server-workspace-pty-proxy.ts` (existing `server-*` convention = "mounted into
`server.ts`"); the four `*.integration.test.ts` files (they test the whole
server, so root *is* their colocation); `sandbox-target-fetch.ts`
(registry-pinned, 9 importers); `agent-config.ts` (20 importers, no directory
owns it); `doorbell-event-contract.test.ts` and `frontend-api-contract.test.ts`
(must sit where both `./bus` and the claxedo-app mirror are reachable).

## Wave 5 — the thesis regroup

The payoff wave. Unify three naming conventions into one role-bearing tree.

```
connections-host/               → hosts/connections/
wakes-host/                     → hosts/wakes/
agent-extensions/               → hosts/agent-extensions/
workspace-runtime-integration/  → hosts/workspace-runtime/

storage/                        → adapters/storage/
credentials/                    → adapters/credentials/
provider-auth/                  → adapters/auth/provider-auth/
sandbox-manager-adapters/       → adapters/sandbox/
relay-provider/                 → adapters/relay/
control-plane/adapters/*        → stays (already correct)
```

`hosts/agent-extensions/` also resolves a real ambiguity: the current directory
name is identical to the npm package `@claxedo/agent-extensions`, so an import
path cannot tell you which you are in.

Write `src/README.md` in this wave: the three roles, the `hosted` vs `.cf.ts`
vocabulary above, and the rule that `deployments/` holds composition roots while
features keep their own `{core,local,hosted}` split.

**Leave alone:** `billing/` (cohesive, guard-pinned name); `cloud/` (3 live
Canonical files — its `Deleted` registry entries already point at removed
paths); `observability/` vs `telemetry/` (zero cross-imports; separate
error-plane vs product-plane with a Worker-safety boundary between them);
`storage/` internals (single backend, migrations already isolated).

**Churn:** ~117 files, plus 7 registry entries (`sandbox-manager-adapters/`
stores ×4, `agent-extensions/catalog.ts`, `provider-auth/service.ts`,
`relay-provider/index.ts`) **[verified]**. Land as one atomic commit per
directory; the registry edit must accompany its move or `architecture.test.ts`
fails immediately — which is the good failure mode.

## Wave 6 — subdivide the large directories

Apply `control-plane/adapters/`'s pattern: `{core,local,hosted}` inside each
feature, never one global bucket.

- **`routes/` (100 flat)** → `agent-config/` (8), `opencode-compat/` (12),
  `hosted/` (12), `workspace/` (14); ~19 true singles stay flat. Do **not**
  chase URL-hierarchy mirroring — one file often serves several prefixes and one
  prefix is served by several files. Prefix-by-filename-family is the stable axis.
- **`documents/` (45 flat)** → `core/`, `local/`, `hosted/`, `service/`, `legacy/`.
- **`adapters/credentials/` (37 flat)** → `backend/`, `verify/`, `rotate/`,
  `sync/`; `registry.ts`, `types.ts`, `secret-scope.ts`, `migrate.ts`,
  `engine-bridge.ts` stay at that directory's root.
- **`adapters/storage/`** → keep flat; only move the 3 `*.migration.test.ts`
  files next to the migrations they exercise.

## Out of scope — debt this relocates but does not fix

- `server.ts` 1700 lines / 31 route mounts; `routes/hosted-workspace.ts` 826
  lines mixing three sub-domains; ~90 lines of business logic inline in
  `hosted-app.ts`.
- **Typed schema bypassed [verified]:** `channel-access-store.ts`,
  `channel-delivery.ts`, `channel-run-audit.ts` make 28 raw `prepare()` calls
  against tables that have typed drizzle schemas in `storage/channel-*.sql.ts`
  and import none of them. A column rename fails at *runtime*, not compile time.
  The only such bypass in the package.
- **Dead schema [verified]:** `claxedo_terminal_session` is created, repaired,
  migrated, and tested — nothing in `src/` reads or writes it.
- **Latent npm leak:** `package.json` `files` includes `scripts/**/*` then
  excludes 4 paths; `bench/` and `drill/` were added later and never excluded —
  `npm pack --dry-run` confirms 5 such files ship **[verified]**. **But
  `"private": true` blocks publishing entirely**, so this is a trap to fix
  before private is lifted, not a live leak. Invert to an allowlist.

## Verification protocol

Per commit: `bun run typecheck`, then the full suite. Run
`architecture.test.ts`, `worker.import-graph.test.ts`, and
`worker-cron-drift.test.ts` **specifically** — they fail silently-wrong rather
than loudly.

The suite takes 210–280s, beating the 120s tool timeout; use the documented
runner. For every guard added or kept in Waves 1 and 3, inject the violation and
confirm it goes red before trusting it.
