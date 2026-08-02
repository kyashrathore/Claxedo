# claxedo-server: per-file review prompt + capability seams

Date: 2026-08-03. Follows `2026-08-02-004` (platform/domains), which is executed
through W10.3. Written after the owner reviewed the result and named what is
still wrong. Every claim below is verified against the tree, with the command
that verified it.

## The owner's findings, measured

| # | Owner's words | Measurement |
|---|---|---|
| 1 | "integration/ is all tests, governance too — but doesn't feel like it" | `integration/` = 10 files, **0 non-test**. `platform/governance/` = 12 files, 4 non-test, of which `architecture.ts` has **4 production importers** and `architecture-ownership.ts` has **0**. One directory, two natures. |
| 2 | "architecture.test? how can you have arch test" | `architecture.test.ts` imports `./architecture`, so it reads as that file's unit test. **1 of its 15 tests** actually covers it; the other 14 assert codebase shape. |
| 3 | "workspace/* workspace-runtime confusing" | Two trees: `workspace/` (domain) and `hosts/workspace-runtime/` (composes the external package). Plus `workspace/http/`, imported by **5+ other domains** — shared infra inside a domain. |
| 4 | "what is authority dir?" | Three things under one name: composition (`services.ts`), the tenancy domain (~1600 lines in `adapters/sqlite/`), and other domains' routes (`routes/session.ts` imports `../../session/meta`). |
| 5 | "backends? why plural, why utility files" | 4 files; **2 are backends** (`cloudflare`, `local`). `codex-auth-file.ts` writes a token file; `envelope.ts` wraps. |
| 6 | "operations/ — why not lib" | 8 of 10 are real verb-named use cases. **`verification-error.ts` is 11 lines of error types** — the exception proves the rule. |
| 7 | "why sandbox/provider/relay in adapter" | `relay`, `central-store` adapt an external package. `sandbox`, `credentials` are **domains** (they have `routes/`). **`provider-auth` imports nothing external at all.** |
| 8 | "routes/ should be pure Hono instances" | **25 of 49 files (51%)** in `routes/` dirs create no Hono app. Largest: `extension-support.ts`, 389 lines of business logic. |
| 9 | **"auth/db/permission — every file its own way"** | **12 distinct auth combinations across 26 route files.** 10 entry points: `requireAuthority` (24 files), `controlPlaneAuthContext` (26), `isLoopbackLocalRequest` (16), `bearerToken` (12), `signedOrError` (12), `requireServiceToken` (8), `authorizeProject` (6), `authorizeWorkspaceOpen` (6), `localOnlyProjection` (4), `internalAdminAuth` (3). |

**#9 is the one that costs real money.** The rest are navigation friction — a
newcomer takes longer to find things. #9 means a security change has 12 places
to land and no way to know you got them all. Everything else in this plan is
subordinate to it.

Counter-finding worth stating: **DB access is already fine.** `ClaxedoDB.use`
(13 files), `.transaction` (8), `.raw` (3), and **zero route files touch the DB
directly**. The layering the owner asked for already exists for persistence; it
is auth that lacks it. Do not "fix" the DB layer.

### The other cross-cutting concerns, measured

The owner named errors, rate limit, retries, telemetry, version and file storage
as belonging at top level rather than inside domains. Measured:

| concern | state | verdict |
|---|---|---|
| **retries** | **7 hand-rolled loops**, no shared helper: `workspace/supervisor/sandbox.ts`, 3× `adapters/sandbox/stores/*`, 2× `hosts/workgraph/*`, `authority/adapters/convex/retry.ts` | **Same class as auth.** A backoff-policy change has 7 landing sites. → `platform/runtime/retry.ts` |
| **errors** | 68 custom classes; **61 extend raw `Error`** with no shared base. Only `DocumentWorkspaceError` has descendants (11) | No common shape for status / code / retryability. → `platform/errors/` with one base |
| **rate limit** | 10 files, but already centred on `platform/auth/rate-limit.ts` | Mostly fine; the 4 in `workspace/routes` are call sites, not reimplementations |
| **telemetry** | already `platform/telemetry/{errors,product}/` | Fine — except `worker-telemetry.ts` sits in `platform/auth/` (W11.4) |
| **file storage** | concentrated in `documents/` (4 files) + 1 each elsewhere | Domain-owned and coherent. **Not** a scatter — leave it |
| **version** | 23 references in `documents/` | Document versioning is that domain's core concept, not a cross-cutting concern. Leave it |

So: **retries and errors need extraction; rate limit and telemetry are already
placed; file storage and version are correctly domain-owned.** Two of six.

