# E2E boot targets

Local flows boot the local daemon. Signed and cloud flows boot the hosted Cloudflare Worker under Miniflare/workerd with local D1, R2 and Durable Object storage, and reach runtimes through the production Cloudflare relay with a Worker-issued Runtime Access Token.

| Entry | Boot target | Owned behavior |
| --- | --- | --- |
| App and harness `startStack` → `startDaemon` (incl. H32, H33.local) | `local-daemon-entry.ts` → `claxedo-local-server`'s `startLocalServer` with Agent Plugins and Tasks | Local projects, credentials, Agent Plugins, Tasks, PTY, harness sessions and restart recovery; `local-app-bundle.ts` serves the app bundle, which the signed front also serves |
| App `startSignedStack` (`signed`, `signedCloud`) | `startHostedStack` (`emailPassword`, the front's origin), `startHostedAppFront`, a local daemon, `startHostedMachine` | Email/password sign-up verified through the Worker's `EMAIL` binding, owner bootstrap, host enrollment, consented folders, serving credentials and the daemon tunnel |
| H19, H19.pi, H33 → `startHostedCloudStack` | `startHostedStack` plus the owner, the scripted ACP connection and Pi as default | Cloud ACP turns on the workspace runtime, Pi turns in the session host, default-harness delivery to a running sandbox |
| H30, H19.hosted*, H28, H31 | `startHostedStack` | Hosted credentials, plugins, settings and per-person accounts |
| `startHostedStack` | Certified `better-auth-d1-worker.agent-plugins.full-hosted.cf.ts`, Wrangler dry bundle, `claxedo-server/scripts/e2e/hosted-miniflare.ts` | Better Auth, D1 ownership/settings/session registration, R2, Cloudflare sandbox control |
| `startHostedRelay` | Node `relay-workerd.mjs` → `workspace-relay/wrangler.toml`, `WorkspaceRelayRoom`, and in the same workerd the session-host Worker from the deploy's `renderSessionHostWranglerConfig` | Runtime HTTP/SSE/WebSockets, capability verification, host signing; `SessionDO` for every Pi session placed in its own host (H19.pi, H19.hostedpi) |
| H19.default, H19.opencode | `cloud-product-host.ts` → `host-entry.agent-plugins.ts` | Runtime composition and signed config delivery without a control plane or relay |

The signed browser's origin is `https://claxedo-e2e.localhost:<front port>`: the app runs its local-daemon path for any loopback server URL, so a hosted origin has to be a name. The front listens on 127.0.0.1 and ::1, Node fixture requests and sandboxed runtimes (`localhost-resolver.mjs`) resolve the name to 127.0.0.1, and each signed build reserves the relay port its Content-Security-Policy names.

The relay's `SESSION_HOST` binding names the session-host Worker by script, so both run in one workerd. The session host's `CONTROL_PLANE` service binding reaches the control-plane Worker, a separate workerd here, over its HTTPS origin, and the provider origins it calls directly (its direct credentials name the vendor) reach the scripted model server; its calls to the relay stay on loopback. `hostedPiSession` (`hosted-cloud.ts`) reserves a Pi session, mints its session-host connection and drives the session's routes through the relay, as the app does.

Ports come from `ports.ts` (`46100-46199` by default; `CLAXEDO_E2E_PORT_RANGE` overrides). A hosted stack leases control-plane, sandbox API, model, Git and relay ports; a signed browser stack also leases its public HTTPS origin, whose front serves the built app and forwards control-plane paths to workerd. The sandbox API fixture launches the real runtime through the local brokering driver, records each runtime's pid, environment, home and secret names in `local-broker-targets`, and answers the driver's backup and restore by copying the sandbox's workspace and runtime data.

## Machine-local contracts

H32 (a custom ACP connection spends a stored secret, and revoking it refuses the next session) and H33.local (a saved command and the signed-runtime plugin snapshot reach and leave a running runtime) are machine-local features the local daemon serves: its `/api/claxedo/credentials`, `/api/claxedo/agent-config/connections` and `/commands`, and `/api/claxedo/plugins/signed-runtime`. H33's hosted half keeps the default-harness delivery to a running sandbox.

## Assertions with no hosted equivalent

| Flow/assertion | Reason |
| --- | --- |
| H30 the account's scope moves from shared to local | Hosted accounts have no scope; revoking is deleting the account (`DELETE /auth/openai?harness=pi`), and the readback is the Pi provider catalog. Every sandbox, placeholder and broker assertion is unchanged. |
| App 35 a machine owner's app plugins never reach another signed-in account | The live app-plugin registry is a local-daemon route; a hosted account never reaches another person's machine. The local case remains. |

Changed shapes that keep the assertion: H19's ungranted member is refused a connection by the Worker and refused by the relay with their own cookie; app 00's signed-out API refusal reads `/api/workspace` on the Worker; flows 21, 24 and 38 create repository-backed cloud workspaces; flow 39 selects by the D1 project id.

Flows 24 and 38 run in a signed browser and on the signed desktop (`signedCloud` + `signedDesktop`); the desktop is launched with the stack's relay as `CLAXEDO_RELAY_ORIGINS`, the origin its renderer policy admits.

Port leases publish a complete PID record atomically through a hard link, so
another process cannot reclaim an empty file while its owner initializes it.
Stale-owner cleanup is serialized per port and rechecks liveness under that
claim. An unreadable owner identity is treated as occupied. A crashed reclaim
claim conservatively blocks reclamation until the temporary lease directory is
cleaned; it never authorizes deleting another run's lease. Linux CI also reserves
the fixture range through `script/ci-linux-test-host.sh` so automatic outbound
socket allocation cannot steal a probed port before the actual server binds.
