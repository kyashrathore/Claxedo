import { describe, expect, test } from "vitest"
import { getSessionWriteMode, runnerHostForRunner, workspaceProfileForRunner } from "./architecture"

describe("runner-scoped harness resolution", () => {
  test("keeps existing runners on workspace-hosted execution", () => {
    expect(runnerHostForRunner({ type: "opencode" })).toBe("workspace")
    expect(runnerHostForRunner({ type: "claude-acp" })).toBe("workspace")
    expect(workspaceProfileForRunner({ type: "codex-acp" })).toBe("full")
    expect(getSessionWriteMode({ type: "cursor-acp" })).toBe("workspace_replicated")
  })

  test("routes pi through the central harness path", () => {
    expect(runnerHostForRunner({ type: "pi" })).toBe("central")
    expect(workspaceProfileForRunner({ type: "pi" })).toBe("minimal")
    expect(getSessionWriteMode({ type: "pi" })).toBe("central_canonical")
  })
})
