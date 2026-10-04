import type { AgentEventEnvelope } from "@claxedo/agent-runtime-contract"
import {
  isRepeatedUsageObservation,
  recordUsageObservation,
  unknownTokenUsage,
  usageObservationKey,
  usageStreamsTotal,
  type RuntimeTokenUsage,
} from "@claxedo/agent-runtime-contract"
import { jsonRecord } from "../platform/runtime/lib/json"
import {
  knownTokenCategories,
  type TurnUsageLocation,
  type TurnUsageRevision,
  type TurnUsageStatus,
  type UsageRevisionReader,
  type UsageRevisionWriter,
} from "./contracts"
import type { TurnMeterState, TurnMeterStateStore } from "./turn-meter-state"
import { eventSessionId } from "@claxedo/session-core"

type TurnContext = {
  sessionRef: string
  workspaceId?: string
  hostId: string
  location: TurnUsageLocation
  harness: string
  providerId?: string
  modelId?: string
  nativeSessionId?: string
  /**
   * The account that incurred the usage, resolved from the session's producer
   * — never from a later request. Absent means the machine produced the fact
   * unsigned; only the machine operator's sync may claim it.
   */
  owner?: { org_id: string; user_id: string }
}

type State = {
  sessionId: string
  messageId: string
  revision: number
  tokens: RuntimeTokenUsage
  hasUsage: boolean
  providerId?: string
  modelId?: string
  /** The model a provider observation named as serving the turn, which outranks the configured `modelId`. */
  servedModelId?: string
  nativeSessionId?: string
  observedAt?: number
  completedAt?: number
  settlement?: TurnUsageRevision["settlement"]
  status?: TurnUsageStatus
  quality: TurnUsageRevision["quality"]
  /** Each scope's running usage; `tokens` is their sum. */
  streams: Map<string, RuntimeTokenUsage>
  /** The last observation each scope applied, so a re-emitted one is not applied twice. */
  lastObservationKeys: Map<string, string>
  context?: TurnContext
}

function key(sessionId: string, messageId: string) {
  return `${sessionId}\u0000${messageId}`
}

function numberOrNull(input: unknown) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 ? input : null
}

function messageTokens(input: unknown): RuntimeTokenUsage | undefined {
  const row = jsonRecord(input)
  if (!row) return undefined
  const cache = jsonRecord(row.cache) ?? {}
  const tokens = {
    input: numberOrNull(row.input),
    output: numberOrNull(row.output),
    reasoning: numberOrNull(row.reasoning),
    cache: { read: numberOrNull(cache.read), write: numberOrNull(cache.write) },
  }
  // `buildAssistantMessage` starts every assistant row at zero tokens, so an
  // all-zero block is indistinguishable from a harness that reported no usage.
  // Treat it as unavailable unless a canonical session.usage observation exists.
  const values = [tokens.input, tokens.output, tokens.reasoning, tokens.cache.read, tokens.cache.write]
  return values.some((value) => value !== null && value > 0) ? tokens : undefined
}

export type TurnMeter = {
  start(): Promise<void>
  consume(event: AgentEventEnvelope): Promise<void>
  settle(input: {
    sessionId: string
    messageId: string
    status: Exclude<TurnUsageStatus, "running" | "completed" | "error">
  }): Promise<void>
  flush(): Promise<void>
}

