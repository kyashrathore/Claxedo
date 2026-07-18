# Deploy Runbook

Operational companion to the deploy workflows in `.github/workflows/`
(`deploy-control-plane.yml`, `deploy-claxedo-app-staging.yml`,
`deploy-claxedo-app.yml`, `deploy-relay.yml`, `deploy-convex.yml`,
`deploy-cloudflare-sandbox-worker.yml`, `deploy-worker-migration.yml`) and the
ops-floor decision record (`docs/plans/2026-07-11-016-wp-ops-floor-design.md`).
Every deploy is a git SHA pushed through GitHub Actions; laptop deploys are
break-glass only. Once its environment is configured, staging deploys are
automatic; production is always human-gated behind the GitHub environment
`production` (required reviewers — the approval click is the promotion gate).

## Units and their pipelines

| Unit                                                       | Plane                  | Workflow                               | Trigger                                                                                                             |
| ---------------------------------------------------------- | ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Ordered Cloud release: Convex → relay Worker → control-plane Worker → app | Convex, Workers, Pages | `deploy-control-plane.yml`             | push to `dev` → staging + smoke + app; `workflow_dispatch` → the same staging sequence + gated production promotion |
| Cloudflare Workspace Relay Worker (`packages/workspace-relay/wrangler.toml`) | Workers + Durable Object | `deploy-control-plane.yml`           | deployed automatically inside the ordered Cloud release, before the control-plane Worker (push to `dev` or `workflow_dispatch`) |
| Migration-only control-plane Worker                        | Workers + Durable Object | `deploy-worker-migration.yml`          | `workflow_dispatch` only; a branch whose single commit carries one Worker DO migration (verified single-commit, migration-only) |
| App-only staging change                                    | Cloudflare Pages       | `deploy-claxedo-app-staging.yml`       | push to `dev` limited to app files; calls the reusable `deploy-claxedo-app.yml` workflow                            |
| Isolated Convex roll-forward                               | Convex (push-only)     | `deploy-convex.yml`                    | operator `workflow_dispatch` for an additive repair or compatible previous SHA                                      |
| Workspace relay on Fly (`packages/workspace-relay/fly.toml`) | Fly machine          | `deploy-relay.yml`                     | `workflow_dispatch` only (drain-then-deploy + reconvergence); the non-Cloudflare regional-container shape           |
| Sandbox image                                              | Cloudflare registry    | `deploy-cloudflare-sandbox-worker.yml` | `workflow_dispatch`; pinned artifact, not a lockstep deploy                                                         |

**Ordering rule** (most-backward-compatible first): Convex → Cloudflare
Workspace Relay Worker → control-plane Worker → authenticated smoke → app.
`deploy-control-plane.yml` owns that full sequence for both environments. All top-level Convex, Worker, and app workflows
share the `claxedo-cloud-deploy` concurrency group, so no release can interleave
with another release against the same deployment. The reusable app workflow has
no independent trigger or lock; its control-plane or app-only staging caller
retains the global lock for the entire deployment.

Two ship-solo disciplines:

- **Convex schema changes ship solo** (D14): the additive schema/function
  expansion is its own commit and remains compatible with the currently
  deployed Worker. A normal `dev` push still runs the complete automatic
  Convex → Worker → app sequence from that SHA. `deploy-convex.yml` is the
  operator path for an isolated compatible roll-forward and carries no
  dependent Worker or app release.
- **Durable Object migrations ship solo**: a Worker deploy that carries a DO
  migration (`[[migrations]]` in a wrangler config) must contain nothing else —
  Workers cannot roll back across a DO migration, so bundling poisons the
  rollback well for the whole deploy. `deploy-worker-migration.yml`
  (`workflow_dispatch`) is the operator path for a control-plane DO migration:
  it hard-verifies the source branch is exactly one migration-only commit before
  deploying it alone.

## Rollback doctrine, per unit

