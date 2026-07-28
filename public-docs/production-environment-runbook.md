# Production Environment Cutover Runbook

Internal ops runbook for creating the GitHub `production` environment and
performing the first Claxedo Cloud production cutover. This is the **one-time
setup** companion to `public-docs/deploy-runbook.md`, which owns steady-state
deploy and rollback doctrine and is not repeated here.

**Status as of 2026-07-28: production has never been deployed.** Everything
below is a plan against a verified-empty target, not a description of a running
system.

## Verified starting state

Every claim in this section traces to a command output.

| Fact | Evidence |
| --- | --- |
| Only two GitHub environments exist: `staging` and `staging - packages/claxedo-docs`. **No `production` environment.** | `gh api repos/kyashrathore/Claxedo/environments` → `total_count: 2` |
| `staging` has **no protection rules** (`protection_rules: []`, `can_admins_bypass: true`) | same response |
| Staging control plane is live and fail-closed | `curl https://claxedo-control-plane-staging.kanusdlp.workers.dev/api/claxedo/health` → `{"ok":true,"mode":"hosted-control-plane","localExecution":false}` |
| Staging mode surface is fully composed | `/api/claxedo/mode` → `{"mode":"hosted-control-plane","signedAuth":true,"authority":true,"relay":true,"relayResolver":true,"runtimeAccessTokenSigner":true,"hostTunnelTokenSigner":true,"deviceLogin":false,"workgraph":true}` |
| Staging relay Worker is live | `curl -o /dev/null -w '%{http_code}' https://claxedo-workspace-relay-staging.kanusdlp.workers.dev/health` → `200` |
| The **production** Worker names do not resolve — never deployed | `claxedo-control-plane.kanusdlp.workers.dev/api/claxedo/health` → `404`; `claxedo-workspace-relay.kanusdlp.workers.dev/health` → `404` |

### About `deviceLogin: false`

**This is expected, not a gap. Production should also read `false` at launch.**

`deviceLogin` is `!!plane.deviceAuthProvider`
(`packages/claxedo-server/src/hosted-app.ts:396`). `deviceAuthProvider` returns
`undefined` whenever `CLAXEDO_DEVICE_LOGIN_ISSUER` is unset
(`packages/claxedo-server/src/control-plane/hosted-services.ts:178-180`).
Device-code login is an unshipped Phase A feature that fails closed by design
until that issuer exists — see
`docs/plans/2026-07-17-001-review-remote-desktop-access-feasibility.md:80`
("fails closed 501 by design until `CLAXEDO_DEVICE_LOGIN_ISSUER` configured")
and `docs/tech-docs/claxedo-up-cli-plan.md:50`. Do not provision a device-login
issuer as part of this cutover; it is the `claxedo up` / `claxedo connect`
track, not a launch blocker.

## Part 1 — The real secret and variable inventory

The launch plan estimates "~30". That number is right **only for the GitHub
Actions layer**, and it is the smaller half of the problem.

There are **two separate inventories**, and GitHub Actions provisions only the
first:

| Layer | Count | Provisioned by | Consumed by |
| --- | --- | --- | --- |
| GitHub environment secrets + variables | **29 names** (9 secrets + 20 variables; 1 secret is a commented-out future TODO, so **28 live**) | GitHub UI / `gh` | the `deploy-*` workflows themselves |
| Cloudflare Worker secrets + Convex function env | see Part 1b | `wrangler secret put` / `bunx convex env set`, **by hand** | the running control plane and relay at runtime |

`public-docs/deploy-runbook.md:195` states this boundary explicitly: "GitHub
Actions deploys code but does not install Worker secrets or Convex function
environment variables."

### 1a. GitHub environment inventory (29 names)

Derived by enumerating every `secrets.*` and `vars.*` reference in
`.github/workflows/deploy-*.yml` plus the reusable workflow they call.

**Required/optional column semantics:** "required" means a workflow step
hard-fails when the value is empty — the guard is quoted in the notes.
"Optional" means the workflow proceeds.

#### Secrets (9)

| Name | Provider | Consumed by | Req? | Absent-behavior (verified guard) |
| --- | --- | --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare | `deploy-control-plane`, `deploy-claxedo-app`, `deploy-worker-migration`, `deploy-cloudflare-sandbox-worker` | **Required** | `deploy-control-plane.yml:114` + `:347` preflight `required=(...)` loop exits 1. **See the repo-level fallback hazard in Part 2 — this guard can pass on a staging credential.** |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare | same four | **Required** | same preflight loop |
| `CONVEX_DEPLOY_KEY` | Convex | `deploy-control-plane`, `deploy-convex` | **Required** | `deploy-control-plane.yml:347`; `deploy-convex.yml:47` `[ -n "$CONVEX_DEPLOY_KEY" ] \|\| exit 1` |
| `CLERK_SECRET_KEY` | Clerk | `deploy-control-plane`, `deploy-claxedo-app` | **Required** | `deploy-control-plane.yml:348`; also `deploy-claxedo-app.yml:38` loop |
| `CLERK_WEBHOOK_SECRET` | Clerk | `deploy-control-plane` | **Required** | `deploy-control-plane.yml:348`. Pushed into Convex by the `bunx convex env set CLERK_WEBHOOK_SECRET` step (`:391`) |
| `CLAXEDO_RUNTIME_ADMIN_TOKEN` | Claxedo | `deploy-control-plane`, `deploy-cloudflare-sandbox-worker` | **Required** | `deploy-control-plane.yml:348`. Also written to the Worker as `CLOUDFLARE_SANDBOX_API_TOKEN` via `wrangler secret put` (`:204`) — staging only, see gap S-3 |
| `FLY_API_TOKEN` | Fly | `deploy-relay` | **Required** *(for that workflow)* | Used at `deploy-relay.yml:64`; no explicit emptiness guard, but `flyctl deploy` fails unauthenticated |
| `CLAXEDO_RELAY_METRICS_TOKEN` | Fly/Claxedo | `deploy-relay` | **Required** *(for that workflow)* | `deploy-relay.yml:80` `[ -n "${METRICS_TOKEN}" ] \|\| { echo "::error::...the reconvergence check cannot run"; exit 1; }` |
| `CLAXEDO_RELAY_ADMIN_DRAIN_TOKEN` | Claxedo | `deploy-relay` | **Not live** | Referenced only inside a commented-out block (`deploy-relay.yml:101-105`). Do **not** provision it. |

#### Variables (20)

