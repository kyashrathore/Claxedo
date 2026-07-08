import { describe, expect, test } from "bun:test"
import {
  isFilesystemDirectory,
  isLocalFilesystemDirectory,
  isLocalSessionDirectory,
  isUserHostedWorkspaceDirectory,
  isUserHostedWorkspaceScope,
  isWorkspaceIdRef,
  workspaceIdFromDirectoryRef,
  workspaceIdFromLegacyScope,
  workspaceIdFromRef,
} from "./legacy-resolver"

describe("legacy directory resolver", () => {
  test("recognizes filesystem directories", () => {
    expect(isFilesystemDirectory("/repo/main")).toBe(true)
    expect(isFilesystemDirectory("C:\\Users\\me\\repo")).toBe(true)
    expect(isFilesystemDirectory("relative/path")).toBe(false)
    expect(isFilesystemDirectory("workspace:ws_1")).toBe(false)
    expect(isFilesystemDirectory(undefined)).toBe(false)
    expect(isLocalFilesystemDirectory("/repo/main")).toBe(true)
    expect(isLocalFilesystemDirectory("workspace:ws_1")).toBe(false)
  })

  test("recognizes workspace id refs and workspace-prefixed selectors", () => {
    expect(isWorkspaceIdRef("ws_abc123")).toBe(true)
    expect(isWorkspaceIdRef("  ws_abc123  ")).toBe(true)
    expect(isWorkspaceIdRef("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBe(false)
    expect(isWorkspaceIdRef("workspace:ws_abc123")).toBe(false)
    expect(workspaceIdFromRef("workspace:ws_abc123")).toBe("ws_abc123")
    expect(workspaceIdFromRef("workspace:608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBe("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")
    expect(workspaceIdFromRef("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBeUndefined()
    expect(workspaceIdFromDirectoryRef("/repo/main")).toBeUndefined()
    expect(workspaceIdFromLegacyScope("workspace:ws_abc123")).toBe("ws_abc123")
  })

  test("recognizes user-hosted workspace directories", () => {
    expect(isUserHostedWorkspaceDirectory("/repo/.claxedo/user-hosted/workspaces/ws_1")).toBe(true)
    expect(isUserHostedWorkspaceDirectory("C:\\repo\\.claxedo\\user-hosted\\workspaces\\ws_1")).toBe(true)
    expect(isUserHostedWorkspaceDirectory("/repo/.claxedo/not-user-hosted/workspaces/ws_1")).toBe(false)
    expect(isUserHostedWorkspaceScope("/repo/.claxedo/user-hosted/workspaces/ws_1")).toBe(true)
    expect(isUserHostedWorkspaceScope("/repo/.claxedo/not-user-hosted/workspaces/ws_1")).toBe(false)
  })

  test("keeps local session directory compatibility for non-workspace opaque strings", () => {
    expect(isLocalSessionDirectory("/repo/main")).toBe(true)
    expect(isLocalSessionDirectory("global")).toBe(true)
    expect(isLocalSessionDirectory("workspace:ws_1")).toBe(false)
    expect(isLocalSessionDirectory(undefined)).toBe(false)
  })
})
