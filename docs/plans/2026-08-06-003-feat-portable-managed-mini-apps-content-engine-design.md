# Portable Managed Mini-Apps — Content Engine Reference Design

Date: 2026-08-06. Status: proposed architecture.

Scope: this is the managed user-scoped reference vertical for the umbrella
[Portable Claxedo Apps Platform](./2026-08-06-004-feat-portable-claxedo-apps-platform-design.md).
The umbrella design defines private gadgets, symmetric collaborative instances,
blueprints, managed apps, external-capability apps, and public sites. This
document applies those primitives specifically to Content Engine.

## 1. Executive summary

Claxedo will support **managed user-scoped apps**: one publisher maintains one
versioned application, while every signed-in customer receives an isolated,
persistent app instance. The publisher owns the app release and customer
relationship; the customer owns their instance data and connections.

The Content Engine is the reference implementation. It appears as a Claxedo
plugin that installs:

- a managed mini-app surface and navigation entry;
- skills that teach the Claxedo agent how to capture, organize, draft, and
  schedule content;
- connector requirements expressed as capabilities, such as browser capture
  and content scheduling;
- a portable app manifest that can bind to different source, deployment,
  identity, storage, and connector providers.

The default hosted profile uses Claxedo identity, a Cloudflare sandboxed
runtime, and isolated SQLite storage. A self-hosted profile can bind the same
application to GitLab or a local repository, Vercel or Cloudflare, Better Auth,
and Turso/libSQL or local SQLite. The application depends on semantic provider
ports rather than vendor SDKs, so portability is a property of the package,
not a manual rewrite.

The core identity is:

```text
managed app release = centrally maintained code
app customer        = a user under that app's publisher
app instance        = customer-scoped runtime and storage
```

For the Content Engine:

```text
Content Engine release v12
  ├── Alice instance → Alice database + Alice connections
  ├── Bob instance   → Bob database + Bob connections
  └── Carol instance → Carol database + Carol connections
```

This design is additive to blueprints and collaborative apps. A blueprint
copies code. A collaborative app shares an instance. A managed user-scoped app
shares a maintained release while isolating instances.

## 2. Problem statement

Claxedo can run an agent, install skills and MCP configuration, manage external
connections, and host an Electron browser with element annotation. It does not
yet have a product primitive that lets a publisher:

1. ship a maintained mini-app inside Claxedo;
2. acquire and manage app customers beneath that publisher;
3. give each customer persistent private data without making the generated app
   implement authentication or tenancy filters;
4. contribute a durable navigation surface to the Claxedo shell;
5. combine the app UI with Claxedo's existing AI chat, skills, browser capture,
   and connectors;
6. move the application to another source host, deployment platform, identity
   system, or SQLite-compatible storage provider without rewriting its domain
   logic.

The Content Engine makes the gap concrete. A user browses source material in
Claxedo, annotates a page, saves notes with AI, develops drafts, and schedules
content through a third-party publisher. Each user needs durable private data
and personal connections. The application publisher needs to maintain one code
line and roll updates to all customers.

Treating this as a Cloudflare OS blueprint gives every customer an independent
code fork. Treating it as a shared collaborative gadget gives every customer
the same database. Neither expresses one maintained app with private per-user
instances.

## 3. Goals

### Product goals

- **G1 — Managed distribution.** A publisher releases one app and can roll out,
  pause, or roll back versions for its customers.
- **G2 — App customer tenancy.** A signed-in person becomes an app-scoped
  customer under the publisher without receiving a separate Claxedo password.
- **G3 — Private persistence.** Every individual customer gets an isolated
  logical instance; the app does not implement `user_id` filtering.
- **G4 — Native Claxedo UX.** Installation contributes a navigation entry,
  settings, commands, skills, and connector setup while the app UI runs in a
  sandboxed surface.
- **G5 — One AI.** The app uses Claxedo's chat and agent runtime. It does not
  bring an independent chatbot or model account system.
- **G6 — Capability-based integrations.** The app requests browser capture,
  content scheduling, and other external operations through narrow connectors;
  credentials never enter generated app code.
- **G7 — Portable deployment.** Source, build, runtime, identity, storage,
  artifacts, assets, and connectors are replaceable provider bindings.
- **G8 — Exportability.** A publisher can export a deployment profile and a
  customer can export their app data in documented formats.

### Engineering goals

- Preserve one stable application contract across Cloudflare, Vercel, and
  self-hosted profiles.
- Keep platform identity and instance routing outside the app's address space.
- Make new provider adapters pass shared conformance suites.
- Keep the portable app subset independent of Durable Object serialization,
  in-memory singleton state, and provider-specific environment variables.
- Align app, publisher, and customer ownership with Claxedo's personal-org and
  team-org identity model.

## 4. Non-goals

- A public marketing site or directory is a static/public deployment output,
  not a managed private app instance.
- The first release does not implement marketplace payouts, revenue sharing, or
  tax handling. App-customer entitlements leave room for a billing provider.
- Claxedo does not become a general replacement for GitHub, GitLab, Vercel,
  Cloudflare, Better Auth, or Turso.
- The Content Engine does not bypass source-site framing rules, automate bulk
  scraping, or circumvent provider terms. Browser captures are explicit user
  actions.
- Cross-provider live migration with zero downtime is outside the first
  release. Export, import, validation, and controlled cutover are required.
- Provider portability does not promise identical security guarantees.
  Deployment profiles publish their isolation grade explicitly.

## 5. Product model and terminology