| Unit                     | Mechanism                                                                                                 | Speed                         | Hard limits                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Control-plane Worker     | `wrangler rollback` (Workers versions & deployments)                                                      | seconds                       | Cannot roll back across a Durable Object migration; bound-resource state (KV/D1/DO storage) is untouched by rollback                                                                                                                                                                                                |
| Cloudflare Relay Worker  | `wrangler rollback --env staging` from `packages/workspace-relay` (Workers versions)                      | seconds                       | Cannot roll back across the `WorkspaceRelayRoom` Durable Object migration; a deploy restarts the DO isolates, so hibernatable host tunnels re-establish. The Bun/Fly relay (`deploy-relay.yml`) is the independent fallback shape                                                                                     |
| Relay / self-host on Fly | `fly releases` → redeploy the prior image                                                                 | ~1–2 min (no rebuild)         | Redeploys the _image_ only; the _current_ `fly.toml` and secrets apply, not those from the old release. A rollback is itself a deploy — it drops tunnels again                                                                                                                                                      |
| Convex                   | **None. Roll-forward only.** Re-push the previous green git SHA (`bunx convex deploy` from that checkout) | minutes; requires the old SHA | Additive schema discipline (expand-migrate-contract) is the rollback substitute: re-pushing old code works only if every schema change was additive. Schema must still validate against _current_ data — a rollback that re-narrows a widened schema is rejected. Data written by the bad version is never reverted |
| Sandbox image            | Re-pin `CLAXEDO_SANDBOX_BUILD_ID` / `CLAXEDO_SNAPSHOT_NAME` on the control plane                          | config change                 | Old snapshot must still exist in the registry; running sandboxes keep their epoch's image                                                                                                                                                                                                                           |
| Documents R2             | Restore a known-good Documents Worker; use immutable snapshots for content recovery                       | minutes                       | Worker rollback never rolls back or deletes R2 objects. A pre-Documents Worker makes hosted Documents unavailable while leaving objects intact                                                                                                                                                                       |

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
deploy shipped a schema change _plus_ a backfill, there is no rollback at all —
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

