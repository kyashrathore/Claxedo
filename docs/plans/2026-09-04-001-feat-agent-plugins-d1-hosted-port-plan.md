---
title: "feat: port the hosted Agent Plugins composition from Convex/Clerk to Better Auth + D1"
date: 2026-09-04
status: in-progress (WP1–WP3 committed on the branch; staging release 65 + live pass in progress)
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

New hosted route `GET /api/claxedo/plugins/runtime/self` (`runtime/self-runtime.ts`): the signed user's
all-projects effective set as an `AgentPluginRuntimeApplyRequest` plus the gateway secrets a sandbox driver would
have brokered (origin-style gateway URLs, no wildcard DNS) and `expiresAt`. Electron main
(`main/agent-plugins-signed-sync.ts`) pulls it on sign-in, after every `agentPlugins.*` mutation, and five minutes
before the credential expires (retry 60 s on failure), and PUTs it to the daemon's loopback
`/api/claxedo/plugins/signed-runtime` (`activation/signed-runtime-routes.ts`). The daemon materializes it under
`<dataDir>/runtime-signed` and every harness launches with that generation while it is applied; a re-pull at the
same revision with a rotated bearer re-projects. Sign-out PUTs `null`, which clears the signed generation and the
machine world launches again. The operation is renderer-withheld: only main holds the account credential.

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

## Progress log (2026-09-04)

- WP1 `b2d9ee6b99`, WP2 `b287661ceb` (with review fixes: partition-scoped upsert, owner-gated attempt polling,
  409 `connection_exists`, owner-scoped runtime resolution, no un-revoke in `readSecret`, sampled sweep), WP3
  `da12ab4d55`.
- Verified: `@claxedo/server` typecheck; server suite 259/260 files before the WP2 fixes (the one failure was the
  public-package count after this branch retired the extensions package; fixed), then connections + agent-plugins +
  closure suites 172/172; local-server agent-plugins 12 files/40 tests incl. the signed apply/rotate/clear flow;
  desktop suite 763/763 after adding `agentPlugins.runtimeSelf` to the operation matrix; ratchets 2/2 + product
  boundary (desktop ceiling 88).
- **V1 unsigned, live**: dev desktop from this worktree (`CLAXEDO_AGENT_PLUGINS=1 bun run predev`, then
  `electron-vite dev`) enabled `["claxedo","context7"]` for all four harnesses through the daemon's
  `POST /api/claxedo/plugins/activation` → revision 1 applied; `~/.claxedo-dev/runtime/agent-plugins` holds
  `generation-1-…` with `harnesses/{opencode,claude,codex}` projections and the Claude `.mcp.json`; the machine-wide
  Codex `~/.codex/config.toml` gained `[plugins."context7@claxedo-agent-plugins"]` and Cursor gained
  `~/.cursor/plugins/local/claxedo--context7--…`. The daemon's `harnessLaunch()` is project-agnostic by
  construction, so every project on the machine launches with it.
- Negative flow observed: signed in against release 64 (no plugin routes), main logs
  `signed world sync failed: control plane answered 404` every 60 s and the daemon's signed runtime stays
  `{active:false}` (machine world keeps launching).
- Staging incident: `wrangler secret put CLAXEDO_CREDENTIALS_KEK` created an untagged "Secret Change" version and
  the candidate worker answered 503 `deployment_candidate_unavailable` (`CF_VERSION_METADATA.tag is required`)
  for ~12 min; recovered by redeploying the tagged release-64 version. Secrets now ride the release through
  `CLAXEDO_RELEASE_SECRETS_FILE`.
- Release 65 (`release-acc-plugins-260904-033000-3851`) failed `/__release/candidate-health`: the worker logged
  `CLAXEDO_HOSTED_CREDENTIALS_ENABLED=1 but CLAXEDO_CF_KV_URL is not configured` because the base plane's
  `workerCredentials(env)` only saw the string-only composition env and never the `CLAXEDO_CREDENTIALS` binding.
  Fixed in `be995567e6` (`credentialsNamespace` seam on `HostedControlPlaneAdapterBindings` and the Better Auth +
  D1 composition input; compose test fails without it). The failed candidate's locked ledger row was retired with
  `prepare-better-auth-d1.ts --rollback-candidate` (active 164 → 166, release 64 still open); release 66
  (`release-acc-plugins2-260904-040500-3851`) follows.
- Release 66 (`release-acc-plugins2-260904-040500-3851`, rev 168 open) deployed and dev-opened; `/api/claxedo/plugins`,
  `/plugins/runtime/self`, `/api/claxedo/integrations`, `/plugins/mcp/*` all exist (401 without a bearer). Signed
  desktop calls then answered 503 `auth_verifier_unavailable`: the routes only knew `services.auth.verifier`, while
  the Better Auth + D1 plane authenticates through its request adapter. Fixed in `6f74d0a60e` (adapter threaded
  through `hostedAgentPluginsModule` → `HostedAgentPluginRoutes`; route test with adapter and no verifier). Same
  commit: a transient `unavailable` account no longer withdraws the signed world. Release 67 follows.
