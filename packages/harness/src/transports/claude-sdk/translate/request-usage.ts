import type { AgentRuntimeEvent, RuntimeTokenUsage } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import type { ClaudeRequestUsage, ClaudeSdkAdapterState } from "./adapter-state"

function requestUsage(usage: Record<string, unknown> | undefined, model: string | undefined): ClaudeRequestUsage | undefined {
  if (!usage) return undefined
  const tokens = {
    input: asFiniteNumber(usage.input_tokens) ?? null,
    output: asFiniteNumber(usage.output_tokens) ?? null,
    reasoning: asFiniteNumber(usage.thinking_tokens) ?? null,
    cacheRead: asFiniteNumber(usage.cache_read_input_tokens) ?? null,
    cacheWrite: asFiniteNumber(usage.cache_creation_input_tokens) ?? null,
    cacheWrite1h: asFiniteNumber(asRecord(usage.cache_creation)?.ephemeral_1h_input_tokens) ?? null,
  }
  if (!Object.values(tokens).some((value) => value !== null && value > 0)) return undefined
  return model ? { ...tokens, model } : tokens
}

function larger(previous: number | null, next: number | null) {
  if (previous === null) return next
  if (next === null) return previous
  return Math.max(previous, next)
}

function mergeRequestUsage(previous: ClaudeRequestUsage | undefined, next: ClaudeRequestUsage): ClaudeRequestUsage {
  if (!previous) return next
  return {
    input: larger(previous.input, next.input),
    output: larger(previous.output, next.output),
    reasoning: larger(previous.reasoning, next.reasoning),
    cacheRead: larger(previous.cacheRead, next.cacheRead),
    cacheWrite: larger(previous.cacheWrite, next.cacheWrite),
    cacheWrite1h: larger(previous.cacheWrite1h, next.cacheWrite1h),
    ...(previous.model ? { model: previous.model } : {}),
  }
}

function sameRequestUsage(left: ClaudeRequestUsage, right: ClaudeRequestUsage) {
  return left.input === right.input &&
    left.output === right.output &&
    left.reasoning === right.reasoning &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.cacheWrite1h === right.cacheWrite1h
}

function addNullable(previous: number | null, value: number | null) {
  if (value === null) return previous
  return (previous ?? 0) + value
}

function sumRequestUsage(requests: Record<string, ClaudeRequestUsage>): ClaudeRequestUsage {
  const sum: ClaudeRequestUsage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null }
  for (const tokens of Object.values(requests)) {
    sum.input = addNullable(sum.input, tokens.input)
    sum.output = addNullable(sum.output, tokens.output)
    sum.reasoning = addNullable(sum.reasoning, tokens.reasoning)
    sum.cacheRead = addNullable(sum.cacheRead, tokens.cacheRead)
    sum.cacheWrite = addNullable(sum.cacheWrite, tokens.cacheWrite)
    sum.cacheWrite1h = addNullable(sum.cacheWrite1h, tokens.cacheWrite1h)
  }
  return sum
}

function runtimeTokenUsage(tokens: ClaudeRequestUsage): RuntimeTokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: {
      read: tokens.cacheRead,
      write: tokens.cacheWrite,
      ...(tokens.cacheWrite1h === null ? {} : { write1h: tokens.cacheWrite1h }),
    },
  }
}

function ownerRequests(state: ClaudeSdkAdapterState, owner: string) {
  return own(state.requestUsageByOwner ?? {}, owner) ?? {}
}

function modelScope(requests: Record<string, ClaudeRequestUsage>, owner: string, model: string | undefined) {
  if (Object.values(requests)[0]?.model === model) return owner || undefined
  return `${owner || "main"}@${model ?? "unknown"}`
}

function ownerUsageEvent(state: ClaudeSdkAdapterState, owner: string, request: ClaudeRequestUsage, nativeSessionId?: string) {
  const requestTotal = (request.input ?? 0) + (request.output ?? 0) + (request.cacheRead ?? 0) + (request.cacheWrite ?? 0)
  const contextSize = state.lastKnownContextWindow ?? requestTotal
  const requests = ownerRequests(state, owner)
  const scope = modelScope(requests, owner, request.model)
  const sameModel = Object.fromEntries(Object.entries(requests).filter(([, tokens]) => tokens.model === request.model))
  return {
    type: "usage",
    contextSize,
    contextUsed: Math.min(requestTotal, contextSize),
    observation: {
      kind: "cumulative",
      ...(scope ? { scope } : {}),
      ...(nativeSessionId ? { nativeSessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      tokens: runtimeTokenUsage(sumRequestUsage(sameModel)),
    },
  } satisfies AgentRuntimeEvent
}

export function meterRequest(
  state: ClaudeSdkAdapterState,
  owner: string,
  requestId: string,
  usage: Record<string, unknown> | undefined,
  nativeSessionId: string | undefined,
  model: string | undefined,
) {
  const tokens = requestUsage(usage, model)
  if (!tokens) return undefined
  const requests = ownerRequests(state, owner)
  const previous = own(requests, requestId)
  const merged = mergeRequestUsage(previous, tokens)
  if (previous && sameRequestUsage(previous, merged)) return undefined
  const requestUsageByOwner = { ...state.requestUsageByOwner, [owner]: { ...requests, [requestId]: merged } }
  return {
    requestUsageByOwner,
    event: ownerUsageEvent({ ...state, requestUsageByOwner }, owner, merged, nativeSessionId),
  }
}

export function meteredResult(state: ClaudeSdkAdapterState, metered: ReturnType<typeof meterRequest>) {
  return metered
    ? { state: { ...state, requestUsageByOwner: metered.requestUsageByOwner }, events: [metered.event] }
    : []
}

export function resultUsageEvent(state: ClaudeSdkAdapterState, nativeSessionId?: string) {
  const requests = ownerRequests(state, "")
  const latest = (state.lastMainRequest ? own(requests, state.lastMainRequest) : undefined) ?? Object.values(requests).at(-1)
  return latest ? ownerUsageEvent(state, "", latest, nativeSessionId) : undefined
}

export function resultContextWindow(message: Record<string, unknown>) {
  const modelUsage = asRecord(message.modelUsage)
  return modelUsage
    ? Object.values(modelUsage).flatMap((value) => asFiniteNumber(asRecord(value)?.contextWindow) ?? [])[0]
    : undefined
}
