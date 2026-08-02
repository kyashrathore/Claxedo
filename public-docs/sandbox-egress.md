# Sandbox Egress Containment

Status: current
Last updated: 2026-07-28

A Claxedo sandbox runs **agent-authored code** over a checkout of someone's
private repository. Whether that code can reach the open internet is decided by
the sandbox driver you compose, and **most drivers cannot decide it at all**.

The posture is: **enforce where we can, document where we can't.** This page is
the "document where we can't" half. It is the authoritative list of which
deployments run sandboxes with unrestricted egress.

> The table below is pinned by a test
> (`packages/sandbox-manager/src/egress-policy.test.ts`) against the
> `egressControl` field each driver declares in its `SandboxDriverMetadata`.
> If a driver's capability changes and this table is not updated, that test
> fails. Do not edit the table to make a test pass — fix whichever one is wrong.

## Driver capability matrix

`egressControl` is the driver's own declaration of how it can enforce a
restricted `SandboxNetworkPolicy`. A policy states the same allowance in up to
two encodings — `hosts` (names) and `cidrs` (addresses) — and a driver contains
egress if it enforces at least one encoding the policy carries and blocks
everything else.

| Driver | `egressControl` | Sandbox egress | Mechanism, or why not |
| --- | --- | --- | --- |
| `daytona` | `hosts-and-cidrs` | **Enforced** | `domainAllowList` (names) and `networkAllowList` (CIDRs) over a `networkBlockAll` floor. The only driver that filters by name *and* by address. |
| `vercel` | `hosts` | **Enforced** | Sandbox firewall takes a hostname allow list, or `deny-all`. No CIDR support. |
| `cloudflare` | `none` | **UNRESTRICTED** | The Cloudflare Sandbox Worker exposes no egress filter. Its credential broker (`drivers/cloudflare-egress.ts`) is an opt-in proxy the sandbox chooses to route brokered-credential requests through — it is not a network boundary and does not stop the sandbox reaching anything else directly. |
| `exe` | `none` | **UNRESTRICTED** | exe.dev exposes no egress allowlist. The driver throws if handed one. |
| `modal` | `none` | **UNRESTRICTED** | Modal can cut the network entirely (`blockNetwork`) but cannot express an allowlist. A total blackout is not containment for a workspace that has to clone a repo and reach a model provider, so it does not qualify. |
| `box` | `none` | **UNRESTRICTED** | No egress allowlist. The driver throws if handed one. |
| `docker` | `none` | **UNRESTRICTED** | Local Docker placement, no per-sandbox network policy wired. The driver throws if handed one. |
| `fetch` | `none` | **UNRESTRICTED** | The fetch bridge forwards a provisioning request to an external HTTP driver; the wire format carries no egress policy, so whatever contains that sandbox (if anything) is outside Claxedo's knowledge. |

## Which production configurations are unrestricted

**The hosted control-plane Worker only composes four of these drivers — `exe`,
`cloudflare`, `daytona`, and `fetch` — and only `daytona` enforces egress.**

The Worker selects a driver from `CLAXEDO_SANDBOX_DRIVER`, or auto-selects from
whichever credentials are present, in this order
(`control-plane/hosted-services.ts`):

| Selected when | Driver | Egress |
| --- | --- | --- |
| `CLOUDFLARE_SANDBOX_WORKER_URL` + (`CLOUDFLARE_SANDBOX_API_TOKEN` or `CLOUDFLARE_API_TOKEN`) | `cloudflare` | **UNRESTRICTED** |
| else `EXE_DEV_API_TOKEN` | `exe` | **UNRESTRICTED** |
| else `DAYTONA_API_KEY` + `CLAXEDO_DAYTONA_SNAPSHOT` | `daytona` | Enforced |
| `CLAXEDO_SANDBOX_DRIVER=fetch` + `CLAXEDO_SANDBOX_DRIVER_URL` (explicit only) | `fetch` | **UNRESTRICTED** |

Cloudflare is checked **first**, so a deployment that has Cloudflare
credentials configured — which is the common case, since the same account hosts
the Worker — runs every hosted sandbox with unrestricted egress unless
`CLAXEDO_SANDBOX_DRIVER=daytona` is set explicitly.

Self-hosted and local deployments (`workspace-supervisor-sandbox.ts`) can
additionally compose `vercel`, `modal`, `box`, and `docker`. They pass a policy
only when the workspace has network-policy rows configured, and never for
`docker`; with no rows configured the sandbox is allow-all by request, which is
the intended single-tenant posture.

## What "unrestricted" costs you

The interesting attack on a hosted sandbox is not "the agent downloads a
package". It is **"the agent POSTs the repository somewhere"**.

With `egressControl: "none"`, code running inside the sandbox can open a
connection to any host on the internet. That includes every general-purpose
bucket and CDN an attacker can create in their own account — `*.workers.dev`,
`r2.cloudflarestorage.com`, `storage.googleapis.com`,
`*.blob.core.windows.net`, `*.amazonaws.com`, paste sites, and so on. So:

- **The private checkout can leave.** A prompt-injected agent, a malicious
  dependency in the repo's own `postinstall`, or an untrusted MCP server can
  exfiltrate the working tree with a single `fetch`.
- **Readable credentials can leave** with it. `env` values are plaintext inside
  the sandbox by design (that is what `secrets`/brokering exists to avoid);
  with no egress control, anything readable is also sendable.
- **There is no network-side record.** Nothing is denied, so nothing is logged
  as denied. Detection has to come from somewhere else entirely.

Brokered secrets (`SandboxBrokeredSecret`) are a *separate* control and are
still fail-closed: a driver that cannot broker refuses to provision rather than
downgrade a secret to readable env. Do not read "egress is unrestricted" as
"brokered secrets leak" — but do note that on a `secretBrokering: "none"` +
`egressControl: "none"` driver you have neither control.

