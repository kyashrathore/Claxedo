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
  requests: {
    permissions: boolean
    questions: boolean
    elicitation: boolean
  }
  subagents: boolean
  goals: GoalCapabilities
  todos: boolean
  history: "store" | "harness"
  durableRuns?: true
}

export type CapabilityContext = {
  sessionId?: string
  directory: string
}
