# @claxedo/sandbox-manager

Open-sourceable sandbox placement and lease management for running `@claxedo/workspace-runtime` inside provider sandboxes.

The package owns the generic pieces:

- `SandboxManager`
- `SandboxLease`
- `SandboxTarget`
- `SandboxLeaseStore`
- `SandboxDriver`
- provider drivers for Cloudflare, Docker, fetch bridge, Modal, and Vercel

`drivers/local-brokering` is a macOS test driver. The e2e hosted stack's
sandbox fixture (`packages/harness/e2e/harness/hosted-sandbox-worker.ts`)
injects its instance programmatically; it has no product driver ID or product
configuration path. It runs the workspace runtime in a private directory under
`sandbox-exec`, permitting outbound TCP to its HTTP proxy and the specified
control-plane and relay loopback ports. The profile lets only `/bin/ps` execute
outside the sandbox because macOS refuses its setuid binary inside
`sandbox-exec`; the runtime stays under the network policy. The proxy accepts
HTTPS CONNECT only for a registered secret host with an explicit loopback test
upstream, terminates it with a private test CA, and applies the egress broker's
placeholder substitution before forwarding. The runtime trusts the CA
certificate, while its sandbox profile denies access to the CA and leaf private
keys. Other CONNECT destinations are refused. It is not a production sandbox
provider.

It deliberately does not own Claxedo product auth, billing, app storage schema, routes, or relay tokens. Applications provide those through adapters and call `createSandboxManager`.

## Install

```sh
npm install @claxedo/sandbox-manager
```

## Quickstart

A `SandboxManager` is three parts wired together: a `SandboxLeaseStore` (where
lease state lives), a `SandboxDriver` (how a sandbox is actually placed), and
`createSandboxManager` (the epoch/retry orchestration on top of both). This
example uses the in-memory lease store and the Docker driver, so it runs
end-to-end with only a local Docker daemon — no provider account needed:

```ts
import { createSandboxManager } from "@claxedo/sandbox-manager"
import { createMemoryLeaseStore } from "@claxedo/sandbox-manager/stores/memory"
import { createDockerSandboxDriver } from "@claxedo/sandbox-manager/drivers/docker"
import { SANDBOX_IMAGE } from "@claxedo/sandbox-manager/image"

const manager = createSandboxManager({
  leaseStore: createMemoryLeaseStore(),
  driver: createDockerSandboxDriver({ image: SANDBOX_IMAGE }),
})

const result = await manager.ensure("workspace-1", { homeRegion: "local" })

if (result.status === "ready") {
  console.log(`sandbox ready at ${result.url} (sandboxId: ${result.sandboxId})`)
} else if (result.status === "provisioning") {
  console.log(`still provisioning, retry in ${result.retryAfterMs}ms`)
} else {
  console.error(`unavailable: ${result.error}`)
}

// Later, on the same workspace: `ensure` re-resolves the existing lease
// instead of placing a new sandbox.
await manager.stop("workspace-1")
```

Swap `createDockerSandboxDriver` for `createModalSandboxDriver`,
`createVercelSandboxDriver`,
`createCloudflareSandboxDriver`, or `createBoatSandboxDriver` (all under
`@claxedo/sandbox-manager/drivers/*`) to place on a hosted provider instead —
see [`docs/architecture.md`](docs/architecture.md) for the full driver
comparison and each provider's required options. Swap `createMemoryLeaseStore`
for a persisted `SandboxLeaseStore` implementation (e.g. backed by SQLite) to
survive process restarts.

The Boat driver checks the runtime's health endpoint after starting its container.
If startup never becomes healthy, the failure includes a bounded container log
tail and container exit information, with staged environment and registry secret
values redacted before truncation. A diagnostic request failure preserves the
original health failure.

### Boat: what survives a stop, and what survives an image update

