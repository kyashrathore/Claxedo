---
title: "refactor: Replace Agent Extensions with an optional Agent Plugins module"
type: refactor
status: active
date: 2026-08-30
deepened: 2026-08-30
---

# refactor: Replace Agent Extensions with an optional Agent Plugins module

## Overview

Replace the current `@claxedo/agent-extensions` install system with a substantially smaller, server-owned Agent Plugins feature that follows Agent Plugins v1.0.0 directly.

The new system has four responsibilities:

1. Read standard plugin candidates from catalog sources supplied by the product, and acquire an immutable validated artifact when an authority first enables or updates one.
2. Store lightweight defaults plus signed user/project/harness or unsigned machine/harness activation metadata.
3. Project the retained artifact into only its selected supported harnesses before those harnesses start.
4. Adapt plugin-declared MCP servers into the existing Connections authority and route protected calls through a thin MCP transport gateway, using the sandbox manager's existing secret-brokering capability where available. Agent Plugins does not create a second connection, credential, OAuth-attempt, or secret-broker subsystem.

The entire feature is optional at composition time. A build without Agent Plugins must not import, bundle, deploy, migrate, mount, or advertise any Agent Plugins implementation.

This is a hard replacement, not a compatibility layer. Old install/update/uninstall state, custom package shapes, component-level materialization, and policy machinery are discarded. The cutover may delete files/documents proven to be owned by the old system, but no legacy reader, route, alias, state translation, fallback, or transition release remains in the final build.

## Mental Model

```text
Catalog source                 Durable Agent Plugins state             Runtime filesystem
--------------                 ---------------------------             ------------------
Discover candidates   --Enable/Update--> immutable artifact   +        harness projections
                                          activation metadata  ----->   active plugin roots

Source may later move, disappear, or publish newer bytes.      Runtime keeps using the retained artifact.
```

The catalog is a discovery input, not a runtime authority. Enable/Update is the acquisition boundary: validate the exact directory, copy it into durable content-addressed storage, and atomically bind the enabling authority to that digest. Disable removes effective projection only; it retains the artifact. Refresh only compares source candidates with retained artifacts and may show **Update**.

## What Goes Away

| Current capability or concept | Disposition |
|---|---|
| Public `@claxedo/agent-extensions` runtime package | Delete after cutover; Agent Plugins becomes a server feature module rather than an independently published lifecycle package. |
| `agent-extensions` CLI and facade | Delete. There is no second command-line installation authority. |
| `install` and `uninstall` vocabulary/lifecycle | Delete. Users enable, disable, return to default, refresh the catalog, or explicitly update. First Enable acquires the artifact behind the scenes; Disable never deletes it. |
| Arbitrary per-plugin GitHub sources | Delete. Each authority has one public GitHub collection repository containing many plugin directories. |
| Existing custom package shapes (`SKILL.md` at root, `mcp/`, `.cursor-plugin`, `plugins/cursor`, hooks packages) | Delete. Accept Agent Plugins v1 roots only: `plugin.json`, optional `skills/`, optional `mcp.json`, and standard client-extension namespaces. |
| Hard-coded catalog entries in `packages/claxedo-server-core/src/agent-config/extensions/catalog.ts` | Delete. Catalog entries are indexed from collection repository children and their `plugin.json` manifests. |
| `machine`, `project`, and `workspace` install scopes | Delete as install concepts. Unsigned local activation has one machine-wide scope; signed activation is keyed by user, project, and harness. |
| Per-install harness target arrays | Delete as package lifecycle state. Harness target remains a first-class activation dimension because only a bounded set of harnesses has an adapter; no plugin is projected into every known harness automatically. |
| Desired-state `installed.json` | Delete. Durable activation metadata is authoritative. |
| Per-package `lock.json` | Delete. An authority-owned artifact pin points at immutable content-addressed bytes. |
| Component ownership `materialized.json` | Delete after the legacy cleanup. Atomic whole-directory generations make component ownership bookkeeping unnecessary. |
| Source-owned runtime fetching | Delete. Sources are read only for catalog display and explicit Enable/Update acquisition; provisioning never depends on them. |
| Repo-controlled `.agent-extensions` declarations and project trust ledger | Delete. Repo-local plugin behavior belongs to the selected harness/client; the Claxedo module does no project cataloging, activation, or materialization work. |
| Discovery scan, machine scan, adopt, ignore, and detach flows | Delete. The module catalogs a plugin only when it is an immediate child of a collection supplied through the source port. |
| Workspace install mirrors | Delete. The effective activation query reads the canonical user/project metadata directly. |
| `AgentExtensionPolicyOverride` and the org/user/workspace policy precedence system | Delete. Replace it with positive Claxedo/org defaults plus one explicit user/project override. |
| Empty extension snapshots in products without a catalog | Delete. When the module is absent, the route and runtime field are absent. |
| Component-specific merging into user MCP/skills files | Delete. The canonical unit written to runtime storage is the whole plugin directory. Harness projection adapters generate isolated views without editing user-owned configuration. |
| Extension-specific types in core control-plane, supervisor, and workspace-runtime contracts | Delete. Generic route/provisioning contributions remain in core; plugin types stay inside the optional module. |
| Root runtime-config `agent_extensions` field and replay implementation | Delete. Plugin projection is a provisioning/reconciliation contribution owned by the module. |
| `agent_extension_installs` and `agent_extension_policy_overrides` authorities | Delete their contents and remove the tables/functions. Convex deletion follows the required expand-migrate-contract mechanics; local schema migration drops the obsolete SQLite tables. Nothing translates their records. |
| Legacy extension HTTP surface under `/api/claxedo/agent-config/extensions` | Delete without aliases. Disabled builds return ordinary `404`; enabled builds expose the new plugin metadata API. |
| Install-oriented Marketplace UI and MCP picker actions | Replace with catalog availability, effective state, enable/disable, project selection, and authentication status. |
| Agent Extensions package publishing, package smoke script, and sandbox dependency pin | Delete from release/build scripts and package manifests. |
| Agent hook and built-in OpenCode document-agent helpers inside Agent Extensions | Move to their actual owners if still required: runtime notification bootstrap and OpenCode harness bootstrap. They are not Agent Plugins v1 components. |

## What Comes In

| New capability | Responsibility |
|---|---|
| Optional `agent-plugins` server domain | Owns catalog reads through an injected source port, artifact acquisition, defaults, activation metadata, effective resolution, dynamic MCP integration descriptions/readiness, provisioning, and reconciliation. Connections remains the owner of connection/auth state. |
| Build-selected feature composition | Includes the module only in Agent Plugins-enabled server, frontend, Convex, and VM artifacts. |
| Agent Plugins v1 validator and indexer | Validates root `plugin.json`, fixed component locations, schemas, names, paths, and independent failure boundaries. |
| Catalog source port | The containing product supplies readable Claxedo and optional personal/organization sources. The module validates their immediate-child plugin directories but exposes no source-management API. |
| Durable artifact store and pins | On Enable/Update, retains validated plugin bytes by digest and binds the enabling authority to that digest. Artifact storage outlives the catalog source. |
| Lightweight activation authority | Stores Claxedo/org per-harness defaults, signed user project overrides, signed user all-project defaults, and unsigned machine/harness overrides. |
| Effective activation resolver | Produces the exact plugin set for one harness on one machine or authenticated user/project runtime. |
| Atomic active-directory generations | Builds a complete new generation, validates it, then swaps one active pointer. Failure preserves the previous generation. |
| Harness directory adapters | Pass standard plugin roots directly where supported; create isolated directory-shaped projection views for nonconforming harnesses such as Claude. |
| MCP-to-Connections adapter | Registers plugin-declared remote MCP servers as dynamic Connections integrations. Existing Connections owns connection rows, OAuth attempts, token storage, refresh, and personal-over-organization resolution. |
| MCP transport gateway | A narrow pass-through from a harness to one upstream MCP server. It asks Connections for a live token and attaches it upstream; it owns no durable credential or OAuth state. Runtime access uses existing workspace/turn identity and the sandbox manager's existing brokered-secret channel where supported. |
| VM provisioning contribution | Resolves and materializes the effective set before the runtime becomes ready. |
| Running-runtime reconciliation | Applies a newer effective revision to an existing isolated runtime without treating a failed or unavailable control plane as an empty set. |
| Plugin Catalog UI contribution | Shows source, supported/selected harnesses, inherited default, user override, effective state, explicit update availability, validation errors, and MCP connection readiness. |

## Problem Frame

The current package exists because Claxedo historically had to translate separately sourced skills, MCP snippets, Cursor plugins, hooks, and agents into several harness-specific file layouts. Agent Plugins v1 now standardizes the portable package unit as a directory with root `plugin.json`, fixed `skills/`, and root `mcp.json`.

Keeping the old lifecycle would duplicate the new standard and preserve concepts that no longer have a product meaning:

- “Installed” mixes source acquisition, durable intent, filesystem presence, and runtime readiness.
- A plugin is copied component by component, so Claxedo needs desired state, content locks, ownership ledgers, target lists, cleanup logic, scans, and conflict recovery.
- Workspace install state and policy overlays do not model multiplayer intent. The actual choice belongs to one user in one project, while Claxedo and organizations only provide inherited defaults.
- Plugin implementation is reachable from generic control-plane and runtime packages, so it cannot be omitted from products that do not ship it.

The refactor must finish the migration to one clear path rather than layering the new model over the old package.

## Requirements Trace

### Standard content and availability

- **R1 — Standards alignment:** Load only Agent Plugins v1.0.0 plugin roots and honor its validation, path-containment, component-discovery, placeholder, and failure-boundary rules.
- **R2 — Collection model:** A collection is one public GitHub repository whose immediate child directories are independent standard plugins; one repository may contain any number of plugins. A candidate identity is source-scoped as `(source_id, relative_plugin_path)`; the module never merges or deduplicates candidates across sources.
- **R3 — Source boundary:** Claxedo supplies one public collection. Signed users additionally receive personal and organization sources only when the containing product supplies them. Private repository access is out of scope. Configuring, publishing, or authorizing catalog sources is outside this module.
- **R4 — Repo-local plugins:** Claxedo adds no project-plugin catalog, activation, or materialization layer. Repo-local discovery is outside this module and remains entirely with the selected harness/client.
- **R5 — Availability:** Unsigned users see the Claxedo public collection. Signed users additionally see a personal or organization collection only when present. Invalid children are omitted from the valid list and returned as ordinary path-scoped errors, with no role-specific behavior.
- **R6 — Durable acquisition:** First Enable and every explicit Update validate and copy the exact plugin directory into durable content-addressed storage before activation points to it. The retained artifact remains usable if the collection, repository, branch, or plugin path later disappears.

### Defaults and user choices

- **R7 — Defaults:** Claxedo and organization admins may mark an acquired plugin default enabled for specified supported harnesses. Defaults are positive only and do not make a plugin required.
- **R8 — User authority:** A signed user can explicitly enable or disable a plugin for each project and supported harness. An unsigned user can do the same once per machine and harness. The explicit override wins over inherited defaults.
- **R9 — Signed bulk and future choices:** A signed user may apply one choice to selected/all current projects and separately set one dynamic all-projects default. The all-projects default is consulted for every present or future project unless that project has an explicit override; membership creation does not seed rows.
- **R10 — Effective state:** The API exposes source availability, retained-artifact availability, inherited default, all-projects default, explicit project override, effective activation, update availability, validation errors, and MCP auth readiness without using install/uninstall terminology.
- **R11 — Persistence:** Unsigned choices and artifacts live in local durable state and apply machine-wide. Signed choices, authority artifact pins, and defaults live in the hosted durable authority and are canonical for signed local and cloud runtimes.

### Runtime, authentication, and failure safety

- **R12 — Runtime projection:** Every runtime materializes retained immutable artifacts, never live catalog sources, and exposes them only to the harnesses for which they are effectively enabled before those harnesses report ready.
- **R13 — Isolation:** A signed runtime projection belongs to one user/project identity; an unsigned local projection belongs to one machine identity. The module rejects a provisioning request missing the identity required by its mode.
- **R14 — MCP authentication:** Standard remote MCP OAuth is implemented as a generic integration adapter on the existing `@claxedo/connections` service. Connections remains authoritative for connection metadata, OAuth attempts, encrypted credentials, refresh, and personal-over-organization selection. A thin MCP transport gateway resolves a live token from Connections and attaches it to the canonical upstream resource at call time. It stores no duplicate connection or credential state. Authenticated cloud MCP is enabled only when the selected sandbox path can keep the gateway/runtime credential unreadable to the agent; unsupported drivers fail that MCP server closed without disabling sibling plugin components.
- **R15 — Failure safety:** Catalog, acquisition, auth, or materialization failures never synthesize an empty activation set, delete retained artifacts, or destroy the last valid active generation. Refresh is read-only; Update changes an artifact pin only after successful validation and storage.

### Packaging and replacement

- **R16 — Optional deployment:** A disabled build contains no module implementation, routes, backend component, frontend contribution, VM materializer, package dependency, or deployment artifact.
- **R17 — Hard cutover:** Discard legacy state, remove files/documents proven to be owned by the old system, and delete all old package code, state readers, routes, tables/functions, tests, docs, and release paths in the same cutover. No legacy compatibility surface survives.

