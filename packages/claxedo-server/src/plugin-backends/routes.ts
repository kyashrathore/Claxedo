import type { D1Database } from "@cloudflare/workers-types"
import { Hono } from "hono"
import { isPluginId } from "@claxedo/plugin-api/id"
import { PLUGIN_BACKEND_METHODS } from "@claxedo/plugin-api/manifest"
import { pluginRefusal, pluginSupervisor, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import { readAppPluginAccess } from "./installs"
import { orgCallerOrRefusal, type OrgCallerInput } from "./org-caller"

export const PLUGIN_BACKEND_ROUTE_PREFIX = "/api/plugins"

const PLUGIN_REQUEST_ORIGIN = "https://plugin.claxedo.internal"

/**
 * The plugin chooses its answer's content type, and the answer is served from
 * the control plane's own origin: a `text/html` answer opened as a page would
 * otherwise run the plugin's script with that origin's cookies.
 */
const PLUGIN_ANSWER_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
}

export type PluginBackendRouteInput = OrgCallerInput &
  Readonly<{
    database: D1Database
    supervisors: PluginSupervisorNamespace
  }>

/**
 * `/api/plugins/:pluginId/*`: the signed caller's organization is resolved
 * here, and the request goes to that organization's supervisor for the plugin
 * only while the organization has it installed and active and the caller has
 * it enabled. Only the body and its content type cross to the plugin, and only
 * the status, body and content type come back, under `PLUGIN_ANSWER_HEADERS`.
 */
export function pluginBackendRouteContribution(input: PluginBackendRouteInput): ControlPlaneRouteContribution {
  const routes = new Hono()
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
    const path = url.pathname.slice(`${PLUGIN_BACKEND_ROUTE_PREFIX}/${pluginId}`.length)
    const contentType = context.req.header("content-type")
    const forwarded = new Request(`${PLUGIN_REQUEST_ORIGIN}${path}${url.search}`, {
      method,
      headers: contentType ? { "content-type": contentType } : {},
      body: method === "GET" ? null : context.req.raw.body,
    })
    let answer: Response
    try {
      answer = await pluginSupervisor(input.supervisors, scope).request({ ...scope, userId: caller.userId }, forwarded)
    } catch (error) {
      console.error(`[plugin-backends] ${pluginId} failed`, error)
      return pluginRefusal(502, "plugin_backend_failed", `Plugin ${pluginId} failed to answer`)
    }
    const answerType = answer.headers.get("content-type")
    return new Response(answer.body, {
      status: answer.status,
      headers: { ...PLUGIN_ANSWER_HEADERS, ...(answerType ? { "content-type": answerType } : {}) },
    })
  })
  return { id: "plugin-backends", path: PLUGIN_BACKEND_ROUTE_PREFIX, routes }
}
