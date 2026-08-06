# Portable Claxedo Apps Platform

Date: 2026-08-06. Status: proposed architecture.

## 1. Executive summary

Claxedo Apps is a general platform for AI-authored and developer-authored
mini-apps. It supports the complete Cloudflare OS product model:

- private personal gadgets;
- shared collaborative gadget instances;
- blueprints that copy code into independent instances;
- sandboxed UI and server execution;
- capability-based external integrations and staged approval.

It also adds the distribution and authorization modes needed for a broader app
platform:

- publisher-maintained apps with one private instance per customer;
- public static applications and sites;
- portable provider bindings for source, build, deployment, identity, storage,
  assets, jobs, and connectors.

These are not separate runtime implementations. They are presets composed from
three independent runtime policies:

```text
instance scope
data authority
distribution method
```

For example:

```text
Cloudflare OS-style personal gadget
  = owner instance + instance SQLite + private distribution

Cloudflare OS-style collaboration
  = workspace instance + symmetric SQLite + instance sharing

Blueprint
  = release snapshot + new instance + fresh storage

Managed consumer app
  = release channel + user instance + private storage + managed installation

Public site
  = immutable release + public delivery + static/public data
```

Claxedo owns the AI chat, agent execution, identity, app registry, navigation,
sharing, and provider contracts. Mini-app UI runs in an opaque sandboxed iframe.
Server code can run in Cloudflare Dynamic Worker Facets or another provider
profile. External systems are reached only through Gatekeeper-style connector
capabilities. Team apps either share one symmetric instance or operate on a
shared external system through Gatekeepers.

Source collaboration is a separate Git workflow. GitHub, GitLab, or another
source provider decides who can edit, review, version, build, and deploy code.
Claxedo Apps consumes immutable releases and does not reproduce source-editor
roles in runtime sharing.

The Content Engine is one reference application of this platform: a managed,
user-scoped app with private persistence, browser capture skills, and personal
scheduler connections. It is not the boundary of the platform.

## 2. Problem statement

Claxedo is an agentic IDE with hosted identity, organizations, workspaces,
sessions, billing, skills, connections, and a desktop browser. It can help a
user create software, but it does not yet turn generated software into a
first-class product object that can be installed, opened from navigation,
persisted, updated, shared, published, or moved across infrastructure.

Cloudflare OS demonstrates a strong baseline:

- a trusted workspace coordinator stores code and app metadata;
- Dynamic Workers execute code supplied at runtime;
- Facets provide persistent isolated SQLite instances;
- opaque-origin iframes communicate over host-provided RPC;
- Gatekeepers provide narrow access to external resources;
- gadget instances can be shared for symmetric collaboration;
- blueprints copy code without copying storage or credentials.

That baseline leaves one common application form outside its central model: one
publisher maintains an app used privately by many customers.

Claxedo needs one architecture that preserves the Cloudflare OS modes, adds
these missing forms, reuses Claxedo's own AI and tenancy, and remains portable
across deployment providers.

## 3. Goals

### Product goals

- **G1 — Complete app taxonomy.** Support private, collaborative, blueprint,
  managed user-scoped, external-data, and public apps.
- **G2 — First-class Claxedo objects.** Apps have durable identities, releases,
  instances, navigation entries, settings, connections, and lifecycle.
- **G3 — One Claxedo AI.** Building, editing, and operating apps use Claxedo
  chat, sessions, skills, and agents.
- **G4 — Safe generated execution.** App code receives only explicit storage,
  data, browser, agent, and connector capabilities.
- **G5 — Explicit sharing semantics.** Sharing code, sharing an instance,
  installing a managed app, and publishing a site are distinct actions.
- **G6 — Publisher/customer tenancy.** Managed apps can have customers beneath
  their publisher while using Claxedo or self-hosted identity.
- **G7 — Web and desktop.** App surfaces run in both; browser capture has
  desktop, extension, import, or remote-browser adapters.
- **G8 — Portability.** App packages express capabilities and provider ports,
  not vendor SDK dependencies.
- **G9 — Exit paths.** Code, schema, data, assets, and connection requirements
  have documented export formats.

### Engineering goals

- Keep app artifacts independent from app instances.
- Keep identity and instance selection outside generated code.
- Keep runtime admission and capability enforcement outside generated code.
- Preserve source and runtime integrity with immutable releases and digests.
- Make provider adapters satisfy shared conformance suites.
- Align ownership with the multiplayer plan's org, actor, workspace, and
  session identities.

## 4. Non-goals

- Claxedo Apps does not replace the Claxedo workbench or agent session model.
- App UI does not execute as trusted SolidJS code inside the shell.
- Public websites with public endpoints do not require private app instances,
  Gatekeepers, or Claxedo authentication.
