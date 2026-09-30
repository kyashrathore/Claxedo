import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { asRecord } from "@claxedo/agent-runtime-contract"

const reportedTokens = (value: unknown) => typeof value === "number" ? value : null

export function piUsageEvents(value: unknown, providerObservationId?: string): AgentRuntimeEvent[] {
  const usage = asRecord(value) ?? {}
  if (typeof usage.input !== "number" || typeof usage.output !== "number") return []
  const cacheRead = reportedTokens(usage.cacheRead)
  const cacheWrite = reportedTokens(usage.cacheWrite)
  const reasoning = reportedTokens(usage.reasoning)
  return [{
    type: "usage",
    contextSize: 0,
    contextUsed: usage.input + (cacheRead ?? 0) + (cacheWrite ?? 0),
    observation: {
      kind: "delta",
      ...(providerObservationId ? { providerObservationId } : {}),
      tokens: { input: usage.input, output: usage.output - (reasoning ?? 0), reasoning, cache: { read: cacheRead, write: cacheWrite } },
    },
  }]
}
