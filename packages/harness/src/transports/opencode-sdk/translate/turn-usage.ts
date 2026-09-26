import type { RuntimeTokenUsage } from "@claxedo/agent-event-runtime"
import type { AgentRuntimeEvent } from "@claxedo/agent-event-runtime"
import type { ProjectedEvent } from "../event-pump.js"
import { tokenUsage, type TokenUsage } from "../session-port.js"
import { errorMessage, settleAtRequestDeadline } from "@claxedo/helpers"
import { asRecord as rec, asString as str } from "@claxedo/helpers/guards"

type UsageEvent = Extract<AgentRuntimeEvent, { type: "usage" }>
type UsageObservation = NonNullable<UsageEvent["observation"]>

const RECORDED_USAGE: readonly string[] = [
  "session.step.ended",
  "session.step.failed",
  "session.usage.recorded",
]

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

export const SESSION_TOTAL_READ_MS = 5_000

export type SessionTotal = { tokens: TokenUsage | undefined } | { failure: string }

export async function readSessionTotal(read: () => Promise<TokenUsage | undefined>, deadlineMs = SESSION_TOTAL_READ_MS): Promise<SessionTotal> {
  try {
    return { tokens: await settleAtRequestDeadline("session total",
      { deadlineAt: Date.now() + deadlineMs, signal: new AbortController().signal }, read(), () => {},
      () => new Error(`the engine did not report the session total within ${deadlineMs}ms`)) }
  } catch (error) {
    return { failure: errorMessage(error) }
  }
}

class TurnUsage {
  private contextUsed = 0
  private readonly stepModels = new Map<string, string>()
  private readonly servedModels = new Set<string | undefined>()
  private observed = NONE

  constructor(private readonly sessionID: string, private readonly opened: SessionTotal) {}

  private usage(kind: UsageObservation["kind"], tokens: TokenUsage, providerObservationId: string | undefined, model: string | undefined): UsageEvent {
    return {
      type: "usage",
      contextSize: 0,
      contextUsed: this.contextUsed,
      observation: {
        kind,
        ...(providerObservationId ? { providerObservationId } : {}),
        nativeSessionId: this.sessionID,
        ...(model ? { model } : {}),
        tokens: runtimeTokens(tokens),
      },
      harness: "opencode",
    }
  }

  private unreconciled(reason: string): AgentRuntimeEvent {
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

  observe(event: ProjectedEvent): UsageEvent | undefined {
      const data = rec(event.data)
      const message = str(data?.assistantMessageID)
      if (event.type === "session.step.started") {
        const model = str(rec(data?.model)?.id)
        if (message && model) this.stepModels.set(message, model)
        return undefined
      }
      const id = durableId(event)
      if (!id || !RECORDED_USAGE.includes(event.type)) return undefined
      const tokens = tokenUsage(data?.tokens)
      if (!tokens || recordsNothing(tokens)) return undefined
      if (event.type !== "session.usage.recorded") this.contextUsed = tokens.input + tokens.cache.read + tokens.cache.write
      const model = event.type === "session.usage.recorded" || !message ? undefined : this.stepModels.get(message)
      this.servedModels.add(model)
      this.observed = addTokens(this.observed, tokens)
      return this.usage("delta", tokens, id, model)
  }

  close(closed: SessionTotal, terminal?: ProjectedEvent): AgentRuntimeEvent | undefined {
      if ("failure" in this.opened) return this.unreconciled(`the session total before the prompt was not read: ${this.opened.failure}`)
      if ("failure" in closed) return this.unreconciled(closed.failure)
      if (!this.opened.tokens || !closed.tokens) return this.unreconciled("the engine reported no session token total")
      const grown = subtractTokens(closed.tokens, this.opened.tokens)
      if (recordsNothing(grown)) return undefined
      const [only] = this.servedModels.size === 1 && JSON.stringify(grown) === JSON.stringify(this.observed) ? this.servedModels : []
      return this.usage("cumulative", grown, terminal ? durableId(terminal) : undefined, only)
  }
}

export function createTurnUsage(sessionID: string, opened: SessionTotal): TurnUsage {
  return new TurnUsage(sessionID, opened)
}
