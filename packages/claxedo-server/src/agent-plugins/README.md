# Agent Plugins module

This module turns standard [Agent Plugins](https://agent-plugins.org/) directories into explicit, per-harness runtime activation. Its dependency chain is deliberately one-way:

```text
authorized collection source
  -> validated source-scoped candidate
  -> immutable retained artifact
  -> authority-owned artifact pin and activation choice
  -> effective user/project or machine snapshot
  -> atomic runtime generation
  -> harness-specific projection
```

A collection is only a discovery and update source. Runtime provisioning never reads GitHub. The first **Enable** and every explicit **Update** validate and retain the complete plugin directory by SHA-256 digest before changing a pin. **Disable** changes activation metadata only. It does not remove the retained artifact, MCP Connection, plugin data, or an already active generation. A retained plugin therefore remains usable when its source repository, branch, or path disappears.

The module has no source-management API. The containing product supplies the Claxedo collection and may supply an already-authorized personal or organization collection. Each collection is one public GitHub repository with one plugin per immediate child directory. Private repositories are not supported. Candidate identity is `(source ID, child path)`; names and bytes are never merged or compared across collections.

## User flows and authority

The supported harness registry is exactly `opencode`, `claude`, `codex`, and `cursor`. An “all harnesses” UI action expands to those four IDs when the mutation is written, so a future adapter cannot silently opt existing users into a new harness.

Unsigned local mode stores one tri-state choice per `(machine, plugin, harness)`. It is machine-wide and has no project selector. Signed hosted mode stores a tri-state project override and a tri-state user all-projects default per `(user, organization, plugin, harness)`. The all-projects value is read dynamically for every current or future project; it is not copied into project rows.

Effective activation is resolved once, in this order:

```text
signed:   project override -> user all-projects default -> organization positive default -> Claxedo positive default -> disabled
unsigned: machine override -> Claxedo positive default -> disabled
```

Only the user and machine layers may explicitly disable. Organization and Claxedo defaults are positive-only and never make a plugin required. A winning enabled choice without its retained artifact remains visibly `artifact-unavailable`; it is not silently treated as disabled and runtime readiness fails closed.

Catalog reads are side-effect free. **Refresh** bypasses the source cache, validates current candidates, and reports ordinary path-scoped errors and `updateAvailable`; it changes no artifact, pin, activation, runtime, or Connection. **Update** is the explicit acquisition action. Source-unavailable retained entries remain in the catalog response with `sourceAvailable: false`.

Organization default mutations require the authenticated actor to be an organization admin or owner. Personal activation mutations derive the user from signed authentication and authorize every selected project before committing the batch. Callers cannot submit an owner identity.

## Runtime materialization

Hosted provisioning reads the signed activation snapshot, resolves effective state, loads only pinned digests from the artifact store, and sends the exact trees to the workspace runtime. Local composition performs the same resolution from the machine store. Both paths call the one materializer in `packages/claxedo-local-server/src/agent-plugins/runtime/materialize.ts`.

The materializer writes a pending generation under:

```text
<runtime-root>/agent-plugins/generations/generation-<revision>-<uuid>/
  plugins/<name>-<identity>/
  harnesses/<harness>/
  generation.json
```

It verifies identity, revision monotonicity, supported harnesses, unique plugin/harness selections, retained digest availability, and MCP projection correspondence. Only after every tree and projection succeeds does it atomically replace `<runtime-root>/agent-plugins/active.json`. Failure deletes the pending generation and leaves the previous active pointer intact. Plugin-owned writable data uses a stable identity-derived directory outside immutable generation bytes.

Projection ownership is:

- OpenCode receives a generated, module-owned configuration with skill paths and MCP entries.
- Claude receives a generated Claude-compatible directory copy with its plugin manifest and MCP configuration.
- Codex receives a marker-owned local marketplace cache plus a Claxedo-owned profile; unrelated Codex files are untouched.
- Cursor receives marker-owned children of `~/.cursor/plugins/local`; unrelated children are untouched.

Harness launch code receives only the selected projection or generated config. It cannot read catalog sources, choose activation, or resolve credentials.

## Remote MCP authentication

`streamable-http` MCP servers use the existing Connections domain. Agent Plugins contributes a deterministic dynamic integration for a retained `(plugin instance, server)` and implements MCP protected-resource/authorization-server discovery. Connections remains authoritative for connection rows, one-time OAuth attempts, PKCE state/verifier, encrypted credentials, refresh, status, disconnect, and personal-over-organization selection. There is no Agent Plugins credential, OAuth-session, or connection table.

The user chooses **Connect** for a personal Connection. An organization admin or owner may separately choose **Connect for organization**. The routes derive the personal user or organization owner from authenticated context. At runtime the existing Connections resolver selects a personal Connection first and falls back to the organization Connection.

OAuth discovery probes the exact MCP resource. A `401` Bearer challenge may point to Protected Resource Metadata with `resource_metadata`; otherwise the standard path-specific and root well-known locations are tried. The resource metadata supplies allowed authorization-server issuers. When exactly one advertised issuer is compatible, it is selected automatically; when several are compatible, the catalog asks the user to choose. Connections freezes that issuer in the connection fields, and runtime provisioning reuses it rather than making a new choice. The selected issuer's authorization-server or OIDC metadata must exactly identify that issuer, support PKCE S256, and expose safe authorization/token endpoints. Client registration is either exact-issuer pre-registration from `CLAXEDO_MCP_OAUTH_CLIENTS` or a configured Client ID Metadata Document URL when the issuer advertises it. Dynamic Client Registration is not supported.

For a cloud runtime, provisioning checks Connections readiness but never resolves the upstream OAuth token. It creates a short-lived, narrowly scoped gateway capability for `(user, organization, project, workspace, harness, plugin, server, integration)`. The existing sandbox driver's secret broker attaches that capability only to its unique gateway hostname. It is absent from VM environment variables, plugin bytes, harness config, and runtime snapshots. A driver with `secretBrokering: none` marks only that protected MCP server unavailable; skills, stdio MCP, public MCP, and other plugin content remain available.

The stateless gateway then performs this flow for every MCP request:

```text
harness -> scoped gateway host -> verify runtime capability
        -> re-check current activation and membership
        -> ask Connections for a live token
        -> replace Authorization and call the one canonical upstream resource
        -> pass MCP method, metadata, session, streaming, and response headers through
```

The gateway stores nothing, does not interpret JSON-RPC, does not retry ambiguous calls, and never forwards incoming cookies, authorization, or unrelated private headers. An upstream `401` or `403` is reported to Connections so its canonical status/refresh flow can recover.

## Build and deployment profiles

This is a build-composed feature, not a runtime switch. Disabled entrypoints do not import the module, mount `/api/claxedo/plugins`, read its storage binding, emit its UI chunk, deploy its Convex component, or add it to sandbox images.

Enabled hosted deployments require:

- the `CLAXEDO_AGENT_PLUGINS` R2 binding;
- the isolated Agent Plugins Convex component/profile;
- `CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL` in production or `CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_URL_STAGING` in staging;
- `CLAXEDO_AGENT_PLUGINS_MCP_GATEWAY_ZONE_NAME`;
- an operator-created proxied wildcard DNS record for `*.<gateway-zone>`.

The gateway origin must be exactly one label below the zone (for example, `mcp-staging.claxedo.dev`). Runtime hosts prepend their scope hash to that label (for example, `mcp-<hash>-mcp-staging.claxedo.dev`), preserving one origin per brokered secret while staying inside standard one-level Cloudflare TLS coverage. The worker-profile builder enforces that shape and DNS label length, emits a route limited to `*.<gateway-zone>/api/claxedo/plugins/mcp/*`, and injects the canonical gateway origin. The deploy script selects the enabled server, app, Convex, Worker, and sandbox profiles together. Omitting the feature flag selects the ordinary artifacts instead.

The primary verification commands are:

```text
bun run typecheck
bun run lint
bun run test:architecture-ratchets
bun run --cwd packages/claxedo-server verify:closure
bun run --cwd packages/claxedo-local-server verify:closure
bun run --cwd packages/claxedo-desktop verify:closure
bun run --cwd packages/claxedo-app verify:closure
```

MCP protocol coverage uses the pinned MCP Inspector and a long-lived SDK client against the real gateway route. It exercises initialize, tools/list, tools/call, resources/list, prompts/list, MCP metadata headers, session continuity, Connections token injection, and isolated Inspector OAuth storage.
