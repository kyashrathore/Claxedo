# Hosted Control Plane on Cloudflare Workers

The hosted Claxedo control plane runs as a Cloudflare Worker. It is a **pure
control plane**: auth, workspace ownership, relay target resolution, token
minting, user-hosted registration/heartbeat/pause, JWKS, health, and device
login. Local execution — the embedded workspace runtime, PTY/process/file
routes, the cloudflared/Tailscale tunnel, SQLite, and the sandbox supervisor —
stays in the local Node server (`src/server.ts`) and is never bundled into the
Worker.

The Worker entrypoint is `packages/claxedo-server/src/worker.ts`, which serves
the Worker-safe app from `src/hosted-app.ts`. The design and rationale are in
`docs/tech-docs/claxedo-server-worker-deployment-plan.md`.

## Worker API surface

| Method | Path                                                                 | Notes                                                                                                                                                                      |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/claxedo/health`                                                | `localExecution: false` on the Worker                                                                                                                                      |
| GET    | `/api/claxedo/mode`                                                   | status of configured deps (no secrets)                                                                                                                                     |
| GET    | `/api/claxedo/compatibility`                                         | deployed component/protocol versions for rollout checks                                                                                                                    |
| GET    | `/.well-known/jwks.json`                                             | RAT signing public keys                                                                                                                                                    |
| POST   | `/api/auth/device/code` · `/api/auth/device/token`                   | fail-closed until Phase A (see below)                                                                                                                                      |
| GET    | `/api/workspace/:id/connection`                                      | mints a Runtime Access Token (user-hosted)                                                                                                                                 |
| POST   | `/api/workspace/:id/connection/refresh`                              | re-mint with `previousJti`                                                                                                                                                 |
| POST   | `/api/workspace/:id/user-hosted/challenge`                           | returns a signing challenge (CLI owns the host key)                                                                                                                        |
| POST   | `/api/workspace/:id/user-hosted/register`                            | records the link, mints a Host Tunnel Token; does **not** start a tunnel                                                                                                   |
| POST   | `/api/workspace/:id/user-hosted/heartbeat`                           | client-signed; re-mints the Host Tunnel Token                                                                                                                              |
| POST   | `/api/workspace/:id/user-hosted/pause`                               | pauses the link in Convex                                                                                                                                                  |
| ALL    | `/api/workgraph` · `/api/workgraph/*`                                | authenticated personal WorkGraph contract backed by Convex; candidate-admission paths are backend APIs surfaced through Needs you, not a separate intake/onboarding screen |
| GET    | `/api/control/sessions` · `/api/control/sessions/:id/gateway` · `/api/control/sessions/:id/messages` | signed session-visibility inventory and per-session gateway/message reads                                          |
| POST   | `/api/auth/cli/exchange`                                             | signed-bearer → short-lived CLI session tokens (`claxedo login`); fails closed without a Convex-trusted signed identity                                                     |
| ALL    | `/api/billing` · `/api/billing/*`                                    | Polar checkout/portal/webhook and entitlement; fails closed (503) when Polar config is absent                                                                              |
| ALL    | `/documents` · `/documents/*`                                        | hosted Documents backed by the `CLAXEDO_DOCUMENTS` R2 binding; `document_backend_unavailable` (503) without it                                                             |
| ALL    | `/api/claxedo/integrations`                                          | Connections setup routes (provider credential + webhook-secret registration)                                                                                               |
| GET    | `/internal/relay/target` · `/internal/relay/revocation`              | resolver-token / loopback gated                                                                                                                                            |
| POST   | `/internal/sandbox-manager/gc` · `/internal/sandbox-manager/release` | manual sandbox GC / lease release; `CLAXEDO_RUNTIME_ADMIN_TOKEN` gated                                                                                                     |
| POST   | `/internal/workgraph/reconcile`                                      | on-demand invocation of the same bounded durable reconciler as cron; accepts no selector and returns counts only                                                           |

The host keypair is owned by the CLI / local runtime, not the server. Register
is a two-step, client-signed flow: `challenge` → the CLI signs the nonce with
its local private key → `register`. The control plane never holds a host private
key and never starts the tunnel — the CLI does, using the returned Host Tunnel
Token.

The first signed `/api/claxedo/bootstrap` request schedules idempotent WorkGraph
capability-catalog activation through the Worker's `waitUntil` lifecycle. The
trusted `(organization, user)` tenant comes only from verified identity and
membership, and the deterministic tenant catalog workspace provisions without
delaying shell boot. Capability GET and Settings remain observation-only and
accept no tenant or workspace selector; explicit refresh uses the same setup
seam. The catalog response carries a content revision, observation time, and
exclusive expiry capped at five minutes; settings and Attempt admission reject
stale or mismatched values. Hosted in-process agent tools remain fail-closed
until the durable invoking Session supplies verified organization-and-user
provenance. Standalone stdio MCP clients use this Worker's authenticated HTTP
boundary.

## Configuration

Local development needs none of these — the local server boots on loopback
defaults. These are the Worker's production knobs, set as Worker secrets
(`wrangler secret put NAME`) unless noted.

### Required

| Name                                           | Purpose                                                  |
| ---------------------------------------------- | -------------------------------------------------------- |
| `CLAXEDO_SIGNED_CLOUD_AUTH`                    | `"1"` to enable signed auth (set as a `[vars]` value)    |
| `CLERK_JWT_ISSUER`, `CLERK_JWKS_URL`           | signed-auth verification (`CLERK_JWT_AUDIENCE` optional) |
| `CLAXEDO_WORKSPACE_AUTHORITY_URL`              | hosted workspace/link/audit state                        |
| `CLAXEDO_WORKSPACE_RELAY_URL`                  | relay URL returned in connection data                    |
| `CLAXEDO_RELAY_RESOLVER_TOKEN`                 | authorizes `/internal/relay/*` callers                   |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM` | RAT/HTT signing key (EdDSA PKCS8)                        |

The Worker **fails closed** (`503`) at boot if signed auth, the workspace
authority URL, relay URL, resolver token, or the signing key is missing.

### Common

| Name                                                    | Purpose                                                                                                               |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM`           | published at JWKS                                                                                                     |
| `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN`                   | unsigned relay-revocation queries to Convex                                                                           |
| `CLAXEDO_RUNTIME_ADMIN_TOKEN`                           | authorizes `/internal/sandbox-manager/*` and `/internal/workgraph/reconcile`; must differ from the resolver token     |
| `CLAXEDO_SANDBOX_DRIVER`                                | optional cloud sandbox driver: `cloudflare`, `daytona`, or `fetch`; auto-selected from present credentials when unset |
| Cloudflare driver                                       | `CLOUDFLARE_SANDBOX_API_TOKEN`, `CLOUDFLARE_SANDBOX_WORKER_URL` (`CLOUDFLARE_API_TOKEN` remains a compatibility fallback) |
| Daytona driver                                          | `DAYTONA_API_KEY`, `CLAXEDO_DAYTONA_SNAPSHOT`                                                                         |
| fetch-bridge driver                                     | `CLAXEDO_SANDBOX_DRIVER_URL` — explicit-only: requires `CLAXEDO_SANDBOX_DRIVER=fetch`, never auto-selected so a stray URL can't become the hidden model |
| `CLAXEDO_DEVICE_LOGIN_ISSUER` (+ optional `_CLIENT_ID`) | device-login broker (Phase A)                                                                                         |
| `CLAXEDO_POSTHOG_KEY`, `CLAXEDO_POSTHOG_HOST`           | optional telemetry (fetch-based)                                                                                      |

Additional knobs — per-region relay endpoints, request rate-limit caps,
key-rotation `_NEXT_*` extras, and device-login URL/audience/scope overrides —
exist with sensible defaults; see the package source if you need them.

### Durable Objects

The Worker declares three Durable Object bindings (`wrangler.toml`; DO bindings
are not inherited by environments, so each is mirrored under `[env.staging]`).
Migrations are declared once at the top level and inherited.

| Binding           | Class              | Role                                                                                                      |
| ----------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `WORKGRAPH_SETTLER` | `WorkGraphSettler` | The bounded WorkGraph settlement driver invoked by cron and `/internal/workgraph/reconcile`.             |
| `WAKE_LANE`       | `ClaxedoWakeLane`  | Wakes-v2 per-lane settlement driver. The binding exists on every deploy; behavior is opt-in.             |
| `LIVE_SYNC_ROOM`  | `LiveSyncRoom`     | Per-owner live-sync fan-out: holds hibernatable internal WebSockets, bridges them to the public SSE route, and fans nudges POSTed from any isolate. |

`CLAXEDO_WAKES_SETTLEMENT="1"` flips settlement onto the wakes path (durable
dirty-flag wake + `WAKE_LANE` DO). It is set only on `[env.staging.vars]`;
production stays on `WORKGRAPH_SETTLER` until the staging latency budgets hold.
Rollback is deleting the line and redeploying.

## Build and deploy

From `packages/claxedo-server`:

```sh
# Verify the bundle compiles and is local-free (no Cloudflare account needed)
npx wrangler deploy --dry-run --outdir dist-worker

# Deploy to staging (needs CLOUDFLARE_API_TOKEN + account)
npx wrangler secret put CLERK_JWT_ISSUER --env staging   # …repeat per secret
npx wrangler deploy --env staging
```

`nodejs_compat` is enabled as a small compatibility net and to populate
`process.env` from bindings (the only consumer is convex-authority's unsigned
service-token path). Control-plane signing and JWKS use **global Web Crypto**,
not `node:crypto`.

## Verify

```sh
BASE=https://claxedo-control-plane-staging.<your-subdomain>.workers.dev

# Unauthenticated smoke
curl -s "$BASE/api/claxedo/health"          # {"ok":true,"mode":"hosted-control-plane","localExecution":false}
curl -s "$BASE/api/claxedo/mode"            # configured-dependency flags
curl -s "$BASE/api/claxedo/compatibility"   # deployed component/protocol versions
curl -s "$BASE/.well-known/jwks.json"       # {"keys":[…]}

# Signed smoke (TOKEN = a Clerk-issued user bearer Convex trusts)
curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/workspace/<id>/connection"

# WorkGraph signed user-and-organization isolation, persistence, and capability smoke
BASE_URL="$BASE" \
CLERK_SECRET_KEY="$CLERK_SECRET_KEY" \
WORKGRAPH_SMOKE_USER_A_ID="$USER_A" \
WORKGRAPH_SMOKE_USER_B_ID="$USER_B" \
WORKGRAPH_SMOKE_ORGANIZATION_A_ID="$ORGANIZATION_A" \
WORKGRAPH_SMOKE_ORGANIZATION_B_ID="$ORGANIZATION_B" \
WORKGRAPH_SMOKE_RECONCILE_TOKEN="$CLAXEDO_RUNTIME_ADMIN_TOKEN" \
WORKGRAPH_SMOKE_HARNESS="opencode" \
WORKGRAPH_SMOKE_AGENT="smoke" \
WORKGRAPH_SMOKE_PROVIDER_ID="$PROVIDER_ID" \
WORKGRAPH_SMOKE_MODEL_ID="$MODEL_ID" \
WORKGRAPH_SMOKE_EFFORT="low" \
WORKGRAPH_SMOKE_TOOLS_JSON='[]' \
WORKGRAPH_SMOKE_REPOSITORY_URL="$REPOSITORY_URL" \
WORKGRAPH_SMOKE_BASE_REVISION="$BASE_REVISION" \
bun run smoke:workgraph
```

The release WorkGraph smoke mints user A Sessions with organizations A and B
active plus a user B Session with organization A active. User A must belong to
both organizations and user B must belong to organization A. It explicitly
refreshes and then reads the workspace-neutral execution catalog, and performs
one Convex-backed Stream-and-Task create/read/execute/delete cycle. The
configured profile is a deliberately cheap no-op smoke Agent. The protected
reconcile trigger drives the same work cron would drive, while rejecting
tenant/workspace selectors and rate limiting repeated machine requests. Final
acceptance additionally proves cross-tenant isolation, including one user
represented in two organizations. This deployment has not yet been executed.
Release acceptance also requires the canonical browser journey against the
deployed app and workspace runtime using the one shared WorkspacePanel.

Focused WorkGraph, Convex, Worker-safety, and Claxedo Server verification is
green in the delivery branch. The currently advertised result-integration
choice is `manual`; pull-request and direct integration remain reserved
contract values until their hosted runtime paths exist. The Docs v2 adapter
seam exists, while the current legacy Pages surface does not yet provide the
triggerable document-to-work journey.

No staging deployment has been executed. The GitHub staging environment still
needs its Convex, Cloudflare, Clerk, control-plane, sandbox, relay, and smoke
configuration before this repository evidence can become deployed acceptance.

## Release ordering

`deploy-control-plane.yml` is the normal Cloud release owner. It deploys the
additive Convex schema and functions, then the Worker, then runs authenticated
smoke verification, and finally invokes the Pages app deployment from the same
SHA. Production repeats that sequence behind the protected GitHub environment.
Top-level Convex, Worker, and app workflows share one deployment concurrency
group. The reusable app workflow has no independent trigger or lock, so its
control-plane or app-only staging caller retains the global lock.
`deploy-convex.yml` is an operator-only Convex roll-forward for an isolated
compatible SHA.

Every release validates its complete GitHub environment configuration before
the first Convex mutation. Runtime Worker secrets and Convex function variables
are provisioned separately and are proven by the fail-closed mode and signed
WorkGraph smoke gates documented in `public-docs/deploy-runbook.md`.

## Guardrails

- `src/worker.import-graph.test.ts` statically walks the Worker import graph and
  fails if any local-only module (`workspace-store`, `workspace-supervisor`,
  `embedded-workspace-runtime`, `user-hosted-tunnel`,
  `credentials/store|registry|local`, `cloud/sandbox`,
  `server.ts`, …) or Node-only package (`@hono/node-server`, `better-sqlite3`,
  `node-pty`, `node:child_process`, `node:crypto`, `fs`, `posthog-node`, …)
  enters the graph. Run it (and the bundle dry-run) before every Worker change.
- Behaviour is covered by `src/hosted-app.test.ts`,
  `src/routes/hosted-workspace.test.ts`,
  `src/routes/hosted-internal-relay.test.ts`, and
  `src/control-plane/worker-runtime-token.test.ts`.

## Known external dependency: device login (Phase A)

`/api/auth/device/code` and `/api/auth/device/token` are implemented, but fail
closed until signed-mode issuer configuration is present. The relevant code
pointers are `docs/tech-docs/identity-roles-auth-foundation.md` and
`docs/tech-docs/claxedo-up-cli-plan.md`. Until a device-login issuer is
configured (`CLAXEDO_DEVICE_LOGIN_ISSUER`), these endpoints return
`501 device_login_unconfigured`.
