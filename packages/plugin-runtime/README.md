# @claxedo/plugin-runtime

The sandboxed runtime an app plugin's backend runs in: one supervisor Durable Object per organization and plugin, the backend loaded through the Worker Loader as a Dynamic Worker once per activation epoch, the plugin's own Durable Object classes run as the supervisor's facets, and the platform a loaded backend reaches the host through. It runs only in the hosted Worker; app plugins exist only for signed-in accounts, and there is no local backend runtime.

The host owns everything else: who the caller is, which organization they act in, what that person may do, and where the install, the bundles and the plugin's data are stored. `packages/claxedo-server/src/plugin-backends/README.md` describes the hosted adapter. The contract a backend is written against is `@claxedo/plugin-api/backend` (`packages/claxedo-plugin-api/README.md`).

## The host port

`PluginHostPort` (`host-port.ts`) is what a host hands the runtime:

| Member | Answers |
| --- | --- |
| `readState(orgId, pluginId)` | `PluginBackendState`: the install's current `epoch`, and its `activation` (`epoch`, the backend bundle's `bundleHash`, the validated `manifest` with its `backend`) while the backend is active. |
| `readBundle(sha256)` | The backend bundle stored under that SHA-256, or undefined when none is. The runtime verifies the digest before it loads the code, so a store that answers other bytes is refused. |
| `platform(call, scope, caller)` | A platform call the runtime has already admitted (below): projects, blobs, events, links and sessions. The host decides what the caller may do and where the data lives. |
| `limits` | Optional. `blobTotalBytes` overrides the 1 GiB a plugin's blobs may hold in one organization. |

The supervisor asks `readState` and `readBundle` on every request it serves. A state whose epoch is lower than one the supervisor has already applied is ignored as stale, so a replica that lags cannot bring back an ended run; a host must never answer an epoch it did not write.

A host composes the runtime in its Worker entry:

```ts
import { pluginSupervisorClass } from "@claxedo/plugin-runtime/supervisor"
export { PluginOutbound, PluginPlatform } from "@claxedo/plugin-runtime/entrypoints"

export class PluginSupervisor extends pluginSupervisorClass((env) => myHostPort(env)) {}
```

The entry must export all three under those names, because the supervisor binds a loaded backend's capabilities from `ctx.exports.PluginPlatform` and `ctx.exports.PluginOutbound`. Its env must carry `PLUGIN_LOADER` (a `[[worker_loaders]]` binding) and `PLUGIN_SUPERVISOR` (the supervisor's namespace), and the Worker needs `enable_ctx_exports` at compatibility date 2025-05-01.

## A request

`pluginSupervisor(namespace, { orgId, pluginId })` names the supervisor `org:<orgId>:plugin:<pluginId>`, so one plugin's CPU, memory and storage never share an object with another plugin's. `request(caller, request)` serves a request the host forwards, for a `person` it authenticated or for anyone holding a public `link`:

- a path under `/_`: 404 `plugin_route_reserved` (those are the platform's own calls into the backend);
- no activation: 404 `plugin_not_activated`;
- a route the manifest does not declare: 404 `plugin_route_not_declared`;
- a link request other than `GET`: 405 `plugin_link_read_only`;
- a bundle the host does not hold: 503 `plugin_bundle_unavailable`, read again on the next request;
- otherwise the backend gets the request's method, path, query, body and `content-type`, and `x-claxedo-caller`, a caller handle; nothing else the caller sent reaches it.

The loaded Worker's environment is only `PLATFORM`, and its `globalOutbound` is `PluginOutbound`. Both are bound to the activation's epoch, which is why the epoch is part of the loader id `<orgId>/<pluginId>/<generation>/<epoch>`. The generation, the SHA-256 of the bundle hash and the manifest, names only the configuration the Worker Loader caches.

## Caller handles

A backend never receives a user id it could replay. The supervisor mints a 128-bit handle for each request and each wake it delivers (`caller-handles.ts`), kept in memory under the epoch it was minted in, for a caller `{ orgId, origin, userId? }`: a `person` with their user id, a `link` or a `system` wake with none.

- `identity.caller` answers it while the handle is live, and refuses otherwise;
- a handle stays live while its request is open, and for `PLUGIN_CALLER_HANDLE_TTL_MS` (10 minutes) after it answered;
- it names nobody once its epoch has ended, under any other epoch, or in another plugin's supervisor;
- a supervisor that restarts has forgotten every handle.

## The platform

`env.PLATFORM` (`entrypoints.cf.ts`) is bound to one organization, plugin and activation epoch:

- `object(className, name, request)` refuses an ended epoch (409 `plugin_backend_replaced`), a class the manifest does not declare (404 `plugin_object_not_declared`) and a name outside 1 to 256 characters, and runs the class as the facet `[className, name]`. A facet has its own SQLite database inside the supervisor, so no plugin can address another plugin's or organization's objects. Every facet's `ctx.id` is the supervisor's, so an object cannot tell itself from its siblings by it: every request it receives carries its own name in `x-claxedo-object-name` instead.
- `active()` answers whether the epoch is still current.
- `call(call, handle)` is every other call (`PluginPlatformCall`). `admitPlatformCall` (`platform-admission.ts`) admits it, in this order:
  1. the epoch is the current activation, else 409 `plugin_backend_replaced`;
  2. its fields parse, else 400 `plugin_call_invalid`;
  3. the manifest's `permissions` hold every permission the call needs (`platformCallPermissions`: its own, and `workspaces.cloud` for a cloud `sessions.preview` or `sessions.start`), else 403 `plugin_permission_not_declared`;
  4. a call that needs a caller has a live handle, else 401 `plugin_caller_invalid`;
  5. a call that acts as a person (projects, `links.create`, an event to the caller or a project, every session call but `sessions.state`) has a person, else 403 `plugin_caller_not_a_person`.
- `fetch` goes through `PluginOutbound`, which allows https on the default port to the manifest's `outbound` hosts, and only while the epoch is current (otherwise 403 `plugin_backend_replaced`).

The runtime answers some calls itself and holds the limits; the host answers the rest through `platform`:

| Call | Permission | Answered by |
| --- | --- | --- |
| `identity.caller` | none | the runtime, from the handle |
| `projects.list`, `projects.authorize` | `projects.read` | the host, as the caller |
| `blobs.put`, `get`, `head`, `delete`, `list` | `blobs` | the host's store; the runtime refuses a blob over 16 MiB (413 `plugin_blob_too_large`) and a put past the quota (413 `plugin_blob_quota_exceeded`), counting each blob's size in its own `plugin_blob_usage` table |
| `events.publish` | `events` | the host's delivery; the runtime refuses data over 8 KiB (413 `plugin_event_too_large`) and more than 10 a second (429 `plugin_event_rate_limited`) |
| `schedule.at`, `cancel`, `list` | `schedule` | the runtime (`wakes.ts`) |
| `links.create`, `links.revoke` | `links` | the host |
| `sessions.harnesses`, `preview`, `start`, `handoff`, `abandon` | `sessions.start`; a cloud `preview` or `start` also `workspaces.cloud` | the host, as the caller |
| `sessions.state`, `authorizeOpen` | `sessions.read` | the host |

**Wakes.** `schedule.at(name, at, payload)` stores a wake in the supervisor's `plugin_wakes` table and arms the supervisor's own alarm at the earliest one. A wake is set at least 30 s ahead (400 `plugin_wake_too_soon`), carries at most 4 KiB of JSON (413), and a plugin holds at most 100 (429 `plugin_wake_limit`). When the alarm fires, `wakeDue(scope, now)` takes every due wake off the table before delivering it, so each runs at most once, as `POST /_wake/<name>` with a `system` caller. A wake due while no backend is active is dropped. The alarm reaches platform code, never a facet. Facet alarms stay unsupported (below); plugins schedule through `schedule.at`.

The supervisor records every facet it starts in its own SQLite table `plugin_facets(name, class_name, created_at)`, and the plugin it serves in `plugin_scope`, which an alarm reads because it arrives with no caller.

`purge(scope)` deletes everything the plugin stored, once the host has removed its install: it refuses while the host still answers an active backend, ends the run, deletes each recorded facet with `ctx.facets.delete`, then the alarm, and only then the supervisor's own storage with `deleteAll`, because a running facet outlives `deleteAll` (below). Its wakes and blob accounting go with that storage. `supervisor.test.ts` pins the order.

## Epochs and runs

`PluginBackendRuns` (`runs.ts`) holds the epoch the supervisor is running, its loaded Worker and the facets it started:

- a read carrying an older epoch than one already applied is stale and changes nothing;
- a newer epoch ends the run: its facets are aborted, and the next call starts them from the new activation over the same storage;
- work that was waiting for a bundle when its run ended starts nothing on that run; it goes again on the current one, or answers `plugin_not_activated` if there is none.

`refresh(scope)` reads the state again, which a host calls after it changes an install so the previous configuration's objects stop at once rather than at the next request. A request the plugin was already handling when its epoch ended keeps running until it answers, but it reaches nothing: no object, no network, no platform call, and `active()` is false.

**Residual risk: facet alarms.** A facet's alarm reaches the facet directly, not through the supervisor, so the platform cannot stop one from running. Deactivation and replacement abort the running facets at once, but an alarm the plugin scheduled before then can still start the facet again and run the plugin's code. That code holds no live capability, so it can read and write only that facet's own storage, and can schedule itself again. The runtime does not wrap the plugin's classes to stop it, because any gate inside the plugin's realm can be bypassed by the plugin's own code. Scheduled work goes through `schedule.at` and the supervisor's alarm instead.

## Gate finding (local workerd)

Measured on 2026-09-30 with Miniflare 4.20260722.0 (workerd 1.20260722.1), Wrangler 4.114.0 and `@cloudflare/workers-types` 5.20260724.1, at compatibility date 2025-05-01 with `nodejs_compat`, `global_fetch_strictly_public` and `enable_ctx_exports`:

- **Worker Loader works.** A `workerLoaders: { PLUGIN_LOADER: {} }` binding loads a module from a string with `get(name, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))` and calls its default `fetch` and its exported classes. No experimental flag is needed.
- **Facets work.** In a SQLite-backed Durable Object, `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Counter") }))` runs the loaded class with its own SQLite database, separate from the parent's; the data survives a Miniflare restart with persistence on. `ctx.facets.abort(name, reason)` stops a running facet, and the next `get` starts it from a newly loaded class over the same storage.
- **`ctx.exports` needs `enable_ctx_exports`** at this compatibility date; without it `ctx.exports` is undefined.
- **Facet alarms do not fire locally.** `setAlarm` inside a facet fails with "alarms are not yet implemented for SQLite-backed Durable Objects", so the residual risk above is reasoned from the capability fencing the suite tests, not observed with a fired alarm.

Not verified locally or on Cloudflare: a fired facet alarm, and the memory gate of 50 concurrent facets under one supervisor.

## Gate finding (Cloudflare)

Measured on 2026-10-20 on the Cloudflare account "Kanusdlp@gmail.com's Account", the one the staging deploy uses, with Wrangler 4.114.0. A throwaway Worker, `claxedo-plugin-gate-test`, ran at the hosted compatibility date and flags (2025-05-01; `nodejs_compat`, `global_fetch_strictly_public`, `enable_ctx_exports`). It used the supervisor's shape: a SQLite-backed Durable Object loading one module through `PLUGIN_LOADER.get(id, () => ({ compatibilityDate, mainModule, modules, env, globalOutbound }))`, with a `ctx.exports` entrypoint as the outbound. The Worker was deleted afterwards, and the API answers 404 for it.

| Check | Result | Evidence |
| --- | --- | --- |
| Deploy with `[[worker_loaders]]` | Pass | Accepted with no account enablement. The script's settings list `{ name: "PLUGIN_LOADER", type: "worker_loader" }`. |
| Load a module at runtime and call its `fetch` | Pass | `getEntrypoint().fetch` answered 200 with the loaded module's JSON. |
| Facet runs the loaded class, and its SQLite rows persist | Pass | `ctx.facets.get(name, () => ({ class: worker.getDurableObjectClass("Store") }))`. A row written in one request was read back in later requests and after a redeploy restarted the Worker. Another facet name saw no rows. |
| `ctx.facets.delete(name)` | Pass | The facet's rows were gone on the next read. |
| Supervisor `ctx.storage.deleteAll()` deletes facet storage | Pass, with a condition | A stopped facet read no rows afterwards. A facet that was still running kept serving its rows until the Worker restarted, and then they were gone. |
| Supervisor (non-facet) alarm | Pass | A `setAlarm(now + 3 s)` fired once, with `retryCount` 0. `getAlarm()` was then null, and the handler had still run only once 40 s later. |
| `globalOutbound` limits the loaded code's `fetch` | Pass | Through the outbound entrypoint, `https://example.com/` answered 200, while `https://www.cloudflare.com/` and `http://example.com/` answered 403 `plugin_outbound_refused`. With `globalOutbound: null`, `fetch` throws "This worker is not permitted to access the internet via global functions like fetch()". |
| Ed25519 `crypto.subtle.verify` | Pass | The RFC 8032 §7.1 TEST 1 vector verifies, and a one-bit-tampered signature does not. A generated key pair signs (64 bytes) and verifies, and the signature fails against a different message. |
| Worker Loader limits | None hit | The 28.77 KiB upload (7.55 KiB gzip) started in 8 ms. Each facet reported a `databaseSize` of 16384 bytes. No response named a limit. The limits page on developers.cloudflare.com could not be reached from the measuring session, so the documented module-count and memory limits were not read. |

Because a running facet outlives `deleteAll`, a purge deletes every facet the registry names with `ctx.facets.delete` first, and only then the supervisor's own storage.

Inside a facet, `ctx.id` is the supervisor's id: every facet reported the same id. A plugin therefore cannot use `ctx.id` to tell its objects apart.


## Tests

`bun test src` runs:

- `runs.test.ts`: the run transitions, with controlled reads and loads;
- `caller-handles.test.ts`: handle lifetime, epochs and expiry over a controlled clock;
- `platform-admission.test.ts`: every call refused for a dead epoch and an undeclared permission, a cloud session start refused without `workspaces.cloud`, a person's calls refused without a person, and malformed calls;
- `supervisor.test.ts`: the purge's order and refusals, and the schedule's alarm arming, against the supervisor class over a recording `ctx` with a real SQLite database.

The runtime on workerd is tested through the hosted adapter's suite, `packages/claxedo-server/src/plugin-backends/plugin-backends.workerd.test.ts`.
