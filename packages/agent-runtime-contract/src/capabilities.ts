export type AgentModel = {
  providerId: string
  modelId: string
  name: string
  description?: string
}

export type ModelSelection =
  | { status: "required"; models: AgentModel[] }
  | { status: "optional"; models?: AgentModel[] }
  | { status: "unsupported" }

export type AgentCapabilities = {
  harness: string
  modelSelection: ModelSelection
  abort: boolean
  reconnect: boolean
  replay: boolean
  permissions: boolean
  questions: boolean
  todos: boolean
  commands: boolean
  fork: boolean
  revert: boolean
  unrevert: boolean
  configOptions: boolean
  subagents: boolean
}
