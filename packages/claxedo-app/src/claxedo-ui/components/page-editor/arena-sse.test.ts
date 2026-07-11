import { describe, expect, test } from "bun:test"
import { createArenaSseParser, extractSseData } from "./arena-sse"

// Pure SSE framing for the Arena stream: chunk-boundary-agnostic, emits whole
// `data:` payloads only when a frame is complete.

describe("extractSseData", () => {
  test("strips the data: prefix and one leading space", () => {
    expect(extractSseData("data: {\"a\":1}")).toBe('{"a":1}')
  })

  test("joins multi-line data frames with newlines", () => {
    expect(extractSseData("data: line1\ndata: line2")).toBe("line1\nline2")
  })

  test("drops non-data lines (event:, comments, blanks)", () => {
    expect(extractSseData("event: arena.message\ndata: payload\n: keep-alive")).toBe("payload")
  })

  test("a frame with no data lines yields an empty string", () => {
    expect(extractSseData("event: arena.heartbeat")).toBe("")
  })
})

describe("createArenaSseParser", () => {
  test("emits one payload per complete frame in a single chunk", () => {
    const parser = createArenaSseParser()
    expect(parser.push("data: one\n\ndata: two\n\n")).toEqual(["one", "two"])
  })

  test("buffers a partial trailing frame until a later chunk completes it", () => {
    const parser = createArenaSseParser()
    expect(parser.push("data: hel")).toEqual([]) // no frame boundary yet
    expect(parser.push("lo\n\n")).toEqual(["hello"])
  })

  test("reassembles a frame boundary split across chunk reads", () => {
    const parser = createArenaSseParser()
    expect(parser.push("data: first\n")).toEqual([]) // only one newline so far
    expect(parser.push("\ndata: second\n\n")).toEqual(["first", "second"])
  })

  test("drops heartbeat/empty frames but keeps real payloads that follow", () => {
    const parser = createArenaSseParser()
    expect(parser.push("event: arena.heartbeat\n\ndata: real\n\n")).toEqual(["real"])
  })

  test("does not re-emit a payload once its frame has been consumed", () => {
    const parser = createArenaSseParser()
    parser.push("data: once\n\n")
    expect(parser.push("data: twice\n\n")).toEqual(["twice"])
  })
})
