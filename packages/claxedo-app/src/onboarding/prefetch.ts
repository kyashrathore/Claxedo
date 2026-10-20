import type { Capabilities, Server } from "@/server"

export function prefetchOnboardingReads(server: Server, capabilities: Capabilities): void {
  const { accounts, integrations } = server.queries
  const client = server.queryClient
  void client.prefetchQuery(accounts.list())
  void client.prefetchQuery(accounts.effective())
  void client.prefetchQuery(accounts.sources())
  if (capabilities.servingMachine) return
  void client.prefetchQuery(accounts.sandbox())
  if (capabilities.features.connections) void client.prefetchQuery(integrations.codeHosts())
}
