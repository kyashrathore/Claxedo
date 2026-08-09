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
  nativeSessionId?: string
}

type State = {
  sessionId: string
  messageId: string
  revision: number
  tokens: RuntimeTokenUsage
  hasUsage: boolean
  providerId?: string
  modelId?: string
  nativeSessionId?: string
  observedAt?: number
  completedAt?: number
  settlement?: TurnUsageRevision["settlement"]
  status?: TurnUsageStatus
  quality: TurnUsageRevision["quality"]
  lastObservationKey?: string
  context?: TurnContext
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
  const cache = row.cache && typeof row.cache === "object" ? (row.cache as { read?: unknown; write?: unknown }) : {}
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
  // Delta observation ids are event identities and remain replay keys. Codex
  // and Cursor cumulative ids identify the containing turn/run, so their
  // evolving token snapshots must include the counters in the signature.
  if (observation.kind === "delta" && observation.providerObservationId) {
    return `provider:${observation.providerObservationId}`
  }
  return JSON.stringify({
    kind: observation.kind,
    sequence: observation.sequence ?? null,
    providerObservationId: observation.providerObservationId ?? null,
    nativeSessionId: observation.nativeSessionId ?? null,
    observedAt: observation.observedAt ?? null,
    tokens: observation.tokens,
  })
}

