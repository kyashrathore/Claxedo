# Deploy Runbook

Operational companion to the deploy workflows in `.github/workflows/`
(`deploy-control-plane.yml`, `deploy-relay.yml`, `deploy-convex.yml`) and the
ops-floor decision record (`docs/plans/2026-07-11-016-wp-ops-floor-design.md`).
Every deploy is a git SHA pushed through GitHub Actions; laptop deploys are
break-glass only. Staging deploys are automatic; production is always
human-gated behind the GitHub environment `production` (required reviewers —
the approval click is the promotion gate).

## Units and their pipelines

| Unit | Plane | Workflow | Trigger |
|---|---|---|---|
| Control-plane Worker (`packages/claxedo-server/wrangler.toml`) | Cloudflare Workers | `deploy-control-plane.yml` | push to `dev` → staging + smoke; `workflow_dispatch` → staging + smoke + gated prod promotion |
| Convex (`convex/`) | Convex (push-only) | `deploy-convex.yml` (also a step inside `deploy-control-plane.yml`) | `workflow_dispatch` only |
| Workspace relay (`packages/workspace-relay/fly.toml`) | Fly machine | `deploy-relay.yml` | `workflow_dispatch` only (drain-then-deploy + reconvergence) |
| Sandbox image | Cloudflare registry | `deploy-cloudflare-sandbox-worker.yml` (pre-existing) | `workflow_dispatch`; pinned artifact, not a lockstep deploy |

**Ordering rule** (most-backward-compatible first): Convex → control-plane
Worker → relay. Two ship-solo disciplines:

- **Convex schema changes ship solo** (D14): push the schema alone via
  `deploy-convex.yml`, verify, then ship dependent code. Never bundle a schema
  change with dependent Worker/relay code in one deploy.
- **Durable Object migrations ship solo**: a Worker deploy that carries a DO
  migration (`[[migrations]]` in a wrangler config) must contain nothing else —
  Workers cannot roll back across a DO migration, so bundling poisons the
  rollback well for the whole deploy.

## Rollback doctrine, per unit

| Unit | Mechanism | Speed | Hard limits |
|---|---|---|---|
| Control-plane Worker | `wrangler rollback` (Workers versions & deployments) | seconds | Cannot roll back across a Durable Object migration; bound-resource state (KV/D1/DO storage) is untouched by rollback |
| Relay / self-host on Fly | `fly releases` → redeploy the prior image | ~1–2 min (no rebuild) | Redeploys the *image* only; the *current* `fly.toml` and secrets apply, not those from the old release. A rollback is itself a deploy — it drops tunnels again |
| Convex | **None. Roll-forward only.** Re-push the previous green git SHA (`bunx convex deploy` from that checkout) | minutes; requires the old SHA | Additive schema discipline (expand-migrate-contract) is the rollback substitute: re-pushing old code works only if every schema change was additive. Schema must still validate against *current* data — a rollback that re-narrows a widened schema is rejected. Data written by the bad version is never reverted |
| Sandbox image | Re-pin `CLAXEDO_SANDBOX_BUILD_ID` / `CLAXEDO_SNAPSHOT_NAME` on the control plane | config change | Old snapshot must still exist in the registry; running sandboxes keep their epoch's image |

### Worker rollback commands

```sh
cd packages/claxedo-server
bunx wrangler deployments list --env staging   # find the previous version
bunx wrangler rollback --env staging           # staging
bunx wrangler rollback                         # production (top-level env)
```

### Fly rollback commands (relay; same shape for the self-host control plane)

```sh
fly releases -a claxedo-workspace-relay --image
# note the image ref of the last good release, then:
fly deploy -a claxedo-workspace-relay -c packages/workspace-relay/fly.toml \
  --image <registry.fly.io/claxedo-workspace-relay@sha256:...>
```

Fly rollback ≠ config rollback: `fly.toml` in-repo is the only source of
config truth; treat `fly secrets set` as a logged, deliberate act.

### Convex "rollback" (roll-forward)

