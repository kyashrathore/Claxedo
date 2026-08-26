import { safeStartIndex } from "./safe-slice"

const TRIM_SLACK_BYTES = 256 * 1024

export type ReplayBuffer = {
  chunks: string[]
  length: number
}

export function createReplayBuffer(seed = ""): ReplayBuffer {
  return { chunks: seed ? [seed] : [], length: seed.length }
}

/**
 * Appends without rebuilding the retained transcript for every small PTY read.
 * Trimming is amortized and still begins at a terminal escape-safe boundary.
 * Returns the exact number of code units removed from the head.
 */
export function appendReplayBuffer(buffer: ReplayBuffer, data: string, limit: number) {
  if (!data) return 0
  buffer.chunks.push(data)
  buffer.length += data.length
  if (buffer.length <= limit + TRIM_SLACK_BYTES) return 0
  const joined = buffer.chunks.join("")
  const cut = safeStartIndex(joined, joined.length - limit)
  const retained = joined.slice(cut)
  buffer.chunks = retained ? [retained] : []
  buffer.length = retained.length
  return cut
}

export function replayBufferSlice(buffer: ReplayBuffer, offset = 0) {
  if (offset >= buffer.length) return ""
  if (buffer.chunks.length === 1) return buffer.chunks[0]!.slice(Math.max(0, offset))
  return buffer.chunks.join("").slice(Math.max(0, offset))
}

export function replayBufferTail(buffer: ReplayBuffer, cap: number) {
  if (buffer.length <= cap) return replayBufferSlice(buffer)
  return replayBufferSlice(buffer, buffer.length - cap)
}