| Term | Meaning |
|---|---|
| **Plugin package** | Installable package containing skills, connector declarations, managed-app manifests, and optional static assets. |
| **Publisher** | A Claxedo organization that owns a managed app and its customer relationship. |
| **Managed app** | Product identity, release channels, capability requirements, and customer policy. |
| **Release** | Immutable, content-addressed UI/server artifact built from one source revision. |
| **Deployment** | A managed app bound to one provider profile, domains, and release channel. |
| **App customer** | App-scoped projection of a global identity, owned by the deployment's publisher. |
| **Entitlement** | Whether an app customer may use a deployment and under what plan/limits. |
| **App instance** | Persistent customer-scoped runtime and storage selected by trusted routing. |
| **Connector slot** | Capability requirement satisfiable by one of several connector providers. |
| **Deployment profile** | Vendor bindings and secrets that satisfy the app manifest's portable ports. |
| **Blueprint** | Copy of an app's code and declarations that begins an independent code lineage. |

An app customer is a relationship, not a second login identity:

```text
global principal ──maps to── app-scoped customer ──owns── app instance
```

The generated app sees only the app-scoped customer identifier. The global
Claxedo principal remains inside trusted identity services.

## 6. Architectural invariants

1. **Artifact and instance are independent identities.** A release selects what
   code runs; an instance selects whose state it operates on.
2. **The host selects the instance.** Browser input, generated code, and URL
   parameters cannot select an arbitrary customer instance.
3. **One customer, one private data scope.** Personal instance tables do not
   require a `user_id` column because the storage adapter is already scoped.
4. **Authentication terminates before generated code.** The app receives an
   app-scoped principal or an already-authorized RPC channel, never the global
   session credential.
5. **Connectors are capabilities.** App code receives typed operations, never
   OAuth tokens or ambient provider SDK access.
6. **Releases are immutable.** Rollout changes the release selected for an
   instance; it never mutates an existing artifact.
7. **Capabilities are release permissions.** Adding or widening a connector,
   egress, browser, or data capability creates a reviewable release diff.
8. **Provider contracts are semantic.** App code depends on transactions,
   objects, identity, jobs, and connector calls rather than Cloudflare, Vercel,
   Clerk, Better Auth, or Turso APIs.
9. **The publisher owns code; the customer owns data and connections.** Support
   access requires an explicit, time-bounded customer grant and an audit trail.
10. **Every request carries an accountable actor chain.** Agent work records the
    initiating human and the acting agent while resolving to the human's app
    instance and entitlements.

## 7. High-level architecture

```text
┌──────────────────────────── Publisher plane ────────────────────────────┐
│ Plugin repo → SourceProvider → BuildProvider → immutable AppRelease     │
│                                      │                                  │
│                               DeploymentProvider                        │
└──────────────────────────────────────┼──────────────────────────────────┘
                                       │ release/channel
┌──────────────────────────── Claxedo control plane ──────────────────────┐
│ AuthProvider → PrincipalMap → AppCustomer → Entitlement → AppInstance  │
│                                      │                   │              │
│                              customer roster       provider bindings   │
└──────────────────────────────────────┼───────────────────┼──────────────┘
                                       │                   │
┌──────────────────────────── Runtime/data plane ─────────────────────────┐
│ Claxedo shell → sandboxed iframe → RPC host → app runtime              │
│                                               │                         │
│                         ┌─────────────────────┼──────────────────────┐  │
│                         │ scoped AppDatabase │ ConnectorBroker      │  │
│                         │ AssetStore         │ BrowserCapture       │  │
│                         │ JobScheduler       │ Claxedo Agent API    │  │
│                         └─────────────────────┴──────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.1 Plane ownership

The **publisher plane** builds and distributes immutable code. The **control
plane** owns identity, customer relationships, entitlements, releases, and
provider configuration. The **runtime/data plane** executes one release
against one resolved customer instance.

The separation permits these valid combinations:

```text
GitHub + Cloudflare runtime + Claxedo auth + Facet SQLite
GitLab + Vercel runtime     + Better Auth   + Turso
local Git + self-hosted     + Better Auth   + local SQLite
```

## 8. Plugin package contract

The Content Engine ships as a normal source repository with an extended
Claxedo package manifest. The existing agent-extension package continues to
own deterministic install, locking, integrity verification, and
materialization. The host continues to own authorization, hosted persistence,
and orchestration, matching the boundary already documented in
`packages/agent-extensions/docs/architecture.md`.

### 8.1 Repository layout

```text
content-engine/
  claxedo.plugin.json
  apps/
    content-engine/
      app.manifest.json
      ui/
      server/
      schema/
        001_initial.sql
      assets/
  skills/
    content-engine/SKILL.md
    content-research/SKILL.md
  connectors/
    browser-capture.json
    content-scheduler.json
  docs/
    self-host.md
    data-export.md