## Scope Boundaries

- No plugin registry, source configuration/publication API, webhook, polling daemon, branch watcher, or automatic update service.
- No recommended, required, or blocked policy. Harness selection is activation routing, not an organization policy tier.
- No organization-level user assignment. Organizations add plugins to their collection and may make them default enabled; users retain per-project control.
- No non-GitHub collection provider, private repository, GitHub connection selection, repository-token brokerage, or private-source permission in this version.
- No Claxedo-owned project-plugin discovery, catalog, defaults, or projection. Any repo-local behavior remains outside this module under the selected harness/client.
- No raw upstream secrets in `plugin.json`, `mcp.json`, catalog entries, activation rows, Git repositories, harness configuration, or runtime files. Connection metadata/provider IDs remain owned by Connections; Agent Plugins stores none of them.
- No Claxedo-specific authentication extension in the plugin format. This version supports standard MCP OAuth for `streamable-http`; secret-bearing static headers, API keys, and authenticated stdio are deferred.
- No general-purpose server module framework. Add the smallest route/provisioning/frontend contribution seams required by this feature and reuse the repository's existing composition patterns.
- No migration of legacy arbitrary extension installs into new activations: most legacy entries are not valid Agent Plugins and have no canonical collection identity. Old selections are discarded.
- No transition release, deprecation period, legacy route alias, dual-write, dual-read, import shim, or old package facade.
- No adapter for every known harness. Only harnesses in the module's explicit supported-harness registry can be selected or receive a projection.
- No cross-collection name merge, digest comparison, deduplication, or precedence. Two candidates with the same manifest name remain distinct catalog instances. Only final projection into one harness checks for a harness-visible destination/name collision.

## Context & Research

### Current code and patterns

- `packages/agent-extensions/src/index.ts` exports lifecycle, source, fetch, cache, state, lock, trust, replay, materialization, and per-component APIs. This is the surface being removed.
- `packages/agent-extensions/docs/architecture.md` confirms the current three-file desired/lock/materialized model and component-level ownership semantics.
- `packages/claxedo-local-server/src/agent-config/routes/index.ts` statically imports and mounts extension routes inside otherwise unrelated agent-config routes.
- `packages/claxedo-local-server/src/agent-config/routes/extension-routes.ts` owns the current install/update/enable/disable/uninstall and scan endpoints.
- `packages/claxedo-server/src/routes/hosted/shell.ts` independently mounts a hosted catalog route, producing a second route owner.
- `packages/claxedo-server-core/src/agent-config/index.ts` always resolves extension state into runtime config.
- `packages/workspace-runtime/src/workspace/runtime.ts` statically imports `applyRuntimeAgentExtensions`, which pulls the feature into every runtime bundle.
- `packages/claxedo-server-core/src/authority/control-plane-contract.ts`, `packages/claxedo-server-core/src/platform/auth/authority.ts`, and `packages/claxedo-server-core/src/workspace/supervisor-port.ts` expose extension-specific types and methods from generic contracts.
- `convex/agentExtensions.ts`, `convex/agentExtensionPolicies.ts`, and `convex/schema.ts` persist workspace installs and multi-scope policy overrides.
- `packages/claxedo-connections/` is the canonical connection mechanism: separate `ConnectionStorePort`/`CredentialStorePort`, OAuth Attempts, callback consumption, live-token refresh, personal-over-team resolution, and runtime token gating. MCP extends this mechanism instead of creating feature-owned connection tables.
- `packages/claxedo-server/src/connections/store-adapter.ts` already adapts Connections to `ControlPlaneCredentials`; local secret bytes therefore stay in the current credential authority.
- `packages/claxedo-server/src/hosts/workgraph/hosted/connections-setup.ts` already composes hosted Connections with durable Convex attempts and encrypted org credentials, but currently maps every row to the team partition. Personal MCP requires completing this existing hosted partition support.
- `packages/sandbox-manager/src/index.ts` already defines the unreadable `SandboxBrokeredSecret` contract. Daytona and Vercel declare native brokering, Cloudflare declares proxy brokering, and Modal/Box/Docker/Exe declare none.
- `packages/opencode/src/mcp/index.ts` and `packages/opencode/src/mcp/oauth-provider.ts` already implement harness-owned MCP OAuth, but that state is local to one harness. The new module must move the shared connection authority above harnesses rather than synchronize each harness's credential files.
- `packages/claxedo-app/src/app/composition/product-contributions.ts` already demonstrates the required optional-build property: a loader/contribution boundary keeps hosted implementations outside a local static import graph.
- `packages/claxedo-server/src/deployments/deployment-closures.test.ts` and product route inventories already enforce bundle reachability separately from mounted routes.
- `convex/convex.config.ts` already uses a Convex Component for migrations; a feature-owned component can isolate Agent Plugins tables/functions from the root schema.
- `docs/tech-docs/convex-schema-evolution.md` requires expand-migrate-contract and `@convex-dev/migrations` for removing the legacy Convex documents.

### Institutional learnings

- No `docs/solutions/` corpus or critical-pattern file exists in this checkout.
- `docs/plans/2026-07-09-001-refactor-host-owned-runtime-state-plan.md` documents why the legacy `materialized.json` ownership ledger cannot be discarded before it removes owned files. This plan supersedes its requirement to preserve the CLI/package after that cleanup.
- `docs/plans/2026-08-02-004-refactor-platform-and-domains-plan.md` establishes the repository direction: feature domains own routes/services/stores; platform code remains feature-neutral; deployments compose domains.

### External references

- Agent Plugins v1.0.0 defines a directory-root package, required root `plugin.json`, fixed `skills/` and `mcp.json`, client-extension namespaces, path containment, `PLUGIN_ROOT`/`PLUGIN_DATA`, and independent component failure boundaries. It explicitly leaves OAuth discovery, user interaction, and credential storage to clients: https://agent-plugins.org/specification
- MCP 2026-07-28 defines HTTP authorization as an OAuth 2.1 client responsibility: Protected Resource Metadata and authorization-server discovery, per-issuer client registration, PKCE, issuer validation, resource indicators, bearer headers, refresh-token confidentiality, and step-up handling: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- Executor's implemented model separates an integration's authentication template from a born-wired, owner-scoped connection; credential values are resolved from a provider at call time and attached behind an MCP proxy so agents and sandboxes never receive them: https://executor.sh/docs/concepts/connections and https://executor.sh/docs/mcp-proxy
- Convex Components isolate a feature's functions, schema, and data behind a component API. The feature-enabled deployment must explicitly mount the component; the disabled deployment must not: https://docs.convex.dev/components/using

## Key Technical Decisions

### 1. A collection is one source containing many plugins, but source management is outside the module

```text
collection-repository/
  playwright/plugin.json
  linear/plugin.json
  review/plugin.json
```

The injected `CatalogSourceProvider` tells the module which Claxedo, personal, and organization collections are readable for the current actor. The module indexes immediate children and returns valid candidates plus path-scoped errors. It has no route or durable table for configuring, approving, publishing, or refreshing repository settings; that belongs to the product supplying the port.

Catalog **Refresh** means “perform a no-cache read of the currently supplied sources.” It validates candidates and compares their digests to retained artifact pins. It never changes a pin, activation row, running runtime, or active generation. If bytes differ, the UI shows **Update**.

### 2. Candidate identity is source-scoped; there is no cross-collection merge

The stable candidate key is `(source_id, safe_relative_plugin_path)`, represented as an opaque `plugin_instance_id`. `plugin.json.name` is display/package metadata, not a global primary key.

- Never compare same-name candidates across collections merely to merge, deduplicate, or choose a winner.
- Never infer that identical bytes from two sources are the same product choice.
- Internal content-addressed storage may deduplicate bytes by digest as an implementation detail, but authority pins and catalog identities remain distinct.
- Only projection into one harness checks whether two enabled instances would claim the same harness-visible destination or native identifier. That is a runtime activation error for those two instances, not a catalog conflict.

### 3. Enable acquires; Disable retains; Update is explicit

Each authority that can cause activation owns a pin to an immutable artifact:

- `claxedo` for Claxedo defaults;
- `organization` for organization defaults;
- `user` for signed all-project/project choices;
- `local_machine` for unsigned choices.

First **Enable** (or first default-enable) fetches the candidate, validates the exact plugin directory, writes the immutable artifact, then atomically records the authority pin and activation choice in the metadata authority. If the metadata commit fails, the unpinned immutable blob is harmless and eligible for sweeping; neither pin nor choice changes.

**Disable** changes activation only. It does not delete the pin, artifact, MCP connection, or `PLUGIN_DATA`. Re-enable uses the retained artifact even when the source is unavailable or now contains different bytes.

**Update** is explicit and authority-scoped. It acquires and validates the current candidate into a new immutable artifact, atomically switches only that authority's pin, then reconciles contexts whose effective activation resolves to that pin. Failure preserves the old pin and running generation. Artifact garbage collection is a later operational concern and must consider all pins/checkpoints; it is not user-facing uninstall behavior.

Only the pin owner may update it: local users update machine pins, signed users update their user pins, organization admins update org pins, and the Claxedo release authority updates Claxedo pins. A catalog read may show that any effective pin differs from its source candidate, but the action is enabled only for its owner. An inheriting member cannot mutate an org/Claxedo pin; choosing an explicit personal Enable acquires a separate user pin.

### 4. Defaults and overrides remain deliberately small and are resolved dynamically

Harness target is a dimension of activation. The module owns a finite supported-harness registry and one adapter per harness. Unknown harnesses cannot be selected.

Signed resolution for each `(plugin_instance_id, harness_id, user_id, project_id)` is:

```text
explicit project override true/false, when present
  otherwise user all-projects default true/false, when present
  otherwise organization positive default, when present
  otherwise Claxedo positive default, when present
  otherwise disabled
```

Unsigned local resolution is:

```text
explicit machine override true/false, when present
  otherwise Claxedo positive default, when present
  otherwise disabled
```

There is no membership-created event, outbox, or seeded project row. “All future projects” is not a copy operation; it is the same dynamic user all-projects default consulted whenever any current or future project is materialized. A project override remains the only way to diverge. Changing the all-projects default therefore affects every project without an explicit project override on its next effective-state read. If it falls through, an organization or Claxedo default may still enable the plugin.

The UI may offer “all supported harnesses,” but the API expands it to today's registry and stores explicit per-harness rows. Adding a harness later does not silently select it.

### 5. Whole-directory retained artifacts and atomic generations replace source fetching and component ownership

Each authority has durable artifact storage, and each runtime has disposable projection storage:

```text
durable artifact authority/
  artifacts/<sha256>/plugin.json ...
  pins/<owner>/<plugin-instance> -> <sha256>

runtime agent-plugins/
  generations/<activation-revision>/<runtime-instance-id>/...
  projections/<activation-revision>/<harness-id>/...
  active -> generations/<activation-revision>
  data/<runtime-instance-id>/...
```

Provisioning resolves activation to exact artifact digests and reads only the durable artifact store. It never clones or downloads a catalog repository. A runtime materializes a plugin root once when any harness targets it, builds selected harness views, validates the complete generation, then atomically swaps `active`. Disabling one harness removes only that projection; disabling the final harness omits the plugin from the next generation. `PLUGIN_DATA` survives disables and updates.

No files are merged into user-owned configuration. Native clients receive active plugin roots. Nonconforming clients such as Claude receive the smallest generated directory-shaped view under module-owned storage.

### 6. MCP auth extends Connections; Agent Plugins does not create another credential system

Agent Plugins v1 gives the client a `streamable-http` URL and fixed, public headers. It deliberately provides no OAuth configuration and no secret-reference syntax. MCP 2026-07-28 says the MCP client discovers OAuth. In this product, the clean boundary is:

```text
plugin mcp.json
    -> Agent Plugins dynamic integration adapter
    -> existing @claxedo/connections service
         connection row + OAuth attempt + encrypted token + refresh
    -> thin MCP transport gateway
    -> upstream MCP server

harness -> normal MCP protocol -> gateway; it never becomes the credential authority
```

There is no `plugin_mcp_connections` table, plugin credential store, plugin OAuth-session store, or second secret broker. Agent Plugins contributes a dynamic MCP integration to the existing Connections registry and asks Connections for readiness/live-token behavior. The transport gateway is necessary because a central personal/org connection cannot be shared across local and cloud runtimes without either copying its token into each harness or proxying the authenticated request. It is a stateless protocol adapter, not another credential authority.

#### What existing Connections already owns

- `@claxedo/connections` already splits non-secret `ConnectionRow` metadata from `CredentialStorePort` secret bytes.
- It already implements connect, one-time OAuth attempts, PKCE verifier/state, callback handling, token envelopes, refresh-before-expiry, single-flight refresh, status degradation, disconnect, and personal-over-team resolution.
- Local composition already adapts Connections to `ControlPlaneCredentials`; hosted composition already uses durable Convex attempts plus encrypted per-org credentials.
- The existing token route and `ConnectionTurnCredentials` already prove that runtime callers do not need direct credential-store access.

The refactor extends those owners instead of copying them:

- Add an `mcp` capability and a generic dynamic MCP OAuth `IntegrationImpl` derived from one retained plugin/server entry.
- Give the dynamic integration a stable ID derived from the source-scoped plugin instance and server name. The Connection row is therefore already born wired to that server; no binding table is needed.
- Extend the hosted Connections adapter, which currently exposes only the organization/team partition, to persist and resolve both `(organization, user)` personal rows and organization rows. Do this in the Connections backing store, not in Agent Plugins metadata.
- Extend the existing Attempts payload only with the validated MCP resource, issuer, scopes, and callback profile needed by the generic integration. Do not add a plugin-specific authorization-session entity.
- Keep access/refresh tokens in the existing credential authority under `connectionProviderId(connectionId)`. Do not add a `secure_ref` column or raw-token field to Agent Plugins.

#### How personal versus organization connection is decided

The source of the plugin and its default state do not decide credential ownership. The explicit UI action and server authorization decide it:

- A signed member's ordinary **Connect** action sends `scope: personal`; the route derives the personal owner from the authenticated subject/internal user ID. The caller never submits an arbitrary owner ID.
- An org admin gets a separate **Connect for organization** action. That sends `scope: team`; the route first checks the admin role, derives the current internal organization partition, and writes the shared Connection there.
- Unsigned local has one machine/deployment partition and therefore one local connection action.
- At runtime, `ConnectionsService.resolveForCapability()` selects a personal row over the matching organization row. Disconnecting the personal row reveals the organization fallback; disconnecting the organization row requires admin authority.

The existing generic route already understands `scope: personal | team`, but hosted `createHostedConnectionsSetup()` currently supplies only `teamOwner` and maps every record back to `org:<id>`. Supporting the two actions requires completing that existing hosted partition implementation, not inventing ownership inside Agent Plugins.

#### What OAuth discovery terms mean

1. The generic integration calls the plugin's MCP URL without a token. A protected server normally answers `401` with a Bearer challenge such as `WWW-Authenticate: Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource"`. `WWW-Authenticate` is the standard HTTP response header that says how to authenticate; `resource_metadata` is a URL inside that challenge.
2. The JSON at `resource_metadata` is **Protected Resource Metadata**. It identifies the canonical MCP resource and lists one or more authorization-server issuer URLs. It does not issue a token.
3. If the `401` omits that pointer, RFC 9728 defines deterministic fallback URLs. For `https://example.com/public/mcp`, try `https://example.com/.well-known/oauth-protected-resource/public/mcp`, then `https://example.com/.well-known/oauth-protected-resource`.
4. For the selected issuer, fetch OAuth Authorization Server Metadata or OIDC discovery metadata in the MCP-mandated order. That second document supplies the authorization endpoint, token endpoint, supported scopes, registration features, and exact issuer. Reject it if its `issuer` does not exactly match the issuer used for discovery.
5. Multiple advertised authorization servers are separate security domains. Registration and tokens stay keyed to the exact issuer. If exactly one passes validation/registration checks, select it; if several pass, ask the user which organization/issuer to use.

#### What the registration choices mean

Before an authorization server accepts `client_id=...`, it must know who Claxedo is:

- **Pre-registered client:** Claxedo's operator/developer previously created an OAuth application at that exact issuer. Deployment configuration contains the resulting client ID and, for a confidential client, client secret. This is the same shape as the current Google/GitHub integration configuration and is issuer-specific.
- **Client ID Metadata Document (CIMD):** Claxedo hosts a public JSON document at an HTTPS URL containing its name and allowed callback URLs. That exact HTTPS URL is the `client_id`; a supporting authorization server fetches and validates it. There is no per-MCP-server client secret or registration write.
- **Dynamic Client Registration:** the client asks the authorization server to create a new client record at runtime. MCP retains this only for backwards compatibility. This hard-cutover plan does not implement it.

Use the MCP priority unchanged: configured pre-registration for the exact issuer, then CIMD when the issuer advertises support. If neither exists, report `unsupported-client-registration`. Hosted and unsigned-local callback profiles are distinct because one uses a fixed HTTPS callback and the other a fixed loopback callback.

#### Connect flow through the existing Connections state machine

1. Agent Plugins validates the retained plugin/server identity and asks the dynamic Connections integration to probe/discover it.
2. The Connections route derives `personal`, `organization`, or unsigned-local ownership as described above.
3. `ConnectionsService.connectOAuth()` creates an attempt in the existing Attempts port. The extended payload binds owner, integration ID, canonical resource, exact issuer, scopes, callback profile, state, verifier, and expiry. Hosted keeps using its durable Convex Attempts adapter; local keeps the existing short-lived in-memory adapter.
4. The integration opens the authorization URL with PKCE S256, state, least required scopes, and the canonical MCP URI in `resource` on both authorization and token requests.
5. The existing callback consumes the attempt once, validates the returned issuer/state, exchanges the code, and stores the token envelope through `CredentialStorePort` using the normal Connection provider ID.
6. The Connections row becomes `connected`; Agent Plugins reads that summary to report MCP readiness. It stores no duplicate pointer or token.

If the current hosted Attempts representation cannot protect the PKCE verifier to the same standard as other credentials, harden that Connections adapter in place—for example, by storing a credential-store reference in the attempt—not by creating a parallel Agent Plugins attempt table.

#### Call-time path and the sandbox broker

The gateway exists for token freshness and ownership checks, not storage:

1. A harness sends ordinary MCP initialize/list/call traffic to the generated gateway URL for one plugin/server.
2. The gateway authenticates the existing workspace/turn identity, checks current project/org membership and effective `(plugin, harness)` activation, and asks Connections to resolve the personal-or-organization connection.
3. `CapabilityHandle.getToken()` resolves or refreshes the token inside Connections. The gateway adds `Authorization: Bearer ...` only on the request to the validated canonical MCP resource and forwards the response/stream back.
4. The harness continues to own the MCP lifecycle and semantics: initialize, protocol negotiation, tools/resources/prompts discovery, `tools/call`, sessions, and Streamable HTTP handling. It does not own login UI, token persistence, owner fallback, or refresh.

For cloud runtimes, reuse `SandboxManager`'s existing `SandboxBrokeredSecret` channel to protect the short-lived gateway/runtime credential; do not create an Agent Plugins broker. The current driver capability matrix is authoritative:

| Driver | Current `secretBrokering` | Authenticated MCP consequence |
|---|---|---|
| Daytona | `native` | Provider secret placeholder/egress substitution can protect the gateway credential. |
| Vercel | `native` | Firewall header transform can attach the gateway credential. |
| Cloudflare | `proxy` | Existing Worker egress proxy can attach it when that proxy path is composed. |
| Modal, Box, Docker, Exe | `none` | Do not downgrade it to readable env/config; protected remote MCP is unavailable on that runtime in this version. |

This matrix matters: encrypted provider storage is not enough if a provider ultimately exposes the value as a readable environment variable. Public remote MCP and unauthenticated stdio still work on every compatible runtime.

The upstream access token is never provisioned to the sandbox. The sandbox broker protects only a narrow, short-lived credential for the Claxedo gateway; Connections resolves the fresh upstream token on each call. This avoids trying to update every running sandbox whenever an OAuth token rotates.

#### Existing AI-provider fanout is not the model to copy

Current AI-provider auth does not consistently use `SandboxBrokeredSecret`. `getRuntimeConfigSnapshot()` resolves eligible provider secrets into `RuntimeConfigSnapshot.auth`, `pushRuntimeConfig()` serializes them to `/api/wr/config`, and workspace-runtime turns them into harness auth/environment or auth files. The sandbox manager's own contract explicitly describes readable `env` as appropriate for model credentials the agent is trusted with, while brokered secrets are for non-model connection/deploy credentials. The private-repository clone token is the existing concrete brokered-secret call site.

Therefore MCP connection IDs must remain in the Connections namespace and out of `resolveSecretsForScope()`/`RuntimeConfigSnapshot.auth`. The MCP design reuses native/proxy sandbox brokerage where available; it does not claim that today's model-provider fanout already does so.

#### Supported authentication and identity boundary

- Public `streamable-http` servers need no Connection. Protected `streamable-http` supports the standard MCP OAuth path above.
- Fixed remote headers and stdio `env` are visible plugin data under Agent Plugins v1, not secret mechanisms. Static API keys and authenticated stdio are deferred and reported per server as unsupported.
- Legacy `sse` is optional in Agent Plugins and remains unsupported here.
- An organization connection is one admin-authorized shared upstream account/service account. It does not make each member a distinct upstream identity. Enterprise-Managed Authorization is the separate MCP mechanism for centrally managed per-member identity and remains out of scope.
- Authentication failure disables only that MCP server. Skills, sibling servers, and other plugins continue under the specification's independent failure boundaries.

### 7. Optionality is an import-graph property

A normal runtime `if` statement is insufficient. The feature flag selects composition inputs before bundling and deployment:

There is one logical Agent Plugins server module but no new workspace package. Its physical code follows the existing dependency direction:

```text
packages/claxedo-server-core/src/agent-plugins/   shared feature domain/ports; no generic barrel import
packages/claxedo-local-server/src/agent-plugins/  unsigned activation/artifacts, local Connections adapter/gateway, runtime composition
packages/claxedo-server/src/agent-plugins/        hosted activation/artifacts, hosted Connections adapter/gateway, cloud composition
packages/claxedo-app/src/features/agent-plugins/  optional UI contribution
```

This split is required by the live graph: desktop imports `@claxedo/local-server`, while `@claxedo/server` already depends on local-server. Local code must not import hosted server code and create a cycle. Shared files remain feature-owned under an explicit subpath and are not re-exported from generic `server-core` barrels.

| Artifact | Disabled profile | Enabled profile |
|---|---|---|
| Server | No import of `agent-plugins` domain | Imports and mounts module contribution |
| Routes | `/api/claxedo/plugins...` is absent | Module owns complete route family |
| Convex | Agent Plugins component not installed/deployed | Component installed in feature-enabled backend composition |
| Frontend | No catalog surface/API bundle | Loads Agent Plugins contribution |
| Workspace/VM artifact | No materializer or adapter | Includes module runtime projection contribution |
| Package/release graph | No `@claxedo/agent-extensions` | Still no public package; code remains inside server feature artifact |

The base composition may know only generic route, runtime-provisioning/reconciliation, and frontend-content contribution contracts. It must not import plugin types.

### 8. Cut over once with no legacy runtime path

The implementation changes from old to new in one cutover:

- Discard all legacy desired, lock, policy, trust, cache, and install records; do not translate them.
- Before deleting the legacy ownership code in the same implementation branch, use it only to identify and remove files it proves were generated by the old system. This cleanup is a migration step, never a runtime fallback, and is absent from the final build.
- Delete legacy Convex documents with a resumable destructive migration, verify completion on every deployment, then contract the old schema/functions.
- Drop the obsolete SQLite tables through the local schema migration.
- Delete the old package, routes, state readers, package exports, dependencies, and tests before shipping the replacement.

If an old artifact cannot be proven owned, leave it untouched and report its path; never preserve old behavior merely to continue loading it.

## Data Ownership

| State | Authoritative owner | Notes |
|---|---|---|
| Catalog source configuration | Containing product through `CatalogSourceProvider` | Outside Agent Plugins storage and API. The module receives only sources readable for the current actor. |
| Catalog candidates | Source repository, read-time only | Transient discovery data; never used by provisioning after acquisition. |
| Immutable plugin artifacts | Local durable artifact store or hosted object/artifact store | Exact validated directory bytes keyed by digest; survive source deletion. |
| Authority artifact pins | Agent Plugins metadata | Bind Claxedo/org/user/local-machine plus source-scoped plugin instance to a retained digest. |
| Claxedo defaults | Agent Plugins module global metadata | Positive `(plugin_instance, harness)` defaults referencing a valid Claxedo pin. |
| Organization defaults | Agent Plugins module org metadata | Org-admin write; positive defaults referencing an org pin. |
| Signed user all-project default | Agent Plugins module user metadata | Tri-state per `(user, organization, plugin_instance, harness)`; dynamically consulted for every project. |
| Signed user/project override | Agent Plugins module activation metadata | Tri-state per `(user, project, plugin_instance, harness)` through row absence or explicit `true`/`false`. |
| Unsigned machine override | Local Agent Plugins SQLite store | Tri-state per `(machine, plugin_instance, harness)` and applies to every local project. |
| MCP connection metadata | Existing Connections `ConnectionStorePort` backing | Stable dynamic integration ID wires the row to plugin/server; non-secret resource, issuer, scopes, status, and ownership stay in the existing connection domain. |
| MCP OAuth attempts | Existing Connections `Attempts` port | Extended only with MCP resource/issuer/scope/callback fields. Local stays ephemeral; hosted stays durable. No Agent Plugins session table. |
| Raw MCP credential material | Existing Connections `CredentialStorePort` over the encrypted credential authority | Owner-scoped access/refresh tokens use `connectionProviderId(connectionId)` and are resolved only by Connections. Pre-registered client secrets remain deployment configuration. |
| Runtime gateway credential | Existing runtime/turn identity plus `SandboxBrokeredSecret` delivery | Short-lived access to one authorized gateway path, protected by native/proxy sandbox brokerage when available; never an upstream token. |
| Hosted artifact read grant | Artifact service | Short-lived, digest-bound read for only artifacts in the authorized activation snapshot; VM verifies the digest after download. |
| Effective activation | Derived by the module per harness | May be cached with a revision, but no second writer owns it. |
| Active plugin filesystem and harness projections | Module runtime projection | Disposable generation derived from effective activation and retained artifact digests. |
| `PLUGIN_DATA` | Module runtime state | Preserved across generation swaps and VM checkpoint/restart. |

