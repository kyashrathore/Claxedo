import { afterEach, describe, expect, test } from "bun:test"
import type {
  AgentAssistantMessage as AssistantMessage,
  AgentContentPart as Part,
  AgentUserMessage as UserMessage,
} from "@claxedo/agent-runtime-contract"
import { Timeline } from "./message-timeline.data"
import { TimelineRow } from "./timeline-row-model"
import { hydrateFirstFoldSessionPrefetch } from "../store/first-fold-hydration"
import { clearConversationChatRegistryForTest } from "../conversation/conversation-registry"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import {
  clearSessionPrefetchScope,
  getSessionPrefetch,
  SESSION_PREFETCH_TTL,
  setSessionPrefetch,
} from "@/platform/sync/session-prefetch"
import { readTimelineMountSnapshot, writeTimelineMountSnapshot } from "./timeline-mount-cache"

const SESSION = "ses_switch"
const SESSION_KEY = `${SESSION}:0`

function userMessage(id: string): UserMessage {
  return { id, sessionID: SESSION, role: "user", time: { created: 1_000 } }
}

function assistantMessage(id: string): AssistantMessage {
  return {
    id,
    sessionID: SESSION,
    role: "assistant",
    parentID: "u1",
    time: { created: 1_000, completed: 61_000 },
  } as AssistantMessage
}

function toolPart(id: string, messageID: string, tool: string): Part {
  return {
    id,
    sessionID: SESSION,
    messageID,
    type: "tool",
    tool,
    callID: `${id}_c`,
    state: { status: "completed", input: {}, output: "ok", time: { start: 1, end: 2 } },
  } as Part
}

function textPart(id: string, messageID: string, text: string): Part {
  return { id, sessionID: SESSION, messageID, type: "text", text } as Part
}

const USER = userMessage("u1")

// What the session's transcript holds once every message has landed: three
// assistant messages, three foldable groups.
const SETTLED_PARTS: Record<string, Part[]> = {
  u1: [],
  a1: [textPart("p1", "a1", "Looking at the rail."), toolPart("p2", "a1", "command"), toolPart("p3", "a1", "command")],
  a2: [toolPart("p4", "a2", "read_file"), toolPart("p5", "a2", "read_file")],
  a3: [textPart("p6", "a3", "Done."), toolPart("p7", "a3", "command")],
}
const SETTLED_MESSAGES = [assistantMessage("a1"), assistantMessage("a2"), assistantMessage("a3")]

// `splitSessionPrefetchPage` seeds a switched-to session with two messages — the
// owning user message and the tail assistant message — and hydrates the rest
// 900ms later (SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT,
// FIRST_FOLD_SESSION_BACKGROUND_HYDRATE_DELAY_MS). This is the surface the row
// builder sees on the switch's first paint.
const MOUNT_PARTS: Record<string, Part[]> = { u1: [], a3: SETTLED_PARTS.a3 }
const MOUNT_MESSAGES = [assistantMessage("a3")]

function rows(
  parts: Record<string, Part[]>,
  messages: AssistantMessage[],
  priorFoldableCount?: (userMessageID: string) => number | undefined,
) {
  return Timeline.constructMessageRows(
    USER,
    (messageID) => parts[messageID] ?? [],
    messages,
    0,
    false,
    "idle",
    false,
    false,
    () => undefined,
    true,
    undefined,
    undefined,
    priorFoldableCount,
  )
}

function keys(value: TimelineRow.TimelineRow[]) {
  return value.map((row) => TimelineRow.key(row))
}

function foldRow(value: TimelineRow.TimelineRow[]) {
  return value.find((row): row is TimelineRow.TurnFold => row._tag === "TurnFold")
}

function unmountWith(sessionKey: string, value: TimelineRow.TimelineRow[]) {
  writeTimelineMountSnapshot(sessionKey, { measurements: [], toolOpen: {}, groupOpen: {}, rows: value })
}