- Generated code does not authorize instance admission or connector scope.
- The first platform release does not provide arbitrary cross-provider live
  migration or identical security guarantees across providers.
- Marketplace payments, publisher payouts, taxes, and revenue sharing are
  separate billing phases.
- The platform does not bypass browser framing rules or source-site terms.
- Runtime sharing does not model source editing, review, build, or deployment
  permissions; the configured Git and CI/CD providers own those decisions.

## 5. The app model: orthogonal policies

App kinds are presets over orthogonal policies rather than a growing enum.

### 5.1 Instance scope

| Value | Instance key | Meaning |
|---|---|---|
| `owner` | app + owner | Private one-off gadget. |
| `user` | deployment + app customer | One maintained app, private instance per user. |
| `workspace` | deployment + workspace | One shared team/collaborative instance. |
| `organization` | deployment + org | Organization-wide instance. |
| `public` | deployment + publication | Anonymous/public runtime or published snapshot. |

### 5.2 Data authority

| Value | Enforcement boundary | Best for |
|---|---|---|
| `instance-sqlite` | Runtime instance boundary | Personal and symmetric shared apps. |
| `external-capabilities` | Gatekeeper + external system | Internal tools and external systems of record. |
| `public-data` | Public endpoint/static artifact | Public sites and directories. |
| `none` | No persistence | Calculators, renderers, transient tools. |

An app may combine authorities. A team app can use symmetric instance SQLite
for shared state and a GitHub connector for repository state. Apps that require
viewer-specific authorization over shared business records use an external
system of record through a Gatekeeper.

### 5.3 Distribution method

| Value | What recipient gets |
|---|---|
| `private` | Access only for owner/creator. |
| `share-instance` | Access to the same running instance. |
| `blueprint` | Copy of code, schema, and capability requirements; fresh instance. |
| `managed-install` | Reference to publisher-maintained release; scoped instance. |
| `public-publish` | Public static artifact or explicitly public instance. |

## 6. Supported presets

### 6.1 Private personal gadget

```text
instance scope: owner
data: instance-sqlite
distribution: private
```

The owner receives private storage, private chat context, and personal
connections. This is the basic Cloudflare OS personal gadget.

### 6.2 Symmetric collaborative app

```text
instance scope: workspace
data: instance-sqlite
distribution: share-instance
```

Every admitted collaborator shares the same instance state. This suits
whiteboards, shared notes, team trackers, and other cases where every
collaborator may see all app data.

### 6.3 Blueprint

```text
source: any immutable release
result source: new Git repository or branch
result instance: fresh owner/workspace instance
result storage/connections/chat: fresh
distribution: blueprint
```

Blueprints carry code, schema, UI metadata, and capability requirements. They
do not carry live storage, credentials, customer rosters, or AI transcripts.

### 6.4 Managed user-scoped app

```text
release: tracked release channel
instance scope: user
data: instance-sqlite and/or external-capabilities
distribution: managed-install
```

One publisher maintains the app while each customer gets private data and
personal connections. Content Engine is the reference application.

### 6.5 External collaborative app

```text
instance scope: owner, user, or workspace
data: external-capabilities
distribution: private, share-instance, or managed-install
```

The external system remains authoritative. Gatekeepers isolate credentials,
scope resources, verify viewer entitlement, log actions, and stage mutations.
Examples include GitHub, Google Drive, CRM, analytics, and scheduler apps.

### 6.6 Public app or site

```text
release: immutable static/public artifact
instance scope: public or none
data: public-data or none
distribution: public-publish
```

Static marketing pages, public directories, documentation, and apps backed only
by public endpoints deploy normally to a public host. They use declared CSP
allowlists and do not inherit private app capabilities.

## 7. Architectural invariants

1. **Artifact identity and instance identity are separate.** A release chooses
   code; an instance chooses state.
2. **Sharing actions name what crosses the boundary.** Instance, code,
   maintained release, and public output are distinct nouns.
3. **The trusted host selects identity and instance.** Generated code cannot
   assert actor, tenant, instance locator, database, or connection owner.
4. **An app begins with zero authority.** Storage, data, browser, AI, jobs, and
   external services are explicit bindings.
5. **Native instance SQLite is symmetric.** Everyone admitted to a shared
   instance is treated as entitled to all data reachable by its generated code.
6. **Credentials never enter app code.** Gatekeepers expose operations, not
   tokens.
7. **Runtime admission is host-enforced.** Generated UI cannot grant instance
   access or widen a connector binding.
8. **Releases are immutable.** Updates select a new release and run explicit
   migrations.
9. **Capability widening is reviewable.** A release cannot silently acquire
    new external, browser, data, export, or egress authority.
10. **Provider security is labeled honestly.** Portability preserves semantics,
    not the strongest provider's isolation guarantee.