### Directional metadata model

This is conceptual naming for review, not final schema syntax.

```text
plugin_artifacts
  artifact_digest
  immutable storage location
  validated manifest/component index
  acquisition provenance: source_id, relative_path, source_revision

plugin_artifact_pins
  owner_type: claxedo | organization | user | local_machine
  owner_id
  plugin_instance_id
  artifact_digest
  source_revision

plugin_defaults
  scope: claxedo | organization
  owner_id
  plugin_instance_id
  harness_id

plugin_user_defaults
  user_id
  organization_id
  plugin_instance_id
  harness_id
  enabled: boolean

plugin_project_overrides
  user_id
  project_id
  plugin_instance_id
  harness_id
  enabled: boolean

plugin_machine_overrides (local SQLite only)
  machine_id
  plugin_instance_id
  harness_id
  enabled: boolean

existing Connections row (extended, not duplicated)
  integration_id: stable dynamic id for plugin_instance + server_name
  owner: local-machine/deployment | organization | organization+user
  granted_capabilities: includes mcp
  fields: canonical resource, exact issuer, scopes, non-secret server identity

existing Connections credential
  provider_id: connectionProviderId(connection_id)
  encrypted token envelope and expiry

existing Connections OAuth attempt (extended payload)
  integration/owner plus canonical resource, exact issuer, scopes, callback profile
  state/verifier/expiry under the existing Attempts lifecycle
```

Rows use canonical internal user/org/project IDs derived from authentication and membership. HTTP callers never choose another user's identity.

## API Surface

The exact URL spelling can be finalized with the existing server route conventions, but the semantic route family is fixed:

### Read effective catalog

```text
Signed:   GET /api/claxedo/plugins?projectId=<project>
Unsigned: GET /api/claxedo/plugins
```

In unsigned mode, omitting a project is semantic rather than shorthand: the response is the machine-wide effective catalog. Signed mode requires a project so user/project authorization remains explicit.

For every plugin, return:

```text
source-scoped plugin_instance_id, source label/path, and standard manifest metadata
candidate source revision and retained artifact digest/revision, when acquired
source available / retained artifact available / update available
supported harnesses
for each supported harness:
  default source: organization | claxedo | none
  all-projects default: true | false | absent (signed only)
  project or machine override: true | false | absent
  effective: true | false
for each MCP server:
  connection source: user | organization | local-machine | none
  status: public | ready | action-required | scope-upgrade-required | expired | unsupported
validation diagnostics
```

The response contains only valid candidates. Invalid children appear in a sibling `errors` list containing source, relative path, and a plain validation message. Member and owner views use the same validation behavior.

### Write user choices

```text
Unsigned: set or clear one machine-wide plugin/harness override.
Signed: set or clear plugin/harness overrides for selected project IDs.
Signed only: set or clear the user's dynamic all-projects plugin/harness default for the current organization.
```

The unsigned server rejects project IDs. The signed server authenticates the caller, verifies a retained artifact or acquires one from the current candidate for `true`, checks supported harness IDs and membership in every project, then commits the authorized batch atomically. A partial list containing an unauthorized project, unsupported harness, or failed acquisition writes nothing.

### Refresh candidates, explicitly update artifacts, and write organization defaults

```text
Refresh: bypass transient source-read caches and report current valid candidates/errors/update availability.
Update: acquire and validate the current candidate, atomically replace the caller authority's artifact pin, then reconcile affected effective contexts.
Default: organization admin marks or unmarks an acquired plugin default enabled for selected supported harnesses.
```

The module exposes no configure/replace/publish source operation. Source appearance and permissions come entirely from the injected provider. Refresh is a read and never updates a runtime. Update is explicit and owner-authorized. “Unmark” deletes the positive default row; there is no organization force-disable operation.

### Configure authentication

```text
Probe one plugin MCP server's authentication method.
Start/complete an owner-scoped MCP OAuth connection.
Disconnect the user/local-machine connection or, for an org admin, the organization connection.
```

The callback is bound to the existing Connections OAuth attempt rather than accepting owner/plugin/server identifiers from query parameters. Catalog endpoints read Connections summaries for readiness only; they never return raw secrets, provider IDs, authorization codes, PKCE verifiers, or gateway credentials.

### Internal projection contract

The provisioning path obtains a resolved activation snapshot from the module service rather than through a public HTTP endpoint:

```text
activation revision
user/project identity or unsigned machine identity
selected source-scoped plugin instance IDs, retained artifact digests, and harness target map
per-harness MCP gateway endpoints, Connections readiness, and sandbox brokerage requirements
short-lived hosted artifact read grants or streams bound to the selected digests
```

Gateway access uses existing workspace/turn identity and, for capable cloud drivers, the existing `SandboxBrokeredSecret` channel. It is never persisted as activation state, and no upstream token enters the snapshot.

## User Flows

### A. Unsigned local user

1. The local product supplies only the Claxedo public collection. Repo-local behavior stays with the harness.
2. The user selects supported harnesses and clicks Enable. There is no project selector.
3. If no machine pin exists, the module fetches that candidate, validates it, retains the artifact, and atomically records the pin plus machine override. If this fails, nothing activates.
4. Local state resolves Claxedo defaults plus the machine override and projects the retained artifact for every local project.
5. Disable removes the projection but retains artifact, MCP connection, and data. Re-enable therefore works offline.

Unsigned mode cannot configure personal/org collections or hosted organization connections. It may create a machine/deployment-scoped Connection in the local encrypted provider and use it through the local gateway; neither the row nor its secret synchronizes.

### B. Signed user viewing a project

1. The module authenticates the user and resolves project/org membership.
2. It asks the source provider for Claxedo plus personal/organization collections only when present, then returns valid candidates and ordinary errors.
3. For every supported harness, it resolves project override, user all-projects default, org default, then Claxedo default.
4. The UI separately shows source availability, retained artifact, update availability, inherited state, explicit state, and effective result.
5. On first Enable, the module acquires a user-owned artifact pin before writing `true`; Disable writes `false` but retains the pin.
6. Signed local hosts and cloud runtimes reconcile from the same durable effective state and retained artifacts.

### C. Apply to all current and future projects

1. For selected current projects, the server authorizes the whole batch and writes explicit project overrides atomically.
2. For “all projects, including future,” it writes one user/org/plugin/harness all-projects default instead of expanding project rows.
3. Every materialization evaluates that default dynamically. A future project needs no event or seeded row.
4. An explicit project override always wins. Changing the all-projects default immediately changes the next resolution for every project without an override; fallthrough org/Claxedo defaults still apply.

### D. Catalog refresh and explicit update

1. The containing product changes or grants sources outside this module. On catalog load, only present sources are passed in.
2. Refresh performs a fresh read. Valid plugins remain listable; invalid children appear only in `errors` with source/path/message.
3. The module compares each candidate digest with the relevant authority pin. Different bytes show **Update**; no runtime changes.
4. The authorized user/admin explicitly chooses Update. The module validates and stores a replacement artifact, atomically switches that authority's pin, then reconciles contexts inheriting that pin.
5. If the source or repository disappears, Refresh reports it unavailable, but retained plugins continue in existing and newly provisioned runtimes. Disable/re-enable also continues from the retained pin.

### E. User authenticates a remote MCP server

1. The user chooses Connect on one `streamable-http` plugin/server. No Claxedo extension is read or required.
2. Agent Plugins creates the stable dynamic integration description and delegates to the existing Connections service.
3. The MCP integration probes the endpoint, discovers protected-resource and authorization-server metadata, and selects configured pre-registration or CIMD.
4. `ConnectionsService.connectOAuth()` creates its ordinary attempt, extended with the exact resource/issuer/scopes/callback profile, and opens the authorization URL.
5. The ordinary Connections callback consumes that attempt once, validates state/issuer, exchanges the code, and writes the encrypted token through `CredentialStorePort` under the new Connection ID.
6. The catalog reads the resulting Connections summary as `ready`. Every selected harness reaches it through the transport gateway; a personal Connection takes precedence over an org Connection.

### F. VM creation

1. Project creation/opening identifies the exact authenticated user and project for the isolated VM.
2. The server resolves one per-harness activation snapshot to exact retained artifact digests.
3. The VM materializer reads those artifacts from durable storage, creates `PLUGIN_DATA`, and builds one canonical generation plus selected harness projections. It performs no catalog or Git operation.
4. For each active protected MCP server, provisioning checks the selected driver's `secretBrokering` capability and prepares the existing runtime/turn identity for the gateway. No upstream credential is resolved or sent during VM provisioning.
5. Harness adapters receive standard roots where supported or generated projection views whose protected remote MCP entries point to the gateway. On Daytona/Vercel—and Cloudflare when its proxy path is composed—the existing sandbox broker attaches the narrow gateway credential; a `none` driver reports only that server unavailable.
6. The VM becomes ready only after the projection reaches a defined success state. Independently invalid plugin components are reported but do not suppress valid components required by the Agent Plugins failure rules.

### G. Running VM reconciliation

1. An activation/default revision changes, or an explicit Update switches an effective artifact pin.
2. The module resolves a complete newer snapshot; it does not send an incremental install command.
3. The VM builds a new generation beside the active one.
4. Successful validation atomically swaps `active`; only harnesses whose effective projection changed reload/restart through their adapter contract.
5. Failure leaves the prior generation active and reports the new revision as unapplied. Broker connection state remains independently authoritative and is never rolled back with a filesystem generation.

## Implementation Units

- [ ] **Unit 1: Establish the optional feature composition boundary**

**Goal:** Make it structurally possible for server, frontend, hosted metadata, and VM builds to exclude Agent Plugins before moving behavior.

**Requirements:** R16

**Dependencies:** None

**Files:**
- Create: `packages/claxedo-server-core/src/agent-plugins/module.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/ports.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/module.ts`
- Create: `packages/claxedo-server/src/agent-plugins/module.ts`
- Create: `packages/claxedo-server/src/deployments/features/agent-plugins.ts`
- Modify: `packages/claxedo-server/src/deployments/hosted-shared/hosted-app.ts`
- Modify: `packages/claxedo-server/src/deployments/self-hosted-node/app.ts`
- Modify: `packages/claxedo-local-server/src/agent-config/routes/index.ts`
- Modify: `packages/claxedo-local-server/src/app/local-app.ts`
- Modify: `packages/claxedo-desktop/scripts/claxedo-server-entry.ts`
- Modify: `packages/claxedo-app/src/app/composition/product-contributions.ts`
- Test: `packages/claxedo-server/src/deployments/deployment-closures.test.ts`
- Test: `packages/claxedo-server/src/deployments/hosted-shared/hosted-product-contract.test.ts`
- Test: `packages/claxedo-server/src/deployments/self-hosted-node/self-hosted-product-contract.test.ts`
- Test: `packages/claxedo-app/src/architecture/local-product-boundary.guard.test.ts`

**Approach:**
- Define the smallest generic composition hooks needed for route families, runtime provisioning/reconciliation, and frontend content contributions.
- Keep all plugin types and implementations on the feature side of those hooks.
- Keep the shared domain under the explicit `server-core/src/agent-plugins` subpath, the local adapters under `local-server/src/agent-plugins`, and hosted adapters under `server/src/agent-plugins`. Do not create `@claxedo/agent-plugins` or export the feature from a generic package barrel.
- Add enabled/disabled build profiles whose selected entrypoints differ before bundling. Do not rely on a runtime environment branch or opaque dynamic import.
- Make desktop's generated local-server entrypoint select the local module at build time. The ordinary `createLocalApp` base accepts only generic contributions and does not statically import the feature.
- Keep the route family absent when no contribution is supplied; do not mount an empty handler.
- Use the existing product-contribution loader pattern for the frontend so disabled products do not statically reach the catalog implementation.
- Plan the hosted metadata store as a feature-owned Convex Component mounted only by the enabled backend deployment composition.

**Patterns to follow:**
- `packages/claxedo-app/src/app/composition/product-contributions.ts` for implementation absence from a static graph.
- `packages/claxedo-server/src/deployments/self-hosted-node/capabilities.ts` for capability contribution rather than scattered feature checks.
- `packages/claxedo-server/src/deployments/deployment-closures.test.ts` for source-closure enforcement.

**Test scenarios:**
- Disabled build: no source-closure path reaches `src/agent-plugins/`, legacy `@claxedo/agent-extensions`, or plugin UI implementation.
- Disabled build: plugin route paths are absent and return ordinary `404`.
- Disabled build: generated VM artifact dependency list contains no plugin materializer.
- Enabled build: exactly one module owns and mounts the complete route family.
- Enabled frontend: the catalog contribution is available; disabled frontend: it is absent from the emitted artifact and navigation.
- Hosted deployment: disabled profile does not install the Agent Plugins Convex Component; enabled profile does.

**Verification:**
- Product closure, emitted artifact, route inventory, and dependency-list tests independently prove “not mounted” and “not bundled/deployed.”

