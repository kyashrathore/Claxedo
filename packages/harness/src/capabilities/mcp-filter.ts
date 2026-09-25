import type { Locality } from "../contract/session"
import type { NotApplied, ProjectedMcpServer } from "../contract/projection"

export type DeclaredMcpCapabilities = { http?: boolean; sse?: boolean; acp?: boolean }

export type McpFilterInput = {
  servers: readonly ProjectedMcpServer[]
  locality: Locality
  mcpCapabilities?: DeclaredMcpCapabilities
  supportsMcpServers?: boolean
}

export function filterMcpServers(input: McpFilterInput): { servers: ProjectedMcpServer[]; notApplied: NotApplied[] } {
  const servers: ProjectedMcpServer[] = []
  const notApplied: NotApplied[] = []
  for (const server of input.servers) {
    const reason = excludedReason(server, input)
    if (reason) notApplied.push({ item: server.name, reason })
    else servers.push(server)
  }
  return { servers, notApplied }
}

function excludedReason(server: ProjectedMcpServer, input: McpFilterInput): NotApplied["reason"] | undefined {
  if (input.locality === "local") return undefined
  if (server.origin === "first-party" || server.origin === "plugin") return "remote-harness"
  if (server.kind === "stdio") return "unsupported-transport"
  if (input.supportsMcpServers === false) return "unsupported-by-harness"
  if (input.mcpCapabilities?.[server.kind] !== true) return "unsupported-transport"
  return undefined
}