A Boat sandbox is a Linux VM whose disk Boat snapshots at every stop; the
runtime runs inside it as a Docker container over the canonical sandbox image's
trees. Boat's snapshot keeps a container's settings but not its writable layer,
and a resume creates every container again from its image
([what a snapshot saves](https://docs.boat.dev/snapshots/whats-saved#docker);
confirmed on a live sandbox 2026-10-14), so the driver keeps the machine's
state on the VM's disk and mounts it into the container:

| Path in the machine | Source on the VM disk | Stop and resume | Image update |
| --- | --- | --- | --- |
| `/workspace` | `claxedo-persistent/workspace` | kept | kept |
| `~/.claxedo`, `~/.workspace-runtime` (runtime stores, harness homes) | `claxedo-persistent/claxedo`, `claxedo-persistent/workspace-runtime` | kept | kept |
| `/root`, `/usr`, `/etc`, `/var`, `/opt`, `/home`, `/srv` | `claxedo-persistent/image-<image>/<tree>`, seeded from the image once per image | kept: dotfiles, `npm i -g`, `pip install`, `apt install`, anything written there | replaced by the new image's trees; the old image's are removed |
| the container's hostname | `--hostname <workspace id>` | kept | kept |
| everything else (`/tmp`, `/run`, processes) | none | gone, as on any reboot | gone |

The seed runs once per image, at the start that first names it: it pulls the
image, streams the trees out of a created container of it with `docker cp` and
unpacks them as root, leaving out `~/.cache` (which Boat's own snapshots leave
out too) and npm's cache. The persistent root is created as root too: Docker
made it as root on every sandbox that booted before the trees existed, and the
VM user cannot create inside it. The seed then saves beside the trees what the
container needs besides them: the image's env (`image.env`, given to the
container with `--env-file`) and a stub image (`stub.tar`, 67 kB) holding the
image's top level outside the trees (Debian's merged-`/usr` links and empty
directories), its working directory, and a `claxedo.image` label naming the
image. The seed starts no container of the image: Boat records the containers
it sees, and one the seed ran for a second to read the image's root was
recreated by a later restore as soon as the image was back, so the next seed
could not remove the image. The trees are marked complete once they all
landed, and a seed whose trees did not complete is redone from the pull; trees
marked complete are never seeded again, since they hold what was changed since,
so a seed missing only `stub.tar` or `image.env` (as one an earlier driver left)
pulls the image and builds those alone. Once the runtime container runs from the
stub, the start removes the image, any leftover container of it, and the archive
Boat keeps of it in `/var/lib/ascii-docker-images` (Boat loads that archive
again at every resume, 16–19 s for this image, and removing the image leaves it
behind). It waits for the start because the container being replaced may run
from the image itself, as an earlier driver's did.

Every start then runs the container from the stub, loading `stub.tar` when
Docker does not hold this image's stub, with every path above mounted. A wake
therefore pulls nothing: on Boat, 2026-10-15, a cold start took 55–96 s (the
pull and seed nearly all of it, as fast as ghcr served the image) and a wake
8–20 s from the resume call to a healthy runtime: `machine_ready` (the resume)
4–5 s, then `image_ready` (the stub and the container start) 1–3 s, or 7 s when
Boat's own create of the container raced the start's; the rest is the runtime
reading its files while Boat still downloads them. A wake that pulled took
57–77 s, and failed when ghcr reset the connection. An image update re-seeds:
the new image is pulled and seeded as above, its stub replaces the old one, and
the old image's trees are removed.

