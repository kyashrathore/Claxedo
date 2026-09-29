import { describe, expect, test } from "bun:test"
import { toolPartHeader } from "./tool-header"
import type { AgentContentPart, AgentMessage } from "./content"
import {
  TURN_PAGE_BYTE_CAP,
  TURN_PAGE_TURN_CAP,
  TurnPageQueryError,
  estimateTurnLines,
  parseOlderTurnPageQuery,
  parseTurnPageQuery,
  projectTurn,
  readFirstRead,
  readTurnPage,
  type PageTurn,
  type TurnRead,
} from "./turn-page"

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

function workedTurn(prompt: string, answer: string): [AgentMessage, AgentMessage, AgentMessage] {
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

const settings = { reasoning: false, shell: false, edit: false }
const viewport = (rows: number) => ({ ...settings, rows, cols: 100 })

const drawnTexts = (turn: PageTurn) =>
  turn.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])))

describe("projectTurn", () => {
  test("every turn is sent with every part, each tool its header, whether or not the reader folds it", () => {
    const id = nextId("user")
    const short = [user(id, "Hi"), assistant(id, [text("Hello.")])]
    const busy = workedTurn("Go", "Still going")
    busy[2] = assistant(busy[0].info.id, busy[2].parts, {})
    for (const turn of [workedTurn("Fix the build", "Done."), short, busy]) {
      expect(projectTurn(turn, settings)).toEqual({
        messages: turn.map((message) => ({ ...message, parts: message.parts.map((part) => (part.type === "tool" ? toolPartHeader(part) : part)) })),
      })
    }
  })
})

describe("estimateTurnLines", () => {
  const request = { cols: 100, reasoning: false }

  test("a folded one-line exchange is its chrome, the prompt, the fold row and the answer", () => {
    expect(estimateTurnLines(workedTurn("Fix the build", "Done."), request)).toBe(3 + 1 + 2 + 1)
  })

  test("prose wraps at the column width, the prompt at the user bubble's width, and blank lines take no line", () => {
    const prompt = "p".repeat(90)
    const answer = `${"a".repeat(250)}\n\n${"b".repeat(100)}\n- one\n- two`
    expect(estimateTurnLines(workedTurn(prompt, answer), request)).toBe(3 + 2 + 2 + (3 + 1 + 1 + 1))
  })

  test("a fenced block counts every code line once and adds its frame", () => {
    const code = Array.from({ length: 12 }, (_, index) => `const value${index} = ${"x".repeat(150)}`).join("\n")
    const answer = `Here is the change:\n\n\`\`\`ts\n${code}\n\`\`\`\nThat is all.`
    expect(estimateTurnLines(workedTurn("Show me", answer), request)).toBe(3 + 1 + 2 + (1 + 2 + 12 + 1))
  })

  test("a turn that does not fold draws a row for every tool group and wraps every text", () => {
    const id = nextId("user")
    expect(estimateTurnLines([user(id, "Hi"), assistant(id, [tool("bash"), text("Hello.")])], request)).toBe(3 + 1 + 2 + 1)
  })

  test("a busy, interrupted, failed or cancelled turn is drawn whole, with no fold row", () => {
    const whole = 3 + 1 + (1 + 2 + 2 + 1)
    const busy = workedTurn("Go", "Still going")
    busy[2] = assistant(busy[0].info.id, busy[2].parts, {})
    const aborted = workedTurn("Go", "Stopped")
    aborted[2] = assistant(aborted[0].info.id, aborted[2].parts, { completed: 6_000, error: "MessageAbortedError" })
    const failed = workedTurn("Go", "Broke")
    failed[2] = assistant(failed[0].info.id, failed[2].parts, { completed: 6_000, error: "APIError" })
    const cancelled = workedTurn("Go", "Cancelled")
    expect(estimateTurnLines(busy, request)).toBe(whole)
    expect(estimateTurnLines(aborted, request)).toBe(whole)
    expect(estimateTurnLines(failed, request)).toBe(whole)
    expect(estimateTurnLines(cancelled, { ...request, cancelledAssistantMessageId: cancelled[2].info.id })).toBe(whole)
  })

  test("reasoning takes a row only when the reader shows it", () => {
    const id = nextId("user")
    const turn = [user(id, "Think"), assistant(id, [reasoning("Weighing it."), reasoning("And this."), text("Answer.")])]
    expect(estimateTurnLines(turn, request)).toBe(3 + 1 + 1)
    expect(estimateTurnLines(turn, { ...request, reasoning: true })).toBe(3 + 1 + 2 + 1)
  })

  test("a part the fold never hides stays drawn under the fold row", () => {
    const id = nextId("user")
    const turn = [user(id, "Draw it"), assistant(id, [text("Working."), tool("bash"), text("Here it is."), file()]), assistant(id, [tool("bash")])]
    expect(estimateTurnLines(turn, request)).toBe(3 + 1 + 2 + (1 + 2))
  })
})

