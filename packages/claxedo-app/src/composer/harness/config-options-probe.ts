import type { Server } from "@/server"
import { harnessHasConfigOptions, type HarnessType } from "./profile"

export function createConfigOptionsProbe(server: Server) {
  return async (type: HarnessType) => {
    if (type.kind === "native") return harnessHasConfigOptions(type)
    const catalog = await server.queryClient.ensureQueryData(server.queries.agentConnections.list())
    if (catalog.status === "unsupported") throw new Error(catalog.reason)
    const row = catalog.connections.find((item) => item.connectionId === type.connectionId)
    if (!row) throw new Error(`Connection ${type.connectionId} is unavailable`)
    return row.capabilities.configOptions
  }
}
