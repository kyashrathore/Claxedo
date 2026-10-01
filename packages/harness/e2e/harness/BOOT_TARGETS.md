# E2E boot targets

The local launchers use the local daemon and both standalone relays use the production Cloudflare Worker. The self-hosted retirement gate remains open because the signed app fixture and six harness cloud flows depend on contracts that the hosted fixture does not provide. No flow assertions were removed or weakened.

| Entry | Boot target | Why it needs that target |
| --- | --- | --- |
| App `startStack` → `startDaemon` | `local-daemon-entry.ts` → `claxedo-local-server/src/app/start-local-server.ts` | Local projects, credentials, Agent Plugins, Tasks, PTY and embedded harness sessions; no control-plane workspace authority or sandbox provisioning |
| Harness `startStack`, without `cloud: true` | The same local daemon entry | Local harness HTTP, SSE, persistence, fault injection and restart flows |
| App `startSignedStack` → `daemon.restart({ signed })` | `claxedo-server/src/deployments/self-hosted-node/index.ts` | Embedded issuer, signed folder project/workspace registration and reserved sessions; retained exception |
| Harness `startStack({ cloud: true })` | `cloud-server-entry.ts` → `startSelfHostedServer`, with the local brokering sandbox driver | Docker/remote-directory creation, account-bearer runtime routing at the control-plane origin; retained exception |
| Harness `startHostedStack` | Certified `better-auth-d1-worker.agent-plugins.full-hosted.cf.ts` under Miniflare, with local D1, R2 and Durable Object storage | GitHub identities, D1 ownership, hosted settings, repository workspaces, credential brokering and runtime registration |
| App `startRelay` and harness `startHostedRelay` | `workerd-relay.ts` → Node `relay-workerd.mjs` → production `workspace-relay/wrangler.toml`, `src/worker.ts`, `WorkspaceRelayRoom` | Runtime HTTP, SSE, WebSocket forwarding, token verification, generation fencing and host signing |
| H19.default and H19.opencode | `cloud-product-host.ts` → `host-entry.agent-plugins.ts` directly | Runtime composition and signed configuration delivery; neither a control plane nor a relay is booted |
| Packaged desktop fixture | Desktop's own local daemon launcher | Already uses the local product; no change to its launcher |

Ports are leased through `ports.ts`: default `46100-46199`, overridable with `CLAXEDO_E2E_PORT_RANGE`. App global setup reserves its bundle's daemon port; signed builds reserve a separate TLS-front port. Hosted stacks reserve control-plane, sandbox, model, Git and relay ports. Changing the relay implementation adds no externally leased port.

The relay fixture dry-bundles the production Wrangler config and passes its converted Worker options to Miniflare. Its private home and Durable Object storage live under the stack's temporary root. Outbound network access permits loopback only, and hosted resolver TLS trusts the fixture certificate. Workerd performs upstream HTTP and WebSocket forwarding directly. The app fixture uses ephemeral relay signing keys; hosted fixtures use `hosted-keys.ts`. Startup requires both the workerd-ready marker and a successful JWKS response. Teardown stops the owned process group before removing storage.

## Remaining retirement blockers

| Flows | Evidence and missing setup |
| --- | --- |
| App signed fixtures: 00 signed smoke; signed tests in 12, 16, 26, 30, 35 and 38; 21, 24 and 39 | `signed-stack.ts` signs up by email, grants the operator, and calls `makeSignedWorkspace`, which records a directory project then resolves a folder workspace. Hosted `routes/hosted/workspace.ts` returns `null` from `/resolve`; it does not register folders. These flows need a real owned host enrollment, serving consent, workspace registration and tunnel fixture. Account-bearer requests to `/workspaces/:id` also need the canonical relay/runtime-token transport. |
| App signedCloud, including 24 and the signed desktop fixtures | `cloud.ts` configures Docker auth and creates a workspace from `remoteDirectory` without a repository. Hosted creation requires an admitted repository and the certified Cloudflare sandbox driver. This needs repository-backed Cloudflare setup plus the enrollment fixture for the local-folder tests. |
| H19 and H19.pi | `cloud-workspace.ts` creates `driver: docker` with no repository and routes the account bearer through the control-plane origin; H19 additionally sends unsigned and ungranted-member runtime requests directly to that origin. A hosted move requires canonical runtime-token routing, not a same-origin proxy. Existing H19.hosted variants exercise the hosted contracts separately. |
| H29 | Explicitly asserts that a self-hosted cold start with no configured signing keys creates them and delivers a signed snapshot. Hosted Workers require provisioned signing bindings. Preserving this assertion is incompatible with deleting the self-hosted product; the owner must rule on that flow. |
| H30 | Same Docker/bearer setup; also reads the local sandbox PID, environment, home and files and verifies replacement after credential revocation. The hosted brokering fixture can expose those observations, but the current flow uses the self-hosted credential and routing contracts. |
| H32 and H33 | Same Docker/bearer setup. H32 validates custom ACP secret delivery and revocation; H33 validates default harness, command and MCP config publication without replacing the runtime. They need the hosted identity, repository, configuration and runtime-token setup, with their assertions preserved. |

