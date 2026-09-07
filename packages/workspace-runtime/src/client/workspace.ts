import type { AgentAgent, AgentCommand } from "@claxedo/agent-runtime-contract"
import type { WorkspaceRuntimeCaller, WorkspaceRuntimeRequestOptions, WorkspaceRuntimeResponse, WorkspaceScope } from "./request"

type Options = WorkspaceRuntimeRequestOptions
type Reply<T> = Promise<WorkspaceRuntimeResponse<T>>

export type WorkspaceVcsInfo = {
  branch?: string
  default_branch?: string
}

export type WorkspaceMcpStatus =
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed"; error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration"; error: string }

export type WorkspaceVcsClient = { get(input?: WorkspaceScope, options?: Options): Reply<WorkspaceVcsInfo> }
export type WorkspaceMcpClient = { status(input?: WorkspaceScope, options?: Options): Reply<Record<string, WorkspaceMcpStatus>> }
export type WorkspaceCommandClient = { list(input?: WorkspaceScope, options?: Options): Reply<AgentCommand[]> }
export type WorkspaceAgentClient = { list(input?: WorkspaceScope, options?: Options): Reply<AgentAgent[]> }

export function vcsClient(caller: WorkspaceRuntimeCaller): WorkspaceVcsClient {
  return { get: (input = {}, options) => caller.call({ operation: "vcs.get", path: "/vcs", scope: input, options }) }
}

export function mcpClient(caller: WorkspaceRuntimeCaller): WorkspaceMcpClient {
  return { status: (input = {}, options) => caller.call({ operation: "mcp.status", path: "/mcp", scope: input, options }) }
}

export function commandClient(caller: WorkspaceRuntimeCaller): WorkspaceCommandClient {
  return { list: (input = {}, options) => caller.call({ operation: "command.list", path: "/command", scope: input, options }) }
}

export function agentClient(caller: WorkspaceRuntimeCaller): WorkspaceAgentClient {
  return { list: (input = {}, options) => caller.call({ operation: "agent.list", path: "/agent", scope: input, options }) }
}