```

The plugin root declares components rather than executable renderer closures:

```json
{
  "schema_version": 1,
  "id": "com.claxedo.content-engine",
  "name": "Content Engine",
  "components": {
    "managed_apps": ["apps/content-engine/app.manifest.json"],
    "skills": ["skills/content-engine", "skills/content-research"],
    "connectors": [
      "connectors/browser-capture.json",
      "connectors/content-scheduler.json"
    ]
  }
}
```

### 8.2 Portable app manifest

The app manifest expresses requirements without selecting vendors:

```json
{
  "schema_version": 1,
  "id": "content-engine",
  "name": "Content Engine",
  "distribution": "managed",
  "instance_scope": "user",
  "release": {
    "ui_entry": "ui/index.html",
    "server_entry": "server/index.js",
    "database_dialect": "sqlite"
  },
  "surfaces": [
    {
      "slot": "global-navigation",
      "label": "Content Engine",
      "icon": "content-engine",
      "route": "/apps/content-engine"
    }
  ],
  "capabilities": {
    "required": ["app.data.private", "agent.invoke", "browser.capture"],
    "connector_slots": [
      {
        "id": "publisher",
        "requires": ["content.schedule", "content.publication-status"],
        "cardinality": "one-or-more",
        "setup": "user"
      }
    ]
  },
  "storage": {
    "migrations": "schema",
    "assets": true,
    "export_format": "content-engine-v1"
  },
  "security": {
    "network": "capabilities-only",
    "support_access": "customer-approved"
  }
}
```

The deployment profile supplies vendor bindings:

```yaml
profile: claxedo-cloud
source: github
build: claxedo-bun
artifacts: cloudflare-r2
runtime: cloudflare-dynamic-worker-facet
identity: claxedo
database: facet-sqlite
assets: cloudflare-r2
jobs: claxedo-wakes
connections: claxedo-connections
```

A self-hosted profile can replace those values without changing the app
manifest:

```yaml
profile: self-hosted-turso
source: gitlab
build: local-bun
artifacts: s3-compatible
runtime: vercel-functions
identity: better-auth
database: turso-libsql
assets: s3-compatible
jobs: cron-adapter
connections: self-hosted-connections
```

### 8.3 Installation behavior

Installation is one host-owned transaction with resumable steps:

1. Resolve and verify the plugin source and content lock.
2. Materialize skills and agent connector configuration.
3. Register the managed-app declaration.
4. Resolve a compatible deployment profile.
5. Present capability and provider requirements.
6. Create the app-customer relationship and entitlement.
7. Lazily provision the private instance on first open.
8. Register declarative navigation, settings, and command contributions.

The navigation contribution points to one trusted `ManagedAppSurface` renderer
owned by Claxedo. The plugin supplies only identifiers, labels, routes, and an
app deployment reference. This preserves the wire boundary because functions
and SolidJS components never cross it.

## 9. Control-plane model

The following records describe the logical contract. Provider adapters may
store them in Convex, SQLite, or another authority implementation.

```text
AppPublisher
  id
  org_id
  display_name

ManagedApp
  id
  publisher_id
  manifest_digest
  default_channel

AppRelease
  id
  app_id
  source_revision
  artifact_digest
  schema_version
  capability_digest
  created_by_actor_id

AppDeployment
  id
  app_id
  provider_profile
  stable_release_id
  preview_release_id?
  auth_audience
  status

AppCustomer
  id
  deployment_id
  app_scoped_subject
  global_actor_id         // trusted control plane only
  status
  created_at

AppEntitlement
  customer_id
  plan
  limits
  status

AppInstance
  id
  deployment_id
  customer_id
  release_channel
  database_locator       // opaque provider reference
  runtime_locator        // opaque provider reference
  schema_version
  status

AppConnectorBinding
  id
  instance_id
  slot
  connection_id
  capability_set
  status
```

`global_actor_id` is never projected into app code. The app receives a stable,
deployment-scoped `app_scoped_subject`, preventing automatic cross-app identity
correlation.

### 9.1 Customer roster

The publisher can manage:

- customer identifier, display-safe profile, signup time, and status;
- entitlement, usage, limits, release channel, and instance health;
- connection readiness without access to secret material;
- explicit support sessions and their audit records.

Private content rows, OAuth credentials, browser history, and AI transcripts
are outside the publisher roster.

## 10. Authentication and instance routing

### 10.1 Hosted sign-in

```text
request for content-engine.apps.claxedo.com
  → AuthProvider verifies Claxedo session
  → PrincipalMap resolves deployment-scoped AppCustomer
  → EntitlementService admits the customer
  → InstanceRouter resolves (deployment_id, customer_id)
  → runtime opens that instance
  → host gives iframe an authorized MessagePort
```

The app iframe does not hold the bearer token. The host associates the RPC
session with:

```text
audience      = app deployment
subject       = app-scoped customer
instance      = resolved private instance
actor chain   = initiating human + optional acting agent
release       = selected immutable release
```

### 10.2 Self-hosted sign-in

`AuthProvider` accepts any adapter that returns a stable verified external
subject. The Better Auth adapter maps its user/session result to the same
internal principal contract. Better Auth's database and organization plugins
remain implementation choices; the first Content Engine profile needs only
user and session identity.

### 10.3 Instance selection

The canonical instance key is derived inside trusted code:

```text
instance_key = H(deployment_id, app_customer_id)
```

The client cannot submit `customer_id`, `database_locator`, or a Facet name.
Every instance-scoped data or connector call reuses the resolved server-side
context.

## 11. Runtime, serving, and storage

### 11.1 Claxedo hardened profile

The default hosted runtime follows the Cloudflare OS separation:

```text
AppRelease server modules
  → Dynamic Worker loader keyed by release digest
  → customer-scoped Facet
  → customer-scoped SQLite
```

The Claxedo host authenticates and selects the customer Facet. The UI runs in
an opaque-origin iframe with network disabled and communicates over a
host-created RPC channel. The Dynamic Worker receives only declared bindings
and has outbound networking disabled.

The release lifecycle and instance lifecycle remain independent:

```text
release v12 → v13
customer Facet identity and SQLite → preserved
```

### 11.2 Portable trusted-publisher profile

Vercel, a conventional Cloudflare Worker, or a self-hosted Node service can run
one stateless service for a release. The trusted request gateway resolves the
customer and injects a scoped `AppDatabase` adapter. Turso/libSQL or local
SQLite provides private persistence.

```text
shared release service
  → trusted request context
  → AppDatabase(instance_locator)