A start runs as two commands: the preparation (daemon, login, seed, stub)
changes nothing a running container serves from, so its failure leaves a
runtime of the previous image serving and the lease ready; the container start
that follows replaces that container, so its failure is a boot failure the
manager demotes. The container carries the stub's label, so a start finds a
container of its own image (one Boat created again after a stop that was not
this driver's, or the one the stop kept) and starts it rather than replacing
it. Boat's restore creates a resumed sandbox's containers again about 2 s after
Docker answers; when that create takes the runtime's name after the start looked
for it, Docker answers that the name is in use, and the start waits a second
(Docker holds the name from the start of Boat's create), removes it and creates
again, up to five creates. Docker named volumes were measured and rejected: Boat
saves them through a path of its own, and a stop with 3.7 GB of them had not
finished after ten minutes, while the same bytes under the work directory
archived in 27 s.

`stop` ends the runtime container with the 30 s grace Boat's own stop gives
and keeps it, so Boat's snapshot records it stopped: the restore creates it
again without starting it, and the start starts it after writing this boot's
env file (each wake's runtime read that wake's env, 2026-10-15). Removed, it
left Boat the set an earlier snapshot recorded, and Boat created and started the
runtime again from it on the previous boot's env file. `host <port> --public` is
sent once more when Boat answers that it could not stop the port's localhost
relay, which is Boat's own request to try again.

## Credentials & secrets

There are two distinct channels for getting values into a sandbox, chosen by
whether the code inside the sandbox is trusted with the raw value.

### `env` — readable, for trusted credentials

`SandboxManagerInput.env` (and the driver-level `env`) sets ordinary
environment variables, readable inside the sandbox via `process.env`. Reserve
this for credentials the agent is *meant* to hold — e.g. the user's own model
subscription/API key, which the agent needs to call the model directly.

### `secrets` — brokered, never readable inside the sandbox

`SandboxManagerInput.secrets: SandboxBrokeredSecret[]` is for credentials the
sandbox must be able to *use* on outbound requests but must never be able to
*read* or exfiltrate (connection tokens, deploy tokens). The raw value never
enters the sandbox: the provider injects it on egress to an allowlist of
`hosts` only.

```ts
await manager.ensure(workspaceId, {
  homeRegion: "us-east",
  secrets: [{
    name: "NOTION_TOKEN",
    value: notionToken,          // never enters the sandbox in plaintext
    hosts: ["api.notion.com"],   // substituted/injected only for these hosts
    header: "Authorization",     // required for Vercel
  }],
})
```

Per-provider mechanism (from each provider's official docs):

| Driver | `secretBrokering` | Mechanism |
| --- | --- | --- |
| Vercel | `native` | Firewall header-transform (`updateNetworkPolicy`): the value is spliced onto egress to the allowlisted hosts as `header`, so the sandbox makes an unauthenticated request ([docs](https://vercel.com/docs/sandbox/concepts/firewall)). `updateNetworkPolicy` replaces the whole policy, so the driver sends the **union** of the create-time allow-list and the brokered hosts — attaching a credential must not revoke egress the caller was already granted (a mid-run `npm install` would start failing), nor widen it to a brokered host the create-time policy never approved. |
| Cloudflare | `native` | The driver sends named registrations to the API-token-gated Worker. KV holds the values outside the container; native HTTPS outbound handlers replace named placeholders in registered headers. Each request reads KV, so there is no expiring container JWT. KV propagation delay still applies to rotation and withdrawal. |
| Modal | `none` | Modal [Secrets](https://modal.com/docs/guide/secrets) are an encrypted by-reference store, but exposed as **readable env vars** inside the sandbox — they cannot satisfy the never-readable contract. |
| Docker, fetch | `none` | Plaintext env only. |

**Fail-closed contract.** A brokered secret is never silently downgraded to
readable env. Only `native` keeps the value out of the sandbox and provisions
normally; a `none` driver makes the manager refuse to provision (`status:
"unavailable", error: "secret_brokering_unsupported"`) rather than expose or
drop the credential. Brokered secret values are also never written to labels,
never logged, and never captured in a driver snapshot. A `none` driver's
sandbox is handed no provider secret at all: on the hosted control plane its
owner's model accounts reach the harness as placeholders spent through the
plane's own egress broker (`@claxedo/server`'s
`credentials/hosted-egress-broker/`), which the driver never sees.

> Native brokering keeps the original upstream URL. Cloudflare accepts its
> named placeholder as the complete credential header, or with a Bearer prefix
> for Authorization API-key clients. Modal remains `none`: its encrypted store
> exposes credentials as readable environment variables inside the sandbox.

**Never readable is not never spendable.** The placeholder sits in every
process's environment, and the edge attaches the real value to any request to
an allowlisted host that carries it, with no condition on which session or
person sent it. Anything that runs in the sandbox can therefore spend what it
was delivered. Claxedo delivers a workspace's sandbox only its owner's chosen
provider accounts, never another person's, and treats the sandbox as shared
trust among everyone admitted to that workspace: their sessions and shells can
spend the owner's delivered accounts (owner ruling, 2026-09-28).

## Egress containment

`SandboxManagerInput.net` restricts what the sandbox can reach on the network.
It is a *separate* control from brokered secrets, with a **different** posture,
and the difference matters:

- **Brokered secrets fail closed.** A driver that cannot broker refuses to
  provision (`error: "secret_brokering_unsupported"`).
- **Egress does not.** Only `vercel` (names) can enforce an allowlist. Every
  other driver declares `metadata.egressControl: "none"`, and for those the
  manager **withholds** the policy and provisions anyway — the sandbox runs
  with unrestricted egress.

Withholding rather than passing is deliberate: `docker`, `modal` and `boat`
throw when handed a restricted policy, and `cloudflare` and the fetch
bridge accept one and silently ignore it. Withholding at the manager means the
throwing drivers never see a policy (their throws stay as their own last line of
defence) and the silently-dropping ones stop pretending.

The gap is never silent. `createSandboxManager` warns at composition, and again
each time a policy is withheld:

```text
[sandbox-manager] SANDBOX EGRESS IS UNRESTRICTED: driver "cloudflare" declares
egressControl: "none", so workspace ws_1 can reach ANY host on the internet …
```

Pass `onEgressUnenforced` to route that into telemetry instead of `console.warn`
— it receives a structured `SandboxEgressUnenforcedEvent`. Overriding the sink
replaces the console warning, so only do it if the replacement is as visible.

`driver.metadata.egressControl` is the machine-readable source of truth, and
`sandboxEgressDisposition(control, net)` is the pure predicate the manager uses,
so you can ask the same question before composing. One exception stays fail
closed: a hosts-only driver handed an address-only policy is refused
(`sandbox_egress_policy_unenforceable`) rather than degraded, because that
driver *does* enforce egress — it just cannot express that encoding.

> SDK conformance: the Vercel network-policy transform shapes follow the
> provider's official docs and are validated structurally
> against the pinned SDK types; like all provider calls in this package they
> are exercised against mocks in unit tests, with live-SDK integration
> verified at deploy time.
