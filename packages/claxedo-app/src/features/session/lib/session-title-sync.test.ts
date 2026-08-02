import { describe, expect, test } from "bun:test"
import { sessionTitleFromSources, sessionTitleSignature } from "./session-title-sync"

describe("session title sync", () => {
  test("includes title changes in the reactive signature", () => {
    expect(sessionTitleSignature({ id: "ses_1", title: "First prompt title" })).toBe("ses_1:First prompt title")
    expect(sessionTitleSignature({ id: "ses_1", title: "AI generated title" })).not.toBe(
      sessionTitleSignature({ id: "ses_1", title: "First prompt title" }),
    )
  })

  test("prefers directory cache titles for mounted workspace sessions", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_1",
      directory: "/repo",
      directorySessions: () => [{ id: "ses_1", title: "Generated from first message" }],
      inventory: {
        global: [{ id: "ses_1", title: "Older inventory title" }],
      },
    })).toBe("Generated from first message")
  })

  test("falls back to inventory titles for resumed mounted sessions", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_2",
      directory: "/repo",
      directorySessions: () => [],
      inventory: {
        byWorkspace: {
          "/repo": {
            sessions: [{ id: "ses_2", title: "Resume generated title" }],
          },
        },
      },
    })).toBe("Resume generated title")
  })

  test("returns undefined for empty placeholder titles", () => {
    expect(sessionTitleFromSources({
      sessionId: "ses_empty",
      inventory: {
        global: [{ id: "ses_empty", title: "   " }],
      },
    })).toBeUndefined()
  })
})
