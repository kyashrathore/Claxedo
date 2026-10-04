import { recordHarnessHomeUse } from "./host/home-use"
import type { HarnessServices } from "@claxedo/harness/contract"
import type { LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "./first-party-mcp"
import { createSpawnService } from "./spawn-service"

type ServiceInputs = {
  ownership: LaunchOwnershipStore
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
  log: HarnessServices["log"]
  clock: HarnessServices["clock"]
  patternEvaluator: HarnessServices["patternEvaluator"]
  /** Where a transport says a session's health or connection state may have changed; the host reads them again. */
  healthChanged: () => void
  refreshCredential?: HarnessServices["refreshCredential"]
}

export function createHarnessServices(input: ServiceInputs): HarnessServices {
  return {
    recordHomeUse: async (home) => recordHarnessHomeUse(home),
    spawn: createSpawnService(input.ownership),
    firstPartyMcp(sessionId, locality) {
      if (locality !== "local" || !input.firstPartyMcpLaunch) return undefined
      const server = firstPartyMcpServerFor(input.firstPartyMcpLaunch, sessionId)
      return server ? { kind: "http", ...server } : undefined
    },
    patternEvaluator: input.patternEvaluator,
    healthChanged: input.healthChanged,
    log: input.log,
    clock: input.clock,
    ...(input.refreshCredential ? { refreshCredential: input.refreshCredential } : {}),
  }
}
