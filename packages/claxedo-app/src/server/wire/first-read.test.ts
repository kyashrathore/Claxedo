/// <reference types="bun" />
import { expect, test } from "bun:test"
import { firstReadFromWire } from "./first-read"
import { viewportQuery } from "./turn-page"

const session = { id: "ses_1" }
const message = (id: string, role: "user" | "assistant") => ({ info: { id, role, sessionID: "ses_1" }, parts: [] })

test("first read wire: outline turns keep their ids, times, title and prompt snippet; a malformed turn is dropped", () => {
  const read = firstReadFromWire({
    session,
    outline: {
      turns: [{ id: "msg_1", createdAt: 10, title: "First", user: "why?" }, { id: "msg_2", createdAt: "soon" }, { createdAt: 30 }, null],
      complete: false,
    },
  })
  expect(read).toEqual({
    session,
    outline: {
      turns: [
        { id: "msg_1", createdAt: 10, title: "First", preview: { user: "why?" } },
        { id: "msg_2", createdAt: 0, preview: {} },
      ],
      complete: false,
    },
  })
})

test("first read wire: a body without its session or a list of outline turns is a server error", () => {
  expect(() => firstReadFromWire({ outline: { turns: [], complete: true } })).toThrow("The first read answered without its session")
  expect(() => firstReadFromWire({ session, outline: { complete: true } })).toThrow("The turn outline is not a list of turns")
  expect(() => firstReadFromWire({ session, outline: { turns: [], complete: true }, page: {} })).toThrow("The page is not a list of turns")
})

test("first read wire: a page lands oldest first, pages back from its first turn, and its newest turn is the latest turn a reader keeps", () => {
  const read = firstReadFromWire({
    session,
    outline: { turns: [], complete: false },
    page: {
      turns: [
        { messages: [message("u1", "user"), message("a1", "assistant")], cursor: "at-u1" },
        { messages: [message("u2", "user"), message("a2", "assistant")], cursor: "at-u2" },
        { messages: [message("u3", "user"), message("a3", "assistant")], cursor: "at-u3" },
      ],
    },
  })
  expect(read.page?.transcript.entries.map((entry) => entry.info.id)).toEqual(["u1", "a1", "u2", "a2", "u3", "a3"])
  expect(read.page?.transcript.olderCursor).toBe("at-u1")
  expect(read.page?.latestTurn).toEqual({ entries: [message("u3", "user"), message("a3", "assistant")], olderCursor: "at-u3" })
})

test("first read wire: a session's only turn is its latest turn and pages back to nothing", () => {
  const read = firstReadFromWire({ session, outline: { turns: [], complete: true }, page: { turns: [{ messages: [message("u1", "user"), message("a1", "assistant")] }] } })
  expect(read.page?.latestTurn).toEqual({ entries: [message("u1", "user"), message("a1", "assistant")] })
  expect(read.page?.transcript.olderCursor).toBeUndefined()
})

test("first read wire: the viewport query names every extent", () => {
  expect(viewportQuery({ rows: 40, cols: 100, reasoning: true, shell: false, edit: true })).toEqual({ rows: "40", cols: "100", reasoning: "1", shell: "0", edit: "1" })
})