- Release 67 (`release-acc-plugins3-260904-042500-3851`, rev 170 open): signed desktop pull works end to end.
  Two more defects found live and fixed: the daemon died on restart after a Cursor activation because the re-read
  refused Cursor's harness-owned root (`de038ef3c1`: `external` roots), and a generation an older build wrote could
  not be restored at all (`5a8fdc589c`: re-project from the SQLite activation store instead of refusing to start).
- **V2 local half, live**: `POST /api/claxedo/plugins/activation` (signed, `target.scope=all-projects`, all four
  harnesses) through the desktop account channel → control plane revision 1 → main refreshed `runtime/self` →
  daemon `signed-runtime` `{active:true, revision:1}` with `runtime-signed/.../generation-1-…` carrying the
  Context7 projections for Claude, Codex (`launch.json` marketplace) and OpenCode (`opencode.json` skills path).
  Fresh-machine simulation: wiping `~/.claxedo-dev/runtime-signed` and triggering any `agentPlugins.*` op
  re-materialized revision 1 from the control plane alone. Sign-out → `{active:false}` ("signed world withdrawn;
  the machine world launches"); sign-in → re-pulled revision 1.
- **V3 root causes (live targets)**: the signed catalog reports Context7 `discovery-failed` and Composio
  `unsupported-client-registration`. Context7's protected-resource metadata names the origin
  (`https://mcp.context7.com`) rather than the exact `/mcp/oauth` URL, which discovery refused; and neither Clerk
  (Context7) nor Composio advertises `client_id_metadata_document_supported` — both offer RFC 7591 dynamic
  registration only, which the branch did not implement (pre-registered or client-id-metadata-document only).
  Fix in flight: prefix-tolerant resource matching + dynamic client registration persisted in
  `mcp_oauth_clients` (migration 0021). The consent click itself needs the owner's logged-in browser; the
  Claude-in-Chrome extension reports no connected browser in this session, so that step stays owner-blocked.
- `bba574288b`: RFC 7591 dynamic client registration (`mcp_oauth_clients`, migration 0021; secrets via the
  deployment credential partition, never in D1 rows), prefix-tolerant resource identifiers, the runtime preparer
  threads the same port, and the Connections kit now carries declared fields on OAuth tokens (the MCP gateway
  matched `fields.resource` and answered 409 for every OAuth connection before). Release 68 carries it.
- Known gap, pre-existing on the branch: `packages/claxedo-desktop` `verify:closure` fails its emitted-manifest
  check (`desktop-hosted-contribution` requires `platform/remote-access/machine-remote-access.ts` in its chunk,
  but the module lands in the shared main chunk; its importers are identical on dev). The source ratchets and the
  product-boundary source checks pass; the emitted check needs a chunking decision by the desktop owner.
- Branch pushed to `origin/codex/refactor-agent-plugins` (no PR, per owner).
- Release 68 (`release-acc-plugins4-260904-050000-3851`, rev 172 open). **V3 up to consent, live**: the signed
  catalog reports both servers as `oauth` (Context7 with issuers `clerk.context7.com` / `context7.com`);
  `POST /api/claxedo/integrations/<mcp-…>/connect` (method oauth, scope personal) registered clients dynamically —
  `mcp_oauth_clients` holds `https://clerk.context7.com` → `i5MSj5eaMigMknSR`, `https://connect.composio.dev` →
  `client_01M1MSW87WAY8978XFYSVKAAY7`, `https://context7.com` → `sVIoBCRLmFIhW7Ig`, no secrets — and returned PKCE
  authorization URLs bound to the staging callback and the exact MCP resource. Attempts are owner-gated rows in
  `hosted_connection_attempts` (`pending`, then `expired` after the TTL). The signed daemon world advanced to
  revision 2 with both plugins. Connect is offered only for MCP servers of retained (enabled) plugins, which is
  why Composio first answered `unknown_integration`.
- **Still owner-blocked**: the consent click at Clerk/Composio (both require the owner's own account session; the
  Claude-in-Chrome extension reported no connected browser all session), so the callback → token → gateway →
  runtime-credential half of V3 is proven only by `signed-composio.miniflare.test.ts` (real D1 authority, real
  hosted-d1 Connections, dynamic registration, gateway forwards the bearer). Cloud-VM half of V2/V3 remains
  blocked on a D1 sandbox lease store (staging is control-plane-only).
