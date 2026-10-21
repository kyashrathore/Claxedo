import { isPluginId } from "./id"
import type { PluginToolDeclaration } from "./release"

/**
 * A plugin's agent tools are one MCP tool group, and the group's id is also
 * the Marketplace activation subject a person turns them on and off with, so
 * a group can never be served under one name and consented to under another.
 */
const TOOL_GROUP_PREFIX = "app-plugin:"

export function appPluginToolGroupId(pluginId: string): string {
  return `${TOOL_GROUP_PREFIX}${pluginId}`
}

export function appPluginIdOfToolGroup(groupId: string): string | undefined {
  if (!groupId.startsWith(TOOL_GROUP_PREFIX)) return undefined
  const pluginId = groupId.slice(TOOL_GROUP_PREFIX.length)
  return isPluginId(pluginId) ? pluginId : undefined
}

/** `GET`: the tools the caller's installed, enabled and consented plugins serve, as `PluginToolsListing[]`. */
export const PLUGIN_TOOLS_ROUTE = "/api/claxedo/app-plugins/tools"

/** `POST { arguments }`: one tool call, which the host delivers to the backend's `/_tools/<name>` as an `agent` caller. */
export function pluginToolCallPath(pluginId: string, name: string): string {
  return `/api/plugins/${encodeURIComponent(pluginId)}/_tools/${encodeURIComponent(name)}`
}

/**
 * The session a tool call comes from, as the MCP mount that serves the
 * session states it. The host takes the user, organization, project and
 * workspace from the credential the call carries, never from this header.
 */
export const PLUGIN_TOOL_AGENT_HEADER = "x-claxedo-agent"

export type PluginToolAgent = Readonly<{ sessionId?: string; ownerDriven?: boolean }>

/** The most a backend's answer to one tool call may hold; a larger one is refused rather than handed to the agent. */
export const PLUGIN_TOOL_RESULT_MAX_BYTES = 256 * 1024

export type PluginToolsListing = Readonly<{
  pluginId: string
  label: string
  tools: readonly PluginToolDeclaration[]
}>
