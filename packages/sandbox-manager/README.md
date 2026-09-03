# @claxedo/sandbox-manager

Open-sourceable sandbox placement and lease management for running `@claxedo/workspace-runtime` inside provider sandboxes.

The package owns the generic pieces:

- `SandboxManager`
- `SandboxLease`
- `SandboxTarget`
- `SandboxLeaseStore`
- `SandboxDriver`
- provider drivers for Cloudflare, Daytona, Docker, fetch bridge, Modal, and Vercel

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

Swap `createDockerSandboxDriver` for `createDaytonaSandboxDriver`,
`createModalSandboxDriver`, `createVercelSandboxDriver`,
`createCloudflareSandboxDriver`, or `createBoxSandboxDriver` (all under
`@claxedo/sandbox-manager/drivers/*`) to place on a hosted provider instead —
see [`docs/architecture.md`](docs/architecture.md) for the full driver
comparison and each provider's required options. Swap `createMemoryLeaseStore`
for a persisted `SandboxLeaseStore` implementation (e.g. backed by SQLite) to
survive process restarts.

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
    header: "Authorization",     // required for Vercel; optional for Daytona
  }],
})
```

Per-provider mechanism (from each provider's official docs):

| Driver | `secretBrokering` | Mechanism |
| --- | --- | --- |
| Daytona | `native` | `daytona.secret.create({name, value, hosts})`; the sandbox env holds an opaque `dtn_secret_…` placeholder and an egress proxy substitutes the real value only for allowlisted hosts ([docs](https://www.daytona.io/docs/en/secrets/)). |
| Vercel | `native` | Firewall header-transform (`updateNetworkPolicy`): the value is spliced onto egress to the allowlisted hosts as `header`, so the sandbox makes an unauthenticated request ([docs](https://vercel.com/docs/sandbox/concepts/firewall)). `updateNetworkPolicy` replaces the whole policy, so the driver sends the **union** of the create-time allow-list and the brokered hosts — attaching a credential must not revoke egress the caller was already granted (a mid-run `npm install` would start failing), nor widen it to a brokered host the create-time policy never approved. |
| Cloudflare | `proxy` | Implemented via the official [Worker-proxy pattern](https://developers.cloudflare.com/sandbox/guides/proxy-requests/): the driver sends the value to the sandbox Worker (API-token-gated, never into the container); the Worker stores it in KV, mints a short-lived per-sandbox JWT, and sets `CLAXEDO_EGRESS_PROXY_URL`/`CLAXEDO_EGRESS_TOKEN`/`CLAXEDO_EGRESS_HOSTS` in the container. The sandbox routes brokered-host egress through the Worker, which validates the JWT and injects the credential as `header` — the raw value never enters the sandbox. The reusable core is `@claxedo/sandbox-manager/drivers/cloudflare-egress` (mint/verify + `handleEgressRequest`). |
| Modal | `none` | Modal [Secrets](https://modal.com/docs/guide/secrets) are an encrypted by-reference store, but exposed as **readable env vars** inside the sandbox — they cannot satisfy the never-readable contract. |
| Docker, fetch | `none` | Plaintext env only. |

**Fail-closed contract.** A brokered secret is never silently downgraded to
readable env. `native` (transparent egress) and `proxy` (Cloudflare Worker
egress proxy) both keep the value out of the sandbox and provision normally;
only a `none` driver makes the manager refuse to provision (`status:
"unavailable", error: "secret_brokering_unsupported"`) rather than expose or
drop the credential. Brokered secret values are also never written to labels,
never logged, and never captured in a driver snapshot.

> Consumption note: `native` brokering is transparent (existing code reaches
> the real host and the platform injects). Cloudflare `proxy` is NOT
> transparent — the sandbox must route brokered-host requests through
> `CLAXEDO_EGRESS_PROXY_URL` (with the `CLAXEDO_EGRESS_TOKEN` bearer and the
> `x-claxedo-egress-target` header). Modal stays `none`; its secret store
> improves storage hygiene for *readable* credentials but does not hide them
> from the sandbox.

## Egress containment

`SandboxManagerInput.net` restricts what the sandbox can reach on the network.
It is a *separate* control from brokered secrets, with a **different** posture,
and the difference matters:

- **Brokered secrets fail closed.** A driver that cannot broker refuses to
  provision (`error: "secret_brokering_unsupported"`).
- **Egress does not.** Only `daytona` (names + CIDRs) and `vercel` (names) can
  enforce an allowlist. Every other driver declares
  `metadata.egressControl: "none"`, and for those the manager **withholds** the
  policy and provisions anyway — the sandbox runs with unrestricted egress.

Withholding rather than passing is deliberate: `exe`, `docker`, `modal` and
`box` throw when handed a restricted policy, and `cloudflare` and the fetch
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

**Reuse and resume reapply the policy.** A restricted policy only reaches a
provider as *creation* parameters, so a sandbox handed back rather than created
— reuse in `ensureHost`, resume in `resumeHost` — would otherwise run on the
policy in force when it was first created, possibly a wider one from an earlier
caller. Daytona's allow-list is mutable post-create
(`Sandbox.updateNetworkSettings`), so `daytona` reapplies the requested policy
on both paths. A client too old to expose that call makes the driver **refuse
the reuse**: a policy reported as applied but not in force is worse than no
sandbox. Requesting no containment leaves the existing policy alone rather than
clearing it — "not requested" is not "please unrestrict".

`driver.metadata.egressControl` is the machine-readable source of truth, and
`sandboxEgressDisposition(control, net)` is the pure predicate the manager uses,
so you can ask the same question before composing. One exception stays fail
closed: a hosts-only driver handed an address-only policy is refused
(`sandbox_egress_policy_unenforceable`) rather than degraded, because that
driver *does* enforce egress — it just cannot express that encoding.

> SDK conformance: the Daytona secret API and Vercel network-policy transform
> shapes follow the providers' official docs and are validated structurally
> against the pinned SDK types; like all provider calls in this package they
> are exercised against mocks in unit tests, with live-SDK integration
> verified at deploy time.
