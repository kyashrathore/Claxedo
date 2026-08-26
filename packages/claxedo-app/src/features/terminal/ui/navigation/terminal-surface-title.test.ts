import { describe, expect, test } from "bun:test"
import { terminalSurfaceTitle } from "./terminal-surface-title"

describe("terminalSurfaceTitle", () => {
  test("leaves idle terminal titles unchanged", () => {
    expect(terminalSurfaceTitle("Claude: Fix Typecheck Errors", "idle")).toBe("Claude: Fix Typecheck Errors")
  })

  test("surfaces active agent status in the displayed title", () => {
    expect(terminalSurfaceTitle("Claude: Fix Typecheck Errors", "working")).toBe(
      "Claude: Fix Typecheck Errors · working",
    )
    expect(terminalSurfaceTitle("Claude: Fix Typecheck Errors", "permission")).toBe(
      "Claude: Fix Typecheck Errors · needs input",
    )
    expect(terminalSurfaceTitle("Claude: Fix Typecheck Errors", "done")).toBe("Claude: Fix Typecheck Errors · done")
  })
})
