import { describe, expect, test } from "bun:test"
import { sessionMessageScrollTop, sessionMessageTopMargin } from "./session-message-scroll-position"

describe("sessionMessageScrollTop", () => {
  test("places the message below the app and sticky timeline headers with breathing room", () => {
    const rootTop = 49
    const stickyBottom = 113
    const targetTop = 600
    const currentScrollTop = 200
    const next = sessionMessageScrollTop({ currentScrollTop, rootTop, stickyBottom, targetTop })

    const targetAfterScroll = targetTop - (next - currentScrollTop)
    expect(targetAfterScroll).toBe(stickyBottom + sessionMessageTopMargin)
  })

  test("does not request a negative scroll near the start of the conversation", () => {
    expect(
      sessionMessageScrollTop({
        currentScrollTop: 0,
        rootTop: 49,
        stickyBottom: 113,
        targetTop: 100,
      }),
    ).toBe(0)
  })
})
