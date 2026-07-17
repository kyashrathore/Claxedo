import { describe, expect, test } from "bun:test"
import { createSelectionTransform } from "./selection-transform"

describe("createSelectionTransform", () => {
  test("sends only the selected text and returns the replacement", async () => {
    const calls: unknown[] = []
    const transform = createSelectionTransform({
      sessionId: () => "session_1",
      client: {
        session: {
          prompt: async (input) => {
            calls.push(input)
            return { data: { parts: [{ type: "text", text: "Clear sentence." }] } }
          },
        },
      },
    })

    expect(await transform("improve", "Sentence needing work.")).toBe("Clear sentence.")
    expect(JSON.stringify(calls)).toContain("Sentence needing work.")
    expect(JSON.stringify(calls)).not.toContain("whole document")
  })

  test("requires an adjacent session", async () => {
    const transform = createSelectionTransform({
      sessionId: () => undefined,
      client: { session: { prompt: async () => ({}) } },
    })
    await expect(transform("fix", "Text")).rejects.toThrow("Open a session")
  })
})
