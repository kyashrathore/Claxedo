---
title: "feat: D1 sandbox lease store so Better Auth + D1 deployments run cloud VMs"
date: 2026-09-04
status: in-progress
branch: codex/refactor-agent-plugins
depends-on: 2026-09-04-001-feat-agent-plugins-d1-hosted-port-plan.md
---

# feat: D1 sandbox lease store (full-hosted posture on Better Auth + D1)

## Why

The Better Auth + D1 composition refuses every posture but `control-plane-only`
(`better-auth-d1-compose.ts`: "no D1 durable sandbox lease store is implemented"), so a user-deployed
Cloudflare deployment cannot create cloud workspaces at all, and the cloud half of Agent Plugins
(V2/V3 in the previous plan) could only be proven on the miniflare rail. The Convex-era plane had
`createConvexLeaseStore` + `retained-sandbox-driver.ts`; both went with Convex.

## Current flow (observed)

- `POST /api/workspace` with a cloud backing (`workspace/routes/index.ts` ~557) needs
  `services.sandbox.sandboxManager`; absent → 503 `sandbox_driver_unavailable`.
- `composeProviderNeutralHostedControlPlane(env, bindings)` builds that manager only when
  `bindings.sandbox = { driver, leaseStore }` is injected AND `CLAXEDO_SANDBOX_DRIVER` names the same driver
  (`provider-neutral-hosted-services.ts` `sandboxManager()`).
- `composeBetterAuthD1UserDeployedControlPlane` never injects `sandbox` and throws for
  `CLAXEDO_SANDBOX_POSTURE !== "control-plane-only"`; `cloudWorkspaceAdmission` answers 403.
- The release/prepare scripts and `certified-worker-artifacts.ts` pin `sandboxPosture: "control-plane-only"`;
  the ledger stores the posture in the release identity.
- Agent Plugins already carries the cloud half (`prepareRuntime`/`provisionRuntime` on the hosted core app,
  `signed-composio.miniflare.test.ts`); it only lacks a running sandbox manager.

## Design

### Lease store (WP1, subagent)

`packages/claxedo-server/src/sandbox/stores/d1.ts` — `createD1SandboxLeaseStore({ database })` over a new
`sandbox_leases` table (`migrations/control-plane/0022_sandbox_leases.sql`, `SandboxLeaseRow` columns). Same
semantics as `stores/sqlite.ts` (the canonical store); D1 has no cross-statement transactions, so every write is a
single statement guarded by the epoch it observed, and a guarded write that changes nothing re-reads and reports
the winner. Verified on real Miniflare D1, including a concurrent-acquire race.

### Driver composition in the Worker (WP2)

`packages/claxedo-server/src/authority/adapters/worker/hosted-sandbox-driver.ts` — the retired
`retained-sandbox-driver.ts` brought back on the new plane: `CLAXEDO_SANDBOX_DRIVER` selects `cloudflare`
(`CLOUDFLARE_SANDBOX_WORKER_URL` + `CLOUDFLARE_SANDBOX_API_TOKEN`), `daytona`, `exe`, or `fetch`. The runtime
control env the sandbox receives is derived from what the plane already knows: relay JWKS =
`<CLAXEDO_WORKSPACE_RELAY_URL>/.well-known/jwks.json`, management JWKS = `<BETTER_AUTH_URL>/.well-known/jwks.json`,
session authority = `<BETTER_AUTH_URL>/api/runtime-authority/session-authorize`, relay verify PEM =
`CLAXEDO_RELAY_HOST_VERIFY_PEM`. Only the full-hosted composition imports it, so control-plane-only artifacts keep
their closure.

### Posture in the composition (WP3)

