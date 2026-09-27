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
