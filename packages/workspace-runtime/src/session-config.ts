import {
  normalizeHarnessIdentity,
  type PromptModel,
  type SessionConfig,
  type SessionConfigRequestUpdate,
  type SessionHarness,
} from "@claxedo/agent-sdk-runtime"
import { rec as record, str } from "./json-value"

export function normalizeSessionHarness(input: unknown): SessionHarness | undefined {
  const row = record(input)
  if (!row) return undefined
  const identity = normalizeHarnessIdentity(row)
  if (!identity) return undefined
  return {
    id: identity.id,
    access: identity.access,
  }
}

function promptModel(input: unknown): PromptModel | null | undefined {
  if (input === null) return null
  const row = record(input)
  if (!row) return undefined
  const providerID = str(row.providerID)
  const modelID = str(row.modelID)
  if (providerID === undefined || modelID === undefined) return undefined
  return { providerID, modelID }
}

export function normalizeSessionConfigUpdate(input: unknown): SessionConfigRequestUpdate {
  const row = record(input) ?? {}
  const harness = normalizeSessionHarness(row.harness)
  const model = "model" in row ? promptModel(row.model) : undefined
  return {
    ...(harness ? { harness } : {}),
    ...(model !== undefined ? { model } : {}),
    ...("variant" in row && (typeof row.variant === "string" || row.variant === null) ? { variant: row.variant } : {}),
    ...("agent" in row && (typeof row.agent === "string" || row.agent === null) ? { agent: row.agent } : {}),
  }
}

export function normalizeSessionCreateConfig(input: unknown): SessionConfigRequestUpdate {
  const row = record(input) ?? {}
  const model = record(row.model)
  return normalizeSessionConfigUpdate({
    ...row,
    ...(typeof model?.providerID === "string" && typeof model.id === "string"
      ? { model: { providerID: model.providerID, modelID: model.id } }
      : {}),
    ...(!("variant" in row) && typeof model?.variant === "string" ? { variant: model.variant } : {}),
  })
}

export function normalizeSessionConfig(input: unknown): SessionConfig | undefined {
  const row = record(input) ?? {}
  const update = normalizeSessionConfigUpdate(input)
  if (!update.harness) return undefined
  return {
    harness: update.harness,
    ...(update.model && update.model !== null ? { model: update.model } : {}),
    variant: "variant" in row && (typeof row.variant === "string" || row.variant === null) ? row.variant : null,
    agent: "agent" in row && (typeof row.agent === "string" || row.agent === null) ? row.agent : null,
  }
}
