# Architecture

This document covers the contract in `src/index.ts`, the epoch/retry model
that governs lease lifecycle, and how the bundled provider drivers differ.

## The contract: `SandboxManager` / `SandboxLease` / `SandboxDriver`

`createSandboxManager({ leaseStore, driver, ...options })` composes two
seams supplied by the caller:

- **`SandboxLeaseStore`** — persistence for `SandboxLease` rows, keyed by
  `workspaceId`. `acquire` / `update` / `recordFailure` / `release` / `get` /
  `list`. The package ships one implementation,
  `createMemoryLeaseStore` (`@claxedo/sandbox-manager/stores/memory`), for
  tests and local use; applications supply their own (SQLite, …) for
  anything that needs to survive a process restart.
- **`SandboxDriver`** — how a sandbox actually gets placed. `id`,
  `metadata` (see the [driver comparison](#driver-comparison) below),
  `ensureHost` (required), and optional `resumeHost`, `list`, `touch`,
  `suspend`, `stop`, `destroy`, `snapshot`. `ensureHost`/`resumeHost` return
  either a `SandboxTarget` (`sandboxId`, `url`, `hostId`, …) or
  `{ provisioning: true, retryAfterMs }` for drivers whose sandboxes take a
  poll loop to come up.

`createSandboxManager` returns a `SandboxManager` with `ensure`, `register`,
`heartbeat`, `target`, `touch`, `snapshot`, `stop`, `destroy`, `release`,
`garbageCollect`, and `list`. `ensure(workspaceId, input)` is the entry point
applications call on every request that needs a live sandbox: it reads the
current `SandboxLease`, decides whether to reuse it, resume it, or acquire a
new epoch, invokes the driver, and returns a `SandboxEnsureResult` of
`"ready"` (with the resolved `SandboxTarget`), `"provisioning"`, or
`"unavailable"`.

A `SandboxLease` (`src/index.ts`) is the manager's own persisted row shape:
`workspaceId`, `homeRegion`, `driver`, `epoch`, `status`
(`"acquiring" | "ready" | "unavailable" | "stopped" | "destroyed"`),
`retryCount`, timestamps, and the resolved `sandboxId` / `url` / `hostId` /
`driverResourceId` once ready. This is distinct from `SandboxLeaseRow`
(`src/lease-types.ts`), a richer DB-shaped row (`snake_case`, extra states
like `"unhealthy"` / `"backoff"` / `"stopping"`, acceleration fields) used by
the standalone `lease-policy` decision functions described next — an
application's own scheduler/cron can use `lease-policy` against its own
row storage independently of (or alongside) `SandboxManager`.

## Lease-policy: epoch and retry model

Two retry/epoch mechanisms live in this package, at different layers.

### Inside `SandboxManager`: epoch-guarded optimistic concurrency

Every `SandboxLease` carries an `epoch`, bumped by `leaseStore.acquire` each
time a fresh placement is started. All mutations (`update`, `recordFailure`)
take an `expectedEpoch` and are no-ops if the stored epoch has since moved
on — this is what makes concurrent `ensure()` calls for the same
`workspaceId` safe: a stale in-flight provision can't clobber a newer one.
`applySandboxLeasePatch` (exported from `src/index.ts`) is the single merge
function every `SandboxLeaseStore` implementation should use: `undefined`
fields leave the current value untouched, `null` clears it.

`createSandboxManager`'s retry/backoff options:

| Option | Default | Effect |
| --- | --- | --- |
| `staleAfterMs` | `60_000` | How long an `"acquiring"` lease is treated as in-flight before another caller can bump the epoch and retry fresh. |
| `retryAfterMs` | `2_000` | Fallback `retryAfterMs` surfaced to callers when a failure doesn't produce its own `nextRetryAt`. |
| `retryDelayMs(retryCount)` | `min(60_000, 1_000 * 2^(retryCount-1))` | Exponential backoff applied after each failed provision attempt. |
| `maxRetryCount` | `Infinity` | Once `retryCount` reaches this, the lease is capped: further `ensure()` calls fail immediately (or wait out `retryCapCooldownMs`) instead of retrying the driver. |
| `retryCapCooldownMs` | `600_000` | Cooldown applied once a lease hits `maxRetryCount`, after which one more attempt is allowed. |
| `appLabel` | `"claxedo"` | Written to every provisioned sandbox's `app` label; `garbageCollect()` only ever destroys sandboxes carrying this label. |

`provision()` (internal) is the shared path for a fresh acquire, a resume of
a `"ready"` lease (sandboxes can be auto-stopped by the provider, so
`ensure()` always re-touches the driver even for a lease already marked
ready), and continuing an in-flight `"acquiring"` lease past its retry time.
A resume failure on an already-`"ready"` lease does **not** demote it —
the existing target keeps resolving for routing while the error is recorded
for observability only; only a cold acquire/`"acquiring"` failure bumps
`retryCount` and schedules backoff.

### Standalone: `src/lease-policy.ts` row-status decision functions

`decideSandboxStart`, `decideSandboxHealthFailure`, `decideSandboxIdle`, and
`nextSandboxRetryAt` are pure functions over a `SandboxLeaseRow` (the
richer row shape above) and a driver's `SandboxDriverPlacement`
capabilities (`sandboxDriverPlacement(driverId)`, from a table keyed by
`SandboxDriverID`). They decide, given a row's status: resume the same
resource, restore a filesystem snapshot, start from a prepared image, cold
start, wait out a backoff timer, stop an idle sandbox, or mark the lease
permanently failed after `config.maxRetries`. `DEFAULT_WORKSPACE_HOST_DECISION_CONFIG`
is `{ maxRetries: 8, idleMs: 10 * 60_000, backoffMaxMs: 30_000, healthTimeoutMs: 60_000 }`.
These are building blocks for a scheduler that owns its own row storage and
health/idle polling loop; `SandboxManager` does not call them itself.

## Driver comparison

All eight metadata fields come straight from each driver's `metadata` object
(`src/driver-catalog.ts` mirrors the same values per `SandboxDriverID`, plus
credential fields for each provider).

| Driver | Runs in | `hostStopBehavior` | `hostResumeBehavior` | `targetAccess` | `secretBrokering` |
| --- | --- | --- | --- | --- | --- |
| [Box](../src/drivers/box.ts) | `node` | `suspends-host` | `same-host` | `relay` | `none` |
| [Cloudflare](../src/drivers/cloudflare.ts) | `worker` | `not-supported` | `same-host` | `relay` | `proxy` |
| [Cloudflare-egress](../src/drivers/cloudflare-egress.ts) | `worker` (+`node` to mint) | n/a — not a placement driver | n/a | n/a | implements Cloudflare's `proxy` brokering |
| [Daytona](../src/drivers/daytona.ts) | `worker`, `node` | `suspends-host` | `same-host` | `relay` | `native` |
| [Docker](../src/drivers/docker.ts) | `local` | `terminates-host` | `same-host` | `loopback` | `none` |
| [Fetch-bridge](../src/drivers/fetch-bridge.ts) | `worker`, `node` | `suspends-host` | `same-host` | `relay` | `none` |
| [Modal](../src/drivers/modal.ts) | `node` | `terminates-host` | `replacement-host` | `relay` | `none` |
| [Vercel](../src/drivers/vercel.ts) | `node` | `terminates-host` | `replacement-host` | `relay` | `native` |

Column meanings:

- **Runs in** — where the driver's own code (not the sandbox) can execute.
- **`hostStopBehavior`** — what `SandboxManager.stop()` actually does to the
  driver-owned resource: `"suspends-host"` (pauses, resumable),
  `"terminates-host"` (destroys it), or `"not-supported"` (no stop API —
  Cloudflare Durable Object sandboxes stay up).
- **`hostResumeBehavior`** — whether a stopped/stale lease can resume the
  *same* driver-owned resource (`"same-host"`) or must always get a
  replacement (`"replacement-host"`, e.g. Modal/Vercel sandboxes are
  ephemeral compute, not resumable containers).
- **`targetAccess`** — how the control plane reaches the resolved
  `SandboxTarget.url`: `"relay"` (all hosted providers) or `"loopback"`
  (Docker, since it runs on the same machine as the manager).
- **`secretBrokering`** — see below.

### Secret brokering

`SandboxManagerInput.secrets: SandboxBrokeredSecret[]` (`{ name, value,
hosts, header? }`) is for credentials the sandbox must be able to *use* on
outbound requests but must never be able to *read*. `provision()` in
`src/index.ts` fails closed: if `secrets` is non-empty and the driver's
`metadata.secretBrokering === "none"`, `ensure()` returns
`{ status: "unavailable", error: "secret_brokering_unsupported" }` instead of
ever handing the value to a driver that can't keep it out of the sandbox.

| `secretBrokering` | Drivers | Mechanism |
| --- | --- | --- |
| `native` | Daytona, Vercel | The provider brokers the value on egress to the allowlisted `hosts` with no extra infrastructure: Daytona secret placeholders + built-in egress proxy; Vercel firewall header-transform on `updateNetworkPolicy`. The driver injects it during `ensureHost`, transparently — no sandbox-side code changes needed. |
| `proxy` | Cloudflare | Implemented by `src/drivers/cloudflare-egress.ts` via the official [Worker-proxy pattern](https://developers.cloudflare.com/sandbox/guides/proxy-requests/): `mintEgressToken` signs a short-lived HS256 JWT (`sub`, `hosts`, `exp`) bound to the sandbox and its allowlisted hosts, exposed to the container as `CLAXEDO_EGRESS_PROXY_URL`/`CLAXEDO_EGRESS_TOKEN`/`CLAXEDO_EGRESS_HOSTS`. `handleEgressRequest` runs inside the Worker: it calls `verifyEgressToken`, checks the requested host (from the `x-claxedo-egress-target` header) against the token's `hosts`, resolves the real credential via the caller-supplied `EgressSecretResolver`, injects it as a header, forwards, and strips the credential back out of the response. The raw value never enters the sandbox — the container only ever holds the JWT. Not automatic like `native`; the sandbox has to route brokered-host requests through the proxy itself. |
| `none` | Modal, Docker, fetch-bridge, Box | No way to keep the value out of sandbox processes. Modal has an encrypted secret *store*, but Modal exposes secrets as readable env vars inside the sandbox, so it can't satisfy the never-readable contract either — hence `"none"` even though it has more secret-hygiene machinery than Docker/Box/fetch-bridge, which have no secret story at all beyond plaintext `env`. |

See the [README](../README.md#credentials--secrets) for the `env` vs.
`secrets` distinction and a worked `secrets` example.
