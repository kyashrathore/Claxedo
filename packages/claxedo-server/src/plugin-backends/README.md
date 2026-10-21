# App plugins on the hosted Worker

An organization's owners and admins install app plugins from the Claxedo registry; each member then enables the ones they use, and until then downloads nothing and reaches nothing. A plugin can ship a backend: one Workers module the hosted Worker loads as a Dynamic Worker, with Durable Object storage that belongs to that organization and plugin. The runtime itself, its supervisor, capabilities, caller handles and epochs, is `@claxedo/plugin-runtime` (`packages/plugin-runtime/README.md`); this directory is what the hosted Worker adds around it. App plugins exist only for signed-in accounts.

## The manifest

`claxedo.backend` in the plugin's `package.json` (`@claxedo/plugin-api`, `pluginBackendSchema`):

| Field | Meaning |
| --- | --- |
| `entry` | The backend module, relative to the package root. Its default export answers the plugin's routes; it also exports every object class. |
| `objects` | The Durable Object classes the entry exports. Only these can be reached through `env.PLATFORM.object`. |
| `outbound` | The hosts the backend may `fetch`, over https on the default port. Everything else is refused. |
| `routes` | `METHOD /path` patterns the backend serves. `:name` matches one segment and a trailing `*` one or more. A request for anything else is refused before it reaches the plugin, and no route may sit under `/_`, which is the platform's. |
| `tools` | Optional. The agent tools the backend serves: a `group` (`id`, `label`) and the `definitions` module. A release cannot carry them until P6. |

The top-level `permissions` list names the platform calls the backend may make (`projects.read`, `blobs`, `events`, `schedule`, `links`, `sessions.read`, `sessions.start`, `workspaces.cloud`, and the ones later slices serve).

## Releases and the registry

A release (`@claxedo/plugin-api/release`) is `{ id, version, manifest, app: { sha256, size }, backend?: { sha256, size }, storage, builtAt }`, signed with Ed25519 over its canonical JSON. `@claxedo/plugin-build`'s `buildPluginRelease` builds both bundles and names each by its full SHA-256; `signPluginRelease` signs it, and `claxedo-plugin-build/src/release-cli.ts` writes a signed release and its blobs as a registry tree. The tree's `index.json` (`@claxedo/plugin-api/registry-index`) is a signed list of `{ id, name, description?, latest, versions, manifest }`, versions newest first and `manifest` the latest's; the CLI re-signs it with each release it publishes (`indexWithRelease`, `signPluginIndex`), taking the description from the package's own `description`.

The registry serves `index.json`, `releases/<id>/<version>.json` and `blobs/<sha256>`, from `CLAXEDO_APP_PLUGIN_REGISTRY_URL` (default `https://plugins.claxedo.dev`). `registry.ts` verifies the signature under `PLUGIN_REGISTRY_KEYS`, that the release names the id and version asked for, and each blob's size and SHA-256 before anything is stored. `registry-test-key.ts` adds a key from `CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY` for test compositions only; `deployment-closures.test.ts` refuses any deployed Worker that reaches it.

## Storage

- **D1** (control-plane baseline):
  - `app_plugin_installs`: one row per organization and plugin, with the version, whether the organization has it active, both bundle hashes, the manifest, the signed release and who installed it.
  - `app_plugin_enablements`: each member's own choice.
  - `app_plugin_org_defaults`: an admin's positive default for members who made no choice.
  - `app_plugin_epochs`: the epoch every backend capability is fenced by. It rises on every install, update, disable, re-enable and uninstall, and is never deleted, so a reinstall continues from it and a supervisor that remembers the uninstalled run reads the reinstall as newer.
  - `app_plugin_links`: each live public link by its token's SHA-256, with the plugin and path it reads, who made it, and when it expires or was revoked.
  - `plugin_session_origins`: the session each of a plugin's origins (`scope`, `key`) started, with its workspace, its placement and the configuration digest its reservation was made under. A cloud row's workspace is that origin's own root, which the session host never offers as a project's workspace.
- **R2** (`CLAXEDO_AGENT_PLUGINS`, typed `AppPluginsBucket` in `bundles.ts`):
  - bundles under `plugin-apps/<sha256>.js` and `plugin-backends/<sha256>.js`. They are content-addressed and shared by every organization that installs the same release, so an uninstall never deletes one;
  - each plugin's blobs under `plugin-data/<orgId>/<pluginId>/<key>`.

A member's app loads a plugin, and its requests reach the backend, only while the plugin is installed, active in the organization and enabled for them: their own choice, else the organization's default, else off.

## Routes

Every route reads the signed caller and asks the authority for their organization (`org-caller.ts`): no credential is a 401, an unknown principal a 401, no active organization a 403. The caller never names an organization. Admin routes need `administer` on that organization (owners and admins), else 403 `app_plugin_admin_required`.

