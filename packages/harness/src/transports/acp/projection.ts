import type { HarnessServices, McpServerSpec } from "../../contract"
import type { AcpConnectionOptions } from "./connection"
import type { AcpEntry, AcpMcpFilter } from "./index"
import { sessionMcpServers } from "../../contract"

export function acpMcpServers(entry: Pick<AcpEntry, "start" | "peer">, services: HarnessServices,
  connection: AcpConnectionOptions, filter: AcpMcpFilter): McpServerSpec[] {
  const servers = sessionMcpServers(entry.start, services, { includeFirstParty: true,
    duplicate: (name) => new Error(`Duplicate ACP MCP server ${name}`) })
  return filter({ servers, locality: entry.start.locality,
    mcpCapabilities: entry.peer.handshake.agentCapabilities?.mcpCapabilities,
    supportsMcpServers: connection.supportsMcpServers }).servers
}
