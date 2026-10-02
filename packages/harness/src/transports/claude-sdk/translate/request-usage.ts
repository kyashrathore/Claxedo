import { asText as text, type AgentRuntimeEvent, type RuntimeTokenUsage } from "@claxedo/agent-runtime-contract"
import { asFiniteNumber, asRecord } from "@claxedo/helpers/guards"
import { own } from "../../../translate/value"
import type { ClaudeRequestUsage, ClaudeSdkAdapterState, ClaudeTranslation } from "./adapter-state"
import type { ClaudeTranslatorMemory } from "./translator-memory"

const tokenFields = ["input", "output", "reasoning", "cacheRead", "cacheWrite", "cacheWrite1h"] as const

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

function mergeRequestUsage(previous: ClaudeRequestUsage | undefined, next: ClaudeRequestUsage): ClaudeRequestUsage {
  if (!previous) return next
  const merged = { ...previous }
  for (const field of tokenFields) {
    const left = previous[field]
    const right = next[field]
    merged[field] = left === null ? right : right === null ? left : Math.max(left, right)
  }
  return merged
}

function sameRequestUsage(left: ClaudeRequestUsage, right: ClaudeRequestUsage) {
  return tokenFields.every((field) => left[field] === right[field])
}

function sumRequestUsage(requests: Record<string, ClaudeRequestUsage>): ClaudeRequestUsage {
  const sum: ClaudeRequestUsage = { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null }
  for (const tokens of Object.values(requests)) {
    for (const field of tokenFields) {
      if (tokens[field] !== null) sum[field] = (sum[field] ?? 0) + tokens[field]
    }
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

function ownerRequests(state: ClaudeSdkAdapterState, memory: ClaudeTranslatorMemory, owner: string) {
  return (owner ? memory.requests.get(owner) : state.mainRequests) ?? {}
}

function modelScope(requests: Record<string, ClaudeRequestUsage>, owner: string, model: string | undefined) {
  if (Object.values(requests)[0]?.model === model) return owner || undefined
  return `${owner || "main"}@${model ?? "unknown"}`
}

function occupancy(memory: ClaudeTranslatorMemory, context: ClaudeRequestUsage | undefined) {
  const used = context ? (context.input ?? 0) + (context.output ?? 0) + (context.cacheRead ?? 0) + (context.cacheWrite ?? 0) : 0
  const contextSize = memory.window && context?.model === memory.window.model ? memory.window.size : 0
  return { contextSize, contextUsed: contextSize ? Math.min(used, contextSize) : used }
}

function ownerUsageEvent(state: ClaudeSdkAdapterState, memory: ClaudeTranslatorMemory, owner: string, request: ClaudeRequestUsage,
  meta: { nativeSessionId?: string; context?: ClaudeRequestUsage }) {
  const requests = ownerRequests(state, memory, owner)
  const scope = modelScope(requests, owner, request.model)
  const sameModel = Object.fromEntries(Object.entries(requests).filter(([, tokens]) => tokens.model === request.model))
  return {
    type: "usage",
    ...occupancy(memory, "context" in meta ? meta.context : request),
    observation: {
      kind: "cumulative",
      ...(scope ? { scope } : {}),
      ...(meta.nativeSessionId ? { nativeSessionId: meta.nativeSessionId } : {}),
      ...(request.model ? { model: request.model } : {}),
      tokens: runtimeTokenUsage(sumRequestUsage(sameModel)),
    },
  } satisfies AgentRuntimeEvent
}

export function meterRequest(
  state: ClaudeSdkAdapterState,
  memory: ClaudeTranslatorMemory,
  owner: string,
  requestId: string,
  usage: Record<string, unknown> | undefined,
  nativeSessionId: string | undefined,
  model: string | undefined,
  context?: { context: ClaudeRequestUsage | undefined },
) {
  const tokens = requestUsage(usage, model)
  const claimed = memory.owners.get(requestId)
  if (!tokens || (claimed !== undefined && claimed !== owner)) return undefined
  const requests = ownerRequests(state, memory, owner)
  const previous = own(requests, requestId)
  const merged = mergeRequestUsage(previous, tokens)
  if (previous && sameRequestUsage(previous, merged)) return undefined
  memory.owners.set(requestId, owner)
  const next = { ...requests, [requestId]: merged }
  if (owner) memory.requests.set(owner, next)
  const metered = owner ? state : { ...state, mainRequests: next }
  return { state: metered, event: ownerUsageEvent(metered, memory, owner, merged, { ...(nativeSessionId ? { nativeSessionId } : {}), ...context }) }
}

export function meteredResult(metered: ReturnType<typeof meterRequest>): ClaudeTranslation {
  return metered ? { state: metered.state, events: [metered.event] } : []
}

export function latestMainRequest(state: ClaudeSdkAdapterState) {
  const requests = state.mainRequests ?? {}
  return (state.lastMainRequest ? own(requests, state.lastMainRequest) : undefined) ?? Object.values(requests).at(-1)
}

export function resultUsageEvent(state: ClaudeSdkAdapterState, memory: ClaudeTranslatorMemory, nativeSessionId?: string) {
  const latest = latestMainRequest(state)
  return latest ? ownerUsageEvent(state, memory, "", latest, nativeSessionId ? { nativeSessionId } : {}) : undefined
}

export function rememberContextWindow(state: ClaudeSdkAdapterState, memory: ClaudeTranslatorMemory, message: Record<string, unknown>) {
  const entries = Object.entries(asRecord(message.modelUsage) ?? {}).flatMap(([key, value]) => {
    const row = asRecord(value)
    return row ? [[key, row] as const] : []
  })
  const main = latestMainRequest(state)?.model
  const [key, entry] = entries.find(([name]) => name === state.model) ?? entries.find(([, row]) => text(row.canonicalModel) === main) ?? []
  const size = asFiniteNumber(entry?.contextWindow)
  if (key && entry && size) memory.window = { model: text(entry.canonicalModel) ?? key, size }
}
