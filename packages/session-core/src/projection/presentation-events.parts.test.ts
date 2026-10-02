import { describe, expect, it } from "bun:test"
import { buildUserPromptParts } from "./presentation-events"

describe("buildUserPromptParts", () => {
  it("records a pasted image as the file part the composer sent, not a serialized string", () => {
    const [part] = buildUserPromptParts("ses_1", "msg_1", [
      { type: "file", mime: "image/png", filename: "image.png", url: "data:image/png;base64,iVBORw0KGgo=" },
    ])
    expect(part).toEqual({
      id: "msg_1-part-0",
      sessionID: "ses_1",
      messageID: "msg_1",
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    })
  })

  it("mints every part's id from the message id and keeps an @file context part's source", () => {
    const parts = buildUserPromptParts("ses_1", "msg_1", [
      { type: "text", text: "look at this" },
      {
        type: "file",
        mime: "text/plain",
        filename: "a.ts",
        url: "file:///repo/a.ts?start=1&end=3",
        source: { type: "file", path: "/repo/a.ts", text: { value: "const a = 1", start: 1, end: 3 } },
      },
      { type: "agent", name: "reviewer" },
    ])
    expect(parts.map((part) => [part.id, part.type])).toEqual([
      ["msg_1-part-0", "text"],
      ["msg_1-part-1", "file"],
      ["msg_1-part-2", "agent"],
    ])
    expect(parts[1]).toMatchObject({ source: { type: "file", path: "/repo/a.ts" } })
    expect(parts.some((part) => part.type === "text" && part.synthetic)).toBe(false)
  })
})