| Name | Provider | Consumed by | Req? | Notes |
| --- | --- | --- | --- | --- |
| `CLAXEDO_CONTROL_PLANE_URL` | Claxedo | control-plane, app, worker-migration | **Required** | Preflight `:348`; also the smoke `BASE_URL` (`:424`) and baked into the app build as `VITE_CLAXEDO_SERVER_URL` (`deploy-claxedo-app.yml:61`) |
| `CLAXEDO_WORKSPACE_RELAY_URL` | Claxedo | control-plane, worker-migration | **Required** | Preflight `:348`; passed to the Worker as `--var CLAXEDO_WORKSPACE_RELAY_URL` (`:419`) |
| `CLAXEDO_SANDBOX_BUILD_ID` | Claxedo | control-plane, worker-migration | **Required** | Preflight `:348`; `--var CLAXEDO_SANDBOX_BUILD_ID` (`:420`). Value comes from the `deploy-cloudflare-sandbox-worker` job summary (`:70-83`) |
| `CLAXEDO_APP_URL` | Claxedo | control-plane, app | **Required** | Preflight `:353`; verifies deployed `/workgraph` (`deploy-claxedo-app.yml:81`) |
| `CLAXEDO_PAGES_PROJECT` | Cloudflare | control-plane, app | **Required** | Preflight `:353`; `wrangler pages deploy --project-name` (`deploy-claxedo-app.yml:74`) |
| `CLAXEDO_PAGES_BRANCH` | Cloudflare | control-plane, app | **Required** | Preflight `:353`; `--branch` |
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk | control-plane, app, **release-claxedo** | **Required** | Preflight `:353`. Baked into the app AND the desktop binary — see gap D-1 |
| `VITE_CONVEX_URL` | Convex | control-plane, app, **release-claxedo** | **Required** | Preflight `:353`. Also the `CONVEX_URL` for the Clerk fixture sync (`:466`) |
| `CLAXEDO_RELAY_FLY_APP` | Fly | `deploy-relay` | **Required** | `deploy-relay.yml:79` hard-fails when empty |
| `WORKGRAPH_SMOKE_USER_A_ID` | Clerk | control-plane, app | **Required** | Preflight `:349` |
| `WORKGRAPH_SMOKE_USER_A_EMAIL` | Clerk | control-plane, app | **Required** | Preflight `:349` |
| `WORKGRAPH_SMOKE_USER_B_ID` | Clerk | control-plane | **Required** | Preflight `:349` |
| `WORKGRAPH_SMOKE_ORGANIZATION_A_ID` | Clerk | control-plane, app | **Required** | Preflight `:350` |
| `WORKGRAPH_SMOKE_ORGANIZATION_B_ID` | Clerk | control-plane | **Required** | Preflight `:350` |
| `WORKGRAPH_SMOKE_HARNESS` | Claxedo | control-plane | **Required** | Preflight `:351` |
| `WORKGRAPH_SMOKE_AGENT` | Claxedo | control-plane | **Required** | Preflight `:351` |
| `WORKGRAPH_SMOKE_PROVIDER_ID` | Claxedo | control-plane | **Required** | Preflight `:351` |
| `WORKGRAPH_SMOKE_MODEL_ID` | Claxedo | control-plane | **Required** | Preflight `:352` |
| `WORKGRAPH_SMOKE_EFFORT` | Claxedo | control-plane | **Required** | Preflight `:352` |
| `WORKGRAPH_SMOKE_TOOLS_JSON` | Claxedo | control-plane | **Required** | Preflight `:352`; use `[]` for the no-op profile |

**There is no "optional" tier in the GitHub layer.** `promote-production`'s
preflight (`deploy-control-plane.yml:346-357`) enumerates exactly **25 names**
(6 secrets + 19 variables) and refuses to start until all are non-empty. The
remaining 4 names are the `deploy-relay.yml` trio — `FLY_API_TOKEN`,
`CLAXEDO_RELAY_METRICS_TOKEN`, `CLAXEDO_RELAY_FLY_APP`, guarded separately at
`deploy-relay.yml:79-80` — plus the commented-out drain-token TODO.

Notably absent from every workflow: **no Sentry secret, no PostHog secret, no
Polar secret.** Those are runtime-only (Part 1b) — no CI step provisions them.

### 1b. Runtime inventory — provisioned by hand, not by CI

No workflow sets any of these. They are installed with `wrangler secret put` and
`bunx convex env set`, and they are the half most likely to be missed.

#### Control-plane Worker — boot-required (5 hand-provisioned)

Missing any one of these makes the Worker return **503 on every request**
(`worker.ts:235-256`), so the smoke's health check catches it immediately. All
five throw from `composeHostedControlPlane`
(`packages/claxedo-server/src/control-plane/hosted-services.ts:234-266`).

| Name | Guard | Notes |
| --- | --- | --- |
| `CLERK_JWT_ISSUER` | `hosted-app.ts:211`, `deployment-mode.ts:97-99` | `CLERK_ISSUER_URL` is accepted as an alternative |
| `CLERK_JWKS_URL` | `deployment-mode.ts:100-102` | Production Clerk instance's JWKS |
| `CLAXEDO_WORKSPACE_AUTHORITY_URL` | `hosted-app.ts:213-215` | Production Convex deployment |
| `CLAXEDO_RELAY_RESOLVER_TOKEN` | `hosted-services.ts:251-255` | **Must differ from `CLAXEDO_RUNTIME_ADMIN_TOKEN`** (`:256-261`) |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM` | `hosted-services.ts:262-266` | EdDSA PKCS8 |

Two more are boot-required but already handled: `CLAXEDO_SIGNED_CLOUD_AUTH` and
`CLAXEDO_DEPLOYMENT_MODE` are committed `[vars]` (`wrangler.toml:72-77`), and
`CLAXEDO_WORKSPACE_RELAY_URL` is injected as a `--var` by the workflow (`:419`).

#### Control-plane Worker — optional but launch-relevant

| Name | Absent-behavior |
| --- | --- |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM` | not published at JWKS (`hosted-control-plane-worker.md:84`) |
| `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` | relay-revocation queries to Convex fail; **must equal the Convex-side value** |
| `CLAXEDO_RUNTIME_ADMIN_TOKEN` | `/internal/workgraph/reconcile` unauthorized — the smoke uses it |
| `CLOUDFLARE_SANDBOX_API_TOKEN` + `CLOUDFLARE_SANDBOX_WORKER_URL` | **no sandbox driver ⇒ zero execution capability**, boots green anyway (`hosted-services.ts:171-176`) |
| `CLAXEDO_SENTRY_DSN` | Sentry no-ops cleanly (`wrangler.toml:46-47`) |
| `CLAXEDO_POSTHOG_KEY` / `_HOST` | telemetry no-ops (`worker-telemetry.ts:18`) |
| `CLAXEDO_POLAR_ACCESS_TOKEN`, `CLAXEDO_POLAR_WEBHOOK_SECRET` (secrets); `CLAXEDO_POLAR_SERVER`, `_PRODUCT_MONTHLY`, `_PRODUCT_YEARLY`, `_CHECKOUT_SUCCESS_URL`, `CLAXEDO_BILLING_PAST_DUE_GRACE_DAYS` (vars) | billing routes 503, sweep no-ops, **every org resolves to free tier** (`wrangler.toml:52-71`) |
| `CLAXEDO_HOSTED_CREDENTIALS_ENABLED` + `CLAXEDO_CREDENTIALS_KEK` + `CLAXEDO_CF_KV_URL` + `CLAXEDO_CF_KV_TOKEN` | **all-or-nothing group.** Enabling the flag without all three fails closed at boot, naming each missing piece — deliberately, so hosted org credentials can never fall back to the unencrypted local file store (`deployment-mode.ts:122-136`) |