11. **Revocation applies to live access.** Instance and connector grants
    terminate or revalidate active sessions within a documented bound.

## 8. High-level architecture

```text
┌────────────────────────────── Claxedo shell ─────────────────────────────┐
│ AI chat   App builder   Marketplace   Dynamic nav   Publisher console   │
└──────────────┬────────────────┬──────────────┬───────────────────────────┘
               │                │              │
               ▼                ▼              ▼
┌──────────────────────────── Control plane ───────────────────────────────┐
│ Apps  Releases  Deployments  Blueprints  Installs  Instances  Grants    │
│ Publishers  App customers  Entitlements  Provider profiles  Audit       │
└──────────────┬────────────────┬──────────────┬───────────────────────────┘
               │                │              │
               ▼                ▼              ▼
┌──────────────────────────── Runtime plane ───────────────────────────────┐
│ Opaque iframe ↔ trusted RPC host ↔ Dynamic Worker/Facet or service       │
└──────────────────────────┬───────────────┬───────────────────────────────┘
                           │               │
                  ┌────────▼───────┐ ┌─────▼─────────────────────────────┐
                  │ Native data    │ │ Capabilities                     │
                  │ instance SQL   │ │ browser, AI, jobs, Gatekeepers   │
                  └────────────────┘ └───────────────────────────────────┘
```

### 8.1 Claxedo owns

- AI chat, agent sessions, model selection, skills, and tool execution;
- global users/actors, orgs, workspaces, app customers, and entitlements;
- app package installation, registry, navigation, and settings;
- releases, deployments, instances, blueprints, sharing provenance, and audit;
- trusted RPC bridges and capability routing;
- provider contracts and hosted default adapters.

### 8.2 App package owns

- UI and optional server code;
- SQLite migrations;
- declarative navigation and settings metadata;
- required capability and connector slots;
- app-specific skills and domain operations;
- export vocabulary and release compatibility metadata.

### 8.3 Provider profile owns

- source/version backend;
- build and artifact storage;
- runtime/deployment and domains;
- identity verification;
- instance and database provisioning;
- asset storage and background jobs;
- connector/credential implementation;
- billing/entitlement integration when configured.

## 9. Core control-plane objects

```text
App
  identity, source/release reference, manifest

Release
  immutable artifacts, source revision, schema, capability digest

Deployment
  provider profile, domains, release channels, distribution policy

Installation
  recipient relationship to a managed app or blueprint result

Instance
  scope subject, runtime locator, database locator, release/schema version

ShareGrant
  instance recipient, provenance, status

Blueprint
  code/schema/capability snapshot and version

AppCustomer
  deployment-scoped projection of a global actor

ConnectorBinding
  instance/customer-scoped external capability

```

### 9.1 Identity keys

```text
personal gadget instance = app_id + owner_actor_id
managed private instance = deployment_id + app_customer_id
team instance            = deployment_id + workspace_id
org instance             = deployment_id + org_id
public instance          = deployment_id + publication_id
```

Keys are derived inside trusted routing. URLs and app RPC arguments carry
opaque handles, never provider locators.

## 10. App package and manifest

One package can contain apps, skills, connectors, and blueprints:

```text
my-plugin/
  claxedo.plugin.json
  apps/
    app.manifest.json
    ui/
    server/
    migrations/
  skills/
  connectors/
  blueprints/
  docs/
```

The package manifest is declarative:

```json
{
  "schema_version": 1,
  "id": "com.example.operations",
  "components": {
    "apps": ["apps/app.manifest.json"],
    "skills": ["skills/operations"],
    "connectors": ["connectors/github.json"],
    "blueprints": ["blueprints/team-dashboard.json"]
  }
}
```

An app manifest composes policies:

```json
{
  "schema_version": 1,
  "id": "operations",
  "name": "Operations",
  "instances": { "scope": "workspace" },
  "data": [
    { "id": "app", "authority": "instance-sqlite", "migrations": "migrations" }
  ],
  "distribution": ["managed-install", "share-instance"],
  "capabilities": {
    "required": ["instance.storage", "agent.invoke"],
    "connector_slots": [
      { "id": "source", "requires": ["issues.read"], "setup": "workspace" }
    ]
  },
  "surfaces": [
    { "slot": "global-navigation", "label": "Operations", "route": "/apps/operations" }
  ]
}
```

Provider and launch-surface selection live in a deployment profile, not the
app manifest. The same release and instance may be opened inside the Claxedo
shell or through an independently accessible authenticated URL.

## 11. Build, release, and versioning

### 11.1 Authoring

Claxedo AI edits app source through the user's normal project/workspace and
session model. The app platform does not introduce a second AI chat. Source can
be stored in GitHub, GitLab, local Git, or another `SourceProvider`.

Personal apps can use a lightweight source store initially, but publishing a
managed release or blueprint produces an immutable source snapshot and build
provenance.