| Kind     | Name                                | Purpose                                                                                                                             |
| -------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| secret   | `CONVEX_DEPLOY_KEY`                 | Deploy key for that environment's Convex deployment (staging key on `staging`, prod key on `production`)                            |
| secret   | `CLOUDFLARE_API_TOKEN`              | Workers Scripts:Edit on the target account (least-privilege, per the sandbox workflow's pattern)                                    |
| secret   | `CLOUDFLARE_ACCOUNT_ID`             | Cloudflare account to deploy into                                                                                                   |
| secret   | `CLERK_SECRET_KEY`                  | Clerk Backend API key used to mint short-lived API smoke Sessions and the browser smoke sign-in ticket.                             |
| secret   | `CLERK_WEBHOOK_SECRET`              | Svix signing secret for the Clerk → Convex identity mirror; the workflow preflight hard-requires it.                                |
| secret   | `CLAXEDO_RUNTIME_ADMIN_TOKEN`       | Same value installed on the Worker; permits the smoke to invoke the bounded WorkGraph reconciler without waiting for cron.          |
| variable | `CLAXEDO_CONTROL_PLANE_URL`         | Base URL of that environment's Worker, used by the smoke job (e.g. `https://claxedo-control-plane-staging.<subdomain>.workers.dev`) |
| variable | `CLAXEDO_WORKSPACE_RELAY_URL`       | Base URL of that environment's Cloudflare Workspace Relay Worker; passed into the control-plane Worker as a `--var` and preflight-required. |
| variable | `CLAXEDO_SANDBOX_BUILD_ID`          | Content build ID emitted by the successful `claxedo-sandbox-image` workflow for this release; passed into the Worker and preflight-required. |
| variable | `WORKGRAPH_SMOKE_USER_A_ID`         | First dedicated Clerk smoke user.                                                                                                   |
| variable | `WORKGRAPH_SMOKE_USER_A_EMAIL`      | Primary email of smoke user A, used only by the official Clerk Playwright sign-in helper.                                           |
| variable | `WORKGRAPH_SMOKE_USER_B_ID`         | Second distinct Clerk smoke user; must belong to smoke organization A.                                                              |
| variable | `WORKGRAPH_SMOKE_ORGANIZATION_A_ID` | First Clerk organization; both smoke users must be members.                                                                         |
| variable | `WORKGRAPH_SMOKE_ORGANIZATION_B_ID` | Second distinct Clerk organization; smoke user A must be a member.                                                                  |
| variable | `WORKGRAPH_SMOKE_HARNESS`           | Harness ID for the deliberately configured no-op smoke profile.                                                                     |
| variable | `WORKGRAPH_SMOKE_AGENT`             | Agent ID for the no-op smoke profile.                                                                                               |
| variable | `WORKGRAPH_SMOKE_PROVIDER_ID`       | Provider ID advertised by the live execution catalog.                                                                               |
| variable | `WORKGRAPH_SMOKE_MODEL_ID`          | Low-cost model ID advertised by the live execution catalog.                                                                         |
| variable | `WORKGRAPH_SMOKE_EFFORT`            | Supported effort value for the configured smoke model.                                                                              |
| variable | `WORKGRAPH_SMOKE_TOOLS_JSON`        | Exact JSON array of permitted tool IDs; use `[]` for the no-op profile.                                                             |

### `deploy-claxedo-app.yml`

| Kind     | Name                                | Purpose                                                                                                      |
| -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| secret   | `CLOUDFLARE_API_TOKEN`              | Pages deployment permission for the target account.                                                          |
| secret   | `CLOUDFLARE_ACCOUNT_ID`             | Cloudflare account containing the Pages project.                                                             |
| secret   | `CLERK_SECRET_KEY`                  | Clerk Backend API key used by the official Playwright helper to create a short-lived browser sign-in ticket. |
| variable | `CLAXEDO_CONTROL_PLANE_URL`         | Verified Worker URL embedded into the app build.                                                             |
| variable | `CLAXEDO_APP_URL`                   | Deployed app base URL used to verify `/workgraph`.                                                           |
| variable | `CLAXEDO_PAGES_PROJECT`             | Exact Pages project name.                                                                                    |
| variable | `CLAXEDO_PAGES_BRANCH`              | Exact Pages branch for this protected environment.                                                           |
| variable | `VITE_CLERK_PUBLISHABLE_KEY`        | Public Clerk instance key embedded into the app.                                                             |
| variable | `VITE_CONVEX_URL`                   | Public Convex URL embedded into the app.                                                                     |
| variable | `WORKGRAPH_SMOKE_USER_A_ID`         | Clerk user ID asserted from each deployed WorkGraph request token.                                           |
| variable | `WORKGRAPH_SMOKE_USER_A_EMAIL`      | Primary email of the dedicated Clerk smoke user.                                                             |
| variable | `WORKGRAPH_SMOKE_ORGANIZATION_A_ID` | Clerk organization activated and asserted by the deployed browser journey.                                   |

### `deploy-relay.yml`

| Kind            | Name                              | Purpose                                                                                                                        |
| --------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| secret          | `FLY_API_TOKEN`                   | Fly deploy token, scoped to the relay app                                                                                      |
| secret          | `CLAXEDO_RELAY_METRICS_TOKEN`     | Bearer token for the relay's `/metrics` (fails closed without it); must equal the Fly secret of the same name on the relay app |
| variable        | `CLAXEDO_RELAY_FLY_APP`           | Fly app name (`claxedo-workspace-relay-staging` / `claxedo-workspace-relay`)                                                   |
| secret (future) | `CLAXEDO_RELAY_ADMIN_DRAIN_TOKEN` | TODO — only once a control-plane HTTP drain endpoint exists; templated in the workflow                                         |

### `deploy-convex.yml`

| Kind   | Name                | Purpose                                             |
| ------ | ------------------- | --------------------------------------------------- |
| secret | `CONVEX_DEPLOY_KEY` | Deploy key for that environment's Convex deployment |

The standalone Convex workflow is not the normal schema release path. Regular
schema changes enter staging through `deploy-control-plane.yml`; the manual
workflow is reserved for an isolated additive repair or re-push of a compatible
green SHA. Production remains protected by the `production` environment review.

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

Hosted Documents requires the `CLAXEDO_DOCUMENTS` R2 binding. Provision and verify `claxedo-documents-staging` and `claxedo-documents` before deployment with `bunx wrangler r2 bucket info <bucket> --json`. Both staging and production authenticated smokes probe `/documents/__claxedo_deployment_probe__`; the expected 404 proves the route reached a composed Documents backend, while a missing binding returns `document_backend_unavailable` with 503 and blocks promotion.

Connections and signed WorkGraph webhooks require the encrypted per-organization credential backend. Set `CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1` together with `CLAXEDO_CREDENTIALS_KEK`, `CLAXEDO_CF_KV_URL`, and `CLAXEDO_CF_KV_TOKEN`; use `CLAXEDO_CREDENTIALS_KEK_NEXT` only during key rotation. Provider tokens and webhook signing secrets are then written through the Connections setup routes and never placed in WorkGraph or deployment variables.

## WorkGraph Cloud go/no-go

### Before deploy

- [ ] `bunx convex codegen` and `bunx tsc --noEmit --project convex/tsconfig.json` pass.
- [ ] `bun run check:worker-safe` and an explicit Wrangler dry-run pass from `packages/claxedo-server`.
- [ ] The relevant hosted auth, tenant-isolation, Connections, webhook, and background-reconciliation tests pass.
- [ ] Every Convex WorkGraph record and access path is physically scoped by required `(organization_id, owner_user_id)` fields and tuple-leading indexes; migration quarantine cannot starve bounded workers.
- [ ] Core adapter conformance v7 passes, including opaque tenant-and-filter-bound cursors, restart-safe snapshot convergence, Attempt recovery, and source-revision replacement fencing.
- [ ] Execution catalogs carry a content revision and an expiry no more than five minutes after observation; stale and wrong-tenant catalogs fail settings and Attempt admission explicitly.
- [ ] Placement failures reserve durable compensation before external cancellation and cleanup; restart verification proves both operations retry while retaining their failure history.
- [ ] Hosted in-process WorkGraph agent tools are absent until durable Session tenant provenance is available; standalone stdio MCP calls authenticate through the Worker HTTP boundary.
- [ ] Connection credentials and metadata remain organization-owned, while WorkGraph provider mappings, filters, source views, candidates, and bindings are user-owned within that organization.
- [ ] The Convex change is additive and can serve the currently deployed Worker before dependent code ships.
- [ ] The Worker and Convex deployment contain the same control-plane service token, without printing either value.
- [ ] Signed auth, workspace authority, runtime admin, relay, sandbox, and runtime-token signing bindings are present in the target Worker environment.
- [ ] The environment's `CLAXEDO_DOCUMENTS` binding resolves to its dedicated R2 bucket; staging and production never share a bucket.
- [ ] Hosted Connections are either deliberately disabled or have the encrypted per-org credential configuration above; webhook signing secrets exist through Connections for every enabled webhook source.

Any failed item is a no-go. Missing external credentials defer deployed acceptance; they do not invalidate repository-level Worker safety or Convex type evidence.

### Deploy and verify

1. [ ] Start the ordered `deploy-control-plane.yml` release for the reviewed SHA; require its additive Convex deploy and server-side schema validation to succeed first.
2. [ ] Require the workflow to deploy the same reviewed SHA's Worker only after Convex is healthy.
3. [ ] Confirm health, signed-auth mode, both garbage-token 401 probes, and the authenticated Documents backend probe.
4. [ ] Require the signed Stream/Task persistence, cross-tenant and cross-filter cursor denial, refreshed and expiring execution-capability, no-op Attempt result, and asynchronous compensation/cleanup smoke to pass, including isolation for one user represented in two organizations.
5. [ ] Confirm the protected reconciliation call and the next scheduled invocation both complete without an error event.
6. [ ] Require the reusable `deploy-claxedo-app.yml` call from the same ordered release, then run the canonical browser journey on `/workgraph`: inline Streams and Add task, one shared WorkspacePanel for Needs you and Settings, no separate intake/onboarding screen, targeted inspectors, reload, and fresh-session persistence.
7. [ ] Send one valid and one invalid-signature provider webhook to a staging Connection; require one filtered intake refresh and one rejection, with no credential material in logs.

### Roll back or roll forward

- Worker-only failure: roll back the Worker version, then repeat health/auth probes against the still-additive Convex deployment.
- Documents failure: retain both R2 buckets, restore the last known-good Documents Worker, repeat the authenticated backend probe, then use immutable Documents snapshots for content recovery if needed.
- Convex function failure: fix forward by deploying the previous compatible function code or a new corrective commit. Convex data and schema do not roll back.
- Credential or signing-key failure: restore the prior Worker secret/key slot, leave stored Connection ciphertext untouched, and rerun authenticated persistence plus webhook verification.
- Reconciliation failure: stop new execution admission if necessary, retain durable Attempts/jobs, restore the Worker, and verify the next claim uses the persisted lease epoch rather than creating duplicate work.



### WorkGraph operational signals and alert contract

Every local server and hosted Worker composition emits content-free WorkGraph operational events through the configured Control Plane telemetry sink. The event properties contain bounded counts, durations, HTTP status classes, command names, stable error codes, queue kinds, and enumerated outcomes. The telemetry boundary excludes organization and user identifiers, prompts, titles, source text, credentials, provider URLs, repository URLs, and relay URLs.



The server and Worker consume the same in-process monitor contract. Count monitors accumulate within a bounded window and emit one `workgraph.alert` per breached window; gauge monitors evaluate the latest observed backlog or lag. Defaults are production-safe and each value can be tuned per deployment:



Provision the external telemetry destination with a notification rule for `workgraph.alert`, routing `severity=critical` to the primary on-call channel and `severity=warning` to the WorkGraph operations channel. Repository deployment verifies event generation and threshold evaluation; environment-specific PostHog dashboards, destinations, and paging integrations are provisioned in the telemetry account before production promotion.

During an alert, group by `monitor`, `command`, `code`, `kind`, `surface`, and `operation`. Use the protected `/internal/workgraph/reconcile` endpoint to exercise one bounded reconciliation cycle, then verify that queue lag and failure counts return below threshold. Durable Attempts and generation jobs retain their claim epochs across Worker replacement, so recovery proceeds through the persisted reconciler rather than manual record edits.

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
   identity. Release acceptance invokes `bun run smoke:workgraph` with signed
   tenant memberships; it explicitly refreshes and then reads the exact
   workspace-neutral hosted execution catalog, creates and reads a real
   Convex-backed Stream and Task, proves cross-tenant denial, runs the configured
   no-op profile to a durable Attempt result, deletes the Stream, verifies
   asynchronous cleanup, and revokes the short-lived Sessions. Catalog failure
   remains explicit; the smoke never substitutes static or guessed choices.
5. `GET /documents/__claxedo_deployment_probe__` with the authenticated smoke
   identity → exactly **404**. A 503 proves the Worker booted without its
   Documents R2 binding and blocks staging or production promotion.
6. After the Pages release, the official Clerk Playwright helper signs in the
   dedicated smoke user by email and activates smoke organization A. The real
   browser creates a uniquely named Stream and Task through `/workgraph`, proves
   both survive desktop and narrow hard reloads, and deletes them through the
   same UI. The gate fails on page exceptions, app/control-plane 4xx/5xx, or any
   WorkGraph request that uses the local Playwright bypass token.

The relay smoke is `/health` recovery plus the tunnel reconvergence assertion
described above.

## Break-glass (laptop) deploys

Only when Actions itself is the outage. Always deploy a _committed_ SHA —
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
- Focused WorkGraph, Convex, Worker-safety, process-restart, and Claxedo Server
  verification is green in the delivery branch. The final integrated package
  regression remains required before deployment.
- Hosted execution, reconciliation, bootstrap catalog activation, archive,
  cleanup, and deletion barriers are implemented in repository verification.
  Capability GET remains side-effect free and returns one exact server-attested
  catalog version; unavailable state remains explicit. The catalogs currently
  advertise `manual` as the only executable result-integration choice.
- The Docs v2 admission seam exists, but the current legacy Pages surface does
  not yet provide a triggerable Docs journey. Deployed browser acceptance must
  cover it after a durable Docs v2 surface invokes the seam.
- The GitHub `staging` environment currently has none of the required deploy
  variables or secrets. Provision Convex, Cloudflare, Clerk, control-plane,
  sandbox, relay, and WorkGraph smoke configuration before dispatching the
  staged release sequence.
- A staging relay Fly app (`claxedo-workspace-relay-staging`) must be created
  (`fly launch --copy-config --no-deploy`) with its secrets set before the
  staging path of `deploy-relay.yml` can run.