#### Relay Worker (`packages/workspace-relay`)

Per `packages/workspace-relay/wrangler.toml:12-21`: required —
`CLAXEDO_RELAY_RESOLVER_TOKEN`, `CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM`,
`CLAXEDO_CONTROL_PLANE_JWKS_URL`. Optional — `CLAXEDO_RELAY_RESOLVER_URL` or
`CLAXEDO_CENTRAL_URL`, `CLAXEDO_RELAY_HOST_PUBLIC_KEY_PEM`,
`_NEXT_PUBLIC_KEY_PEM`, `_KID`, `_NEXT_KID`. **Unverified by me** (the header
comment is the source; I did not trace each guard) — owner should confirm
absent-behavior for the three "required" ones before relying on fail-closed.

#### Convex deployment (5 names) — and a **cutover ordering hazard**

`convex/auth.config.ts` reads env at **deploy time**:

```ts
domain: process.env.CLERK_JWT_ISSUER_DOMAIN ?? process.env.CLERK_JWT_ISSUER!,
applicationID: process.env.CLERK_JWT_AUDIENCE ?? "convex",
```

The `!` is a non-null assertion. If neither issuer variable is set on the
production Convex deployment, `domain` evaluates to `undefined` and the auth
provider config is pushed broken.

**The deploy workflow sets only `CLERK_WEBHOOK_SECRET`**
(`deploy-control-plane.yml:387-391`), and it does so *after*
`convex deploy` has already run (`:382-385`). So:

> **`CLERK_JWT_ISSUER_DOMAIN` (or `CLERK_JWT_ISSUER`) and
> `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` must be set on the production Convex
> deployment BEFORE the first `promote-production` run**, or the first
> production Convex push lands with a broken auth configuration. This is Step 4
> in Part 5 and it is ordered before the deploy for exactly this reason.

| Name | Set by | Required? |
| --- | --- | --- |
| `CLERK_JWT_ISSUER_DOMAIN` or `CLERK_JWT_ISSUER` | **manual, before first deploy** | **Required** |
| `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` | **manual** | Required for relay revocation; must equal the Worker value |
| `CLERK_WEBHOOK_SECRET` | workflow (`:391`) | Required for the Clerk→Convex identity mirror |
| `CLERK_JWT_AUDIENCE` | manual | Optional — defaults to `"convex"` |
| `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN_PREVIOUS` | manual | Optional — rotation only |

Convex crons deploy with the code and need no configuration
(`convex/crons.ts`): a 10-minute stale-runtime-lease sweep and a 6-hour
stale-billing-sync flag.

**Headline count.** 29 GitHub names + 5 boot-required Worker secrets + 3 relay
secrets + 2 manual Convex vars = **39 names for a minimum viable production
cutover**, rising past 55 if Polar billing, hosted credentials, Sentry and
PostHog are all enabled. The plan's "~30" covers the GitHub layer only.

### 1c. Staging-vs-required gaps (found before they bit production)

Method — names only, values never read:

```sh
gh api repos/kyashrathore/Claxedo/environments/staging/secrets   --paginate -q '.secrets[].name'
gh api repos/kyashrathore/Claxedo/environments/staging/variables --paginate -q '.variables[].name'
gh api repos/kyashrathore/Claxedo/actions/secrets                --paginate -q '.secrets[].name'
```

Staging has **7 secrets and 19 variables** configured. Diffed against the 28
live required names, exactly three discrepancies exist:

| # | Name | Kind | Finding |
| --- | --- | --- | --- |
| **G-1** | `CLAXEDO_RELAY_METRICS_TOKEN` | secret | **Latent staging bug.** Hard-required by `deploy-relay.yml:80`, absent from staging *and* from repo level. `deploy-relay.yml` **cannot currently run against staging** — it exits 1 at Preflight. |
| **G-2** | `CLAXEDO_RELAY_FLY_APP` | variable | **Latent staging bug.** Hard-required by `deploy-relay.yml:79`, absent. Same effect as G-1. |
| **G-3** | `CLAXEDO_RELAY_ADMIN_DRAIN_TOKEN` | secret | Not a gap. Commented-out future TODO (`deploy-relay.yml:101-105`). Correctly absent. |

Nothing is configured in staging that no workflow reads — there is no dead
configuration to clean up.

**Reading of G-1/G-2:** `FLY_API_TOKEN` *is* present in staging while the other
two Fly-path names are not, so the Fly relay path was started and abandoned.
The relay shape actually in service is the **Cloudflare relay Worker**, deployed
inside the ordered release by `deploy-control-plane.yml:173-178`, not the Fly
app. `public-docs/deploy-runbook.md:22` classifies `deploy-relay.yml` as "the
non-Cloudflare regional-container shape".

> **Owner decision OD-1.** Either provision `CLAXEDO_RELAY_METRICS_TOKEN` +
> `CLAXEDO_RELAY_FLY_APP` on both environments to make the Fly fallback real,
> or accept that `deploy-relay.yml` is dormant and do not provision them for
> production either. Do not half-provision: a Fly relay that exists but is
> never deployed by CI drifts silently from the code in `dev`.

## Part 2 — The repo-level fallback hazard (read before provisioning anything)

**This is the single highest-risk item in the cutover.**

`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` exist as **repository-level**
secrets (verified: `gh api repos/kyashrathore/Claxedo/actions/secrets`), in
addition to their environment-scoped copies in `staging`.

In GitHub Actions, an environment-scoped secret shadows a repo-level secret of
the same name, but when the environment does **not** define the name, the
repo-level value is inherited silently. Consequences:

1. `promote-production`'s preflight loop (`deploy-control-plane.yml:346-357`)
   tests only for **non-emptiness**. It cannot tell a production Cloudflare
   token from the repo-level one.
2. Therefore: **if the owner provisions the four missing production secrets and
   assumes `CLOUDFLARE_*` "are already there", the preflight passes and the
   production Worker deploys into the staging Cloudflare account.**
