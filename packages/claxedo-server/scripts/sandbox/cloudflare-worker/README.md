# Claxedo Cloudflare Sandbox Worker

Cloudflare Worker behind the `cloudflare` `SandboxDriver`. Each workspace's
sandbox is one `WorkspaceSandbox` Durable Object, which starts, snapshots,
restores and stops its container through the platform's `ctx.container` API
and runs `@claxedo/workspace-runtime` inside it. The driver gets back the
Worker's own proxy URL, which the relay uses.

## Setup

```bash
cd packages/claxedo-server/scripts/sandbox
npx tsx build-sandbox-image.ts --bundle-only --out=cloudflare-worker/.build
cd cloudflare-worker
npm ci
wrangler login
wrangler deploy --var CONTROL_PLANE_URL:https://<control-plane-origin> \
  --var RUNTIME_BUILD_ID:<buildId> --var RUNTIME_VERSION:<coreVersion> --var RUNTIME_DIGEST:<runtimeDigest>
wrangler secret put API_TOKEN
wrangler secret put IDLE_STOP_TOKEN
```

`wrangler deploy` builds `Dockerfile` (the `runtime` image of the container
application) with Docker, pushes it to Cloudflare's registry and deploys the
Worker; the `deploy-cloudflare-sandbox-worker` workflow does this in CI. The
image `COPY`s the in-repo workspace-runtime host bundle from `.build/`. Native
modules and ACP bins are npm-installed inside the image from the generated
`.build/package.json`, pinned to the versions in
`packages/workspace-runtime/package.json`.

## Platform API and Sandbox SDK 1.x

Container snapshots need the container application's `durable_object`
scheduling policy (Wrangler 4.131.0 or later), and Sandbox SDK 1.x moved
container ownership onto that platform API: a Durable Object starts and drives
`this.ctx.container` itself, and `@cloudflare/sandbox` 1.x keeps only `Files`,
`S3Mount` and `DirectoryBackup`. This Worker uses none of the three, so it has
no Sandbox SDK dependency. What each capability maps to:

| Capability | 0.12 `Sandbox` | Now |
| --- | --- | --- |
| Start | `getSandbox()`, lazy start on first call | `ensureWorkspace` calls `container.start({ image \| containerSnapshot, entrypoint: ["/usr/bin/tini", "--", "sleep", "infinity"], enableInternet: true, instance: "standard-1" })`, then waits for the first `exec(["true"])`, racing `monitor()`. tini as PID 1 reaps orphaned processes; a PID 1 that never waits leaves them as zombies in their launch's process group, which retirement then never reads as exited |
| Runtime process | `startProcess`, `listProcesses`, `getProcess` | `runtime-process.ts`: `exec` of a `setsid` launcher that records the pid and exit code under `/run/claxedo-runtime/<launch>`; a status script reads them; the launch id, time and readiness live in Durable Object storage |
| Readiness | `waitForPort(port, { path: "/global/health" })` | `getTcpPort(port).fetch("/global/health")` every 500 ms for 30 s, ending early once the process has exited |
| Proxy HTTP and WebSocket | `containerFetch`, `wsConnect` | the Worker forwards to the object's `fetch()`, which forwards to `getTcpPort(port).fetch(request)`; an upgrade answer passes through unchanged |
| Exec | SDK `exec` | `container.exec(argv, { env, cwd })`; it inherits only `PATH`, so the launcher passes the image's environment (read from `/proc/1/environ`), the interception trust variables and the boot env |
| Egress brokering | `interceptHttps = true`, start overrides | `interceptOutboundHttps(host, CredentialEgress)` on every container start, on a running container when hosts change, and from the constructor of a restarted object; the CA is trusted by rebuilding the system bundle (below) |
| Idle stop | `setKeepAlive(true)`, `schedule()` | a Durable Object alarm every 30 seconds, which is activity and keeps the container running; `setInactivityTimeout(10 min)` bounds a container once the alarm chain ends |
| Stop, destroy | `stop()`, `destroy()` | `container.destroy()`; `DELETE` also clears the object's storage |
| Registry for GC | R2 objects under `sandbox-registry/` | unchanged, bound as `SANDBOX_REGISTRY` |
| Control auth | string comparison of `API_TOKEN` | SHA-256 digests of both, compared with `crypto.subtle.timingSafeEqual` |
| Labels | `setLabels` | the registry's `customMetadata` (`app`, `workspaceId`, `epoch`, `homeRegion`); nothing reads container labels, so none are set |
| Persistence | `createBackup` and `restoreBackup` of `/workspace` and HOME to R2 | `snapshotContainer()` of the whole writable root filesystem, restored by `start({ containerSnapshot })` |

