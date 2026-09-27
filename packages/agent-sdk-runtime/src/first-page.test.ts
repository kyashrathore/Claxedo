import { describe, expect, test } from "bun:test"
import type { AgentContentPart, AgentMessage } from "./index"
import {
  FIRST_PAGE_BYTE_CAP,
  FIRST_PAGE_TURN_CAP,
  FirstPageQueryError,
  estimateTurnLines,
  firstPageTurn,
  parseFirstPageQuery,
  readFirstPage,
  readFirstRead,
  type FirstPageTurn,
  type TurnRead,
} from "./first-page"

let ids = 0
const nextId = (prefix: string) => `${prefix}-${String(++ids).padStart(4, "0")}`

function user(id: string, text: string): AgentMessage {
  return {
    info: { id, sessionID: "s", role: "user", time: { created: 1_000 }, agent: "build" },
    parts: [{ id: `${id}-text`, sessionID: "s", messageID: id, type: "text", text }],
  }
}

function assistant(parentID: string, parts: AgentContentPart[], state: { completed?: number; error?: string } = { completed: 5_000 }): AgentMessage {
  const id = nextId("assistant")
  return {
    info: {
      id,
      sessionID: "s",
      role: "assistant",
      parentID,
      time: { created: 2_000, ...(state.completed === undefined ? {} : { completed: state.completed }) },
      ...(state.error ? { error: { name: state.error, data: { message: state.error } } } : {}),
      mode: "build",
      agent: "build",
      path: { cwd: "/w", root: "/w" },
      cost: 0.01,
      tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: parts.map((part) => ({ ...part, messageID: id })),
  }
}

const text = (value: string): AgentContentPart => ({ id: nextId("text"), sessionID: "s", messageID: "", type: "text", text: value })
const reasoning = (value: string): AgentContentPart => ({ id: nextId("reasoning"), sessionID: "s", messageID: "", type: "reasoning", text: value, time: { start: 1 } })
const file = (): AgentContentPart => ({ id: nextId("file"), sessionID: "s", messageID: "", type: "file", mime: "image/png", url: "data:image/png;base64,AA" })
const tool = (name: string, output = "ok"): AgentContentPart => ({
  id: nextId("tool"),
  sessionID: "s",
  messageID: "",
  type: "tool",
  callID: nextId("call"),
  tool: name,
  state: { status: "completed", input: { command: "ls" }, output, title: name, metadata: {}, time: { start: 1, end: 2 } },
})

function workedTurn(prompt: string, answer: string): AgentMessage[] {
  const id = nextId("user")
  return [user(id, prompt), assistant(id, [text("Looking."), tool("bash"), tool("read")]), assistant(id, [text(answer)])]
}

function turnReader(turnsOldestFirst: AgentMessage[][]) {
  const cursorOf = (index: number) => `cursor-${index}`
  const calls: (string | undefined)[] = []
  const read: TurnRead = (before) => {
    calls.push(before)
    const end = before === undefined ? turnsOldestFirst.length : Number(before.slice("cursor-".length))
    const index = end - 1
    const turn = turnsOldestFirst[index]
    if (!turn) return { messages: [] }
    return { messages: turn, ...(index > 0 ? { nextCursor: cursorOf(index) } : {}) }
  }
  return { read, calls }
}

const drawnTexts = (turn: FirstPageTurn) =>
  turn.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))