3. Because the production wrangler env is the *top-level* config, that deploy
   would create a Worker named `claxedo-control-plane` and bind an R2 bucket
   named `claxedo-documents` **inside the staging account** — a production-named
   deployment sitting on staging infrastructure, which is exactly the state this
   cutover exists to prevent.

**Mitigation is mandatory:** explicitly set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` on the `production` environment even if they "look
present". Verify with the name-listing call in Step 2 of Part 5 — an
environment-scoped name must appear in
`gh api .../environments/production/secrets`, not merely resolve at runtime.

> **Owner decision OD-2.** Consider deleting the repo-level `CLOUDFLARE_API_TOKEN`
> and `CLOUDFLARE_ACCOUNT_ID` after both environments define their own, so the
> silent-inheritance path stops existing. Blocker: `deploy-cloudflare-sandbox-worker.yml`'s
> `deploy` job (line 39-89) has **no `environment:` key** and depends on the
> repo-level values. Deleting them breaks that workflow until it is given an
> environment. Not an agent-safe change — it needs an owner call on which
> account builds the sandbox image.

## Part 3 — Account boundary: what must be separate

The rule is **production must not reuse any staging credential or resource.**
Below is what that means concretely, with the naming implications read out of
the wrangler configs.

### 3a. Cloudflare

`packages/claxedo-server/wrangler.toml` defines production as the **top-level**
config and staging as `[env.staging]`:

| Resource | Production (top-level) | Staging (`[env.staging]`) | Source |
| --- | --- | --- | --- |
| Worker name | `claxedo-control-plane` | `claxedo-control-plane-staging` | `wrangler.toml:17`, `:116` |
| R2 bucket | `claxedo-documents` | `claxedo-documents-staging` | `wrangler.toml:81`, `:133` |
| DO bindings | `WORKGRAPH_SETTLER`, `WAKE_LANE`, `LIVE_SYNC_ROOM` | same three, re-declared | `wrangler.toml:83-98`, `:135-149` |
| Cron trigger | `*/15 * * * *` | `*/15 * * * *` | `wrangler.toml:36`, `:121` |

`packages/workspace-relay/wrangler.toml`:

| Resource | Production | Staging | Source |
| --- | --- | --- | --- |
| Worker name | `claxedo-workspace-relay` | `claxedo-workspace-relay-staging` | `wrangler.toml:23`, `:39` |
| DO binding | `WORKSPACE_RELAY_ROOM` | same | `:30-32`, `:44-46` |

**Because the names already differ, a single Cloudflare account is technically
viable** — production and staging Workers/buckets would not collide. But a
shared account means one API token can destroy both, and the blast radius of a
leaked token spans production. A separate production Cloudflare account is the
stronger boundary; a shared account with two distinct least-privilege tokens is
the weaker but workable fallback.

> **Owner decision OD-3.** Separate Cloudflare account for production, or one
> account with distinct scoped tokens? If separate: `claxedo-documents` and both
> production Worker names must be created fresh there, and the workers.dev
> subdomain changes, which changes `CLAXEDO_CONTROL_PLANE_URL` and
> `CLAXEDO_WORKSPACE_RELAY_URL`.

**Verified R2 requirement.** A production deploy resolves the R2 binding
`CLAXEDO_DOCUMENTS` → bucket `claxedo-documents`. Confirmed by dry-run:

```
$ cd packages/claxedo-server && bunx wrangler deploy --env "" --dry-run --outdir /tmp/wr-envtest
env.CLAXEDO_DOCUMENTS (claxedo-documents)              R2 Bucket
env.CLAXEDO_SIGNED_CLOUD_AUTH ("1")                    Environment Variable
env.CLAXEDO_DEPLOYMENT_MODE ("hosted")                 Environment Variable
```

`public-docs/deploy-runbook.md:211` requires the bucket to exist **before**
deployment and to be verified with
`bunx wrangler r2 bucket info claxedo-documents --json`, and states "staging and
production never share a bucket". A missing binding makes the authenticated
Documents probe return 503 and blocks promotion.

### 3b. Production runs a different code path than staging — verified

The same dry-run proves production's resolved `[vars]` are **only**
`CLAXEDO_SIGNED_CLOUD_AUTH` and `CLAXEDO_DEPLOYMENT_MODE`. Staging additionally
sets `CLAXEDO_WAKES_SETTLEMENT = "1"` (`wrangler.toml:129`), whose own comment
says:

> "staging proves settlement through the wakes path (durable dirty-flag wake +
> WakeLane DO). **Production stays on WorkGraphSettler** until the latency
> budgets hold here."

**So on day one, production will execute the `WorkGraphSettler` settlement path
that staging has not exercised since the wakes flip.** This is a deliberate,
documented choice — but it means the staging smoke is *not* evidence for the
settlement path production will actually run.

> **Owner decision OD-4.** Either accept that divergence and test WorkGraphSettler
> explicitly during the cutover, or set `CLAXEDO_WAKES_SETTLEMENT = "1"` in the
> top-level `[vars]` so production matches the path staging has been proving.
> Rollback for the latter is documented in-file: "delete this line and redeploy".

Similarly, `CLAXEDO_RELAY_TUNNEL_CHANNEL_CAP = "32768"` is set only for staging
(`packages/workspace-relay/wrangler.toml:42`); production falls back to the
in-code default. **Unverified:** what that default is — owner should confirm it
is acceptable before the first production relay deploy.

### 3c. Convex

A separate production Convex deployment is mandatory — it is the system of
record for Streams, Tasks, orgs, and the Clerk identity mirror. Sharing it
would mean production and staging writing to the same tables.

Concretely this requires:
- a distinct `CONVEX_DEPLOY_KEY` on the `production` environment;
- a distinct `VITE_CONVEX_URL` (public URL of that deployment), which is baked
  into the app bundle **and** the desktop binary;
- `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` set to the *same* value on both the
  production Convex deployment and the production Worker
  (`public-docs/deploy-runbook.md:197-207`), and different from staging's.

Note that `deploy-control-plane.yml:396` runs
`bunx convex run migrations:run '{"fn":"migrations:normalizeRuntimeLeaseLegacyFields"}'`
against production. On a fresh deployment this is a no-op over zero rows, but
the function must exist or the step fails.

### 3d. Clerk

A separate production Clerk instance is mandatory, and it is the one boundary
that **fails loudly rather than silently** if shared: the Worker verifies tokens
against `CLERK_JWKS_URL` / `CLERK_JWT_ISSUER`, so a production Worker pointed at
the staging issuer would happily accept staging-issued sessions — a real
cross-environment authentication hole.

Separate production Clerk instance implies new values for:
`CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, `VITE_CLERK_PUBLISHABLE_KEY`, and
the Worker-side `CLERK_JWT_ISSUER` + `CLERK_JWKS_URL`.

