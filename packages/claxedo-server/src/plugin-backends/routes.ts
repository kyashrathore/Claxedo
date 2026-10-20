import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { isPluginId } from "@claxedo/plugin-api/id"
import { PLUGIN_BACKEND_METHODS } from "@claxedo/plugin-api/manifest"
import { pluginRefusal, pluginSupervisor, type PluginRequestCaller, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { readAppPluginAccess } from "./installs"
import { orgCallerOrRefusal, type OrgCallerInput } from "./org-caller"
import { pluginAnswer } from "./plugin-answer"
import type { AppPluginToolsAccess } from "./tool-access"
import { pluginToolCallHandler } from "./tool-routes"

export const PLUGIN_BACKEND_ROUTE_PREFIX = "/api/plugins"

const PLUGIN_REQUEST_ORIGIN = "https://plugin.claxedo.internal"

export type PluginBackendRouteInput = OrgCallerInput &
  Readonly<{
    database: D1Database
    supervisors: PluginSupervisorNamespace
    /** Absent where no MCP mount serves plugin tools; then no tool call reaches a backend. */
    tools?: AppPluginToolsAccess
  }>

/**
 * Sends `method path?search` to the plugin's supervisor for `caller`. Only the
 * body and its content type cross to the plugin, and only the status, body and
 * content type come back (`pluginAnswer`).
 */
export async function forwardToPlugin(
  supervisors: PluginSupervisorNamespace,
  caller: PluginRequestCaller,
  outgoing: Readonly<{ method: string; path: string; search: string; contentType?: string | undefined; body: ReadableStream<Uint8Array> | null }>,
): Promise<Response> {
  const forwarded = new Request(`${PLUGIN_REQUEST_ORIGIN}${outgoing.path}${outgoing.search}`, {
    method: outgoing.method,
    headers: outgoing.contentType ? { "content-type": outgoing.contentType } : {},
    body: outgoing.method === "GET" ? null : outgoing.body,
  })
  try {
    return pluginAnswer(await pluginSupervisor(supervisors, caller).request(caller, forwarded))
  } catch (error) {
    console.error(`[plugin-backends] ${caller.pluginId} failed`, error)
    return pluginRefusal(502, "plugin_backend_failed", `Plugin ${caller.pluginId} failed to answer`)
  }
}

/**
 * `/api/plugins/:pluginId/*`: the signed caller's organization is resolved
 * here, and the request goes to that organization's supervisor for the plugin
 * only while the organization has it installed and active and the caller has
 * it enabled. `POST /:pluginId/_tools/:name` is an agent's tool call
 * (`pluginToolCallHandler`); every other path under `/_` is the platform's.
 */
export function pluginBackendRouteContribution(input: PluginBackendRouteInput): ControlPlaneRouteContribution {
  const routes = new Hono()
  if (input.tools) routes.post("/:pluginId/_tools/:name", pluginToolCallHandler({ ...input.tools, supervisors: input.supervisors }))
  routes.all("/:pluginId/*", async (context) => {
    const pluginId = context.req.param("pluginId")
    if (!isPluginId(pluginId)) return pluginRefusal(404, "plugin_not_found", "No plugin has that id")
    const method = context.req.method
    if (!(PLUGIN_BACKEND_METHODS as readonly string[]).includes(method)) {
      return pluginRefusal(405, "plugin_method_not_allowed", `Plugin routes do not answer ${method}`)
    }
    const caller = await orgCallerOrRefusal(context.req.raw, input)
    if (caller instanceof Response) return caller
    const scope = { orgId: caller.orgId, pluginId }
    const access = await readAppPluginAccess(input.database, scope, caller.userId)
    if (access === "not_installed" || access === "inactive") {
      return pluginRefusal(404, "plugin_not_activated", `This organization has not activated plugin ${pluginId}`)
    }
    if (access === "not_enabled") return pluginRefusal(404, "plugin_not_enabled", `Plugin ${pluginId} is not enabled for you`)
    const url = new URL(context.req.url)
    return forwardToPlugin(input.supervisors, { ...scope, origin: "person", userId: caller.userId }, {
      method,
      path: url.pathname.slice(`${PLUGIN_BACKEND_ROUTE_PREFIX}/${pluginId}`.length),
      search: url.search,
      contentType: context.req.header("content-type"),
      body: context.req.raw.body,
    })
  })
  return { id: "plugin-backends", path: PLUGIN_BACKEND_ROUTE_PREFIX, routes }
}
