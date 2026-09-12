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
npm ci
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

## Native credential brokering

The API-token-gated `ensure-runtime` action accepts named egress registrations.
The Worker stores values in `EGRESS_SECRETS` KV and configures SDK native HTTPS
outbound handlers. Container environment variables contain only
`claxedo-broker:<name>` placeholders. Clients use the original upstream URL.
Authorization clients may send the placeholder as the complete header or with
one Bearer prefix; the handler replaces it with the complete registered value.

Create the namespace with `wrangler kv namespace create EGRESS_SECRETS` and
set its id in `wrangler.toml`. A nonempty registration requires this binding.
Omitting `egress` preserves registrations; sending `egress: []` clears them.
Malformed registrations return 400. Every intercepted request reads KV, so
rotation needs no runtime token renewal. KV propagation delays apply.
A request to a registered host that carries no `claxedo-broker:` placeholder is
forwarded exactly as sent, with no credential attached and no response
scrubbing: `git clone`, `npm install` and `curl` reach the same hosts as a
brokered client, and refusing them would break the sandbox the moment a token
for that host is registered. A request that does carry a placeholder must match
a live registration for that host over HTTPS on port 443, or it is refused.
The handler rejects unmatched placeholders and redirects; it does not redact
response bodies or restrict unrelated destinations.

### Interception is whole-container, and cannot be narrowed

`Sandbox.interceptHttps = true` plus `setOutboundByHosts` puts EVERY outbound
request from the container through this Worker, not only the registered hosts.
This is a property of `@cloudflare/containers` as bundled in
`@cloudflare/sandbox` 0.12.9, not a choice here:

- `shouldInterceptAllOutbound()` returns true as soon as
  `outboundByHostOverrides` is non-empty, and `setOutboundByHosts` is the only
  runtime API that registers a host — so the first registration promotes the
  container to intercept-all.
- The promotion latches in `hasInterceptAllRegistration` and stays until the
  instance restarts.
- Under intercept-all with `interceptHttps`, the SDK installs
  `interceptOutboundHttps('*')` and `interceptAllOutboundHttp`.
- Per-host interception exists only for the STATIC `outboundByHost` class
  registry, which is fixed at deploy time and cannot carry per-sandbox
  registrations read from KV.

Unregistered hosts still reach the internet — `ContainerProxy` falls through to
`fetch(request)` on the `enableInternet` path — but they do so through a
Worker-terminated TLS connection.

Only Node and Bun HTTPS clients have been exercised against this
(Appendix E item 3, local probe). The CLIs baked into `Dockerfile` —
`claude`, `codex`, `gemini`, `pi`, `cursor-agent`, `amp`, `droid` — were not
probed, and an agent CLI that pins its own CA bundle or ships its own TLS stack
will fail against an intercepted connection in a way no local test here shows.
That is why deployed acceptance is still required before this adapter is called
complete.

The former `/egress` JWT route and signing secret are removed. Deploy the
Worker and matching driver together, then destroy and recreate existing
sandboxes with fresh named registrations. No legacy registration migration or
proxy compatibility route is provided.
Local native HTTPS interception passed; deployed acceptance remains pending
because the isolated probe image upload failed (see the implementation report).

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