// The real producer caches the page, then the real seed hydrates the bounded
// surface out of it and withholds the rest.
function seedPrefetch(directory: string, page = {
  messages: [USER, ...SETTLED_MESSAGES],
  parts: Object.entries(SETTLED_PARTS).map(([id, part]) => ({ id, part })),
}) {
  seededDirectories.add(directory)
  setSessionPrefetch({ directory, sessionID: SESSION, limit: page.messages.length, complete: true, page })
  const prefetch = getSessionPrefetch(directory, SESSION)!
  hydrateFirstFoldSessionPrefetch({ directory, sessionID: SESSION, prefetch })
  return prefetch
}

function restoredCount(sessionKey: string) {
  const counts = readTimelineMountSnapshot(sessionKey)?.turnFoldableCounts
  return (userMessageID: string) => counts?.[userMessageID]
}

const seededDirectories = new Set<string>()

afterEach(() => {
  clearConversationChatRegistryForTest()
  for (const directory of seededDirectories) clearSessionPrefetchScope(directory, SESSION)
  seededDirectories.clear()
})

describe("timeline mount snapshot", () => {
  test("keeps the foldable count behind every fold row the visit rendered, per session", () => {
    unmountWith(SESSION_KEY, rows(SETTLED_PARTS, SETTLED_MESSAGES))

    expect(readTimelineMountSnapshot(SESSION_KEY)?.turnFoldableCounts).toEqual({ u1: 3 })
    expect(readTimelineMountSnapshot("ses_other:0")).toBeUndefined()
  })

  test("records nothing for a turn that had no fold row to restore", () => {
    unmountWith("ses_unfolded:0", rows(MOUNT_PARTS, MOUNT_MESSAGES))

    expect(readTimelineMountSnapshot("ses_unfolded:0")?.turnFoldableCounts).toEqual({})
  })

  test("keeps the count of a turn that scrolled out of the rendered window", () => {
    unmountWith("ses_window:0", rows(SETTLED_PARTS, SETTLED_MESSAGES))
    unmountWith("ses_window:0", [])

    expect(readTimelineMountSnapshot("ses_window:0")?.turnFoldableCounts).toEqual({ u1: 3 })
  })

  test("a snapshot written without rows still loads", () => {
    writeTimelineMountSnapshot("ses_legacy:0", { measurements: [], toolOpen: {}, groupOpen: {} })

    const snapshot = readTimelineMountSnapshot("ses_legacy:0")
    expect(snapshot?.toolOpen).toEqual({})
    expect(snapshot?.turnFoldableCounts).toBeUndefined()
  })
})