`/api/claxedo/app-plugins` (`app-plugin-routes.ts`). An install answers `{ id, version, active, manifest, app: { sha256 } }`.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /` | member | The installs the caller's app loads. |
| `GET /installed` | member | Every install, with `enabledForMe` and `orgDefault`. |
| `GET /catalog` | member | `{ canManage, registry, plugins }`: whether the caller manages the organization's installs, and the registry's signed index, each entry `{ id, name, description?, latest, versions, manifest, available }`, where `available` is false for a backend this deployment cannot run. An index that is missing or does not verify answers `registry: "unavailable"` with no plugins; the installs are still `GET /installed`'s. |
| `GET /:id/bundles/:sha256/app.js` | member | The app bundle, as immutable JavaScript; 404 `app_plugin_bundle_not_found` unless `GET /` holds it with that hash. |
| `POST /:id/enable`, `DELETE /:id/enable` | member | 204; 404 `app_plugin_not_installed`. |
| `POST /` `{ id, version }` | admin | 201 with the install; 409 `app_plugin_installed`, 422 `app_plugin_release_invalid`, 502 `app_plugin_release_unavailable`, 409 `app_plugin_platform_unavailable` for a backend where no supervisor runs. |
| `POST /:id/update` `{ version }` | admin | 200 with the install; 409 `app_plugin_storage_downgrade` for a release whose `storage` is lower than the installed one's. |
| `POST /:id/disable`, `DELETE /:id/disable` | admin | 204. Off and back on for everyone; storage is kept. |
| `POST /:id/default`, `DELETE /:id/default` | admin | 204. |
| `DELETE /:id` | admin | 204, after deleting the install, every member's choice, its links and everything the plugin stored. |
| `GET /links/:token` | anyone | The path the plugin's live link was created for, answered by the backend as a `link` caller while the plugin is installed and active; 404 `plugin_link_not_found` otherwise. Documents still owns `/p` until its cutover, so links live here. |

`ALL /api/plugins/:pluginId/*` (`routes.ts`) answers 404 `plugin_not_activated` unless the organization has the plugin installed and active, and 404 `plugin_not_enabled` unless the caller has it enabled. Otherwise the request goes to the plugin's supervisor (`pluginSupervisor(namespace, { orgId, pluginId })`) with the caller's user id, which the runtime turns into a caller handle. Only the body and its `content-type` are forwarded, and only the plugin's status, body and `content-type` come back, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, because the answer is served from the control plane's own origin.

## The platform on this host

The runtime admits every platform call a backend makes (`packages/plugin-runtime/README.md`) and hands the hosted Worker the ones it answers, through `hostedPlatform` (`platform-host.ts`):

- **projects**: `projects.list` answers `{ id, repoKey }` of the organization's projects the caller may read, and `projects.authorize` the caller's `read` or `write`. Both use the D1 authority's own project rule (`may`, `maySql`), so a member is a project's viewer and an owner or admin more.
- **blobs**: R2 under the plugin's prefix, with the content type as HTTP metadata. `CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES` sets the quota the runtime holds; absent, it is 1 GiB.
- **events**: one `plugin.event` per recipient, nudged into the organization's live-sync room. The recipients are the members with the plugin enabled; for a `project` event, those of them who may read the project, which the publisher must read too (else 403 `plugin_project_forbidden`); for `caller`, the caller alone. `eventVisibleTo` delivers each copy only to the member it names.
- **links**: a 32-byte token, stored only as its SHA-256, at most 1,000 live per plugin.
- **sessions** (`sessions/platform.ts`): through the deployment's session host (`sessions/`), the one hosted Tasks starts through too, as the caller's canonical human actor (`ownerGrant` dispatch and reservation). A start needs write on the project and runs in the caller's own workspace of it, or for `placement: "cloud"` in the origin's own root (`workspace/origin-cloud-workspace.ts`), filed and started through the create route's admission. Its session id is `ses_plugin_<hash>` of `app-plugin.v1:<org>:<plugin>:<scope>:<key>`, so a start sent again finds the session it created, and each start is recorded in `plugin_session_origins`; a handoff, an abandonment and a state reading name only a session recorded there (404 `plugin_session_origin_unknown`). `continueFrom` is read only when the caller may open that session in this organization, asked at the read (403 `plugin_session_forbidden`). Refusals of the session core answer `plugin_session_<code>`: 400 `invalid_input`, 403 `forbidden`, 409 `conflict`, 422 `unsupported`, 429 `rate_limited`; a digest that moved is 409 `plugin_session_digest_stale`, and a member-driven session's agent is 403 `plugin_session_start_refused`. A Worker composition without a session host answers 503 `plugin_sessions_unavailable`.

`identity.caller` carries no display name: the control-plane database holds no person's name, and the Better Auth database that does is not the supervisor's.

## Lifecycle

`lifecycle.ts` verifies a release and copies both bundles into R2 before any row names them, writes D1, then refreshes the plugin's supervisor, so the previous configuration's objects stop at once rather than at the next request. Uninstall deletes the rows, the plugin's links and its session origins; the sessions themselves are their starters' and stay. It then has the supervisor purge, which deletes each facet its registry names, and only then its own storage with its wakes and blob accounting (the Cloudflare gate found that a running facet outlives `deleteAll`). Finally it deletes the plugin's `plugin-data/<orgId>/<pluginId>/` prefix. The data is deleted even when no install was found, so an uninstall that failed after its rows were deleted completes on retry.

`compose.ts` builds the routes for the Agent Plugins entries; `composeBetterAuthD1AgentPlugins` takes the registry's keys as `registryKeys`, by default `PLUGIN_REGISTRY_KEYS`. Two test compositions add the test key: `fixtures/worker.fixture.ts` for this suite, and `fixtures/full-hosted.fixture.cf.ts`, the full-hosted Worker (`createFullHostedWorker(registryKeysWithTestKey)`) the app's signed e2e stack runs when a flow asks for a registry (`packages/claxedo-app/e2e/README.md`).

## Deployment

The Agent Plugins artifacts (`scripts/deploy/wrangler-config.ts`) bind `CLAXEDO_AGENT_PLUGINS`, `PLUGIN_LOADER` (`[[worker_loaders]]`) and `PLUGIN_SUPERVISOR`, and add migration `v2` with `new_sqlite_classes = ["PluginSupervisor"]`. Their entries export `PluginSupervisor` (`hostedPluginSupervisorClass` in `supervisor.cf.ts`: the runtime's class over `hostedPluginHostPort`, which reads `app_plugin_installs` and the backend bundle, and answers session calls over the session host the entry's own composition builds), `PluginPlatform` and `PluginOutbound`. The hosted compatibility flags include `enable_ctx_exports`. The base artifact carries none of this and serves no app plugins.

## Tests

`plugin-backends.workerd.test.ts` bundles `fixtures/worker.fixture.ts` with Wrangler and runs it in Miniflare with a real D1 database, R2 bucket, Worker Loader and supervisor. It signs releases of the counter plugin in `fixtures/counter` with a generated key into a registry the outbound service serves. The identity provider is the one stand-in: a bearer token carries the principal the provider would have verified, and the D1 authority checks it against its identity rows. The suite covers:

- installs: a member who is not an admin is refused every admin route; a tampered release, a tampered blob, an unknown key, a missing release and an invalid version install nothing; a second install is refused;
- enablement: members reach nothing, neither the list, the bundle nor the backend, until they enable it; an organization default enables it for members with no choice, and a member's own choice wins;
- the backend: per-organization counting, another organization reaching nothing until it installs, and two plugins in one organization kept apart;
- caller handles: the signed caller, forged headers ignored, a handle outliving its request, and naming nobody in another plugin or after a re-enable; and an object learning its own name;
- refusals: no credential, an unknown principal, no organization, an undeclared route or object class, the root route, a plugin that throws, and outbound limits;
- updates: a new epoch over the same storage, a refused storage downgrade, a manifest-only release, and a bundle the bucket lost;
- disable and re-enable: they reach running objects at once, raise the epoch, and leave a request held across them reaching no object, network or caller;
- the platform:
  - identity with the caller's origin;
  - projects listed and authorized as the caller;
  - a call refused for an undeclared permission;
  - blobs in the plugin's prefix, under the quota (`CLAXEDO_APP_PLUGIN_BLOB_QUOTA_BYTES` is 64 bytes there), refused a `..` key, and unreachable from another organization;
  - events reaching only enabled members of their audience, one copy each, and refused for a project the caller cannot read or data over 8 KiB;
  - a wake that fires once as a system caller while `/_wake` stays unreachable from a request;
  - a link read anonymously as a link caller that cannot act as a person, and refused once expired or revoked;
  - a held request refused every platform call once its epoch ended;
  - sessions: a start in the project's workspace recorded under its origin and answered again for a resent start, a stale digest refused, a first message with the plugin's image sent once, state read from the registry, an abandonment that deletes a session no message reached and keeps one a message did, `continueFrom` refused for a session the caller cannot open, a cloud start in the origin's own root that a later local start does not take, nothing reached from another organization, and the origins deleted by an uninstall. The relay's workspace runtime is the test's outbound service, and the session host's sandbox manager, relay token mint and registration hooks are `test-support/hosted-session-fixture.ts`, which the Tasks workerd suite shares;
- uninstall: it deletes the plugin's objects, a running one included, its blobs, wakes and links, and every member's choice, while another plugin's data stays and a reinstall continues the epoch. The live-sync room is the fixture's `RecordingRoom`, which records nudges.

`supervisor.test.ts` in the runtime pins the purge's order against the real supervisor class. `sessions/platform.test.ts` pins the caller rules (a member-driven agent refused a start before anything is read), and `sessions/reads.test.ts` the session host's D1 reads.
