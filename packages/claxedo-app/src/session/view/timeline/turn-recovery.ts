import { providerErrorDetail, providerUsageLimitDetail, type DispatchContext } from "./provider-error-detail"
import { asRecord } from "@claxedo/helpers/guards"
import { credentialBrokerErrorCode, CREDENTIAL_BROKER_ERRORS, type AgentAssistantMessage, type AgentUserMessage } from "@claxedo/agent-runtime-contract"

export type SessionErrorClass = "credential" | "harness" | "model" | "usage_limit" | "workspace" | "session" | "unknown"
export type FirstTurnMessage =
  | Pick<AgentUserMessage, "id" | "role" | "time">
  | Pick<AgentAssistantMessage, "id" | "role" | "parentID" | "time" | "finish" | "error">

const recoveries = {
  credential: { kind: "credential", title: "Reconnect your AI provider", description: "The provider rejected the credential for this workspace.", label: "Reconnect and resend" },
  harness: { kind: "harness", title: "The agent isn't responding", description: "The agent process stopped or couldn't run this turn.", label: "Resend last prompt" },
  model: { kind: "model", title: "Try another model", description: "The selected model couldn't serve this turn.", label: "Switch model and resend" },
  usage_limit: { kind: "usage_limit", title: "Usage limit reached", description: "Choose another model to continue.", label: "Continue" },
  workspace: { kind: "workspace", title: "Workspace isn't ready", description: "The project workspace wasn't available for this turn.", label: "Resend last prompt" },
  session: { kind: "session", title: "This session was lost", description: "The agent process no longer has this conversation. Its history is still here.", label: "Start a new session" },
  unknown: { kind: "unknown", title: "That turn didn't complete", description: "The agent returned an error before completing this turn. Resend the last prompt.", label: "Resend last prompt" },
} as const satisfies Record<SessionErrorClass, { kind: SessionErrorClass; title: string; description: string; label: string }>

export function sessionRecovery(
  kind: SessionErrorClass,
  error?: unknown,
  context?: DispatchContext,
) {
  if (kind === "usage_limit") {
    const detail = providerUsageLimitDetail(error, context)
    if (detail) return { ...recoveries[kind], ...detail }
  }
  return recoveries[kind]
}

export function sessionRecoveryDescription(
  kind: SessionErrorClass,
  error?: unknown,
  context?: DispatchContext,
) {
  const fallback = recoveries[kind].description
  const { summary, status } = providerErrorDetail(error, context)
  if (status !== undefined && summary) return summary
  if (kind === "usage_limit") return providerUsageLimitDetail(error, context)?.description ?? fallback
  if (kind !== "unknown") return fallback
  return summary ?? fallback
}

export function sessionRecoveryClass(error: unknown): SessionErrorClass {
  const data = asRecord(asRecord(error)?.data)
  const classified = data?.firstTurnErrorClass
  if (
    classified === "credential" || classified === "harness" || classified === "model" || classified === "usage_limit" ||
    classified === "workspace" || classified === "session" || classified === "unknown"
  ) return classified
  const message = typeof data?.message === "string" ? data.message : ""
  const broker = credentialBrokerErrorCode(message)
  if (broker) return CREDENTIAL_BROKER_ERRORS[broker].fault
  if (/(?:reached|hit)\s+(?:your|the)\s+.+?\s+limit|usage\s+(?:limit|cap)\s+(?:reached|exceeded)|limit.*(?:reset|usage credits)|usage_limit_reached|rate_limit_reached|credits_depleted/i.test(message)) return "usage_limit"
  if (/\b(401|403|unauthori[sz]ed|api[ _-]?key|oauth|token|credential|authentication|billing|payment|quota|rate[ _-]?limit)\b/i.test(message)) return "credential"
  if (/(thread not found|session not found|conversation not found|no such (thread|session))/i.test(message)) return "session"
  if (/(harness|adapter|acp|agent process|spawn|executable|binary|capabilit(?:y|ies)|unsupported operation)/i.test(message)) return "harness"
  if (/(model|provider\/model|model id|deployment)/i.test(message)) return "model"
  if (/(workspace|worktree|repository|directory|sandbox|provision|filesystem|eacces|enoent|permission denied)/i.test(message)) return "workspace"
  return "unknown"
}

export function isSettledTurnAssistant(message: FirstTurnMessage): message is Extract<FirstTurnMessage, { role: "assistant" }> {
  if (message.role !== "assistant") return false
  if (message.error !== undefined) return true
  return typeof message.time.completed === "number" && message.finish !== "tool-calls" && message.finish !== "unknown"
}

export function firstTurnOutcome(messages: FirstTurnMessage[]) {
  const first = messages.find((message): message is Extract<FirstTurnMessage, { role: "user" }> => message.role === "user")
  if (!first) return undefined
  const assistant = messages.find((message): message is Extract<FirstTurnMessage, { role: "assistant" }> =>
    isSettledTurnAssistant(message) && message.parentID === first.id,
  )
  if (!assistant || (typeof assistant.time.completed !== "number" && !assistant.error)) return undefined
  if (!assistant.error) return { name: "first_turn_ok" as const }
  return { name: "first_turn_failed" as const, class: sessionRecoveryClass(assistant.error) }
}

export function firstTurnFunnelEvents(messages: FirstTurnMessage[], cloud: boolean) {
  const outcome = firstTurnOutcome(messages)
  if (!outcome) return []
  if (outcome.name !== "first_turn_ok" || !cloud) return [outcome]
  return [outcome, { name: "first_cloud_turn_ok" as const }]
}

