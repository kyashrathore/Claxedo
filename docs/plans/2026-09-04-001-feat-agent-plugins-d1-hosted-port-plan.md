---
title: "feat: port the hosted Agent Plugins composition from Convex/Clerk to Better Auth + D1"
date: 2026-09-04
status: in-progress
branch: codex/refactor-agent-plugins
---

# feat: port the hosted Agent Plugins composition to Better Auth + D1

## Why

`codex/refactor-agent-plugins` was written against Convex + Clerk + WorkGraph. Dev removed all three
(`c103088e0d`..`52d993fc85`). After the rebase the harness-neutral core
(`@claxedo/server-core/agent-plugins/*`), the unsigned local rail (`@claxedo/local-server/agent-plugins/*`),
the app UI, and the hosted routes survive; the four hosted seams below do not:

| Seam | Old owner (deleted) | New owner |
| --- | --- | --- |
| Signed activation metadata | `convex/components/agentPlugins` via `ConvexSignedAgentPluginActivationStore` | `D1SignedAgentPluginActivationStore` over `CONTROL_PLANE_DB` (migration `0019`) |
| Hosted Connections (MCP OAuth rows, attempts, credentials) | `hosts/workgraph/hosted/connections-setup.ts` on Convex | `connections/hosted-d1/*` on `CONTROL_PLANE_DB` (migration `0020`) + envelope-encrypted KV credentials (`hostedOrgCredentials`) |
| Worker composition | `hosted-shared/hosted-app.ts` overrides + `worker.agent-plugins.ts` | `HostedCoreAppOptions.routeContributions` + `productWorkspace.prepareRuntime/provisionRuntime`, certified artifact `user-deployed-better-auth-d1-candidate-agent-plugins` |
| Deploy profile | `build-convex-profile.ts` + wrangler profile builder | `renderBetterAuthD1WranglerConfig` gains R2 (`CLAXEDO_AGENT_PLUGINS`) + KV (`CLAXEDO_CREDENTIALS`) bindings when `--agent-plugins` is selected |

## Requirements (verification definition, from the owner)

- **V1 unsigned**: a local unsigned install enables a plugin once and every project on that machine gets it
  (existing rail; re-verified through `lifecycle.e2e.test.ts` and the running desktop).
- **V2 signed, cross-machine**: a signed user enables a plugin on machine A; machine B (signed as the same user)
  and every cloud workspace of that user receive it without re-doing anything.
- **V3 MCP auth once**: connecting an OAuth MCP server (Composio, Context7) once is enough for every cloud
  session and every signed machine.
- **V4 live**: Composio and Context7 from the public `kyashrathore/plugins` collection are the live targets.

Cloud VMs: dev's certified Better Auth + D1 worker is `control-plane-only` (no D1 sandbox lease store), so
`createCloudWorkspace` is refused on staging. The cloud half of V2/V3 is proven through the unchanged hosted
prepare/provision rail (`signed-composio.miniflare.test.ts`, now over the D1 store) and cannot be proven live
until a D1 sandbox lease store exists. That gap is reported, not hidden.

## Design

### Signed activation store (D1)

Same model as the Convex component, one table per row kind, all keyed by canonical application ids:
`agent_plugin_revisions` (per org, idempotent `last_operation_id` replay), `agent_plugin_artifact_pins`
(authority `user|organization|claxedo`), `agent_plugin_user_defaults`, `agent_plugin_project_overrides`,
`agent_plugin_organization_defaults`, `agent_plugin_claxedo_defaults`. Authorization comes from the D1
authority port (`usersMe`, `resolveOrgId`, `authorizeProject`, `listOrgs`); the store never accepts owner ids
from callers. Runtime reads (`readRuntime`, `runtimeSnapshot`, `runtimeSnapshotForUser`) recheck
membership/project/workspace access with the same SQL shapes `D1WorkspaceAuthority` uses.

### Hosted Connections (D1)

`createHostedD1ConnectionsSetup` is the port of the WorkGraph-owned setup: per-request
`createConnectionsService` over a D1 `ConnectionStorePort` partitioned by `(org, owner)`, a durable D1
`Attempts` port with the kit's exact single-use/TTL semantics, and `hostedOrgCredentials(orgId, env)` for
secret bytes. Membership resolves through the authority (`usersMe` → org, `listOrgs` → role). Mounted at
`/api/claxedo/integrations` on the hosted core app when the Agent Plugins composition is selected.

### Composition

`createHostedAgentPluginsComposition({ env, plane, database, authentication })` returns
`{ routeContributions, integrations, prepareRuntime, provisionRuntime }`. The new certified entrypoint
`better-auth-d1-candidate-worker.agent-plugins.cf.ts` wraps the candidate composition and injects those into
`HostedCoreAppOptions` (`routeContributions`, `integrationRoutes`, `productWorkspace`). Provisioning pushes to
cloud VMs through `sandboxFetch` as before; user-hosted workspaces are skipped there because the signed desktop
pulls (below).

### Signed desktop (V2 local half, V3 local half)

New hosted route `GET /api/claxedo/plugins/runtime/self`: the signed user's all-projects effective set as an
`AgentPluginRuntimeApplyRequest` plus gateway secrets (origin-style gateway URLs, no wildcard DNS). Electron main
pulls it on sign-in, after every activation mutation, and every 10 minutes (gateway token TTL is 30), and hands
it to the daemon's embedded runtime apply route, which materializes a `signed` generation and applies the
harness launch machine-wide while signed in. Sign-out re-applies the machine (unsigned) generation.

## Work packages

- **WP1 (subagent)** D1 activation store + migration `0019` + tests; delete `convex-store.ts`.
- **WP2 (subagent)** D1 Connections host + migration `0020` + tests.
- **WP3 (owner)** composition seams, certified artifact, wrangler/deploy, routes fixes, desktop pull, gateway
  origin style, closure/ratchet tests, staging release, live verification with Composio + Context7.

## Definition of done

- `bun run typecheck` green for `@claxedo/server`, `@claxedo/server-core`, `@claxedo/local-server`,
  `@claxedo/app`, `@claxedo/desktop`; `bun run test:architecture-ratchets` green; deployment-closure tests green.
- WP1/WP2 vitest suites green on Miniflare D1; `signed-composio.miniflare.test.ts` green over the D1 store.
- Staging release with the agent-plugins artifact serves `/api/claxedo/plugins` and `/api/claxedo/integrations`.
- V1: unsigned desktop enables `context7`; a second project on the machine sees it in its harness config.
- V2/V3 local: desktop signed on this machine (fresh profile = "other machine") shows the plugin enabled and
  Composio/Context7 connected without re-auth, and the local harness config carries the gateway endpoints.
- V2/V3 cloud: proven by the miniflare rail only; live cloud VM verification is blocked on the D1 sandbox lease
  store (owner decision).