```

Portable app code obeys these constraints:

- correctness does not depend on process memory or single-threaded actor
  execution;
- writes use database transactions and idempotency keys;
- background work uses `JobProvider`;
- assets use `AssetProvider`;
- time and random identifiers come from host utilities where deterministic
  retry matters;
- external services use connector capabilities.

### 11.3 Database contract

The first portable dialect is SQLite-compatible SQL:

```ts
interface AppDatabase {
  execute(statement: { sql: string; args?: unknown[] }): Promise<QueryResult>
  batch(statements: Array<{ sql: string; args?: unknown[] }>): Promise<QueryResult[]>
  transaction<T>(operation: (tx: AppTransaction) => Promise<T>): Promise<T>
  schemaVersion(): Promise<number>
}
```

Adapters include:

- Facet SQLite for the hardened Cloudflare profile;
- Turso/libSQL for remote per-customer databases or a provider-managed tenant
  partition;
- local SQLite for self-hosted single-node use.

The router opens the adapter already scoped to one `AppInstance`. App SQL has
no operation for selecting a different instance.

### 11.4 Serving the UI

The managed app surface is always rendered by trusted Claxedo code:

```text
dynamic navigation entry
  → ManagedAppSurface(deployment_id)
  → load immutable UI artifact by digest
  → construct sandboxed iframe srcDoc
  → transfer authorized RPC MessagePort
```

Every URL is fully qualified from deployment configuration. Renderer
`file://` location is never used as a URL base in Electron.

## 12. Provider ports and reference adapters

### 12.1 Core provider contracts

```ts
interface SourceProvider {
  resolve(ref: SourceRef): Promise<SourceSnapshot>
}

interface BuildProvider {
  build(input: SourceSnapshot, manifest: AppManifest): Promise<BuiltArtifact>
}

interface ArtifactProvider {
  put(artifact: BuiltArtifact): Promise<ArtifactRef>
  get(ref: ArtifactRef): Promise<ReadableStream>
}

interface DeploymentProvider {
  preview(release: AppRelease): Promise<DeploymentTarget>
  promote(target: DeploymentTarget): Promise<void>
  rollback(deploymentId: string, releaseId: string): Promise<void>
}

interface AuthProvider {
  authenticate(request: Request, audience: string): Promise<ExternalPrincipal>
}

interface InstanceProvider {
  resolve(input: { deploymentId: string; customerId: string }): Promise<AppInstance>
  provision(input: NewAppInstance): Promise<AppInstance>
  suspend(instanceId: string): Promise<void>
}

interface DatabaseProvider {
  open(instance: AppInstance): Promise<AppDatabase>
  export(instance: AppInstance): Promise<PortableDatabaseExport>
  import(instance: AppInstance, input: PortableDatabaseExport): Promise<void>
}

interface ConnectorProvider {
  candidates(requirement: ConnectorRequirement): Promise<ConnectorCandidate[]>
  bind(input: ConnectorBindingInput): Promise<ConnectorBinding>
  invoke(input: ScopedConnectorCall): Promise<ConnectorResult>
}

interface JobProvider {
  schedule(job: AppJob): Promise<JobHandle>
  cancel(handle: JobHandle): Promise<void>
}
```

Each adapter ships a conformance suite. Conformance tests validate behavior,
including tenant isolation, idempotent provision, transaction rollback,
release immutability, audience restriction, credential non-disclosure, and
export/import round trips.

### 12.2 Provider matrix

| Concern | Claxedo default | Portable alternatives | Contract boundary |
|---|---|---|---|
| Source/version | GitHub | GitLab, local Git, archive | Immutable source revision |
| Build | Claxedo Bun builder | GitHub Actions, GitLab CI, local Bun | Reproducible artifact + provenance |
| Artifact storage | R2 | S3-compatible, filesystem | Content-addressed blob |
| Runtime/deploy | Dynamic Worker + Facet | Workers for Platforms, Vercel, conventional Worker, Node/workerd | Release endpoint + isolation grade |
| Identity | Claxedo signed identity | Better Auth, OIDC | Verified external principal |
| App database | Facet SQLite | Turso/libSQL, local SQLite | Customer-scoped SQLite contract |
| Assets | R2 | S3-compatible, filesystem | Customer-scoped object namespace |
| Jobs | Claxedo Wakes | provider cron/queue adapter | At-least-once idempotent job |
| Connections | `@claxedo/connections` | self-hosted implementation of its ports | Narrow capability invocation |
| Billing/entitlement | Claxedo billing | Stripe or custom adapter later | Active entitlement + limits |

Cloudflare Workers for Platforms is a deployment adapter rather than a
required architecture. Its dispatch Worker naturally hosts trusted routing,
authentication, limits, and response policy before invoking isolated user
Workers. Vercel's deployment API can publish immutable preview and production
artifacts, but it does not provide Facet semantics; its profile therefore uses
a stateless release service plus `DatabaseProvider`.

Turso is an appropriate SQLite-compatible adapter for a portable remote
profile. Embedded replicas suit long-running hosts with a filesystem; remote
serverless access suits Vercel and edge functions. The profile chooses one
explicitly rather than making runtime detection part of app code.

### 12.3 Isolation grades

Every deployment profile declares one of:

| Grade | Guarantee |
|---|---|
| `sandboxed-capabilities-only` | Untrusted app code, no ambient egress, explicit bindings, isolated instance storage. |
| `isolated-trusted-publisher` | Publisher code is trusted; customer storage and secrets remain scoped through host adapters. |
| `self-hosted-operator-trusted` | Operator and publisher control the runtime and network policy. |

Portability preserves the application contract. It does not relabel a weaker
runtime as a stronger sandbox.

## 13. Connector and Gatekeeper model

The Content Engine declares connector slots by capability rather than provider:

```text
browser source slot:
  browser.capture
  browser.open-source

publisher slot:
  content.schedule
  content.publication-status
  content.cancel-scheduled
```

A connector provider can satisfy the publisher slot with any compatible
third-party scheduler. The user's setup wizard presents available candidates
and records the selected binding on that user's app instance.

### 13.1 Connection ownership

Connections are customer-scoped:

```text
Content Engine × Alice → Alice scheduler connection
Content Engine × Bob   → Bob scheduler connection
```

The existing `@claxedo/connections` separation between non-secret connection
metadata and credential storage is retained. Its opaque owner partition becomes
the app-scoped customer identity.

