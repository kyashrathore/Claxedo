import { DurableObject } from "cloudflare:workers"
import type { DurableObjectState, Fetcher, WorkerLoader, WorkerStub } from "@cloudflare/workers-types"
import {
  PLUGIN_BLOB_LIMITS,
  PLUGIN_CALLER_HEADER,
  PLUGIN_EVENT_LIMITS,
  PLUGIN_OBJECT_NAME_HEADER,
  PLUGIN_TOOL_PATH_PREFIX,
  PLUGIN_WAKE_PATH_PREFIX,
  type PluginCaller,
  type PluginPlatformAnswer,
} from "@claxedo/plugin-api/backend"
import { jsonByteLength } from "@claxedo/plugin-api/backend-schema"
import { pluginBackendRouteAllowed } from "@claxedo/plugin-api/manifest"
import { PluginBlobUsage } from "./blob-usage"
import { PluginCallerHandles } from "./caller-handles"
import { activationGeneration, verifiedBundle } from "./digest"
import type { PluginAgentCaller, PluginBackendActivation, PluginHostPort, PluginRequestCaller, PluginRunScope, PluginScope } from "./host-port"
import { admitPlatformCall, refusedCall } from "./platform-admission"
import { pluginRefusal } from "./refusal"
import { PluginBackendRuns, type PluginDispatch } from "./runs"
import type { PluginSupervisorNamespace } from "./supervisor-stub"
import { PluginWakes } from "./wakes"

/** The bindings the runtime itself needs; a host's own bindings reach it only through its `PluginHostPort`. */
export type PluginRuntimeEnv = {
  PLUGIN_LOADER: WorkerLoader
  PLUGIN_SUPERVISOR: PluginSupervisorNamespace
}

const PLUGIN_COMPATIBILITY_DATE = "2025-05-01"
const PLUGIN_MODULE = "backend.js"
const PLUGIN_REQUEST_ORIGIN = "https://plugin.claxedo.internal"
const OBJECT_NAME_MAX_LENGTH = 256
const EVENT_WINDOW_MS = 1000

// Every Worker main module that hosts the supervisor also exports its
// entrypoints, which is what types `ctx.exports`.
declare module "@cloudflare/workers-types" {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./entrypoints.cf")
    }
  }
}

/**
 * workers-types gives a `Fetcher` the runtime's own `Request` and `Response`,
 * while this package compiles against the DOM lib's; at runtime they are the
 * same classes.
 */
function fetchThrough(fetcher: Fetcher, request: Request): Promise<Response> {
  return fetcher.fetch(request as unknown as Parameters<Fetcher["fetch"]>[0]) as unknown as Promise<Response>
}

function refusals(pluginId: string): Pick<PluginDispatch<WorkerStub, Response>, "inactive" | "unavailable" | "changing"> {
  return {
    inactive: () => pluginRefusal(404, "plugin_not_activated", `This organization has not activated plugin ${pluginId}`),
    unavailable: () => pluginRefusal(503, "plugin_bundle_unavailable", `The bundle for plugin ${pluginId} is not stored`),
    changing: () => pluginRefusal(503, "plugin_backend_changing", `Plugin ${pluginId} changed while the request was starting`),
  }
}

function callerOf(caller: PluginRequestCaller): PluginCaller {
  return caller.origin === "person" ? { orgId: caller.orgId, origin: "person", userId: caller.userId } : { orgId: caller.orgId, origin: "link" }
}

/**
 * The supervisor Durable Object class over a host's port. A host's Worker
 * entry exports the result as `PluginSupervisor`, beside `PluginPlatform` and
 * `PluginOutbound` from `./entrypoints.cf`.
 *
 * One object per organization and plugin, named by `pluginSupervisorName`. It
 * loads the plugin's backend through the Worker Loader, once per activation
 * epoch, runs the plugin's Durable Object classes as its own facets, admits
 * every platform call the backend makes, and delivers its wakes on its own
 * alarm. The caller is authenticated before it gets here; this object answers
 * only to the Worker that owns its namespace.
 */