### 11.2 Release

```text
source revision
  → deterministic build
  → UI bundle + server modules + migration bundle
  → compute artifact digests
  → compute capability digest
  → create immutable Release
```

Release channels are `preview`, `canary`, and `stable`. Personal/forked apps may
pin a release while changes remain in a draft branch. Managed installations
normally follow a publisher channel.

### 11.3 Upgrade

App code and storage have independent lifecycles:

```text
release v7 → release v8
instance identity and durable storage → preserved
```

Instance upgrade acquires a migration lease, validates capability consent,
applies ordered checksum-verified migrations, records schema/release, and then
starts the runtime. Unsafe rollback is rejected using declared schema bounds.

## 12. Runtime and serving

### 12.1 UI sandbox and launch surfaces

The trusted `ManagedAppSurface` or `GadgetSurface` loads the immutable UI bundle
into an opaque-origin iframe. The host surface can be a route inside the Claxedo
shell or a minimal independently accessible app-domain page:

```html
<iframe
  sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
  srcdoc="..."
/>
```

The hardened profile uses a CSP with `connect-src 'none'`. The iframe receives
an authorized `MessagePort` from the parent and communicates through typed RPC.
It cannot access the Claxedo DOM, cookies, filesystem, bearer tokens, or ambient
network.

Both launch surfaces use the same actor authentication, instance resolver,
release, RPC protocol, capability broker, and data authorization. The
standalone page is a thin host and routing adapter, not a separate app mode.
Public static output is different: it is a conventional published artifact and
does not require the trusted private-app host or broker.

### 12.2 Stateful sandbox profile

```text
Release server modules
  → Dynamic Worker loader keyed by release digest
  → Facet selected by trusted instance router
  → isolated SQLite
```

Dynamic Worker environment bindings contain only app self-RPC, instance
storage, trusted data capabilities, and explicitly bound Gatekeepers. Global
outbound access is disabled.

### 12.3 Portable service profile

A conventional Cloudflare Worker, Vercel function, Node service, or workerd
deployment can run one stateless release service. Trusted middleware resolves
the actor and instance, then injects scoped database and capabilities.

Portable app correctness cannot depend on Facet serialization or in-memory
state. It uses transactions, idempotency keys, `JobProvider`, `AssetProvider`,
and realtime/subscription ports.

### 12.4 Public static profile

UI and selected public data compile into a public artifact for Cloudflare
Pages, Vercel, or another static host. Public endpoint access is declared in
CSP. Private instance data, auth sessions, app connectors, and Gatekeepers are
excluded from the artifact.

## 13. Native instance storage

The app runtime receives a database already scoped to its instance:

```ts
interface AppDatabase {
  execute(input: Statement): Promise<QueryResult>
  batch(input: Statement[]): Promise<QueryResult[]>
  transaction<T>(operation: (tx: AppTransaction) => Promise<T>): Promise<T>
  schemaVersion(): Promise<number>
}
```

Adapters include Facet SQLite, Turso/libSQL, and local SQLite. Personal instance
tables need no `user_id` column. A workspace instance is symmetric: everyone
admitted to it is entitled to all data reachable by the generated app. The
instance boundary is the authorization boundary.

## 14. Gatekeepers and external capabilities

Gatekeepers are a separate capability plane from native storage and app
sharing. They own:

- OAuth and secret storage;
- typed, narrow service APIs;
- resource and operation scoping;
- user, workspace, or organization connection selection;
- action logs and audit;
- approval and provisional results;
- entitlement revalidation and revocation.

The effective external operation rule is:

```text
user may access app/instance
AND app instance holds connector binding
AND binding permits operation/resource
AND viewer or organization is entitled externally
AND approval policy permits commit
```

### 14.1 Connection modes

| Mode | Credential used | Responsibility |
|---|---|---|
| `per-viewer` | Current viewer's connection | External provider naturally applies viewer ACL. |
| `instance-owner` | Connection creator's account | Every collaborator must be independently entitled to the resource. |
| `organization` | Org service account | Gatekeeper/Claxedo policy must constrain the service account's broad access. |
| `public` | No secret; public endpoint | Declared public capability or ordinary public deployment access. |

### 14.2 Asynchronous approval

Sensitive writes are staged, given provisional IDs, overlaid into subsequent
reads, and resolved after human approval. This lets agents continue without
receiving credentials or requiring dangerous global auto-approval.

### 14.3 Capability availability by audience

A capability binding declares its permitted audiences:

```text
owner | app-customer | workspace-member | public
```

Public runtimes receive only capabilities explicitly safe for public use. A
private Gatekeeper added to an app is not automatically attached to an existing
public deployment.

## 15. Sharing and authorization

### 15.1 Four sharing actions

The UX uses four verbs:

