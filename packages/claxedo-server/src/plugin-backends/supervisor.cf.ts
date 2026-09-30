import { DurableObject } from "cloudflare:workers"
import type { D1Database, Fetcher, WorkerLoader, WorkerStub } from "@cloudflare/workers-types"
import { pluginBackendRouteAllowed } from "@claxedo/plugin-api/manifest"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import { readPluginBackendState, type PluginBackendActivation } from "./activations"
import { readPluginBackendBundle } from "./bundles"
import { pluginRefusal } from "./refusal"
import { PluginBackendRuns, type PluginDispatch } from "./runs"

export type PluginBackendEnv = {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AgentPluginR2Bucket
  PLUGIN_LOADER: WorkerLoader
  PLUGIN_SUPERVISOR: PluginSupervisorNamespace
}

export type PluginScope = Readonly<{ orgId: string; pluginId: string }>

export type PluginCaller = PluginScope & Readonly<{ userId: string }>

/** The scope every capability of a loaded backend is bound to: one activation epoch of one plugin in one organization. */
export type PluginRunScope = PluginScope & Readonly<{ epoch: number }>

export type PluginSupervisorStub = {
  request(caller: PluginCaller, request: Request): Promise<Response>
  object(scope: PluginRunScope, className: string, name: string, request: Request): Promise<Response>
  active(scope: PluginRunScope): Promise<boolean>
  refresh(scope: PluginScope): Promise<void>
}

export interface PluginSupervisorNamespace {
  idFromName(name: string): unknown
  get(id: unknown): PluginSupervisorStub
}

/** The one supervisor an organization's plugin backends run under. */
export function pluginSupervisor(namespace: PluginSupervisorNamespace, orgId: string): PluginSupervisorStub {
  return namespace.get(namespace.idFromName(`org:${orgId}`))
}

const PLUGIN_USER_HEADER = "x-claxedo-user-id"
const PLUGIN_COMPATIBILITY_DATE = "2025-05-01"
const PLUGIN_MODULE = "backend.js"
const OBJECT_NAME_MAX_LENGTH = 256

/** `ctx.exports` is typed from a main module this package does not declare to workers-types. */
type LoaderExports = {
  PluginPlatform(options: { props: PluginRunScope }): Fetcher
  PluginOutbound(options: { props: PluginRunScope & { hosts: readonly string[] } }): Fetcher
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
 * One per organization, named `org:<orgId>`. It loads each activated plugin's
 * backend through the Worker Loader, once per activation epoch, and runs the
 * plugin's Durable Object classes as its own facets, so every object a plugin
 * reaches holds only this organization's storage. The caller is authenticated
 * before it gets here; this object answers only to the Worker that owns its
 * namespace.
 */
export class PluginSupervisor extends DurableObject<PluginBackendEnv> {
  #orgId: string | undefined
  #runs: PluginBackendRuns<WorkerStub> | undefined

  async request(caller: PluginCaller, request: Request): Promise<Response> {
    const url = new URL(request.url)
    return this.#runsFor(caller.orgId).dispatch(caller.pluginId, {
      ...refusals(caller.pluginId),
      refuse: (activation) =>
        pluginBackendRouteAllowed(activation.manifest.backend, request.method, url.pathname)
          ? undefined
          : pluginRefusal(404, "plugin_route_not_declared", `Plugin ${caller.pluginId} declares no route ${request.method} ${url.pathname}`),
      send: (worker) => {
        const headers = new Headers({ [PLUGIN_USER_HEADER]: caller.userId })
        const contentType = request.headers.get("content-type")
        if (contentType) headers.set("content-type", contentType)
        return fetchThrough(worker.getEntrypoint(), new Request(url, { method: request.method, headers, body: request.body }))
      },
    })
  }

  async object(scope: PluginRunScope, className: string, name: string, request: Request): Promise<Response> {
    return this.#runsFor(scope.orgId).dispatch(scope.pluginId, {
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
        const facet = JSON.stringify([scope.pluginId, className, name])
        track(facet)
        return fetchThrough(this.ctx.facets.get(facet, () => ({ class: worker.getDurableObjectClass(className) })), request)
      },
    })
  }

  async active(scope: PluginRunScope): Promise<boolean> {
    return this.#runsFor(scope.orgId).admits(scope.pluginId, scope.epoch)
  }

  async refresh(scope: PluginScope): Promise<void> {
    await this.#runsFor(scope.orgId).current(scope.pluginId)
  }

  #runsFor(orgId: string): PluginBackendRuns<WorkerStub> {
    if (this.#orgId !== undefined && this.#orgId !== orgId) throw new Error(`supervisor for ${this.#orgId} was asked about ${orgId}`)
    this.#orgId = orgId
    this.#runs ??= new PluginBackendRuns({
      readState: (pluginId) => readPluginBackendState(this.env.CONTROL_PLANE_DB, orgId, pluginId),
      loadWorker: (activation) => this.#load(activation),
      abortFacet: (facet, reason) => this.ctx.facets.abort(facet, reason),
    })
    return this.#runs
  }

  async #load(activation: PluginBackendActivation): Promise<WorkerStub | undefined> {
    const code = await readPluginBackendBundle(this.env.CLAXEDO_AGENT_PLUGINS, activation.bundleHash)
    if (code === undefined) return undefined
    const exports = this.ctx.exports as unknown as LoaderExports
    const scope: PluginRunScope = { orgId: activation.orgId, pluginId: activation.pluginId, epoch: activation.epoch }
    // The epoch is part of the id because it is part of the loaded Worker's
    // environment: an identical reactivation must not inherit bindings
    // fenced to an epoch that has ended.
    return this.env.PLUGIN_LOADER.get(`${scope.orgId}/${scope.pluginId}/${activation.generation}/${scope.epoch}`, () => ({
      compatibilityDate: PLUGIN_COMPATIBILITY_DATE,
      mainModule: PLUGIN_MODULE,
      modules: { [PLUGIN_MODULE]: code },
      env: { PLATFORM: exports.PluginPlatform({ props: scope }) },
      globalOutbound: exports.PluginOutbound({ props: { ...scope, hosts: activation.manifest.backend.outbound } }),
    }))
  }
}
