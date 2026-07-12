import { describe, expect, test } from "bun:test"
import { capChunk, createStream, pushStream, takeStream } from "./terminal-stream"

describe("terminal stream", () => {
  test("pushStream trims single oversized chunk to max bytes", () => {
    const stream = createStream()
    pushStream(stream, "a".repeat(10), 4)
    expect(stream.items).toEqual(["aaaa"])
    expect(stream.bytes).toBe(4)
    expect(stream.dropped).toBe(1)
  })

  test("pushStream caps backlog by dropping oldest chunks", () => {
    const stream = createStream()
    pushStream(stream, "aaaa", 6)
    pushStream(stream, "bbbb", 6)
    pushStream(stream, "cccc", 6)
    expect(stream.items).toEqual(["cccc"])
    expect(stream.bytes).toBe(4)
    expect(stream.dropped).toBe(2)
  })

  test("takeStream batches by bytes and item limits", () => {
    const stream = createStream()
    pushStream(stream, "aa", 100)
    pushStream(stream, "bb", 100)
    pushStream(stream, "cc", 100)

    const out1 = takeStream(stream, 4, 10)
    expect(out1).toBe("aabb")
    expect(stream.items).toEqual(["cc"])

    const out2 = takeStream(stream, 10, 1)
    expect(out2).toBe("cc")
    expect(stream.items).toEqual([])
  })

  test("takeStream splits a single oversized item without dropping the tail", () => {
    const stream = createStream()
    pushStream(stream, "abcdef", 100)

    expect(takeStream(stream, 4, 10)).toBe("abcd")
    expect(stream.items).toEqual(["ef"])
    expect(stream.bytes).toBe(2)
    expect(takeStream(stream, 4, 10)).toBe("ef")
  })

  test("takeStream does not exceed max bytes for a leading unicode code point", () => {
    const stream = createStream()
    pushStream(stream, "🙂b", 100)

    expect(takeStream(stream, 3, 10)).toBe("")
    expect(stream.items).toEqual(["🙂b"])
    expect(stream.bytes).toBe(5)

    expect(takeStream(stream, 4, 10)).toBe("🙂")
    expect(stream.items).toEqual(["b"])
    expect(stream.bytes).toBe(1)
  })

  test("capChunk does not split a unicode code point", () => {
    expect(capChunk("🙂", 1)).toMatchObject({ value: "", bytes: 0, trimmed: true })
    expect(capChunk("🙂", 4)).toMatchObject({ value: "🙂", bytes: 4, trimmed: false })
  })

  test("pushStream counts utf8 bytes rather than utf16 code units", () => {
    const stream = createStream()
    pushStream(stream, "🙂", 4)

    expect(stream.items).toEqual(["🙂"])
    expect(stream.bytes).toBe(4)
  })
})