| Action | Effect |
|---|---|
| **Invite to app** | Grant access to the same live instance. |
| **Create blueprint** | Share/copy code and requirements into a fresh instance. |
| **Publish app** | Offer a maintained release that creates scoped customer/workspace instances. |
| **Publish site** | Deploy a public static/public-data artifact. |

### 15.2 Runtime access grants

Runtime sharing answers one question: whether an actor may open a particular
app instance. A live `ShareGrant` grants admission and its revocation removes
admission. GitHub, GitLab, or the configured source and CI/CD providers govern
who may edit, review, build, and deploy the app.

For Gatekeeper-backed apps, admission to the app and entitlement to the external
resource are conjunctive checks. The external system remains responsible for
viewer-specific data authorization.

### 15.3 Permission provenance graph

Share grants record how access was acquired:

```text
owner → direct user grant
owner → share link → user
owner → group → member
owner → team → member
```

Effective access is a fixed-point computation over live edges. Revocation removes
supporting paths, previews affected collaborators, preserves audit/undo data,
and terminates or revalidates live sessions.

### 15.4 Conjunctive Claxedo authorization

For a private managed instance:

```text
may open
  = authenticated actor
  AND actor belongs to deployment publisher/customer authority
  AND entitlement is active
  AND actor maps to the resolved app customer or accepted share grant
```

For a workspace/team app:

```text
may open
  = required org membership
  AND required workspace authority
  AND app installation/instance grant
  AND session creator/participant rule when transcript content is involved
```

For an external operation, the Gatekeeper rule in §14 is another conjunct.

## 16. Blueprints and managed releases

### 16.1 Blueprint contents

- source snapshot or release artifact;
- app manifest and UI metadata;
- SQLite migrations;
- required skills and connector slots;
- binding annotations and setup instructions;
- author, description, version, and provenance.

### 16.2 Blueprint exclusions

- live instance storage;
- customer data and roster;
- credentials and connector bindings;
- AI chat history;
- share grants and support sessions.

### 16.3 Managed install versus fork

```text
Install app
  → follow publisher release channel
  → keep private or workspace-scoped instance

Fork with AI
  → copy code into personal/team lineage
  → pin current schema/data migration decision
  → future publisher releases do not overwrite fork
```

The fork flow offers explicit data handling: start fresh, copy compatible
instance data, or keep the existing managed instance separate.

## 17. Plugin and Claxedo integration

A Claxedo plugin package may install:

- skills;
- MCP/agent configuration;
- connector declarations;
- app manifests;
- blueprint manifests;
- declarative surfaces, navigation, commands, and settings.

The current agent-extension package remains responsible for source resolution,
locking, integrity, materialization, replay, and conflict detection. The host
owns authorization, provider configuration, app lifecycle, and persistent
control-plane state.

Wire manifests never contain SolidJS renderer functions. Claxedo provides
first-party renderers:

```text
ManagedAppSurface(deployment_id)
GadgetSurface(app_id, instance_id)
BlueprintInstallSurface(blueprint_id)
PublisherConsoleSurface(app_id)
```

Plugins contribute declarative records that target those renderers.

## 18. UX high-level design

### 18.1 Apps navigation

Global navigation gains a dynamic **Apps** section. Entries show private,
shared, managed, setup-required, update, suspended, and error states. Context
actions include:

- open;
- ask Claxedo AI;
- share instance;
- create blueprint;
- connections;
- release/version;
- export data;
- fork with AI;
- disable/uninstall.

### 18.2 App builder

The builder is a Claxedo session plus a Git-backed preview surface:

1. User asks Claxedo AI to create or modify an app.
2. Agent edits source and schema/manifest declarations in the configured Git
   repository.
3. The source/build provider produces a preview artifact and Claxedo opens it
   against an isolated preview instance.
4. Capability changes appear in a review panel.
5. Git and CI/CD create the immutable release; Claxedo can select it for an
   instance, package it as a blueprint, or publish its public artifact.

### 18.3 Marketplace

Marketplace cards identify distribution semantics:

```text
Blueprint — creates your editable copy
Managed app — publisher-maintained, your private/team data
Public site template — deploys public output
Connector/skill plugin — extends agents and integrations
```

Each card shows required capabilities, provider compatibility, data location,
isolation grade, source provenance, update ownership, and pricing/entitlement
when configured.

### 18.4 Sharing dialog

The dialog starts with the user's intended outcome:

- Collaborate in this app
- Give someone their own copy
- Offer this as a maintained app
- Publish a public site

It then shows exactly which code, data, chat/session context, and connections
cross the boundary.

### 18.5 Publisher console

Managed app publishers see releases, capability diffs, deployments, customers,
entitlements, instance health, aggregate usage, provider profiles, rollout,
rollback, and customer-approved support sessions. Private payload data remains
outside the default console.

