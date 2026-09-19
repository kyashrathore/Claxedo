import { describe, expect, test } from "bun:test"
import { modelStoreWorkspaceKey, sessionRowDirectory } from "./workspace-address"

const DIRECTORY = "/repo/main"
const WORKSPACE_ID = "ws_1"

describe("modelStoreWorkspaceKey", () => {
  test("a workspace this server holds is keyed by its directory", () => {
    expect(modelStoreWorkspaceKey({ kind: "local", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })).toBe(DIRECTORY)
  })

  test("a workspace another machine or the provisioner holds is keyed by its id in either vocabulary", () => {
    expect(modelStoreWorkspaceKey({ kind: "machine", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })).toBe(WORKSPACE_ID)
    expect(modelStoreWorkspaceKey({ kind: "user-hosted", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })).toBe(WORKSPACE_ID)
    expect(modelStoreWorkspaceKey({ kind: "provisioner", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })).toBe(WORKSPACE_ID)
    expect(modelStoreWorkspaceKey({ kind: "cloud", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })).toBe(WORKSPACE_ID)
  })

  test("a row that states no kind, or no id to key by, falls to the directory", () => {
    expect(modelStoreWorkspaceKey({ workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })).toBe(DIRECTORY)
    expect(modelStoreWorkspaceKey({ kind: "machine", hostDirectory: DIRECTORY })).toBe(DIRECTORY)
  })

  test("the pane's sdk workspace and the Settings catalog row reach the same key for one workspace", () => {
    const pane = modelStoreWorkspaceKey({ kind: "machine", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })
    const settings = modelStoreWorkspaceKey({ kind: "user-hosted", workspaceId: WORKSPACE_ID, hostDirectory: DIRECTORY })
    expect(pane).toBe(settings)
  })
})

describe("sessionRowDirectory", () => {
  test("a signed workspace is addressed by id and a server-served path by itself", () => {
    expect(sessionRowDirectory({ workspaceId: WORKSPACE_ID, hostDirectory: "/on/another/machine" })).toBe("workspace:ws_1")
    expect(sessionRowDirectory({ workspaceId: undefined, hostDirectory: DIRECTORY })).toBe(DIRECTORY)
  })
})
