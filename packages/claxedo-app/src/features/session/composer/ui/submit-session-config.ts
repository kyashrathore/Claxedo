import { asRecord } from "@claxedo/helpers/guards"
import { pickHarness, type HarnessType } from "@/features/session/harness/profile"
import { sameHarnessSelection } from "@/platform/identity/harness-selection"

export type ExistingSessionConfig = {
  harnessType: HarnessType
  agent?: string
  model?: { providerID: string; modelID: string }
  variant?: string
}

export function parseExistingSessionConfig(input: unknown): ExistingSessionConfig | undefined {
  const row = asRecord(input)
  const harness = asRecord(row?.harness)
  const harnessType = pickHarness(row?.harnessType) ?? pickHarness(harness)
  if (!harnessType) return undefined
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
  const model = asRecord(input)
  const providerID = string(model?.providerID)
  const modelID = string(model?.modelID)
  return providerID && modelID ? { model: { providerID, modelID } } : {}
}

function string(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}

/** Existing sessions must load their authoritative binding before a turn is sent. */
export async function loadExistingSubmitConfig(read: () => Promise<unknown>, onError: (error: unknown) => void) {
  try {
    const config = parseExistingSessionConfig(await read())
    if (!config || (!config.model && config.harnessType.kind !== "connection")) throw new Error("The session configuration is not available yet. Try again after it loads.")
    return config
  } catch (error) {
    onError(error)
    return undefined
  }
}
