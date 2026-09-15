import { expect, test } from "bun:test"
import { Marked } from "marked"
import { transcriptMarkdownExtensions } from "./marked"

const parse = (text: string) => new Marked(...transcriptMarkdownExtensions).parse(text, { async: false })

test("linked images render image tokens inside the navigation link", () => {
  expect(parse('[![result](https://example.com/result.png)](https://example.com/original)')).toBe(
    '<p><a href="https://example.com/original" class="external-link" target="_blank" rel="noopener noreferrer"><img src="https://example.com/result.png" alt="result"></a></p>\n',
  )
})

test("links preserve inline formatting and escaped text", () => {
  expect(parse('[**Result** and `file` &amp; details](https://example.com)')).toContain(
    '<strong>Result</strong> and <code>file</code> &amp; details</a>',
  )
})
