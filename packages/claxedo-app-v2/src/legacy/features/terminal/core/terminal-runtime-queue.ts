import { createStream, pushStream, takeStream } from "./terminal-stream"

export type QueueKind = "pending" | "live"

export function createTerminalRuntimeQueue(input: {
  maxPendingBytes: number
  maxStreamBytes: number
  maxBatchBytes: number
  maxBatchItems: number
  maxDroppedChunks: number
  requestFrame: (cb: () => void) => number
  cancelFrame: (id: number) => void
  write: (chunk: string, done: () => void) => void
  onOverload: (kind: QueueKind, dropped: number) => void
  onThrottled?: (dropped: number) => void
}) {
  const stream = createStream()
  const pending = createStream()
  let restored = false
  let frame = 0
  let writing = false
  let reported = false
  let overloaded = false

  const schedule = () => {
    if (overloaded) return
    if (frame) return
    if (writing) return
    frame = input.requestFrame(drain)
  }

  const enqueueLive = (data: string) => {
    if (overloaded) return
    pushStream(stream, data, input.maxStreamBytes)
    if (stream.dropped > 0 && !reported) {
      reported = true
      input.onThrottled?.(stream.dropped)
    }
    if (stream.dropped >= input.maxDroppedChunks) {
      overloaded = true
      input.onOverload("live", stream.dropped)
      return
    }
    schedule()
  }

  const drain = () => {
    frame = 0
    if (overloaded) return
    if (writing) return
    const chunk = takeStream(stream, input.maxBatchBytes, input.maxBatchItems)
    if (!chunk) return
    writing = true
    let done = false
    const complete = () => {
      if (done) return
      done = true
      writing = false
      if (stream.items.length > 0) schedule()
    }
    input.write(chunk, complete)
  }

  return {
    beginRestore() {
      if (frame) input.cancelFrame(frame)
      frame = 0
      restored = false
      stream.items = []
      stream.bytes = 0
      pending.items = []
      pending.bytes = 0
    },
    push(data: string) {
      if (restored) {
        enqueueLive(data)
        return
      }
      pushStream(pending, data, input.maxPendingBytes)
      if (pending.dropped >= input.maxDroppedChunks) {
        overloaded = true
        input.onOverload("pending", pending.dropped)
      }
    },
    flushPending() {
      if (restored) return
      restored = true
      if (pending.items.length === 0) return
      for (const chunk of pending.items) {
        enqueueLive(chunk)
      }
      pending.items = []
      pending.bytes = 0
    },
    pendingCount() {
      return pending.items.length
    },
    dispose() {
      if (frame) input.cancelFrame(frame)
      frame = 0
      pending.items = []
      pending.bytes = 0
      overloaded = true
    },
  }
}
