import { recordHarnessHomeUse } from "./host/home-use"
import type { HarnessServices } from "@claxedo/harness/contract"
import type { LaunchOwnershipStore } from "@claxedo/process-ownership/launch"
import { firstPartyMcpServerFor, type WorkspaceFirstPartyMcpLaunchOptions } from "./first-party-mcp"
import { createSpawnService } from "./spawn-service"
import type { WorkspaceTranscriptRoutesOptions } from "./workspace/core"

type ServiceInputs = {
  ownership: LaunchOwnershipStore
  transcripts?: WorkspaceTranscriptRoutesOptions
  firstPartyMcpLaunch?: WorkspaceFirstPartyMcpLaunchOptions
  log: HarnessServices["log"]
  clock: HarnessServices["clock"]
  patternEvaluator: HarnessServices["patternEvaluator"]
}

function transcriptRegistrar(transcripts: WorkspaceTranscriptRoutesOptions | undefined): HarnessServices["transcripts"] {
  if (!transcripts) {
    return {
      register: async (request) => { throw new Error(`Transcript registration is unavailable on this host (${request.providerKind} session ${request.parentSessionId})`) },
    }
  }
  const { workspaceId, resolver } = transcripts
  if (!resolver.register) throw new Error("Transcript resolver must support registration")
  const register = resolver.register.bind(resolver)
  return {
    register: (request) => register({ workspaceId, ...request }),
    open: (request) => resolver.open({ workspaceId, ...request }),
  }
}

export function createHarnessServices(input: ServiceInputs): HarnessServices {
  return {
    recordHomeUse: async (home) => recordHarnessHomeUse(home),
    spawn: createSpawnService(input.ownership),
    transcripts: transcriptRegistrar(input.transcripts),
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