describe("switching back to a session folds before the first paint", () => {
  test("the bounded mount surface alone cannot decide the fold", () => {
    expect(foldRow(rows(MOUNT_PARTS, MOUNT_MESSAGES))).toBeUndefined()
  })

  test("the fold row the last visit rendered is on screen from the first row build", () => {
    unmountWith(SESSION_KEY, rows(SETTLED_PARTS, SETTLED_MESSAGES))
    const firstPaint = rows(MOUNT_PARTS, MOUNT_MESSAGES, restoredCount(SESSION_KEY))

    expect(foldRow(firstPaint)?.folded).toBe(true)
    expect(foldRow(firstPaint)?.foldCount).toBe(3)
  })

  test("no row on screen at the first paint is taken away when the deferred messages land", () => {
    unmountWith(SESSION_KEY, rows(SETTLED_PARTS, SETTLED_MESSAGES))
    const firstPaint = keys(rows(MOUNT_PARTS, MOUNT_MESSAGES, restoredCount(SESSION_KEY)))
    const landed = keys(rows(SETTLED_PARTS, SETTLED_MESSAGES, restoredCount(SESSION_KEY)))

    expect(firstPaint).toEqual(["user-message:u1", "turn-fold:u1", "assistant-part:u1:part:a3:p6"])
    expect(landed).toEqual([
      "user-message:u1",
      "turn-fold:u1",
      "assistant-part:u1:part:a1:p1",
      "assistant-part:u1:part:a3:p6",
    ])
    expect(firstPaint.filter((key) => !landed.includes(key))).toEqual([])
  })

  test("without the last visit's count the switch hides a row the reader was already given", () => {
    const firstPaint = keys(rows(MOUNT_PARTS, MOUNT_MESSAGES))
    const landed = keys(rows(SETTLED_PARTS, SETTLED_MESSAGES))

    expect(firstPaint).toContain("assistant-part:u1:part:a3:p7")
    expect(landed).not.toContain("assistant-part:u1:part:a3:p7")
  })

  test("a first visit folds from the surface the seed withheld, with no snapshot to restore", () => {
    const directory = "/repo/cold"
    seedPrefetch(directory)
    const paneKey = sessionViewKey({ directory, sessionId: SESSION })
    const seeded = readTimelineMountSnapshot(paneKey)
    const firstPaint = rows(MOUNT_PARTS, MOUNT_MESSAGES, (id) => seeded?.turnFoldableCounts?.[id])

    expect(seeded?.measurements).toEqual([])
    expect(foldRow(firstPaint)?.folded).toBe(true)
    expect(foldRow(firstPaint)?.foldCount).toBe(3)
    expect(keys(firstPaint)).toEqual(["user-message:u1", "turn-fold:u1", "assistant-part:u1:part:a3:p6"])
  })

  test("another session's seeded page never answers for this pane", () => {
    seedPrefetch("/repo/elsewhere")

    expect(readTimelineMountSnapshot(sessionViewKey({ directory: "/repo/here", sessionId: SESSION })))
      .toBeUndefined()
  })

  test("a seeded page past its lifetime no longer decides the fold", () => {
    const directory = "/repo/stale"
    const page = {
      messages: [USER, ...SETTLED_MESSAGES],
      parts: Object.entries(SETTLED_PARTS).map(([id, part]) => ({ id, part })),
    }
    seededDirectories.add(directory)
    setSessionPrefetch({
      directory,
      sessionID: SESSION,
      limit: page.messages.length,
      complete: true,
      at: Date.now() - SESSION_PREFETCH_TTL - 1,
      page,
    })

    expect(readTimelineMountSnapshot(sessionViewKey({ directory, sessionId: SESSION }))).toBeUndefined()
  })

  test("the count a visit rendered wins over the seed's floor", () => {
    const directory = "/repo/both"
    seedPrefetch(directory)
    const paneKey = sessionViewKey({ directory, sessionId: SESSION })
    writeTimelineMountSnapshot(paneKey, {
      measurements: [],
      toolOpen: {},
      groupOpen: {},
      rows: [TimelineRow.TurnFold({ userMessageID: "u1", foldCount: 7, folded: true })],
    })

    expect(readTimelineMountSnapshot(paneKey)?.turnFoldableCounts).toEqual({ u1: 7 })
  })

  test("the seeded count is a floor: reasoning parts count as the default hides them", () => {
    const directory = "/repo/reasoning"
    const assistant = assistantMessage("a9")
    seedPrefetch(directory, {
      messages: [USER, assistant],
      parts: [{
        id: "a9",
        part: [
          toolPart("r1", "a9", "command"),
          { id: "r2", sessionID: SESSION, messageID: "a9", type: "reasoning", text: "weighing it" } as Part,
          toolPart("r3", "a9", "command"),
        ],
      }],
    })

    expect(readTimelineMountSnapshot(sessionViewKey({ directory, sessionId: SESSION }))?.turnFoldableCounts)
      .toEqual({ u1: 1 })
  })

  test("an explicit unfold still wins over the restored count", () => {
    unmountWith(SESSION_KEY, rows(SETTLED_PARTS, SETTLED_MESSAGES))
    const unfolded = Timeline.constructMessageRows(
      USER,
      (messageID) => MOUNT_PARTS[messageID] ?? [],
      MOUNT_MESSAGES,
      0,
      false,
      "idle",
      false,
      false,
      () => false,
      true,
      undefined,
      undefined,
      restoredCount(SESSION_KEY),
    )

    expect(foldRow(unfolded)?.folded).toBe(false)
    expect(keys(unfolded)).toContain("assistant-part:u1:part:a3:p7")
  })
})
