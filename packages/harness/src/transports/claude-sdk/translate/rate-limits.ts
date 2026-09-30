import { USAGE_WINDOW_NAMES, asText as text } from "@claxedo/agent-runtime-contract"
import type { AgentRuntimeEvent, FirstTurnErrorClass } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { formatRateLimitReset } from "../../../translate/rate-limit-reset"
import type { ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"

function rateLimitResetMs(value: unknown) {
  const reset = asFiniteNumber(value)
  if (reset === undefined) return null
  return Math.round(reset < 1e12 ? reset * 1000 : reset)
}

export function assistantErrorClass(code: string, state: ClaudeSdkAdapterState): FirstTurnErrorClass | undefined {
  if (code !== "rate_limit") return undefined
  return state.rejectedWindow ? "usage_limit" : "rate_limit"
}

export function windowLimitMessage(window: NonNullable<ClaudeSdkAdapterState["rejectedWindow"]>) {
  const name = window.limitName?.replaceAll("_", " ")
  return `You've reached your Claude ${name ? `${name} ` : "usage "}limit.${formatRateLimitReset(window.resetsAt)}`
}

function claudeRateLimitEvent(info: Record<string, unknown>) {
  const utilization = asFiniteNumber(info.utilization)
  const limitId = text(info.rateLimitType)
  const windows = USAGE_WINDOW_NAMES.claude
  return {
    type: "rate-limit",
    status: text(info.status) === "rejected" ? "limited" : "ok",
    ...(utilization === undefined ? {} : { usedPercent: Math.min(100, Math.max(0, Math.round(utilization))) }),
    resetsAt: rateLimitResetMs(info.resetsAt),
    ...(limitId ? { limitId, limitName: (windows && Object.hasOwn(windows, limitId) ? windows[limitId] : undefined) ?? limitId } : {}),
  } satisfies AgentRuntimeEvent
}

export function translateRateLimitEvent(state: ClaudeSdkAdapterState, rateLimitInfo: unknown): ClaudeTranslation {
  const event = claudeRateLimitEvent(asRecord(rateLimitInfo) ?? {})
  const { rejectedWindow: _, ...rest } = state
  const rejectedWindow = { ...(event.limitName ? { limitName: event.limitName } : {}), resetsAt: event.resetsAt }
  return { state: event.status === "limited" ? { ...rest, rejectedWindow } : rest, events: [event] }
}
