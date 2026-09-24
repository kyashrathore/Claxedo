export const MAX_PENDING_BYTES = 128 * 1024 * 1024
export const MAX_STREAM_BYTES = 128 * 1024 * 1024
export const MAX_BATCH_BYTES = 4 * 1024 * 1024
export const MAX_BATCH_ITEMS = 8192
export const MAX_DROPPED_CHUNKS = 1_000_000

type Stream = { items: string[]; bytes: number; dropped: number }

const encoder = new TextEncoder()

function utf8Bytes(data: string): number {
  return encoder.encode(data).byteLength
}

function tailWithin(data: string, maxBytes: number): { value: string; bytes: number; trimmed: boolean } {
  const bytes = utf8Bytes(data)
  if (bytes <= maxBytes) return { value: data, bytes, trimmed: false }
  let kept = 0
  const suffix: string[] = []
  for (const char of Array.from(data).reverse()) {
    const size = utf8Bytes(char)
    if (kept + size > maxBytes) break
    suffix.push(char)
    kept += size
  }
  return { value: suffix.reverse().join(""), bytes: kept, trimmed: true }
}

function push(stream: Stream, data: string, maxBytes: number): void {
  const next = tailWithin(data, maxBytes)
  if (next.trimmed) stream.dropped += 1
  if (!next.value) return
  stream.items.push(next.value)
  stream.bytes += next.bytes
  while (stream.bytes > maxBytes && stream.items.length > 1) {
    const evicted = stream.items.shift()
    if (!evicted) break
    stream.bytes -= utf8Bytes(evicted)
    stream.dropped += 1
  }
}

function take(stream: Stream, maxBytes: number, maxItems: number): string {
  let bytes = 0
  let count = 0
  let out = ""
  while (stream.items.length > 0 && count < maxItems) {
    const next = stream.items[0]
    const size = utf8Bytes(next)
    if (count > 0 && bytes + size > maxBytes) break
    stream.items.shift()
    stream.bytes -= size
    out += next
    bytes += size
    count += 1
    if (bytes >= maxBytes) break
  }
  return out
}

function emptyStream(): Stream {
  return { items: [], bytes: 0, dropped: 0 }
}

export type WriteQueue = {
  readonly beginRestore: () => void
  readonly push: (data: string) => void
  readonly flushPending: () => void
  readonly dispose: () => void
}

export function createWriteQueue(input: {
  write: (chunk: string, done: () => void) => void
  onOverload: (dropped: number) => void
}): WriteQueue {
  let live = emptyStream()
  let pending = emptyStream()
  let restored = false
  let frame = 0
  let writing = false
  let overloaded = false

  const drain = () => {
    frame = 0
    if (overloaded || writing) return
    const chunk = take(live, MAX_BATCH_BYTES, MAX_BATCH_ITEMS)
    if (!chunk) return
    writing = true
    input.write(chunk, () => {
      writing = false
      if (live.items.length > 0) schedule()
    })
  }

  const schedule = () => {
    if (overloaded || frame || writing) return
    frame = requestAnimationFrame(drain)
  }

  const overload = (dropped: number) => {
    overloaded = true
    input.onOverload(dropped)
  }

  const enqueueLive = (data: string) => {
    if (overloaded) return
    push(live, data, MAX_STREAM_BYTES)
    if (live.dropped >= MAX_DROPPED_CHUNKS) {
      overload(live.dropped)
      return
    }
    schedule()
  }

  return {
    beginRestore: () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      restored = false
      live = emptyStream()
      pending = emptyStream()
    },
    push: (data) => {
      if (restored) {
        enqueueLive(data)
        return
      }
      push(pending, data, MAX_PENDING_BYTES)
      if (pending.dropped >= MAX_DROPPED_CHUNKS) overload(pending.dropped)
    },
    flushPending: () => {
      if (restored) return
      restored = true
      for (const chunk of pending.items) enqueueLive(chunk)
      pending = emptyStream()
    },
    dispose: () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      overloaded = true
      live = emptyStream()
      pending = emptyStream()
    },
  }
}
