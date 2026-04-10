import { describe, expect, test } from "bun:test"
import { translateEventToChunk } from "./translate-event-to-chunk"

describe("translateEventToChunk", () => {
  test("preserves recovering session status", () => {
    expect(
      translateEventToChunk({
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "recovering",
            kind: "process_restart",
            message: "Recovering ACP client...",
          },
        },
      }, { partKinds: {} }),
    ).toEqual([{ type: "session-status", status: "recovering" }])
  })

  test("maps retry session status to UI error", () => {
    expect(
      translateEventToChunk({
        type: "session.status",
        properties: {
          sessionID: "s1",
          status: {
            type: "retry",
            attempt: 2,
            message: "rate limited",
            next: 123,
          },
        },
      }, { partKinds: {} }),
    ).toEqual([{ type: "session-status", status: "error" }])
  })
})
