import { describe, expect, test } from "bun:test"
import { composerModeSnapshot } from "./mode-snapshot"

describe("composerModeSnapshot", () => {
  test("keys an unowned draft by the same SDK directory used by the harness picker", () => {
    expect(composerModeSnapshot({
      mode: {
        kind: "draft",
        target: {
          directory: "/workspace/project",
          worktree: "main",
          workspaceKind: "local",
          signedControlPlane: false,
        },
      },
      sdkDirectory: "/sdk/current",
      sessionDirectory: "/workspace/project",
    }).scope).toBe("draft:/sdk/current:route")
  })

  test("keeps a stable draft identity independent of its directory", () => {
    expect(composerModeSnapshot({
      mode: { kind: "draft", draftId: "draft-1", target: undefined },
      sdkDirectory: "/sdk/current",
      sessionDirectory: "/workspace/project",
    }).scope).toBe("draft:draft-1")
  })
})
