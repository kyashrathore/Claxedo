# Claxedo Cloudflare Sandbox Worker

Cloudflare Worker that wraps `@cloudflare/sandbox` behind the `cloudflare`
`SandboxDriver`. The driver starts `@claxedo/workspace-runtime` inside the
sandbox and returns the Worker proxy URL used by the relay.

## Status

This Worker does not require `exposePort` or wildcard preview subdomains. Its
data-plane route proxies relay traffic to the workspace runtime port inside the
sandbox.

## Setup

```bash
cd packages/claxedo-server/scripts/sandbox
npx tsx build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build
cd cloudflare-worker
npm install
wrangler login
wrangler deploy
wrangler secret put API_TOKEN
```

The container image `COPY`s the in-repo workspace-runtime host bundle from
`.build/` (produced by `build-sandbox-image.ts --bundle-only`, or automatically
by `scripts/deploy/deploy-hosted.ts --target cloudflare-sandbox`). Native
modules and ACP bins are npm-installed inside the image from the generated
`.build/package.json`, pinned to the versions in
`packages/workspace-runtime/package.json`. Publishing
`@claxedo/workspace-runtime` to npm is a separate release concern and no longer
gates image builds.

## Pinning the control plane to a specific build

Deleting the npm-publish gate removed content immutability at a fixed
workspace-runtime version: two builds at the same core version now produce
different bundles. To keep them distinguishable, `build-sandbox-image.ts`
computes a short content **build-id** (sha256 → 10 hex over the emitted bundle
+ generated `package.json`) and folds it into both the image tag and the
snapshot name:

```
image    ghcr.io/<repo>:workspace-runtime-<version>-<buildId>-v<schema>
snapshot claxedo-workspace-runtime-<version>-<buildId>-v<schema>
```

Every build prints these prominently and writes
`packages/claxedo-server/scripts/sandbox/.build/build-info.json`
(`{ imageTag, snapshotName, buildId, coreVersion }`).
`scripts/deploy/deploy-hosted.ts --target cloudflare-sandbox` and the two
GitHub workflows echo this file after bundling.

The runtime side (sandbox-manager `image.ts`, read at import by the
supervisor/drivers) resolves the snapshot/image name from these env vars, in
precedence order:

1. `CLAXEDO_SANDBOX_IMAGE` / `CLAXEDO_SNAPSHOT_NAME` — override the full names
   outright (highest precedence).
2. `CLAXEDO_SANDBOX_BUILD_ID` — folds the given build-id into the default
   names, so they resolve to the exact build just pushed.
3. Neither set — the default names carry **no** build-id (byte-identical to the
   pre-build-id behavior).

So after a rebuild, set `CLAXEDO_SANDBOX_BUILD_ID` (from the printed
`build-info.json`) on the control plane's environment; the drivers will then
`ensureSnapshot` against the new snapshot name instead of returning early for
the stale one.

## Custom domain setup

Custom domains are optional. A `workers.dev` URL is enough for the sandbox-manager
driver path. If you want a custom domain, add a normal Worker route/CNAME for
the Worker origin; no wildcard route is required.

Update `wrangler.toml` routes only when deploying behind your own domain.

## Configure claxedo-server

Add to `.env`:

```
CLOUDFLARE_API_TOKEN=<the token you set above>
CLOUDFLARE_SANDBOX_WORKER_URL=https://sandbox.yourdomain.com
```

The hosted control plane auto-selects the Cloudflare driver when these values
are present. You can also set `CLAXEDO_SANDBOX_DRIVER=cloudflare` explicitly.
To run the live product-path test against a running claxedo-server:

```bash
CLAXEDO_SERVER_URL=http://127.0.0.1:3001 node --import tsx scripts/sandbox/live/live-ui-test.ts
```

## Egress credential broker (optional)

For non-AI credentials the sandbox must *use* but must never be able to *read*
(e.g. a connection token), the Worker implements Cloudflare's official
[Worker-proxy pattern](https://developers.cloudflare.com/sandbox/guides/proxy-requests/).
The credential is stored in KV keyed by sandbox id (never in the container);
the sandbox gets only a short-lived JWT and routes brokered-host requests
through the Worker, which injects the real credential on egress.

Enable it:

```bash
wrangler kv namespace create EGRESS_SECRETS   # paste the id into wrangler.toml
wrangler secret put EGRESS_SIGNING_SECRET     # random 32+ byte secret
```

Until both are set, brokering stays off and `ensure-runtime` rejects any
`egress` payload with 503 (the sandbox-manager driver declares
`secretBrokering: "proxy"`, and the manager fails closed on brokered secrets
if the Worker isn't configured).

Inside the sandbox, brokered egress uses:
`CLAXEDO_EGRESS_PROXY_URL` (POST/GET here), `Authorization: Bearer
$CLAXEDO_EGRESS_TOKEN`, and `x-claxedo-egress-target: <absolute upstream URL>`.
`CLAXEDO_EGRESS_HOSTS` lists the hosts that must be routed this way. The raw
credential never appears in the container environment.

## Workspace checkpoint storage

The `backup` control action and replacement restore use Cloudflare Sandbox
directory backups. Before deploying the Worker:

```bash
wrangler r2 bucket create claxedo-sandbox-backups
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

The R2 token needs Object Read & Write access to the checkpoint bucket. The
committed `wrangler.toml` binds that bucket as `BACKUP_BUCKET`; local
`wrangler dev` uses the binding without production presigned-URL credentials.
