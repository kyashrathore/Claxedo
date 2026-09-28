import type { AgentAgent, AgentCommand } from "@claxedo/agent-runtime-contract"
import type { WorkspaceRuntimeCaller, WorkspaceRuntimeRequestOptions, WorkspaceRuntimeResponse, WorkspaceScope } from "./request"

type Options = WorkspaceRuntimeRequestOptions
type Reply<T> = Promise<WorkspaceRuntimeResponse<T>>

export type WorkspaceVcsInfo = {
  branch?: string
  default_branch?: string
}

export type WorkspaceVcsClient = { get(input?: WorkspaceScope, options?: Options): Reply<WorkspaceVcsInfo> }
export type WorkspaceCommandClient = { list(input?: WorkspaceScope, options?: Options): Reply<AgentCommand[]> }
export type WorkspaceAgentClient = { list(input?: WorkspaceScope, options?: Options): Reply<AgentAgent[]> }

export function vcsClient(caller: WorkspaceRuntimeCaller): WorkspaceVcsClient {
  return { get: (input = {}, options) => caller.call({ operation: "vcs.get", path: "/vcs", scope: input, options }) }
}

export function commandClient(caller: WorkspaceRuntimeCaller): WorkspaceCommandClient {
  return { list: (input = {}, options) => caller.call({ operation: "command.list", path: "/command", scope: input, options }) }
}

export function agentClient(caller: WorkspaceRuntimeCaller): WorkspaceAgentClient {
  return { list: (input = {}, options) => caller.call({ operation: "agent.list", path: "/agent", scope: input, options }) }
}
