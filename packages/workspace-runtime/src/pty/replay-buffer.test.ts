import { describe, expect, test } from "bun:test"
import { appendReplayBuffer, createReplayBuffer, replayBufferSlice, replayBufferTail } from "./replay-buffer"

describe("PTY replay buffer", () => {
  test("preserves FIFO reads without rebuilding the buffer contract", () => {
    const buffer = createReplayBuffer("before")
    expect(appendReplayBuffer(buffer, "-middle", 1024)).toBe(0)
    expect(appendReplayBuffer(buffer, "-after", 1024)).toBe(0)
    expect(replayBufferSlice(buffer)).toBe("before-middle-after")
    expect(replayBufferSlice(buffer, 7)).toBe("middle-after")
    expect(replayBufferTail(buffer, 5)).toBe("after")
  })

  test("amortizes trimming and reports the exact absolute-cursor advance", () => {
    const limit = 1024
    const buffer = createReplayBuffer()
    let removed = 0
    const input = "x".repeat(300 * 1024)
    removed += appendReplayBuffer(buffer, input, limit)
    expect(buffer.length).toBeLessThanOrEqual(limit)
    expect(removed + buffer.length).toBe(input.length)
    expect(replayBufferSlice(buffer)).toBe(input.slice(removed))
  })
})