It **also** implies re-creating all six WorkGraph smoke fixtures in that
instance — `WORKGRAPH_SMOKE_USER_A_ID`, `_USER_A_EMAIL`, `_USER_B_ID`,
`_ORGANIZATION_A_ID`, `_ORGANIZATION_B_ID`, with the membership topology the
workflow header documents (`deploy-control-plane.yml:33-36`): user A belongs to
both orgs, user B belongs to org A. Clerk IDs are instance-scoped; copying
staging's IDs across is guaranteed to fail.

> **Owner decision OD-5.** `promote-production` runs
> `sync-clerk-workgraph-fixtures.ts` and `smoke:workgraph` **against production**
> (`deploy-control-plane.yml:461-492`). That means every production promotion
> creates smoke users/orgs and a real Stream + Task in the production Convex
> deployment, then deletes them. Confirm this is acceptable in production, or
> decide to scope the smoke to staging only. This is a policy call, not a bug.

### 3e. Polar, Sentry, PostHog

None of these are referenced by any workflow — they are runtime-only.

- **Polar** — production must use a *separate Polar project* and, critically,
  must **not** set `CLAXEDO_POLAR_SERVER = "sandbox"`. Per
  `packages/claxedo-server/wrangler.toml:63-64`, `"sandbox"` selects Polar test
  mode; "unset/anything else = production api.polar.sh". A production Worker
  left on sandbox would take no real payments; a staging Worker accidentally on
  production Polar would take real ones. The monthly/yearly product IDs
  (`CLAXEDO_POLAR_PRODUCT_MONTHLY` / `_YEARLY`) are project-scoped and must be
  the production products.
- **Sentry** — `CLAXEDO_SENTRY_DSN` is a Worker secret. Per `wrangler.toml:46-47`,
  absent = "Sentry no-ops cleanly (no events, no network)". A separate production
  Sentry project is required for release tagging to mean anything;
  `CLAXEDO_RELEASE` is already passed as the git SHA at deploy time
  (`deploy-control-plane.yml:417`).
- **PostHog** — see the finding in Part 4.

## Part 4 — Defects found while deriving this runbook

### 4a. `promote-production` verdict: what happens if dispatched today

**Verdict: the run fails safely at the preflight guard, and deploys nothing.**
But it is unusable as written, and the *near-miss* is dangerous.

Trace, for a `workflow_dispatch` with `promote: true` (the default,
`deploy-control-plane.yml:67`):

1. `deploy-staging`, `smoke-staging`, `deploy-app-staging` all run first —
   `promote-production` has `needs: deploy-app-staging` (`:313`). **A production
   promotion therefore redeploys and re-smokes staging first.** That is by
   design, but it means a prod promotion cannot be attempted while staging is red.
2. `promote-production` declares `environment: production` (`:315`), which does
   not exist. GitHub creates environments on demand when a job references them,
   so the expected result is an environment auto-created with **no protection
   rules and no secrets** — i.e. **no approval gate fires.** *(Marked
   **unverified**: confirming this requires actually dispatching the workflow,
   which is an owner action. Either way — auto-create or hard error — the run
   does not reach a deploy step, see 3.)*
3. The first step, "Verify ordered release configuration" (`:317-357`), loops
   over 25 required names. `CONVEX_DEPLOY_KEY`, `CLERK_SECRET_KEY`,
   `CLERK_WEBHOOK_SECRET`, `CLAXEDO_RUNTIME_ADMIN_TOKEN` and all 12 variables
   resolve empty → the job exits 1 with
   `::error::CONVEX_DEPLOY_KEY is not configured in the production environment`.
4. `deploy-app-production` (`:494-500`) has `needs: promote-production`, so it is
   skipped.

**Net effect today: staging is redeployed, production is untouched, the run is
red.** No data loss, no partial production deploy.

**The dangerous state is the next one.** Because `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` resolve from repo level (Part 2), the preflight will
stop complaining about them the moment the other four secrets are added. An
owner who provisions "the things the error message named" gets a **green
preflight and a production-named deploy into the staging Cloudflare account.**

**What must change for `promote-production` to work:**

| # | Change | Who |
| --- | --- | --- |
| 1 | Create the `production` environment **with required reviewers** before any dispatch | Owner (needs admin) |
| 2 | Provision all 25 preflight names environment-scoped, **including `CLOUDFLARE_*` explicitly** | Owner (secrets) |
| 3 | Provision the Worker/Convex runtime secrets (Part 1b) — no workflow does this | Owner (secrets) |
| 4 | Create the `claxedo-documents` R2 bucket in the production account | Owner |
| 5 | Recreate the six Clerk smoke fixtures in the production Clerk instance | Owner |

**No unambiguous code change to the workflow was identified, so none was made.**
The job's logic is correct; what it lacks is an environment and credentials.
Every candidate improvement below is a judgement call about secret names or
policy and is therefore recorded here as an owner decision rather than edited
into the YAML.

### 4b. What the 4-assertion smoke does and does not cover

`/api/claxedo/mode` (`packages/claxedo-server/src/hosted-app.ts:387-399`)
returns eight booleans. The production smoke (`deploy-control-plane.yml:422-459`)
asserts **health ok**, **`signedAuth == true`**, and **two garbage-bearer 401s**.

An 8-signal surface behind a 4-assertion gate looks alarming. **On inspection it
is not, and the reason is worth writing down** — because the natural "harden the
smoke" reaction would add assertions that can never fail.

The hosted composition is genuinely fail-closed. `composeHostedControlPlane`
(`packages/claxedo-server/src/control-plane/hosted-services.ts:234-266`) throws
`HostedWorkerCompositionError` before the app is ever built, and
`worker.ts:235-256` maps that to a **503 on every request** — which the smoke's
health check catches first.

| Signal | Derivation | Can it be `false` on a Worker that returns health 200? |
| --- | --- | --- |
| `signedAuth` | `services.auth.config.enabled` (`hosted-app.ts:390`) | **No.** `hosted-services.ts:236-241` throws when auth is disabled; `assertHostedAppBootConfig` (`hosted-app.ts:210`) re-checks. |
| `authority` | `!!services.authority` (`:391`) | **No.** `composeWorkerAuthority` fails closed; re-checked at `hosted-app.ts:213`. |
| `relay` | `!!services.relay.relayUrl` (`:392`) | **No.** `required(env.CLAXEDO_WORKSPACE_RELAY_URL, …)` — `hosted-services.ts:246-250`. |
| `relayResolver` | `!!services.relay.resolverToken` (`:393`) | **No.** `required(env.CLAXEDO_RELAY_RESOLVER_TOKEN, …)` — `hosted-services.ts:251-255`. |
| `runtimeAccessTokenSigner` | `!!…runtimeAccessTokenSigner` (`:394`) | **No.** Derived from a `required()` PEM — `hosted-services.ts:262-266`. |
| `hostTunnelTokenSigner` | `!!…hostTunnelTokenSigner` (`:395`) | **No** — `hostTunnelTokenSigner()` returns a closure unconditionally (`runtime-access-token.ts:207-208`); the key loads lazily at first use. Always truthy. |
| `deviceLogin` | `!!plane.deviceAuthProvider` (`:396`) | Expected `false`. See the top of this document. |
| `workgraph` | hard-coded literal `true` (`:397`) | Always `true`. Asserts nothing. |

