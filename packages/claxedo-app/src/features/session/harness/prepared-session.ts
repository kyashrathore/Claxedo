import type { HarnessType } from "./profile"
import type { ModelKey } from "@/features/session/composer/model-strategy"

export type PreparedSessionDirectory = string

export type PreparedRuntimeSessionConfig = {
  agent: string
  model?: ModelKey
  variant?: string
}

export type PreparedRuntimeSession = {
  id: string
  directory: PreparedSessionDirectory
  harness: HarnessType
  model?: string
}

export type PreparedHarnessSessionState = {
  modelOptional?: boolean
  harness?: HarnessType
  selectedModel?: string
}

export type PreparedHarnessSessionPlan =
  | { status: "disabled" }
  | { status: "missing-directory" }
  | { status: "missing-harness" }
  | { status: "no-model" }
  | { status: "reuse"; item: PreparedRuntimeSession }
  | {
      status: "create"
      directory: PreparedSessionDirectory
      harness: HarnessType
      model?: string
      stale?: PreparedRuntimeSession
    }

export function preparedHarnessSessionModel(state: PreparedHarnessSessionState) {
  if (!state.harness) return undefined
  return state.selectedModel
}

export function planPreparedHarnessSession(input: {
  enabled: boolean
  directory?: PreparedSessionDirectory
  state: PreparedHarnessSessionState
  prepared?: PreparedRuntimeSession
}): PreparedHarnessSessionPlan {
  if (!input.enabled) return { status: "disabled" }
  if (!input.directory) return { status: "missing-directory" }
  if (!input.state.harness) return { status: "missing-harness" }

  const model = preparedHarnessSessionModel(input.state)
  if (!model && !input.state.modelOptional) return { status: "no-model" }

  if (
    input.prepared?.directory === input.directory &&
    JSON.stringify(input.prepared.harness) === JSON.stringify(input.state.harness) &&
    input.prepared.model === model
  ) {
    return { status: "reuse", item: input.prepared }
  }

  return {
    status: "create",
    directory: input.directory,
    harness: input.state.harness,
    model,
    ...(input.prepared ? { stale: input.prepared } : {}),
  }
}
