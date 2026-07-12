import { describe, expect, test } from "bun:test"
import { GLOBAL_SESSION_PAGE_SIZE, paginateSessions } from "./session-pagination"

describe("paginateSessions", () => {
  const sessions = Array.from({ length: 7 }, (_, index) => ({
    id: `ses-${index + 1}`,
    time: { updated: index + 1 },
  }))

  test("returns the five newest sessions by default and exposes a load-more cursor", () => {
    const page = paginateSessions(sessions, {})

    expect(page.sessions.map((session) => session.id)).toEqual([
      "ses-7",
      "ses-6",
      "ses-5",
      "ses-4",
      "ses-3",
    ])
    expect(page.total).toBe(7)
    expect(page.hasMore).toBe(true)
    expect(page.nextCursor).toBe(GLOBAL_SESSION_PAGE_SIZE)
  })

  test("loads the next page without repeating earlier sessions", () => {
    const page = paginateSessions(sessions, { cursor: GLOBAL_SESSION_PAGE_SIZE })

    expect(page.sessions.map((session) => session.id)).toEqual(["ses-2", "ses-1"])
    expect(page.total).toBe(7)
    expect(page.hasMore).toBe(false)
    expect(page.nextCursor).toBeUndefined()
  })
})