```sh
git checkout <previous-green-sha>
CONVEX_DEPLOY_KEY=... bunx convex deploy
```

Or dispatch `deploy-convex.yml` from a branch pointing at that SHA. If the bad
deploy shipped a schema change *plus* a backfill, there is no rollback at all —
only fix-forward.

## The relay tunnel-drop window

Relay production v1 is single-instance: host presence and tunnel sockets live
in process memory, so **every relay deploy (and any restart or crash) drops
active host tunnels and long-lived HTTP/WebSocket/SSE/PTY sessions until the
workspace-runtime hosts reconnect** — a bounded seconds-to-a-minute outage
even with a clean drain, because there is no second instance to reconnect to
(`public-docs/relay-and-deployment.md`).

What the pipeline does about it (`deploy-relay.yml`):

1. **Drain-then-deploy.** The relay's drain controller is signal-driven
   (`installShutdownDrainHandler`, `packages/workspace-relay/src/main.ts`):
   on SIGTERM, `/health` flips to 503 (Fly stops routing), new work gets
   `503 relay_draining`, host tunnels close so hosts reconnect promptly, and
   pending work drains up to `CLAXEDO_RELAY_DRAIN_TIMEOUT_MS` (30 s). The
   `fly deploy` machine stop delivers that SIGTERM; `fly.toml` sets
   `kill_timeout = 45s` so Fly never force-kills mid-drain. There is no HTTP
   drain endpoint today (`relay_provider.drainWorkspace` on the control plane
   is an unexposed per-workspace seam).
2. **Reconvergence assertion.** Pre-deploy, the workflow snapshots
   `directory.activeHostCount` from the token-gated `/metrics`; post-deploy it
   polls until the count recovers to ≥ 80% of the snapshot within 10 minutes,
   else the run fails.

**Policy** (ADR §2.4 R2): batch relay deploys; run tunnel-affecting ones at a
published time. Multi-instance / DO relay is deferred with named triggers.

## GitHub configuration required

Two GitHub **environments**: `staging` (no protection) and `production`
(**required reviewers** — this is the one-click prod gate). Secrets and
variables below are environment-scoped and use the same names in both
environments, with per-environment values.

### `deploy-control-plane.yml`