### 13.2 Capability invocation

The app receives:

```ts
publisher.stageSchedule({ draftId, channel, publishAt })
publisher.getPublicationStatus({ provisionalId })
publisher.cancelScheduled({ publicationId })
```

It does not receive OAuth tokens, refresh tokens, or unrestricted `fetch`.
Sensitive side effects use asynchronous approval:

1. The connector stages the action.
2. It returns a provisional identifier and simulated status.
3. The agent continues planning.
4. The user approves, edits, or rejects the staged batch.
5. The connector resolves provisional identifiers to provider identifiers.

### 13.3 Revocation

Disconnecting a user connection immediately disables its instance binding.
Pending actions remain visible but cannot commit. Runtime sessions hold
short-lived capability handles; the broker validates binding status on every
mutation and on credential refresh.

## 14. Content Engine domain design

### 14.1 Data model

The private customer database contains no `user_id` columns:

```text
sources
  id, url, canonical_url, title, author, captured_at, capture_method

source_fragments
  id, source_id, quote, selector, context, screenshot_asset_id

annotations
  id, source_fragment_id, note, tags, created_at

ideas
  id, title, thesis, status, source_refs, created_at

drafts
  id, idea_id, channel, body, status, revision, updated_at

schedule_items
  id, draft_id, channel, publish_at, state, provisional_external_id

publications
  id, schedule_item_id, external_id, published_at, url, status

assets
  id, provider_key, media_type, digest, created_at

agent_receipts
  id, operation, initiating_actor, acting_agent, input_refs, output_refs, created_at
```

Large screenshots and media live behind `AssetProvider`; the SQLite database
stores opaque keys and digests.

### 14.2 Agent contract

The plugin skill teaches the Claxedo agent to use domain operations:

```text
content.capture_source
content.search_sources
content.create_idea
content.create_draft
content.revise_draft
content.stage_schedule
content.list_calendar
content.publication_status
```

The UI and the agent call the same server API. An operation performed by an
agent carries both the app customer and the acting agent identity. The agent
cannot cross instance boundaries or resolve its own approval.

### 14.3 Browser capture

Desktop flow uses Claxedo's hardened webview and existing annotation bridge:

```text
user opens source page
  → enables comment/annotation mode
  → selects an element or excerpt
  → browser host captures URL, selector, excerpt, screenshot, and note
  → Content Engine stores a normalized source record
  → focused Claxedo chat receives the same capture as context
```

The mini-app does not embed or control the source site. The trusted Claxedo
browser owns cookies and page interaction.

Web deployments use one of:

- a browser extension that sends an explicit capture to Claxedo;
- a share/import endpoint;
- manual URL and excerpt entry;
- a separately governed remote-browser provider.

Sites that prohibit framing remain outside the managed-app iframe.

### 14.4 Public output

The private Content Engine may generate a public static site or directory as a
separate deployment artifact:

```text
selected published content
  → static export
  → Cloudflare Pages / Vercel / another public host
```

The public artifact contains only selected public data and public endpoint
allowlists. It does not include the private app database, auth session, or user
connectors.

## 15. UX high-level design

### 15.1 Marketplace card

The Content Engine card communicates:

- “Private workspace for research, drafts, and scheduling”;
- installed skills;
- required browser capability;
- required one-of scheduler connector slot;
- default provider profile and available alternatives;
- data location and isolation grade;
- source repository and release provenance.

Primary action: **Install and set up**.

### 15.2 Setup wizard

The wizard has four steps:

1. **Runtime and data** — accept the Claxedo default or choose a configured
   self-hosted profile.
2. **Capture** — enable the desktop browser bridge, browser extension, or manual
   import mode.
3. **Publishing** — connect one compatible scheduler provider.
4. **Review** — show capabilities, data location, approval behavior, and
   release-update policy.

Installation can complete with a missing optional connector. The navigation
entry appears with a setup badge and the affected workflow explains what is
needed.

### 15.3 Global navigation

Installed managed apps appear in a dynamic **Apps** section. Each entry has:

- manifest-provided label and host-approved icon;
- active, setup-required, update-available, and error states;
- a context menu for connections, data export, release channel, disable, and
  uninstall.

The shell renders one first-party `ManagedAppSurface`; plugin code never renders
inside the trusted navigation tree.

### 15.4 Content Engine surface

The app's primary navigation contains:

| View | Purpose |
|---|---|
| **Inbox** | Recent captures and unprocessed annotations. |
| **Library** | Searchable sources, excerpts, notes, and tags. |
| **Ideas** | Theses and content opportunities derived from sources. |
| **Studio** | Draft editor with source citations and AI actions. |
| **Calendar** | Staged, approved, scheduled, and published content. |
| **Connections** | Capture mode and scheduler health. |
| **Settings** | Export, privacy, release channel, support access, and provider profile. |

The Claxedo chat stays available beside the surface. “Ask AI” focuses the
existing chat with the current app selection as context; it does not open an
app-owned chatbot.

### 15.5 Publisher console

The publisher sees:

- release history, provenance, preview, rollout, and rollback;
- capability diffs and required customer re-consent;
- customer roster, entitlement, version, usage, and instance health;
- aggregate operational metrics with no private content payloads;
- support-access requests and audit trails;
- provider-profile export and deployment diagnostics.

## 16. User journeys

### 16.1 Publisher releases the Content Engine

1. Publisher installs the development plugin into a Claxedo project.
2. Claxedo resolves the locked source revision.
3. The build produces immutable UI/server artifacts, a schema bundle, and a
   capability digest.
4. A preview deployment creates a fresh test customer and instance.
5. Automated conformance and migration tests run against the selected profile.
6. Publisher reviews the UI and capability diff.
7. Publisher promotes the release to the stable channel.
8. Customer instances adopt it according to rollout policy.

### 16.2 Customer installs the app

