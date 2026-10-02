import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import { formatRateLimitReset } from "../../../translate/rate-limit-reset"
import type { CodexHandlers } from "./frame"

function rateLimitEvent(row: Record<string, unknown>) {
  const rateLimits = asRecord(row.rateLimits) ?? {}
  const primary = asRecord(rateLimits.primary)
  const secondary = asRecord(rateLimits.secondary)
  const window = [primary, secondary]
    .filter((item): item is Record<string, unknown> => !!item)
    .sort((a, b) => (asFiniteNumber(b.usedPercent) ?? 0) - (asFiniteNumber(a.usedPercent) ?? 0))[0]
  return {
    type: "rate-limit",
    status: rateLimits.rateLimitReachedType ? "limited" : "ok",
    usedPercent: asFiniteNumber(window?.usedPercent),
    resetsAt: asFiniteNumber(window?.resetsAt) ?? null,
    windowDurationMins: asFiniteNumber(window?.windowDurationMins) ?? null,
    limitId: text(rateLimits.limitId) ?? null,
    limitName: text(rateLimits.limitName) ?? null,
    reason: text(rateLimits.rateLimitReachedType) ?? null,
    metadata: { codex: { rateLimits } },
  } satisfies AgentRuntimeEvent
}

function rateLimitErrorMessage(event: Extract<AgentRuntimeEvent, { type: "rate-limit" }>) {
  const reset = formatRateLimitReset(event.resetsAt, event.windowDurationMins)
  const reason = event.reason
  if (reason === "workspace_owner_credits_depleted" || reason === "workspace_member_credits_depleted") {
    return `You've reached your Codex credits limit.${reset}`
  }
  if (reason === "rate_limit_reached") {
    return `You've reached your Codex rate limit.${reset}`
  }
  if (reason === "workspace_owner_usage_limit_reached" || reason === "workspace_member_usage_limit_reached") {
    return `You've reached your Codex usage limit.${reset}`
  }
  if (event.limitName) {
    return `You've reached your ${event.limitName} limit.${reset}`
  }
  return `You've reached your Codex usage limit.${reset}`
}

export const accountHandlers: CodexHandlers = {
  "account/rateLimits/updated": ({ state, row }) => {
    const event = rateLimitEvent(row)
    return {
      state: {
        ...state,
        lastLimitedRateLimitMessage: event.status === "limited" ? rateLimitErrorMessage(event) : undefined,
      },
      events: [event],
    }
  },
}
