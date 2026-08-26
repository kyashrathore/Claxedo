import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { extractPromptFromParts } from "./prompt"

const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "text", text: value, ...extra }) as Part

const filePart = (input: {
  value?: string
  start?: number
  end?: number
  path?: string
  url?: string
  mime?: string
  filename?: string
}) =>
  ({
    type: "file",
    id: "prt_file",
    url: input.url ?? "file:///x",
    mime: input.mime ?? "text/plain",
    filename: input.filename,
    source:
      input.value === undefined
        ? undefined
        : {
            type: "file",
            text: { value: input.value, start: input.start ?? 0, end: input.end ?? 0 },
            path: input.path,
          },
  }) as Part

const agentPart = (input: { name: string; value: string; start: number; end: number }) =>
  ({
    type: "agent",
    name: input.name,
    source: { value: input.value, start: input.start, end: input.end },
  }) as Part

describe("extractPromptFromParts", () => {
  test("returns a single text part for a plain text message", () => {
    const result = extractPromptFromParts([text("hello world")])
    expect(result).toEqual([{ type: "text", content: "hello world", start: 0, end: 11 }])
  })

  test("returns one empty text part when there is no usable content", () => {
    expect(extractPromptFromParts([])).toEqual([{ type: "text", content: "", start: 0, end: 0 }])
  })

  test("picks the longest non-synthetic text part and ignores synthetic/ignored parts", () => {
    const result = extractPromptFromParts([
      text("short"),
      text("the longer real prompt"),
      text("SYNTHETIC", { synthetic: true }),
      text("IGNORED", { ignored: true }),
    ])
    expect(result).toEqual([{ type: "text", content: "the longer real prompt", start: 0, end: 22 }])
  })

  test("splits an inline file mention out of the surrounding text at its position", () => {
    const source = "see @src/a.ts now"
    const result = extractPromptFromParts([text(source), filePart({ value: "@src/a.ts", start: 4, end: 13 })])
    expect(result).toEqual([
      { type: "text", content: "see ", start: 0, end: 4 },
      { type: "file", path: "src/a.ts", content: "@src/a.ts", start: 4, end: 13, selection: undefined },
      { type: "text", content: " now", start: 13, end: 17 },
    ])
  })

  test("makes an @-mention path relative to the provided directory", () => {
    const source = "@/repo/src/a.ts"
    const result = extractPromptFromParts([text(source), filePart({ value: "@/repo/src/a.ts", start: 0, end: 15 })], {
      directory: "/repo",
    })
    const file = result.find((part) => part.type === "file")
    expect(file).toMatchObject({ type: "file", path: "src/a.ts" })
  })

  test("parses a line selection from the file url query", () => {
    const source = "@a.ts"
    const result = extractPromptFromParts([
      text(source),
      filePart({ value: "@a.ts", start: 0, end: 5, url: "file:///a.ts?start=3&end=9" }),
    ])
    const file = result.find((part) => part.type === "file") as { selection?: unknown }
    expect(file.selection).toEqual({ startLine: 3, endLine: 9, startChar: 0, endChar: 0 })
  })

  test("extracts an inline agent mention", () => {
    const source = "ask @reviewer please"
    const result = extractPromptFromParts([
      text(source),
      agentPart({ name: "reviewer", value: "@reviewer", start: 4, end: 13 }),
    ])
    expect(result).toContainEqual({ type: "agent", name: "reviewer", content: "@reviewer", start: 4, end: 13 })
  })

  test("appends image attachments from data: urls after the text", () => {
    const result = extractPromptFromParts([
      text("look"),
      filePart({ url: "data:image/png;base64,AAAA", mime: "image/png", filename: "shot.png" }),
    ])
    expect(result[0]).toEqual({ type: "text", content: "look", start: 0, end: 4 })
    expect(result.at(-1)).toMatchObject({
      type: "image",
      mime: "image/png",
      filename: "shot.png",
      dataUrl: "data:image/png;base64,AAAA",
    })
  })
})
