# Plugin backends

A plugin can ship a backend: one Workers module that the hosted Worker loads as a Dynamic Worker, once per activation generation per organization, with Durable Object storage that belongs to that organization. The plugin's app reaches it at `/api/plugins/:pluginId/*`.

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

1. **Route** (`routes.ts`, mounted by the Agent Plugins Worker entries). `ALL /api/plugins/:pluginId/*` reads the signed caller through `signedOrError`, the principal path every control-plane route uses, and asks the authority for the caller's organization (`resolveOrgId`). No credential is a 401; a principal the authority does not know is a 401; a caller with no active organization is a 403. The caller never names an organization. Only the request body and its `content-type` are forwarded, and only the plugin's status, body and `content-type` come back.
2. **Supervisor** (`supervisor.cf.ts`, `PluginSupervisor`). One Durable Object per organization, named `org:<orgId>`. For each request it reads the organization's activation from D1 (`activations.ts`) and hands the request to the plugin's current run (`runs.ts`):
   - no activation row: 404 `plugin_not_activated`;
   - a route the manifest does not declare: 404 `plugin_route_not_declared`;
   - otherwise it loads the bundle and forwards the request with `x-claxedo-user-id` set to the caller, replacing any value the caller sent.
3. **Loader.** The supervisor reads the bundle from the plugin artifact bucket (`CLAXEDO_AGENT_PLUGINS`, key `plugin-backends/<sha256>.js`, `bundles.ts`), verifies its SHA-256, and loads it with `PLUGIN_LOADER.get("<orgId>/<pluginId>/<generation>", …)`. A hash the bucket does not hold is a 503 `plugin_bundle_unavailable`, retried on the next request. The loaded Worker's main module is `platform-module.ts`'s, which re-exports the bundle; its environment is only `PLATFORM`, and its `globalOutbound` is `PluginOutbound` bound to the manifest's hosts.
4. **Platform** (`entrypoints.cf.ts`). `env.PLATFORM` is the `PluginPlatform` loopback entrypoint, bound by the supervisor to one organization, plugin and generation. `object(className, name, request)` calls the supervisor, which refuses a generation that is no longer current (409 `plugin_backend_replaced`) and a class the manifest does not declare, and runs the class as its facet `[pluginId, className, name]`. A facet has its own SQLite database, so the plugin's storage lives inside its organization's supervisor and no plugin can address another organization's objects. `active()` answers whether the bound generation is still the organization's current activation.

## Versions and activation

`plugin_backend_activations` (control-plane migration `0046`) holds one row per organization and plugin: the manifest and the bundle hash. The row is the authority. Its generation is the SHA-256 of the bundle hash and the manifest, so a change to routes, object classes or outbound hosts is a new generation just as a new bundle is.

`PluginBackendRuns` (`runs.ts`) holds, per plugin, the generation the supervisor is running, its loaded Worker and the facets it started:

- Activation reads are applied in the order they started, so a slow read never replaces a newer one.
- A new generation, or no row, ends the run: its facets are aborted, and the next call starts them from the new configuration over the same storage.
- Work that was waiting for a bundle when its run ended starts nothing on that run; it goes again on the current one, or answers `plugin_not_activated` if there is none.

`activatePluginBackend` and `deactivatePluginBackend` (`lifecycle.ts`) write or delete the row and then tell the organization's supervisor, so the previous configuration's objects stop at once rather than at the next request. Deactivation leaves the plugin's storage in place. They and `putPluginBackendBundle` have no production caller until an install route exists; the test Worker drives them.

A facet's alarm reaches the facet directly, not through the supervisor. The main module therefore subclasses every declared object class and replaces its `alarm` with one that runs only while `env.PLATFORM.active()` is true. The replacement is an own, non-writable property set after the plugin's constructor, and it captures `env.PLATFORM` before that constructor runs, so neither a prototype method, a class field nor a reassignment of the plugin's can bypass it. An alarm that fires after deactivation or replacement runs nothing, and the object's storage is kept.

## Deployment

The Agent Plugins artifacts (`scripts/deploy/wrangler-config.ts`) bind `PLUGIN_LOADER` (`[[worker_loaders]]`) and `PLUGIN_SUPERVISOR`, and add migration `v2` with `new_sqlite_classes = ["PluginSupervisor"]`. Their entries export `PluginSupervisor`, `PluginPlatform` and `PluginOutbound`. The hosted compatibility flags include `enable_ctx_exports`, which the supervisor needs for `ctx.exports` at compatibility date 2025-05-01. The base artifact carries none of this.

## Gate finding (local workerd)

Measured on 2026-09-30 with Miniflare 4.20260722.0 (workerd 1.20260722.1), Wrangler 4.114.0 and `@cloudflare/workers-types` 5.20260724.1, at compatibility date 2025-05-01 with `nodejs_compat`, `global_fetch_strictly_public` and `enable_ctx_exports`:

- **Worker Loader works.** A `workerLoaders: { PLUGIN_LOADER: {} }` binding (Wrangler: `[[worker_loaders]]`) loads a module from a string with `get(name, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))` and calls its default `fetch` and its exported classes. No experimental flag is needed.
- **Facets work.** In a SQLite-backed Durable Object, `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Counter") }))` runs the loaded class with its own SQLite database, separate from the parent's; the data survives a Miniflare restart with persistence on. `ctx.facets.abort(name, reason)` stops a running facet, and the next `get` starts it from a newly loaded class over the same storage. The top-level `org:<id>` namespace fallback is therefore not built.
- **`ctx.exports` needs `enable_ctx_exports`** at this compatibility date; without it `ctx.exports` is undefined. With it, `ctx.exports.PluginOutbound({ props })` works as a loaded Worker's `globalOutbound`, and `ctx.exports.PluginPlatform({ props })` as a binding in its `env`.

- **Facet alarms do not fire locally.** On this workerd, `setAlarm` inside a facet fails with "alarms are not yet implemented for SQLite-backed Durable Objects" (a Cloudflare review saw the same runtime crash with `expected !firing` as a facet alarm handler completed). The alarm gate is therefore tested by calling `alarm()` through the gated property and by the generation checks, not by a fired alarm.

Not verified: a fired facet alarm, Worker Loader and facets on Cloudflare's production runtime (both are beta there and may need account enablement), and the plan's memory gate of 50 concurrent task facets under one organization running Pi turns.

## Tests

`plugin-backends.workerd.test.ts` bundles `fixtures/worker.fixture.ts` with Wrangler and runs it in Miniflare with a real D1 database, R2 bucket, Worker Loader and supervisor. The counter plugin in `fixtures/counter` is built with `buildPluginBackend`. The identity provider is the one stand-in: a bearer token carries the principal the provider would have verified, and the D1 authority checks it against its identity rows. The suite covers per-organization counting shared by members, isolation between two organizations, refusal without a credential, with an unknown principal, without an organization, for an organization that has not activated the plugin, for an undeclared route or object class, the root route, a plugin that throws, outbound limits, a new bundle hash, a manifest-only change, a missing bundle, deactivation reaching running objects at once, generation checks and the gated alarm. `runs.test.ts` covers the run transitions with controlled reads and loads, and `platform-module.test.ts` the alarm gate against a prototype method, a class field and a constructor that replaces `env.PLATFORM`.