- [ ] **Unit 2: Add source-scoped catalog reads and durable artifact acquisition**

**Goal:** Validate standard candidates supplied by the product and make retained immutable artifacts—not repositories—the runtime content authority.

**Requirements:** R1, R2, R3, R4, R5, R6

**Dependencies:** Unit 1

**Files:**
- Create: `packages/claxedo-server-core/src/agent-plugins/catalog/types.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/catalog/validate-plugin.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/catalog/index-collection.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/catalog/resolve-collections.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/artifacts/types.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/artifacts/acquire.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/artifacts/local-store.ts`
- Create: `packages/claxedo-server/src/agent-plugins/artifacts/hosted-store.ts`
- Test: `packages/claxedo-server-core/src/agent-plugins/catalog/validate-plugin.test.ts`
- Test: `packages/claxedo-server-core/src/agent-plugins/catalog/index-collection.test.ts`
- Test: `packages/claxedo-server-core/src/agent-plugins/catalog/resolve-collections.test.ts`
- Test: `packages/claxedo-server-core/src/agent-plugins/artifacts/acquire.test.ts`
- Test: `packages/claxedo-local-server/src/agent-plugins/artifacts/local-store.test.ts`
- Test: `packages/claxedo-server/src/agent-plugins/artifacts/hosted-store.test.ts`

**Approach:**
- Vendor the published Agent Plugins v1 schemas locally; never fetch schemas during plugin loading.
- Index immediate child directories only and implement the specification's fatal manifest, component-level, server-entry, and unsupported-component boundaries.
- Resolve symlinks and every plugin-supplied path against the filesystem-resolved plugin root.
- Define `CatalogSourceProvider` as a read port supplied by composition. It returns only sources already authorized/readable for the current actor; Agent Plugins stores no repository configuration.
- Key candidates by source ID plus safe relative child path. Do not merge or compare candidates across sources based on manifest name or digest.
- Catalog reads return valid candidates and a sibling ordinary error list. Refresh bypasses transient caches but performs no durable write or reconcile.
- On first Enable/default-enable and explicit Update, reacquire and revalidate the exact child, store immutable bytes by digest, then atomically write the authority pin plus activation metadata. A failed fetch, validation, or store write leaves the old pin/activation unchanged; unpinned blobs are swept later.
- Keep acquisition provenance for diagnostics only. Runtime reads never dereference it.
- Permit internal byte deduplication by digest while preserving separate source-scoped instance IDs and authority pins.
- Do not inspect the project checkout for plugins. Repo-local standard discovery remains entirely outside this module.
- Establish the external Claxedo public collection repository as a release prerequisite and migrate current first-party entries into conforming child directories there.

**Test scenarios:**
- Valid collection: several immediate-child plugins are indexed from one commit.
- Missing/invalid child `plugin.json`: that child is reported and excluded without hiding valid siblings.
- Invalid plugin manifest: no components for that plugin are discovered.
- Invalid `mcp.json`: MCP is disabled for that plugin while valid skills remain visible.
- Escaping symlink or relative path: rejected at the narrow specification failure boundary.
- Same manifest name across two sources, whether bytes match or differ: two independent candidates; no merge/conflict computation runs.
- Missing personal/org configuration: that origin is absent rather than an error or empty placeholder collection.
- Project checkout with repo-local plugins: collection output is unchanged because the module does not scan it.
- Refresh with changed candidate bytes: reports `update_available` and does not alter pins, activations, or runtimes.
- Source deleted after Enable: retained artifact can still provision a new VM, disable/re-enable, and run while catalog reports the source unavailable.
- Explicit Update success: writes a new artifact then atomically changes only the caller authority pin; failure preserves the old artifact and pin.
- Harness-visible collision: two catalog candidates remain valid, but enabling both for one harness is rejected with a projection collision diagnostic.

**Verification:**
- Catalog output contains only conforming candidates plus explicit errors, and every enabled runtime can be recreated from retained artifact digests without reading a catalog source.

- [ ] **Unit 3: Introduce the lightweight defaults and activation authority**

**Goal:** Replace workspace installs and policy overlays with dynamic defaults and explicit overrides for unsigned and signed operation.

**Requirements:** R6, R7, R8, R9, R10, R11, R13

**Dependencies:** Units 1 and 2

**Files:**
- Create: `packages/claxedo-server-core/src/agent-plugins/activation/types.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/activation/effective.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/activation/routes.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/activation/sqlite-store.ts`
- Create: `packages/claxedo-server/src/agent-plugins/activation/routes.ts`
- Create: `convex/components/agentPlugins/convex.config.ts`
- Create: `convex/components/agentPlugins/schema.ts`
- Create: `convex/components/agentPlugins/collections.ts`
- Create: `convex/components/agentPlugins/activations.ts`
- Modify: `convex/convex.config.ts` and feature-enabled deployment composition
- Test: `packages/claxedo-server-core/src/agent-plugins/activation/effective.test.ts`
- Test: `packages/claxedo-local-server/src/agent-plugins/activation/routes.test.ts`
- Test: `packages/claxedo-local-server/src/agent-plugins/activation/sqlite-store.test.ts`
- Test: `packages/claxedo-server/src/agent-plugins/activation/routes.test.ts`
- Test: `convex/agent-plugins-v2.policy.test.ts`

**Approach:**
- Keep module-owned tables out of generic workspace authority interfaces.
- Derive signed user/org/project IDs from the authenticated request, then authorize every requested project using the existing authority before calling the component store.
- Define the finite supported-harness registry separately from activation rows. Reject unknown harness IDs at every write boundary.
- Store positive Claxedo/org `(plugin_instance, harness)` defaults, tri-state signed user all-project defaults, tri-state signed user/project overrides, and unsigned machine overrides.
- Resolve effective state per harness in one canonical pure function and reuse it for HTTP responses, local reconciliation, and VM provisioning.
- Resolve signed precedence as project override, user all-projects default, org positive default, Claxedo positive default, then false. Do not subscribe to membership creation or seed project rows.
- Every `true` choice/default must resolve to an owner pin; its mutation acquires one first when absent. `false` may retain an existing pin.
- Allow an organization default only for a plugin available from a source the containing product exposes as Claxedo or organization-owned. A member's personal candidate never becomes organization policy input.
- Keep signed durable state canonical. A signed local host may cache the last applied effective revision for recovery, but it must not become a competing writer.
- Return diagnostics for unavailable source candidates without deleting pins or dormant overrides.

**Test scenarios:**
- No defaults/override for a harness: effective disabled on that harness.
- Claxedo harness default: effective enabled there; explicit signed or machine `false` wins.
- Org harness default: effective enabled there for signed users; explicit user `false` wins.
- Explicit user `true`: enables an otherwise non-default available plugin only for the selected harness.
- Clearing override: returns to the inherited result.
- Source unavailable after acquisition: retained artifact still materializes; source availability affects only Refresh/Update.
- Signed bulk current projects and harnesses: all authorized cross-product rows commit atomically.
- Bulk request with one unauthorized project: no rows commit.
- User all-projects default: existing and future projects without explicit rows resolve it dynamically; no membership callback or project row is written.
- Changing all-projects default: the next resolution changes for every unoverridden project, while explicit project overrides stay unchanged and lower org/Claxedo defaults still apply on fallthrough.
- Signed request cannot submit another user's ID or operate outside current org/project membership.
- Unsupported harness ID: the whole mutation fails without writing rows.
- Unsigned mode accepts no project ID, writes one machine-wide override, and produces the same effective state for two different local projects.
- “All supported harnesses” expands to the current registry at write time; adding a new harness later does not create an override for it.
- Concurrent toggles: authority revision ordering yields one deterministic final override and effective revision.

**Verification:**
- Every effective `(plugin, harness)` result can be explained from at most one project/machine override, one user all-project default, positive org/Claxedo defaults, and the winning authority artifact pin; no catalog fetch or legacy state participates at runtime.

- [ ] **Unit 4: Build whole-directory materialization and harness adapters**

**Goal:** Replace per-component copying/merging and runtime replay with an atomic projection of selected standard plugin roots.

**Requirements:** R1, R6, R12, R13, R15

**Dependencies:** Units 2 and 3

**Files:**
- Create: `packages/claxedo-server-core/src/agent-plugins/runtime/harness-registry.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/runtime/generation.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/runtime/materialize.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/runtime/plugin-data.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/runtime/adapters/native.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/runtime/adapters/claude.ts`
- Create: additional adapter files only for harnesses proven not to accept standard plugin roots directly
- Test: `packages/claxedo-local-server/src/agent-plugins/runtime/materialize.test.ts`
- Test: `packages/claxedo-local-server/src/agent-plugins/runtime/generation.test.ts`
- Test: `packages/claxedo-local-server/src/agent-plugins/runtime/adapters/claude.test.ts`

**Approach:**
- Treat the resolved activation snapshot as the whole desired world for one isolated user/project runtime.
- Keep the Node filesystem projection implementation in local-server's explicit feature subpath because both desktop and `@claxedo/server` can consume it in the current dependency direction. Hosted Worker metadata entrypoints must not reach this Node-only subpath; cloud VM image assembly includes it only in the enabled profile.
- Define a deliberately small supported-harness registry. Each entry owns a stable `harness_id`, display metadata, capability flags, and exactly one projection adapter. Catalog reads and activation writes use this registry; merely detecting another harness executable does not make it supported.
- Seed the registry with only `opencode`, `claude`, `codex`, and `cursor`, matching the current `HARNESS_TARGETS` contract in `packages/agent-extensions/src/types.ts`. Expanding to another harness is a separate adapter-and-conformance change, not part of this refactor.
- Read each selected artifact by exact digest from the durable artifact store and verify its digest/validated record before projection. Never fetch a source here.
- Build a fresh generation under module-owned runtime storage, using safe links/copies that cannot escape the retained artifact root.
- Create one writable, stable `PLUGIN_DATA` directory per plugin instance and preserve it across generation swaps.
- Atomically swap the active generation only after all plugin roots and adapter views reach a valid terminal state.
- Materialize a plugin root once when any harness targets it, then invoke adapters only for its selected harness IDs. “All supported harnesses” is expanded before this stage; materialization never loops over every harness known to the wider product.
- Pass plugin directories directly to conforming harnesses. For Claude or another selected nonconforming harness, generate the smallest directory-shaped projection view; do not reintroduce an all-purpose component materializer or edit user files.
- Respect Agent Plugins independent component failure rules in adapter diagnostics.

**Test scenarios:**
- Fresh projection: selected directories appear in one generation and active points to it.
- Disable: next generation omits the plugin while preserving `PLUGIN_DATA`.
- Update: authority pin changes to a new artifact digest, plugin root changes, and data directory remains stable.
- Materialization failure: active pointer and independent MCP connection state remain unchanged.
- Stale generation cleanup: only inactive module-owned generations are removed.
- Path attack: escaping links, malformed relative paths, or active-pointer traversal are rejected.
- Native adapter: receives exact standard plugin roots.
- Claude adapter: receives a valid directory-shaped view without component-by-component writes into user config.
- Harness targeting: a plugin enabled for harness A but not B appears only in A's projection; disabling A leaves B intact; an unsupported harness cannot be projected.
- Registry growth: adding harness C does not change an existing “all supported harnesses” choice until the user/default owner explicitly selects C.
- Unsupported component: reported/skipped without preventing supported independent components.

**Verification:**
- The runtime can enable, disable, and update plugins by replacing one generation and has no `installed.json`, `lock.json`, `materialized.json`, or install-target list. The only harness targeting state is canonical activation metadata.

- [ ] **Unit 5: Extend Connections with generic MCP OAuth and a thin transport gateway**

**Goal:** Make standard OAuth-protected remote MCP servers use the existing connection/credential authority across unsigned local, signed local, and cloud runtimes, without a second broker or token store.

**Requirements:** R14, R15

**Dependencies:** Units 2 through 4

**Files:**
- Modify: `packages/claxedo-connections/src/types.ts`
- Modify: `packages/claxedo-connections/src/attempts.ts`
- Modify: `packages/claxedo-connections/src/service.ts`
- Modify: `packages/claxedo-connections/src/routes.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/mcp/discovery.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/mcp/integration.ts`
- Create: `packages/claxedo-server-core/src/agent-plugins/mcp/gateway.ts`
- Create: `packages/claxedo-local-server/src/agent-plugins/mcp/routes.ts`
- Create: `packages/claxedo-server/src/agent-plugins/mcp/routes.ts`
- Modify: `packages/claxedo-server/src/connections/index.ts`
- Modify: `packages/claxedo-server/src/connections/store-adapter.ts`
- Modify: `packages/claxedo-server/src/hosts/workgraph/hosted/connections-setup.ts`
- Modify: `packages/claxedo-server/src/authority/adapters/convex/connection-attempts.ts`
- Modify: `convex/workgraphConnections.ts`, `convex/connectionAttempts.ts`, and their schema definitions or their generalized Connections replacements
- Test: discovery/integration/gateway tests beside the files above
- Test: existing Connections service, route, hosted-partition, token-refresh, attempt, and tenant-isolation suites
- Test: `packages/claxedo-server/src/agent-plugins/mcp/inspector.e2e.test.ts` using a pinned `@modelcontextprotocol/inspector` CLI on Node 22.19+

