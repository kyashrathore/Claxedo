import { WorkerEntrypoint } from "cloudflare:workers"
import type { Request as WorkerRequest, Response as WorkerResponse } from "@cloudflare/workers-types"
import { pluginRefusal } from "./refusal"
import { pluginSupervisor, type PluginBackendEnv, type PluginRunScope } from "./supervisor.cf"

/**
 * `env.PLATFORM` inside a loaded backend, bound by the supervisor to the one
 * generation it loaded, so a plugin names objects but never an organization,
 * and a backend the organization has since replaced reaches nothing.
 * `object(className, name, request)` reaches an object of the plugin's;
 * `active()` answers whether this generation is still the current activation.
 */
export class PluginPlatform extends WorkerEntrypoint<PluginBackendEnv, PluginRunScope> {
  object(className: string, name: string, request: Request): Promise<Response> {
    return pluginSupervisor(this.env.PLUGIN_SUPERVISOR, this.ctx.props.orgId).object(this.ctx.props, className, name, request)
  }

  active(): Promise<boolean> {
    return pluginSupervisor(this.env.PLUGIN_SUPERVISOR, this.ctx.props.orgId).active(this.ctx.props)
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
