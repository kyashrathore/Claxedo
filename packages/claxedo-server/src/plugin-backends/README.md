# Plugin backends (hosted adapter)

A plugin can ship a backend: one Workers module that the hosted Worker loads as a Dynamic Worker, once per activation per organization, with Durable Object storage that belongs to that organization and plugin. The plugin's app reaches it at `/api/plugins/:pluginId/*`. The runtime itself, its supervisor, capabilities, caller handles and epochs, is `@claxedo/plugin-runtime` (`packages/plugin-runtime/README.md`); this directory is what the hosted Worker adds around it.

## The manifest

`claxedo.backend` in the plugin's `package.json` (`@claxedo/plugin-api`, `pluginBackendSchema`):

| Field | Meaning |
| --- | --- |
| `entry` | The backend module, relative to the package root. Its default export answers the plugin's routes; it also exports every object class. |
| `objects` | The Durable Object classes the entry exports. Only these can be reached through `env.PLATFORM.object`. |
| `outbound` | The hosts the backend may `fetch`, over https on the default port. Everything else is refused. |
| `routes` | `METHOD /path` patterns the backend serves. `:name` matches one segment and a trailing `*` one or more. A request for anything else is refused before it reaches the plugin. |

`@claxedo/plugin-build`'s `buildPluginBackend` bundles the entry into one ES module and refuses a bundle whose exports lack `default` or a declared object class. `checkPluginApp`, which `app_plugin_check` runs, validates the block and builds the backend beside the app.

## A request

1. **Route** (`routes.ts`, mounted by the Agent Plugins Worker entries). `ALL /api/plugins/:pluginId/*` reads the signed caller through `signedOrError`, the principal path every control-plane route uses, and asks the authority for the caller's organization (`resolveOrgId`). No credential is a 401; a principal the authority does not know is a 401; a caller with no active organization is a 403. The caller never names an organization. Only the request body and its `content-type` are forwarded, and only the plugin's status, body and `content-type` come back, with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` added because the answer is served from the control plane's own origin.
2. **Supervisor.** The route hands the request to the organization's supervisor for that plugin (`pluginSupervisor(namespace, { orgId, pluginId })`), with the caller's user id, which the runtime turns into a caller handle.
3. **Host port** (`supervisor.cf.ts`, `hostedPluginHostPort`). The runtime reads the install from D1 (`activations.ts`) and the bundle from the plugin artifact bucket (`CLAXEDO_AGENT_PLUGINS`, key `plugin-backends/<sha256>.js`, `bundles.ts`), whose digest it verifies before loading.

## Versions and activation

`plugin_backend_activations` (control-plane baseline) holds one row per organization and plugin: the manifest, the bundle hash, whether the plugin is active, and its epoch. The row is the authority. The epoch rises on every activation and deactivation and is never reused, so an identical reactivation, a new bundle and a manifest-only change are each a new epoch, and every capability issued under an earlier one is dead.

`activatePluginBackend` and `deactivatePluginBackend` (`lifecycle.ts`) write or delete the row and then refresh the plugin's supervisor, so the previous configuration's objects stop at once rather than at the next request. Deactivation leaves the plugin's storage in place. They and `putPluginBackendBundle` have no production caller until an install route exists; the test Worker drives them.

## Deployment

The Agent Plugins artifacts (`scripts/deploy/wrangler-config.ts`) bind `PLUGIN_LOADER` (`[[worker_loaders]]`) and `PLUGIN_SUPERVISOR`, and add migration `v2` with `new_sqlite_classes = ["PluginSupervisor"]`. Their entries export `PluginSupervisor` (this directory's class over the hosted port), `PluginPlatform` and `PluginOutbound`. The hosted compatibility flags include `enable_ctx_exports`, which the supervisor needs for `ctx.exports` at compatibility date 2025-05-01. The base artifact carries none of this.

## Tests

`plugin-backends.workerd.test.ts` bundles `fixtures/worker.fixture.ts` with Wrangler and runs it in Miniflare with a real D1 database, R2 bucket, Worker Loader and supervisor. The counter plugin in `fixtures/counter` is built with `buildPluginBackend`. The identity provider is the one stand-in: a bearer token carries the principal the provider would have verified, and the D1 authority checks it against its identity rows. The suite covers:

- per-organization counting shared by members, isolation between two organizations, and between two plugins of one organization;
- a caller handle that names the signed caller, ignores a forged `x-claxedo-user-id` or `x-claxedo-caller`, outlives its request within its run, and names nobody in another plugin or after a reactivation;
- refusal without a credential, with an unknown principal, without an organization, for an organization that has not activated the plugin, and for an undeclared route or object class;
- the root route, a plugin that throws, and outbound limits;
- a new bundle hash, a manifest-only change and a missing bundle;
- deactivation reaching running objects at once, epochs across deactivation and identical reactivation, and a request held open across them that then reaches no object, no network and no caller, and is no longer active.
