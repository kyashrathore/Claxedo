import { describe, expect, test } from "bun:test"
import { shouldRenderUserMarkdown } from "./user-message-markdown"

describe("user message Markdown detection", () => {
  test("detects pasted GFM tables", () => {
    expect(
      shouldRenderUserMarkdown(
        "| Project | Status | Next step |\n|---|---|---|\n| Aurora | Staging | Security review |",
      ),
    ).toBe(true)
  })

  test("detects common block and inline Markdown", () => {
    expect(shouldRenderUserMarkdown("## Plan\n\n- Ship it\n- Verify it")).toBe(true)
    expect(shouldRenderUserMarkdown("Read the [design](https://example.com/design).")).toBe(true)
    expect(shouldRenderUserMarkdown("Run `bun typecheck` next.")).toBe(true)
  })

  test("keeps ordinary prompts on the compact text renderer", () => {
    expect(shouldRenderUserMarkdown("Can you explain why the build failed?")).toBe(false)
    expect(shouldRenderUserMarkdown("Search for src/config and summarize it.")).toBe(false)
  })
})
