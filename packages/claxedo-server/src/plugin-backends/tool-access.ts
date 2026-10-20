import type { D1Database } from "@cloudflare/workers-types"
import type { PluginToolsListing } from "@claxedo/plugin-api/tools"
import { pluginRefusal, type PluginAgentCaller } from "@claxedo/plugin-runtime"
import { bearerToken } from "@claxedo/helpers/string"
import { ControlPlaneAuthError } from "@claxedo/server-core/platform/auth/auth"
import type { CloudRootIdentity } from "@claxedo/server-core/plugins/server-plugin"
import type { AppPluginToolConsent } from "../agent-plugins/app-plugin-tool-consent"
import { listEnabledAppPlugins, type AppPluginInstall } from "./installs"
import { orgCallerOrRefusal, type OrgCallerInput } from "./org-caller"
import { isPluginToolsGrantToken, PluginToolsGrantConfigurationError, verifyPluginToolsGrant, type PluginToolsGrantKeys } from "./tool-grant"

export type AppPluginToolsAccess = OrgCallerInput &
  Readonly<{
    database: D1Database
    consent: AppPluginToolConsent
    /** Absent on a deployment that mints no sandbox grants; then only signed callers reach tools. */
    grants?: PluginToolsGrantKeys
  }>

/** An install whose release declares tools, served while it is installed, active and enabled for the user. */
export type ToolServingInstall = AppPluginInstall & Readonly<{ release: AppPluginInstall["release"] & { tools: NonNullable<AppPluginInstall["release"]["tools"]> } }>

async function toolServingInstalls(database: D1Database, orgId: string, userId: string): Promise<ToolServingInstall[]> {
  const installs = await listEnabledAppPlugins(database, orgId, userId)
  return installs.filter((install): install is ToolServingInstall => install.release.tools !== undefined)
}

/** The tool-serving installs whose tools are on for a cloud root, read as the root's owner. */
export async function rootToolInstalls(input: Pick<AppPluginToolsAccess, "database" | "consent">, root: CloudRootIdentity): Promise<ToolServingInstall[]> {
  const installs = await toolServingInstalls(input.database, root.orgId, root.userId)
  const on = await input.consent.forRoot(root, installs.map((install) => install.pluginId))
  return installs.filter((install) => on.has(install.pluginId))
}

/** Who calls a plugin's tools: the agent's user and organization, the root its grant names, and the installs it reaches. */
export type ToolCaller = Readonly<{
  agent: Omit<PluginAgentCaller, "pluginId">
  installs: readonly ToolServingInstall[]
  /** Present for a sandbox's grant; a signed caller has none. */
  root?: CloudRootIdentity
}>

/**
 * A request's tool caller: a cloud root presenting its sandbox grant reaches
 * the plugins its grant names that are still on for the root; a signed person,
 * which the hosted MCP endpoint's in-process calls are, reaches the plugins
 * they have on.
 */
export async function toolCallerOrRefusal(request: Request, input: AppPluginToolsAccess): Promise<ToolCaller | Response> {
  const token = bearerToken(request.headers.get("authorization"))
  if (token && input.grants && isPluginToolsGrantToken(token)) {
    let scope
    try {
      scope = await verifyPluginToolsGrant(input.grants, token)
    } catch (error) {
      if (error instanceof PluginToolsGrantConfigurationError) return pluginRefusal(503, error.code, "This deployment cannot verify plugin tools grants")
      return pluginRefusal(401, "plugin_tools_grant_invalid", "This plugin tools grant is not valid")
    }
    const { plugins, ...root } = scope
    let installs
    try {
      installs = (await rootToolInstalls(input, root)).filter((install) => plugins.includes(install.pluginId))
    } catch (error) {
      if (error instanceof ControlPlaneAuthError) return pluginRefusal(403, "plugin_tools_grant_owner_changed", "This workspace no longer answers for the grant it carries")
      throw error
    }
    return { agent: { orgId: root.orgId, origin: "agent", userId: root.userId, projectId: root.projectId, workspaceId: root.workspaceId }, installs, root }
  }
  const caller = await orgCallerOrRefusal(request, input)
  if (caller instanceof Response) return caller
  const installs = await toolServingInstalls(input.database, caller.orgId, caller.userId)
  const on = await input.consent.forCaller(caller.auth, installs.map((install) => install.pluginId))
  return { agent: { orgId: caller.orgId, origin: "agent", userId: caller.userId }, installs: installs.filter((install) => on.has(install.pluginId)) }
}

export function toolsListing(install: ToolServingInstall): PluginToolsListing {
  return { pluginId: install.pluginId, label: install.manifest.backend?.tools?.group.label ?? install.manifest.name, tools: install.release.tools }
}
