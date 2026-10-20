/// <reference types="bun" />
import { describe, expect, test } from "bun:test"
import { MarkdownManager } from "@tiptap/markdown"
import { marked } from "marked"
import { markdownExtensions } from "./extensions"
import { markdownRoundTrips } from "./markdown-fit"

const manager = new MarkdownManager({ extensions: markdownExtensions() })
const fits = (markdown: string) => markdownRoundTrips(markdown, manager, (text) => marked.parse(text, { async: false, gfm: true }))

describe("markdownRoundTrips", () => {
  test("keeps prose, headings, marks, lists, to-dos, quotes, code, rules and links exactly as written", () => {
    const markdown = "# Plan\n\nRetry with **backoff**, *jitter* and `cap`.\n\n- one\n- two\n\n1. first\n2. second\n\n- [ ] write\n- [x] ship\n\n> careful\n\n```ts\nconst cap = 30\n```\n\n---\n\n[runbook](https://example.com/runbook)"
    expect(fits(markdown)).toBe(true)
    expect(fits("The relay drops idle sockets after 60 s; reconnect with exponential backoff capped at 30 s.")).toBe(true)
    expect(fits("")).toBe(true)
  })

  test("accepts Markdown it would rewrite to the same document, such as star bullets", () => {
    expect(fits("* star\n* list")).toBe(true)
  })

  test("refuses Markdown it would lose: a table, raw HTML", () => {
    expect(fits("| a | b |\n| - | - |\n| 1 | 2 |")).toBe(false)
    expect(fits("<b>bold</b> text")).toBe(false)
  })
})
