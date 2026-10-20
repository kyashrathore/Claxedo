# @claxedo/plugin-runtime

The sandboxed runtime an app plugin's backend runs in: one supervisor Durable Object per organization and plugin, the backend loaded through the Worker Loader as a Dynamic Worker once per activation epoch, the plugin's own Durable Object classes run as the supervisor's facets, and the capabilities a loaded backend reaches the host through. It runs only in the hosted Worker; app plugins exist only for signed-in accounts, and there is no local backend runtime.

The host owns everything else: who the caller is, which organization they act in, where the install row and the bundles are stored. `packages/claxedo-server/src/plugin-backends/README.md` describes the hosted adapter.

## The host port

`PluginHostPort` (`host-port.ts`) is what a host hands the runtime:

| Member | Answers |
| --- | --- |
| `readState(orgId, pluginId)` | `PluginBackendState`: the install's current `epoch`, and its `activation` (`epoch`, the backend bundle's `bundleHash`, the validated `manifest` with its `backend`) while the backend is active. |
| `readBundle(sha256)` | The backend bundle stored under that SHA-256, or undefined when none is. The runtime verifies the digest before it loads the code, so a store that answers other bytes is refused. |

The supervisor asks both on every request it serves. A state whose epoch is lower than one the supervisor has already applied is ignored as stale, so a replica that lags cannot bring back an ended run; a host must never answer an epoch it did not write.

A host composes the runtime in its Worker entry:

```ts
import { pluginSupervisorClass } from "@claxedo/plugin-runtime/supervisor"
export { PluginOutbound, PluginPlatform } from "@claxedo/plugin-runtime/entrypoints"

export class PluginSupervisor extends pluginSupervisorClass((env) => myHostPort(env)) {}
```

The entry must export all three under those names, because the supervisor binds a loaded backend's capabilities from `ctx.exports.PluginPlatform` and `ctx.exports.PluginOutbound`. Its env must carry `PLUGIN_LOADER` (a `[[worker_loaders]]` binding) and `PLUGIN_SUPERVISOR` (the supervisor's namespace), and the Worker needs `enable_ctx_exports` at compatibility date 2025-05-01.

## A request

`pluginSupervisor(namespace, { orgId, pluginId })` names the supervisor `org:<orgId>:plugin:<pluginId>`, so one plugin's CPU, memory and storage never share an object with another plugin's. `request(caller, request)` serves a request the host authenticated:

- no activation: 404 `plugin_not_activated`;
- a route the manifest does not declare: 404 `plugin_route_not_declared`;
- a bundle the host does not hold: 503 `plugin_bundle_unavailable`, read again on the next request;
- otherwise the backend gets the request's method, path, query, body and `content-type`, and `x-claxedo-caller`, a caller handle; nothing else the caller sent reaches it.

The loaded Worker's environment is only `PLATFORM`, and its `globalOutbound` is `PluginOutbound`. Both are bound to the activation's epoch, which is why the epoch is part of the loader id `<orgId>/<pluginId>/<generation>/<epoch>`. The generation, the SHA-256 of the bundle hash and the manifest, names only the configuration the Worker Loader caches.

## Caller handles

A backend never receives a user id it could replay. The supervisor mints a 128-bit handle per request (`caller-handles.ts`), kept in memory under the epoch it was minted in:

- `env.PLATFORM.caller(handle)` answers `{ userId, orgId }` while the handle is live, and null otherwise;
- a handle stays live while its request is open, and for `PLUGIN_CALLER_HANDLE_TTL_MS` (10 minutes) after it answered;
- it names nobody once its epoch has ended, under any other epoch, or in another plugin's supervisor;
- a supervisor that restarts has forgotten every handle.

## Capabilities

Everything a loaded backend reaches beyond its own facet's storage is bound to one organization, plugin and activation epoch, and refused once that epoch is not the current one (`entrypoints.cf.ts`):