export type TurnMeter = {
  start(): Promise<void>
  consume(event: CompatEnvelope): Promise<void>
  settle(input: {
    sessionId: string
    messageId: string
    status: Exclude<TurnUsageStatus, "running" | "completed" | "error">
  }): Promise<void>
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

  function hydrate(fact: TurnUsageRevision) {
    const hydrated: State = {
      sessionId: fact.sessionId,
      messageId: fact.messageId,
      revision: fact.revision,
      tokens: fact.tokens,
      hasUsage: fact.quality.knownCategories.length > 0,
      providerId: fact.providerId,
      modelId: fact.modelId,
      ...(fact.nativeSessionId ? { nativeSessionId: fact.nativeSessionId } : {}),
      observedAt: fact.observedAt,
      settlement: fact.settlement,
      status: fact.status,
      quality: fact.quality,
      ...(fact.quality.providerObservationKey
        ? { lastObservationKey: fact.quality.providerObservationKey }
        : fact.quality.observationKind === "delta" && fact.quality.providerObservationId
          ? { lastObservationKey: `provider:${fact.quality.providerObservationId}` }
          : {}),
      ...(fact.completedAt === undefined ? {} : { completedAt: fact.completedAt }),
      context: {
        sessionRef: fact.sessionRef,
        ...(fact.workspaceId ? { workspaceId: fact.workspaceId } : {}),
        hostId: fact.hostId,
        location: fact.location,
        harness: fact.harness,
        providerId: fact.providerId,
        modelId: fact.modelId,
        ...(fact.nativeSessionId ? { nativeSessionId: fact.nativeSessionId } : {}),
      },
    }
    states.set(key(fact.sessionId, fact.messageId), hydrated)
    return hydrated
  }

  async function initialize() {
    if (initialized) return
    if (!input.reader) {
      initialized = true
      return
    }
    const recover: State[] = []
    const current = input.reconcileProvisionalOnStart
      ? await input.reader.current({ settlement: "provisional" })
      : await input.reader.current()
    for (const fact of current) {
      if (input.currentFilter && !input.currentFilter(fact)) continue
      hydrate(fact)
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
    initialized = true
  }

  async function state(sessionId: string, messageId: string) {
    const id = key(sessionId, messageId)
    const existing = states.get(id)
    if (existing) return existing
    if (input.reader && input.reconcileProvisionalOnStart) {
      const persisted = (
        await input.reader.current({
          sessionId,
          messageId,
        })
      ).find((fact) => !input.currentFilter || input.currentFilter(fact))
      if (persisted) return hydrate(persisted)
    }
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

  async function persist(
    current: State,
    terminal?: { settlement: TurnUsageRevision["settlement"]; status: TurnUsageStatus; completedAt?: number },
  ) {
    let fact: TurnUsageRevision | undefined
    try {
      const context =
        current.context ?? (await input.resolveContext({ sessionId: current.sessionId, messageId: current.messageId }))
      current.context = context
      const revision = current.revision + 1
      fact = {
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
        ...((current.nativeSessionId ?? context.nativeSessionId)
          ? { nativeSessionId: current.nativeSessionId ?? context.nativeSessionId }
          : {}),
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        hostId: context.hostId,
        tokens: current.hasUsage ? current.tokens : unknownTokens(),
        quality: {
          ...current.quality,
          knownCategories: current.hasUsage ? knownTokenCategories(current.tokens) : [],
        },
      }
      let result = await input.writer.writeRevision(fact)
      if (result.status === "stale") {
        current.revision = result.currentRevision
        fact.revision = result.currentRevision + 1
        result = await input.writer.writeRevision(fact)
      }
      if (result.status === "conflict") {
        input.onDegraded?.(
          new Error(`usage revision ${fact.revision} conflicts with durable revision ${result.currentRevision}`),
          fact,
        )
        return
      }
      if (result.status === "accepted" || result.status === "duplicate") {
        current.revision = fact.revision
        current.settlement = fact.settlement
        current.status = fact.status
        current.completedAt = fact.completedAt
        if (fact.settlement !== "provisional") {
          activeBySession.delete(current.sessionId)
          await input.onTerminal?.(fact)
        }
      } else {
        input.onDegraded?.(new Error(`usage revision ${fact.revision} remained stale after refresh`), fact)
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
      const current = await state(sessionId, messageId)
      const signature = observationKey(observation)
      if (current.lastObservationKey === signature) return
      current.tokens = applyObservation(current.tokens, observation)
      current.hasUsage = true
      current.observedAt = observation.observedAt ?? now()
      current.nativeSessionId = observation.nativeSessionId ?? current.nativeSessionId
      current.quality = {
        source: "provider",
        observationKind: observation.kind,
        ...(observation.providerObservationId ? { providerObservationId: observation.providerObservationId } : {}),
        providerObservationKey: signature,
        knownCategories: knownTokenCategories(current.tokens),
      }
      current.lastObservationKey = signature
      activeBySession.set(sessionId, messageId)
      const terminalSettlement = current.settlement
      await persist(
        current,
        terminalSettlement && terminalSettlement !== "provisional"
          ? {
              settlement:
                terminalSettlement === "partial" || terminalSettlement === "unavailable"
                  ? "recovered"
                  : terminalSettlement,
              status: current.status ?? "completed",
              completedAt: current.completedAt ?? now(),
            }
          : undefined,
      )
      return
    }
    if (event.payload.type === "message.updated") {
      const info = event.payload.properties.info
      if (info.role !== "assistant") return
      const current = await state(sessionId, info.id)
      current.providerId = info.providerID
      current.modelId = info.modelID
      activeBySession.set(sessionId, info.id)
      const tokens = messageTokens(info.tokens)
      // OpenCode publishes its authoritative token snapshot on the final
      // assistant update, but represents terminality with `finish` followed by
      // `message.completed` rather than populating `time.completed`. Capture
      // usage whenever the provider supplies it; settlement remains owned by
      // the terminal lifecycle events below.
      if (tokens && current.quality.source !== "provider") {
        current.tokens = tokens
        current.hasUsage = true
        current.observedAt = typeof info.time.completed === "number" ? info.time.completed : now()
        current.quality = { source: "provider-message", knownCategories: knownTokenCategories(tokens) }
      }
      const completedAt = info.time.completed
      if (typeof completedAt !== "number") {
        if (current.revision === 0) await persist(current)
        return
      }
      if (
        current.status === "stopped" ||
        current.status === "interrupted_by_steer" ||
        current.status === "process_lost"
      )
        return
      // `session.usage` is the canonical producer. Assistant-message tokens are
      // a compatibility fallback and may contain schema-required zeroes for
      // categories the provider never reported.
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
      const current = await state(sessionId, event.payload.properties.messageID)
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
      const current = await state(sessionId, messageId)
      if (
        current.status === "stopped" ||
        current.status === "interrupted_by_steer" ||
        current.status === "process_lost"
      )
        return
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
        const current = await state(value.sessionId, value.messageId)
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
