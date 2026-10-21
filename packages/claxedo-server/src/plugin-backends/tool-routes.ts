import { Hono, type Context } from "hono"
import { z } from "zod"
import { isPluginId } from "@claxedo/plugin-api/id"
import { PLUGIN_TOOL_AGENT_HEADER } from "@claxedo/plugin-api/tools"
import { pluginRefusal, pluginSupervisor, type PluginSupervisorNamespace } from "@claxedo/plugin-runtime"
import { pluginAnswer } from "./plugin-answer"
import { toolCallerOrRefusal, toolsListing, type AppPluginToolsAccess } from "./tool-access"
import { mintPluginToolsGrant } from "./tool-grant"

/** The most one tool call's arguments may hold. */
const TOOL_CALL_MAX_BYTES = 1024 * 1024

const agentHeaderSchema = z.object({ sessionId: z.string().min(1).max(256).optional(), ownerDriven: z.boolean().optional() }).strict()

function statedAgent(header: string | undefined): z.infer<typeof agentHeaderSchema> {
  if (!header) return {}
  try {
    const parsed = agentHeaderSchema.safeParse(JSON.parse(header))
    return parsed.success ? parsed.data : {}
  } catch {
    return {}
  }
}

/**
 * `/api/claxedo/app-plugins/tools`:
 * - `GET /` lists the tools the caller's plugins serve, as `PluginToolsListing[]`;
 * - `POST /grant` trades a cloud root's live grant for a fresh one naming the plugins still on for the root, or answers 403 `app_plugin_disabled` when none is.
 */
export function appPluginToolRoutes(input: AppPluginToolsAccess): Hono {
  const routes = new Hono()
  routes.get("/", async (context) => {
    const caller = await toolCallerOrRefusal(context.req.raw, input)
    return caller instanceof Response ? caller : Response.json(caller.installs.map(toolsListing))
  })
  routes.post("/grant", async (context) => {
    const caller = await toolCallerOrRefusal(context.req.raw, input)
    if (caller instanceof Response) return caller
    if (!caller.root || !input.grants) return pluginRefusal(401, "plugin_tools_grant_invalid", "Only a plugin tools grant is renewed")
    const plugins = caller.installs.map((install) => install.pluginId)
    if (plugins.length === 0) return pluginRefusal(403, "app_plugin_disabled", "App plugin tools were turned off for this project")
    const minted = await mintPluginToolsGrant(input.grants, { ...caller.root, plugins })
    return Response.json({ token: minted.token, expiresAt: minted.expiresAt })
  })
  return routes
}

/**
 * `POST /api/plugins/:pluginId/_tools/:name`: one tool call, delivered to the
 * backend as an `agent` caller while the plugin serves the caller tools and
 * its release declares `name`.
 */
export function pluginToolCallHandler(input: AppPluginToolsAccess & Readonly<{ supervisors: PluginSupervisorNamespace }>) {
  return async (context: Context): Promise<Response> => {
    const pluginId = context.req.param("pluginId") ?? ""
    const name = context.req.param("name") ?? ""
    if (!isPluginId(pluginId)) return pluginRefusal(404, "plugin_not_found", "No plugin has that id")
    const caller = await toolCallerOrRefusal(context.req.raw, input)
    if (caller instanceof Response) return caller
    const install = caller.installs.find((candidate) => candidate.pluginId === pluginId)
    if (!install) return pluginRefusal(404, "plugin_tools_not_enabled", `Plugin ${pluginId}'s tools are not on for you`)
    if (!install.release.tools.some((tool) => tool.name === name)) return pluginRefusal(404, "plugin_tool_not_declared", `Plugin ${pluginId} declares no tool ${name}`)
    const body = await context.req.raw.text()
    if (new TextEncoder().encode(body).byteLength > TOOL_CALL_MAX_BYTES) return pluginRefusal(413, "plugin_tool_call_too_large", `A tool call's arguments are at most ${TOOL_CALL_MAX_BYTES} bytes`)
    const stated = statedAgent(context.req.header(PLUGIN_TOOL_AGENT_HEADER))
    const workspaceId = caller.root?.workspaceId
    const agent = {
      ...caller.agent,
      pluginId,
      ...(stated.sessionId && workspaceId ? { session: { sessionId: stated.sessionId, workspaceId } } : {}),
      ...(stated.ownerDriven === undefined ? {} : { ownerDriven: stated.ownerDriven }),
    }
    try {
      return pluginAnswer(await pluginSupervisor(input.supervisors, agent).tool(agent, name, body))
    } catch (error) {
      console.error(`[plugin-backends] ${pluginId} tool ${name} failed`, error)
      return pluginRefusal(502, "plugin_backend_failed", `Plugin ${pluginId} failed to answer`)
    }
  }
}
