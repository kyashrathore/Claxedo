import { describe, expect, test } from "bun:test"
import { estimateLongMarkdownHeight } from "./timeline-virtualization"

describe("timeline Markdown height estimate", () => {
  test("keeps ordinary prose on the virtualizer default", () => {
    expect(estimateLongMarkdownHeight("A short response with **Markdown**.")).toBeUndefined()
  })

  test("reserves space for long structural Markdown before rich rendering", () => {
    const text = [
      "# Results",
      "",
      ...Array.from({ length: 40 }, (_, index) => `- Result ${index}`),
      "",
      "| Name | State |",
      "| --- | --- |",
      ...Array.from({ length: 40 }, (_, index) => `| row-${index} | ready |`),
    ].join("\n")

    expect(estimateLongMarkdownHeight(text)).toBe(text.split("\n").length * 50)
  })

  test("caps adversarial transcripts", () => {
    expect(estimateLongMarkdownHeight(Array.from({ length: 1_000 }, () => "- row").join("\n"))).toBe(6_000)
  })

  test("reserves the complete line viewport for a large fenced block", () => {
    const text = ["```ts", ...Array.from({ length: 240 }, (_, index) => `export const value${index} = ${index}`), "```"].join("\n")
    expect(estimateLongMarkdownHeight(text)).toBe(240 * 24 + 36)
  })
})