**Approach:**
- Add `mcp` to the Connections capability contract and implement one generic dynamic `IntegrationImpl` from a retained `streamable-http` server entry. Its stable integration ID encodes the source-scoped plugin instance and server name; do not store a second binding.
- Implement MCP 2026-07-28 discovery in the adapter: parsed `WWW-Authenticate` pointer first, then path-specific and root RFC 9728 metadata; AS/OIDC discovery order; exact issuer validation; HTTPS/redirect/SSRF checks; PKCE S256; RFC 8707 `resource`; least scopes; and bounded step-up.
- Use exact-issuer pre-registration first, then the configured Claxedo CIMD profile when advertised. Do not implement deprecated DCR.
- Extend the existing Attempts payload for resource/issuer/scopes/callback profile and continue using its consume-once lifecycle. Harden the hosted adapter's verifier storage in Connections itself if required; no feature-owned OAuth-session table.
- Continue storing token envelopes through `CredentialStorePort` under `connectionProviderId(connectionId)`. Agent Plugins stores no `secure_ref`, access token, refresh token, or credential provider ID.
- Complete hosted personal/team partitions in the existing Connections backing. Ordinary member Connect writes the authenticated personal partition; the separate org-admin action writes the derived organization partition. Reuse `resolveForCapability()` so personal wins over organization.
- Keep pre-registered client secrets in deployment configuration. Never copy them to connection rows or user partitions.
- Implement a stateless gateway for exactly one upstream plugin/server. It authenticates existing workspace/turn identity, authorizes current activation/membership, calls the Connections capability handle for a live token, adds the token only to the validated canonical resource, and transparently relays MCP headers/body/stream.
- Preserve the harness as the MCP protocol owner. The gateway must not merge tools, reinterpret JSON-RPC, or create an Executor-style integration/policy catalog.
- Do not auto-replay `tools/call` after an ambiguous upstream failure. A pre-send refresh is safe; after-send retries are restricted to methods proven safe/read-only. A `403 insufficient_scope` returns an explicit reauthorization state.
- Use the current sandbox capability matrix. Daytona/Vercel use native brokered-secret delivery; Cloudflare uses its existing proxy path when composed; `none` drivers fail only the protected server closed. Never downgrade the gateway credential or upstream token into readable env/config.
- Keep MCP Connections namespaced out of `resolveSecretsForScope()` and `/api/wr/config`. Existing model-provider fanout remains a separate contract.
- Disconnect and auth failure use existing Connections removal/status methods. Membership loss, plugin disablement, or harness deselection is denied by gateway authorization even if the dormant Connection remains stored.
- Use MCP Inspector in two deliberately separate roles. First point its modern-2026-07-28 client directly at the test OAuth/MCP server to prove the fixture itself is standards-compatible. Then point Inspector at the Claxedo gateway with Inspector OAuth disabled/no Inspector token state: Claxedo Connections must already own upstream auth, and Inspector must observe an ordinary authenticated MCP server. Never pass the upstream URL or seed `~/.mcp-inspector/storage/oauth.json` in the gateway test, or the test can bypass Connections while appearing green.
- Pin Inspector's package version and isolated storage directory in CI. Run `initialize`, `tools/list`, `tools/call`, `resources/list`, and `prompts/list` with JSON output and assert its stable exit/error classes. Because Inspector CLI intentionally performs one request per process and rejects stream/session-only methods, keep a long-lived SDK client plus each real harness adapter for session headers, resumable streaming, reconnect, and mid-session behavior.

**Test scenarios:**
- Discovery: challenge pointer wins; absent pointer falls back path-specific then root; multiple issuers maintain separate registration/token state.
- Registration: exact-issuer pre-registration wins, then CIMD; DCR-only reports unsupported.
- Ownership action: member personal Connect cannot write team; non-admin team Connect is denied; admin team Connect writes org; callers cannot choose an owner ID.
- Resolution: personal wins over org, personal disconnect reveals org, membership loss denies org immediately.
- Callback: wrong/expired state, issuer mismatch, callback replay, or plugin/server substitution fails through the existing Attempts service.
- Storage: Agent Plugins rows contain no connection/credential pointer; raw OAuth values remain only in `CredentialStorePort`; namespaced records never fan out in runtime config.
- Gateway: wrong workspace/project/harness/plugin/server identity is rejected before token resolution; authenticated request reaches only the canonical resource; redirects never receive credentials without revalidation.
- Sandbox matrix: native and composed-proxy drivers keep the gateway credential out of VM env/config; `none` drivers report protected MCP unavailable while skills/public/stdIO siblings remain usable.
- Refresh: existing Connections single-flight refresh persists a rotated token and gateway requests use it without reprovisioning the VM.
- Protocol ownership: initialize, session headers, streaming, and MCP errors pass through unchanged; `tools/call` is never replayed after an ambiguous failure.
- Inspector oracle: direct-upstream modern mode succeeds with Inspector-owned OAuth; gateway mode succeeds with an empty Inspector auth store and a Claxedo-owned Connection; deleting the Claxedo Connection makes gateway mode fail auth even if the direct-upstream Inspector store still contains a valid upstream token.

**Verification:**
- End-to-end unsigned-local, signed-local, and supported-cloud-driver tests prove there is one Connection row, one Connections credential, one existing attempt lifecycle, and no upstream OAuth token in plugin state, harness config, VM files, or runtime snapshots.

- [ ] **Unit 6: Integrate effective projection into project and VM lifecycle**

**Goal:** Materialize the canonical effective set before VM readiness and reconcile running isolated runtimes from the same resolver.

**Requirements:** R6, R8, R11, R12, R13, R15

**Dependencies:** Units 3 through 5

**Files:**
- Create: `packages/claxedo-server/src/agent-plugins/runtime/provision.ts`
- Create: `packages/claxedo-server/src/agent-plugins/runtime/reconcile.ts`
- Modify: `packages/claxedo-server/src/routes/hosted/workspace.ts`
- Modify: `packages/claxedo-server/src/workspace/supervisor/index.ts`
- Modify: `packages/claxedo-server/src/workspace/supervisor/config-sync.ts`
- Modify: `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.ts`
- Modify: sandbox bundle/image composition under `packages/claxedo-server/scripts/sandbox/`
- Test: `packages/claxedo-server/src/agent-plugins/runtime/provision.integration.test.ts`
- Test: `packages/claxedo-server/src/agent-plugins/runtime/reconcile.integration.test.ts`
- Test: `packages/claxedo-local-server/src/deployments/local/embedded-workspace-runtime.test.ts`
- Test: sandbox image dependency/closure tests under `packages/claxedo-server/scripts/sandbox/tests/`

**Approach:**
- Insert a generic provisioning contribution before runtime-ready, supplied only by the enabled module.
- Resolve effective activation once for the authenticated user/project or unsigned machine, then use that snapshot for retained-artifact reads, materialization, Connections readiness, sandbox-broker requirements, and diagnostics.
- Read only exact artifact digests already pinned by the winning authority. This path has no repository URL/ref and cannot call catalog, GitHub connection selection, clone-token brokerage, or private-repository permission APIs.
- Local runtimes read the local artifact store directly. Hosted provisioning gives the VM short-lived read grants/streams for only snapshot digests; the VM verifies SHA-256 before projection. No long-lived object-store credential enters the VM.
- Stamp the applied activation revision, selected harness map, and artifact digests in module-owned runtime status, excluding gateway credentials, Connection provider IDs, and upstream credentials.
- Reconcile by sending/rebuilding a full snapshot, never per-plugin install commands.
- On signed local disconnection, retain the last applied generation. Do not interpret failed durable-store access as zero effective plugins.
- Fail VM readiness for failures that make the selected plugin root unsafe/unavailable; report specification-isolated component failures without suppressing valid independent components.

**Test scenarios:**
- Cloud VM: active plugins from Claxedo/personal/org authorities materialize from exact retained digests before ready.
- Signed local runtime: durable user/project choice produces the same effective plugin names as cloud.
- Unsigned local runtime: the same machine/harness choice applies when two different projects are opened; neither provisioning request carries a local project activation identity.
- Signed user identity missing/mismatched: provisioning refuses before reading artifacts or preparing gateway access.
- Source repository deleted: new and running VMs still materialize from retained artifacts.
- Retained artifact missing/corrupt: new VM reports a precise integrity failure; running VM keeps its previous generation and no source fallback runs.
- Artifact delivery: an expired grant, wrong digest, or digest mismatch fails before projection; a grant for project/runtime A cannot fetch any digest outside its authorized snapshot or be reused by runtime B.
- MCP boundary: a capable sandbox receives only brokered access to the short-lived gateway credential, never the upstream OAuth value; repository, status, checkpoint, env, and harness config inspection expose neither.
- Reconcile success: newer revision atomically becomes active and harness adapter reload occurs once.
- Reconcile failure: prior revision remains active and retry can later apply the same desired revision.
- Stale/out-of-order update: older activation revision cannot replace a newer active generation.
- Module disabled: none of the provisioning/reconcile calls or VM dependencies exist.

**Verification:**
- Real public entrypoint tests show a user toggle reaches the authoritative store, a newly created VM, and a running VM through one effective resolver and one materializer.

- [ ] **Unit 7: Replace the install marketplace with the Plugin Catalog activation UI**

**Goal:** Expose the simplified vocabulary and multiplayer choices without retaining install-oriented client behavior.

**Requirements:** R5 through R9, R14, R16

**Dependencies:** Units 1, 3, 5, and 6

**Files:**
- Move/replace: `packages/claxedo-app/src/features/extensions/` -> `packages/claxedo-app/src/features/agent-plugins/`
- Modify: `packages/claxedo-app/src/app/integrations/first-party-content-surfaces.tsx`
- Modify: `packages/claxedo-app/src/app/composition/product-contributions.ts`
- Modify: `packages/claxedo-app/src/platform/identity/route.ts`
- Modify: `packages/claxedo-app/src/features/session/ui/dialogs/select-mcp.tsx`
- Modify: `packages/claxedo-app/src/features/session/app-ports.ts`
- Test: `packages/claxedo-app/src/features/agent-plugins/catalog-api.test.ts`
- Test: `packages/claxedo-app/src/features/agent-plugins/catalog-panel.ui.vitest.tsx`
- Test: `packages/claxedo-app/src/features/session/ui/dialogs/select-mcp.test.tsx`
- Test: relevant app contribution and emitted-artifact architecture tests

**Approach:**
- Rename the surface from extension marketplace/install state to Plugin Catalog/activation state.
- Show the Claxedo collection always. Add personal and organization collection sections only when the source provider returns them; do not render empty placeholder sections.
- Render source-scoped identity, source/retained/update state, validation errors, supported harnesses, per-harness inherited default, user all-projects default, project override, effective result, and MCP connection readiness.
- In unsigned mode, the harness toggle is labeled machine-wide and there is no project selector. In signed mode, the primary toggle applies to the current project/harness; secondary actions apply it to selected/all current projects or set the dynamic all-projects default.
- Provide a way to clear an explicit override and return to inherited behavior.
- Do not render collection configuration controls; source management belongs to the containing product. Make org default and org-shared connection controls visible only to authenticated org admins.
- Replace MCP “Install/Uninstall” with Connect/Reconnect/Disconnect. Explain whether the effective connection is local-machine, personal, or organization-shared without showing identifiers or credential metadata.
- Model loading, empty Claxedo collection, optional-source absent, source unavailable, refresh pending/failed, update available/pending/failed, activation applying/failed, signed control-plane disconnected, OAuth pending/expired/scope-upgrade, and unsupported-auth states explicitly. A failed source read never hides retained/effective state.
- Reuse the app's existing focus, keyboard, screen-reader status, and responsive dialog patterns for harness and project multi-selection; no new interaction framework is introduced.
- Load the entire UI/API implementation as an optional product contribution selected by the build profile.

**Test scenarios:**
- Unsigned view shows only Claxedo collection plugins, selects explicit supported harnesses, and persists one machine-wide choice.
- Signed member view adds personal/org sections only when present and explains org/Claxedo default, user all-projects default, and project override.
- Default-enabled plugin toggled off writes explicit `false`; “Use default” clears it.
- Multi-project selector submits exact project IDs; “all projects, including future” writes one dynamic user default independently.
- “All supported harnesses” expands visibly to the current supported set; a newly supported harness is not silently selected.
- Invalid child appears in the ordinary error list; valid same-name candidates from different sources remain independently selectable. A harness projection collision is reported only when the conflicting combination is enabled.
- OAuth-required MCP shows Connect without exposing credential metadata; a user connection, org fallback, scope upgrade, expiry, and unsupported auth each have distinct states.
- Refresh/Update/apply failure leaves retained and effective state visible; loading or disconnected state never renders as zero plugins.
- Disabled build has no navigation item, route surface, feature chunk, or session MCP plugin actions.

**Verification:**
- No user-facing source, test, API helper, or telemetry event uses install/uninstall terminology. `Update` is reserved for explicit artifact replacement; `Refresh` is reserved for read-only source comparison.

## Implementation quality contract

Passing end-to-end tests is necessary but does not establish that the replacement is good code. Every implementation unit must also satisfy these design constraints before the cutover unit begins.