| Kind | Name | Purpose |
|---|---|---|
| secret | `CONVEX_DEPLOY_KEY` | Deploy key for that environment's Convex deployment (staging key on `staging`, prod key on `production`) |
| secret | `CLOUDFLARE_API_TOKEN` | Workers Scripts:Edit on the target account (least-privilege, per the sandbox workflow's pattern) |
| secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account to deploy into |
| secret | `CLERK_SECRET_KEY` | Clerk Backend API key used to mint and revoke short-lived Sessions for the two smoke users. |
| variable | `CLAXEDO_CONTROL_PLANE_URL` | Base URL of that environment's Worker, used by the smoke job (e.g. `https://claxedo-control-plane-staging.<subdomain>.workers.dev`) |
| variable | `WORKGRAPH_SMOKE_USER_A_ID` | First dedicated Clerk smoke user. |
| variable | `WORKGRAPH_SMOKE_USER_B_ID` | Second distinct Clerk smoke user used for cross-owner denial. |
| variable | `WORKGRAPH_SMOKE_WORKSPACE_ID` | Existing hosted Workspace accessible to smoke user A; the capability route reads its real runtime catalog. |

### `deploy-claxedo-app.yml`

| Kind | Name | Purpose |
|---|---|---|
| secret | `CLOUDFLARE_API_TOKEN` | Pages deployment permission for the target account. |
| secret | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account containing the Pages project. |
| variable | `CLAXEDO_CONTROL_PLANE_URL` | Verified Worker URL embedded into the app build. |
| variable | `CLAXEDO_APP_URL` | Deployed app base URL used to verify `/workgraph`. |
| variable | `CLAXEDO_PAGES_PROJECT` | Exact Pages project name. |
| variable | `CLAXEDO_PAGES_BRANCH` | Exact Pages branch for this protected environment. |
| variable | `VITE_CLERK_PUBLISHABLE_KEY` | Public Clerk instance key embedded into the app. |
| variable | `VITE_CONVEX_URL` | Public Convex URL embedded into the app. |

### `deploy-relay.yml`

| Kind | Name | Purpose |
|---|---|---|
| secret | `FLY_API_TOKEN` | Fly deploy token, scoped to the relay app |
| secret | `CLAXEDO_RELAY_METRICS_TOKEN` | Bearer token for the relay's `/metrics` (fails closed without it); must equal the Fly secret of the same name on the relay app |
| variable | `CLAXEDO_RELAY_FLY_APP` | Fly app name (`claxedo-workspace-relay-staging` / `claxedo-workspace-relay`) |
| secret (future) | `CLAXEDO_RELAY_ADMIN_DRAIN_TOKEN` | TODO — only once a control-plane HTTP drain endpoint exists; templated in the workflow |

### `deploy-convex.yml`

| Kind | Name | Purpose |
|---|---|---|
| secret | `CONVEX_DEPLOY_KEY` | Deploy key for that environment's Convex deployment |

Secret-concentration risk is accepted per the ADR (§6.1): environment-scoped
secrets + required review on `production` + least-privilege tokens beat a
laptop keychain with no audit trail.

## Runtime configuration required before the first deploy

GitHub Actions deploys code but does not install Worker secrets or Convex function environment variables. Provision these separately for both staging and production, then keep their values stable across ordinary code deploys.

The same randomly generated `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` must exist in both runtime environments:

```sh
# Convex function environment
CONVEX_DEPLOY_KEY=... bunx convex env set CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN "$TOKEN"

# Cloudflare Worker secret
cd packages/claxedo-server
printf '%s' "$TOKEN" | bunx wrangler secret put CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN --env staging
# Omit --env for production.
```

The hosted Worker also requires `CLAXEDO_WORKSPACE_AUTHORITY_URL`, `CLERK_JWT_ISSUER`, `CLERK_JWKS_URL`, and `CLAXEDO_RUNTIME_ADMIN_TOKEN`. Hosted execution additionally requires the selected sandbox driver, relay, and runtime-token signing configuration documented in `packages/claxedo-server/wrangler.toml`. A missing required binding fails closed at boot or makes the scheduled reconciliation invocation fail visibly.

Connections and signed WorkGraph webhooks require the encrypted per-organization credential backend. Set `CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1` together with `CLAXEDO_CREDENTIALS_KEK`, `CLAXEDO_CF_KV_URL`, and `CLAXEDO_CF_KV_TOKEN`; use `CLAXEDO_CREDENTIALS_KEK_NEXT` only during key rotation. Provider tokens and webhook signing secrets are then written through the Connections setup routes and never placed in WorkGraph or deployment variables.

## WorkGraph Cloud go/no-go

### Before deploy

- [ ] `bunx convex codegen` and `bunx tsc --noEmit --project convex/tsconfig.json` pass.
- [ ] `bun run check:worker-safe` and an explicit Wrangler dry-run pass from `packages/claxedo-server`.
- [ ] The relevant hosted auth, owner-isolation, Connections, webhook, notification, and background-reconciliation tests pass.
- [ ] The Convex change is additive and can serve the currently deployed Worker before dependent code ships.
- [ ] The Worker and Convex deployment contain the same control-plane service token, without printing either value.
- [ ] Signed auth, workspace authority, runtime admin, relay, sandbox, and runtime-token signing bindings are present in the target Worker environment.
- [ ] Hosted Connections are either deliberately disabled or have the encrypted per-org credential configuration above; webhook signing secrets exist through Connections for every enabled webhook source.

Any failed item is a no-go. Missing external credentials defer deployed acceptance; they do not invalidate repository-level Worker safety or Convex type evidence.

### Deploy and verify

1. [ ] Deploy an additive Convex schema/functions commit first and verify server-side schema validation succeeds.
2. [ ] Deploy the same reviewed SHA's Worker after Convex is healthy.
3. [ ] Confirm health, signed-auth mode, and both garbage-token 401 probes.
4. [ ] Require the short-lived two-user Stream/Task persistence, owner-denial, and execution-capability smoke to pass.
5. [ ] Confirm the next scheduled invocation completes sandbox GC and WorkGraph reconciliation without an error event.
6. [ ] Deploy the app from the same SHA through `deploy-claxedo-app.yml` and require `/workgraph` to return the built app shell.
7. [ ] Send one valid and one invalid-signature provider webhook to a staging Connection; require one filtered intake refresh and one rejection, with no credential material in logs.

### Roll back or roll forward

- Worker-only failure: roll back the Worker version, then repeat health/auth probes against the still-additive Convex deployment.
- Convex function failure: fix forward by deploying the previous compatible function code or a new corrective commit. Convex data and schema do not roll back.
- Credential or signing-key failure: restore the prior Worker secret/key slot, leave stored Connection ciphertext untouched, and rerun authenticated persistence plus webhook verification.
- Reconciliation failure: stop new execution admission if necessary, retain durable Attempts/jobs, restore the Worker, and verify the next claim uses the persisted lease epoch rather than creating duplicate work.

For the first 24 hours, alert on Worker composition 503s, non-401 garbage-token probes, WorkGraph command/query error rate, expired or repeatedly failed Attempt/Recap/source-plan claims, webhook signature/deduplication failures, and credential decryption/authentication failures.

## Smoke gates (what "green" asserts)

The control-plane smoke is behavioral, not liveness theater:

1. `GET /api/claxedo/health` → `ok: true`.
2. `GET /api/claxedo/mode` → `signedAuth: true` (the deployment is configured
   fail-closed).
3. `GET /api/control/sessions?workspaceId=...` with a **garbage bearer token**
   → exactly **401**. Any other status (including 200) fails the job: the auth
   path is not failing closed.
4. `GET /api/workgraph/snapshot?limit=1` with a garbage bearer token → exactly
   **401**, proving the personal WorkGraph cannot be reached without signed
   identity. The workflow then invokes `bun run smoke:workgraph` with two
   dedicated Clerk users; it checks hosted execution capabilities, creates and
   reads a real Convex-backed Stream and Task, proves cross-user denial, deletes
   the Stream, and revokes the short-lived Sessions.

The relay smoke is `/health` recovery plus the tunnel reconvergence assertion
described above.

## Break-glass (laptop) deploys

Only when Actions itself is the outage. Always deploy a *committed* SHA —
never a dirty working tree (an uncommitted deploy has no rollback artifact).

```sh
# Convex (first)
CONVEX_DEPLOY_KEY=... bunx convex deploy

# Control-plane Worker
cd packages/claxedo-server
bunx wrangler deploy --env staging   # or omit --env for production

# Relay (from the monorepo root; expect the tunnel-drop window)
fly deploy -c packages/workspace-relay/fly.toml -a claxedo-workspace-relay
```

Afterwards, re-run the deploy workflow on the same SHA so the Actions log
stays the authoritative record of what is running.

## Known gaps / pending verification

- **Live-run verification is pending credentials.** These workflows have been
  YAML-validated and command-audited against the tree, but have not executed a
  real deploy.
- Hosted WorkGraph execution admission, fencing, and dispatch outbox are
  durable in Convex. The scheduled Worker provisions the Stream workspace,
  admits work through authenticated Session V2 relay routes, and reconciles
  explicit durable terminal events on later cron passes. Transport failures
  remain visible as Attempt attention.
- `packages/workspace-relay/Dockerfile` does not exist yet; the relay
  `fly.toml` references it and documents the requirement. First relay deploy
  is blocked on writing it.
- A staging relay Fly app (`claxedo-workspace-relay-staging`) must be created
  (`fly launch --copy-config --no-deploy`) with its secrets set before the
  staging path of `deploy-relay.yml` can run.
