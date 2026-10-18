import { Hono } from "hono"
import { isPluginId } from "@claxedo/plugin-api/id"
import { PLUGIN_BACKEND_METHODS } from "@claxedo/plugin-api/manifest"
import { ControlPlaneAuthError, controlPlaneAuthErrorBody } from "@claxedo/server-core/platform/auth/auth"
import type { RequestAuthenticationAdapter } from "@claxedo/server-core/platform/auth/authentication"
import type { WorkspaceAuthority } from "@claxedo/server-core/platform/auth/authority"
import type { ControlPlaneRouteContribution } from "@claxedo/server-core/platform/http/route-contribution"
import type { ControlPlaneServices } from "../authority/services"
import { signedOrError } from "../workspace/route-support"
import { pluginRefusal } from "./refusal"
import { pluginSupervisor, type PluginSupervisorNamespace } from "./supervisor.cf"

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

export type PluginBackendRouteInput = {
  authentication: RequestAuthenticationAdapter
  authority: Pick<WorkspaceAuthority, "resolveOrgId">
  supervisors: PluginSupervisorNamespace
  services?: ControlPlaneServices
}

/**
 * `/api/plugins/:pluginId/*`: the signed caller's organization is resolved
 * here, through the same signed principal every control-plane route reads, and
 * the request goes to that organization's supervisor with the plugin path. The
 * caller never names an organization, so another organization's plugin is
 * unreachable by construction. Only the body and its content type cross to the
 * plugin, and only the status, body and content type come back, under
 * `PLUGIN_ANSWER_HEADERS`.
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
    const signed = await signedOrError(context.req.raw, { authentication: input.authentication, requireSigned: true }, input.services)
    if ("error" in signed) return Response.json(signed.error, { status: signed.status })
    const principal = signed.auth?.principal
    if (!signed.auth || !principal) return pluginRefusal(401, "unauthorized", "A signed caller is required")
    let orgId: string
    try {
      orgId = await input.authority.resolveOrgId(signed.auth)
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return Response.json(controlPlaneAuthErrorBody(error), { status: error.status })
      throw error
    }
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
      answer = await pluginSupervisor(input.supervisors, orgId).request({ orgId, pluginId, userId: principal.userId }, forwarded)
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