describe("firstPageTurn", () => {
  test("a settled turn that folds is its user message, every assistant envelope, and only the parts the fold leaves drawn", () => {
    const turn = workedTurn("Fix the build", "Done: the build passes.")
    const page = firstPageTurn(turn, { reasoning: false })
    expect(page.foldableCount).toBe(3)
    expect(page.messages.map((message) => message.info.id)).toEqual(turn.map((message) => message.info.id))
    expect(drawnTexts(page)).toEqual(["Fix the build", "Done: the build passes."])
    expect(page.messages[1]?.parts).toEqual([])
  })

  test("a part the fold never hides stays drawn, and the answer is the turn's last text even when a later message has none", () => {
    const id = nextId("user")
    const image = file()
    const turn = [user(id, "Draw it"), assistant(id, [text("Working."), tool("bash"), text("Here it is."), image]), assistant(id, [tool("bash")])]
    const page = firstPageTurn(turn, { reasoning: false })
    expect(page.foldableCount).toBe(3)
    expect(page.messages[1]?.parts.map((part) => part.id)).toEqual([turn[1].parts[2].id, image.id])
    expect(page.messages[2]?.parts).toEqual([])
  })

  test("a turn below the fold minimum, a busy turn, an interrupted turn and a failed turn are drawn whole", () => {
    const id = nextId("user")
    const short = [user(id, "Hi"), assistant(id, [text("Hello.")])]
    expect(firstPageTurn(short, { reasoning: false })).toEqual({ messages: short })

    const busy = workedTurn("Go", "Still going")
    busy[2] = assistant(busy[0].info.id, busy[2].parts, {})
    expect(firstPageTurn(busy, { reasoning: false })).toEqual({ messages: busy })

    const aborted = workedTurn("Go", "Stopped")
    aborted[2] = assistant(aborted[0].info.id, aborted[2].parts, { completed: 6_000, error: "MessageAbortedError" })
    expect(firstPageTurn(aborted, { reasoning: false })).toEqual({ messages: aborted })

    const failed = workedTurn("Go", "Broke")
    failed[2] = assistant(failed[0].info.id, failed[2].parts, { completed: 6_000, error: "APIError" })
    expect(firstPageTurn(failed, { reasoning: false })).toEqual({ messages: failed })

    const cancelled = workedTurn("Go", "Cancelled")
    expect(firstPageTurn(cancelled, { reasoning: false, cancelledAssistantMessageId: cancelled[2].info.id })).toEqual({ messages: cancelled })
  })

  test("reasoning counts toward the fold only when the reader shows it", () => {
    const id = nextId("user")
    const turn = [user(id, "Think"), assistant(id, [text("First."), reasoning("Weighing it."), text("Answer.")])]
    expect(firstPageTurn(turn, { reasoning: false }).foldableCount).toBeUndefined()
    expect(firstPageTurn(turn, { reasoning: true }).foldableCount).toBe(2)
  })
})

describe("estimateTurnLines", () => {
  const folded = (prompt: string, answer: string) => firstPageTurn(workedTurn(prompt, answer), { reasoning: false })

  test("a folded one-line exchange is its chrome, the prompt, the fold row and the answer", () => {
    expect(estimateTurnLines(folded("Fix the build", "Done."), 100)).toBe(3 + 1 + 2 + 1)
  })

  test("prose wraps at the column width, the prompt at the user bubble's width, and blank lines take no line", () => {
    const prompt = "p".repeat(90)
    const answer = `${"a".repeat(250)}\n\n${"b".repeat(100)}\n- one\n- two`
    expect(estimateTurnLines(folded(prompt, answer), 100)).toBe(3 + 2 + 2 + (3 + 1 + 1 + 1))
  })

  test("a fenced block counts every code line once and adds its frame", () => {
    const code = Array.from({ length: 12 }, (_, index) => `const value${index} = ${"x".repeat(150)}`).join("\n")
    const answer = `Here is the change:\n\n\`\`\`ts\n${code}\n\`\`\`\nThat is all.`
    expect(estimateTurnLines(folded("Show me", answer), 100)).toBe(3 + 1 + 2 + (1 + 2 + 12 + 1))
  })

  test("a whole turn draws a row for every tool group and wraps every text", () => {
    const id = nextId("user")
    const whole = firstPageTurn([user(id, "Hi"), assistant(id, [tool("bash"), text("Hello.")])], { reasoning: false })
    expect(whole.foldableCount).toBeUndefined()
    expect(estimateTurnLines(whole, 100)).toBe(3 + 1 + 2 + 1)
  })
})