### Cloudflare-specific code

`platform/` is **already CF-clean** — zero `cloudflare:workers` / `DurableObject`
/ `KVNamespace` / `R2Bucket` references. The `.cf.ts` convention holds there.

Two gaps outside it: `documents/hosted-managed.ts` and `documents/hosted-backend.ts`
use `R2Bucket` without the `.cf.ts` marker. Narrower than feared, but real — the
R2 object-store code should be extracted to a marked file (it is already the
subject of `documents/r2-conditional-object-store.miniflare.test.ts`, a test with
no matching source file).

### `workspace/http/proxy.ts` — the name is right, the location is wrong

The owner's read was that this is misnamed because nothing forwards requests.
**Checked, and it does forward:** line 214 `const res = await fetch(req)`, after
reconstructing the request against `hit.url` (a remote sandbox) or
`http://embedded-workspace-runtime.local`, minting an owner token, and setting
`x-forwarded-by`. It streams the response back. It is a genuine HTTP reverse
proxy and `proxy` is the honest word for it.

What IS wrong is where it lives. `workspace/http/` is imported by 5+ other
domains, so it is not the workspace domain's HTTP — it is shared runtime-proxy
infra parked inside a domain. → `platform/http/runtime-proxy/` (it is
domain-agnostic transport once `resolveWorkspaceRuntimeHit` is passed in), or
keep it domain-side and rename to `workspace/runtime-proxy/` so the name stops
competing with `workspace/routes/`.

### Core business logic vs utils

The owner asked what the rule is. Proposed and enforceable:

- **`platform/runtime/lib/`** — no domain vocabulary in the signature. `bus.ts`,
  `paths.ts`, `strings.ts`, `lazy.ts` qualify. A function taking a `Workspace` or
  returning a `CredentialMetadata` does **not**, however generic it looks.
- **domain root** — the domain's own rules and vocabulary.
- Test: could this move to another product unchanged? If yes, it is a util.

Today `platform/runtime/lib/` holds 10 files and all pass. The failures are the
reverse case — domain dirs holding utils, e.g.
`adapters/credentials/operations/verification-error.ts` (11 lines of error types
in an operations dir).

## Naming rule this plan enforces

> A directory name is a **falsifiable claim about every file in it**, and each
> claim is enforced by a test.

- `routes/` — every file exports a Hono app. (Today: 51% fail.)
- `backends/` — every file implements the port the parent names. (Today: 50%.)
- `hosts/` — every file composes an external `@claxedo/*` package. (Today: 3 fail.)
- `platform/` — no file imports a domain. (Today: passes, guarded since W10.2.)

Where a name can't be made true, the name is wrong. That is the test for every
rename below.

---

# Part 1 — The per-file review prompt

Reusable, for a fresh reviewer per area. Areas: `hosts/`, `authority/`,
`platform/`, `adapters/`, each domain, `deployments/`.

```
READ-ONLY review of <AREA> in packages/claxedo-server/src. Do NOT edit.

Architecture: platform/ = layer-organized shared machinery (http, db, auth,
telemetry, runtime). Domains = feature-organized, flat at src/ root, each
owning port/routes/service/store/tables. adapters/ = adapts an external
package. hosts/ = composes an external @claxedo/* package. deployments/ =
composes. Rule: platform never imports a domain; domains import platform;
deployments compose both.

For EVERY file, answer four questions. Cite evidence — a quoted header
comment, an import list, an export list, or a caller count. Never infer from
the filename; that error has already been made in this codebase twice.

  1. WHY DOES IT EXIST? What breaks if deleted? If nothing, say DEAD and give
     the importer count (0).
  2. IS IT IN THE RIGHT PLACE? Does the directory's claim hold for it?
     - in routes/     -> does it export a Hono app?
     - in backends/   -> does it implement the parent's port?
     - in hosts/      -> does it import an external @claxedo/* package?
     - in adapters/   -> does it adapt something external, or is it a domain
                         with routes/ and its own tables?
     - in platform/   -> does it import zero domains?
  3. IS IT NAMED RIGHT? Does the name say what it does? Flag: the same word
     meaning different things (hosted/store/service), the same thing named
     differently across dirs, a `.test.ts` that is not that module's test.
  4. HOW DOES IT DO AUTH? (Route/handler files only.) List every guard it
     calls. Then say which of the five postures it is:
       LOCAL_ONLY | SIGNED_USER | SERVICE_TOKEN | INTERNAL_ADMIN | PUBLIC
     If it does not fit exactly one, that is a finding — say why.

Also report: files >400 lines doing more than one job (name the jobs);
same-name/different-semantics pairs; test files whose location or name no
longer matches their subject.

Rank BLOCKER (wrong or broken) / SMELL (confusing) / NIT. Do not report what is
fine. No preamble. Evidence or it does not count.
```

