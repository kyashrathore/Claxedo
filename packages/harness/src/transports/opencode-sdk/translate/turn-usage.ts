import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { ProjectedEvent } from "../event-pump"
import { tokenUsage, type TokenUsage } from "../session-port"
import { errorMessage } from "../error-text"
import { rec, str } from "../value"

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>
type UsageObservation = NonNullable<UsageEvent["observation"]>

const RECORDED_USAGE: ReadonlySet<string> = new Set([
  "session.step.ended",
  "session.step.failed",
  "session.usage.recorded",
])

function recordsNothing(tokens: TokenUsage) {
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write === 0
}

function subtractTokens(closed: TokenUsage, opened: TokenUsage): TokenUsage {
  return {
    input: closed.input - opened.input,
    output: closed.output - opened.output,
    reasoning: closed.reasoning - opened.reasoning,
    cache: { read: closed.cache.read - opened.cache.read, write: closed.cache.write - opened.cache.write },
  }
}

function addTokens(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cache: { read: left.cache.read + right.cache.read, write: left.cache.write + right.cache.write },
  }
}

const NONE: TokenUsage = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

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

/** How long a turn waits for the engine to report the session total, at its start and at its end. */
export const SESSION_TOTAL_READ_MS = 5_000

/** The session's recorded token total, or why it could not be read in time. */
export type SessionTotal = { tokens: TokenUsage | undefined } | { failure: string }

/**
 * Reads the session total with a deadline: a wedged engine costs the turn its
 * reconciliation, never the turn itself or the step usage already metered.
 */
export async function readSessionTotal(read: () => Promise<TokenUsage | undefined>, deadlineMs = SESSION_TOTAL_READ_MS): Promise<SessionTotal> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the engine did not report the session total within ${deadlineMs}ms`)), deadlineMs)
  })
  try {
    return { tokens: await Promise.race([read(), expired]) }
  } catch (error) {
    return { failure: errorMessage(error) }
  } finally {
    clearTimeout(timer)
  }
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
export function createTurnUsage(sessionID: string, opened: SessionTotal) {
  /** The prompt the latest step sent, which is how full the context was. */
  let contextUsed = 0
  /** The model each step started on, by the assistant message the step writes. */
  const stepModels = new Map<string, string>()
  /** Every model a recorded usage event was served by; `undefined` for one that named none. */
  const servedModels = new Set<string | undefined>()
  let observed = NONE

  function usage(kind: UsageObservation["kind"], tokens: TokenUsage, providerObservationId: string | undefined, model: string | undefined): UsageEvent {
    return {
      type: "usage",
      contextSize: 0,
      contextUsed,
      observation: {
        kind,
        ...(providerObservationId ? { providerObservationId } : {}),
        nativeSessionId: sessionID,
        ...(model ? { model } : {}),
        tokens: runtimeTokens(tokens),
      },
      harness: "opencode",
    }
  }

  function unreconciled(reason: string): AgentRuntimeEvent {
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
      const data = rec(event.data)
      const message = str(data?.assistantMessageID)
      if (event.type === "session.step.started") {
        const model = str(rec(data?.model)?.id)
        if (message && model) stepModels.set(message, model)
        return undefined
      }
      const id = durableId(event)
      if (!id || !RECORDED_USAGE.has(event.type)) return undefined
      const tokens = tokenUsage(data?.tokens)
      if (!tokens || recordsNothing(tokens)) return undefined
      if (event.type !== "session.usage.recorded") contextUsed = tokens.input + tokens.cache.read + tokens.cache.write
      const model = event.type === "session.usage.recorded" || !message ? undefined : stepModels.get(message)
      servedModels.add(model)
      observed = addTokens(observed, tokens)
      return usage("delta", tokens, id, model)
    },

    close(closed: SessionTotal, terminal: ProjectedEvent): AgentRuntimeEvent | undefined {
      if ("failure" in opened) return unreconciled(`the session total before the prompt was not read: ${opened.failure}`)
      if ("failure" in closed) return unreconciled(closed.failure)
      if (!opened.tokens || !closed.tokens) return unreconciled("the engine reported no session token total")
      const grown = subtractTokens(closed.tokens, opened.tokens)
      if (recordsNothing(grown)) return undefined
      const [only] = servedModels.size === 1 && JSON.stringify(grown) === JSON.stringify(observed) ? servedModels : []
      return usage("cumulative", grown, durableId(terminal), only)
    },
  }
}
