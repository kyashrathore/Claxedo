/// <reference types="bun" />
import { expect, test } from "bun:test"
import { project, transcriptMarked } from "./markdown-stream"

const texts = [
  "# Title\n\nPlain **bold**, `code`, ~/test/opencode and file:///tmp/a.txt.\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |",
  "See [the docs][docs] and [again][docs].\n\n> quoted [docs] text\n\n[docs]: https://example.com \"Docs\"",
  "Before\n\n```ts\nconst fenced = 1\n```\n\nAfter the fence\n\n    indented code\n\n<details><summary>More</summary>\n\nhidden\n\n</details>",
]

test("a first-paint block parsed from the projection's tokens matches a parse of its own source", () => {
  for (const text of texts) {
    for (const live of [false, true]) {
      const blocks = project(undefined, text, live).blocks.filter((block) => block.tokens)
      expect(blocks.length).toBeGreaterThan(0)
      for (const block of blocks) expect(transcriptMarked.parser(block.tokens!)).toBe(transcriptMarked.parse(block.src, { async: false }) as string)
    }
  }
})

const fenced = [
  "Intro\n\n```python\ndef total(rows):\n    return sum(rows)\n```",
  "```ts\nconst a = 1\n\nconst b = 2\n```\n\nAfter",
  "```json\n{\n  \"last\": true\n}\n```",
  "~~~~md\ntrailing blank line\n\n~~~~",
]

test("while a fence streams it draws only lines its closed block will have, whatever the chunk size", () => {
  for (const text of fenced) {
    const closed = project(undefined, text, false).blocks.find((block) => block.mode === "code")!
    for (let size = 1; size <= 8; size++) {
      let streamed: ReturnType<typeof project> | undefined
      for (let end = size; end < text.length + size; end += size) {
        streamed = project(streamed, text.slice(0, end), true)
        const open = streamed.blocks.find((block) => block.mode === "code" && !block.complete)
        if (!open) continue
        expect(closed.src.slice(0, open.src.length)).toBe(open.src)
        if (open.raw.includes("\n")) expect(open.language).toBe(closed.language)
      }
    }
    const beforeClose = text.slice(0, text.search(/\n(```|~~~~)(\n|$)/) + 1)
    expect(project(undefined, beforeClose, true).blocks.find((block) => block.mode === "code")!.src).toBe(closed.src)
  }
})

const settledShapes = [
  "1. **Check 1**: read the path\n2. **Check 2**: confirm the result\n3. *done* at last",
  "- **one** first\n- **two** second\n+ plus item",
  "Intro line\n- item after a paragraph",
]

test("while a list streams its live tail draws no nested list or heading its settled text lacks, whatever the chunk size", () => {
  const shape = (html: string) => ({ nested: /<li>\s*<(ul|ol)/.test(html), heading: /<h\d/.test(html) })
  for (const text of settledShapes) {
    const settled = shape(transcriptMarked.parse(text, { async: false }) as string)
    for (let size = 1; size <= 8; size++) {
      let streamed: ReturnType<typeof project> | undefined
      for (let end = size; end < text.length + size; end += size) {
        streamed = project(streamed, text.slice(0, end), true)
        const live = streamed.blocks.at(-1)!
        const drawn = shape(transcriptMarked.parse(live.src, { async: false }) as string)
        if (!settled.nested) expect({ prefix: text.slice(0, end), nested: drawn.nested }).toEqual({ prefix: text.slice(0, end), nested: false })
        if (!settled.heading) expect({ prefix: text.slice(0, end), heading: drawn.heading }).toEqual({ prefix: text.slice(0, end), heading: false })
      }
    }
  }
})