**Fan-out discipline (learned this session):** reviewers run read-only in
parallel safely; **moves must be serial** — each does a repo-wide import
rewrite, and two at once corrupt each other. This bit three times today.

---

# Part 2 — The plan

Waves are ordered by *value per unit of risk*, not by size. Each wave: typecheck
→ 4 sweeps → full suite → commit, with every guard fault-injected.

## W11.0 — Delete the guard evasion (do this first)

`platform/auth/request-timeout.ts:20` is `["C","ONVEX"].join("")` with a comment
saying it exists "so this file carries no adapter token for the R8 guard to
flag." **Verified:** written plainly, R8 fails with
`expected ['auth/request-timeout.ts'] to deeply equal []`.

Move it to `authority/adapters/convex/timeout-config.ts` (its only callers are
`authority/sandbox-relay-target.ts` and `authority/adapters/convex/timeout.ts`),
write the constant plainly, confirm R8 green because the file is now legitimately
in the adapter.

Smallest wave here and the highest priority: a codebase that teaches people to
route around its own lints will not hold any boundary this reorg built.

## W11.1 — One auth seam (the wave that matters)

Today: 10 entry points, 12 combinations, 26 route files. Target: **five named
postures, one place each.**

```
platform/auth/postures.ts
  localOnly()      — loopback, unsigned, single-tenant
  signedUser()     — Clerk-verified user + org resolution
  serviceToken()   — machine-to-machine
  internalAdmin()  — operator surface
  publicRoute()    — deliberately unauthenticated (must be named to be allowed)
```

Steps:
1. Inventory every route file's current combination (the review prompt's Q4).
2. For each, name its posture. **Any file not fitting exactly one is a finding
   before it is a refactor** — that is where a real authz bug will be hiding.
3. Implement the five as middleware over today's primitives. No behavior change.
4. Convert one domain per commit, snapshotting the auth decision for every route
   before and after.
5. Guard: every Hono route is reachable only through a posture. Fault-inject.

Do NOT touch the DB layer in this wave. It is already correct.

## W11.1b — One retry seam, one error base

Same shape as W11.1, smaller and lower risk. Do it in the same stretch.

- **Retries.** 7 hand-rolled loops → `platform/runtime/retry.ts` exposing one
  `withRetry(fn, policy)`. Convert call sites one commit at a time; each keeps
  its own policy VALUES (a Convex mutation and a sandbox boot should not share
  a backoff curve) but stops re-implementing the loop.
- **Errors.** 61 classes extend raw `Error` → one `platform/errors/base.ts`
  carrying `code`, `status`, `retryable`. Migrate by domain. This is what lets
  `errorBody` stop guessing at status codes per route.

Guard: no `for (let attempt` / `while (attempt` outside `platform/runtime/retry.ts`;
no `extends Error` outside `platform/errors/`. Fault-inject both.

## W11.2 — Make `routes/` mean one thing

25 of 49 files are not routes. Move the non-Hono files out by kind:
- business logic → the domain's `service.ts` (`extension-support.ts` 389L,
  `signed-access.ts` 154L, `git-remote-derivation.ts` 141L)
- shared helpers → `platform/http/`
- `workspace/routes/user-hosted.ts` — a 23-line barrel that re-exports BOTH
  `userHostedConnectionInfo` (user's machine) and `hostedConnectionInfo` (our
  cloud). Delete it; callers import the owners directly.

Then guard: every file under a `routes/` directory exports a Hono app.

## W11.3 — Separate test-only from production

- `integration/` → `tests/integration/` (0 non-test files today).
- `platform/governance/` splits by nature, which is what makes it confusing:
  - `architecture.ts` → `platform/runtime/profile.ts`. It resolves
    `getHarnessMode`/`getSessionWriteMode`/`getWorkspaceProfile` at runtime and
    has 4 production importers. **It is not governance.**
  - `route-ownership.ts`, `deployment-compatibility.ts` → `platform/http/` and
    `deployments/` (they have production importers).
  - the shape-assertion tests + `architecture-ownership.ts` (0 production
    importers) → `tests/governance/`.
- Rename `architecture.test.ts` → `codebase-shape.test.ts`. It is not
  `architecture.ts`'s unit test — 1 of its 15 tests touches that module.
  Same for `billing/architecture.test.ts` → `billing/invariants.test.ts`.

## W11.4 — Fix directory names that lie