### One owner and one direction

- Each concept has one canonical owner: collection indexing, retained artifacts, activation persistence, effective resolution, materialization, harness projection, and MCP connection/gateway integration. No second helper may independently implement the same rule for local, hosted, UI, or runtime code.
- `claxedo-server-core` owns dependency-free contracts and deterministic domain behavior only. Local SQLite/filesystem and hosted Convex/object-store implementations depend inward on those contracts. Core never imports either adapter.
- Agent Plugins may consume the public Connections API and generic provisioning/composition ports. Generic Connections, workspace, supervisor, and runtime packages do not gain Agent-Plugin-specific tables, methods, fields, or fallback branches.
- The dependency chain remains source -> validated candidate -> immutable retained artifact -> activation pin -> effective snapshot -> atomic runtime generation -> harness projection. Runtime code cannot walk backward to a collection or repository.
- Shared code is extracted only when it expresses one of these real concepts. Similar-looking local and hosted orchestration remains separate when their transaction, authorization, or failure semantics differ.

Architecture tests enforce these directions through forbidden imports, one-writer/route ownership inventories, and exact source closures. Review must reject a change that passes by adding an exception, barrel re-export, service locator, opaque dynamic import, or generic callback that hides the same dependency.

### Explicit state and failure contracts

- Effective activation is a pure deterministic function of a versioned input snapshot. It performs no I/O, reads no clock/environment/global state, and returns the winning authority plus reason for every harness result.
- State transitions are named operations with typed inputs/results. Boolean success values, catch-all `unknown` records, silent coercion, and “missing means empty” behavior are not accepted at authority boundaries.
- Retained artifacts are immutable and content-addressed. Only explicit Update changes an authority pin; Refresh cannot mutate it.
- Materialization builds beside the active generation and changes one active pointer only after validation succeeds. A failed or stale reconcile cannot partially alter the live generation.
- Every durable mutation is authorized and revisioned at its owner. Retries are idempotent; concurrent stale writes fail explicitly rather than using last-write-wins accidentally.
- Source unavailable, authority unavailable, invalid plugin, artifact unavailable, unsupported harness, connection required, authentication failed, and materialization failed remain distinct typed outcomes. None is converted to an empty catalog or disabled plugin set.
- Credentials are referenced by Connections identity and resolved only at the gateway/broker boundary. Plugin metadata, activation rows, runtime snapshots, logs, diagnostics, and harness config cannot accept a raw secret-shaped field.

Tests assert these invariants directly, including concurrency and fault injection; they do not infer them only from a successful UI flow.

### Narrow and testable APIs

- Domain operations accept the smallest value objects they require, not application service bags, Hono/Convex request objects, sandbox handles, or broad environment objects.
- Adapters translate at their boundary and return domain results. They do not leak SQLite rows, Convex document shapes, HTTP responses, GitHub payloads, or sandbox-provider SDK types into core behavior.
- Public exports are allowlisted. Internal files are not re-exported for test convenience, and tests do not make production internals public.
- Harness adapters receive only a verified plugin root, plugin-data root, and explicit harness capabilities. They cannot fetch sources, choose activation, resolve credentials, or merge arbitrary user configuration.
- Errors carry stable codes and safe context; secret values and provider payloads are retained only at the existing Connections authority.

Each public operation gets contract tests at its owner. Local and hosted adapters run the same store/resolver conformance suites, while adapter-specific tests cover their actual transaction and persistence behavior.

### Test integrity

- Tests call the real public entrypoint for the layer they claim to verify. A route test mounts the real module route; a provisioning test crosses the actual supervisor contribution; a materialization test inspects the resulting filesystem generation; an MCP test speaks the protocol through the gateway.
- Mocks stop only at genuine external boundaries: Git transport, object storage, OAuth issuer, sandbox provider, or clock/randomness. Tests may not mock the resolver, store, materializer, gateway, or route under test.
- Assertions cover durable state and externally visible effects, not private call order. Where ordering is the contract—credential write ordering or atomic generation swap—the test injects a failure at each boundary and inspects recoverable state.
- Every clean scanner/closure assertion has a positive control and scan-health assertion. Every critical resolver/security invariant has a negative or mutation-style test demonstrating that the test fails when precedence, tenant, digest, revision, or capability checks are removed.
- Test data uses valid standard-shaped plugin directories and real parsers. Minimal malformed fixtures each violate one named rule; no giant fixture ambiguously exercises many failures.
- Flaky timing is not accepted: concurrency/retry tests use controlled barriers, clocks, and deterministic revisions rather than sleeps.

### Reviewable implementation slices

- Implement in vertical, independently verifiable slices: contract and invariant -> one canonical implementation -> real adapter -> public entrypoint -> failure tests. Do not build all models first and defer integration until the end.
- Before adding a new abstraction, search callers and existing owners. Reuse a canonical generic mechanism such as Connections or provisioning contributions; do not wrap it in a plugin-specific imitation.
- Every slice deletes any path it replaces. There are no temporary dual readers/writers, compatibility aliases, fallback events, legacy DTOs, or TODO-based cleanup left for Unit 8.
- A slice is complete only after focused tests, typecheck, lint, affected product build, closure measurement, and repository search pass. Closure growth must name the newly reachable modules and dependency chain; only the exact measured ceiling may be recorded.
- Review the final diff by responsibility, not directory: for each invariant, identify its sole producer, consumers, persistent representation, authorization point, failure behavior, and tests. If two answers exist for any producer or writer, the slice is not complete.

- [ ] **Unit 8: Clean legacy artifacts and delete Agent Extensions end-to-end**

**Goal:** Finish the migration with one implementation per responsibility and prove the old package is absent.

**Requirements:** R17 and completion of all earlier requirements

**Dependencies:** Units 1 through 7 complete and verified on the replacement path

**Files:**
- Delete: `packages/agent-extensions/`
- Delete: `packages/claxedo-local-server/src/hosts/agent-extensions/`
- Delete: `packages/claxedo-local-server/src/agent-config/routes/extension-routes.ts`
- Delete: `packages/claxedo-local-server/src/agent-config/extension-support.ts`
- Delete: `packages/claxedo-local-server/src/agent-config/extensions/`
- Delete: `packages/claxedo-server-core/src/hosts/agent-extensions/`
- Delete: `packages/claxedo-server-core/src/agent-config/extensions/catalog.ts`
- Delete/replace: `convex/agentExtensions.ts`, `convex/agentExtensionPolicies.ts`, and legacy schema tables
- Modify: `packages/claxedo-server-core/src/agent-config/index.ts`
- Modify: `packages/workspace-runtime/src/routes/config.ts`
- Modify: `packages/workspace-runtime/src/workspace/runtime.ts`
- Modify: `packages/claxedo-server-core/src/authority/control-plane-contract.ts`
- Modify: `packages/claxedo-server-core/src/platform/auth/authority.ts`
- Modify: `packages/claxedo-server-core/src/workspace/supervisor-port.ts`
- Modify: package manifests for `claxedo-server`, `claxedo-server-core`, `claxedo-local-server`, and `workspace-runtime`
- Modify: root/package release and sandbox scripts that publish, smoke, or pin `@claxedo/agent-extensions`
- Modify: route/product inventories, architecture ownership maps, docs, and generated API types
- Create: cutover-only owned-artifact cleanup and its tests; remove that cleanup implementation before the final production artifact is built
- Modify: `convex/migrations.ts` for resumable legacy document deletion before schema contraction
- Test: `packages/claxedo-server/src/deployments/deployment-closures.test.ts`
- Test: `packages/claxedo-server/src/tests/governance/codebase-shape.test.ts`
- Create: `packages/claxedo-server/src/tests/governance/agent-extensions-retirement.test.ts`
- Test: `convex/migrations-discipline.policy.test.ts`

**Approach:**
- Use the existing legacy ownership record during the cutover branch to remove only paths marked as applied and owned; never broadly delete user directories or harness configuration.
- Do not translate legacy desired/lock rows into new activations.
- Use expand-migrate-contract for Convex schema safety, but treat the operation as destructive replacement: resumably delete every legacy document, verify completion everywhere, then remove old functions/schema. No code reads both models.
- Drop obsolete local SQLite tables; do not leave them as dormant compatibility storage.
- Remove extension-specific methods/types from generic authorities and supervisor ports rather than leaving optional no-op members.
- Remove `agent_extensions` from generic runtime config validation and persistence.
- Move non-plugin hook/document-agent behavior to its canonical runtime/harness owner or delete it if unused.
- Delete old tests rather than rewriting them around the new result; add new tests at the new owners.
- Remove public-package publishing and smoke coverage because the package no longer exists.
- Search for stale vocabulary, paths, imports, routes, environment flags, telemetry events, and package names before completion.
- Add a dedicated retirement ratchet to `test:architecture-ratchets`; it scans tracked source, tests, package manifests/lockfiles, generated API output, and emitted artifacts. It is not a best-effort grep run by a reviewer.
- Give the retirement ratchet positive controls and scan-health assertions. Synthetic legacy files/imports/routes/schema keys/state paths must be detected, every expected repository/product root must be visited, and unresolved or opaque import edges fail the test. An empty or accidentally narrowed scan cannot report success.
- Keep a closed deletion manifest for the legacy package/directories/files and a zero-allowlist retired-token manifest for executable/test/generated/package code. The detector may construct retired tokens from split literals so it does not exempt its own source. Historical prose may describe the migration, but no legacy implementation, fixture, helper, compatibility type, or executable test remains.
- Add semantic retirement tests, not only name checks: final runtime config rejects `agent_extensions`; final route and schema inventories exclude the old API/functions/tables; and poison legacy files/database rows cannot cause reads, writes, copying, execution, activation, or materialization.
- Assert one replacement owner for each responsibility: one activation writer, one effective resolver, one retained-artifact authority, one materializer, and one route owner. The plugin materializer's import closure cannot reach source discovery, repository fetching, private-repository authorization, or credential storage.

**Test scenarios:**
- Legacy cleanup removes a symlink/config entry only when the ledger proves ownership.
- Legacy cleanup preserves unmanaged conflicting user files and reports them.
- Cleanup is idempotent across restart/retry.
- Legacy Convex deletion migration is resumable and verified before table contraction.
- Existing SQLite database upgrades by dropping the old extension tables and starts with only the new module-owned schema when the feature is enabled.
- Repository search finds no production import of `@claxedo/agent-extensions`, old route prefix, old state files, or legacy policy types.
- Repository-wide retirement ratchet finds no old package dependency/script/bin, source or test module, runtime-config key, route, schema/function/table, state filename, telemetry event, environment flag, UI vocabulary, generated API symbol, emitted chunk, source-map reference, or copied package artifact.
- Positive controls prove each retirement detector fails on a synthetic reintroduced file, dependency, import, route, runtime key, schema key, and state path; scan-health assertions prove all required roots and real entry graphs were inspected.
- Poison-state tests start the final local/server/runtime entrypoints with legacy `.agent-extensions`, `installed.json`, `lock.json`, `materialized.json`, legacy SQLite rows, and a legacy runtime payload containing a sentinel plugin. The final system rejects or ignores the input as specified, never reads plugin payload bytes, never executes/copies the sentinel, never creates replacement activation, and leaves no legacy table after the destructive upgrade.
- Closed route inventories contain only the new module routes in enabled builds and no plugin routes in disabled builds. Behavioral route-posture tests make requests to both the old prefix and the new routes so a renamed or accidentally remounted handler cannot hide behind a string scan.
- Closed Convex/local schema and generated-API inventories contain only the new module stores/functions. No legacy migration, dual reader, table alias, fallback decoder, or cleanup function is present in the final build.
- Source-closure tests prove the runtime materializer cannot reach catalog/source/Git/credential-store code; exact module and package ceilings are lowered to the measured post-cutover values with no headroom.
- Enabled and disabled production builds are scanned after emission. The disabled artifact contains no Agent Plugins route, frontend chunk, backend component, materializer, dependency, or token; the enabled artifact contains exactly one route owner and one materializer path.
- Every disabled production entry's source and emitted package closure excludes the new module.
- Every enabled production entry mounts one route owner and includes one materializer path.

**Verification:**
- The old package, lifecycle, runtime snapshot, database authorities, routes, UI vocabulary, release entries, and build dependencies are gone. There is no backward-compatible reader, alias, fallback, dormant table, old-flow fixture, or migration code in the final tree/artifacts. All relevant product verification and architecture ratchets pass through public entrypoints.

### Unit 8 quality and proof gates

The hard cutover is mergeable only when all four gates pass. A repository search alone is insufficient.

1. **Structural death:** the deletion and retired-token manifests prove the old files, package identity, dependencies, scripts, bins, symbols, paths, state keys, schema names, and generated/emitted references are absent. The manifests have no baseline and no per-file waiver.
2. **Behavioral death:** poison legacy state is presented to real startup/config/provisioning entrypoints. The system must not translate, adopt, repair, replay, materialize, or execute it. Old HTTP paths are exercised and remain unowned; old runtime payloads are rejected rather than silently accepted.
3. **Single replacement path:** closed route/schema inventories, single-writer tests, and import-closure tests prove that activation and materialization have exactly one owner and that catalog/source acquisition cannot leak into runtime provisioning.
4. **Artifact death:** both build profiles are built, their manifests/chunks/source maps/package contents are scanned, and deployment entry closures are measured exactly. Source deletion does not count if compiled or copied legacy code still ships.

