# @claxedo/sandbox-manager

Open-sourceable sandbox placement and lease management for running `@claxedo/workspace-runtime` inside provider sandboxes.

The package owns the generic pieces:

- `SandboxManager`
- `SandboxLease`
- `SandboxTarget`
- `SandboxLeaseStore`
- `SandboxDriver`
- provider drivers for Cloudflare, Daytona, Docker, fetch bridge, Modal, and Vercel

It deliberately does not own Claxedo product auth, billing, Convex schema, SQLite app storage, routes, or relay tokens. Applications provide those through adapters and call `createSandboxManager`.

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
| Vercel | `native` | Firewall header-transform (`updateNetworkPolicy`): the value is spliced onto egress to the allowlisted hosts as `header`; the sandbox makes an unauthenticated request, egress restricted to brokered hosts ([docs](https://vercel.com/docs/sandbox/concepts/firewall)). |
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

> SDK conformance: the Daytona secret API and Vercel network-policy transform
> shapes follow the providers' official docs and are validated structurally
> against the pinned SDK types; like all provider calls in this package they
> are exercised against mocks in unit tests, with live-SDK integration
> verified at deploy time.
