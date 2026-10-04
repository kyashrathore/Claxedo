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
  `suspend`, `stop`, `destroy`, `snapshot`, `deleteSnapshot`. A driver whose
  snapshots outlive their sandbox implements `deleteSnapshot`: a lease
  references one checkpoint, so the manager deletes the snapshot a newer
  commit replaced, the one a fenced commit never referenced, and the last one
  when the workspace is destroyed. `ensureHost`/`resumeHost` return
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
(`src/lease-types.ts`), the DB-shaped row (`snake_case`) a lease store
persists.

## Epoch and retry model

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

## Start timing

Each lease epoch starts once. A lease that is not serving yet records its start
in `lease.start` (`SandboxStartProgress`), so a start that a driver answers with
"provisioning" keeps its timing across the polls of later requests. A serving
lease that is re-ensured is not a start, and the next `acquire` begins a new
epoch with no start recorded.

`provision()` ends `lease_decision` when it begins a start, `provider_ready`
when the driver calls `onResource`, `image_ready` when a driver that can tell
calls `onImageReady`, and `runtime_ready` when the driver returns a serving
target. Each phase is timed from the one before. One provision call writes what
it observed once, after the driver work, and emits each phase through the
`onStartPhase` option. Phases from outside the manager join the same epoch:
`recordStartPhases` takes durations the runtime measured inside the sandbox, and
`markStartPhase` ends a phase now, refusing evidence older than the start. A
phase reaches the sink at most once per epoch. The vocabulary and the
`createSandboxPhaseTimer` a single process times its own phases with are in
`@claxedo/sandbox-contract`.

## Driver comparison

All eight metadata fields come straight from each driver's `metadata` object
(`src/driver-catalog.ts` mirrors the same values per `SandboxDriverID`, plus
credential fields for each provider).

| Driver | Runs in | `hostStopBehavior` | `hostResumeBehavior` | `targetAccess` | `secretBrokering` |
| --- | --- | --- | --- | --- | --- |
| [Boat](../src/drivers/boat.ts) | `worker`, `node` | `suspends-host` | `same-host` | `relay` | `none` |
| [Cloudflare](../src/drivers/cloudflare.ts) | `worker` | `terminates-host` | `same-host` | `relay` | `native` |
| [Docker](../src/drivers/docker.ts) | `local` | `terminates-host` | `same-host` | `loopback` | `none` |
| [Fetch-bridge](../src/drivers/fetch-bridge.ts) | `worker`, `node` | `suspends-host` | `same-host` | `relay` | `none` |
| [Modal](../src/drivers/modal.ts) | `node` | `terminates-host` | `replacement-host` | `relay` | `none` |
| [Vercel](../src/drivers/vercel.ts) | `node` | `terminates-host` | `replacement-host` | `relay` | `native` |

Column meanings:

- **Runs in** — where the driver's own code (not the sandbox) can execute.
- **`hostStopBehavior`** — what `SandboxManager.stop()` actually does to the
  driver-owned resource: `"suspends-host"` (pauses, resumable),
  `"terminates-host"` (destroys it), or `"not-supported"` (no stop API).
  `stop(workspaceId, { runtime })` first captures the workspace: the capture
  commits the checkpoint and the stopped lease in one update, the runtime stays
  frozen, and only then does the host stop, for that lease generation only.
  With `hostStopsItself` the caller is the host and stops itself; the answer's
  `checkpoint` names the snapshot the stopped lease references, for it to keep.
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
`metadata.secretBrokering !== "native"` — including an absent or unrecognized
value — `ensure()` returns
`{ status: "unavailable", error: "secret_brokering_unsupported" }` instead of
ever handing the value to a driver that can't keep it out of the sandbox.

| `secretBrokering` | Drivers | Mechanism |
| --- | --- | --- |
| `native` | Vercel | The provider brokers the value on egress to the allowlisted `hosts` with no extra infrastructure: Vercel firewall header-transform on `updateNetworkPolicy`. The driver injects it during `ensureHost`, transparently — no sandbox-side code changes needed. |
| `native` | Cloudflare | API-token-gated named registrations live in Worker KV. Native HTTPS outbound handlers select a credential by host and placeholder, read its current value per request, and inject its header. The container retains the original URL and a stable placeholder. KV propagation delays apply; unrelated destinations remain unrestricted. |
| `none` | Modal, Docker, fetch-bridge, Boat | No way to keep the value out of sandbox processes. Modal has an encrypted secret *store*, but Modal exposes secrets as readable env vars inside the sandbox, so it can't satisfy the never-readable contract either — hence `"none"` even though it has more secret-hygiene machinery than Docker/Boat/fetch-bridge, which have no secret story at all beyond plaintext `env`. |

See the [README](../README.md#credentials--secrets) for the `env` vs.
`secrets` distinction and a worked `secrets` example.
