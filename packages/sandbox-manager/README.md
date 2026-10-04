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

The Boat driver assigns the mounted workspace root to the container's runtime
user before starting the runtime, so Git accepts the checkout's ownership.
It changes only the mount root's owner, preserving ownership within the person's
checkout. Docker's init process reaps orphaned harness children so exited Git
children cannot leave a retired Codex process group populated by zombies.
A container is reused only when its image, init setting, security-policy digest and boot command match;
if Boat restores the same image and boot command with an older configuration during creation,
the driver replaces that known old container once. A competing different image
or command remains a startup failure.
Replacing an outdated container preserves the bind-mounted workspace and state.
The [native harness policy](src/drivers/boat-security/README.md) keeps seccomp,
AppArmor where supported, and no-new-privileges while allowing Codex's nested
user namespaces. Only `SETFCAP` (UID-zero mapping) and `CHOWN` (workspace-root
ownership repair) remain from Docker's default capability set. Policy staging
or AppArmor load failure prevents startup; the driver never retries unconfined.
The Boat driver checks the runtime's health endpoint after starting its container.
If startup never becomes healthy, the failure includes a bounded container log
tail and container exit information, with staged environment and registry secret
values redacted before truncation. A diagnostic request failure preserves the
original health failure. This evidence identifies a failed runtime boot without
reporting the VM itself as ready.

Workspace deletion calls `destroy` with `retireLease` and the placement's home
region. This fences acquisition before provider cleanup, persists `retiring`
across cleanup failures, and records `retired` only after cleanup succeeds.
Neither state accepts provisioning results, heartbeats, or lease release.
An empty workspace receives the same fence without starting compute. Ordinary
`destroy` still permits fresh compute to be acquired for a surviving workspace.
The hosted route removes the workspace record only after retirement and runtime
credential withdrawal succeed. Boat deletion waits for the sandbox read to
report absence; an asynchronous deletion acknowledgement alone is insufficient.
Snapshot deletion failures propagate and leave cleanup retryable.

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
never logged, and never captured in a driver snapshot.

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