1. Alice selects Content Engine in the marketplace.
2. Claxedo authenticates Alice and creates an app-scoped customer under the
   Content Engine publisher.
3. Alice chooses the default provider profile and connects a scheduler.
4. Claxedo records her entitlement and connector binding.
5. Content Engine appears in global navigation.
6. First open provisions Alice's private instance and applies schema
   migrations.

### 16.3 Customer captures research

1. Alice opens a source in the Claxedo desktop browser.
2. She annotates an element and adds a note.
3. The trusted browser bridge sends a structured capture to her Content Engine
   instance and adds it to the focused Claxedo chat context.
4. The app deduplicates the canonical source and stores the fragment,
   screenshot key, and provenance.
5. Inbox shows the new capture immediately.

### 16.4 Customer creates content with AI

1. Alice selects several sources and chooses **Develop an idea**.
2. Claxedo chat invokes the Content Engine skill and scoped app operations.
3. The agent creates an idea and a cited draft in Alice's instance.
4. Studio opens the draft and shows its source lineage.
5. Alice edits directly or asks the same Claxedo chat for revisions.

### 16.5 Customer schedules publication

1. Alice selects a draft and publication time.
2. The scheduler connector stages the action and returns a provisional item.
3. Calendar renders the provisional scheduled state.
4. Alice approves the staged batch.
5. The connector commits the action and maps the provisional ID to the external
   publication ID.
6. A background job refreshes publication status idempotently.

### 16.6 Publisher rolls out an update

1. Release v13 changes code but retains the same capability digest.
2. Claxedo upgrades a canary cohort.
3. The instance migration runs once under a schema lease.
4. Health checks pass and rollout continues.
5. Existing customer data and connections remain attached to their instances.

If v13 requests a new connector capability, affected customers remain on v12
until they review and grant it or the publisher marks the capability optional.

### 16.7 Customer self-hosts

1. Alice exports the plugin source reference, deployment manifest, database
   export, asset archive, and connector reauthorization checklist.
2. The self-host tool validates a Better Auth, runtime, database, asset, and job
   provider profile.
3. It provisions the destination instance and applies schema migrations.
4. It imports data and assets, verifies digests and row counts, and requires
   external connectors to be reauthorized.
5. Alice validates the destination before switching her app URL.

Credentials are never exported as plaintext.

## 17. Security and privacy model

### 17.1 Threat boundaries

| Boundary | Trust decision |
|---|---|
| Plugin package | Content-addressed, locked, integrity-checked supply-chain input. |
| App iframe | Untrusted UI, opaque origin, restrictive CSP, MessagePort-only host access. |
| App server | Untrusted in hardened profile; trusted publisher code in portable profile. |
| Auth gateway | Trusted identity verification and audience restriction. |
| Instance router | Trusted customer-to-instance mapping; locator never accepted from client input. |
| Database adapter | Trusted instance scoping and migration enforcement. |
| Connector broker | Trusted credential isolation, capability scope, approval, and audit. |
| Publisher | Controls future code releases, but receives no default private-data read capability. |

### 17.2 Release permissions

Every release records:

- UI and server artifact digests;
- source revision and builder provenance;
- database schema version;
- connector capability set;
- browser and asset permissions;
- network policy and isolation grade.

Code-only changes can roll out automatically. Capability widening, data export,
support access, or isolation downgrade requires explicit policy and customer
communication.

### 17.3 Publisher power

A maintained app necessarily asks customers to trust publisher updates. Claxedo
reduces this power through immutable releases, capability diffs, egress denial
in the hardened profile, staged rollout, customer-visible provenance, and
auditable support access. A portable trusted-publisher deployment states that
the operator and publisher can change server code and network policy.

### 17.4 Data lifecycle

- Uninstall disables execution before beginning retention or deletion policy.
- Export remains available during the configured retention window.
- Deletion removes database, asset namespace, connector bindings, app sessions,
  and derived search indexes.
- Publisher-level analytics use counts and health states, not private content.
- Backups and exports carry deployment, instance, schema, and digest metadata.

## 18. Versioning, migrations, and rollback

Releases use semantic channels rather than mutable tags:

```text
preview → canary → stable
```

An instance stores its current release and schema version. Opening an instance
performs:

1. resolve target release;
2. compare capability digest and consent state;
3. acquire an instance migration lease;
4. create a provider backup/checkpoint when available;
5. apply ordered, checksum-verified migrations;
6. record the new schema and release;
7. start the runtime.

Code rollback is immediate when the prior release supports the current schema.
Destructive schema rollback requires a forward repair migration or backup
restore. Release metadata declares `minimum_schema` and `maximum_schema` so an
unsafe rollback is rejected before execution.

## 19. Reliability and operations

- Instance provisioning is idempotent on `(deployment_id, customer_id)`.
- Connector mutations require idempotency keys and persist provisional state
  before contacting external providers.
- At-least-once jobs store a dedupe key in the customer database.
- Runtime health is separate from connector health; one failed connector does
  not make the private library unreadable.
- App surfaces display explicit states for provisioning, migration, offline,
  connector action required, suspended entitlement, and unsupported release.
- Release logs contain instance/customer opaque identifiers and never payload
  content by default.
- Provider conformance tests run against disposable real backends before an
  adapter can be selected for production.

## 20. Portability and export contract

Portability has three layers:

1. **Source portability** — Git repository plus lockable revisions and a vendor-
   neutral plugin/app manifest.
2. **Runtime portability** — provider ports and the portable execution subset.
3. **Data portability** — ordered SQLite migrations, a documented logical
   export, asset archive, and connector reauthorization manifest.

The export bundle is:

```text
content-engine-export/
  manifest.json
  database.sqlite             # when provider can emit canonical SQLite
  data.ndjson                 # required logical fallback
  assets/
  asset-digests.json
  connector-requirements.json # identifiers and scopes, never secrets
  verification.json           # counts, schema version, source release
```

