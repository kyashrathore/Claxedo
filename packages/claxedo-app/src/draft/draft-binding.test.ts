import { describe, expect, test } from "bun:test"
import { attachDraftBinding, createDraftBinding, draftScopeDirectory, isDraftScopeDirectory } from "./draft-binding"

describe("draft binding", () => {
  test("creates an unbound draft", () => {
    expect(createDraftBinding("draft_1")).toEqual({
      draftId: "draft_1",
    })
  })

  test("attaches a directory to a draft", () => {
    expect(attachDraftBinding(createDraftBinding("draft_1"), "/repo/main")).toEqual({
      draftId: "draft_1",
      directory: "/repo/main",
    })
  })

  test("reattaching to the same directory is idempotent", () => {
    const binding = attachDraftBinding(createDraftBinding("draft_1"), "/repo/main")
    expect(attachDraftBinding(binding, "/repo/main")).toBe(binding)
  })

  test("builds a stable synthetic directory for draft-only scope", () => {
    expect(draftScopeDirectory("draft_1")).toBe("__draft__/draft_1")
  })

  test("recognizes synthetic draft directories", () => {
    expect(isDraftScopeDirectory("__draft__/draft_1")).toBe(true)
    expect(isDraftScopeDirectory("/repo/main")).toBe(false)
  })
})
