import { registerAttentionTools } from "./attention"
import { registerDocumentTools } from "./documents"
import { registerProcessTools } from "./processes"
import type { ToolRegistrar } from "./registry"
import { registerReviewTools } from "./review"
import { registerSessionTools } from "./sessions"
import { registerSubagentTools } from "./subagents"
import { registerTaskTools } from "./tasks"
import { registerWorkspaceTools } from "./workspaces"

/**
 * A named group of tools, the unit a project turns on or off.
 *
 * The name rides on the registration rather than in a table beside it because
 * the catalog, the activation row and the mount all address a group by it: a
 * name kept somewhere else could be enabled under one spelling and registered
 * under another.
 */
/**
 * How far a group's tools reach, which is what decides whether a project that
 * has said nothing gets it.
 *
 * Declared by the registration rather than inferred from the name, because the
 * rule that reads it cannot recognise a group that does not exist yet: a name
 * it did not know would have to be guessed at, and the safe-looking guess —
 * this one is like the others — is the one that grants.
 */
export type McpToolGroupReach =
  /** The workspace runtime this session is already running in. Nothing new is granted by turning it on. */
  | "runtime"
  /** A named service some deployments run in this process and others reach as the account's. */
  | Readonly<{ service: string }>
  /** Outside the project altogether. Never on until a user says so. */
  | "account"

export type McpToolGroup = Readonly<{
  id: string
  reach: McpToolGroupReach
  register: (registry: ToolRegistrar) => void
}>

export const CLAXEDO_MCP_TOOL_GROUPS = [
  { id: "attention", reach: "runtime", register: registerAttentionTools },
  { id: "documents", reach: { service: "documents" }, register: registerDocumentTools },
  { id: "processes", reach: "runtime", register: registerProcessTools },
  { id: "review", reach: "runtime", register: registerReviewTools },
  { id: "sessions", reach: "runtime", register: registerSessionTools },
  { id: "subagents", reach: "runtime", register: registerSubagentTools },
  { id: "tasks", reach: "account", register: registerTaskTools },
  { id: "workspaces", reach: "runtime", register: registerWorkspaceTools },
] as const satisfies readonly McpToolGroup[]

export type ClaxedoMcpToolGroupId = (typeof CLAXEDO_MCP_TOOL_GROUPS)[number]["id"]

export const CLAXEDO_MCP_TOOL_GROUP_IDS: readonly ClaxedoMcpToolGroupId[] =
  CLAXEDO_MCP_TOOL_GROUPS.map((group) => group.id)

export type ClaxedoMcpToolGroupDescription = Readonly<{
  id: ClaxedoMcpToolGroupId
  reach: McpToolGroupReach
  tools: readonly string[]
}>

let inventory: readonly ClaxedoMcpToolGroupDescription[] | undefined

/**
 * Each group's tool names, read by running its registration against a sink
 * that keeps the names and drops everything else.
 *
 * The catalog a user consents from has to name the tools the mount will serve,
 * and the only place those names exist is the registration call. A second list
 * would be a list to forget; this one cannot disagree with the code.
 */
export function claxedoMcpToolGroupInventory(): readonly ClaxedoMcpToolGroupDescription[] {
  inventory ??= CLAXEDO_MCP_TOOL_GROUPS.map((group) => {
    const tools: string[] = []
    group.register({ tool: (name) => { tools.push(name) } })
    return { id: group.id, reach: group.reach, tools }
  })
  return inventory
}

/** The registrations an enabled set selects, in catalog order; an unknown name selects nothing. */
export function claxedoMcpToolGroupsFor(enabled: Iterable<string>): readonly McpToolGroup[] {
  const wanted = new Set(enabled)
  return CLAXEDO_MCP_TOOL_GROUPS.filter((group) => wanted.has(group.id))
}
