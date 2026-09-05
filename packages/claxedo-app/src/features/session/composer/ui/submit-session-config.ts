import { pickHarness, type HarnessType } from "@/features/session/harness/profile"
import { sameHarnessSelection } from "@/platform/identity/harness-selection"

export type ExistingSessionConfig = {
  harnessType: HarnessType
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

export function parseExistingSessionConfig(input: unknown): ExistingSessionConfig | undefined {
  const row = record(input)
  const harness = record(row?.harness)
  const harnessType = pickHarness(row?.harnessType) ?? pickHarness(harness)
  if (!harnessType) return
  return {
    harnessType,
    ...modelConfig(row?.model),
    ...(string(row?.agent) ? { agent: string(row?.agent) } : {}),
    ...(string(row?.variant) ? { variant: string(row?.variant) } : {}),
  }
}

export function sameExistingSessionConfig(left: ExistingSessionConfig, right: ExistingSessionConfig) {
  return sameHarnessSelection(left.harnessType, right.harnessType) &&
    left.agent === right.agent &&
    left.variant === right.variant &&
    left.model?.providerID === right.model?.providerID &&
    left.model?.modelID === right.model?.modelID
}

function modelConfig(input: unknown) {
  const model = record(input)
  const providerID = string(model?.providerID)
  const modelID = string(model?.modelID)
  return providerID && modelID ? { model: { providerID, modelID } } : {}
}

function record(input: unknown) {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function string(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
