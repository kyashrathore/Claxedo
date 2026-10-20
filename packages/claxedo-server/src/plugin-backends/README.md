# Plugin backends

A plugin can ship a backend: one Workers module that the hosted Worker loads as a Dynamic Worker, once per activation per organization, with Durable Object storage that belongs to that organization. The plugin's app reaches it at `/api/plugins/:pluginId/*`.

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
2. **Supervisor** (`supervisor.cf.ts`, `PluginSupervisor`). One Durable Object per organization, named `org:<orgId>`. For each request it reads the organization's activation from D1 (`activations.ts`) and hands the request to the plugin's current run (`runs.ts`):
   - no activation row: 404 `plugin_not_activated`;
   - a route the manifest does not declare: 404 `plugin_route_not_declared`;
   - otherwise it loads the bundle and forwards the request with `x-claxedo-user-id` set to the caller, replacing any value the caller sent.
3. **Loader.** The supervisor reads the bundle from the plugin artifact bucket (`CLAXEDO_AGENT_PLUGINS`, key `plugin-backends/<sha256>.js`, `bundles.ts`), verifies its SHA-256, and loads it with `PLUGIN_LOADER.get("<orgId>/<pluginId>/<generation>/<epoch>", …)`. A hash the bucket does not hold is a 503 `plugin_bundle_unavailable`, retried on the next request. The loaded Worker's environment is only `PLATFORM`, and its `globalOutbound` is `PluginOutbound`; both are bound to the activation's epoch, which is why the epoch is part of the loader id.
4. **Capabilities** (`entrypoints.cf.ts`). Everything a loaded backend can reach beyond its own facet's storage is bound to one organization, plugin and activation epoch, and refused once that epoch is not the current one:
   - `env.PLATFORM.object(className, name, request)` (`PluginPlatform`) calls the supervisor, which refuses an ended epoch (409 `plugin_backend_replaced`) and a class the manifest does not declare, and runs the class as its facet `[pluginId, className, name]`. A facet has its own SQLite database, so the plugin's storage lives inside its organization's supervisor and no plugin can address another organization's objects.
   - `env.PLATFORM.active()` answers whether the epoch is still current.
   - `fetch` goes through `PluginOutbound`, which allows https on the default port to the manifest's hosts, and only while the epoch is current (otherwise 403 `plugin_backend_replaced`).

## Versions and activation

`plugin_backend_activations` (control-plane migration `0046`) holds one row per organization and plugin: the manifest, the bundle hash, whether the plugin is active, and its epoch. The row is the authority. The epoch rises on every activation and deactivation and is never reused, so an identical reactivation, a new bundle and a manifest-only change are each a new epoch, and every capability issued under an earlier one is dead. The generation, the SHA-256 of the bundle hash and the manifest, names only the configuration the Worker Loader caches.

`PluginBackendRuns` (`runs.ts`) holds, per plugin, the epoch the supervisor is running, its loaded Worker and the facets it started:

- A read carrying an older epoch than one already applied is stale and changes nothing.
- A newer epoch ends the run: its facets are aborted, and the next call starts them from the new activation over the same storage.
- Work that was waiting for a bundle when its run ended starts nothing on that run; it goes again on the current one, or answers `plugin_not_activated` if there is none.

`activatePluginBackend` and `deactivatePluginBackend` (`lifecycle.ts`) write or delete the row and then tell the organization's supervisor, so the previous configuration's objects stop at once rather than at the next request. Deactivation leaves the plugin's storage in place. They and `putPluginBackendBundle` have no production caller until an install route exists; the test Worker drives them.

A request the plugin was already handling when its epoch ended keeps running until it answers, but it reaches nothing: no object, no network, and `active()` is false.

**Residual risk: facet alarms.** A facet's alarm reaches the facet directly, not through the supervisor, so the platform cannot stop one from running. Deactivation and replacement abort the running facets at once, but an alarm the plugin scheduled before then can still start the facet again and run the plugin's code. That code holds no live capability: `env.PLATFORM` refuses every call and `PluginOutbound` every fetch, so it can read and write only that facet's own storage, and can schedule itself again, spending CPU in the organization's supervisor. The platform does not wrap the plugin's classes to stop it, because any gate inside the plugin's realm can be bypassed by the plugin's own code. Scheduled work for plugins goes through a platform-owned scheduler (the Tasks plan), not facet alarms.

## Deployment

The Agent Plugins artifacts (`scripts/deploy/wrangler-config.ts`) bind `PLUGIN_LOADER` (`[[worker_loaders]]`) and `PLUGIN_SUPERVISOR`, and add migration `v2` with `new_sqlite_classes = ["PluginSupervisor"]`. Their entries export `PluginSupervisor`, `PluginPlatform` and `PluginOutbound`. The hosted compatibility flags include `enable_ctx_exports`, which the supervisor needs for `ctx.exports` at compatibility date 2025-05-01. The base artifact carries none of this.

## Gate finding (local workerd)

Measured on 2026-09-30 with Miniflare 4.20260722.0 (workerd 1.20260722.1), Wrangler 4.114.0 and `@cloudflare/workers-types` 5.20260724.1, at compatibility date 2025-05-01 with `nodejs_compat`, `global_fetch_strictly_public` and `enable_ctx_exports`:

