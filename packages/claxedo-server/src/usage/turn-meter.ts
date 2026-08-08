import type { RuntimeTokenUsage, RuntimeUsageObservation } from "@claxedo/agent-event-runtime"
import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime"
import { eventSessionId } from "@claxedo/agent-sdk-runtime/compat-events"
import {
  knownTokenCategories,
  type TurnUsageLocation,
  type TurnUsageRevision,
  type TurnUsageStatus,
  type UsageRevisionReader,
  type UsageRevisionWriter,
} from "./contracts"

type TurnContext = {
  sessionRef: string
  workspaceId?: string
  hostId: string
  location: TurnUsageLocation
  harness: string
  providerId?: string
  modelId?: string
}

type State = {
  sessionId: string
  messageId: string
  revision: number
  tokens: RuntimeTokenUsage
  hasUsage: boolean
  providerId?: string
  modelId?: string
  observedAt?: number
  settlement?: TurnUsageRevision["settlement"]
  status?: TurnUsageStatus
  quality: TurnUsageRevision["quality"]
  lastObservationKey?: string
}

const unknownTokens = (): RuntimeTokenUsage => ({
  input: null,
  output: null,
  reasoning: null,
  cache: { read: null, write: null },
})

function key(sessionId: string, messageId: string) {
  return `${sessionId}\u0000${messageId}`
}

function add(previous: number | null, delta: number | null) {
  if (delta === null) return previous
  return (previous ?? 0) + delta
}

function applyObservation(previous: RuntimeTokenUsage, observation: RuntimeUsageObservation) {
  if (observation.kind === "cumulative") return observation.tokens
  return {
    input: add(previous.input, observation.tokens.input),
    output: add(previous.output, observation.tokens.output),
    reasoning: add(previous.reasoning, observation.tokens.reasoning),
    cache: {
      read: add(previous.cache.read, observation.tokens.cache.read),
      write: add(previous.cache.write, observation.tokens.cache.write),
    },
  }
}

function numberOrNull(input: unknown) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null
}

function messageTokens(input: unknown): RuntimeTokenUsage | undefined {
  if (!input || typeof input !== "object") return
  const row = input as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: unknown }
  const cache = row.cache && typeof row.cache === "object" ? row.cache as { read?: unknown; write?: unknown } : {}
  const tokens = {
    input: numberOrNull(row.input),
    output: numberOrNull(row.output),
    reasoning: numberOrNull(row.reasoning),
    cache: { read: numberOrNull(cache.read), write: numberOrNull(cache.write) },
  }
  // Legacy compat builders initialized every completed message to zero even
  // when the harness reported no usage. Treat that indistinguishable all-zero
  // block as unavailable unless a canonical session.usage observation exists.
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write]
  return values.some((value) => value !== null && value > 0) ? tokens : undefined
}

function observationKey(observation: RuntimeUsageObservation) {
  return JSON.stringify({
    kind: observation.kind,
    sequence: observation.sequence ?? null,
    providerObservationId: observation.providerObservationId ?? null,
    observedAt: observation.observedAt ?? null,
    tokens: observation.tokens,
  })
}

export type TurnMeter = {
  start(): Promise<void>
  consume(event: CompatEnvelope): Promise<void>
  settle(input: { sessionId: string; messageId: string; status: Exclude<TurnUsageStatus, "running" | "completed" | "error"> }): Promise<void>
  flush(): Promise<void>
}

