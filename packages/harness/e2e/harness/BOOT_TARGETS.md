# E2E boot targets

Both e2e trees boot the local daemon for local flows and the hosted Cloudflare Worker for signed/cloud flows. Hosted control-plane, D1, R2 and Durable Object storage run under Miniflare/workerd. Runtime traffic goes through the production Cloudflare relay with a Worker-issued Runtime Access Token. Socket-free tests verify fixture composition; live acceptance below remains for the orchestrator.

| Entry | Boot target | Owned behavior |
| --- | --- | --- |
| App and harness `startStack` → `startDaemon` | `local-daemon-entry.ts` → `claxedo-local-server/src/app/start-local-server.ts` | Local projects, credentials, Agent Plugins, Tasks, PTY, harness sessions and restart recovery |
| App `startSignedStack` | `startHostedStack`, `startHostedAppFront`, local daemon and `startHostedMachine` | Browser/desktop auth, email verification, owner bootstrap, P256 host enrollment, consented folders, serving credentials and daemon tunnel |
| H19, H19.pi, H30, H32, H33 → `startHostedCloudStack` | Shared hosted stack and canonical hosted configuration APIs | Repository-backed Cloudflare provisioning, ACP/Pi turns, credential revocation, ACP secrets, default harness and commands |
| `startHostedStack` | Certified `better-auth-d1-worker.agent-plugins.full-hosted.cf.ts`, Wrangler dry bundle, `claxedo-server/scripts/e2e/hosted-miniflare.ts` | Better Auth, D1 ownership/settings/session registration, R2 persistence and Cloudflare sandbox control |
| `startHostedRelay` | `workerd-relay.ts` → Node `relay-workerd.mjs` → production `workspace-relay/wrangler.toml`, `src/worker.ts`, `WorkspaceRelayRoom` | Runtime HTTP/SSE/WebSockets, capability verification, generation fencing and host signing |
| H19.default, H19.opencode | `cloud-product-host.ts` → `host-entry.agent-plugins.ts` directly | Runtime composition and signed config delivery without a control plane or relay |
| Packaged desktop | Desktop's own local daemon; account fixture uses hosted stack | Local workspaces and hosted account workspace/session catalog |

Ports are leased through `ports.ts` (`46100-46199` by default; `CLAXEDO_E2E_PORT_RANGE` overrides). Hosted stacks lease control-plane, sandbox API, model, Git and relay ports. Signed browser builds additionally lease their public HTTPS origin. The front serves the built app and forwards control-plane requests retaining the public host. Runtime traffic uses the relay capability directly.

The existing Cloudflare sandbox API fixture launches the real product runtime through the local brokering driver. H30 reads actual PID/environment/home/filesystem observations in `local-broker-targets`. The fixture admits its repository/model endpoints and refuses other outbound access. Child processes have private HOME/XDG paths. The relay owns separate Durable Object storage; workerd forwards HTTP and WebSockets.

`startHostedMachine` signs the enrollment challenge with real keys, acquires the enrollment through `createHostConnector`, and acknowledges only folders explicitly consented by `makeWorkspace`. Heartbeat-issued endpoints/serving credentials go to the local daemon's `/api/claxedo/host-serving`; the daemon owns the tunnel. Workspace/project IDs come from the canonical local daemon and D1 catalog. Session creation reserves the ID in D1 before sending the same ID/operation to the runtime. Another person's cookie is never a runtime capability.

## Retired behavior and evidence corrections

These assertions belong to deleted product contracts; they are listed explicitly rather than translated into different assertions.

| Flow/assertion | Disposition and reason |
| --- | --- |
| H29 cold start without configured signing keys | Flow, recording and exclusion removed. Automatic filesystem signing-key creation belongs to the self-hosted server; hosted Workers require provisioned signing bindings. There is no hosted equivalent. |
| App 00 unsigned `GET /api/claxedo/projects` returns 401 | Assertion removed. Hosted does not mount the self-hosted folder-project endpoint. Browser redirect, owner sign-in, transcript and logout assertions remain. |
| App 35 signed live app-plugin registry publish/update/remove across two accounts | Signed case removed. Hosted does not mount the signed server's local registry; machine tunnels reject machine-local registry routes. The local spec 35 remains. Hosted Agent Plugins sources/activation are a different contract. |
| H33 direct `/api/claxedo/plugins/signed-runtime` MCP snapshot install/remove and config faults | Direct snapshot/MCP assertions and fault helpers removed. The self-hosted in-process registry injects a raw MCP URL without replacement. Hosted uses source activation/gateway credentials; changing those credentials re-ensures the sandbox. H28 tests that hosted contract. H33 retains default harness, saved command, live/stored turn, command removal, transport command retention and unchanged PID assertions. |

Flow 39 previously used the workspace ID for project-scope list queries and UI selectors; it now uses the D1 project ID without changing pagination/title assertions. Hosted workspace create returns only a workspace ID/directory; the app fixture reads the matching project from the hosted catalog.

Part 1's boot map incorrectly identified specs 12, 16, 26 and 30 as signed consumers; they use local fixtures. Actual signed consumers are 00, 21, 24, 38 and 39 (plus removed signed 35). Hosted supports email/password; the fixture needed a sender and exact public origin. The only production seam is `AUTH_EMAIL_SERVICE` on the existing hosted Worker composition, carrying the original `AuthEmailMessage` to a service binding. Miniflare records delivery and follows its actual verification URL.

The plan's evidence that both e2e trees booted the retired server was confirmed and is resolved in executable fixtures. Its stronger claim that the authority twin/Bun relay survived only for e2e was not confirmed: production entrypoints remain outside this lane. No production deletion is claimed.

## Orchestrator acceptance commands

Run sequentially from the repository root after `bun run build:packages`. This sandbox cannot bind sockets, launch browsers or validate built distributions. H19 selects itself and all variants; H19.pi can also be diagnosed independently.

```sh
bun run --cwd packages/harness flows H19
bun run --cwd packages/harness flows H19.pi
bun run --cwd packages/harness flows H30
bun run --cwd packages/harness flows H32
bun run --cwd packages/harness flows H33
bun run --cwd packages/harness flows H28
bun run --cwd packages/harness flows H31
bun test --cwd packages/claxedo-app ../harness/e2e/harness/hosted-stack.test.ts --timeout 180000
```

H29 is retired with no substitute command/assertion. H19 includes hosted ACP/Pi/OpenCode variants, which share the canonical reservation helper. H28/H31 cover changed helper callers and hosted plugin/settings/identity isolation.

Each signed app consumer, on its actual projects:

```sh
bun packages/claxedo-app/e2e/run.ts --project=web --project=phone 00-signed-smoke
bun packages/claxedo-app/e2e/run.ts --project=web --project=phone 24-cloud-sandbox
bun packages/claxedo-app/e2e/run.ts --project=web --project=phone 38-session-sources
bun packages/claxedo-app/e2e/run.ts --project=desktop 21-desktop-sign-in
bun packages/claxedo-app/e2e/run.ts --project=desktop 39-signed-desktop-sessions
bun packages/claxedo-app/e2e/run.ts --project=web --project=phone 35-live-plugin-web
```

The last command checks the retained local registry flow. Signed acceptance must prove actual email verification/browser/desktop login, owner-only folder registration, relay HTTP/SSE/WebSockets, persistence, cloud stop/wake and teardown. No wire corpus snapshots were synthesized; after acceptance, re-record and compare changed flows with the existing corpus runner before treating old recordings as parity gates.
