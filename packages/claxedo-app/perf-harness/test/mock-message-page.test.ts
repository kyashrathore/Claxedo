import { describe, expect, test } from "bun:test"
import {
  MOCK_MESSAGE_PAGE_DEFAULT_LIMIT,
  MockMessagePageError,
  parseMockMessagePageRequest,
  projectMockSurfacePage,
  selectMockMessagePage,
  type MockMessagePageRequest,
} from "../src/mock-message-page"

// The synthetic transcript the mock generates: ids `msg_perf_<index>`, roles
// alternating user/assistant from index 0.
const messageID = (index: number) => `msg_perf_${index}`
const indexOfMessageID = (id: string) => {
  if (!id.startsWith("msg_perf_")) return undefined
  const value = Number(id.slice("msg_perf_".length))
  return Number.isInteger(value) && value >= 0 ? value : undefined
}
const role = (index: number) => (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant"

const select = (request: MockMessagePageRequest, total = 800) =>
  selectMockMessagePage({ request, total, messageID, indexOfMessageID, role })

const parse = (search: string) => parseMockMessagePageRequest(new URL(`http://mock/session/s/message${search}`).searchParams)

describe("mock message page request parsing", () => {
  test("accepts the two semantic views alone", () => {
    expect(parse("?view=latest-surface")).toEqual({ view: "latest-surface" })
    expect(parse("?view=latest-turn")).toEqual({ view: "latest-turn" })
  })

  test("rejects a view combined with limit or before, exactly like the product servers", () => {
    expect(() => parse("?view=latest-surface&limit=2")).toThrow(MockMessagePageError)
    expect(() => parse("?view=latest-surface&before=msg_perf_10")).toThrow(MockMessagePageError)
    expect(() => parse("?view=everything")).toThrow(MockMessagePageError)
  })

  test("rejects before without limit and out-of-range limits", () => {
    expect(() => parse("?before=msg_perf_10")).toThrow(MockMessagePageError)
    expect(() => parse("?limit=0")).toThrow(MockMessagePageError)
    expect(() => parse("?limit=501")).toThrow(MockMessagePageError)
    expect(() => parse("?limit=abc")).toThrow(MockMessagePageError)
  })

  test("an unparameterised read is a numeric page with no explicit limit", () => {
    expect(parse("")).toEqual({})
    expect(select({}).indexes.length).toBe(MOCK_MESSAGE_PAGE_DEFAULT_LIMIT)
  })
})

describe("latest-surface is a bounded first-paint fragment", () => {
  test("returns only the owning user and the final message", () => {
    const page = select({ view: "latest-surface" })
    expect(page.indexes).toEqual([798, 799])
    expect(page.surface).toBe(true)
  })

  test("its cursor points at the final message so paging restores the intermediates", () => {
    const surface = select({ view: "latest-surface" })
    expect(surface.cursor).toBe("msg_perf_799")
    const older = select({ limit: 200, before: surface.cursor! })
    expect(older.indexes.at(-1)).toBe(798)
    expect(older.indexes.at(0)).toBe(599)
    expect(older.cursor).toBe("msg_perf_599")
  })

  test("a lone trailing user message is its own surface", () => {
    const page = selectMockMessagePage({
      request: { view: "latest-surface" },
      total: 799, // last index 798 -> a user message
      messageID,
      indexOfMessageID,
      role,
    })
    expect(page.indexes).toEqual([798])
  })

  test("the whole transcript in one page reports no cursor", () => {
    const page = selectMockMessagePage({
      request: { view: "latest-surface" },
      total: 1,
      messageID,
      indexOfMessageID,
      role,
    })
    expect(page.indexes).toEqual([0])
    expect(page.cursor).toBeUndefined()
  })
})

describe("latest-turn is the complete latest turn", () => {
  test("spans the owning user through the newest message", () => {
    const alwaysAssistantAfterBoundary = (index: number) => (index === 790 ? "user" : "assistant") as "user" | "assistant"
    const page = selectMockMessagePage({
      request: { view: "latest-turn" },
      total: 800,
      messageID,
      indexOfMessageID,
      role: alwaysAssistantAfterBoundary,
    })
    expect(page.indexes.at(0)).toBe(790)
    expect(page.indexes.at(-1)).toBe(799)
    expect(page.surface).toBe(false)
    expect(page.cursor).toBe("msg_perf_790")
  })
})

describe("numeric paging", () => {
  test("walks strictly older than the cursor and stops at the transcript head", () => {
    let cursor: string | undefined = undefined
    let first = select({ limit: 500 })
    expect(first.indexes.at(0)).toBe(300)
    expect(first.indexes.at(-1)).toBe(799)
    cursor = first.cursor
    expect(cursor).toBe("msg_perf_300")
    const second = select({ limit: 500, before: cursor! })
    expect(second.indexes.at(0)).toBe(0)
    expect(second.indexes.at(-1)).toBe(299)
    expect(second.cursor).toBeUndefined()
  })

  test("rejects a cursor this transcript never produced", () => {
    expect(() => select({ limit: 10, before: "not_a_cursor" })).toThrow(MockMessagePageError)
  })

  test("an empty transcript is an empty page", () => {
    expect(selectMockMessagePage({ request: { view: "latest-surface" }, total: 0, messageID, indexOfMessageID, role }))
      .toEqual({ indexes: [], surface: false })
  })
})

describe("the surface projection", () => {
  test("drops non-text parts and the omitted user envelope fields", () => {
    const projected = projectMockSurfacePage<
      { type: string; text?: string },
      { info: Record<string, unknown>; parts: Array<{ type: string; text?: string }> }
    >([
      {
        info: { id: "msg_perf_798", role: "user", summary: "s", system: ["x"], tools: {}, agent: "build" },
        parts: [{ type: "text", text: "hello" }],
      },
      {
        info: { id: "msg_perf_799", role: "assistant" },
        parts: [{ type: "tool" }, { type: "text", text: "world" }],
      },
    ])
    expect(projected[0]!.info).toEqual({ id: "msg_perf_798", role: "user", agent: "build" })
    expect(projected[0]!.parts).toEqual([{ type: "text", text: "hello" }])
    expect(projected[1]!.parts).toEqual([{ type: "text", text: "world" }])
  })

  test("omits an oversized text part whole rather than truncating it", () => {
    const projected = projectMockSurfacePage([
      {
        info: { id: "msg_perf_799", role: "assistant" },
        parts: [{ type: "text", text: "x".repeat(49 * 1024) }, { type: "text", text: "kept" }],
      },
    ])
    expect(projected[0]!.parts).toEqual([{ type: "text", text: "kept" }])
  })

  test("keeps at most the newest-priority bounded set of text parts", () => {
    const parts = Array.from({ length: 20 }, (_, index) => ({ type: "text" as const, text: `part ${index}` }))
    const projected = projectMockSurfacePage([{ info: { id: "msg_perf_799", role: "assistant" }, parts }])
    expect(projected[0]!.parts.length).toBe(16)
    // Newest-priority selection, restored to canonical order.
    expect(projected[0]!.parts.at(-1)).toEqual({ type: "text", text: "part 19" })
    expect(projected[0]!.parts.at(0)).toEqual({ type: "text", text: "part 4" })
  })
})