export function createTurnMeter(input: {
  writer: UsageRevisionWriter
  reader?: UsageRevisionReader
  currentFilter?: (fact: TurnUsageRevision) => boolean
  reconcileProvisionalOnStart?: boolean
  resolveContext(value: { sessionId: string; messageId: string }): Promise<TurnContext>
  onTerminal?: (fact: TurnUsageRevision) => Promise<void> | void
  onDegraded?: (error: unknown, fact?: TurnUsageRevision) => void
  now?: () => number
}): TurnMeter {
  const states = new Map<string, State>()
  const activeBySession = new Map<string, string>()
  const now = input.now ?? Date.now
  let queue = Promise.resolve()
  let initialized = false

  async function initialize() {
    if (initialized) return
    initialized = true
    if (!input.reader) return
    const recover: State[] = []
    for (const fact of await input.reader.current()) {
      if (input.currentFilter && !input.currentFilter(fact)) continue
      states.set(key(fact.sessionId, fact.messageId), {
        sessionId: fact.sessionId,
        messageId: fact.messageId,
        revision: fact.revision,
        tokens: fact.tokens,
        hasUsage: fact.quality.knownCategories.length > 0,
        providerId: fact.providerId,
        modelId: fact.modelId,
        observedAt: fact.observedAt,
        settlement: fact.settlement,
        status: fact.status,
        quality: fact.quality,
        ...(fact.quality.providerObservationId ? { lastObservationKey: fact.quality.providerObservationId } : {}),
      })
      if (fact.settlement === "provisional") {
        activeBySession.set(fact.sessionId, fact.messageId)
        const current = states.get(key(fact.sessionId, fact.messageId))!
        recover.push(current)
      }
    }
    if (input.reconcileProvisionalOnStart) {
      for (const current of recover) {
        await persist(current, {
          settlement: current.hasUsage ? "partial" : "unavailable",
          status: "process_lost",
          completedAt: now(),
        })
      }
    }
  }

  function state(sessionId: string, messageId: string) {
    const id = key(sessionId, messageId)
    const existing = states.get(id)
    if (existing) return existing
    const created: State = {
      sessionId,
      messageId,
      revision: 0,
      tokens: unknownTokens(),
      hasUsage: false,
      quality: { source: "lifecycle", knownCategories: [] },
    }
    states.set(id, created)
    return created
  }

  async function persist(current: State, terminal?: { settlement: TurnUsageRevision["settlement"]; status: TurnUsageStatus; completedAt?: number }) {
    const context = await input.resolveContext({ sessionId: current.sessionId, messageId: current.messageId })
    const revision = current.revision + 1
    const fact: TurnUsageRevision = {
      sessionRef: context.sessionRef,
      sessionId: current.sessionId,
      messageId: current.messageId,
      revision,
      observedAt: current.observedAt ?? now(),
      ...(terminal?.completedAt === undefined ? {} : { completedAt: terminal.completedAt }),
      settlement: terminal?.settlement ?? "provisional",
      status: terminal?.status ?? "running",
      location: context.location,
      harness: context.harness,
      providerId: current.providerId ?? context.providerId ?? "unknown",
      modelId: current.modelId ?? context.modelId ?? "unknown",
      ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
      hostId: context.hostId,
      tokens: current.hasUsage ? current.tokens : unknownTokens(),
      quality: {
        ...current.quality,
        knownCategories: current.hasUsage ? knownTokenCategories(current.tokens) : [],
      },
    }
    try {
      let result = await input.writer.writeRevision(fact)
      if (result.status === "stale" || result.status === "conflict") {
        current.revision = result.currentRevision
        fact.revision = result.currentRevision + 1
        result = await input.writer.writeRevision(fact)
      }
      if (result.status === "accepted" || result.status === "duplicate") {
        current.revision = fact.revision
        current.settlement = fact.settlement
        current.status = fact.status
        if (fact.settlement !== "provisional") {
          activeBySession.delete(current.sessionId)
          await input.onTerminal?.(fact)
        }
      }
    } catch (error) {
      input.onDegraded?.(error, fact)
    }
  }

  async function consumeOne(event: CompatEnvelope) {
    await initialize()
    const sessionId = eventSessionId(event.payload)
    if (!sessionId) return
    if (event.payload.type === "session.usage") {
      const observation = event.payload.properties.observation
      const messageId = event.payload.properties.messageID
      if (!observation || !messageId) return
      const current = state(sessionId, messageId)
      const signature = observationKey(observation)
      if (current.lastObservationKey === signature) return
      current.tokens = applyObservation(current.tokens, observation)
      current.hasUsage = true
      current.observedAt = observation.observedAt ?? now()
      current.quality = {
        source: "provider",
        observationKind: observation.kind,
        ...(observation.providerObservationId ? { providerObservationId: observation.providerObservationId } : {}),
        knownCategories: knownTokenCategories(current.tokens),
      }
      current.lastObservationKey = signature
      activeBySession.set(sessionId, messageId)
      await persist(current)
      return
    }
    if (event.payload.type === "message.updated") {
      const info = event.payload.properties.info
      if (info.role !== "assistant") return
      const current = state(sessionId, info.id)
      current.providerId = info.providerID
      current.modelId = info.modelID
      activeBySession.set(sessionId, info.id)
      const completedAt = info.time.completed
      if (typeof completedAt !== "number") {
        if (current.revision === 0) await persist(current)
        return
      }
      if (current.status === "stopped" || current.status === "interrupted_by_steer" || current.status === "process_lost") return
      const tokens = messageTokens(info.tokens)
      if (tokens) {
        current.tokens = tokens
        current.hasUsage = true
        current.observedAt = completedAt
        current.quality = { source: "provider-message", knownCategories: knownTokenCategories(tokens) }
      }
      const status: TurnUsageStatus = info.error ? "error" : "completed"
      if (current.settlement === "final" && current.status === status) return
      await persist(current, {
        settlement: current.hasUsage ? "final" : "unavailable",
        status,
        completedAt,
      })
      return
    }
    if (event.payload.type === "message.completed") {
      const current = state(sessionId, event.payload.properties.messageID)
      if (current.settlement === "final" || current.settlement === "unavailable") return
      await persist(current, {
        settlement: current.hasUsage ? "final" : "unavailable",
        status: "completed",
        completedAt: now(),
      })
      return
    }
    if (event.payload.type === "session.error") {
      const messageId = activeBySession.get(sessionId)
      if (!messageId) return
      const current = state(sessionId, messageId)
      if (current.status === "stopped" || current.status === "interrupted_by_steer" || current.status === "process_lost") return
      await persist(current, {
        settlement: current.hasUsage ? "final" : "unavailable",
        status: "error",
        completedAt: now(),
      })
    }
  }

  function enqueue(operation: () => Promise<void>) {
    const run = queue.then(operation)
    queue = run.catch((error) => input.onDegraded?.(error))
    return run
  }

  return {
    start() {
      return enqueue(initialize)
    },
    consume(event) {
      return enqueue(() => consumeOne(event))
    },
    settle(value) {
      return enqueue(async () => {
        await initialize()
        const current = state(value.sessionId, value.messageId)
        await persist(current, {
          settlement: current.hasUsage ? "partial" : "unavailable",
          status: value.status,
          completedAt: now(),
        })
      })
    },
    flush() {
      return queue
    },
  }
}
