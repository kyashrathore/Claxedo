/**
 * What a tool group is authored with, for a group that lives outside this
 * package: a first-party plugin's tools register against the same registrar,
 * declare their access the same way and answer through the same results as
 * the groups every mount serves.
 */
import type { ToolRegistrar } from "./tools/registry"

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
  /** The workspace runtime this session is already running in; its tools reach nothing outside that workspace. */
  | "runtime"
  /** A named service some deployments run in this process and others reach as the account's. */
  | Readonly<{ service: string }>
  /** Outside the project altogether. Never on until a user says so. */
  | "account"

/**
 * A named group of tools, the unit a project turns on or off.
 *
 * The name rides on the registration rather than in a table beside it because
 * the catalog, the activation row and the mount all address a group by it: a
 * name kept somewhere else could be enabled under one spelling and registered
 * under another.
 */
export type McpToolGroup = Readonly<{
  id: string
  reach: McpToolGroupReach
  register: (registry: ToolRegistrar) => void
}>

export type { McpToolDefinition, McpToolHandler, ToolRegistrar } from "./tools/registry"
export type { McpCredential, McpToolAccess, McpToolContext, McpToolService } from "./context"
export type { ClaxedoFetch, McpServiceGrant } from "./client/contract"
export type { McpToolResult } from "./mcp-tool"
export { mcpToolRefusal } from "./mcp-tool"
export { declaredToolAccess } from "./tools/inventory"
export { targetScope, toolJson, toolTarget } from "./tools/target"
export { assertDetachedSessionCreation } from "./tools/session-reach"