Provider-specific locators and credentials remain outside the portable bundle.

## 21. Inspirations

### Cloudflare OS

Cloudflare OS supplies the strongest runtime patterns:

- dynamic code and persistent instance state have separate lifecycles;
- Dynamic Workers load versioned code with explicit bindings and denied egress;
- Facets give each instance isolated SQLite;
- opaque-origin iframes communicate over host-provided RPC;
- Gatekeepers keep credentials outside generated code and stage sensitive
  actions asynchronously;
- blueprints distinguish reusable code from shared live state.

This design adds the distribution mode Cloudflare OS does not center: one
maintained release referenced by many private user instances.

### Stripe Connect

The useful analogy is hierarchical product tenancy:

```text
platform → publisher → app deployment → app customers
```

Claxedo owns the underlying identity and infrastructure; the publisher owns
the app-customer relationship. Payment settlement is a future adapter rather
than part of the identity model.

### Cloudflare Workers for Platforms

Its dispatch namespace and trusted dispatch Worker validate the separation
between platform routing/policy and isolated customer code. It is a strong
deployment adapter for generated-code platforms, while the app contract remains
portable to other runtimes.

### Better Auth

Its adapter-based database model and organization plugin make it a suitable
self-hosted `AuthProvider`. Claxedo consumes only the verified-principal
contract, keeping Better Auth schema and session implementation outside app
code.

### Turso/libSQL

SQLite compatibility, remote serverless clients, and local/embedded options
make Turso a practical `DatabaseProvider` for profiles that cannot use Facet
SQLite. The selected client mode is explicit because filesystem-backed replicas
and serverless fetch clients have different operational constraints.

## 22. Alternatives considered

### A. Fork Cloudflare OS and replace its chat

This reuses the most code but binds Claxedo to Overseer identity, chat, sharing,
Yjs code history, and Cloudflare-specific runtime orchestration. The central
Overseer is not a clean hosting API. It also lacks the managed-release/private-
instance distribution mode. The design instead extracts its runtime and
security patterns.

### B. Install one blueprint per customer

This produces correct data isolation and easy customization, but every customer
owns an independent code fork. Publisher updates, coherent migrations, support,
and capability consent become fleet reconciliation problems. Blueprints remain
the explicit **Fork with AI** operation.

### C. One shared multi-tenant database with `user_id`

This matches conventional SaaS deployment and supports global queries, but it
requires a trusted row-authorization layer for every read, write, subscription,
export, and background job. The Content Engine does not need cross-customer
queries, so instance-scoped SQLite is the smaller and safer primitive.

### D. One full deployment per customer

This maximizes infrastructure isolation but makes releases, domains, cold start,
observability, and cost scale with customer count. The default uses one release
artifact and lazy customer instances; a provider may still choose full per-
customer deployment behind `InstanceProvider`.

### E. Render plugin UI directly in the trusted SolidJS tree

This gives maximal UI integration but makes third-party code part of Claxedo's
origin and privilege boundary. The design uses a first-party surface renderer
and sandboxed app iframe, while keeping shell contributions declarative.

### F. Standardize on one infrastructure vendor

This minimizes initial adapter work but embeds vendor identity, storage, and
deployment assumptions in application code. The default profile remains
opinionated; provider ports and conformance suites preserve an exit path.

## 23. Tradeoffs

| Decision | Benefit | Cost |
|---|---|---|
| Per-customer instance storage | Strong isolation; no row tenancy logic | Cross-customer analytics require a separate aggregate plane |
| Centrally maintained releases | Coherent fixes and migrations | Customers trust publisher updates |
| Declarative plugin UI contribution | Keeps trusted shell safe | App UI cannot inject arbitrary native SolidJS components |
| SQLite-compatible portable subset | Facet, Turso, and local parity | Avoids provider-exclusive database features |
| Capability-only connectors | Secrets and side effects stay governed | Connector adapters require more design than raw OAuth + fetch |
| App-scoped identity | Publisher customer roster without cross-app leakage | Identity mapping and account recovery become control-plane responsibilities |
| Isolation grades | Honest portability | Profiles are not security-equivalent |
| Export/import before live migration | Achievable provider escape hatch | Cutover includes downtime and connector reauthorization |

## 24. Alignment with current Claxedo architecture

The design extends existing seams rather than creating parallel systems:

- `@claxedo/agent-extensions` already owns locked installation,
  materialization, replay, and conflict detection; its manifest discovery gains
  managed-app and connector declarations.
- `@claxedo/connections` already separates non-secret connection metadata from
  credential storage through host-provided ports; app-customer identity becomes
  its owner partition for managed-app bindings.
- `ContributionRegistry` already models string-addressed surfaces and gates.
  Managed apps add a persistent package-owned tier and declarative navigation
  contribution; executable renderers remain first-party.
- The browser pane already exposes screenshot, inspect, selected-node, and
  user-gated agent evaluation primitives. Content Engine adds a durable capture
  sink rather than another browser implementation.
- Route postures already require public and signed intent to be named. Managed
  app routes use signed app-customer posture and audience restriction.

The app shell needs two structural changes:

1. `ContentMeta` becomes extensible so a managed-app payload can reach a
   string-addressed surface.
2. Global navigation consumes declarative registered entries instead of a
   closed list and closed icon union.

## 25. Roadmap sequencing and file-level contention

### Phase 0 — security prerequisite

Land Milestone 0 of the multiplayer plan before agent-authored app installation
or deployment. Arbitrary process/session execution without the planned role and
path gates invalidates every higher-level sandbox claim.

### Phase 1 — identity foundation

Land multiplayer Milestone 2a before production managed-app ownership:

- personal and team org identities are stable;
- `actor_id` is carried through signed authority tokens;
- app publisher ownership uses `org_id`;
- app customers map to the existing users/actors registry rather than a second
  global identity table.

The Content Engine can launch for personal-org customers after 2a. Any flow that
places its AI transcript in a shared workspace also depends on Milestone 2c's
private-session boundary. Milestone 2b attribution enriches receipts but is not
a storage-isolation prerequisite.

### Phase 2 — contracts before providers

Introduce a provider-neutral managed-app package containing:

- manifests and decoders;
- control-plane record contracts;
- provider ports;
- conformance suites;
- release/capability digest rules;
- logical export/import format.

This phase has no hosted database dependency and can proceed while tenancy
schema work settles.

### Phase 3 — extension and shell integration

- Extend agent-extension discovery/materialization for managed-app and connector
  components.
- Add a persistent package contribution tier and dynamic navigation entries.
- Open the content metadata path to registered string-addressed surfaces.
- Add the first-party `ManagedAppSurface` iframe/RPC host.
- Persist installed app/navigation state across restart.

Primary files with expected contention:

```text
packages/agent-extensions/src/manifest.ts
packages/agent-extensions/src/discovery.ts
packages/agent-extensions/src/types.ts
packages/claxedo-app/src/app/integrations/registry.ts
packages/claxedo-app/src/app/workbench/rail/global-navigation.tsx
packages/claxedo-app/src/app/workbench/state/types.ts
packages/claxedo-app/src/app/workbench/review/review-workspace.tsx
```

### Phase 4 — default hosted provider profile

- Add managed-app control-plane/domain services.
- Add Claxedo auth and principal-map adapters.
- Add Cloudflare release/runtime/Facet SQLite adapters.
- Add R2 assets, Wakes jobs, and Connections connector adapters.
- Add preview, canary, migration, rollout, and rollback flows.

Hosted authority records will contend with the multiplayer plan in
`convex/schema.ts`. B1, B2, B4, and B5 already share that file. Managed-app
tables land only in a scheduled schema wave with one owner, preferably as an
EXPAND migration after 2a's org/project identities are stable. The provider-
neutral contracts and SQLite/self-host adapter can proceed independently.

### Phase 5 — Content Engine reference plugin

- Implement schema and domain operations.
- Materialize Content Engine skills.
- Connect the existing browser annotation bridge to the durable capture sink.
- Implement the scheduler connector slot and staged approvals.
- Ship Inbox, Library, Ideas, Studio, Calendar, Connections, and Settings.
- Prove customer isolation with two authenticated users on one release.

### Phase 6 — portability proof

Prove the contract with one non-default vertical profile:

```text
GitLab or local Git
Vercel or self-hosted Node
Better Auth
Turso/libSQL
S3-compatible assets
```

The proof must deploy the same Content Engine release contract, create two
isolated customers, migrate/export/import data, rebind connectors, and pass the
provider conformance suite.

## 26. Success criteria

- One publisher releases one Content Engine version and two authenticated
  customers run it against provably isolated data and connections.
- Publisher rollout upgrades both instances without copying source or losing
  data.
- Neither UI nor server code can select another customer's instance.
- The app contains no login implementation and no customer-level `user_id`
  filtering.
- Skills operate through Claxedo's existing AI chat and act on the same data as
  the app UI.
- Browser annotation creates a durable, searchable capture in the correct
  customer instance.
- Scheduling uses a user-owned connector, returns provisional state, and
  requires the configured approval policy.
- Installed navigation and app state survive desktop/web restart.
- A release capability widening is blocked pending required customer consent.
- The same app contract passes both the Claxedo hosted profile and one
  Better Auth + Turso portable profile.
- Data export/import preserves logical row counts, asset digests, schema
  version, and source provenance without exporting credentials.

## 27. Open decisions before implementation planning

1. **Customer acquisition surface:** whether a managed app can accept branded
   signup on its own domain in the first release or initially requires an
   existing Claxedo account and marketplace install.
2. **Publisher visibility:** the exact display-safe customer fields exposed in
   the publisher roster.
3. **Default release policy:** automatic stable rollout versus publisher-
   selected canary percentage and maintenance window.
4. **Storage topology:** database-per-customer versus signed tenant partitions
   for the Turso adapter; both must satisfy the same isolation conformance tests.
5. **Connector approval default:** approval for every scheduled publication
   versus explicit per-channel auto-approval rules.
6. **Data retention:** uninstall retention period and whether suspended
   entitlements preserve read-only export access.
7. **Billing boundary:** whether initial entitlement is free/manual or backed by
   Claxedo billing before publisher-managed pricing ships.

## 28. References

### Local architecture

- `packages/agent-extensions/docs/architecture.md`
- `packages/claxedo-connections/docs/architecture.md`
- `packages/claxedo-app/src/app/integrations/registry.ts`
- `packages/claxedo-app/src/features/browser/store/browser-pane-context.tsx`
- `packages/claxedo-server/src/platform/auth/postures.ts`
- `docs/plans/2026-08-01-002-refactor-single-tenant-today-multiplayer-ready-plan.md`
- Cloudflare OS: `packages/workshop-backend/src/overseer.ts`,
  `docs/blueprints.md`, `docs/sharing.md`, and `docs/observers.md`

### Provider documentation

- [Cloudflare Dynamic Workers](https://developers.cloudflare.com/dynamic-workers/)
- [Cloudflare Workers for Platforms architecture](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)
- [Vercel deployment API overview](https://vercel.com/docs/deployments/overview)
- [Better Auth database adapters](https://better-auth.com/docs/concepts/database)
- [Better Auth organizations](https://better-auth.com/docs/plugins/organization)
- [Turso TypeScript clients](https://docs.turso.tech/sdk/ts/reference)
- [Turso embedded replicas](https://docs.turso.tech/features/embedded-replicas/introduction)