export function pluginSupervisorClass<Env extends PluginRuntimeEnv>(hostPort: (env: Env) => PluginHostPort) {
  return class PluginSupervisor extends DurableObject<Env> {
    readonly #port: PluginHostPort
    readonly #handles = new PluginCallerHandles()
    readonly #wakes: PluginWakes
    readonly #blobs: PluginBlobUsage
    readonly #events: number[] = []
    #scope: PluginScope | undefined
    #runs: PluginBackendRuns<WorkerStub> | undefined

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      this.#port = hostPort(env)
      this.#wakes = new PluginWakes({
        sql: ctx.storage.sql,
        setAlarm: (at) => ctx.storage.setAlarm(at),
        deleteAlarm: () => ctx.storage.deleteAlarm(),
      })
      this.#blobs = new PluginBlobUsage(ctx.storage.sql)
      this.#createSchema()
    }

    // `plugin_facets` lists every facet this plugin ever started, so a purge
    // reaches the ones no run of this isolate started; `plugin_scope` names
    // the plugin to an alarm, which arrives with no caller.
    #createSchema() {
      this.ctx.storage.sql.exec("create table if not exists plugin_facets (name text primary key, class_name text not null, created_at integer not null)")
      this.ctx.storage.sql.exec("create table if not exists plugin_scope (id integer primary key check (id = 1), org_id text not null, plugin_id text not null)")
      this.#wakes.createSchema()
      this.#blobs.createSchema()
    }

    async request(caller: PluginRequestCaller, request: Request): Promise<Response> {
      const url = new URL(request.url)
      if (url.pathname.startsWith("/_")) return pluginRefusal(404, "plugin_route_reserved", "Paths under /_ are the platform's own calls into a backend")
      return this.#runsFor(caller).dispatch({
        ...refusals(caller.pluginId),
        refuse: (activation) => {
          if (!pluginBackendRouteAllowed(activation.manifest.backend, request.method, url.pathname)) {
            return pluginRefusal(404, "plugin_route_not_declared", `Plugin ${caller.pluginId} declares no route ${request.method} ${url.pathname}`)
          }
          if (caller.origin === "link" && request.method !== "GET") return pluginRefusal(405, "plugin_link_read_only", "A public link only reads")
          return undefined
        },
        send: (worker, activation) => this.#send(worker, activation, callerOf(caller), new Request(url, { method: request.method, headers: request.headers, body: request.body })),
      })
    }

    async tool(caller: PluginAgentCaller, name: string, body: string): Promise<Response> {
      const { pluginId, ...agent } = caller
      const delivery = new Request(`${PLUGIN_REQUEST_ORIGIN}${PLUGIN_TOOL_PATH_PREFIX}${encodeURIComponent(name)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
      return this.#runsFor(caller).dispatch({
        ...refusals(pluginId),
        refuse: (activation) =>
          activation.manifest.backend.tools ? undefined : pluginRefusal(404, "plugin_tools_not_declared", `Plugin ${pluginId} declares no tools`),
        send: (worker, activation) => this.#send(worker, activation, agent, delivery),
      })
    }

    async object(scope: PluginRunScope, className: string, name: string, request: Request): Promise<Response> {
      return this.#runsFor(scope).dispatch({
        ...refusals(scope.pluginId),
        refuse: (activation) => {
          if (activation.epoch !== scope.epoch) {
            return pluginRefusal(409, "plugin_backend_replaced", `Plugin ${scope.pluginId} is running a newer activation`)
          }
          if (!activation.manifest.backend.objects.includes(className)) {
            return pluginRefusal(404, "plugin_object_not_declared", `Plugin ${scope.pluginId} declares no object class ${className}`)
          }
          if (!name || name.length > OBJECT_NAME_MAX_LENGTH) {
            return pluginRefusal(400, "plugin_object_name_invalid", `An object name is 1 to ${OBJECT_NAME_MAX_LENGTH} characters`)
          }
          return undefined
        },
        send: (worker, _activation, track) => {
          const facet = JSON.stringify([className, name])
          this.ctx.storage.sql.exec(
            "insert into plugin_facets (name, class_name, created_at) values (?, ?, ?) on conflict (name) do nothing",
            facet,
            className,
            Date.now(),
          )
          track(facet)
          // Every facet's `ctx.id` is the supervisor's, so the object learns
          // which of the plugin's objects it is only from this header.
          const headers = new Headers(request.headers)
          headers.set(PLUGIN_OBJECT_NAME_HEADER, name)
          const named = new Request(request, { headers })
          return fetchThrough(this.ctx.facets.get(facet, () => ({ class: worker.getDurableObjectClass(className) })), named)
        },
      })
    }

    async active(scope: PluginRunScope): Promise<boolean> {
      return this.#runsFor(scope).admits(scope.epoch)
    }

    /** A platform call from the backend loaded under `scope`, admitted against the current activation and the caller of `handle`. */
    async platform(scope: PluginRunScope, raw: unknown, handle: string | undefined): Promise<PluginPlatformAnswer> {
      const run = await this.#runsFor(scope).current()
      const caller = typeof handle === "string" ? this.#handles.resolve(scope.epoch, handle) : undefined
      const admitted = admitPlatformCall({ raw, epoch: scope.epoch, activation: run?.activation, caller })
      if (!admitted.ok) return admitted
      const { call } = admitted
      switch (call.name) {
        case "identity.caller":
          return { ok: true, value: admitted.caller }
        case "schedule.at":
          return this.#wakes.at(call.wake, call.at, call.payload)
        case "schedule.cancel":
          return this.#wakes.cancel(call.wake)
        case "schedule.list":
          return { ok: true, value: this.#wakes.list() }
        case "blobs.put":
          return this.#putBlob(scope, call)
        case "blobs.delete": {
          const answer = await this.#port.platform(call, scope, admitted.caller)
          if (answer.ok) this.#blobs.forget(call.key)
          return answer
        }
        case "events.publish": {
          if (jsonByteLength(call.data) > PLUGIN_EVENT_LIMITS.dataBytes) {
            return refusedCall(413, "plugin_event_too_large", `An event's data is at most ${PLUGIN_EVENT_LIMITS.dataBytes} bytes of JSON`)
          }
          if (!this.#admitEvent()) return refusedCall(429, "plugin_event_rate_limited", `A plugin publishes at most ${PLUGIN_EVENT_LIMITS.perSecond} events a second`)
          return this.#port.platform(call, scope, admitted.caller)
        }
        default:
          return this.#port.platform(call, scope, admitted.caller)
      }
    }

    async refresh(scope: PluginScope): Promise<void> {
      await this.#runsFor(scope).current()
    }

    async purge(scope: PluginScope): Promise<void> {
      if (await this.#runsFor(scope).current()) {
        throw new Error(`plugin ${scope.pluginId} is still active in ${scope.orgId}; its storage is not purged`)
      }
      // A facet that is still running keeps serving its rows after the
      // supervisor's `deleteAll` (Cloudflare gate, 2026-10-20), so each one is
      // deleted by name first.
      const facets = this.ctx.storage.sql.exec<{ name: string }>("select name from plugin_facets").toArray()
      for (const { name } of facets) this.ctx.facets.delete(name)
      await this.ctx.storage.deleteAlarm()
      await this.ctx.storage.deleteAll()
      this.#createSchema()
      this.#remember(scope)
    }

    /** Delivers every wake due at `now`, once each, as a `system` caller; a wake due while no backend is active is dropped. */
    async wakeDue(scope: PluginScope, now: number): Promise<number> {
      const due = await this.#wakes.takeDue(now)
      const runs = this.#runsFor(scope)
      for (const wake of due) {
        const delivery = new Request(`${PLUGIN_REQUEST_ORIGIN}${PLUGIN_WAKE_PATH_PREFIX}${encodeURIComponent(wake.name)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wake.payload ?? null),
        })
        const answer = await runs.dispatch({
          ...refusals(scope.pluginId),
          refuse: () => undefined,
          send: (worker, activation) => this.#send(worker, activation, { orgId: scope.orgId, origin: "system" }, delivery),
        })
        if (!answer.ok) console.error(`[plugin-runtime] wake ${wake.name} of ${scope.pluginId} answered ${answer.status}`)
        await answer.body?.cancel()
      }
      return due.length
    }

    override async alarm(): Promise<void> {
      const [stored] = this.ctx.storage.sql.exec<{ org_id: string; plugin_id: string }>("select org_id, plugin_id from plugin_scope where id = 1").toArray()
      if (stored) await this.wakeDue({ orgId: stored.org_id, pluginId: stored.plugin_id }, Date.now())
    }

    async #send(worker: WorkerStub, activation: PluginBackendActivation, caller: PluginCaller, request: Request): Promise<Response> {
      const minted = this.#handles.mint(activation.epoch, caller)
      const headers = new Headers({ [PLUGIN_CALLER_HEADER]: minted.handle })
      const contentType = request.headers.get("content-type")
      if (contentType) headers.set("content-type", contentType)
      try {
        return await fetchThrough(worker.getEntrypoint(), new Request(request.url, { method: request.method, headers, body: request.body }))
      } finally {
        minted.settle()
      }
    }

    async #putBlob(scope: PluginRunScope, call: Extract<Parameters<PluginHostPort["platform"]>[0], { name: "blobs.put" }>): Promise<PluginPlatformAnswer> {
      const size = call.bytes.byteLength
      if (size > PLUGIN_BLOB_LIMITS.objectBytes) return refusedCall(413, "plugin_blob_too_large", `A blob is at most ${PLUGIN_BLOB_LIMITS.objectBytes} bytes`)
      const previous = this.#blobs.sizeOf(call.key)
      const quota = this.#port.limits?.blobTotalBytes ?? PLUGIN_BLOB_LIMITS.totalBytes
      if (this.#blobs.total() - (previous ?? 0) + size > quota) {
        return refusedCall(413, "plugin_blob_quota_exceeded", `This plugin's blobs hold at most ${quota} bytes in this organization`)
      }
      // Reserved before the host stores it, so a put that interleaves with
      // this one counts it.
      this.#blobs.record(call.key, Math.max(previous ?? 0, size))
      let answer: PluginPlatformAnswer
      try {
        answer = await this.#port.platform(call, scope, undefined)
      } catch (error) {
        this.#restore(call.key, previous)
        throw error
      }
      if (answer.ok) this.#blobs.record(call.key, size)
      else this.#restore(call.key, previous)
      return answer
    }

    #restore(key: string, previous: number | undefined) {
      if (previous === undefined) this.#blobs.forget(key)
      else this.#blobs.record(key, previous)
    }

    #admitEvent(): boolean {
      const now = Date.now()
      for (let oldest = this.#events[0]; oldest !== undefined && oldest <= now - EVENT_WINDOW_MS; oldest = this.#events[0]) this.#events.shift()
      if (this.#events.length >= PLUGIN_EVENT_LIMITS.perSecond) return false
      this.#events.push(now)
      return true
    }

    #remember(scope: PluginScope) {
      this.ctx.storage.sql.exec("insert into plugin_scope (id, org_id, plugin_id) values (1, ?, ?) on conflict (id) do nothing", scope.orgId, scope.pluginId)
    }

    #runsFor(scope: PluginScope): PluginBackendRuns<WorkerStub> {
      if (!this.#scope) {
        this.#scope = { orgId: scope.orgId, pluginId: scope.pluginId }
        this.#remember(this.#scope)
      }
      const own = this.#scope
      if (own.orgId !== scope.orgId || own.pluginId !== scope.pluginId) {
        throw new Error(`the supervisor of ${own.pluginId} in ${own.orgId} was asked about ${scope.pluginId} in ${scope.orgId}`)
      }
      this.#runs ??= new PluginBackendRuns({
        readState: async () => {
          const state = await this.#port.readState(own.orgId, own.pluginId)
          if (state.activation && state.activation.manifest.id !== own.pluginId) {
            throw new Error(`the host answered plugin ${state.activation.manifest.id} for ${own.pluginId}`)
          }
          return state
        },
        loadWorker: (activation) => this.#load(own, activation),
        abortFacet: (facet, reason) => this.ctx.facets.abort(facet, reason),
      })
      return this.#runs
    }

    async #load(own: PluginScope, activation: PluginBackendActivation): Promise<WorkerStub | undefined> {
      const stored = await this.#port.readBundle(activation.bundleHash)
      if (stored === undefined) return undefined
      const code = await verifiedBundle(stored, activation.bundleHash)
      const generation = await activationGeneration(activation)
      const exports = this.ctx.exports
      const scope: PluginRunScope = { ...own, epoch: activation.epoch }
      // The epoch is part of the id because it is part of the loaded Worker's
      // environment: an identical reactivation must not inherit bindings
      // fenced to an epoch that has ended.
      return this.env.PLUGIN_LOADER.get(`${scope.orgId}/${scope.pluginId}/${generation}/${scope.epoch}`, () => ({
        compatibilityDate: PLUGIN_COMPATIBILITY_DATE,
        mainModule: PLUGIN_MODULE,
        modules: { [PLUGIN_MODULE]: code },
        env: { PLATFORM: exports.PluginPlatform({ props: scope }) },
        globalOutbound: exports.PluginOutbound({ props: { ...scope, hosts: activation.manifest.backend.outbound } }),
      }))
    }
  }
}
