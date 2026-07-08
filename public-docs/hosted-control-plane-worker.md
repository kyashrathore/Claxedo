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

| Method | Path | Notes |
|---|---|---|
| GET | product health route | `localExecution: false` on the Worker |
| GET | product mode route | status of configured deps (no secrets) |
| GET | `/.well-known/jwks.json` | RAT signing public keys |
| POST | `/api/auth/device/code` · `/api/auth/device/token` | fail-closed until Phase A (see below) |
| GET | `/api/workspace/:id/connection` | mints a Runtime Access Token (user-hosted) |
| POST | `/api/workspace/:id/connection/refresh` | re-mint with `previousJti` |
| POST | `/api/workspace/:id/user-hosted/challenge` | returns a signing challenge (CLI owns the host key) |
| POST | `/api/workspace/:id/user-hosted/register` | records the link, mints a Host Tunnel Token; does **not** start a tunnel |
| POST | `/api/workspace/:id/user-hosted/heartbeat` | client-signed; re-mints the Host Tunnel Token |
| POST | `/api/workspace/:id/user-hosted/pause` | pauses the link in Convex |
| GET | product compatibility route | deployed component/protocol versions for rollout checks |
| GET | `/internal/relay/target` · `/internal/relay/revocation` | resolver-token / loopback gated |
| POST | `/internal/sandbox-manager/gc` · `/internal/sandbox-manager/release` | manual sandbox GC / lease release; `CLAXEDO_RUNTIME_ADMIN_TOKEN` gated |

The host keypair is owned by the CLI / local runtime, not the server. Register
is a two-step, client-signed flow: `challenge` → the CLI signs the nonce with
its local private key → `register`. The control plane never holds a host private
key and never starts the tunnel — the CLI does, using the returned Host Tunnel
Token.

## Configuration

Local development needs none of these — the local server boots on loopback
defaults. These are the Worker's production knobs, set as Worker secrets
(`wrangler secret put NAME`) unless noted.

### Required

| Name | Purpose |
|---|---|
| `CLAXEDO_SIGNED_CLOUD_AUTH` | `"1"` to enable signed auth (set as a `[vars]` value) |
| `CLERK_JWT_ISSUER`, `CLERK_JWKS_URL` | signed-auth verification (`CLERK_JWT_AUDIENCE` optional) |
| `CLAXEDO_WORKSPACE_AUTHORITY_URL` | hosted workspace/link/audit state |
| `CLAXEDO_WORKSPACE_RELAY_URL` | relay URL returned in connection data |
| `CLAXEDO_RELAY_RESOLVER_TOKEN` | authorizes `/internal/relay/*` callers |
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM` | RAT/HTT signing key (EdDSA PKCS8) |

The Worker **fails closed** (`503`) at boot if signed auth, the workspace
authority URL, relay URL, resolver token, or the signing key is missing.

### Common

| Name | Purpose |
|---|---|
| `CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM` | published at JWKS |
| `CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN` | unsigned relay-revocation queries to Convex |
| `CLAXEDO_RUNTIME_ADMIN_TOKEN` | authorizes `/internal/sandbox-manager/*`; must differ from the resolver token |
| `CLAXEDO_SANDBOX_DRIVER` | optional cloud sandbox driver: `cloudflare`, `daytona`, or `fetch`; auto-selected from present credentials when unset |
| Cloudflare driver | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_SANDBOX_WORKER_URL` |
| Daytona driver | `DAYTONA_API_KEY`, `CLAXEDO_DAYTONA_SNAPSHOT` |
| `CLAXEDO_DEVICE_LOGIN_ISSUER` (+ optional `_CLIENT_ID`) | device-login broker (Phase A) |
| `CLAXEDO_POSTHOG_KEY`, `CLAXEDO_POSTHOG_HOST` | optional telemetry (fetch-based) |

Additional knobs — per-region relay endpoints, request rate-limit caps,
key-rotation `_NEXT_*` extras, and device-login URL/audience/scope overrides —
exist with sensible defaults; see the package source if you need them.

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
curl -s "$BASE/<product-health-route>"      # {"ok":true,"mode":"hosted-control-plane","localExecution":false}
curl -s "$BASE/<product-mode-route>"        # configured-dependency flags
curl -s "$BASE/.well-known/jwks.json"       # {"keys":[…]}

# Signed smoke (TOKEN = a Clerk-issued user bearer Convex trusts)
curl -s -H "authorization: Bearer $TOKEN" "$BASE/api/workspace/<id>/connection"
```

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
