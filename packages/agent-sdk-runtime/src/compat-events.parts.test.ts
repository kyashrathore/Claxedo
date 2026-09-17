import { describe, expect, it } from "bun:test"
import { buildUserPromptParts, readRecordedPart } from "./compat-events"

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

  it("keeps an @file context part's source and a text part's own id", () => {
    const parts = buildUserPromptParts("ses_1", "msg_1", [
      { id: "prt_given", type: "text", text: "look at this" },
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
      ["prt_given", "text"],
      ["msg_1-part-1", "file"],
      ["msg_1-part-2", "agent"],
    ])
    expect(parts[1]).toMatchObject({ source: { type: "file", path: "/repo/a.ts" } })
    expect(parts.some((part) => part.type === "text" && part.synthetic)).toBe(false)
  })
})

describe("readRecordedPart", () => {
  const identity = { id: "prt_1", sessionID: "ses_1", messageID: "msg_1" } as const

  it("reads an attachment the old recorder serialized into a synthetic text back as its file part", () => {
    const file = { id: "prt_1", type: "file", mime: "image/png", filename: "image.png", url: "data:image/png;base64,iVBORw0KGgo=" }
    expect(readRecordedPart({ ...identity, type: "text", text: JSON.stringify(file), synthetic: true })).toEqual({
      ...identity,
      type: "file",
      mime: "image/png",
      filename: "image.png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    })
  })

  it("leaves every other part alone: prose, a comment note, a non-file record, malformed JSON", () => {
    const keep = [
      { ...identity, type: "text" as const, text: '{"type":"file"}' },
      { ...identity, type: "text" as const, text: "review: fix this", synthetic: true },
      { ...identity, type: "text" as const, text: '{"type":"agent","name":"x"}', synthetic: true },
      { ...identity, type: "text" as const, text: '{"type":"file","mime":"image/png"}', synthetic: true },
      { ...identity, type: "text" as const, text: '{"type":"file",', synthetic: true },
    ]
    for (const part of keep) expect(readRecordedPart(part)).toBe(part)
  })
})