The `durable_object` policy is fixed when a container application is created,
so `WorkspaceSandbox` is a new class and application (migration `v2`), and the
retired `Sandbox` class is deleted with its storage.

### Placement

The policy refuses `instance_type`, `max_instances` and `constraints.regions`,
so the former APAC pin is gone, and a container is placed near its Durable
Object. In place of `max_instances`, the control plane caps each organization's
running cloud workspaces at every start that puts a machine up, a first lease or
a wake (`workspace/cloud-workspace-start.ts`, 25 by default).

The Worker reaches every object by its name alone, so Cloudflare places it by
default: near the Worker invocation that first reaches it, and it never moves.
That invocation is the first `ensure-runtime`, which the control plane's
`SandboxProvisioner` object sends from its alarm, so a sandbox lands near that
object, which in turn was created near the control-plane Worker that first
reached it. A sandbox placed in a region a model vendor refuses stays there:
from HKG, Anthropic answers every request 403
`{"type":"forbidden","message":"Request not allowed"}` with no request id, before
reading any credential, and OpenAI refuses Hong Kong as well. Only a new
sandbox name gets a new placement.

## Workspace persistence

A checkpoint is one container snapshot. The control plane's capture freezes the
runtime, flushes it and retires its transports, then calls `snapshot`; the
object answers `{ snapshotId, sizeBytes, runtimeBuild }` from
`snapshotContainer()` and records the snapshot in its own storage with the
runtime build and image environment of the container it came from. When that
capture ends the lease, the control plane commits it and calls `stop`, and the
object destroys its container. The next wake's `ensure-runtime` carries
`restore: { snapshotId }` and `minimumRuntimeVersion`, and the object starts the
container from that snapshot, never from the image, passing the recorded image
environment to the container's main process and running the main process
the snapshot's container ran; a snapshot recorded without one is refused as
`not_restorable`. A restore over a container running
from anything but that snapshot replaces it; polls of the same restore keep it.

A snapshot keeps every file of the root filesystem: the repository and its
edits, the runtime store and harness homes under `/home/claxedo`, global npm
installs and apt packages. It holds no process, no memory and no mount. Each
launch's pid, exit code and unredacted output live in `/run/claxedo-runtime`,
which every start checks is `tmpfs` and mounts one over when it is not, so no
runtime output reaches a snapshot.

**What a snapshot carries that is sensitive.** On this Worker every credential
the container sees is a `claxedo-broker:<name>` placeholder; the values stay in
`EGRESS_SECRETS`. Read of the code (2026-10-16), the files under HOME hold:

- `.gitconfig`: `http.<repo>.extraheader` with the clone placeholder, rewritten
  or withdrawn by every boot (`hosts/workspace-runtime/git-auth.ts`).
- Codex homes: `cli_auth_credentials_store = "ephemeral"`; a plan token travels
  over JSON-RPC in memory, and `auth.json` is linked only for an own login,
  which cloud placement turns off.
- Claude Code, OpenCode, Cursor and Pi: placeholders or in-memory stores.
- The runtime store: signed grant JWTs in `runtime_delivery.turn_grant` and
  `session_subagent.wake_grant`, which deferred work redeems after a wake; the
  control plane checks each against its row and expiry.
- `pty-history`: what the person's terminals printed.
- Raw secrets in the boot env (`WORKSPACE_RUNTIME_CONFIG_TOKEN`, the owner
  grant, the tasks capability) are process environment, not files, and are
  supplied again by every ensure.

None of these is a value the snapshot should lose: the placeholders are
rewritten at boot, the grants are the workspace's pending work, and the history
is the person's own. So the Worker deletes nothing before it snapshots; the
runtime's own checkpoint scrub (retiring transports) is the scrub step.

