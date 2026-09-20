import { describe, expect, test } from "bun:test"
import {
  isFilesystemDirectory,
  sameWorkspaceDirectory,
  isLocalSessionDirectory,
  isWorkspaceIdRef,
  localWorkspaceAssociationId,
  workspaceIdFromRef,
} from "./legacy-resolver"

describe("legacy directory resolver", () => {
  test("recognizes filesystem directories", () => {
    expect(isFilesystemDirectory("/repo/main")).toBe(true)
    expect(isFilesystemDirectory("C:\\Users\\me\\repo")).toBe(true)
    expect(isFilesystemDirectory("relative/path")).toBe(false)
    expect(isFilesystemDirectory("workspace:ws_1")).toBe(false)
    expect(isFilesystemDirectory(undefined)).toBe(false)
  })

  test("recognizes workspace id refs and workspace-prefixed selectors", () => {
    expect(isWorkspaceIdRef("ws_abc123")).toBe(true)
    expect(isWorkspaceIdRef("  ws_abc123  ")).toBe(true)
    expect(isWorkspaceIdRef("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBe(false)
    expect(isWorkspaceIdRef("workspace:ws_abc123")).toBe(false)
    expect(workspaceIdFromRef("workspace:ws_abc123")).toBe("ws_abc123")
    expect(workspaceIdFromRef("workspace:608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBe("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")
    expect(workspaceIdFromRef("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBeUndefined()
    expect(workspaceIdFromRef("/repo/main")).toBeUndefined()
    expect(localWorkspaceAssociationId("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")).toBe("608c72e3-405a-4d2a-bf7f-883b8c76ea8e")
    expect(localWorkspaceAssociationId("ws_abc123")).toBeUndefined()
  })

  test("keeps local session directory compatibility for non-workspace opaque strings", () => {
    expect(isLocalSessionDirectory("/repo/main")).toBe(true)
    expect(isLocalSessionDirectory("global")).toBe(true)
    expect(isLocalSessionDirectory("workspace:ws_1")).toBe(false)
    expect(isLocalSessionDirectory(undefined)).toBe(false)
  })
})

describe("sameWorkspaceDirectory", () => {
  test("a bare workspace id and its workspace: route address name the same workspace", () => {
    expect(sameWorkspaceDirectory("ws_signed_browser_relay", "workspace:ws_signed_browser_relay")).toBe(true)
    expect(sameWorkspaceDirectory("workspace:ws_a", "workspace:ws_a")).toBe(true)
  })

  test("different workspace ids stay distinct in either shape", () => {
    expect(sameWorkspaceDirectory("ws_a", "workspace:ws_b")).toBe(false)
    expect(sameWorkspaceDirectory("ws_a", "ws_b")).toBe(false)
  })

  test("a filesystem directory never aliases a workspace id", () => {
    expect(sameWorkspaceDirectory("/work/ws_a", "workspace:ws_a")).toBe(false)
    expect(sameWorkspaceDirectory("/private/tmp/project", "/tmp/project")).toBe(true)
  })
})
