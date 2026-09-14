/**
 * Which runtime operation each tool covers, and what that makes the tool.
 *
 * `SESSION_CORE_ROUTE_ACCESS` is the workspace runtime's own route table and
 * `sessionAccessRequiresWrite` its own write classification. Deriving from
 * both means a route added, removed or reclassified there fails
 * `inventory.test.ts` here rather than going silently unreachable, and no tool
 * spells a `write` flag of its own for read-only mode to trust.
 */
import {
  SESSION_CORE_ROUTE_ACCESS,
  sessionAccessRequiresWrite,
  type SessionAccessOperation,
} from "@claxedo/workspace-runtime/client"
import type { TasksOperation } from "../client/contract"
import type { McpAudience, McpScope, McpToolAccess } from "../context"

export type RuntimeOperationEntry = Readonly<{
  operation: SessionAccessOperation
  write: boolean
  /** Every `"<METHOD> <path>"` in the inventory that resolves to this operation. */
  routes: readonly string[]
}>

function runtimeOperations(): ReadonlyMap<SessionAccessOperation, RuntimeOperationEntry> {
  const rows = new Map<SessionAccessOperation, { operation: SessionAccessOperation; write: boolean; routes: string[] }>()
  for (const [route, decision] of Object.entries(SESSION_CORE_ROUTE_ACCESS)) {
    if (decision.kind === "workspace") continue
    const existing = rows.get(decision.operation)
    if (existing) existing.routes.push(route)
    else {
      rows.set(decision.operation, {
        operation: decision.operation,
        write: sessionAccessRequiresWrite({ operation: decision.operation }),
        routes: [route],
      })
    }
  }
  return rows
}

export const RUNTIME_OPERATIONS = runtimeOperations()

/**
 * The one declaration of which tool covers which runtime operation.
 *
 * A tool asks for its access by name, so the table cannot drift from the tools
 * that exist: an unknown name or an operation the runtime does not have throws
 * at registration, and an entry whose tool no group registers fails the guard.
 */
export const MCP_TOOL_OPERATIONS = {
  session_create: ["session_create"],
  sessions_list: ["session_list", "session_status"],
  session_get: ["session_meta_read", "session_config_read"],
  session_transcript: ["message_read"],
  session_send: ["prompt"],
  session_abort: ["abort"],
  session_handoff: ["session_config_write"],
  session_rename: ["session_meta_write"],
  session_delete: ["delete"],
} as const satisfies Record<string, readonly SessionAccessOperation[]>

export type McpRuntimeToolName = keyof typeof MCP_TOOL_OPERATIONS

/**
 * Operations a group other than the session tools serves, and the tools that
 * serve them.
 *
 * Their access is not derived here because it is narrower than the operation's
 * write class: a permission reply is a human-credential act under the
 * `approve` scope (security review S1), which no route-level classification
 * expresses. Naming the tools keeps the claim checkable — the guard fails when
 * one of them stops being registered.
 */
export const MCP_OPERATIONS_SERVED_ELSEWHERE = {
  permission_list: ["sessions_board", "wait_for_attention"],
  permission_response: ["permission_reply"],
  question_list: ["sessions_board", "wait_for_attention"],
  question_response: ["question_reply", "question_reject"],
  list_subagents: ["subagent_list"],
  session_capabilities_read: ["subagent_capabilities"],
} as const satisfies Partial<Record<SessionAccessOperation, readonly string[]>>

/**
 * Runtime operations this MCP deliberately serves no tool for, each with the
 * reason. An entry is a review decision, not a backlog: a tool that later
 * covers one of these must delete its row, which the guard enforces by
 * refusing an operation that is both covered and excluded.
 */
export const MCP_OPERATIONS_WITHOUT_TOOLS = {
  session_event_stream:
    "GET /event is an SSE stream and a tool call answers once; the attention group reads the pending lists the stream would carry.",
  permission_mode_read:
    "A session's permission mode is set once at creation under the caller's ceiling; reading it back invites the widening security review S4 closed.",
  permission_mode_write: "Widening a live session's permission mode is the escalation security review S4 closed.",
  todo_read: "The harness writes its todo list into the transcript session_transcript already returns.",
  command: "Slash commands are a harness UI affordance; a model writes the prose session_send carries.",
  shell: "Every harness already runs shell commands with its own tool; the plan drops the duplicate file, search, diff and git tools for the same reason.",
  fork: "Forking, reverting and unreverting are transcript surgery keyed by message id, which no MCP host renders.",
  revert: "Forking, reverting and unreverting are transcript surgery keyed by message id, which no MCP host renders.",
  unrevert: "Forking, reverting and unreverting are transcript surgery keyed by message id, which no MCP host renders.",
  summarize: "The plan removes summarize_logs and the throwaway session it created.",
  goal_read: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_state: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_capabilities: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_start: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_pause: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_resume: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_stop: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
  goal_delete: "Goal internals are the runtime's own autonomous-loop state, not a host-facing surface.",
} as const satisfies Partial<Record<SessionAccessOperation, string>>

export type McpToolGating = Readonly<{
  audiences: readonly McpAudience[]
  scope: McpScope
  destructive?: boolean
}>

/**
 * The runtime's write class for the operations one tool covers: a write if any
 * of them is, since read-only must hide the whole tool.
 *
 * An operation the route inventory does not have throws rather than defaulting
 * to read, because the alternative is a tool that quietly survives read-only
 * mode on a route nobody classified.
 */
export function operationsWriteClass(tool: string, operations: readonly SessionAccessOperation[]): boolean {
  if (operations.length === 0) throw new Error(`${tool} claims no runtime operation`)
  return operations.some((operation) => {
    const entry = RUNTIME_OPERATIONS.get(operation)
    if (!entry) throw new Error(`${tool} names ${operation}, which the runtime route inventory does not have`)
    return entry.write
  })
}

/**
 * Access for a tool over session-core routes. `write` is the runtime's
 * classification of the operations the tool covers, so read-only mode hides
 * exactly what the runtime calls a write.
 */
export function runtimeToolAccess(tool: McpRuntimeToolName, gating: McpToolGating): McpToolAccess {
  const write = operationsWriteClass(tool, MCP_TOOL_OPERATIONS[tool])
  return {
    audiences: gating.audiences,
    write,
    scope: gating.scope,
    ...(gating.destructive ? { destructive: true } : {}),
  }
}

/**
 * Access for a tool over a surface the session-core inventory does not cover —
 * the managed-process routes, the diff routes, the control plane's workspace
 * routes, the documents service and the Tasks routes. Their write class is
 * declared because no machine-checked table classifies them; anything over a
 * session-core route must take `runtimeToolAccess` instead.
 *
 * `operation` is the Tasks grant a tool needs, and is the one part of an access
 * declaration checked against the client rather than the credential.
 */
export function declaredToolAccess(
  gating: McpToolGating & Readonly<{ write: boolean; operation?: TasksOperation }>,
): McpToolAccess {
  return {
    audiences: gating.audiences,
    write: gating.write,
    scope: gating.scope,
    ...(gating.destructive ? { destructive: true } : {}),
    ...(gating.operation ? { operation: gating.operation } : {}),
  }
}