describe("readTurnPage", () => {
  test("walks back from the newest turn until the estimate covers the viewport and two more screens", async () => {
    const turns = Array.from({ length: 10 }, (_, index) => workedTurn(`Prompt ${index}`, `Answer ${index}.`))
    const reader = turnReader(turns)
    const page = await readTurnPage(reader.read, viewport(10))
    expect(page.turns.map((turn) => drawnTexts(turn)[0])).toEqual(["Prompt 5", "Prompt 6", "Prompt 7", "Prompt 8", "Prompt 9"])
    expect(page.turns.map((turn) => turn.cursor)).toEqual(["cursor-5", "cursor-6", "cursor-7", "cursor-8", "cursor-9"])
    expect(reader.calls).toEqual([undefined, "cursor-9", "cursor-8", "cursor-7", "cursor-6"])
  })

  test("a session shorter than the fill is read whole, and its first turn carries no cursor", async () => {
    const turns = [workedTurn("Only", "One.")]
    const page = await readTurnPage(turnReader(turns).read, viewport(40))
    expect(page.turns).toHaveLength(1)
    expect(page.turns[0]?.cursor).toBeUndefined()
  })

  test("stops at the turn cap on a session of one-line turns", async () => {
    const turns = Array.from({ length: TURN_PAGE_TURN_CAP + 5 }, (_, index) => workedTurn(`P${index}`, `A${index}`))
    const page = await readTurnPage(turnReader(turns).read, viewport(10_000))
    expect(page.turns).toHaveLength(TURN_PAGE_TURN_CAP)
  })

  test("a cold read stops once the page reaches the byte cap and never trims the turn that crossed it", async () => {
    const huge = "z".repeat(TURN_PAGE_BYTE_CAP)
    const turns = [workedTurn("Older", "Older answer."), workedTurn("Big", huge), workedTurn("Newest", "Short.")]
    const page = await readTurnPage(turnReader(turns).read, viewport(10_000))
    expect(page.turns.map((turn) => drawnTexts(turn)[0])).toEqual(["Big", "Newest"])
    const [big] = page.turns
    expect(big && drawnTexts(big).at(-1)).toBe(huge)
  })

  test("a read before a cursor has no byte cap, so it pages past a large turn until the viewport fills", async () => {
    const huge = "z".repeat(TURN_PAGE_BYTE_CAP)
    const turns = [workedTurn("Oldest", "Oldest answer."), workedTurn("Big", huge), workedTurn("Newest", "Short.")]
    const page = await readTurnPage(turnReader(turns).read, { ...viewport(10_000), before: "cursor-2" })
    expect(page.turns.map((turn) => drawnTexts(turn)[0])).toEqual(["Oldest", "Big"])
  })

  test("an empty session has an empty page", async () => {
    const page = await readTurnPage(turnReader([]).read, viewport(40))
    expect(page).toEqual({ turns: [] })
  })
})

