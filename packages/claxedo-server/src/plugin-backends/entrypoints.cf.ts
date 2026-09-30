import { WorkerEntrypoint } from "cloudflare:workers"
import type { Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"
import { pluginRefusal } from "./refusal"
import { pluginSupervisor, type PluginBackendEnv, type PluginScope } from "./supervisor.cf"

/**
 * `env.OBJECTS` inside a loaded backend: `object(className, name, request)`
 * reaches that object in the plugin's own organization. The scope is bound by
 * the supervisor when it loads the backend, so a plugin names an object but
 * never an organization.
 */
export class PluginObjects extends WorkerEntrypoint<PluginBackendEnv, PluginScope> {
  object(className: string, name: string, request: Request): Promise<Response> {
    return pluginSupervisor(this.env.PLUGIN_SUPERVISOR, this.ctx.props.orgId).object(this.ctx.props, className, name, request)
  }
}

/** A loaded backend's only network: https to the hosts its manifest lists. */
export class PluginOutbound extends WorkerEntrypoint<unknown, { hosts: readonly string[] }> {
  override async fetch(request: WorkerRequest): Promise<WorkerResponse> {
    // The entrypoint's signature takes workers-types' Request and Response;
    // global `fetch` here is the DOM lib's. They are one class at runtime.
    const url = new URL(request.url)
    const answer =
      url.protocol === "https:" && url.port === "" && this.ctx.props.hosts.includes(url.hostname)
        ? await fetch(request as unknown as Request)
        : pluginRefusal(403, "plugin_outbound_refused", `The plugin's manifest does not allow ${url.protocol}//${url.host}`)
    return answer as unknown as WorkerResponse
  }
}
