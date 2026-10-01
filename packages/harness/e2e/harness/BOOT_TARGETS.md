# E2E boot targets

Local flows boot the local daemon. Signed and cloud flows boot the hosted Cloudflare Worker under Miniflare/workerd with local D1, R2 and Durable Object storage, and reach runtimes through the production Cloudflare relay with a Worker-issued Runtime Access Token. Neither tree boots `claxedo-server`'s self-hosted entry or the Bun relay; `boot-targets.test.ts` refuses either import.

| Entry | Boot target | Owned behavior |
| --- | --- | --- |
| App and harness `startStack` → `startDaemon` (incl. H32, H33.local) | `local-daemon-entry.ts` → `claxedo-local-server`'s `startLocalServer` with Agent Plugins and Tasks | Local projects, credentials, Agent Plugins, Tasks, PTY, harness sessions and restart recovery; the app bundle is served by `local-app-bundle.ts` |
| App `startSignedStack` (`signed`, `signedCloud`) | `startHostedStack` (`emailPassword`, the front's origin), `startHostedAppFront`, a local daemon, `startHostedMachine` | Email/password sign-up verified through the Worker's `EMAIL` binding, owner bootstrap, host enrollment, consented folders, serving credentials and the daemon tunnel |
| H19, H19.pi, H33 → `startHostedCloudStack` | `startHostedStack` plus the owner, the scripted ACP connection and Pi as default | Cloud ACP/Pi turns, default-harness delivery to a running sandbox |
| H30, H19.hosted*, H28, H31 | `startHostedStack` | Hosted credentials, plugins, settings and per-person accounts |
| `startHostedStack` | Certified `better-auth-d1-worker.agent-plugins.full-hosted.cf.ts`, Wrangler dry bundle, `claxedo-server/scripts/e2e/hosted-miniflare.ts` | Better Auth, D1 ownership/settings/session registration, R2, Cloudflare sandbox control |
| `startHostedRelay` | `workerd-relay.ts` → Node `relay-workerd.mjs` → `workspace-relay/wrangler.toml`, `WorkspaceRelayRoom` | Runtime HTTP/SSE/WebSockets, capability verification, host signing |
| H19.default, H19.opencode | `cloud-product-host.ts` → `host-entry.agent-plugins.ts` | Runtime composition and signed config delivery without a control plane or relay |

The signed browser's origin is `https://claxedo-e2e.localhost:<front port>`: the app runs its local-daemon path for any loopback server URL, so a hosted origin has to be a name. The front listens on 127.0.0.1 and ::1, Node fixture requests and sandboxed runtimes (`localhost-resolver.mjs`) resolve the name to 127.0.0.1, and each signed build reserves the relay port its Content-Security-Policy names.

Ports come from `ports.ts` (`46100-46199` by default; `CLAXEDO_E2E_PORT_RANGE` overrides). A hosted stack leases control-plane, sandbox API, model, Git and relay ports; a signed browser stack also leases its public HTTPS origin, whose front serves the built app and forwards control-plane paths to workerd. The sandbox API fixture launches the real runtime through the local brokering driver, records each runtime's pid, environment, home and secret names in `local-broker-targets`, and answers the driver's backup and restore by copying the sandbox's workspace and runtime data.

## Machine-local contracts

H32 (a custom ACP connection spends a stored secret, and revoking it refuses the next session) and H33.local (a saved command and the signed-runtime plugin snapshot reach and leave a running runtime) are machine-local features the local daemon serves: its `/api/claxedo/credentials`, `/api/claxedo/agent-config/connections` and `/commands`, and `/api/claxedo/plugins/signed-runtime`. H33's hosted half keeps the default-harness delivery to a running sandbox; the config-push fault modes lived in the self-hosted entry and are gone.

## Assertions with no hosted equivalent

| Flow/assertion | Reason |
| --- | --- |
| H29 self-hosted cold start creates its signing keys | The hosted Worker requires provisioned signing bindings; nothing creates keys on first boot. Flow and recording removed. |
| H30 the account's scope moves from shared to local | Hosted accounts have no scope; revoking is deleting the account (`DELETE /auth/openai?harness=pi`), and the readback is the Pi provider catalog. Every sandbox, placeholder and broker assertion is unchanged. |
| App 35 a machine owner's app plugins never reach another signed-in account | The live app-plugin registry is a local-daemon route; a hosted account never reaches another person's machine. The local case remains. |

Changed shapes that keep the assertion: H19's ungranted member is refused a connection by the Worker and refused by the relay with their own cookie, instead of carrying a self-hosted member bearer; app 00's signed-out API refusal reads `/api/workspace` on the Worker; flows 21, 24 and 38 create repository-backed cloud workspaces; flow 39 selects by the D1 project id.

The browser signed cases of app flows 00, 24 (asleep, wake, live stream) and 38 (stored surface) are skipped until `goal/web-hosted-account` gives a browser signed in to the Worker a project source; the app reads projects only from the local daemon's `/api/claxedo/projects` or a signed desktop's account catalog. Flows 24 and 38 also run on the signed desktop (`signedCloud` + `signedDesktop`); waking and streaming a cloud session from the desktop are skipped until the session sources plan's S5 lets the desktop reach an account cloud workspace's runtime.
