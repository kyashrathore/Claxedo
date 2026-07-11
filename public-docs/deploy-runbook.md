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
| variable | `CLAXEDO_CONTROL_PLANE_URL` | Base URL of that environment's Worker, used by the smoke job (e.g. `https://claxedo-control-plane-staging.<subdomain>.workers.dev`) |

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

## Smoke gates (what "green" asserts)

The control-plane smoke is behavioral, not liveness theater:

1. `GET /api/claxedo/health` → `ok: true`.
2. `GET /api/claxedo/mode` → `signedAuth: true` (the deployment is configured
   fail-closed).
3. `GET /api/control/sessions?workspaceId=...` with a **garbage bearer token**
   → exactly **401**. Any other status (including 200) fails the job: the auth
   path is not failing closed.

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
- `packages/workspace-relay/Dockerfile` does not exist yet; the relay
  `fly.toml` references it and documents the requirement. First relay deploy
  is blocked on writing it.
- A staging relay Fly app (`claxedo-workspace-relay-staging`) must be created
  (`fly launch --copy-config --no-deploy`) with its secrets set before the
  staging path of `deploy-relay.yml` can run.