**Conclusion: all six "true" signals are either boot-gated or hard-coded, so
adding them to the smoke would be tautological.** `/api/claxedo/mode` is a
*diagnostic* surface, not an assertion surface. The correct reading of a failed
production smoke is: **a 503 on health means the composition is incomplete, and
the error body names the missing piece** — that is where to look, not at `mode`.

**The real uncovered risk is the opposite one: what is deliberately optional.**
These leave a Worker that boots green, returns `ok:true`, 401s garbage bearers,
and passes all four assertions while being functionally degraded:

| Optional piece | Absent-behavior | Caught by? |
| --- | --- | --- |
| **Sandbox driver** (`CLOUDFLARE_SANDBOX_WORKER_URL` + `CLOUDFLARE_SANDBOX_API_TOKEN`, or Daytona) | `sandboxManager()` returns `undefined` (`hosted-services.ts:171-176`); composition proceeds. **Zero execution capability.** | Not by the 4 assertions. `smoke:workgraph` runs a real no-op Attempt, so it should fail there — that is the actual backstop. |
| **Polar billing** | Billing routes fail closed 503, reconciliation no-ops, every org resolves to free tier (`wrangler.toml:52-56`) | Nothing. Silent. |
| **`CLAXEDO_SENTRY_DSN`** | Sentry "no-ops cleanly (no events, no network)" (`wrangler.toml:46-47`) | Nothing. Silent. |
| **`CLAXEDO_POSTHOG_KEY`** | Telemetry no-ops (`worker-telemetry.ts:18`) | Nothing. Silent. See 4d. |

> **Owner decision OD-6.** The cutover verification in Part 5 checks these four
> optional pieces **by hand**, because no automated gate does. Decide which are
> launch-required. Recommended minimum: the sandbox driver must be present (the
> product does nothing without it), and Sentry should be present before taking
> real traffic.

**One hard provisioning constraint, easy to violate:**
`hosted-services.ts:256-261` throws `hosted_token_reuse` at boot if
`CLAXEDO_RUNTIME_ADMIN_TOKEN` equals `CLAXEDO_RELAY_RESOLVER_TOKEN` — "admin and
resolver are distinct trust domains". Generate them independently.

### 4c. The production deploy runs an unpinned wrangler

`deploy-control-plane.yml:180-181` comments:

> "wrangler resolves to the workspace-pinned version (4.50.0 via the repo
> lockfile) after setup-bun's `bun install`."

**This is false for both Workers deployed to production.** Verified:

```
packages/claxedo-app/package.json:95                                    "wrangler": "4.50.0"
packages/claxedo-server/scripts/sandbox/cloudflare-worker/package.json:12 "wrangler": "4.50.0"
```

`packages/claxedo-server` and `packages/workspace-relay` declare **no** wrangler
dependency, and no hoisted `node_modules/wrangler` exists at the repo root.
`bunx wrangler` from those two directories therefore resolves an unpinned
version from the network — in this worktree it resolved **4.81.1**, not 4.50.0:

```
$ cd packages/claxedo-server && bunx wrangler deploy --env "" --dry-run --outdir /tmp/wr-envtest
 ⛅️ wrangler 4.81.1 (update available 4.114.0)
```

So the tool performing the irreversible, Durable-Object-migration-bearing
production Worker deploy is **version-floating**, while the Pages deploy and the
sandbox image build are pinned. Only `packages/claxedo-app` (Pages) gets 4.50.0.

> **Owner decision OD-7.** Add `"wrangler": "4.50.0"` to the devDependencies of
> `packages/claxedo-server` and `packages/workspace-relay` so all four deploy
> paths use one pinned version. Not done here: it changes `package.json` and
> requires a lockfile update, which means running an installer — explicitly out
> of scope for this task.

### 4d. Product analytics are structurally dead in every deployed build

PostHog is a real dependency (`posthog-js` in `packages/claxedo-app/package.json:158`,
`posthog-node` in `packages/claxedo-server/package.json:109`, 63 source
references) but appears in **zero workflows**.

Two independent problems:

1. **App-side is a workflow defect, not a missing variable.**
   `packages/claxedo-app/src/platform/telemetry/analytics.ts:34` reads
   `import.meta.env.VITE_POSTHOG_KEY` — Vite inlines this at **build time**. The
   build step at `deploy-claxedo-app.yml:58-65` passes only
   `VITE_CLAXEDO_SERVER_URL`, `VITE_AUTH_ENABLED`, `VITE_CLERK_PUBLISHABLE_KEY`,
   and `VITE_CONVEX_URL`. **Setting `VITE_POSTHOG_KEY` as an environment variable
   would change nothing** — the workflow must also pass it into the build.
2. **Worker-side is just a missing secret.**
   `packages/claxedo-server/src/control-plane/worker-telemetry.ts:18` reads
   `env.CLAXEDO_POSTHOG_KEY`, so `wrangler secret put` is sufficient there.

This matters for the cutover because `public-docs/deploy-runbook.md:266` makes
telemetry a *promotion precondition*: "environment-specific PostHog dashboards,
destinations, and paging integrations are provisioned in the telemetry account
**before production promotion**." That precondition cannot currently be met on
the app side without a workflow change.

> **Owner decision OD-8.** Decide whether launch requires product analytics. If
> yes, `deploy-claxedo-app.yml`'s build step needs `VITE_POSTHOG_KEY` /
> `VITE_POSTHOG_HOST` added — a `.github/workflows/` change owned by another
> stream. If no, explicitly waive the `deploy-runbook.md:266` precondition so it
> does not silently block the go/no-go.

### 4e. Desktop releases are hard-wired to staging

`release-claxedo.yml:133-138`:

```yaml
  build-desktop:
    # The VITE_* cloud vars are environment-scoped, not repo-level. Only the
    # staging environment exists today; switch to production once that
    # environment is created and promoted.
    environment: staging
```

Every published desktop binary bakes in staging's `VITE_CLERK_PUBLISHABLE_KEY`,
`VITE_CONVEX_URL`, and `CLAXEDO_CONTROL_PLANE_URL` (`:259-261`). These are
build-time values, so a shipped installer points at staging permanently.

