import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeStreamEvent } from "@claxedo/agent-sdk-runtime"
import type { ProjectedEvent } from "./event-pump"
import { tokenUsage, type TokenUsage } from "./session-port"
import { errorMessage } from "../error-message"
import { rec } from "../json-value"

type UsageEvent = Extract<AgentRuntimeStreamEvent, { type: "usage" }>
type UsageObservation = NonNullable<UsageEvent["observation"]>

/**
 * The engine events that add to a session's recorded total. The engine's
 * session projection sums exactly these, a failed step only when it carries
 * tokens, so a turn that misses none of them sums to the total's growth.
 */
const RECORDED_USAGE: ReadonlySet<string> = new Set([
  "session.step.ended",
  "session.step.failed",
  "session.usage.recorded",
])

function recordsNothing(tokens: TokenUsage) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write === 0
}

function difference(closed: TokenUsage, opened: TokenUsage): TokenUsage {
  return {
    input: closed.input - opened.input,
    output: closed.output - opened.output,
    reasoning: closed.reasoning - opened.reasoning,
    cache: { read: closed.cache.read - opened.cache.read, write: closed.cache.write - opened.cache.write },
  }
}

/** The engine's categories are already the disjoint ones this contract meters. */
function runtimeTokens(tokens: TokenUsage): RuntimeTokenUsage {
  return {
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cache: { read: tokens.cache.read, write: tokens.cache.write },
  }
}

function durableId(event: ProjectedEvent): string | undefined {
  return event.durable ? `${event.durable.aggregateID}:${event.durable.seq}` : undefined
}

/**
 * One turn's token usage, from the engine's own accounting.
 *
 * Every recorded usage event becomes a delta keyed by its durable position, so
 * a replay carries the identity of the event it repeats. The event stream does
 * not replay what it missed while disconnected, so the turn closes with the
 * growth of the session's recorded total as a cumulative observation, which
 * replaces the running sum of the deltas downstream.
 */
export function createTurnUsage(sessionID: string, opened: TokenUsage | undefined) {
  /** The prompt the latest step sent, which is how full the context was. */
  let contextUsed = 0

  function usage(kind: UsageObservation["kind"], tokens: TokenUsage, providerObservationId: string | undefined): UsageEvent {
    return {
      type: "usage",
      contextSize: 0,
      contextUsed,
      observation: {
        kind,
        ...(providerObservationId ? { providerObservationId } : {}),
        nativeSessionId: sessionID,
        tokens: runtimeTokens(tokens),
      },
      harness: "opencode",
    }
  }

  function unreconciled(reason: string): AgentRuntimeStreamEvent {
    return {
      type: "diagnostic",
      diagnostic: {
        code: "opencode_turn_usage_unreconciled",
        message: `OpenCode turn usage could not be checked against the session total, so it stands as the step usage observed: ${reason}`,
        severity: "warn",
        source: "opencode-adapter",
      },
      harness: "opencode",
    }
  }

  return {
    observe(event: ProjectedEvent): UsageEvent | undefined {
      const id = durableId(event)
      if (!id || !RECORDED_USAGE.has(event.type)) return undefined
      const tokens = tokenUsage(rec(event.data)?.tokens)
      // Every real request has a prompt, so an all-zero record is a provider
      // that reported nothing, not a measured zero.
      if (!tokens || recordsNothing(tokens)) return undefined
      if (event.type !== "session.usage.recorded") contextUsed = tokens.input + tokens.cache.read + tokens.cache.write
      return usage("delta", tokens, id)
    },

    async close(read: () => Promise<TokenUsage | undefined>, terminal: ProjectedEvent): Promise<AgentRuntimeStreamEvent | undefined> {
      let closed: TokenUsage | undefined
      try {
        closed = await read()
      } catch (error) {
        return unreconciled(errorMessage(error))
      }
      if (!opened || !closed) return unreconciled("the engine reported no session token total")
      const grown = difference(closed, opened)
      if (recordsNothing(grown)) return undefined
      return usage("cumulative", grown, durableId(terminal))
    },
  }
}
