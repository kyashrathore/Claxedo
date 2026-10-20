# App plugins on the hosted Worker

An organization's owners and admins install app plugins from the Claxedo registry; each member then enables the ones they use, and until then downloads nothing and reaches nothing. A plugin can ship a backend: one Workers module the hosted Worker loads as a Dynamic Worker, with Durable Object storage that belongs to that organization and plugin. The runtime itself, its supervisor, capabilities, caller handles and epochs, is `@claxedo/plugin-runtime` (`packages/plugin-runtime/README.md`); this directory is what the hosted Worker adds around it. App plugins exist only for signed-in accounts.

## The manifest

`claxedo.backend` in the plugin's `package.json` (`@claxedo/plugin-api`, `pluginBackendSchema`):

| Field | Meaning |
| --- | --- |
| `entry` | The backend module, relative to the package root. Its default export answers the plugin's routes; it also exports every object class. |
| `objects` | The Durable Object classes the entry exports. Only these can be reached through `env.PLATFORM.object`. |
| `outbound` | The hosts the backend may `fetch`, over https on the default port. Everything else is refused. |
| `routes` | `METHOD /path` patterns the backend serves. `:name` matches one segment and a trailing `*` one or more. A request for anything else is refused before it reaches the plugin. |

## Releases and the registry

A release (`@claxedo/plugin-api/release`) is `{ id, version, manifest, app: { sha256, size }, backend?: { sha256, size }, storage, builtAt }`, signed with Ed25519 over its canonical JSON. `@claxedo/plugin-build`'s `buildPluginRelease` builds both bundles and names each by its full SHA-256; `signPluginRelease` signs it, and `release-cli.ts` writes a signed release and its blobs as a registry tree.

The registry serves `releases/<id>/<version>.json` and `blobs/<sha256>`, from `CLAXEDO_APP_PLUGIN_REGISTRY_URL` (default `https://plugins.claxedo.dev`). `registry.ts` verifies the signature under `PLUGIN_REGISTRY_KEYS`, that the release names the id and version asked for, and each blob's size and SHA-256 before anything is stored. `registry-test-key.ts` adds a key from `CLAXEDO_APP_PLUGIN_REGISTRY_TEST_KEY` for test compositions only; `deployment-closures.test.ts` refuses any deployed Worker that reaches it.

## Storage

- **D1** (control-plane baseline):
  - `app_plugin_installs`: one row per organization and plugin, with the version, whether the organization has it active, both bundle hashes, the manifest, the signed release and who installed it.
  - `app_plugin_enablements`: each member's own choice.
  - `app_plugin_org_defaults`: an admin's positive default for members who made no choice.
  - `app_plugin_epochs`: the epoch every backend capability is fenced by. It rises on every install, update, disable, re-enable and uninstall, and is never deleted, so a reinstall continues from it and a supervisor that remembers the uninstalled run reads the reinstall as newer.
- **R2** (`CLAXEDO_AGENT_PLUGINS`): bundles under `plugin-apps/<sha256>.js` and `plugin-backends/<sha256>.js` (`bundles.ts`). They are content-addressed and shared by every organization that installs the same release, so an uninstall never deletes one.

A member's app loads a plugin, and its requests reach the backend, only while the plugin is installed, active in the organization and enabled for them: their own choice, else the organization's default, else off.

## Routes

Every route reads the signed caller and asks the authority for their organization (`org-caller.ts`): no credential is a 401, an unknown principal a 401, no active organization a 403. The caller never names an organization. Admin routes need `administer` on that organization (owners and admins), else 403 `app_plugin_admin_required`.

`/api/claxedo/app-plugins` (`app-plugin-routes.ts`). An install answers `{ id, version, active, manifest, app: { sha256 } }`.

