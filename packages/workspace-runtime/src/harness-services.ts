import { recordHarnessHomeUse } from "./host/home-use"
import type { HarnessServices } from "@claxedo/harness/contract"
import type { LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "./first-party-mcp"
import { createSpawnService, type SpawnObservation } from "./spawn-service"

type ServiceInputs = {
  ownership: LaunchOwnershipStore
  observation?: SpawnObservation
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
  log: HarnessServices["log"]
  clock: HarnessServices["clock"]
  patternEvaluator: HarnessServices["patternEvaluator"]
  /** Where a transport says a session's health or connection state may have changed; the host reads them again. */
  healthChanged: () => void
}

export function createHarnessServices(input: ServiceInputs): HarnessServices {
  return {
    recordHomeUse: async (home) => recordHarnessHomeUse(home),
    spawn: createSpawnService(input.ownership, input.observation),
    firstPartyMcp(sessionId, locality) {
      if (locality !== "local" || !input.firstPartyMcpLaunch) return undefined
      const server = firstPartyMcpServerFor(input.firstPartyMcpLaunch, sessionId)
      return server ? { kind: "http", ...server } : undefined
    },
    patternEvaluator: input.patternEvaluator,
    healthChanged: input.healthChanged,
    log: input.log,
    clock: input.clock,
  }
}
