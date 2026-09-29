import type { CompatEnvelope } from "@claxedo/agent-sdk-runtime/compat-events"
import { AGENT_RUNTIME_EVENT_CONTRACT_VERSION, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { createSessionOrder, type SessionSlot } from "./session-order"

type Subscriber = (event: CompatEnvelope) => void
type RuntimeSubscriber = (event: RuntimeEventEnvelope) => void

export type RuntimeEventEnvelope = {
  contractVersion: typeof AGENT_RUNTIME_EVENT_CONTRACT_VERSION
  directory: string
  sessionId: string
  agentSessionId?: string
  assistantMessageId?: string
  payload: AgentRuntimeEvent
}

export type RuntimeEventEnvelopeInput = Omit<RuntimeEventEnvelope, "contractVersion"> & {
  contractVersion?: number
}

/**
 * Function properties, not methods: the hub is a closure over its subscriber
 * sets, so callers pass `publishRuntime` around as a plain callback and no
 * member ever reads `this`.
 */
export type RuntimeEventHub = {
  publishGlobal: (event: CompatEnvelope) => void
  subscribeGlobal: (fn: Subscriber) => () => void
  publishRuntime: (event: RuntimeEventEnvelopeInput) => void
  subscribeRuntime: (fn: RuntimeSubscriber) => () => void
  /** Holds the session's later frames until the slot closes; see `SessionSlot`. */
  openSlot: (sessionId: string, turnMessageId: string) => SessionSlot
  /** Delivers a session frame published outside the hub in the same order as the hub's own. */
  sequence: (sessionId: string, send: () => void) => void
}

export type RuntimeEventPublishers = Pick<RuntimeEventHub, "publishGlobal" | "publishRuntime">

export function runtimeEventEnvelope(input: RuntimeEventEnvelopeInput): RuntimeEventEnvelope {
  if (input.contractVersion !== undefined && input.contractVersion !== AGENT_RUNTIME_EVENT_CONTRACT_VERSION) {
    throw new Error(`unsupported runtime event contract version: ${input.contractVersion}`)
  }
  return {
    ...input,
    contractVersion: AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
  }
}

export function createRuntimeEventHub(): RuntimeEventHub {
  const subscribers = new Set<Subscriber>()
  const runtimeSubscribers = new Set<RuntimeSubscriber>()
  const publish = <T>(items: Set<(event: T) => void>, event: T) => {
    for (const sub of items) {
      try {
        sub(event)
      } catch (err) {
        console.error("runtime event subscriber failed", err)
      }
    }
  }
  const order = createSessionOrder()
  return {
    publishGlobal(event) {
      order.global(event, () => publish(subscribers, event))
    },
    subscribeGlobal(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    publishRuntime(event) {
      const envelope = runtimeEventEnvelope(event)
      order.runtime(envelope, () => publish(runtimeSubscribers, envelope))
    },
    subscribeRuntime(fn) {
      runtimeSubscribers.add(fn)
      return () => runtimeSubscribers.delete(fn)
    },
    openSlot: (sessionId, turnMessageId) => order.open(sessionId, turnMessageId, (event) => publish(subscribers, event)),
    sequence: order.sequence,
  }
}