- `adapters/credentials` → `credentials/` (top-level domain; it has `routes/`,
  `operations/`, its own table).
- `adapters/sandbox` → `sandbox/` (same reasoning; it has `routes/`).
- `adapters/provider-auth` → `credentials/provider-auth/` — **it imports nothing
  external**, so it is not an adapter by any reading.
- `adapters/` keeps only `relay/` and `central-store/`, which genuinely adapt one
  external thing each.
- `backends/` → keep the name, move the two non-backends out
  (`codex-auth-file.ts` → `operations/`, it writes a token file).
- `operations/verification-error.ts` → `types.ts` or the domain root. 11 lines of
  error types is not an operation.

## W11.5 — `hosts/` boundary guard + drift

Verified: exactly **3 production violations** of hosts→deployments
(`wakes/wake-settlement-dispatcher.ts`, `workgraph/hosted.ts`,
`workspace-runtime/session-env.ts`). Small enough to fix now, and the guard would
have caught all three.

Also move the 3 drifted files with zero external-package imports:
`agent-extensions/{catalog,scan,machine-scan}.ts` → `agent-config/` (their real
consumer).

## W11.6 — Extract the tenancy domain

`authority/adapters/sqlite/workspace-authority.ts` (1156L) +
`workspace-authority-store.ts` (436L) hold `ensurePersonalOrg`, `ensureProject`,
`authorizeProjectForUser`, `workspaceRoleForUser`. As the reviewer put it, "the
SQLite-ness is incidental to ~80% of the file."

→ `tenancy/` domain, with the SQLite persistence behind it. Also move
`authority/routes/session.ts` (already imports `../../session/meta`) to
`session/routes/`. Largest wave; do it last, when the seams above are guarded.

## W11.7 — Vocabulary

Deferred to last because it is the widest diff and the least functional risk.
- `hosted-` → `cloud-` (the codebase already says `cloud`:
  `connections/routes/cloud-connection.ts`, `access === "cloud"`).
- `user-hosted-` → `tunnel-`. Not `self-hosted`, which already means a third
  thing (see `deployment-mode.ts`'s own warning).
- **Caveat:** `access === "user-hosted"` is a persisted DB/API string. That needs
  a migration, not a rename. File and symbol renames only.
- `store` means 5 things. Rule: `<domain>/store.ts` = own persistence;
  `-adapter` only for external-port implementations;
  `adapters/credentials/store.ts` (a backend selector) → `backend-registry.ts`.
- `workspace/http/` → `workspace/runtime-proxy/` (or `platform/http/runtime-proxy/`).
  The dir name currently competes with `workspace/routes/` while holding neither
  routes nor workspace-specific transport.

## W11.9 — Extend the `.cf.ts` convention

`platform/` is already CF-clean, so this is small: extract the R2 object-store
code out of `documents/hosted-managed.ts` (it is buried at lines ~530-609 and
already imported by `hosted-backend.ts` and `hosted-index.ts` as general infra)
into `documents/r2-object-store.cf.ts`.

Two things fall out: the `R2Bucket` reference gets its runtime marker, and
`documents/r2-conditional-object-store.miniflare.test.ts` — which today tests
code with no matching source file — gets a subject that matches its name.

Then extend `worker.import-graph.test.ts`'s bidirectional check: any file
referencing `R2Bucket` / `KVNamespace` / `DurableObject` / `cloudflare:workers`
must be `.cf.ts`. Fault-inject.

## W11.8 — Docs, and a guard for them

**7 stale path references across 3 READMEs**, including ones written during this
reorg: `authority/README.md` cites 4 files that moved to `platform/auth/` in
W10.1; `src/README.md` cites `governance/architecture.test.ts`.

Fix them, then guard: every path in a `.md` under `src/` must resolve. Docs that
describe structure decay silently through exactly these moves.

---

## Known landmine, not scheduled

`workGraphWorkspaceId` is exported twice with different signatures and
incompatible outputs — `workspace/worktree.ts:23` (directory → `workgraph_<hex>`)
and `hosts/workgraph/hosted-runtime.ts:1644` ((org,owner,scope) → `wg-<hex>`).
Both live, imported from separate paths, so **no active bug**. Rename the local
one `localWorktreeWorkGraphId` during W11.6 rather than as its own wave.

## Cost

W11.0 is minutes. W11.1 is the largest by risk (it touches every route's auth)
and should not be rushed or parallelized. W11.2–W11.5 are mechanical and gated.
W11.6 is the largest by file count. W11.7 is the widest diff and the safest.

If only one wave is ever done, do **W11.1** — it is the only one that changes
whether a security fix can be applied in one place.
