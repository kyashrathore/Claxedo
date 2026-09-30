import { DurableObject } from "cloudflare:workers"
import type { D1Database, Fetcher, WorkerLoader, WorkerStub } from "@cloudflare/workers-types"
import { pluginBackendRouteAllowed, type PluginBackend } from "@claxedo/plugin-api/manifest"
import type { AgentPluginR2Bucket } from "../agent-plugins/artifacts/r2-artifact-adapter"
import { readPluginBackendActivation } from "./activations"
import { readPluginBackendBundle } from "./bundles"
import { pluginRefusal } from "./refusal"

export type PluginBackendEnv = {
  CONTROL_PLANE_DB: D1Database
  CLAXEDO_AGENT_PLUGINS: AgentPluginR2Bucket
  PLUGIN_LOADER: WorkerLoader
  PLUGIN_SUPERVISOR: PluginSupervisorNamespace
}

export type PluginScope = Readonly<{ orgId: string; pluginId: string }>

export type PluginCaller = PluginScope & Readonly<{ userId: string }>

export type PluginSupervisorStub = {
  request(caller: PluginCaller, request: Request): Promise<Response>
  object(scope: PluginScope, className: string, name: string, request: Request): Promise<Response>
}

export interface PluginSupervisorNamespace {
  idFromName(name: string): unknown
  get(id: unknown): PluginSupervisorStub
}

/** The one supervisor an organization's plugin backends run under. */
export function pluginSupervisor(namespace: PluginSupervisorNamespace, orgId: string): PluginSupervisorStub {
  return namespace.get(namespace.idFromName(`org:${orgId}`))
}

export const PLUGIN_USER_HEADER = "x-claxedo-user-id"

const PLUGIN_COMPATIBILITY_DATE = "2025-05-01"
const PLUGIN_MODULE = "backend.js"
const OBJECT_NAME_MAX_LENGTH = 256

/** `ctx.exports` is typed from a main module this package does not declare to workers-types. */
type LoaderExports = {
  PluginObjects(options: { props: PluginScope }): Fetcher
  PluginOutbound(options: { props: { hosts: readonly string[] } }): Fetcher
}

/**
 * workers-types gives a `Fetcher` the runtime's own `Request` and `Response`,
 * while this package compiles against the DOM lib's; at runtime they are the
 * same classes.
 */
async function fetchThrough(fetcher: Fetcher, request: Request): Promise<Response> {
  return (await fetcher.fetch(request as unknown as Parameters<Fetcher["fetch"]>[0])) as unknown as Response
}

type LoadedBackend = {
  hash: string
  backend: PluginBackend
  worker?: Promise<WorkerStub | undefined>
  facets: Set<string>
}

/**
 * One per organization, named `org:<orgId>`. It loads each activated plugin's
 * backend through the Worker Loader, once per bundle hash, and runs the
 * plugin's Durable Object classes as its own facets, so every object a plugin
 * reaches holds only this organization's storage. The caller is authenticated
 * before it gets here; this object answers only to the Worker that owns its
 * namespace.
 */
export class PluginSupervisor extends DurableObject<PluginBackendEnv> {
  readonly #loaded = new Map<string, LoadedBackend>()

  async request(caller: PluginCaller, request: Request): Promise<Response> {
    const loaded = await this.#load(caller)
    if (!loaded) return pluginRefusal(404, "plugin_not_activated", `This organization has not activated plugin ${caller.pluginId}`)
    const url = new URL(request.url)
    if (!pluginBackendRouteAllowed(loaded.backend, request.method, url.pathname)) {
      return pluginRefusal(404, "plugin_route_not_declared", `Plugin ${caller.pluginId} declares no route ${request.method} ${url.pathname}`)
    }
    const worker = await this.#ready(caller, loaded)
    if (!worker) return pluginRefusal(503, "plugin_bundle_unavailable", `The bundle for plugin ${caller.pluginId} is not stored`)
    const headers = new Headers({ [PLUGIN_USER_HEADER]: caller.userId })
    const contentType = request.headers.get("content-type")
    if (contentType) headers.set("content-type", contentType)
    const forwarded = new Request(url, { method: request.method, headers, body: request.body })
    return fetchThrough(worker.getEntrypoint(), forwarded)
  }

  async object(scope: PluginScope, className: string, name: string, request: Request): Promise<Response> {
    const loaded = await this.#load(scope)
    if (!loaded) return pluginRefusal(404, "plugin_not_activated", `This organization has not activated plugin ${scope.pluginId}`)
    if (!loaded.backend.objects.includes(className)) {
      return pluginRefusal(404, "plugin_object_not_declared", `Plugin ${scope.pluginId} declares no object class ${className}`)
    }
    if (!name || name.length > OBJECT_NAME_MAX_LENGTH) {
      return pluginRefusal(400, "plugin_object_name_invalid", `An object name is 1 to ${OBJECT_NAME_MAX_LENGTH} characters`)
    }
    const worker = await this.#ready(scope, loaded)
    if (!worker) return pluginRefusal(503, "plugin_bundle_unavailable", `The bundle for plugin ${scope.pluginId} is not stored`)
    const facet = JSON.stringify([scope.pluginId, className, name])
    loaded.facets.add(facet)
    return fetchThrough(this.ctx.facets.get(facet, () => ({ class: worker.getDurableObjectClass(className) })), request)
  }

  async #load(scope: PluginScope): Promise<LoadedBackend | undefined> {
    const activation = await readPluginBackendActivation(this.env.CONTROL_PLANE_DB, scope.orgId, scope.pluginId)
    const current = this.#loaded.get(scope.pluginId)
    if (current && current.hash === activation?.bundleHash) return current
    if (current) this.#retire(scope.pluginId, current)
    if (!activation) return undefined
    const loaded: LoadedBackend = { hash: activation.bundleHash, backend: activation.manifest.backend, facets: new Set() }
    this.#loaded.set(scope.pluginId, loaded)
    return loaded
  }

  async #worker(scope: PluginScope, loaded: LoadedBackend): Promise<WorkerStub | undefined> {
    const code = await readPluginBackendBundle(this.env.CLAXEDO_AGENT_PLUGINS, loaded.hash)
    if (code === undefined) return undefined
    const exports = this.ctx.exports as unknown as LoaderExports
    return this.env.PLUGIN_LOADER.get(`${scope.orgId}/${scope.pluginId}/${loaded.hash}`, () => ({
      compatibilityDate: PLUGIN_COMPATIBILITY_DATE,
      mainModule: PLUGIN_MODULE,
      modules: { [PLUGIN_MODULE]: code },
      env: { OBJECTS: exports.PluginObjects({ props: { orgId: scope.orgId, pluginId: scope.pluginId } }) },
      globalOutbound: exports.PluginOutbound({ props: { hosts: loaded.backend.outbound } }),
    }))
  }

  /** The loaded Worker, read from the bucket on first use; a missing or corrupt bundle is read again next time. */
  async #ready(scope: PluginScope, loaded: LoadedBackend): Promise<WorkerStub | undefined> {
    loaded.worker ??= this.#worker(scope, loaded)
    const worker = await loaded.worker.catch((error: unknown) => {
      if (this.#loaded.get(scope.pluginId) === loaded) loaded.worker = undefined
      throw error
    })
    if (!worker && this.#loaded.get(scope.pluginId) === loaded) loaded.worker = undefined
    return worker
  }

  #retire(pluginId: string, loaded: LoadedBackend) {
    this.#loaded.delete(pluginId)
    for (const facet of loaded.facets) this.ctx.facets.abort(facet, new Error(`plugin ${pluginId} is no longer running bundle ${loaded.hash}`))
  }
}