> **Owner decision OD-9.** After the production environment exists, flip
> `release-claxedo.yml:138` to `environment: production`. The in-file comment
> already designates this as the intended follow-up. Sequencing matters: flip it
> **after** the production control plane is live, or desktop builds break.

## Part 5 — Cutover procedure

Every step is an owner action. Steps 1-6 are preparation and change nothing
that serves traffic; the first irreversible action is Step 7.

Resolve OD-1 through OD-5 before starting — they change what you provision.

### Step 1 — Provision the production accounts

Create, per OD-3/OD-4/OD-5: the production Cloudflare account (or scoped token),
a production Convex deployment, a production Clerk instance, and — if launching
paid — a production Polar project and Sentry project.

In the production Clerk instance, create the six smoke fixtures with the
topology from `deploy-control-plane.yml:33-36`: two users, two organizations,
user A in **both** orgs, user B in org A. Record their IDs.

**Verify:**
```sh
# Clerk JWKS must be reachable and non-empty before anything depends on it
curl -fsS "https://<prod-clerk-domain>/.well-known/jwks.json" | jq -e '.keys | length > 0'
```

### Step 2 — Create the `production` environment WITH required reviewers

Do this **before** adding secrets, so no window exists where production is
deployable without review.

GitHub → Settings → Environments → New environment → `production` → enable
**Required reviewers**.

**Verify (protection rules must be non-empty):**
```sh
gh api repos/kyashrathore/Claxedo/environments/production \
  -q '{name, protection: [.protection_rules[].type]}'
```
A result with `protection: []` means the gate does not exist — stop and fix it.
This is the one-click promotion gate the whole design depends on
(`deploy-control-plane.yml:8-12`).

### Step 3 — Create the R2 bucket

```sh
CLOUDFLARE_ACCOUNT_ID=<prod> CLOUDFLARE_API_TOKEN=<prod> \
  bunx wrangler r2 bucket create claxedo-documents
```

**Verify** (`public-docs/deploy-runbook.md:211`):
```sh
bunx wrangler r2 bucket info claxedo-documents --json
```

### Step 4 — Provision Convex runtime env (BEFORE any deploy)

See the ordering hazard in Part 1b — `convex/auth.config.ts` is evaluated at
deploy time.

```sh
export CONVEX_DEPLOY_KEY=<production key>
bunx convex env set CLERK_JWT_ISSUER_DOMAIN "https://<prod-clerk-domain>"
bunx convex env set CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN "$SERVICE_TOKEN"
```

Generate `$SERVICE_TOKEN` once; it must be byte-identical here and in Step 5,
and different from staging's.

**Verify (names only):**
```sh
bunx convex env list
```

### Step 5 — Provision Worker secrets

Generate three independent random values: `$SERVICE_TOKEN` (reused from Step 4),
`$RESOLVER_TOKEN`, `$ADMIN_TOKEN`. **`$ADMIN_TOKEN` must not equal
`$RESOLVER_TOKEN`** — `hosted-services.ts:256-261` refuses to boot otherwise.

```sh
cd packages/claxedo-server
# Omit --env entirely for production (top-level wrangler env).
printf '%s' "$PROD_CLERK_ISSUER"  | bunx wrangler secret put CLERK_JWT_ISSUER
printf '%s' "$PROD_CLERK_JWKS"    | bunx wrangler secret put CLERK_JWKS_URL
printf '%s' "$PROD_CONVEX_URL"    | bunx wrangler secret put CLAXEDO_WORKSPACE_AUTHORITY_URL
printf '%s' "$RESOLVER_TOKEN"     | bunx wrangler secret put CLAXEDO_RELAY_RESOLVER_TOKEN
printf '%s' "$RAT_PRIVATE_PEM"    | bunx wrangler secret put CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM
printf '%s' "$SERVICE_TOKEN"      | bunx wrangler secret put CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
printf '%s' "$ADMIN_TOKEN"        | bunx wrangler secret put CLAXEDO_RUNTIME_ADMIN_TOKEN
# Sandbox driver — without this the product has no execution capability (4b)
printf '%s' "$SANDBOX_WORKER_URL" | bunx wrangler secret put CLOUDFLARE_SANDBOX_WORKER_URL
printf '%s' "$SANDBOX_API_TOKEN"  | bunx wrangler secret put CLOUDFLARE_SANDBOX_API_TOKEN
# Optional per OD-6: CLAXEDO_SENTRY_DSN, CLAXEDO_POSTHOG_KEY, Polar, credentials
```

Then the relay Worker:
```sh
cd ../workspace-relay
printf '%s' "$RESOLVER_TOKEN"     | bunx wrangler secret put CLAXEDO_RELAY_RESOLVER_TOKEN
printf '%s' "$HOST_SIGNING_PEM"   | bunx wrangler secret put CLAXEDO_RELAY_HOST_SIGNING_KEY_PEM
printf '%s' "$PROD_CP_JWKS_URL"   | bunx wrangler secret put CLAXEDO_CONTROL_PLANE_JWKS_URL
```

**Verify (names only, never values):**
```sh
bunx wrangler secret list          # from each package dir; production = no --env
```

### Step 6 — Provision the 25 GitHub environment names

Set all 9 secrets and 20 variables from Part 1a on `production` — **explicitly
including `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`** even though they
appear to resolve. Re-read Part 2 before skipping them.

`CLAXEDO_CONTROL_PLANE_URL` and `CLAXEDO_WORKSPACE_RELAY_URL` are chicken-and-egg:
they are the URLs of Workers that do not exist yet. Their names are fixed by
`wrangler.toml` (`claxedo-control-plane` / `claxedo-workspace-relay`), so set
them to the predicted `https://<name>.<prod-subdomain>.workers.dev` and correct
them after Step 7 if the subdomain differs.

**Verify the environment now satisfies every preflight name:**
```sh
gh api repos/kyashrathore/Claxedo/environments/production/secrets   --paginate -q '.secrets[].name'   | sort > /tmp/have_s.txt
gh api repos/kyashrathore/Claxedo/environments/production/variables --paginate -q '.variables[].name' | sort > /tmp/have_v.txt
grep -ohE 'secrets\.[A-Za-z_][A-Za-z0-9_]*' .github/workflows/deploy-control-plane.yml .github/workflows/deploy-claxedo-app.yml \
  | sed 's/secrets\.//' | sort -u | comm -23 - /tmp/have_s.txt   # must be empty
grep -ohE 'vars\.[A-Za-z_][A-Za-z0-9_]*' .github/workflows/deploy-control-plane.yml .github/workflows/deploy-claxedo-app.yml \
  | sed 's/vars\.//' | sort -u | comm -23 - /tmp/have_v.txt      # must be empty
```
Both `comm` outputs empty ⇒ the preflight at `deploy-control-plane.yml:346-357`
will pass. This reproduces the exact check used to find the staging gaps in 1c.

