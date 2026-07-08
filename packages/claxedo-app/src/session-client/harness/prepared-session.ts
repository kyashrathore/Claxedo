// target-layer: session-client
import { fixedHarnessModel, type HarnessType } from "./profile"

export type PreparedSessionDirectory = string

export type PreparedRuntimeSession = {
  id: string
  directory: PreparedSessionDirectory
  harness: HarnessType
  model: string
}

export type PreparedHarnessSessionState = {
  harness: HarnessType
  selectedModel?: string
}

export type PreparedHarnessSessionPlan =
  | { status: "disabled" }
  | { status: "missing-directory" }
  | { status: "no-model" }
  | { status: "reuse"; item: PreparedRuntimeSession }
  | {
      status: "create"
      directory: PreparedSessionDirectory
      harness: HarnessType
      model: string
      stale?: PreparedRuntimeSession
    }

export function preparedHarnessSessionModel(state: PreparedHarnessSessionState) {
  if (state.harness === "opencode") return undefined
  return fixedHarnessModel(state.harness)?.id ?? state.selectedModel
}

export function planPreparedHarnessSession(input: {
  enabled: boolean
  directory?: PreparedSessionDirectory
  state: PreparedHarnessSessionState
  prepared?: PreparedRuntimeSession
}): PreparedHarnessSessionPlan {
  if (!input.enabled) return { status: "disabled" }
  if (!input.directory) return { status: "missing-directory" }

  const model = preparedHarnessSessionModel(input.state)
  if (!model) return { status: "no-model" }

  if (
    input.prepared?.directory === input.directory &&
    input.prepared.harness === input.state.harness &&
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
