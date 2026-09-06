import { describe, expect, test } from "bun:test"
import { admitPromptSubmission } from "./prompt-admission"

describe("prompt admission", () => {
  test.each(["", "   ", "\n\t"])("ignores empty input %j", (bodyMd) => {
    expect(admitPromptSubmission({ bodyMd })).toBe("ignore")
  })

  test.each([
    { bodyMd: "hello" },
    { bodyMd: "", imageCount: 1 },
    { bodyMd: "", commentCount: 1 },
  ])("admits text, images, or comments: %j", (input) => {
    expect(admitPromptSubmission(input)).toBe("admit")
  })

  test.each([
    { bodyMd: "" },
    { bodyMd: "the next message" },
    { bodyMd: "", imageCount: 1, commentCount: 1 },
  ])("stops active work instead of dispatching another turn: %j", (input) => {
    expect(admitPromptSubmission({ ...input, working: true })).toBe("abort-active")
  })
})