export function createTurnMeter(input: {
  writer: UsageRevisionWriter
  reader?: Pick<UsageRevisionReader, "current">
  /** Where each turn's per-scope streams outlive the process. */
  state?: TurnMeterStateStore
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

  async function hydrate(fact: TurnUsageRevision) {
    const saved = await input.state?.load({ sessionId: fact.sessionId, messageId: fact.messageId })
    const streams = saved
      ? new Map(Object.entries(saved.streams))
      : new Map(fact.quality.knownCategories.length > 0 ? [["", fact.tokens]] : [])
    // Saved streams can hold an observation whose revision never landed, so
    // the turn's usage is their sum, and it is the provider's.
    const restored = saved !== undefined && streams.size > 0
    const hydrated: State = {
      sessionId: fact.sessionId,
      messageId: fact.messageId,
      revision: fact.revision,
      tokens: restored ? usageStreamsTotal(streams) : fact.tokens,
      hasUsage: fact.quality.knownCategories.length > 0 || restored,
      providerId: fact.providerId,
      modelId: fact.modelId,
      ...(fact.nativeSessionId ? { nativeSessionId: fact.nativeSessionId } : {}),
      observedAt: fact.observedAt,
      settlement: fact.settlement,
      status: fact.status,
      quality: restored ? { ...fact.quality, source: "provider" } : fact.quality,
      // With no saved state the fact's sum is all there is, filed as the
      // unscoped stream: a scoped observation replayed onto it is counted twice.
      streams,
      lastObservationKeys: saved
        ? new Map(Object.entries(saved.lastObservationKeys))
        : new Map(
            fact.quality.providerObservationKey
              ? [["", fact.quality.providerObservationKey]]
              : fact.quality.observationKind === "delta" && fact.quality.providerObservationId
                ? [["", `provider:${fact.quality.providerObservationId}`]]
                : [],
          ),
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
      const hydrated = await hydrate(fact)
      if (fact.settlement === "provisional") {
        activeBySession.set(fact.sessionId, fact.messageId)
        recover.push(hydrated)
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
      if (persisted) return await hydrate(persisted)
    }
    const created: State = {
      sessionId,
      messageId,
      revision: 0,
      tokens: unknownTokenUsage(),
      hasUsage: false,
      quality: { source: "lifecycle", knownCategories: [] },
      streams: new Map(),
      lastObservationKeys: new Map(),
    }
    states.set(id, created)
    return created
  }

  function savedState(current: State): TurnMeterState {
    return {
      streams: Object.fromEntries(current.streams),
      lastObservationKeys: Object.fromEntries(current.lastObservationKeys),
    }
  }

  async function persist(
    current: State,
    terminal?: { settlement: TurnUsageRevision["settlement"]; status: TurnUsageStatus; completedAt?: number },
  ) {
    let fact: TurnUsageRevision | undefined
    // Saved ahead of the revision: a restart between the two then restores an
    // observation the fact lacks, which the next revision carries, instead of
    // losing one the fact already counted.
    if (input.state && current.streams.size > 0) {
      await input.state
        .save({ sessionId: current.sessionId, messageId: current.messageId, state: savedState(current) })
        .catch((error: unknown) => input.onDegraded?.(error))
    }
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
        modelId: current.servedModelId ?? current.modelId ?? context.modelId ?? "unknown",
        ...((context.nativeSessionId ?? current.nativeSessionId)
          ? { nativeSessionId: context.nativeSessionId ?? current.nativeSessionId }
          : {}),
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        hostId: context.hostId,
        tokens: current.hasUsage ? current.tokens : unknownTokenUsage(),
        quality: {
          ...current.quality,
          knownCategories: current.hasUsage ? knownTokenCategories(current.tokens) : [],
        },
      }
      let result = await input.writer.writeRevision(fact, { owner: context.owner })
      if (result.status === "stale") {
        current.revision = result.currentRevision
        fact.revision = result.currentRevision + 1
        result = await input.writer.writeRevision(fact, { owner: context.owner })
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
          if (activeBySession.get(current.sessionId) === current.messageId) activeBySession.delete(current.sessionId)
          await input.onTerminal?.(fact)
        }
      } else {
        input.onDegraded?.(new Error(`usage revision ${fact.revision} remained stale after refresh`), fact)
      }
    } catch (error) {
      input.onDegraded?.(error, fact)
    }
  }

  async function consumeOne(event: AgentEventEnvelope) {
    await initialize()
    const sessionId = eventSessionId(event.payload)
    if (!sessionId) return
    if (event.payload.type === "session.usage") {
      const observation = event.payload.properties.observation
      const messageId = event.payload.properties.messageID
      if (!observation || !messageId) return
      const current = await state(sessionId, messageId)
      if (isRepeatedUsageObservation(current, observation)) return
      // Provider observations are canonical: tokens read off an assistant
      // message before the first of them are a fallback, not a stream.
      if (current.quality.source !== "provider") current.streams.clear()
      recordUsageObservation(current, observation)
      const signature = usageObservationKey(observation)
      current.tokens = usageStreamsTotal(current.streams)
      current.hasUsage = true
      current.observedAt = observation.observedAt ?? now()
      // The turn's own stream reports first; a child thread's or subagent's
      // later observation must not rename the thread the fact belongs to.
      current.nativeSessionId ??= observation.nativeSessionId
      current.servedModelId ??= observation.model
      current.quality = {
        source: "provider",
        observationKind: observation.kind,
        ...(observation.providerObservationId ? { providerObservationId: observation.providerObservationId } : {}),
        providerObservationKey: signature,
        knownCategories: knownTokenCategories(current.tokens),
      }
      const terminalSettlement = current.settlement
      if (!terminalSettlement || terminalSettlement === "provisional") activeBySession.set(sessionId, messageId)
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
      // A connected runtime may publish its authoritative token snapshot on the final
      // assistant update while representing terminality with `finish` followed by
      // `message.completed` rather than populating `time.completed`. Capture
      // usage whenever the provider supplies it; settlement remains owned by
      // the terminal lifecycle events below.
      if (tokens && current.quality.source !== "provider") {
        current.tokens = tokens
        current.hasUsage = true
        current.observedAt = typeof info.time?.completed === "number" ? info.time.completed : now()
        current.quality = { source: "provider-message", knownCategories: knownTokenCategories(tokens) }
      }
      const completedAt = info.time?.completed
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
