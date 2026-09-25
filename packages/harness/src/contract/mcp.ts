import type { HarnessServices } from "./services"
import type { ProjectedMcpServer } from "./projection"
import type { StartInput } from "./session"

export function sessionMcpServers(input: Pick<StartInput, "sessionId" | "locality"> & { projection: Pick<StartInput["projection"], "mcpServers"> },
  services: Pick<HarnessServices, "firstPartyMcp">,
  options: { includeFirstParty: boolean; duplicate: (name: string) => Error }): ProjectedMcpServer[] {
  const first = options.includeFirstParty ? services.firstPartyMcp(input.sessionId, input.locality) : undefined
  const servers: ProjectedMcpServer[] = [...input.projection.mcpServers,
    ...(first ? [{ ...first, origin: "first-party" as const }] : [])]
  const names = new Set<string>()
  for (const server of servers) {
    if (names.has(server.name)) throw options.duplicate(server.name)
    names.add(server.name)
  }
  return servers
}
