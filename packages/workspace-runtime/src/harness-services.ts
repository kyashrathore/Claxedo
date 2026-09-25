import type { HarnessServices } from "@claxedo/harness/contract"
import type { LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "./first-party-mcp"
import { createSpawnService } from "./spawn-service"
import type { WorkspaceTranscriptRoutesOptions } from "./workspace/core"

type ServiceInputs = {
  ownership: LaunchOwnershipStore
  transcripts: WorkspaceTranscriptRoutesOptions
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
  log: HarnessServices["log"]
  clock: HarnessServices["clock"]
  patternEvaluator: HarnessServices["patternEvaluator"]
}

export function createHarnessServices(input: ServiceInputs): HarnessServices {
  const { workspaceId, resolver } = input.transcripts
  if (!resolver.register) throw new Error("Transcript resolver must support registration")
  const register = resolver.register.bind(resolver)
  return {
    spawn: createSpawnService(input.ownership),
    transcripts: {
      register: (request) => register({ workspaceId, ...request }),
      open: (request) => resolver.open({ workspaceId, ...request }),
    },
    firstPartyMcp(sessionId, locality) {
      if (locality !== "local" || !input.firstPartyMcpLaunch) return undefined
      const server = firstPartyMcpServerFor(input.firstPartyMcpLaunch, sessionId)
      return server ? { kind: "http", ...server } : undefined
    },
    patternEvaluator: input.patternEvaluator,
    log: input.log,
    clock: input.clock,
  }
}
