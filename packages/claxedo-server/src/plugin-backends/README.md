# Plugin backends

A plugin can ship a backend: one Workers module that the hosted Worker loads as a Dynamic Worker, once per bundle hash per organization, with Durable Object storage that belongs to that organization. The plugin's app reaches it at `/api/plugins/:pluginId/*`.

## The manifest

`claxedo.backend` in the plugin's `package.json` (`@claxedo/plugin-api`, `pluginBackendSchema`):

| Field | Meaning |
| --- | --- |
| `entry` | The backend module, relative to the package root. Its default export answers the plugin's routes; it also exports every object class. |
| `objects` | The Durable Object classes the entry exports. Only these can be reached through `env.OBJECTS`. |
| `outbound` | The hosts the backend may `fetch`, over https on the default port. Everything else is refused. |
| `routes` | `METHOD /path` patterns the backend serves. `:name` matches one segment and a trailing `*` one or more. A request for anything else is refused before it reaches the plugin. |

`@claxedo/plugin-build`'s `buildPluginBackend` bundles the entry into one ES module and refuses a bundle whose exports lack `default` or a declared object class. `checkPluginApp`, which `app_plugin_check` runs, validates the block and builds the backend beside the app.

## A request

1. **Route** (`routes.ts`, mounted by the Agent Plugins Worker entries). `ALL /api/plugins/:pluginId/*` reads the signed caller through `signedOrError`, the principal path every control-plane route uses, and asks the authority for the caller's organization (`resolveOrgId`). No credential is a 401; a principal the authority does not know is a 401; a caller with no active organization is a 403. The caller never names an organization. Only the request body and its `content-type` are forwarded, and only the plugin's status, body and `content-type` come back.
2. **Supervisor** (`supervisor.cf.ts`, `PluginSupervisor`). One Durable Object per organization, named `org:<orgId>`. For each request it reads the organization's activation from D1 (`activations.ts`):
   - no activation row: 404 `plugin_not_activated`;
   - a route the manifest does not declare: 404 `plugin_route_not_declared`;
   - otherwise it loads the bundle and forwards the request with `x-claxedo-user-id` set to the caller, replacing any value the caller sent.
3. **Loader.** The supervisor reads the bundle from the plugin artifact bucket (`CLAXEDO_AGENT_PLUGINS`, key `plugin-backends/<sha256>.js`, `bundles.ts`), verifies its SHA-256, and loads it with `PLUGIN_LOADER.get("<orgId>/<pluginId>/<hash>", …)`. A hash the bucket does not hold is a 503 `plugin_bundle_unavailable`, retried on the next request. The loaded Worker's environment is only `OBJECTS`, and its `globalOutbound` is `PluginOutbound` bound to the manifest's hosts.
4. **Objects** (`entrypoints.cf.ts`). `env.OBJECTS.object(className, name, request)` is the `PluginObjects` loopback entrypoint, bound by the supervisor to one organization and plugin. It calls the supervisor, which refuses a class the manifest does not declare and runs the class as its facet `[pluginId, className, name]`. A facet has its own SQLite database, so the plugin's storage lives inside its organization's supervisor and no plugin can address another organization's objects.

## Versions and activation

`plugin_backend_activations` (control-plane migration `0045`) holds one row per organization and plugin: the manifest and the bundle hash. The row is the authority; the supervisor keeps only which hash it is running. When the row names a new hash, the supervisor aborts the facets the old version started, and the next call starts them from the new bundle over the same storage. Deleting the row refuses the plugin's routes at the next request and leaves its storage in place. `activatePluginBackend`, `deactivatePluginBackend` and `putPluginBackendBundle` are the store operations; the tests are their only callers until an install route exists.

## Deployment

The Agent Plugins artifacts (`scripts/deploy/wrangler-config.ts`) bind `PLUGIN_LOADER` (`[[worker_loaders]]`) and `PLUGIN_SUPERVISOR`, and add migration `v2` with `new_sqlite_classes = ["PluginSupervisor"]`. Their entries export `PluginSupervisor`, `PluginObjects` and `PluginOutbound`. The hosted compatibility flags include `enable_ctx_exports`, which the supervisor needs for `ctx.exports` at compatibility date 2025-05-01. The base artifact carries none of this.

## Gate finding (local workerd)

Measured on 2026-09-30 with Miniflare 4.20260722.0 (workerd 1.20260722.1), Wrangler 4.114.0 and `@cloudflare/workers-types` 5.20260724.1, at compatibility date 2025-05-01 with `nodejs_compat`, `global_fetch_strictly_public` and `enable_ctx_exports`:

- **Worker Loader works.** A `workerLoaders: { PLUGIN_LOADER: {} }` binding (Wrangler: `[[worker_loaders]]`) loads a module from a string with `get(name, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))` and calls its default `fetch` and its exported classes. No experimental flag is needed.
- **Facets work.** In a SQLite-backed Durable Object, `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Counter") }))` runs the loaded class with its own SQLite database, separate from the parent's; the data survives a Miniflare restart with persistence on. `ctx.facets.abort(name, reason)` stops a running facet, and the next `get` starts it from a newly loaded class over the same storage. The top-level `org:<id>` namespace fallback is therefore not built.
- **`ctx.exports` needs `enable_ctx_exports`** at this compatibility date; without it `ctx.exports` is undefined. With it, `ctx.exports.PluginOutbound({ props })` works as a loaded Worker's `globalOutbound`, and `ctx.exports.PluginObjects({ props })` as a binding in its `env`.

Not verified: Worker Loader and facets on Cloudflare's production runtime (both are beta there and may need account enablement), and the plan's memory gate of 50 concurrent task facets under one organization running Pi turns.

## Tests

`plugin-backends.workerd.test.ts` bundles `fixtures/worker.ts` with Wrangler and runs it in Miniflare with a real D1 database, R2 bucket, Worker Loader and supervisor. The counter plugin in `fixtures/counter` is built with `buildPluginBackend`. The identity provider is the one stand-in: a bearer token carries the principal the provider would have verified, and the D1 authority checks it against its identity rows. The suite covers per-organization counting shared by members, isolation between two organizations, refusal without a credential, with an unknown principal, without an organization, for an organization that has not activated the plugin, for an undeclared route or object class, outbound limits, a new bundle hash, a missing bundle and deactivation.
