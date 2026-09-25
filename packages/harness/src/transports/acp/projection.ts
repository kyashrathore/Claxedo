import type { HarnessServices, McpServerSpec } from "../../contract"
import type { AcpConnectionOptions } from "./connection"
import type { AcpEntry, AcpMcpFilter } from "./index"

export function acpMcpServers(entry: Pick<AcpEntry, "start" | "peer">, services: HarnessServices,
  connection: AcpConnectionOptions, filter: AcpMcpFilter): McpServerSpec[] {
  const first = services.firstPartyMcp(entry.start.sessionId, entry.start.locality)
  const servers = [...entry.start.projection.mcpServers, ...(first ? [{ ...first, origin: "first-party" as const }] : [])]
  return filter({ servers, locality: entry.start.locality,
    mcpCapabilities: entry.peer.handshake.agentCapabilities?.mcpCapabilities,
    supportsMcpServers: connection.supportsMcpServers }).servers
}