| Route | Who | Answer |
| --- | --- | --- |
| `GET /` | member | The installs the caller's app loads. |
| `GET /installed` | member | Every install, with `enabledForMe` and `orgDefault`. |
| `GET /:id/bundles/:sha256/app.js` | member | The app bundle, `text/javascript`, immutable; 404 `app_plugin_bundle_not_found` unless `GET /` holds it with that hash. |
| `POST /:id/enable`, `DELETE /:id/enable` | member | 204; 404 `app_plugin_not_installed`. |
| `POST /` `{ id, version }` | admin | 201 with the install; 409 `app_plugin_installed`, 422 `app_plugin_release_invalid`, 502 `app_plugin_release_unavailable`, 409 `app_plugin_platform_unavailable` for a backend where no supervisor runs. |
| `POST /:id/update` `{ version }` | admin | 200 with the install; 409 `app_plugin_storage_downgrade` for a release whose `storage` is lower than the installed one's. |
| `POST /:id/disable`, `DELETE /:id/disable` | admin | 204. Off and back on for everyone; storage is kept. |
| `POST /:id/default`, `DELETE /:id/default` | admin | 204. |
| `DELETE /:id` | admin | 204, after deleting the install, every member's choice and everything the plugin stored. |

`ALL /api/plugins/:pluginId/*` (`routes.ts`) answers 404 `plugin_not_activated` unless the organization has the plugin installed and active, and 404 `plugin_not_enabled` unless the caller has it enabled. Otherwise the request goes to the plugin's supervisor (`pluginSupervisor(namespace, { orgId, pluginId })`) with the caller's user id, which the runtime turns into a caller handle. Only the body and its `content-type` are forwarded, and only the plugin's status, body and `content-type` come back, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`, because the answer is served from the control plane's own origin.

## Lifecycle

`lifecycle.ts` verifies a release and copies both bundles into R2 before any row names them, writes D1, then refreshes the plugin's supervisor, so the previous configuration's objects stop at once rather than at the next request. Uninstall deletes the rows, then has the supervisor purge: it deletes each facet its registry names, and only then its own storage (the Cloudflare gate found that a running facet outlives `deleteAll`). The purge runs even when no install was found, so an uninstall that failed after its rows were deleted completes on retry.

`compose.ts` builds the routes for the Agent Plugins entries; the fixture Worker composes the same routes over the test key.

## Deployment

The Agent Plugins artifacts (`scripts/deploy/wrangler-config.ts`) bind `CLAXEDO_AGENT_PLUGINS`, `PLUGIN_LOADER` (`[[worker_loaders]]`) and `PLUGIN_SUPERVISOR`, and add migration `v2` with `new_sqlite_classes = ["PluginSupervisor"]`. Their entries export `PluginSupervisor` (`supervisor.cf.ts`, the runtime's class over `hostedPluginHostPort`, which reads `app_plugin_installs` and the backend bundle), `PluginPlatform` and `PluginOutbound`. The hosted compatibility flags include `enable_ctx_exports`. The base artifact carries none of this and serves no app plugins.

## Tests

`plugin-backends.workerd.test.ts` bundles `fixtures/worker.fixture.ts` with Wrangler and runs it in Miniflare with a real D1 database, R2 bucket, Worker Loader and supervisor. It signs releases of the counter plugin in `fixtures/counter` with a generated key into a registry the outbound service serves. The identity provider is the one stand-in: a bearer token carries the principal the provider would have verified, and the D1 authority checks it against its identity rows. The suite covers:

- installs: a member who is not an admin is refused every admin route; a tampered release, a tampered blob, an unknown key, a missing release and an invalid version install nothing; a second install is refused;
- enablement: members reach nothing, neither the list, the bundle nor the backend, until they enable it; an organization default enables it for members with no choice, and a member's own choice wins;
- the backend: per-organization counting, another organization reaching nothing until it installs, and two plugins in one organization kept apart;
- caller handles: the signed caller, forged headers ignored, a handle outliving its request, and naming nobody in another plugin or after a re-enable; and an object learning its own name;
- refusals: no credential, an unknown principal, no organization, an undeclared route or object class, the root route, a plugin that throws, and outbound limits;
- updates: a new epoch over the same storage, a refused storage downgrade, a manifest-only release, and a bundle the bucket lost;
- disable and re-enable: they reach running objects at once, raise the epoch, and leave a request held across them reaching no object, network or caller;
- uninstall: it deletes the plugin's objects, a running one included, and every member's choice, while another plugin's data stays and a reinstall continues the epoch.

`supervisor-purge.test.ts` in the runtime pins the purge's order against the real supervisor class.