## 19. Representative user journeys

### 19.1 Build a private personal app

1. User asks Claxedo AI for a personal tracker.
2. Agent creates UI, server, migrations, and manifest.
3. Preview provisions an owner-scoped Facet.
4. The configured Git and CI/CD providers produce an immutable release.
5. Claxedo points the personal instance at that release; the app appears in
   navigation with private SQLite.

### 19.2 Share the live app with a collaborator

1. Owner chooses **Collaborate in this app**.
2. Claxedo previews code, storage, and external capability implications.
3. Owner grants runtime access through a direct grant or link.
4. External observers/capabilities verify collaborator entitlement as required.
5. Collaborator enters the same instance and sees live shared state.

### 19.3 Share a blueprint

1. Creator publishes a code/schema/capability snapshot.
2. Recipient reviews requirements and installs.
3. Claxedo creates a fresh app lineage, instance, storage, chat context, and
   connector setup.
4. Recipient customizes independently with AI.

### 19.4 Install a managed personal app

1. Customer installs Content Engine.
2. Claxedo creates an app-scoped customer and entitlement.
3. First open provisions a private customer instance.
4. Customer connects their scheduler.
5. Publisher rolls future compatible releases to the instance.

### 19.5 Build an external collaborative dashboard

1. Owner binds a specific external resource through a Gatekeeper.
2. App receives narrow read/staged-write methods.
3. Collaborators are admitted according to app and external-resource policy.
4. External provider remains the system of record.
5. Side effects are staged and approved asynchronously.

### 19.6 Publish a public site

1. User builds a directory over public endpoints or selected public data.
2. Build emits a static/public artifact and CSP allowlist.
3. Deployment provider publishes to Cloudflare Pages or Vercel.
4. No private instance, Claxedo auth, or Gatekeeper is included.

## 20. Provider portability

App manifests state semantic needs. Deployment profiles bind providers.

| Concern | Hosted default | Alternatives |
|---|---|---|
| Source/version | GitHub | GitLab, local Git, archive |
| Build | GitHub Actions | GitLab CI, local Bun, custom build service |
| Artifacts/assets | R2 | S3-compatible, filesystem |
| Stateful runtime | Dynamic Worker + Facet | Workers for Platforms, workerd-based host |
| Portable runtime | Cloudflare Worker | Vercel functions, Node/Bun service |
| Public delivery | Cloudflare Pages | Vercel, static object/CDN host |
| Identity | Claxedo signed identity | Better Auth, OIDC |
| Instance database | Facet SQLite | Turso/libSQL, local SQLite |
| Jobs | Claxedo Wakes | queue/cron adapter |
| Connections | `@claxedo/connections` hosted adapters | self-hosted port implementations |
| Billing | Claxedo billing | Stripe/custom entitlement adapter |

Core ports include `SourceProvider`, `BuildProvider`, `ArtifactProvider`,
`DeploymentProvider`, `AuthProvider`, `PrincipalMap`, `InstanceProvider`,
`DatabaseProvider`, `AssetProvider`, `JobProvider`,
`ConnectorProvider`, and `EntitlementProvider`.

Every adapter passes a conformance suite covering identity audience, instance
isolation, idempotent provisioning, transaction rollback, capability scope,
credential non-disclosure, live/replay filtering where applicable, migrations,
and export/import.

Deployment profiles publish an isolation grade:

```text
sandboxed-capabilities-only
isolated-trusted-publisher
self-hosted-operator-trusted
public-static
```

## 21. Security and privacy

### 21.1 Boundaries

| Component | Trust |
|---|---|
| Claxedo shell/control plane | Trusted platform code |
| Plugin package | Integrity-checked supply-chain input |
| App UI iframe | Untrusted |
| App server in hardened profile | Untrusted |
| App server in portable profile | Publisher/operator trusted |
| Instance router | Trusted |
| Gatekeeper/connector broker | Trusted credential and side-effect boundary |
| Publisher | Controls releases; no default private-data read grant |

### 21.2 Release review

Every release records source/build provenance, artifact digest, schema version,
capability digest, network policy, and isolation grade. New
capabilities, wider data export, support access, or isolation downgrade follow
an explicit consent/rollout policy.

### 21.3 Live revocation

- Instance/share revocation terminates or reauthenticates RPC sessions.
- Connector revocation invalidates short-lived capability handles and checks
  binding status on mutations.
- App entitlement suspension prevents new sessions and moves existing sessions
  to a bounded teardown/read-export policy.

### 21.4 Publisher trust

Managed customers necessarily trust future publisher code. Immutable releases,
capability diffs, denied egress in the hardened profile, canary rollout,
customer-visible provenance, and time-bounded support access reduce that power.
Portable profiles state when publisher/operator code can access network or
infrastructure directly.

