import { registerAttentionTools } from "./attention"
import { registerDocumentTools } from "./documents"
import { registerProcessTools } from "./processes"
import type { ToolRegistry } from "./registry"
import { registerReviewTools } from "./review"
import { registerSessionTools } from "./sessions"
import { registerSubagentTools } from "./subagents"
import { registerTaskTools } from "./tasks"
import { registerWorkspaceTools } from "./workspaces"

export type McpToolGroup = (registry: ToolRegistry) => void

/**
 * The tool surface every mount serves.
 *
 * One list rather than a per-mount argument: the loopback, hosted and node
 * mounts are the same server reached over different credentials, and a group
 * present on one but not another would make a tool's absence a deployment
 * accident instead of an access decision the registry states.
 */
export const CLAXEDO_MCP_TOOL_GROUPS: readonly McpToolGroup[] = [registerAttentionTools, registerDocumentTools, registerProcessTools, registerReviewTools, registerSessionTools, registerSubagentTools, registerTaskTools, registerWorkspaceTools]
