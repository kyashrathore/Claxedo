import { registerAppPluginTools } from "./app-plugins"
import { registerAttentionTools } from "./attention"
import { registerDocumentTools } from "./documents"
import { registerReviewTools } from "./review"
import { registerSessionTools } from "./sessions"
import { registerSubagentTools } from "./subagents"
import { registerSurfaceTools } from "./surfaces"
import { registerWorkspaceTools } from "./workspaces"
import type { McpToolGroup, McpToolGroupReach } from "../tool-group"

export type { McpToolGroup, McpToolGroupReach } from "../tool-group"

/** The groups every mount serves. A first-party plugin's groups are composed after them by the host that mounts the plugin. */
export const CLAXEDO_MCP_TOOL_GROUPS = [
  { id: "app-plugins", reach: { service: "app-plugins" }, register: registerAppPluginTools },
  { id: "attention", reach: "runtime", register: registerAttentionTools },
  { id: "documents", reach: { service: "documents" }, register: registerDocumentTools },
  { id: "review", reach: "runtime", register: registerReviewTools },
  { id: "sessions", reach: "runtime", register: registerSessionTools },
  { id: "subagents", reach: "runtime", register: registerSubagentTools },
  { id: "surfaces", reach: "runtime", register: registerSurfaceTools },
  { id: "workspaces", reach: "runtime", register: registerWorkspaceTools },
] as const satisfies readonly McpToolGroup[]

export type ClaxedoMcpToolGroupId = (typeof CLAXEDO_MCP_TOOL_GROUPS)[number]["id"]

export const CLAXEDO_MCP_TOOL_GROUP_IDS: readonly ClaxedoMcpToolGroupId[] =
  CLAXEDO_MCP_TOOL_GROUPS.map((group) => group.id)

export type ClaxedoMcpToolGroupDescription = Readonly<{
  id: string
  reach: McpToolGroupReach
  tools: readonly string[]
}>

const inventories = new WeakMap<readonly McpToolGroup[], readonly ClaxedoMcpToolGroupDescription[]>()

/**
 * Each group's tool names, read by running its registration against a sink
 * that keeps the names and drops everything else.
 *
 * The catalog a user consents from has to name the tools the mount will serve,
 * and the only place those names exist is the registration call. A second list
 * would be a list to forget; this one cannot disagree with the code.
 */
export function claxedoMcpToolGroupInventory(groups: readonly McpToolGroup[]): readonly ClaxedoMcpToolGroupDescription[] {
  const known = inventories.get(groups)
  if (known) return known
  const inventory = groups.map((group) => {
    const tools: string[] = []
    group.register({ tool: (name) => { tools.push(name) } })
    return { id: group.id, reach: group.reach, tools }
  })
  inventories.set(groups, inventory)
  return inventory
}
