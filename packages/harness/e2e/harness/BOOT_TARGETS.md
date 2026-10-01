# E2E boot targets

Local flows boot the local daemon. Signed and cloud flows boot the hosted Cloudflare Worker under Miniflare/workerd with local D1, R2 and Durable Object storage, and reach runtimes through the production Cloudflare relay with a Worker-issued Runtime Access Token. Neither tree boots `claxedo-server`'s self-hosted entry or the Bun relay; `boot-targets.test.ts` refuses either import.

| Entry | Boot target | Owned behavior |
| --- | --- | --- |
| App and harness `startStack` → `startDaemon` | `local-daemon-entry.ts` → `claxedo-local-server`'s `startLocalServer` with Agent Plugins and Tasks | Local projects, credentials, Agent Plugins, Tasks, PTY, harness sessions and restart recovery; the app bundle is served by `local-app-bundle.ts` |
| App `startSignedStack` (`signed`, `signedCloud`) | `startHostedStack` (`emailPassword`, the front's origin), `startHostedAppFront`, a local daemon, `startHostedMachine` | Email/password sign-up verified through the Worker's `EMAIL` binding, owner bootstrap, host enrollment, consented folders, serving credentials and the daemon tunnel |
| H19, H19.pi, H33 → `startHostedCloudStack` | `startHostedStack` plus the owner, the scripted ACP connection and Pi as default | Cloud ACP/Pi turns, default-harness delivery to a running sandbox |
| H30, H19.hosted*, H28, H31 | `startHostedStack` | Hosted credentials, plugins, settings and per-person accounts |
| `startHostedStack` | Certified `better-auth-d1-worker.agent-plugins.full-hosted.cf.ts`, Wrangler dry bundle, `claxedo-server/scripts/e2e/hosted-miniflare.ts` | Better Auth, D1 ownership/settings/session registration, R2, Cloudflare sandbox control |
| `startHostedRelay` | `workerd-relay.ts` → Node `relay-workerd.mjs` → `workspace-relay/wrangler.toml`, `WorkspaceRelayRoom` | Runtime HTTP/SSE/WebSockets, capability verification, host signing |
| H19.default, H19.opencode | `cloud-product-host.ts` → `host-entry.agent-plugins.ts` | Runtime composition and signed config delivery without a control plane or relay |

Ports come from `ports.ts` (`46100-46199` by default; `CLAXEDO_E2E_PORT_RANGE` overrides). A hosted stack leases control-plane, sandbox API, model, Git and relay ports; a signed browser stack also leases its public HTTPS origin, whose front serves the built app and forwards control-plane paths to workerd. The sandbox API fixture launches the real runtime through the local brokering driver and records each runtime's pid, environment, home and secret names in `local-broker-targets`.

## Assertions with no hosted equivalent

| Flow/assertion | Reason |
| --- | --- |
| H29 self-hosted cold start creates its signing keys | The hosted Worker requires provisioned signing bindings; nothing creates keys on first boot. Flow and recording removed. |
| H32 custom ACP connection spends a stored secret, and revoking it refuses the next session | Hosted connection descriptors accept `secretRefs` and the runtime lease route serves them, but no hosted route stores a credential a descriptor can name (`/api/claxedo/credentials` exists only in the self-hosted server). Flow and recording removed. |
| H33 saved commands reach and leave the running sandbox | Saved commands are `~/.claxedo/commands` files served by the local server; the hosted Worker has no commands route and delivers none. |
| H33 an installed plugin's MCP server reaches new cloud sessions and leaves on removal, and the config-push faults | `/api/claxedo/plugins/signed-runtime` is a local-daemon route; hosted plugins activate through sources and the MCP gateway, which H28 covers. |
| H30 the account's scope moves from shared to local | Hosted accounts have no scope; revoking is deleting the account (`DELETE /auth/openai?harness=pi`), and the readback is the Pi provider catalog. Every sandbox, placeholder and broker assertion is unchanged. |
| App 35 a machine owner's app plugins never reach another signed-in account | The live app-plugin registry is a local-daemon route; a hosted account never reaches another person's machine. The local case remains. |

Changed shapes that keep the assertion: H19's ungranted member is refused a connection by the Worker and refused by the relay with their own cookie, instead of carrying a self-hosted member bearer; app 00's signed-out API refusal reads `/api/workspace` on the Worker; flows 21, 24 and 38 create repository-backed cloud workspaces; flow 39 selects by the D1 project id.