describe("parseTurnPageQuery", () => {
  const query = (search: string) => {
    const params = new URLSearchParams(search)
    return (name: string) => params.get(name) ?? undefined
  }

  test("a read naming none of rows, cols, reasoning, shell and edit asks for no page", () => {
    expect(parseTurnPageQuery(query("workspaceId=ws_1"))).toBeUndefined()
  })

  test("a read naming all five asks for the page its viewport and settings draw", () => {
    expect(parseTurnPageQuery(query("rows=40&cols=2000&reasoning=1&shell=0&edit=1"))).toEqual({ rows: 40, cols: 2000, reasoning: true, shell: false, edit: true })
    expect(parseTurnPageQuery(query("rows=1&cols=1&reasoning=0&shell=1&edit=0"))).toEqual({ rows: 1, cols: 1, reasoning: false, shell: true, edit: false })
  })

  test("a read naming some of them, or one out of range, is refused", () => {
    const settled = "&shell=0&edit=0"
    for (const search of ["rows=10&cols=100", "rows=10&reasoning=0", "cols=100", "shell=1", "rows=10&cols=100&reasoning=0", `rows=0&cols=100&reasoning=0${settled}`, `rows=10&cols=2001&reasoning=1${settled}`, `rows=1.5&cols=100&reasoning=0${settled}`, `rows=10&cols=100&reasoning=yes${settled}`, "rows=10&cols=100&reasoning=0&shell=2&edit=0"]) {
      expect(() => parseTurnPageQuery(query(search)), search).toThrow(TurnPageQueryError)
    }
  })
})

describe("parseOlderTurnPageQuery", () => {
  const query = (search: string) => {
    const params = new URLSearchParams(search)
    return (name: string) => params.get(name) ?? undefined
  }
  const viewport = "rows=40&cols=100&reasoning=0&shell=1&edit=0"

  test("an older page's read names all five page parameters and the cursor it reads before", () => {
    expect(parseOlderTurnPageQuery(query(`${viewport}&before=cursor-1`))).toEqual({ rows: 40, cols: 100, reasoning: false, shell: true, edit: false, before: "cursor-1" })
  })

  test("a read without its cursor, with an empty one, or without its page parameters is refused", () => {
    for (const search of [viewport, `${viewport}&before=`, "before=cursor-1", "rows=40&cols=100&before=cursor-1"]) {
      expect(() => parseOlderTurnPageQuery(query(search)), search).toThrow(TurnPageQueryError)
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
    const read = await readFirstRead({ id: "s" }, outline, turnReader(turns).read, viewport(40))
    expect(read).toEqual({ session: { id: "s" }, outline, page: await readTurnPage(turnReader(turns).read, viewport(40)) })
  })
})

describe("tool bodies stay off every page", () => {
  const request = viewport(40)
  const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
  const answeredWith = (output: string) => {
    const id = nextId("user")
    return [user(id, "Run it"), assistant(id, [tool("bash", output), text("It ran.")])]
  }

  test("a latest turn that does not fold sends its tool as a header, so the page does not grow with the tool's output", async () => {
    const small = await readTurnPage(turnReader([answeredWith("x".repeat(1024))]).read, request)
    const large = await readTurnPage(turnReader([answeredWith("x".repeat(1024 * 1024))]).read, request)
    expect(bytes(large)).toBe(bytes(small))
  })

  test("a page read before a cursor starts at the turn before it and does not grow with a tool's output", async () => {
    const older = (output: string) => [workedTurn("First", "One."), answeredWith(output), workedTurn("Newest", "Three.")]
    const small = await readTurnPage(turnReader(older("x".repeat(1024))).read, { ...request, before: "cursor-2" })
    const large = await readTurnPage(turnReader(older("x".repeat(1024 * 1024))).read, { ...request, before: "cursor-2" })
    expect(small.turns.map((turn) => drawnTexts(turn)[0])).toEqual(["First", "Run it"])
    expect(bytes(large)).toBe(bytes(small))
  })
})

describe("tool parts on a page", () => {
  test("a tool the reader's settings open rides whole, and every other tool is its header", () => {
    const id = nextId("user")
    const turn = [user(id, "Change it"), assistant(id, [tool("bash", "listing"), tool("edit", "diff"), text("Changed.")])]
    const tools = (page: PageTurn) => page.messages.flatMap((message) => message.parts.flatMap((part) => (part.type === "tool" ? [[part.tool, part.headerOnly === true, part.state.status === "completed" ? part.state.output : ""]] : [])))
    expect(tools(projectTurn(turn, settings))).toEqual([["bash", true, ""], ["edit", true, ""]])
    expect(tools(projectTurn(turn, { ...settings, shell: true }))).toEqual([["bash", false, "listing"], ["edit", true, ""]])
    expect(tools(projectTurn(turn, { ...settings, edit: true }))).toEqual([["bash", true, ""], ["edit", false, "diff"]])
  })
})