## 22. Reliability and operations

- Provisioning is idempotent on the canonical instance key.
- Runtime version and storage schema version are recorded independently.
- Migrations acquire per-instance leases and create provider checkpoints where
  supported.
- External mutations use idempotency keys and durable provisional records.
- Jobs are at-least-once and deduplicated in authoritative storage.
- Connector failure does not make native app data unavailable.
- App UI distinguishes provisioning, migration, offline, setup-required,
  suspended, and incompatible-version states.
- Logs default to opaque actor/instance identifiers and exclude data payloads.
- Data/asset export includes schema, release, digests, and verification counts;
  credentials are reauthorized at the destination.

## 23. Inspirations

### Cloudflare OS

Adopt:

- Dynamic Worker and Facet separation;
- opaque iframe plus MessageChannel/Cap'n Web RPC;
- explicit environment bindings and denied egress;
- Gatekeepers and asynchronous approvals;
- blueprint semantics;
- permission provenance, transitive revocation, preview, and live restart.

Extend:

- maintained release with private per-customer instances;
- Claxedo org/workspace/session tenancy;
- portable provider profiles;
- declarative plugin integration into the Claxedo shell.

### Stripe Connect

Use the hierarchy, not the payment implementation:

```text
Claxedo platform → app publisher → deployment → app customers
```

The global person remains a Claxedo or self-hosted identity. Each deployment
receives an app-scoped customer projection and entitlement.

### Conventional deployment platforms

Git, immutable builds, preview/production promotion, static hosting, OIDC,
SQLite/libSQL, object storage, and job adapters provide the portable profile.

## 24. Alternatives and tradeoffs

### One app-kind enum

An enum is simple initially but combines independent code, instance, data,
sharing, and runtime choices. Orthogonal policies make hybrid apps explicit and
avoid a new app kind for every combination.

### Full Cloudflare OS fork

It maximizes immediate reuse but couples Claxedo to Overseer chat, identity,
sharing, and code history. Claxedo reuses the runtime/security architecture and
keeps its own product control plane.

### Blueprint-only distribution

It preserves user ownership and customization but turns publisher updates and
migrations into reconciliation across forks. Both blueprint and managed install
remain first-class.

### Facet-only runtime

It gives excellent isolation and persistence but makes the app contract
Cloudflare-specific. The hardened default can use Facets while portable apps
depend only on transactions, jobs, assets, and capabilities.

### Trusted in-shell plugin UI

It offers deep integration but grants third-party code the Claxedo origin and
DOM. Declarative shell contributions plus sandboxed app UI preserve the trust
boundary.

### Main tradeoffs

| Decision | Benefit | Cost |
|---|---|---|
| Orthogonal policies | Complete, composable taxonomy | More validation than a small enum |
| Per-instance SQLite | Strong simple personal isolation | Cross-instance queries need aggregate services |
| Managed releases | Coherent updates | Customers trust publisher code |
| Capability-only connectors | Secret isolation and audit | Connector ecosystem investment |
| Sandboxed iframe | Web/desktop safety | Native shell integration stays declarative |
| Provider ports | Self-host and exit path | Conformance and weakest-common-contract cost |
| Separate public publishing | Simple public hosting | Public output has a separate lifecycle |

## 25. What is genuinely hard

### 25.1 Generated-code upgrade and migrations

Publisher-managed apps combine untrusted/generated migrations with durable
customer data. Migration leases, backups, compatibility bounds, canaries, and
forward repair require first-class operational design.

### 25.2 Portable sandbox parity

Dynamic Workers and Facets have no exact local or Vercel equivalent. Workerd can
provide a local runtime, but production packaging, resource control, dynamic
code loading, and persistent child-instance orchestration remain substantial.
Portable trusted-publisher profiles are semantically compatible, not equivalent
untrusted sandboxes.

### 25.3 Web browser capture

Electron can host hardened webviews. A normal web app cannot frame many major
sites. Web capture requires an extension, explicit import/share flow, or remote
browser service.

### 25.4 Publisher trust and consent

A publisher who controls future code can change how private data is processed.
Capability review reduces external authority but cannot make maintained code
ownership disappear. The product must communicate this trust relationship.

## 26. Roadmap and file-level sequencing

### Phase 0 — execution security

Multiplayer Milestone 0 lands first. Agent-written app installation cannot be
called safe while arbitrary workspace process/PTY/session execution lacks the
planned role and path enforcement.

### Phase 1 — identity and tenancy

Milestone 2a establishes org, project, actor, and signed token identity. App,
publisher, installation, customer, and instance ownership reuse those identities
rather than creating a second global principal system.

Milestone 2c is required before app-related AI transcripts can be private
inside shared workspaces.

### Phase 2 — app contracts

Create provider-neutral packages for:

- manifests and instance/capability composition;
- app/release/deployment/instance records;
- provider ports and conformance suites;
- capability and release digests;
- blueprint and export formats.

This phase avoids hosted schema writes and can proceed while 2a settles.

### Phase 3 — shell and plugin integration

- extend agent-extension manifests for apps/connectors/blueprints;
- add persistent package-owned contribution tier;
- open content metadata to string-addressed app surfaces;
- make global navigation registry-driven;
- add trusted app/blueprint/publisher surface renderers;
- persist installed app/navigation state.

Expected contention:

```text
packages/agent-extensions/src/manifest.ts
packages/agent-extensions/src/discovery.ts
packages/agent-extensions/src/types.ts
packages/claxedo-app/src/app/integrations/registry.ts
packages/claxedo-app/src/app/workbench/rail/global-navigation.tsx
packages/claxedo-app/src/app/workbench/state/types.ts
packages/claxedo-app/src/app/workbench/review/review-workspace.tsx
```

### Phase 4 — personal gadgets, blueprints, symmetric collaboration

- Cloudflare runtime adapter;
- personal/workspace instances and SQLite;
- Git-backed preview and immutable release selection;
- share graph, links, provenance, preview, revocation;
- blueprint publish/install;
- two-user live collaboration proof.

### Phase 5 — managed user-scoped apps

- publisher, deployment, app-customer, entitlement, and per-user instance;
- release channels, rollout, migration, rollback;
- optional authenticated app-domain host reusing the shell surface contract;
- publisher console;
- Content Engine reference plugin.

The detailed vertical design is in
`2026-08-06-003-feat-portable-managed-mini-apps-content-engine-design.md`.

### Phase 6 — portability and public publishing

- one non-default Better Auth + Turso + Vercel/self-host profile;
- provider conformance proof and export/import;
- public static build/deploy adapters;
- custom domains and public CSP manifests.

### Convex contention

`convex/schema.ts` is already shared by multiplayer B1, B2, B4, and B5. Hosted
app/release/instance/share/customer rows land in scheduled EXPAND schema
waves with one owner after 2a's identities stabilize. Provider-neutral contracts,
local SQLite adapters, shell work, and runtime prototypes remain independent of
that file.

## 27. Success criteria

- A user creates a private app with AI, restarts Claxedo, and retains code,
  navigation, storage, and connections.
- Two collaborators share one symmetric instance with runtime admission and
  live revocation.
- A blueprint recipient receives independent code, storage, chat context, and
  connector setup.
- One publisher releases a managed app used by two private customers on
  isolated instances and rolls out a compatible update.
- A Gatekeeper-based app proves secret non-disclosure, resource scope,
  provisional writes, approval, and revocation.
- A public app deploys as a static/public artifact without private bindings.
- The app shell renders all modes through persistent registry-driven navigation
  in web and Electron.
- The same managed reference app passes Claxedo hosted and one Better Auth +
  Turso portable profile.

## 28. Open decisions before implementation planning

1. Whether the first runtime slice uses Cloudflare Dynamic Workers/Facets
   directly or a smaller local workerd prototype first.
2. Whether share links require Claxedo authentication in the first release.
3. Whether managed standalone apps accept branded signup before marketplace
   installation.
4. Default publisher rollout and customer capability-consent policy.
5. Data retention and export access after uninstall or entitlement suspension.
6. The verified result of the existing workspace-sandbox secret inheritance
   audit; managed apps cannot ship on a substrate that materializes an owner's
   secrets into a collaborator-reachable sandbox.

## 29. References

### Claxedo

- `docs/plans/2026-08-01-002-refactor-single-tenant-today-multiplayer-ready-plan.md`
- `docs/plans/2026-08-06-003-feat-portable-managed-mini-apps-content-engine-design.md`
- `packages/agent-extensions/docs/architecture.md`
- `packages/claxedo-connections/docs/architecture.md`
- `packages/claxedo-app/src/app/integrations/registry.ts`
- `packages/claxedo-app/src/features/browser/store/browser-pane-context.tsx`
- `packages/claxedo-server/src/platform/auth/postures.ts`

### Cloudflare OS

- `packages/workshop-backend/src/overseer.ts`
- `packages/workshop-backend/src/sharing.ts`
- `packages/workshop-frontend/src/GadgetUI.tsx`
- `docs/blueprints.md`
- `docs/sharing.md`
- `docs/observers.md`

### Provider documentation

- [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Cloudflare Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Vercel deployments](https://vercel.com/docs/deployments/overview)
- [Better Auth database adapters](https://better-auth.com/docs/concepts/database)
- [Better Auth organizations](https://better-auth.com/docs/plugins/organization)
- [Turso TypeScript clients](https://docs.turso.tech/sdk/ts/reference)
- [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction)
