import type {
  GoalCapabilities,
  HarnessEffortLevels,
  HarnessInstructionChannel,
  ModelSelection,
} from "@claxedo/agent-runtime-contract"

export type TransportCapabilities = {
  modelSelection: ModelSelection
  effortLevels: HarnessEffortLevels
  instructionChannel: HarnessInstructionChannel
  configOwner: "harness" | "runtime"
  requests: {
    permissions: boolean
    questions: boolean
    elicitation: boolean
  }
  subagents: boolean
  goals: GoalCapabilities
  todos: boolean
  history: "store" | "harness"
}

export type CapabilityContext = {
  sessionId?: string
  directory: string
}
