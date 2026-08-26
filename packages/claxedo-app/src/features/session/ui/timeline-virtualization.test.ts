import { describe, expect, test } from "bun:test"
import {
  estimateLongMarkdownHeight,
  timelineNavigationAnchorIndex,
} from "./timeline-virtualization"

describe("timeline navigation anchor", () => {
  const rows = [
    { _tag: "UserMessage", userMessageID: "first", anchor: true },
    { _tag: "AssistantPart", userMessageID: "first" },
    { _tag: "CommentStrip", userMessageID: "middle" },
    { _tag: "UserMessage", userMessageID: "middle", anchor: false },
    { _tag: "UserMessage", userMessageID: "last", anchor: true },
  ]

  test("selects the canonical first, middle, and last anchor only", () => {
    expect(timelineNavigationAnchorIndex(rows, "first")).toBe(0)
    expect(timelineNavigationAnchorIndex(rows, "middle")).toBe(2)
    expect(timelineNavigationAnchorIndex(rows, "last")).toBe(4)
  })

  test("does not pin a missing navigation target", () => {
    expect(timelineNavigationAnchorIndex(rows, "missing")).toBe(-1)
    expect(timelineNavigationAnchorIndex(rows, undefined)).toBe(-1)
  })
})

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
    const text = [
      "```ts",
      ...Array.from({ length: 240 }, (_, index) => `export const value${index} = ${index}`),
      "```",
    ].join("\n")
    expect(estimateLongMarkdownHeight(text)).toBe(240 * 24 + 36)
  })
})
