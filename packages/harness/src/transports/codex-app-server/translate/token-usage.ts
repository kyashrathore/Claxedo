import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import type { AgentRuntimeEvent, AgentRuntimeEventOf, RuntimeTokenUsage, RuntimeUsageObservation } from "@claxedo/agent-runtime-contract"
import { asText as text } from "@claxedo/agent-runtime-contract"
import type { CodexTurnUsageState } from "./state"

type CodexUsageField = keyof CodexTurnUsageState["accumulated"]
type CodexUsageFields = CodexTurnUsageState["accumulated"]

function addNullable(previous: number | null, delta: number | undefined) {
  if (delta === undefined) return previous
  return (previous ?? 0) + delta
}

function disjointTokens(fields: CodexUsageFields): RuntimeTokenUsage {
  return {
    input: fields.inputTokens === null ? null : Math.max(0, fields.inputTokens - (fields.cachedInputTokens ?? 0)),
    output: fields.outputTokens === null ? null : Math.max(0, fields.outputTokens - (fields.reasoningOutputTokens ?? 0)),
    reasoning: fields.reasoningOutputTokens,
    cache: { read: fields.cachedInputTokens, write: null },
  }
}

type TokenUsageReport = {
  total?: Record<string, unknown>
  last: Record<string, unknown>
  totalsSignature?: string
  contextSize?: number
  contextUsed?: number
}

function tokenUsageReport(row: Record<string, unknown>): TokenUsageReport | undefined {
  const tokenUsage = asRecord(row.tokenUsage) ?? row
  const total = asRecord(tokenUsage.total)
  const last = asRecord(tokenUsage.last) ?? {}
  const contextSize = asFiniteNumber(tokenUsage.modelContextWindow) ?? asFiniteNumber(row.modelContextWindow)
  const contextUsed = asFiniteNumber(last.totalTokens) ?? asFiniteNumber(tokenUsage.totalTokens) ?? asFiniteNumber(total?.totalTokens)
  if (contextUsed === undefined && contextSize === undefined) return undefined
  return {
    ...(total ? { total, totalsSignature: JSON.stringify(total) } : {}),
    last,
    ...(contextSize === undefined ? {} : { contextSize }),
    ...(contextUsed === undefined ? {} : { contextUsed }),
  }
}

function reportGrowth(report: TokenUsageReport, previousTotals: Record<string, unknown> | undefined) {
  return (field: CodexUsageField) => {
    if (report.total && previousTotals) {
      const current = asFiniteNumber(report.total[field])
      const previous = asFiniteNumber(previousTotals[field])
      if (current !== undefined && previous !== undefined) return Math.max(0, current - previous)
    }
    return asFiniteNumber(report.last[field])
  }
}

function usageEvent(report: TokenUsageReport, observation?: RuntimeUsageObservation): AgentRuntimeEventOf<"usage"> {
  return {
    type: "usage",
    contextSize: report.contextSize ?? report.contextUsed ?? 0,
    contextUsed: report.contextUsed ?? report.contextSize ?? 0,
    ...(observation ? { observation } : {}),
  }
}

function accumulate(stream: CodexTurnUsageState | undefined, growth: (field: CodexUsageField) => number | undefined): CodexUsageFields {
  return {
    inputTokens: addNullable(stream?.accumulated.inputTokens ?? null, growth("inputTokens")),
    cachedInputTokens: addNullable(stream?.accumulated.cachedInputTokens ?? null, growth("cachedInputTokens")),
    outputTokens: addNullable(stream?.accumulated.outputTokens ?? null, growth("outputTokens")),
    reasoningOutputTokens: addNullable(stream?.accumulated.reasoningOutputTokens ?? null, growth("reasoningOutputTokens")),
  }
}

export function turnUsage(
  row: Record<string, unknown>,
  previous: CodexTurnUsageState | undefined,
  threadId: string,
  servedModel: (turnId: string | undefined) => string | undefined,
): { event: AgentRuntimeEvent; turnUsage: CodexTurnUsageState } | undefined {
  const turnId = text(row.turnId)
  const sameTurn = previous?.turnId === turnId ? previous : undefined
  const report = tokenUsageReport(row)
  if (!report) return undefined
  if (report.totalsSignature !== undefined && report.totalsSignature === sameTurn?.previousTotalsSignature) {
    return { event: usageEvent(report), turnUsage: sameTurn }
  }
  const model = servedModel(turnId)
  const turnScope = turnId ? `${threadId}:${turnId}` : threadId
  const stream = sameTurn?.model === model ? sameTurn : undefined
  const scope = stream ? stream.scope ?? turnScope : sameTurn ? `${turnScope}@${model ?? "unknown"}` : turnScope
  const accumulated = accumulate(stream, reportGrowth(report, sameTurn?.previousTotals))
  return {
    event: usageEvent(report, {
      kind: "cumulative",
      scope,
      ...(threadId ? { nativeSessionId: threadId } : {}),
      ...(turnId ? { providerObservationId: turnId } : {}),
      ...(model ? { model } : {}),
      tokens: disjointTokens(accumulated),
    }),
    turnUsage: {
      ...(turnId ? { turnId } : {}),
      ...(model ? { model } : {}),
      scope,
      ...(report.total ? { previousTotals: report.total } : {}),
      ...(report.totalsSignature === undefined ? {} : { previousTotalsSignature: report.totalsSignature }),
      accumulated,
    },
  }
}

export function codexUsageGrowth(input: {
  payload: unknown
  previousTotal: Record<string, unknown> | undefined
  scope: string
  model?: string
}): { total?: Record<string, unknown>; event?: AgentRuntimeEventOf<"usage"> } {
  const row = asRecord(input.payload) ?? {}
  const report = tokenUsageReport(row)
  if (!report) return {}
  const growth = reportGrowth(report, input.previousTotal)
  const fields = {
    inputTokens: growth("inputTokens") ?? null,
    cachedInputTokens: growth("cachedInputTokens") ?? null,
    outputTokens: growth("outputTokens") ?? null,
    reasoningOutputTokens: growth("reasoningOutputTokens") ?? null,
  }
  const total = report.total ? { total: report.total } : {}
  if (!Object.values(fields).some((value) => value !== null && value > 0)) return total
  const threadId = text(row.threadId)
  const turnId = text(row.turnId)
  return {
    ...total,
    event: usageEvent(report, {
      kind: "delta",
      scope: input.scope,
      ...(threadId ? { nativeSessionId: threadId } : {}),
      providerObservationId: `${threadId ?? ""}:${turnId ?? ""}:${report.totalsSignature ?? JSON.stringify(report.last)}`,
      ...(input.model ? { model: input.model } : {}),
      tokens: disjointTokens(fields),
    }),
  }
}