- **Worker Loader works.** A `workerLoaders: { PLUGIN_LOADER: {} }` binding (Wrangler: `[[worker_loaders]]`) loads a module from a string with `get(name, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))` and calls its default `fetch` and its exported classes. No experimental flag is needed.
- **Facets work.** In a SQLite-backed Durable Object, `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Counter") }))` runs the loaded class with its own SQLite database, separate from the parent's; the data survives a Miniflare restart with persistence on. `ctx.facets.abort(name, reason)` stops a running facet, and the next `get` starts it from a newly loaded class over the same storage. The top-level `org:<id>` namespace fallback is therefore not built.
- **`ctx.exports` needs `enable_ctx_exports`** at this compatibility date; without it `ctx.exports` is undefined. With it, `ctx.exports.PluginOutbound({ props })` works as a loaded Worker's `globalOutbound`, and `ctx.exports.PluginPlatform({ props })` as a binding in its `env`.

- **Facet alarms do not fire locally.** On this workerd, `setAlarm` inside a facet fails with "alarms are not yet implemented for SQLite-backed Durable Objects", and a review of this lane saw the runtime crash with `expected !firing` as a facet alarm handler completed. The residual risk above is therefore reasoned from the capability fencing the suite does test, not observed with a fired alarm.

Not verified locally or on Cloudflare: a fired facet alarm, and the plan's memory gate of 50 concurrent task facets under one organization running Pi turns.

## Gate finding (Cloudflare)

Measured on 2026-10-20 on the Cloudflare account "Kanusdlp@gmail.com's Account", the one the staging deploy uses, with Wrangler 4.114.0. A throwaway Worker, `claxedo-plugin-gate-test`, ran at the hosted compatibility date and flags (2025-05-01; `nodejs_compat`, `global_fetch_strictly_public`, `enable_ctx_exports`). It used the supervisor's shape: a SQLite-backed Durable Object loading one module through `PLUGIN_LOADER.get(id, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))`, with a `ctx.exports` entrypoint as the outbound. The Worker was deleted afterwards, and the API answers 404 for it.

| Check | Result | Evidence |
| --- | --- | --- |
| Deploy with `[[worker_loaders]]` | Pass | Accepted with no account enablement. The script's settings list `{ name: "PLUGIN_LOADER", type: "worker_loader" }`. |
| Load a module at runtime and call its `fetch` | Pass | `getEntrypoint().fetch` answered 200 with the loaded module's JSON. |
| Facet runs the loaded class, and its SQLite rows persist | Pass | `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Store") }))`. A row written in one request was read back in later requests and after a redeploy restarted the Worker. Another facet name saw no rows. |
| `ctx.facets.delete(name)` | Pass | The facet's rows were gone on the next read. |
| Supervisor `ctx.storage.deleteAll()` deletes facet storage | Pass, with a condition | A stopped facet read no rows afterwards. A facet that was still running kept serving its rows until the Worker restarted, and then they were gone. The supervisor holds every plugin in its organization, so uninstalling one plugin deletes that plugin's facets with `ctx.facets.delete`; `deleteAll` would remove the other plugins' storage too. |
| Supervisor (non-facet) alarm | Pass | A `setAlarm(now + 3 s)` fired once, with `retryCount` 0. `getAlarm()` was then null, and the handler had still run only once 40 s later. |
| `globalOutbound` limits the loaded code's `fetch` | Pass | Through the outbound entrypoint, `https://example.com/` answered 200, while `https://www.cloudflare.com/` and `http://example.com/` answered 403 `plugin_outbound_refused`. With `globalOutbound: null`, `fetch` throws "This worker is not permitted to access the internet via global functions like fetch()". |
| Ed25519 `crypto.subtle.verify` | Pass | The RFC 8032 §7.1 TEST 1 vector verifies, and a one-bit-tampered signature does not. A generated key pair signs (64 bytes) and verifies, and the signature fails against a different message. |
| Worker Loader limits | None hit | The 28.77 KiB upload (7.55 KiB gzip) started in 8 ms. Each facet reported a `databaseSize` of 16384 bytes. No response named a limit. The limits page on developers.cloudflare.com could not be reached from the measuring session, so the documented module-count and memory limits were not read. |

Inside a facet, `ctx.id` is the supervisor's id: every facet reported the same id. A plugin therefore cannot use `ctx.id` to tell its objects apart.

## Tests

`plugin-backends.workerd.test.ts` bundles `fixtures/worker.fixture.ts` with Wrangler and runs it in Miniflare with a real D1 database, R2 bucket, Worker Loader and supervisor. The counter plugin in `fixtures/counter` is built with `buildPluginBackend`. The identity provider is the one stand-in: a bearer token carries the principal the provider would have verified, and the D1 authority checks it against its identity rows. The suite covers per-organization counting shared by members, isolation between two organizations, refusal without a credential, with an unknown principal, without an organization, for an organization that has not activated the plugin, for an undeclared route or object class, the root route, a plugin that throws, outbound limits, a new bundle hash, a manifest-only change, a missing bundle, deactivation reaching running objects at once, epochs across deactivation and identical reactivation, and a request held open across them that then reaches no object, no network and is no longer active. `runs.test.ts` covers the run transitions with controlled reads and loads.
