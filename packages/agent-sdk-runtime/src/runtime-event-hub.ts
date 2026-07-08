import type { CompatEnvelope } from "./compat-events"
import {
  AGENT_RUNTIME_EVENT_CONTRACT_VERSION,
  type AgentRuntimeEvent,
} from "@claxedo/agent-event-runtime"

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

export type RuntimeEventHub = {
  publishGlobal(event: CompatEnvelope): void
  subscribeGlobal(fn: Subscriber): () => void
  publishRuntime(event: RuntimeEventEnvelopeInput): void
  subscribeRuntime(fn: RuntimeSubscriber): () => void
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
  return {
    publishGlobal(event) {
      publish(subscribers, event)
    },
    subscribeGlobal(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    publishRuntime(event) {
      publish(runtimeSubscribers, runtimeEventEnvelope(event))
    },
    subscribeRuntime(fn) {
      runtimeSubscribers.add(fn)
      return () => runtimeSubscribers.delete(fn)
    },
  }
}
