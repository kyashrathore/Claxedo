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
wrangler deploy --var CONTROL_PLANE_URL:https://<control-plane-origin>
wrangler secret put API_TOKEN
wrangler secret put IDLE_STOP_TOKEN
```

The container image `COPY`s the in-repo workspace-runtime host bundle from
`.build/` (produced by `build-sandbox-image.ts --bundle-only`, which the
`deploy-cloudflare-sandbox-worker` workflow runs before `npm run deploy`). Native
modules and ACP bins are npm-installed inside the image from the generated
`.build/package.json`, pinned to the versions in
`packages/workspace-runtime/package.json`. Publishing
`@claxedo/workspace-runtime` to npm is a separate release concern and no longer
gates image builds.

### Deploying over existing sandboxes

A sandbox created by a Worker that used the SDK's runtime outbound overrides
(`setOutboundByHosts` or `setOutboundHandler`) persisted that configuration in
its Durable Object storage. On its next container start `@cloudflare/containers`
re-applies it through the SDK `ContainerProxy` export, which this Worker no
longer has, and the start throws. `DELETE /sandbox/:id` is not enough: the SDK's
destroy keeps that key (`OUTBOUND_CONFIGURATION`), and the control plane names a
sandbox by its workspace, so a recreated one reads it back. Before rolling this
Worker out, reset the `Sandbox` namespace's storage: `wrangler delete` the
Worker (which deletes its Durable Object namespaces and their storage), then
deploy, and let the control plane recreate workspaces' sandboxes. No migration
is provided; only sandboxes created by this Worker start.

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
`Dockerfile` — `claude`, `codex`, `pi`, `cursor-agent`, `amp`, `droid` — were
not probed against an intercepted connection, and an agent CLI that pins its
own CA bundle or ships its own TLS stack fails against one in a way no local
test here shows. Deployed acceptance is still required.

The former `/egress` JWT route and signing secret are removed. Deploy the
Worker and matching driver together, after destroying existing sandboxes (see
"Deploying over existing sandboxes").

## Repository preparation

The runtime checks out the tip of the workspace's repository before it reports
ready (`src/hosts/workspace-runtime/repository-source.ts` in claxedo-server):
one depth-1 fetch of the selected branch, in place, within a 30-minute deadline
for the whole preparation (`RUNTIME_PREPARATION_DEADLINE_MS` in
`boot-contract.ts`). A boot stopped mid-fetch leaves a repository with no
commit yet, which the next boot finishes. A checkout with a commit is the
person's work and boots as it is, without reaching the repository. Once the
runtime is listening, it deepens the selected branch alone in the background
(`repository-history.ts`), 1,000 generations per fetch, 5 seconds apart, with
`--no-auto-maintenance`. Each finished fetch is kept, so a runtime stopped
partway resumes from there on its next boot. The steps end when the checkout is
complete, when a step brings nothing (the commit the checkout began from was
amended or force-pushed away), at the first failure, or when the runtime drains,
which ends the running fetch with its whole process group so no git outlives it
holding `shallow.lock`. While another git holds that lock the steps wait
without fetching, a step that meets it mid-fetch waits and tries again, and no
step deepens a checkout that is already complete. At boot, a `shallow.lock` is
removed when `ps` shows no git process that could hold it.

A private repository's clone credential is the brokered
`CLAXEDO_GITHUB_CLONE_AUTH`, scoped to that repository's path and minted on
every boot from the connection the workspace was created through.

`ensure-runtime` decides about an existing runtime as follows:

- A live runtime that has answered ready once is kept, however long it has run;
  a slow health check answers 503 (still starting) and never replaces it. The
  Worker records the start time the container reports for it (read back with
  `getProcess` once it is ready, because `startProcess` answers with the
  Worker's own clock), in Durable Object storage, and writes only when it
  changes.
- A live runtime that has never answered ready is still preparing its
  repository and is kept, until it is 35 minutes old (the preparation deadline
  plus 5 minutes), when it is wedged and replaced.
- A runtime that exited before it was ever ready failed its boot. The answer is
  502 `{ ready: false, exited: true, error }` with the reason the runtime
  printed (a revoked token, a branch that does not exist), credentials blanked
  by `src/runtime-log.ts`, and the exited
  process is cleared so the next ensure boots afresh. The driver reports it as a
  failed ensure, never as provisioning, and the connect answers
  `cloud_runtime_boot_failed` with the reason.
- A runtime that exited after it had served, or any runtime when the set of
  credential names changed, is replaced.

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

A checkpoint captures the directories the driver names (the workspace and
`/home/claxedo`, the runtime's HOME), one SDK backup each, sequentially, inside
the Durable Object; HOME's rebuildable caches (`.cache`, `.npm/_cacache`,
`.bun/install/cache`) are left out to shorten the freeze. Its provider reference
is the backup ids joined with commas, in capture order, and a restore mounts
each id over its directory inside the single runtime launch. The SDK writes
`backups/<id>/data.sqsh` and `meta.json` and never deletes them, so every
backup has a deletion rule:

- The object records each backup id as soon as it exists. The next capture or
  stop names the checkpoint the lease committed (`committed`) and deletes every
  recorded id outside it, so a capture whose caller gave up, or whose commit
  never happened, does not outlive the next one. A capture that fails partway
  deletes what it made at once.
- `delete-backup` deletes the checkpoint a newer one replaced and the last one
  of a destroyed workspace.

The backup TTL only bounds how long a sleeping workspace can still restore.

## Idle stop

The SDK's own sleep stops a container after an interval without requests, which
loses everything outside the backups, while an open browser stream keeps a
container awake indefinitely. The Worker therefore keeps a ready container alive
(`setKeepAlive(true)`) and stops it only through a checkpoint:

- `ensure-runtime` records the lease's `workspaceId` and `epoch` labels, gives the
  runtime a health token as `WORKSPACE_RUNTIME_CONFIG_TOKEN` (kept across boots
  in Durable Object storage), and refuses with 503 when `CONTROL_PLANE_URL` (a
  `--var` the deploy sets) or the `IDLE_STOP_TOKEN` secret is missing, because
  nothing would ever stop that container.
- Every 30 seconds the Durable Object reads `idleSince` and `frozenSince` from
  the runtime's `GET /api/wr/health`. The runtime owns those answers: idle means
  no turn, admitted write or background work, no checkpoint in progress, and no
  terminal input or output since; an open but quiet shell is not work, nor are
  HTTP reads and event streams.
- Once `idleSince` is older than `WORKSPACE_IDLE_MS` (default 600000), or the
  runtime has been frozen for 15 minutes (longer than any checkpoint holds it),
  it posts `{ workspaceId, epoch, idleBefore }` to the control plane's
  `/internal/sandbox/idle-stop` with `IDLE_STOP_TOKEN`, a secret the two share
  for this call alone (`CLOUDFLARE_SANDBOX_IDLE_STOP_TOKEN` on the control
  plane). The control plane freezes the runtime only if it is still idle since
  `idleBefore`, captures it, and commits the checkpoint and the stopped lease
  in one update; a lease it already stopped is answered the same way, and a
  runtime a failed capture left frozen is thawed and refused. The answer names
  the committed checkpoint, and the object then stops its own container. From
  the commit on, a send wakes a restore of this checkpoint.
- `stop` (the control plane's own stop) is fenced: a sandbox a newer lease
  generation already took over keeps running.

A failed idle check is logged as `workspace idle stop failed` and retried at the
next check. After 20 failures in a row the object stops keeping the container
alive, so the SDK's own sleep bounds what a dead runtime or a refused stop costs.