**A snapshot id restores only the sandbox that took it.** At the platform a
snapshot id is a bearer handle any object of the class can start from. The
object therefore restores only an id it recorded itself; any other id, and
every id after `DELETE /sandbox/:id` (which clears the object's storage), is
refused as `not_restorable` before anything starts. The object keeps its eight
newest records. The control plane's checkpoint answers carry no
`providerReference`, so the id does not leave the control plane either.

**The runtime a restore runs.** Agents run as root, so a snapshot can carry a
changed runtime, and the runtime receives the raw boot env at every launch.
Every start, and every launch after it, recomputes a digest of
`/opt/workspace-runtime` (every file but what `npm install` writes, and the
`/usr/local/bin/workspace-runtime` link) with `RUNTIME_DIGEST_SCRIPT` and
compares it with the build the container must carry: this Worker's own
(`RUNTIME_BUILD_ID`, `RUNTIME_VERSION`, `RUNTIME_DIGEST`, set at deploy from the
`build-info.json` of the bundle the image copies, computed by
`scripts/sandbox/runtime-digest.ts`) for a container from the image, the
recorded build for one from a snapshot. A mismatch destroys the container
unlaunched. The check runs with the container's own `find` and `sha256sum`, so
a root process that replaced those tools can still answer for a changed
runtime; it catches a changed bundle or entry point, not a compromised system.
A restore that must not trust the snapshot's executables at all would restore
only `/workspace` and HOME into the current image (`snapshotDirectory` and
`start({ image, directorySnapshots })`), giving up the system packages a
snapshot keeps.

A snapshot is bound to the image it was taken from, so a restored workspace
keeps the runtime build it was captured with until it starts fresh, as the
Modal and Vercel drivers' filesystem snapshots do. A restore whose recorded
runtime version is below the control plane's
`MINIMUM_RESTORABLE_WORKSPACE_RUNTIME_VERSION` (`sandbox-manager`
`runtime-version.ts`) is refused as `runtime_outdated`. Raise that minimum,
together with the runtime version, for a security-relevant runtime change
alone: every workspace saved below it must start fresh.

**Unusable checkpoints.** Each refusal is a 410
`{ ready: false, checkpointUnusable, error }`, where `checkpointUnusable` is
the cause the app's Start fresh control keys off and `error` the one line a
person reads:

| `checkpointUnusable` | When | Line |
| --- | --- | --- |
| `expired` | the platform no longer holds the snapshot (30 days after it was taken or last restored; there is no deletion or listing, so persistence is `retention: "provider-managed"`) | This workspace's saved files expired after 30 days unused; choose Start fresh. |
| `runtime_outdated` | the recorded runtime version is below the minimum | This workspace was saved by a runtime that has since had a security fix; choose Start fresh. |
| `runtime_modified` | the runtime files are not the build they must be | This workspace's saved runtime was changed inside the machine; choose Start fresh. |
| `not_restorable` | the id is not one this sandbox recorded, or the sandbox was destroyed | This workspace's saved files can't be restored here; choose Start fresh. |

Nothing falls back to the image: a silent fallback would hand the person an
empty workspace in place of theirs.

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

## Point the control plane at it

A hosted control plane has no provider account of its own. An organization
owner or admin adds this Worker as a Cloudflare sandbox key under Settings →
Models → Sandbox (or in the first run's "Where it runs" step): the Worker URL
(`https://sandbox.yourdomain.com`) and the `API_TOKEN` you set above. Every
cloud workspace of that organization then starts on this Worker.

A local machine instead reads its own Cloudflare key from `.env`:

```
CLOUDFLARE_API_TOKEN=<the token you set above>
CLOUDFLARE_SANDBOX_WORKER_URL=https://sandbox.yourdomain.com
```

## Native credential brokering

The API-token-gated `ensure-runtime` action accepts named egress registrations.
The Worker stores values in `EGRESS_SECRETS` KV and intercepts HTTPS to the
registered hosts with its `CredentialEgress` entrypoint. Container environment
variables contain only `claxedo-broker:<name>` placeholders. Clients use the original upstream URL.
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

`WorkspaceSandbox.setCredentialHosts` records the hosts the registrations name
and installs `ctx.container.interceptOutboundHttps(host, CredentialEgress)` for
exactly those: on a running container at once, on every container start, and
from the constructor of an object that restarts while its container runs. Every
other host keeps its direct route, so this Worker is never in the path of all
sandbox traffic. A container holds at most 64 hostname intercepts.

The platform mints the container's interception CA, at
`/etc/cloudflare/certs/cloudflare-containers-ca.crt`, with its first HTTPS
intercept, so every container also intercepts
`claxedo-credential-trust.invalid`, a reserved name no request resolves: a
sandbox that starts before it holds any credential host still has the CA, and a
host registered later is intercepted without restarting the container. Each
start then rebuilds `/etc/ssl/certs/ca-certificates.crt` from the image's own
bundle (kept beside it on first start) and the current CA, which curl and git
read; the runtime gets `NODE_EXTRA_CA_CERTS` and `REQUESTS_CA_BUNDLE`. Rebuilding
rather than appending matters after a restore, whose bundle carries its source
container's CA. A container that cannot trust the CA within 10 seconds is
destroyed and the ensure fails.

The platform offers no way to remove an interception, so a withdrawn host stays
routed through `CredentialEgress` until the container restarts; without a
registration it forwards requests without a placeholder unchanged and refuses
ones that carry a placeholder.

Node and Bun HTTPS clients passed the local probe. The CLIs baked into
`Dockerfile` (`claude`, `codex`, `pi`, `cursor-agent`, `amp`, `droid`) were not
probed against an intercepted connection, and an agent CLI that pins its own CA
bundle or ships its own TLS stack fails against one in a way no local test here
shows. Deployed acceptance is still required.

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
  object records each launch (its id, its launch time and whether it has
  answered ready) in Durable Object storage.
- A live runtime that has never answered ready is still preparing its
  repository and is kept, until it is 35 minutes old (the preparation deadline
  plus 5 minutes), when it is wedged and replaced.
- A runtime that exited before it was ever ready failed its boot. The answer is
  502 `{ ready: false, exited: true, error }` with the reason the runtime
  printed (a revoked token, a branch that does not exist), credentials blanked
  by `src/runtime-log.ts`, and the exited launch is cleared so the next ensure
  boots afresh. The driver reports it as a failed ensure, never as
  provisioning, and the connect answers `cloud_runtime_boot_failed` with the
  reason.
- A runtime that exited after it had served, or any runtime when the set of
  credential names changed, is replaced: SIGTERM to its process group, SIGKILL
  5 seconds later.

## Idle stop

A container stops once its object has been inactive for its inactivity
timeout, which loses everything since the last snapshot, while an open browser
stream keeps an object active indefinitely. The object therefore keeps a ready
container running with its own alarm and stops it only through a checkpoint:

- `ensure-runtime` records the lease's `workspaceId` and `epoch` labels, gives the
  runtime a health token as `WORKSPACE_RUNTIME_CONFIG_TOKEN` (kept across boots
  in Durable Object storage), and refuses with 503 when `CONTROL_PLANE_URL` (a
  `--var` the deploy sets) or the `IDLE_STOP_TOKEN` secret is missing, because
  nothing would ever stop that container.
- Every 30 seconds the object's alarm reads `idleSince` and `frozenSince` from
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
  `idleBefore`, snapshots it, and commits the checkpoint and the stopped lease
  in one update; a lease it already stopped is answered the same way, and a
  runtime a failed capture left frozen is thawed and refused. The object then
  destroys its own container. From the commit on, a send wakes a restore of
  this checkpoint.
- `stop` (the control plane's own stop) is fenced: a sandbox a newer lease
  generation already took over keeps running.

A failed idle check is logged as `workspace idle stop failed` and retried at the
next check. After 20 failures in a row the alarm is not set again, so the
10-minute inactivity timeout bounds what a dead runtime or a refused stop costs.

## Moving a deployment onto this Worker

The `v2` migration creates the `WorkspaceSandbox` container application and
deletes the `Sandbox` class with its Durable Object storage. Checkpoints taken
by the retired Worker name directory backups, and snapshots taken before the
object recorded them have no record, so their restores are refused as
`not_restorable` and the workspaces start fresh. No migration of them is
provided. After the new Worker serves, delete the retired container application
(`wrangler containers list`, then `wrangler containers delete <id>` for the
`Sandbox` one) and the `backups/` prefix of the `claxedo-sandbox-backups`
bucket, which still holds the registry.