## Getting enforcement

**Hosted:** set `CLAXEDO_SANDBOX_DRIVER=daytona` and provide `DAYTONA_API_KEY`
plus `CLAXEDO_DAYTONA_SNAPSHOT`. That is the only hosted configuration where the
allowlist below actually binds. Setting the variable is required even if Daytona
credentials are present, because Cloudflare wins the auto-selection.

**Self-hosted:** compose `daytona` or `vercel`. Vercel enforces names only, so a
policy expressed purely as CIDRs will be refused (see "Failure modes").

Verify from the logs: an enforcing deployment prints **no**
`SANDBOX EGRESS IS UNRESTRICTED` warning at boot. If you see one, the driver you
composed is not enforcing anything, regardless of what any policy config says.

## What is allowed when egress IS enforced

The hosted allowlist is built per request by `hostedSandboxNetworkPolicy`
(`packages/sandbox-manager/src/hosted-network-policy.ts`) from three sources:

1. **Per request** — the relay and control-plane origin the runtime reports
   back to, and the single git host this workspace clones from (not a forge
   allowlist).
2. **Model providers** — `api.anthropic.com`, `api.openai.com`,
   `generativelanguage.googleapis.com`, `openrouter.ai`, plus `models.dev` and
   `opencode.ai` for the catalog/config fetched at runner startup.
3. **Package registries** — npm, nodejs.org, PyPI, crates.io, and the Go module
   proxy hostnames.

Deliberately **excluded**, even though the credential layer's default list
contains them: general-purpose object storage and CDN wildcards
(`*.workers.dev`, `r2.cloudflarestorage.com`, `storage.googleapis.com`,
`*.blob.core.windows.net`, `*.amazonaws.com`). Each is a bucket an attacker can
create in their own account, so allowlisting one hands back exactly the
exfiltration channel the policy exists to close.

A deployment that genuinely needs one adds it as an explicit and auditable
decision, by setting `CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS` on the hosted control
plane to a comma-separated list of hostnames:

```sh
CLAXEDO_SANDBOX_EGRESS_EXTRA_HOSTS=npm.acme.internal,models.acme.internal
```

That is the operator-facing name for the route option `sandboxEgressExtraHosts`
(`HostedWorkspaceRouteOptions`), which a custom composition can also set
directly. Hostnames only; the hosted policy carries no CIDRs.

## Failure modes and what the manager does

| Situation | What happens |
| --- | --- |
| Capable driver, restricted policy | Policy is passed verbatim and enforced. |
| No policy, or `mode: "allow-all"` | Nothing to enforce. Provisioning proceeds silently — this is the intended single-tenant/self-host path. |
| `egressControl: "none"`, restricted policy | **Policy is withheld and provisioning proceeds.** The driver is handed no `net` at all, so the drivers that throw on one never see it and the drivers that would silently drop it are not pretending. A warning is emitted (below). The sandbox has unrestricted egress. |
| Hosts-only driver (`vercel`), address-only policy | **Refused** — `status: "unavailable", error: "sandbox_egress_policy_unenforceable"`. This driver *does* enforce egress, it just cannot express this encoding, so degrading it to unrestricted would weaken a working control. Express the policy with hostnames. The hosted policy builder only ever emits hostnames, so no hosted path reaches this. |

### The warning

Emitted twice, because a per-create line is easy to miss in request logs:

- **at composition**, once per driver per process, from `createSandboxManager`;
- **per create**, naming the workspace and the allowlist that did not apply.

```text
[sandbox-manager] SANDBOX EGRESS IS UNRESTRICTED: driver "cloudflare" declares
egressControl: "none", so workspace ws_abc123 can reach ANY host on the
internet, including attacker-controlled buckets — agent-authored code inside
the sandbox has an unmonitored exfiltration path. The requested allowlist
(17 host(s), 0 cidr(s)) was withheld, not applied. Select a driver that can
enforce egress (daytona, vercel) to close it. See public-docs/sandbox-egress.md.
```

It goes to `console.warn` by default. To send it somewhere else, pass
`onEgressUnenforced` to `createSandboxManager` — it receives a structured
`SandboxEgressUnenforcedEvent` (`phase`, `driver`, `egressControl`,
`workspaceId`, `requested`, `message`). Overriding the sink replaces the console
warning, so only do it if the replacement is at least as visible.

**The hosted control plane already overrides it.** `composeHostedControlPlane`
keeps the console line *and* emits an ops-plane telemetry event, because a
`console.warn` inside a Worker isolate only reaches whoever happens to be
tailing logs at that moment — which is nobody on the day someone switches the
driver:

| | |
| --- | --- |
| Event | `sandbox.egress_unenforced` |
| `distinct_id` | `system` (ops plane — no org or user identifiers) |
| Properties | `phase`, `reason`, `driver`, `egress_control`, and on a create: `workspace_id`, `withheld_host_count`, `withheld_cidr_count` |

The allowlist itself is never sent — deployment topology is not ops-plane data,
so the withheld hosts ride as counts. Alert on `phase = "composition"` to learn
that a deployment is uncontained *before* its first workspace exists.

## Related

- [Deploy Runbook](./deploy-runbook.md) — deploy order and required bindings.
- [Hosted Control Plane Worker](./hosted-control-plane-worker.md) —
  `CLAXEDO_SANDBOX_DRIVER` and per-driver credentials.
- [Production Environment Runbook](./production-environment-runbook.md) —
  what fails closed at boot and what does not.
- `packages/sandbox-manager/README.md` — brokered secrets, the *other*
  sandbox credential control.
