import { DurableObject } from "cloudflare:workers"
import type { DurableObjectState, Fetcher, WorkerLoader, WorkerStub } from "@cloudflare/workers-types"
import { pluginBackendRouteAllowed } from "@claxedo/plugin-api/manifest"
import { PLUGIN_CALLER_HEADER, PluginCallerHandles } from "./caller-handles"
import { activationGeneration, verifiedBundle } from "./digest"
import type { PluginBackendActivation, PluginCaller, PluginCallerRecord, PluginHostPort, PluginRunScope, PluginScope } from "./host-port"
import { pluginRefusal } from "./refusal"
import { PluginBackendRuns, type PluginDispatch } from "./runs"
import type { PluginSupervisorNamespace } from "./supervisor-stub"

/** The bindings the runtime itself needs; a host's own bindings reach it only through its `PluginHostPort`. */
export type PluginRuntimeEnv = {
  PLUGIN_LOADER: WorkerLoader
  PLUGIN_SUPERVISOR: PluginSupervisorNamespace
}

const PLUGIN_COMPATIBILITY_DATE = "2025-05-01"
const PLUGIN_MODULE = "backend.js"
const OBJECT_NAME_MAX_LENGTH = 256

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

/**
 * The supervisor Durable Object class over a host's port. A host's Worker
 * entry exports the result as `PluginSupervisor`, beside `PluginPlatform` and
 * `PluginOutbound` from `./entrypoints.cf`.
 *
 * One object per organization and plugin, named by `pluginSupervisorName`. It
 * loads the plugin's backend through the Worker Loader, once per activation
 * epoch, and runs the plugin's Durable Object classes as its own facets, so
 * every object the plugin reaches holds only this organization's storage and
 * no other plugin shares its CPU. The caller is authenticated before it gets
 * here; this object answers only to the Worker that owns its namespace.
 */
export function pluginSupervisorClass<Env extends PluginRuntimeEnv>(hostPort: (env: Env) => PluginHostPort) {
  return class PluginSupervisor extends DurableObject<Env> {
    readonly #port: PluginHostPort
    readonly #handles = new PluginCallerHandles()
    #scope: PluginScope | undefined
    #runs: PluginBackendRuns<WorkerStub> | undefined

    constructor(ctx: DurableObjectState, env: Env) {
      super(ctx, env)
      this.#port = hostPort(env)
      // Every facet this plugin ever started, so a later deletion reaches the
      // ones no run of this isolate started.
      ctx.storage.sql.exec("create table if not exists plugin_facets (name text primary key, class_name text not null, created_at integer not null)")
    }

    async request(caller: PluginCaller, request: Request): Promise<Response> {
      const url = new URL(request.url)
      return this.#runsFor(caller).dispatch({
        ...refusals(caller.pluginId),
        refuse: (activation) =>
          pluginBackendRouteAllowed(activation.manifest.backend, request.method, url.pathname)
            ? undefined
            : pluginRefusal(404, "plugin_route_not_declared", `Plugin ${caller.pluginId} declares no route ${request.method} ${url.pathname}`),
        send: async (worker, activation) => {
          const minted = this.#handles.mint(activation.epoch, { userId: caller.userId, orgId: caller.orgId })
          const headers = new Headers({ [PLUGIN_CALLER_HEADER]: minted.handle })
          const contentType = request.headers.get("content-type")
          if (contentType) headers.set("content-type", contentType)
          try {
            return await fetchThrough(worker.getEntrypoint(), new Request(url, { method: request.method, headers, body: request.body }))
          } finally {
            minted.settle()
          }
        },
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
          return fetchThrough(this.ctx.facets.get(facet, () => ({ class: worker.getDurableObjectClass(className) })), request)
        },
      })
    }

    async active(scope: PluginRunScope): Promise<boolean> {
      return this.#runsFor(scope).admits(scope.epoch)
    }

    async caller(scope: PluginRunScope, handle: string): Promise<PluginCallerRecord | null> {
      if (typeof handle !== "string" || !(await this.#runsFor(scope).admits(scope.epoch))) return null
      return this.#handles.resolve(scope.epoch, handle) ?? null
    }

    async refresh(scope: PluginScope): Promise<void> {
      await this.#runsFor(scope).current()
    }

    #runsFor(scope: PluginScope): PluginBackendRuns<WorkerStub> {
      const own = (this.#scope ??= { orgId: scope.orgId, pluginId: scope.pluginId })
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