The hosted product supports email/password auth (`platform/auth/better-auth-d1-foundation.ts`); email auth is **not** inherently self-hosted-only. The existing `claxedo-server/scripts/e2e/hosted-miniflare.ts` hardcodes GitHub auth, its API origin as the app origin, and the hosted test signing keys. That script is outside this lane. The orchestrator/server fixture owner should expose auth method, email sender, exact app origin and signing configuration to the fixture, then compose the enrollment path. No production bypass, compatibility proxy or synthesized workspace is needed or authorized.

The plan's evidence that both harnesses boot retired targets is confirmed. Its statement that the authority twin and Bun relay survive *only* for e2e is broader than this lane's evidence: both also still have production entrypoints and self-hosted contracts in this checkout. This change removes the two Bun relay launch paths, but does not open the self-hosted deletion gate.

## Acceptance outside the sandbox

Run these commands sequentially from the repository root unless a working directory is specified. This lane cannot bind sockets or launch browsers. The orchestrator must build package distributions first (`bun run build:packages`).

Local harness flows, including variants, persistence, cancellation, permissions, isolation and fault checks:

```sh
bun run --cwd packages/harness flows H0 H1 H2 H3 H3b H4 H5 H6 H7 H8 H9 H10 H11 H12 H13 H14 H15 H16 H17 H18 H19.default H19.opencode H20 H21 H22 H23 H24 H25 H26 H27 H35 H36 H37 H38
```

Hosted control plane and workerd relay (ACP, Pi, OpenCode, settings and per-person accounts):

```sh
bun run --cwd packages/harness flows H19.hostedacp H19.hostedpi H19.hostedopencode H28 H31
bun test --cwd packages/claxedo-app ../harness/e2e/harness/hosted-stack.test.ts --timeout 180000
```

Retained self-hosted cloud contracts (H19 also selects its hosted/direct-runtime variants):

```sh
bun run --cwd packages/harness flows H19 H29 H30 H32 H33
```

All app browser flows, then packaged desktop flows, including their retained signed fixtures:

```sh
bun packages/claxedo-app/e2e/run.ts --project=web --project=phone
bun packages/claxedo-app/e2e/run.ts --project=desktop
```

Targeted signed/cloud browser and desktop recovery coverage:

```sh
bun packages/claxedo-app/e2e/run.ts --project=web --project=phone '00-signed-smoke|24-cloud-sandbox'
bun packages/claxedo-app/e2e/run.ts --project=desktop '21-desktop-sign-in|39-signed-desktop-sessions'
```

Production relay binary/WebSocket/backpressure checks, from `packages/workspace-relay`:

```sh
bun test src/relay-workerd-binary.test.ts src/relay-workerd-backpressure.test.ts --timeout 240000
```

Expected differences: local stacks report the local product and have no cloud authority; existing local flow assertions should remain valid. Standalone relays now use Durable Object gateway, hibernation and alarms, so live stream reconnect, binary delivery, revocation and sandbox stop/wake need acceptance on workerd. The signed app stack now bootstraps its machine configuration through the local daemon before its retained self-hosted restarts. Its relay also uses workerd. No e2e success is claimed by the socket-free launch tests.
