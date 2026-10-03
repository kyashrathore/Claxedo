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
`.build/` (produced by `build-sandbox-image.ts --bundle-only`, which the
`deploy-cloudflare-sandbox-worker` workflow runs before `npm run deploy`). Native
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
+ generated `package.json`) and folds it into the image tag:

```
image    ghcr.io/<repo>:workspace-runtime-<version>-<buildId>-v<schema>
```

Every build prints these prominently and writes
`packages/claxedo-server/scripts/sandbox/.build/build-info.json`
(`{ imageTag, buildId, coreVersion }`).
The `deploy-cloudflare-sandbox-worker` and `claxedo-sandbox-image` workflows
echo this file after bundling.

The runtime side (sandbox-manager `image.ts`, read at import by the
supervisor/drivers) resolves the image name from these env vars, in precedence
order:

1. `CLAXEDO_SANDBOX_IMAGE` — overrides the full name outright (highest
   precedence).
2. `CLAXEDO_SANDBOX_BUILD_ID` — folds the given build-id into the default
   name, so it resolves to the exact build just pushed.
3. Neither set — the default name carries **no** build-id.

So after a rebuild, set `CLAXEDO_SANDBOX_BUILD_ID` (from the printed
`build-info.json`) on the control plane's environment so the drivers use the
new image.

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

## Native credential brokering

The API-token-gated `ensure-runtime` action accepts named egress registrations.
The Worker stores values in `EGRESS_SECRETS` KV and intercepts HTTPS to the
registered hosts with its `CredentialEgress` entrypoint. Container environment variables contain only
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

### Only credential hosts are intercepted

The SDK's runtime host overrides (`setOutboundByHosts`, `setOutboundHandler`)
promote a container to intercepting every outbound request
(`@cloudflare/containers` 0.3.7 `shouldInterceptAllOutbound()`), which would put
this Worker in the path of all sandbox traffic. The Worker does not use them.
`Sandbox.setCredentialHosts` records the hosts the registrations name and
installs `ctx.container.interceptOutboundHttps(host, CredentialEgress)` for
exactly those, on a running container at once and on every container start
(the `start` and `startAndWaitForPorts` overrides run before the SDK starts it).
Every other host keeps its direct route.

`interceptHttps = true` makes the container server trust the platform CA and
refuse to start without it, and the platform mints that CA with the first HTTPS
interception. Every container therefore also intercepts
`claxedo-credential-trust.invalid`, a reserved name no request resolves, so a
sandbox that starts before it holds any credential host still has the CA, and
a host registered later is intercepted without restarting the container.

The platform offers no way to remove an interception, so a withdrawn host stays
routed through `CredentialEgress` until the container restarts; without a
registration it forwards requests without a placeholder unchanged and refuses
ones that carry a placeholder.

Node and Bun HTTPS clients passed the local probe. The CLIs baked into
`Dockerfile` — `claude`, `codex`, `gemini`, `pi`, `cursor-agent`, `amp`,
`droid` — were not probed against an intercepted connection, and an agent CLI
that pins its own CA bundle or ships its own TLS stack fails against one in a
way no local test here shows. Deployed acceptance is still required.

The former `/egress` JWT route and signing secret are removed. Deploy the
Worker and matching driver together, then destroy and recreate existing
sandboxes: one created with the SDK's runtime overrides persisted them, and
re-applying them needs the SDK `ContainerProxy` export this Worker no longer has. No migration or compatibility route is provided.

## Repository preparation

The runtime checks out the workspace's repository before it reports ready
(`src/hosts/workspace-runtime/repository-source.ts` in claxedo-server), in
place and bounded by the same 30-minute clone limit as a local clone. A boot
killed mid-fetch leaves a repository with no commit yet, which the next boot
finishes; an existing checkout is only checked against its origin, so it boots
without reaching the repository. A private repository's clone credential is
the brokered `CLAXEDO_GITHUB_CLONE_AUTH`, scoped to that repository's path and
minted on every boot from the connection the workspace was created through.

`ensure-runtime` keeps a live runtime that is not ready yet instead of
replacing it, so a large clone finishes across polls; an exited runtime, or a
changed set of credential names, is replaced.

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