`composeBetterAuthD1UserDeployedControlPlane` accepts `CLAXEDO_SANDBOX_POSTURE=full-hosted` when
`CLAXEDO_SANDBOX_DRIVER` is set and the driver composes; it injects
`sandbox: { driver, leaseStore: createD1SandboxLeaseStore({ database: controlPlaneDatabase }) }` and admits cloud
workspaces (user-deployed has no billing tier: the owner's org is entitled). `control-plane-only` keeps refusing a
driver, `full-hosted` refuses a missing one — both fail closed at composition.

### Release pipeline (WP4)

- `certified-worker-artifacts.ts`: `user-deployed-better-auth-d1-candidate-agent-plugins-full-hosted` — the
  same entrypoint and Worker name as the Agent Plugins candidate, `sandboxPosture: "full-hosted"`,
  `resources.sandboxDriver: true`.
- `release-better-auth-d1.ts` reads the posture from the environment (`CLAXEDO_SANDBOX_POSTURE=full-hosted`
  `CLAXEDO_SANDBOX_DRIVER=<driver>` `CLAXEDO_<ENV>_SANDBOX_WORKER_URL`), cutover + `--agent-plugins` only: posture
  `full-hosted` in the profile, ledger identity and manifest; vars `CLAXEDO_SANDBOX_POSTURE=full-hosted`, `CLAXEDO_SANDBOX_DRIVER=<driver>`,
  `CLOUDFLARE_SANDBOX_WORKER_URL`; required secret `CLOUDFLARE_SANDBOX_API_TOKEN` (cloudflare) /
  `DAYTONA_API_KEY` (daytona). `prepare-better-auth-d1.ts` certifies both postures. `deploy-hosted.ts` threads the
  flag.

### Live target (owner decision 2026-09-04)

Cloudflare sandbox Worker `claxedo-sandbox-proxy` at `sandbox.claxedo.com` (deployed 2026-08-31); its
`API_TOKEN` is rotated to a fresh value the release carries as `CLOUDFLARE_SANDBOX_API_TOKEN`. Daytona's key in
`.env` is invalid and no snapshot is known to exist.

## Definition of done

- `@claxedo/server` typecheck green; ratchets + product boundary green; deployment-closure tests pin that the plain
  candidate and the control-plane-only Agent Plugins candidate do not close over the sandbox drivers.
- `stores/d1.test.ts` (Miniflare D1) green incl. the concurrent acquire; compose test proves `full-hosted` +
  `cloudflare` yields a sandbox manager and that `control-plane-only` + a driver is refused.
- Release/prepare tests green for `--sandbox cloudflare`; staging release with `--agent-plugins --sandbox cloudflare`
  deployed and dev-opened.
- Live: a signed desktop creates a cloud workspace on staging, the VM boots through `claxedo-sandbox-proxy`, and the
  Agent Plugins provisioner delivers the signed world (Context7/Composio gateway servers) to it; the lease row is
  visible in `sandbox_leases`.

## Progress log (2026-09-04)

- WP1 `1ba4104f81` (D1 lease store + migration 0022, 12 Miniflare tests incl. a concurrent acquire race), WP2–WP4
  `72b3edf8fc` (driver composer, full-hosted posture, certified artifact, release/prepare support; secrets carried
  by `CLAXEDO_RELEASE_SECRETS_FILE` no longer need a prior `secret put`). Server suites 45 files / 392 tests,
  ratchets green.
- `claxedo-sandbox-proxy` `API_TOKEN` rotated (keychain `claxedo-cf-sandbox-proxy-token-260830-232009-3851`);
  its `/sandboxes` registry answers with the new token.
- Release 73 (first full-hosted) failed candidate health: `better-auth-d1-release-identity.cf.ts` still certified
  only control-plane-only. Fixed in `41faf522f4`; stale candidate row rolled back, deployment consolidated.
  Release 74 (`release-acc-vm2-260904-123000-3851`, rev 184) deployed and dev-opened: the plane composes the
  cloudflare driver and the D1 lease store (the sandbox-manager egress warning shows in the tail).
- Live create refused: `POST /api/workspace/create` passed a fresh id as `projectId` when the caller gave none, and
  the D1 authority admits creation only inside an existing project the caller administers
  (`workspace_authorization_denied`); with an existing local-worktree project the repo-key assertion refused the
  row instead. Fixed in the route (the authority derives the project from the repository); release 75 follows.
- Release 75 (`release-acc-vm3-260904-125000-3851`, rev 186): **cloud VM live on the new plane.** Create returned
  `ws_mtmkytgm_yh0p15xyj414qz19`; the `/connection` poll drove `ensure` and `sandbox_leases` holds
  `epoch 1, status ready, sandbox claxedo-ws_mtmkytgm…, url https://sandbox.claxedo.com/sandbox/…/proxy`; the
  sandbox worker's registry lists the sandbox. Two findings: the create route's fire-and-forget provisioning is
  cancelled by workerd once the response returns (no `waitUntil`), so the first `ensure` runs on the app's first
  `/connection` poll — acceptable, since the app polls, but worth a `waitUntil` follow-up; and the Agent Plugins
  provisioner minted its service runtime token as `agent-plugins-provisioner`, which the D1 runtime authority
  refuses (only `control-plane`, owner) → `runtime_provision_failed`. Fixed in `83621960b9`; release 76 follows.
- Release 76 (`release-acc-vm4-260904-131500-3851`, rev 188): the service actor mints; the provisioner's
  `POST /api/wr/agent-plugins/apply` reaches the relay (two relay events, forwarded) and the VM's runtime answers
  401 `relay_token_claims_invalid` ("claims are incomplete"). The relay's signing key matches the plane's
  `CLAXEDO_RELAY_HOST_VERIFY_PEM` (same JWK `x`), and the plane's target lookup returns `access: cloud` /
  `backing: cloud-vm`, so the mismatch is the claim RULES: the sandbox worker's runtime image was built
  2026-08-31 10:35Z, before `903b2d4dec` (13:45Z) reshaped the Relay Host Token claims (`parent_jti`, the
  access/backing pair, no actor profile requirement). Rebuilding the sandbox worker image from the current tree
  (`build-sandbox-image.ts --agent-plugins --bundle-only` + `wrangler deploy` in
  `scripts/sandbox/cloudflare-worker`), which also ships the Agent Plugins materializer the VM needs.
