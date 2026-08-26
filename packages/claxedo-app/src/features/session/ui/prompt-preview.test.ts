import { describe, expect, test } from "bun:test"
import { previewPromptText } from "./prompt-preview"

describe("previewPromptText", () => {
  test("joins text content verbatim", () => {
    expect(
      previewPromptText([
        { type: "text", content: "hello " },
        { type: "text", content: "world" },
      ]),
    ).toBe("hello world")
  })

  test("renders file parts as [file:<path>]", () => {
    expect(previewPromptText([{ type: "file", path: "src/a.ts" }])).toBe("[file:src/a.ts]")
  })

  test("renders agent mentions as @<name>", () => {
    expect(previewPromptText([{ type: "agent", name: "build" }])).toBe("@build")
  })

  test("renders image parts as [image:<filename>]", () => {
    expect(previewPromptText([{ type: "image", filename: "cat.png" }])).toBe("[image:cat.png]")
  })

  test("composes a mixed prompt and trims the result", () => {
    expect(
      previewPromptText([
        { type: "text", content: "  fix " },
        { type: "file", path: "a.ts" },
        { type: "text", content: " with " },
        { type: "agent", name: "review" },
        { type: "text", content: "  " },
      ]),
    ).toBe("fix [file:a.ts] with @review")
  })

  test("returns an empty string for no parts", () => {
    expect(previewPromptText([])).toBe("")
  })
})
