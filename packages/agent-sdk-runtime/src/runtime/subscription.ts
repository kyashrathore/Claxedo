import type { AgentRuntimeEventEnvelope, AgentRuntimeSubscribeInput } from "../runtime"

export type RuntimeSubscriber = {
  input: AgentRuntimeSubscribeInput
  push(event: AgentRuntimeEventEnvelope): void
  close(): void
}

export function createRuntimeSubscription(
  subscribers: Set<RuntimeSubscriber>,
  input: AgentRuntimeSubscribeInput,
  bufferSize: number,
): AsyncIterable<AgentRuntimeEventEnvelope> {
  if (!Number.isInteger(bufferSize) || bufferSize < 1) throw new Error("subscriberBufferSize must be a positive integer")
  const queue: AgentRuntimeEventEnvelope[] = []
  const resolvers: Array<(result: IteratorResult<AgentRuntimeEventEnvelope>) => void> = []
  let closed = false
  let overflowed = false

  const finish = () => {
    closed = true
    subscribers.delete(subscriber)
    for (const resolve of resolvers.splice(0)) resolve({ done: true, value: undefined })
  }
  const subscriber: RuntimeSubscriber = {
    input,
    push(event) {
      if (closed || overflowed) return
      const resolve = resolvers.shift()
      if (resolve) {
        resolve({ done: false, value: event })
        return
      }
      if (queue.length >= bufferSize) {
        queue.splice(0)
        queue.push(overflowNotice(event, bufferSize))
        overflowed = true
        return
      }
      queue.push(event)
    },
    close: finish,
  }
  subscribers.add(subscriber)

  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<AgentRuntimeEventEnvelope>> {
          const value = queue.shift()
          if (value) {
            if (overflowed && queue.length === 0) finish()
            return Promise.resolve({ done: false, value })
          }
          if (closed) return Promise.resolve({ done: true, value: undefined })
          return new Promise((resolve) => resolvers.push(resolve))
        },
        return(): Promise<IteratorResult<AgentRuntimeEventEnvelope>> {
          finish()
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}

function overflowNotice(event: AgentRuntimeEventEnvelope, bufferSize: number): AgentRuntimeEventEnvelope {
  return {
    sessionId: event.sessionId,
    directory: event.directory,
    payload: {
      type: "harness-notice",
      code: "runtime.subscription_overflow",
      message: "Runtime event subscriber exceeded its buffer; reopen the stream and replay from the durable store",
      severity: "warn",
      details: { bufferSize },
    },
  }
}