### Step 7 — Dispatch the promotion (first irreversible step)

The workflow enforces the ADR ordering itself — **Convex → relay Worker →
control-plane Worker → smoke → Pages** — so do not deploy the units by hand.

```sh
gh workflow run deploy-control-plane.yml --ref dev -f promote=true
```

This first redeploys and re-smokes **staging** (`promote-production` has
`needs: deploy-app-staging`), then pauses for the required-reviewer approval on
`production`. Approve only if staging is green.

### Step 8 — Verify each unit

The workflow runs these itself; run them again by hand to confirm independently.

**Convex** — `bunx convex env list` still shows the Step 4 names, and the
deployment reports the pushed commit.

**Relay Worker:**
```sh
curl -s -o /dev/null -w '%{http_code}\n' https://claxedo-workspace-relay.<sub>.workers.dev/health   # 200
```

**Control-plane Worker** — the composition check that actually matters:
```sh
BASE=https://claxedo-control-plane.<sub>.workers.dev
curl -fsS "$BASE/api/claxedo/health" | jq -e '.ok == true'
curl -fsS "$BASE/api/claxedo/mode"
```
A **503 here means the composition is incomplete and the body names the missing
secret** — that is the diagnostic, per 4b. On success, `mode` must match
staging's shape exactly, including `"deviceLogin": false`:
```json
{"mode":"hosted-control-plane","signedAuth":true,"authority":true,"relay":true,
 "relayResolver":true,"runtimeAccessTokenSigner":true,"hostTunnelTokenSigner":true,
 "deviceLogin":false,"workgraph":true}
```

Fail-closed probes (both must be exactly `401`):
```sh
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer garbage" "$BASE/api/control/sessions?workspaceId=probe"
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer garbage" "$BASE/api/workgraph/snapshot?limit=1"
```

**Manual checks no gate performs** (per OD-6): confirm the sandbox driver is
live (a real Attempt runs — this is what `smoke:workgraph` exercises), and that
Sentry received the release tagged with the deploy SHA.

**Authenticated smoke** — verified to exist at
`packages/claxedo-server/scripts/smoke/smoke-workgraph.ts` (`bun run smoke:workgraph`,
`packages/claxedo-server/package.json`). It covers the Documents R2 probe at
`smoke-workgraph.ts:75` (`/documents/__claxedo_deployment_probe__` → 404; a 503
means the R2 binding is missing).

**Pages / browser gate** — `bun run test:e2e:deployed-workgraph`
(`packages/claxedo-app/package.json`, config
`packages/claxedo-app/playwright.deployed.config.ts`).

### Step 9 — Post-cutover follow-ups

Flip `release-claxedo.yml:138` to `environment: production` (OD-9). Revisit
OD-2 (repo-level secret deletion), OD-7 (wrangler pin), OD-8 (PostHog).

## Part 6 — Rollback, per unit

`public-docs/deploy-runbook.md:49-90` is the authoritative doctrine; this is the
cutover-relevant subset. **Production omits `--env` entirely** (top-level
wrangler env) — every staging command below differs by that flag.

| Unit | Rollback | Cutover-specific caveat |
| --- | --- | --- |
| **Control-plane Worker** | `cd packages/claxedo-server && bunx wrangler deployments list && bunx wrangler rollback` (`deploy-runbook.md:60-67`) | **On a first cutover there is no previous version to roll back to.** The only "rollback" is deleting the Worker. Plan forward-fix, not rollback. |
| **Relay Worker** | `cd packages/workspace-relay && bunx wrangler rollback` (`deploy-runbook.md:54`) | Cannot roll back across the `WorkspaceRelayRoom` DO migration. Same first-deploy caveat. |
| **Convex** | **None — roll-forward only.** Re-push the previous green SHA (`deploy-runbook.md:56`, `:81-90`) | Deploy key is production's. Data written by a bad version is never reverted. |
| **Pages / app** | Redeploy the previous SHA through `deploy-claxedo-app.yml` | Fast and safe; the app is a static bundle. |
| **R2 documents** | Worker rollback never touches R2 objects (`deploy-runbook.md:58`) | Do not delete the bucket to "reset" a failed cutover. |
| **Sandbox image** | Re-pin `CLAXEDO_SANDBOX_BUILD_ID` (`deploy-runbook.md:57`) | Config change only. |
| **Fly relay** | `fly releases -a <app> --image` then redeploy (`deploy-runbook.md:69-79`) | Dormant today — see G-1/G-2. |

**The honest framing for a first cutover: nothing before Step 7 is
irreversible, and almost nothing after it is rollbackable.** The Convex push in
particular is one-way. Spend the effort on Steps 1-6 verification.

## Appendix — Commands used to derive this document

All read-only. No `gh api` write methods, no deploys, no environment or secret
mutations.

```sh
gh api repos/kyashrathore/Claxedo/environments
gh api repos/kyashrathore/Claxedo/environments/staging/secrets   --paginate -q '.secrets[].name'
gh api repos/kyashrathore/Claxedo/environments/staging/variables --paginate -q '.variables[].name'
gh api repos/kyashrathore/Claxedo/actions/secrets                --paginate -q '.secrets[].name'
gh api repos/kyashrathore/Claxedo/actions/variables              --paginate -q '.variables[].name'
gh api repos/kyashrathore/Claxedo -q '.owner.type'

curl -fsS https://claxedo-control-plane-staging.kanusdlp.workers.dev/api/claxedo/health
curl -fsS https://claxedo-control-plane-staging.kanusdlp.workers.dev/api/claxedo/mode
curl -s -o /dev/null -w '%{http_code}' https://claxedo-control-plane.kanusdlp.workers.dev/api/claxedo/health
curl -s -o /dev/null -w '%{http_code}' https://claxedo-workspace-relay.kanusdlp.workers.dev/health
curl -s -o /dev/null -w '%{http_code}' https://claxedo-workspace-relay-staging.kanusdlp.workers.dev/health

cd packages/claxedo-server && bunx wrangler deploy --env "" --dry-run --outdir /tmp/wr-envtest
cd packages/workspace-relay && bunx wrangler deploy --env "" --dry-run --outdir /tmp/wr-relaytest
```

Plus `grep`-based enumeration of `secrets.*` / `vars.*` across
`.github/workflows/deploy-*.yml`, and source reading of
`packages/claxedo-server/src/control-plane/hosted-services.ts`,
`.../deployment-mode.ts`, `.../runtime-access-token.ts`,
`packages/claxedo-server/src/hosted-app.ts`, both `wrangler.toml` files, and
`convex/auth.config.ts`.
