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

type WriteQueueInput = {
  write: (chunk: string, done: () => void) => void
  onOverload: (dropped: number) => void
}

type WriteQueueState = {
  readonly input: WriteQueueInput
  live: Stream
  pending: Stream
  restored: boolean
  frame: number
  writing: boolean
  overloaded: boolean
}

function drain(state: WriteQueueState): void {
  state.frame = 0
  if (state.overloaded || state.writing) return
  const chunk = take(state.live, MAX_BATCH_BYTES, MAX_BATCH_ITEMS)
  if (!chunk) return
  state.writing = true
  state.input.write(chunk, () => {
    state.writing = false
    if (state.live.items.length > 0) schedule(state)
  })
}

function schedule(state: WriteQueueState): void {
  if (state.overloaded || state.frame || state.writing) return
  state.frame = requestAnimationFrame(() => drain(state))
}

function cancelFrame(state: WriteQueueState): void {
  if (state.frame) cancelAnimationFrame(state.frame)
  state.frame = 0
}

function overload(state: WriteQueueState, dropped: number): void {
  state.overloaded = true
  state.input.onOverload(dropped)
}

function enqueueLive(state: WriteQueueState, data: string): void {
  if (state.overloaded) return
  push(state.live, data, MAX_STREAM_BYTES)
  if (state.live.dropped >= MAX_DROPPED_CHUNKS) {
    overload(state, state.live.dropped)
    return
  }
  schedule(state)
}

function enqueue(state: WriteQueueState, data: string): void {
  if (state.restored) {
    enqueueLive(state, data)
    return
  }
  push(state.pending, data, MAX_PENDING_BYTES)
  if (state.pending.dropped >= MAX_DROPPED_CHUNKS) overload(state, state.pending.dropped)
}

function beginRestore(state: WriteQueueState): void {
  cancelFrame(state)
  state.restored = false
  state.live = emptyStream()
  state.pending = emptyStream()
}

function flushPending(state: WriteQueueState): void {
  if (state.restored) return
  state.restored = true
  for (const chunk of state.pending.items) enqueueLive(state, chunk)
  state.pending = emptyStream()
}

function dispose(state: WriteQueueState): void {
  cancelFrame(state)
  state.overloaded = true
  state.live = emptyStream()
  state.pending = emptyStream()
}

export function createWriteQueue(input: WriteQueueInput): WriteQueue {
  const state: WriteQueueState = {
    input,
    live: emptyStream(),
    pending: emptyStream(),
    restored: false,
    frame: 0,
    writing: false,
    overloaded: false,
  }
  return {
    beginRestore: () => beginRestore(state),
    push: (data) => enqueue(state, data),
    flushPending: () => flushPending(state),
    dispose: () => dispose(state),
  }
}
