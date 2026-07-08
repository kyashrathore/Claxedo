import { authFetch } from "../../utils/api"
import { centralTransportForServer, unsignedLocalFetch } from "@claxedo/shell/data/transport/transport"

export type AgentConfigResource = "agents" | "commands"
export type WorkspaceRuntimeAgentConfigResource = "agent" | "command"

export function agentConfigRequest(input: { baseUrl: string; request?: typeof fetch }) {
  return centralTransportForServer(input.baseUrl) === "loopback"
    ? unsignedLocalFetch
    : input.request ?? authFetch
}

export function workspaceTransportForBaseUrl(baseUrl: string) {
  return centralTransportForServer(baseUrl) === "loopback" ? "loopback" : "workspace-relay"
}

export function agentConfigUrl(input: {
  baseUrl: string
  resource: AgentConfigResource
  scope?: string
  harnessType?: string
}) {
  const url = new URL(`/api/claxedo/agent-config/${input.resource}`, input.baseUrl)
  if (input.scope) url.searchParams.set("directory", input.scope)
  if (input.harnessType) url.searchParams.set("type", input.harnessType)
  return url
}

export function workspaceRuntimeAgentConfigPath(input: {
  resource: WorkspaceRuntimeAgentConfigResource
  scope: string
  harnessType?: string
}) {
  const url = new URL(`/${input.resource}`, "http://claxedo.local")
  url.searchParams.set("directory", input.scope)
  if (input.harnessType) url.searchParams.set("harness", input.harnessType)
  return `${url.pathname}${url.search}`
}