- `env.PLATFORM.object(className, name, request)` refuses an ended epoch (409 `plugin_backend_replaced`), a class the manifest does not declare (404 `plugin_object_not_declared`) and a name outside 1 to 256 characters, and runs the class as the facet `[className, name]`. A facet has its own SQLite database inside the supervisor, so no plugin can address another plugin's or organization's objects.
- `env.PLATFORM.active()` answers whether the epoch is still current.
- `env.PLATFORM.caller(handle)`, above.
- `fetch` goes through `PluginOutbound`, which allows https on the default port to the manifest's `outbound` hosts, and only while the epoch is current (otherwise 403 `plugin_backend_replaced`).

The supervisor records every facet it starts in its own SQLite table `plugin_facets(name, class_name, created_at)`, so a deletion reaches facets no run of the current isolate started.

## Epochs and runs

`PluginBackendRuns` (`runs.ts`) holds the epoch the supervisor is running, its loaded Worker and the facets it started:

- a read carrying an older epoch than one already applied is stale and changes nothing;
- a newer epoch ends the run: its facets are aborted, and the next call starts them from the new activation over the same storage;
- work that was waiting for a bundle when its run ended starts nothing on that run; it goes again on the current one, or answers `plugin_not_activated` if there is none.

`refresh(scope)` reads the state again, which a host calls after it changes an install so the previous configuration's objects stop at once rather than at the next request. A request the plugin was already handling when its epoch ended keeps running until it answers, but it reaches nothing: no object, no network, no caller, and `active()` is false.

**Residual risk: facet alarms.** A facet's alarm reaches the facet directly, not through the supervisor, so the platform cannot stop one from running. Deactivation and replacement abort the running facets at once, but an alarm the plugin scheduled before then can still start the facet again and run the plugin's code. That code holds no live capability, so it can read and write only that facet's own storage, and can schedule itself again. The runtime does not wrap the plugin's classes to stop it, because any gate inside the plugin's realm can be bypassed by the plugin's own code. Scheduled work goes through a platform-owned scheduler instead (`docs/plans/2026-10-20-feat-opt-in-plugins-plan.md` §3.7).

## Gate finding (local workerd)

Measured on 2026-09-30 with Miniflare 4.20260722.0 (workerd 1.20260722.1), Wrangler 4.114.0 and `@cloudflare/workers-types` 5.20260724.1, at compatibility date 2025-05-01 with `nodejs_compat`, `global_fetch_strictly_public` and `enable_ctx_exports`:

- **Worker Loader works.** A `workerLoaders: { PLUGIN_LOADER: {} }` binding loads a module from a string with `get(name, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))` and calls its default `fetch` and its exported classes. No experimental flag is needed.
- **Facets work.** In a SQLite-backed Durable Object, `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Counter") }))` runs the loaded class with its own SQLite database, separate from the parent's; the data survives a Miniflare restart with persistence on. `ctx.facets.abort(name, reason)` stops a running facet, and the next `get` starts it from a newly loaded class over the same storage.
- **`ctx.exports` needs `enable_ctx_exports`** at this compatibility date; without it `ctx.exports` is undefined.
- **Facet alarms do not fire locally.** `setAlarm` inside a facet fails with "alarms are not yet implemented for SQLite-backed Durable Objects", so the residual risk above is reasoned from the capability fencing the suite tests, not observed with a fired alarm.

Not verified: a fired facet alarm, Worker Loader and facets on Cloudflare's production runtime (both are beta there and may need account enablement), and the memory gate of 50 concurrent facets under one supervisor.

## Tests

`bun test src` runs `runs.test.ts` (the run transitions with controlled reads and loads) and `caller-handles.test.ts` (handle lifetime, epochs and expiry over a controlled clock). The runtime on workerd is tested through the hosted adapter's suite, `packages/claxedo-server/src/plugin-backends/plugin-backends.workerd.test.ts`.
