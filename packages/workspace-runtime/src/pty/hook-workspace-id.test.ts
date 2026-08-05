import { describe, expect, test } from "bun:test"
import { looksLikeDirectoryPath, terminalHookWorkspaceId } from "./hook-workspace-id"

const runtimeId = () => "0cce5b5d-1a52-4538-865d-fde31ca7653c"

describe("terminalHookWorkspaceId", () => {
  // The actual defect: the PTY fell back to `cwd`, so notify.sh posted
  // ?workspaceId=/Users/…/repo, which 404s, so no agent.lifecycle event ever
  // reached the app and terminal coding agents showed no status.
  test("falls back to the runtime workspace identity, never a directory", () => {
    const id = terminalHookWorkspaceId({ runtimeWorkspaceId: runtimeId })
    expect(id).toBe("0cce5b5d-1a52-4538-865d-fde31ca7653c")
    expect(looksLikeDirectoryPath(id)).toBe(false)
  })

  test("keeps an explicit identity supplied by the caller", () => {
    expect(terminalHookWorkspaceId({
      envWorkspaceId: "43c4e78f-2de3-4e78-a95d-c0771db0ded1",
      runtimeWorkspaceId: runtimeId,
    })).toBe("43c4e78f-2de3-4e78-a95d-c0771db0ded1")
  })

  // Callers in this repo routinely pass directories where an identity belongs,
  // so a path arriving here is treated as the mistake it almost certainly is.
  test("ignores a path-shaped value from the caller", () => {
    expect(terminalHookWorkspaceId({
      envWorkspaceId: "/Users/yashvardhansingh/test/opencode",
      runtimeWorkspaceId: runtimeId,
    })).toBe("0cce5b5d-1a52-4538-865d-fde31ca7653c")
  })

  test("ignores blank and whitespace-only values", () => {
    expect(terminalHookWorkspaceId({ envWorkspaceId: "", runtimeWorkspaceId: runtimeId })).toBe(runtimeId())
    expect(terminalHookWorkspaceId({ envWorkspaceId: "   ", runtimeWorkspaceId: runtimeId })).toBe(runtimeId())
  })

  test("trims an otherwise valid identity", () => {
    expect(terminalHookWorkspaceId({ envWorkspaceId: "  ws_abc  ", runtimeWorkspaceId: runtimeId })).toBe("ws_abc")
  })
})

describe("looksLikeDirectoryPath", () => {
  test("recognises the path shapes a workspace id must never be", () => {
    for (const value of [
      "/Users/yashvardhansingh/test/opencode",
      "~/projects/app",
      "C:\\Users\\dev\\repo",
      "\\\\server\\share",
      "relative/sub/dir",
    ]) {
      expect(looksLikeDirectoryPath(value)).toBe(true)
    }
  })

  test("accepts opaque identity tokens", () => {
    for (const value of [
      "0cce5b5d-1a52-4538-865d-fde31ca7653c",
      "ws_abc123",
      "workspace-1",
    ]) {
      expect(looksLikeDirectoryPath(value)).toBe(false)
    }
  })
})
