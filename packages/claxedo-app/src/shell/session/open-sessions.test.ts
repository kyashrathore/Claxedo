import { afterEach, describe, expect, test } from "bun:test"
import { clearOpenSessions, hasOpenSession, openSessionRefsFromMetas, setOpenSessions } from "./open-sessions"

afterEach(() => {
  clearOpenSessions()
})

describe("open session registry", () => {
  test("tracks valid open session refs by session id", () => {
    setOpenSessions([
      { directory: "/tmp/ws", sessionId: "ses_live" },
      { directory: "/tmp/ws", sessionId: "new" },
      { directory: "", sessionId: "ses_without_directory" },
      { directory: "/tmp/ws", sessionId: "" },
    ])

    expect(hasOpenSession("ses_live")).toBe(true)
    expect(hasOpenSession("new")).toBe(false)
    expect(hasOpenSession("ses_without_directory")).toBe(true)
    expect(hasOpenSession("")).toBe(false)
  })

  test("replaces previous refs on each update", () => {
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_old" }])
    setOpenSessions([{ directory: "/tmp/ws", sessionId: "ses_new" }])

    expect(hasOpenSession("ses_old")).toBe(false)
    expect(hasOpenSession("ses_new")).toBe(true)
  })

  test("does not split the same open session by directory", () => {
    setOpenSessions([{ directory: "/tmp/a", sessionId: "ses_shared" }])

    expect(hasOpenSession("ses_shared")).toBe(true)
  })

  test("derives mounted session refs from workbench content metadata", () => {
    expect(openSessionRefsFromMetas([
      { type: "session", sessionId: "ses_direct", directory: "/repo" },
      { type: "context", content: { sessionId: "ses_context", directory: "/repo" } },
      { type: "terminal", sessionId: "ses_terminal", directory: "/repo" },
      { type: "session", sessionId: "new", directory: "/repo" },
    ])).toEqual([
      { sessionId: "ses_direct", directory: "/repo" },
      { sessionId: "ses_context", directory: "/repo" },
      { sessionId: "new", directory: "/repo" },
    ])
  })
})
