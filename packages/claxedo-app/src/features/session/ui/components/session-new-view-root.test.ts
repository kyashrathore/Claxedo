import { describe, expect, test } from "bun:test"
import { newSessionProjectRoot } from "./session-new-view-root"

describe("newSessionProjectRoot", () => {
  test("keeps synthetic cloud workspace sessions on the active workspace selector", () => {
    expect(
      newSessionProjectRoot({
        sdkDirectory: "workspace:ws_local_image_codex",
        projectWorktree: "/private/tmp/claxedo-real-ui-ws.sbxIwa",
      }),
    ).toBe("workspace:ws_local_image_codex")
  })

  test("uses project worktree for ordinary local sessions", () => {
    expect(
      newSessionProjectRoot({
        sdkDirectory: "/repo/main/worktree",
        projectWorktree: "/repo/main",
      }),
    ).toBe("/repo/main")
  })
})