Quality is held at the replacement owners rather than with a broad end-stage coverage number:

- Effective resolution uses table-driven and property tests for authority precedence, per-harness selection, explicit `false`, cleared overrides, dynamic all-future-project defaults, and local machine-wide semantics.
- Local and hosted activation stores run the same conformance suite, including authorization, tenant isolation, revision compare-and-swap, concurrent toggles, retries, and persistence/restart.
- Artifact acquisition/materialization tests cover byte validation, exact digest pinning, path traversal/symlink rejection, atomic generation swap, crash/fault injection at every write boundary, rollback preservation, and source disappearance after acquisition.
- Module composition tests build enabled and disabled profiles through real product entrypoints; optionality is verified in source closure, route inventory, frontend chunks, backend deployment output, VM image/package closure, and runtime behavior.
- MCP tests cover Connections ownership/visibility, personal-versus-org selection, OAuth discovery/refresh/revocation, gateway authorization, sandbox secret-brokering capability, redaction, tenant isolation, and MCP Inspector protocol/tool calls from a provisioned runtime.
- Every bug found during implementation receives a failing test at the canonical owner before the fix. Tests may not mock away the route, store, provisioning, materialization, or gateway boundary whose behavior they claim to verify.

The final gate runs focused package tests first, then repository-wide checks: `bun run lint`, `bun run typecheck`, affected package tests/builds, every affected product's `verify:closure`, `bun run test:architecture-ratchets`, enabled/disabled emitted-artifact inspection, and end-to-end local plus cloud-VM provisioning/MCP tests. Any intentional production import change must first explain its dependency chain, then record only the exact measured closure with no headroom.

## Phased Delivery

### Phase 1 — Create the boundary and new path

- Land Unit 1 first so all new work is born behind an enforceable optional composition.
- Land source-scoped indexing, durable artifact acquisition, and activation authority without routing production users to it.
- Establish the Claxedo public collection repository and validate all initial plugins before cutover.

### Phase 2 — Complete and verify the replacement path

- Land whole-directory materialization, MCP connections, VM provisioning, and the new UI behind the enabled profile.
- Exercise signed local and cloud parity through only the replacement entrypoints. Do not add dual-read or dual-write behavior.

### Phase 3 — Destructive cleanup and hard cutover

- Run cutover-only cleanup for proven old owned artifacts and delete legacy durable/local state without translation.
- Switch the enabled product to the new route/UI/runtime path in the same release boundary.
- Delete the cleanup implementation, legacy package, and every legacy compatibility surface before producing the final artifact.
- Lower architecture closure ceilings to the new measured values; do not leave headroom.

### Phase 4 — Prove optional deployment

- Build and inspect both enabled and disabled server/frontend/VM artifacts.
- Deploy the disabled profile to a test environment and prove the route/backend/component/materializer are absent rather than returning empty data.
- Deploy the enabled profile and prove catalog -> override -> VM activation -> MCP auth through real entrypoints.

## System-Wide Impact

- **Interaction graph:** User toggles flow through the module's route, canonical activation store, effective resolver, runtime provisioning/reconcile contribution, active generation, and harness adapter. Generic agent config no longer participates.
- **Authorization:** Signed project reads/writes reuse project membership; source authorization remains outside the module; org default/team-Connection writes require org admin; the MCP gateway re-checks existing workspace/turn identity, Connection visibility, membership, and effective harness activation.
- **State lifecycle:** Catalog candidates are transient; retained artifacts and pins are durable; defaults resolve dynamically; overrides are durable; runtime generations are disposable; plugin data persists independently.
- **Failure propagation:** Catalog validation errors are simple source/path errors; auth diagnostics are per server. Source loss cannot break retained plugins. Artifact integrity failure blocks a new projection; failed reconcile preserves the old active generation. Store/network failure is never converted to an empty set.
- **Deployment:** Server, Worker backend component, frontend feature chunk, and VM materializer must use the same build profile. A mixed profile is a build error, not a runtime partial feature.
- **API parity:** Unsigned local and signed hosted APIs expose the same catalog/effective semantics while using different authorities. The server derives identity in both cases.
- **Runtime identity:** Signed provisioning must carry authenticated user plus project; unsigned local provisioning must carry its canonical machine identity. Any caller missing the identity required by its mode must be corrected at the authoritative producer rather than synthesizing one.
- **Observability:** Record source-read outcome, candidate revision, authority artifact digest, activation revision, materialization outcome, plugin/server diagnostic codes, and non-sensitive Connection IDs only. Never record OAuth tokens, codes, verifiers, gateway credentials, or credential provider IDs.
- **Unchanged invariants:** Project/workspace authorization, encrypted secret backends, and harness process ownership remain canonical in their existing domains. Private-Git and clone-secret authorities are intentionally not on this feature's path.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Signed user/project activation reaches a VM that is not actually user-isolated | Make signed user identity mandatory in that provisioning contract and fail before materialization if it is absent or inconsistent. |
| A source disappears or later requires credentials | Mark only the source read unavailable. Retained artifacts continue provisioning and running; Update remains unavailable until the source returns. |
| MCP credentials cross tenants or reach inactive plugins | Keep owner/resource/issuer on the existing Connection, derive plugin/server from its stable integration ID, authorize every gateway call, and resolve only the visible personal-or-org row. |
| A plugin update changes an MCP endpoint but reuses old auth | Bind the connection to canonical resource URI and exact issuer; endpoint or transport drift forces a new connection. |
| Malicious OAuth metadata redirects the integration/gateway to an internal or attacker-controlled service | Validate HTTPS origins, discovery relationships, exact issuer, redirects, and resolved network targets before sending codes, tokens, or authenticated requests. |
| Org/Claxedo default change surprises users | Expose inherited source and explicit override separately; user `false` always wins. |
| Two source-scoped plugins map to the same harness-visible identity | Keep both catalog entries valid; reject only the conflicting effective projection until the user changes harness selection. |
| Source bytes change between catalog read and Enable/Update | Acquisition re-fetches, validates, computes the actual digest, and shows the acquired version. Runtime never trusts the earlier catalog read. |
| Retained artifact is deleted too early | Garbage collection must trace all authority pins, active/checkpointed runtime references, and rollback retention. No user Disable triggers artifact deletion. |
| Hosted artifact delivery leaks broad object-store access or accepts corrupt bytes | Issue only short-lived runtime/digest-bound reads and verify the content digest before projection; never put a bucket credential in the VM. |
| Connection credential write partially succeeds | Preserve the existing Connections write ordering and idempotent owner/integration upsert; test recovery so a row never reports connected unless its `connectionProviderId` credential resolves. |
| Failed reconcile disables everything | Build beside active and atomically swap only on success; unavailable authority preserves last applied revision. |
| Legacy generated artifacts remain loaded after package deletion | During the cutover branch, use the old ownership ledger once to remove proven generated paths; delete that migration code before building the final artifact and report unproven leftovers instead of loading them. |
| Convex schema contraction loses data or blocks deploy | Follow expand-migrate-contract and verify the migration ledger on every deployment before deleting old tables/functions. |
| Convex Components are a beta API | Keep the component boundary narrow, pin the current Convex version, and enforce enabled/disabled deployment integration tests. If the component cannot be build-selected reliably, treat that as a blocker rather than silently deploying feature code in the disabled profile. |
| Optional feature leaks through a type-only or dynamic import | Source-closure, emitted-artifact, route-inventory, dependency-list, and frontend chunk tests cover different leakage classes. |
| Per-harness projection grows back into the old materializer | Adapters may only consume a standard plugin root and emit an isolated view; no adapter may own source fetching, activation, durable policy, or user-config merging. |

## Success Criteria

- A conforming plugin directory from the Claxedo collection can be enabled machine-wide for one or more explicitly selected supported harnesses and appears only in those harness projections for every local project.
- A signed user can enable/disable different plugin sets for two projects and observe identical effective results in local and cloud runtimes.
- A signed user sees personal and organization collections only when the containing product supplies them; this module has no collection configuration API.
- An org admin can default-enable a plugin for selected supported harnesses; a member can disable it for one project/harness.
- “All current projects” writes explicit choices; “all projects, including future” writes one dynamic user default read by every project without an explicit override.
- After first Enable, deleting the source repository does not prevent new VM provisioning, disable/re-enable, or continued execution. Refresh reports source loss; explicit Update remains unavailable.
- Refresh with newer candidate bytes only shows Update. Only an explicit authorized Update replaces the authority pin and reconciles affected runtimes.
- A user- or org-owned OAuth-protected MCP server uses the same Connections authority in signed local and supported cloud drivers through the hosted gateway; unsigned OAuth uses local Connections and the local gateway. No upstream token enters Git, Agent Plugins metadata, harness config, VM files, or persisted snapshots; a `secretBrokering: none` cloud driver reports only that protected server unsupported.
- A runtime materialization failure preserves the last working generation.
- The Agent Plugins-disabled build contains no server routes, Convex component, frontend catalog surface, VM materializer, or legacy/new package dependency.
- `packages/agent-extensions`, old route/state/policy code, public package release entries, and install vocabulary are absent from production code.
- Architecture ratchets pass with exact new closure measurements.

## Documentation and Operational Notes

- Replace package documentation with one server feature document covering public collection layout, per-harness activation semantics, MCP OAuth connections, build profiles, and runtime paths.
- Publish the Claxedo collection contribution workflow separately from product activation docs; source provisioning/configuration remains a containing-product concern.
- Document that disabling the new module removes all executable/mounted behavior and does not interpret legacy Agent Extensions state. The flag itself does not erase new feature metadata; permanent data deletion is a separate explicit decommissioning operation.
- Update product/help copy from “Agent Extensions” and “Install” to “Agent Plugins,” “Catalog,” “Default enabled,” “Enabled for this project,” and “Use default.”
- Operational dashboards should distinguish source reads, artifact acquisition/update, effective resolution, artifact retrieval/integrity, materialization, harness reload, and MCP authentication failures.

## Deferred Implementation Details

- Final route names and TypeScript symbol names may adjust to adjacent conventions, but the semantic operations and single route owner may not change.
- Static API-key/header auth and authenticated stdio may be reconsidered only after the standard defines a portable secret reference or a separate product requirement justifies a Claxedo client extension. They are not part of this refactor.
- MCP Enterprise-Managed Authorization is a separate future capability for per-member enterprise identities and centrally managed IdP policy. This plan's organization connection is deliberately one shared upstream account, not an EMA approximation.
- The exact VM readiness classification for a plugin whose skills are valid but one MCP server cannot authenticate should follow the standard's independent failure boundary: the VM may become ready with the server reported failed, while unsafe/unavailable plugin roots remain provisioning failures.
- The enabled Convex deployment assembly mechanism should be selected during Unit 1 based on reproducible generated-artifact inspection. The acceptance criterion is fixed: disabled deployment does not contain the component.

## Sources and References

- Agent Plugins Specification v1.0.0: https://agent-plugins.org/specification
- MCP Authorization 2026-07-28: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
- MCP Authorization Server Discovery: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/authorization-server-discovery
- MCP Client Registration: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
- MCP Inspector: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector
- MCP Inspector CLI: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/cli
- MCP Inspector Authorization: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/authorization
- MCP Inspector Protocol Eras: https://modelcontextprotocol.io/docs/2026-07-28/tools/inspector/protocol-eras
- MCP Authorization Security Considerations: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations
- MCP Enterprise-Managed Authorization: https://modelcontextprotocol.io/extensions/auth/enterprise-managed-authorization
- Executor Connections: https://executor.sh/docs/concepts/connections
- Executor MCP Proxy: https://executor.sh/docs/mcp-proxy
- Executor connection model source (researched at `fff7ed6`): https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/core/sdk/src/connection.ts
- Executor credential resolution/refresh source (researched at `fff7ed6`): https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/core/sdk/src/executor.ts
- Executor MCP connection source (researched at `fff7ed6`): https://github.com/UsefulSoftwareCo/executor/blob/fff7ed68553c9d249966103b74c7ed4218fe45b1/packages/plugins/mcp/src/sdk/connection.ts
- Convex Components: https://docs.convex.dev/components/using
- `packages/agent-extensions/docs/architecture.md`
- `packages/agent-extensions/src/index.ts`
- `packages/claxedo-local-server/src/agent-config/routes/extension-routes.ts`
- `packages/claxedo-server-core/src/agent-config/index.ts`
- `packages/workspace-runtime/src/workspace/runtime.ts`
- `packages/claxedo-server/src/hosts/workgraph/hosted/connections-setup.ts`
- `packages/claxedo-server/src/workspace/repository-clone.ts`
- `packages/claxedo-server-core/src/credentials/types.ts`
- `packages/claxedo-app/src/app/composition/product-contributions.ts`
- `packages/claxedo-server/src/deployments/deployment-closures.test.ts`
- `docs/tech-docs/convex-schema-evolution.md`
- `docs/plans/2026-07-09-001-refactor-host-owned-runtime-state-plan.md`
- `docs/plans/2026-08-02-004-refactor-platform-and-domains-plan.md`
