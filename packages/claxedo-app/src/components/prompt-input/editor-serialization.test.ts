import { describe, expect, test } from "bun:test"
import { DEFAULT_PROMPT, type Prompt } from "@/context/prompt"
import {
  createPromptPill,
  isNormalizedPromptEditor,
  parsePromptEditor,
  renderPromptEditor,
} from "./editor-serialization"

describe("prompt editor serialization", () => {
  const editor = () => document.createElement("div")

  test("parses an empty editor as the default prompt", () => {
    expect(parsePromptEditor(editor())).toEqual(DEFAULT_PROMPT)
  })

  test("renders and parses text with newlines and trailing newline sentinel", () => {
    const el = editor()
    renderPromptEditor(el, [
      { type: "text", content: "hello\nworld\n", start: 0, end: 12 },
    ])

    expect(Array.from(el.childNodes).map((node) => node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement).tagName : node.textContent)).toEqual([
      "hello",
      "BR",
      "world",
      "BR",
      "\u200B",
    ])
    expect(isNormalizedPromptEditor(el)).toBe(true)
    expect(parsePromptEditor(el)).toEqual([
      { type: "text", content: "hello\nworld\n", start: 0, end: 12 },
    ])
  })

  test("normalizes carriage returns and zero-width sentinels while parsing text", () => {
    const el = editor()
    el.appendChild(document.createTextNode("a\r\nb\u200Bc\r"))

    expect(parsePromptEditor(el)).toEqual([
      { type: "text", content: "a\nbc\n", start: 0, end: 5 },
    ])
  })

  test("renders and parses file and agent pills with offsets", () => {
    const el = editor()
    const parts: Prompt = [
      { type: "text", content: "see ", start: 0, end: 4 },
      {
        type: "file",
        path: "/repo/app.ts",
        selection: { startLine: 4, startChar: 1, endLine: 8, endChar: 2 },
        content: "app.ts",
        start: 4,
        end: 10,
      },
      { type: "text", content: " ask ", start: 10, end: 15 },
      { type: "agent", name: "builder", content: "@builder", start: 15, end: 23 },
    ]

    renderPromptEditor(el, parts)

    expect((el.childNodes[1] as HTMLElement).dataset).toMatchObject({
      type: "file",
      path: "/repo/app.ts",
      selectionStartLine: "4",
      selectionStartChar: "1",
      selectionEndLine: "8",
      selectionEndChar: "2",
    })
    expect((el.childNodes[3] as HTMLElement).dataset).toMatchObject({
      type: "agent",
      name: "builder",
    })
    expect(parsePromptEditor(el)).toEqual(parts)
  })

  test("parses sibling block elements as newline separated text", () => {
    const el = editor()
    const div = document.createElement("div")
    div.textContent = "one"
    const paragraph = document.createElement("p")
    paragraph.textContent = "two"
    const span = document.createElement("span")
    span.textContent = "three"
    paragraph.appendChild(span)
    el.append(div, paragraph)

    expect(parsePromptEditor(el)).toEqual([
      { type: "text", content: "one\ntwothree", start: 0, end: 12 },
    ])
  })

  test("normalization allows text, BR, valid pills, and only the trailing sentinel", () => {
    const el = editor()
    el.append(
      document.createTextNode("hello"),
      document.createElement("br"),
      document.createTextNode("\u200B"),
      createPromptPill({ type: "file", path: "/repo/a.ts", content: "a.ts", start: 0, end: 4 }),
      createPromptPill({ type: "agent", name: "agent", content: "@agent", start: 0, end: 6 }),
    )

    expect(isNormalizedPromptEditor(el)).toBe(false)

    const valid = editor()
    valid.append(
      document.createTextNode("hello"),
      createPromptPill({ type: "file", path: "/repo/a.ts", content: "a.ts", start: 0, end: 4 }),
      createPromptPill({ type: "agent", name: "agent", content: "@agent", start: 0, end: 6 }),
      document.createElement("br"),
      document.createTextNode("\u200B"),
    )
    expect(isNormalizedPromptEditor(valid)).toBe(true)

    const invalid = editor()
    invalid.append(document.createTextNode("bad\u200Btext"))
    expect(isNormalizedPromptEditor(invalid)).toBe(false)

    const arbitrary = editor()
    arbitrary.append(document.createElement("span"))
    expect(isNormalizedPromptEditor(arbitrary)).toBe(false)
  })

  test("normalization rejects malformed prompt pills", () => {
    const missingPath = editor()
    const file = document.createElement("span")
    file.dataset.type = "file"
    missingPath.append(file)
    expect(isNormalizedPromptEditor(missingPath)).toBe(false)

    const missingName = editor()
    const agent = document.createElement("span")
    agent.dataset.type = "agent"
    missingName.append(agent)
    expect(isNormalizedPromptEditor(missingName)).toBe(false)

    const partialSelection = editor()
    const partial = createPromptPill({ type: "file", path: "/repo/a.ts", content: "a.ts", start: 0, end: 4 })
    partial.dataset.selectionStartLine = "1"
    partialSelection.append(partial)
    expect(isNormalizedPromptEditor(partialSelection)).toBe(false)

    const invalidSelection = editor()
    const invalid = createPromptPill({ type: "file", path: "/repo/a.ts", content: "a.ts", start: 0, end: 4 })
    invalid.dataset.selectionStartLine = "1"
    invalid.dataset.selectionStartChar = "0"
    invalid.dataset.selectionEndLine = "two"
    invalid.dataset.selectionEndChar = "0"
    invalidSelection.append(invalid)
    expect(isNormalizedPromptEditor(invalidSelection)).toBe(false)
  })
})
