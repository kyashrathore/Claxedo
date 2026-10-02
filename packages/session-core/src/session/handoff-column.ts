import { normalizeHarnessIdentity, type SessionConfig, type SessionHandoff, type SessionHandoffSource } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/helpers/guards"
import { nullable } from "../stored-columns"

export function sessionHandoff(input: string | null | undefined): SessionHandoff | undefined {
  if (!input) return undefined
  try {
    const value: unknown = JSON.parse(input)
    const handoff = pendingHandoff(value)
    const source = handoff && handoffSource(asRecord(value)?.source)
    return source ? { ...handoff, source } : handoff
  } catch {
    return undefined
  }
}

function pendingHandoff(input: unknown): Omit<SessionHandoff, "source"> | undefined {
  const value = asRecord(input)
  if (!value || value.pending !== true || typeof value.transcript !== "string") return undefined
  const from = normalizeHarnessIdentity(value.from)
  if (!from) return undefined
  return {
    from,
    pending: true,
    transcript: value.transcript,
    ...(value.announced === true ? { announced: true } : {}),
  }
}

function handoffSource(input: unknown): SessionHandoffSource | undefined {
  const value = asRecord(input)
  const ownerKey = nullable(value?.ownerKey)
  if (!value || typeof value.agentSessionId !== "string" || typeof value.upstreamSessionId !== "string" || ownerKey === undefined) {
    return undefined
  }
  const model = asRecord(value.model)
  const variant = nullable(value.variant)
  const agent = nullable(value.agent)
  const handoff = pendingHandoff(value.handoff)
  return {
    agentSessionId: value.agentSessionId,
    upstreamSessionId: value.upstreamSessionId,
    ownerKey,
    ...(typeof model?.providerID === "string" && typeof model.modelID === "string"
      ? { model: { providerID: model.providerID, modelID: model.modelID } }
      : {}),
    ...(variant !== undefined ? { variant } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(handoff ? { handoff } : {}),
  }
}

export function sessionHandoffJson(input: SessionConfig["handoff"] | undefined) {
  return input ? JSON.stringify(input) : null
}
