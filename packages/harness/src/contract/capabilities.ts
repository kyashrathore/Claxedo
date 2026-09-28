import type {
  GoalCapabilities,
  HarnessEffortLevels,
  HarnessInstructionChannel,
  ModelSelection,
} from "@claxedo/agent-runtime-contract"

export type ConfigTiming = "immediate" | "after-active-turns" | "next-turn" | "next-session"

export type PluginIntake = {
  mcp: "session" | "config" | "none"
  skills: "plugin-dir" | "skill-dirs" | "none"
}

export type McpTransports = {
  stdio: boolean
  http: boolean
  sse: boolean
}

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
  titles: "harness" | "side-request" | "none"
  pluginIntake: PluginIntake
  mcpTransports: McpTransports
  timing: {
    model: ConfigTiming
    effort: ConfigTiming
    permissionMode: ConfigTiming
    credentials: ConfigTiming
  }
}

export type CapabilityContext = {
  sessionId?: string
  directory: string
}