describe("readFirstPage", () => {
  test("walks back from the newest turn until the estimate covers the viewport and one more screen", async () => {
    const turns = Array.from({ length: 10 }, (_, index) => workedTurn(`Prompt ${index}`, `Answer ${index}.`))
    const reader = turnReader(turns)
    const page = await readFirstPage(reader.read, { rows: 10, cols: 100, reasoning: false })
    expect(page.turns.map((turn) => drawnTexts(turn)[0])).toEqual(["Prompt 7", "Prompt 8", "Prompt 9"])
    expect(page.turns.map((turn) => turn.cursor)).toEqual(["cursor-7", "cursor-8", "cursor-9"])
    expect(reader.calls).toEqual([undefined, "cursor-9", "cursor-8"])
  })

  test("a session shorter than the fill is read whole, and its first turn carries no cursor", async () => {
    const turns = [workedTurn("Only", "One.")]
    const page = await readFirstPage(turnReader(turns).read, { rows: 40, cols: 100, reasoning: false })
    expect(page.turns).toHaveLength(1)
    expect(page.turns[0]?.cursor).toBeUndefined()
  })

  test("stops at the turn cap on a session of one-line turns", async () => {
    const turns = Array.from({ length: FIRST_PAGE_TURN_CAP + 5 }, (_, index) => workedTurn(`P${index}`, `A${index}`))
    const page = await readFirstPage(turnReader(turns).read, { rows: 10_000, cols: 100, reasoning: false })
    expect(page.turns).toHaveLength(FIRST_PAGE_TURN_CAP)
  })

  test("stops once the page reaches the byte cap and never trims the turn that crossed it", async () => {
    const huge = "z".repeat(FIRST_PAGE_BYTE_CAP)
    const turns = [workedTurn("Older", "Older answer."), workedTurn("Big", huge), workedTurn("Newest", "Short.")]
    const page = await readFirstPage(turnReader(turns).read, { rows: 10_000, cols: 100, reasoning: false })
    expect(page.turns.map((turn) => drawnTexts(turn)[0])).toEqual(["Big", "Newest"])
    expect(drawnTexts(page.turns[0])[1]).toBe(huge)
  })

  test("an empty session has an empty page", async () => {
    const page = await readFirstPage(turnReader([]).read, { rows: 40, cols: 100, reasoning: false })
    expect(page).toEqual({ turns: [] })
  })
})

describe("parseFirstPageQuery", () => {
  const query = (search: string) => {
    const params = new URLSearchParams(search)
    return (name: string) => params.get(name) ?? undefined
  }

  test("a read naming none of rows, cols and reasoning asks for no page", () => {
    expect(parseFirstPageQuery(query("workspaceId=ws_1"))).toBeUndefined()
  })

  test("a read naming all three asks for the page its viewport draws", () => {
    expect(parseFirstPageQuery(query("rows=40&cols=2000&reasoning=1"))).toEqual({ rows: 40, cols: 2000, reasoning: true })
    expect(parseFirstPageQuery(query("rows=1&cols=1&reasoning=0"))).toEqual({ rows: 1, cols: 1, reasoning: false })
  })

  test("a read naming some of them, or one out of range, is refused", () => {
    for (const search of ["rows=10&cols=100", "rows=10&reasoning=0", "cols=100", "rows=0&cols=100&reasoning=0", "rows=10&cols=2001&reasoning=1", "rows=1.5&cols=100&reasoning=0", "rows=10&cols=100&reasoning=yes"]) {
      expect(() => parseFirstPageQuery(query(search)), search).toThrow(FirstPageQueryError)
    }
  })
})

describe("readFirstRead", () => {
  const outline = { turns: [{ id: "u", createdAt: 1 }], complete: true }

  test("answers the row and the outline, and reads no page unless one is asked for", async () => {
    const reader = turnReader([workedTurn("Only", "One.")])
    expect(await readFirstRead({ id: "s" }, outline, reader.read, undefined)).toEqual({ session: { id: "s" }, outline })
    expect(reader.calls).toEqual([])
  })

  test("carries the first page its request asks for", async () => {
    const turns = [workedTurn("Only", "One.")]
    const read = await readFirstRead({ id: "s" }, outline, turnReader(turns).read, { rows: 40, cols: 100, reasoning: false })
    expect(read).toEqual({ session: { id: "s" }, outline, page: await readFirstPage(turnReader(turns).read, { rows: 40, cols: 100, reasoning: false }) })
  })
})
