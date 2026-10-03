import { describe, expect, test } from "vitest"
import { sessionPlacement } from "./session-placement"

describe("sessionPlacement", () => {
  test("places Pi on a cloud workspace in a Durable Object", () => {
    expect(sessionPlacement({ backing: "cloud-vm", harnessId: "pi" })).toBe("durable-object")
  })

  test("keeps every other session in the workspace runtime", () => {
    expect(sessionPlacement({ backing: "local-worktree", harnessId: "pi" })).toBe("runtime")
    expect(sessionPlacement({ backing: "cloud-vm", harnessId: "codex" })).toBe("runtime")
  })
})
