import type { HarnessServices, McpServerSpec } from "../../contract"
import type { AcpConnectionOptions } from "./connection"
import type { AcpEntry, AcpMcpFilter } from "./index"
import { sessionMcpServers } from "../../contract"
import { AcpTransportError } from "./errors"

export function acpMcpProjection(entry: Pick<AcpEntry, "start" | "peer">, services: HarnessServices,
  connection: AcpConnectionOptions, filter: AcpMcpFilter): { servers: McpServerSpec[]; notApplied: { item: string; reason: string }[] } {
  const servers = sessionMcpServers(entry.start, services, { includeFirstParty: true,
    duplicate: (name) => new AcpTransportError("configuration", `Duplicate ACP MCP server ${name}`) })
  const filtered = filter({ servers, locality: entry.start.locality,
    mcpCapabilities: entry.peer.handshake.agentCapabilities?.mcpCapabilities,
    supportsMcpServers: connection.supportsMcpServers })
  return { servers: filtered.servers, notApplied: [...entry.start.projection.notApplied, ...filtered.notApplied] }
}
