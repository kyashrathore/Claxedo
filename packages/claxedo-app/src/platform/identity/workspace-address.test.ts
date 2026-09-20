import { describe, expect, test } from "bun:test"
import { sessionRowDirectory } from "./workspace-address"

describe("sessionRowDirectory", () => {
  test("a signed workspace is addressed by id and a server-served path by itself", () => {
    expect(sessionRowDirectory({ workspaceId: "ws_1", hostDirectory: "/on/another/machine" })).toBe("workspace:ws_1")
    expect(sessionRowDirectory({ workspaceId: undefined, hostDirectory: "/repo/main" })).toBe("/repo/main")
  })
})
