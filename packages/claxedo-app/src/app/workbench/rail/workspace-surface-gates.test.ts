import { describe, expect, test } from "bun:test"
import {
  workspacePanelTargetForContent,
  workspaceToolDirectoryForContent,
  workspaceToolsBlockedForContent,
} from "./workspace-surface-gates"
import type { ContentMeta } from "../state/types"

const centralAuthzSession = {
  id: "central-authz",
  type: "session",
  scope: "directory",
  directory: "ws_authz",
  sessionId: "ses_authz",
  content: {
    type: "session",
    directory: "ws_authz",
    sessionId: "ses_authz",
    sessionRef: {
      sessionId: "ses_authz",
      host: "central",
      workspaceId: "ws_authz",
      toolSandbox: { kind: "virtual" },
    },
  },
} satisfies ContentMeta

const workspaceBackedSession = {
  id: "workspace-backed",
  type: "session",
  scope: "directory",
  directory: "workspace:ws_cloud",
  sessionId: "ses_cloud",
  content: {
    type: "session",
    directory: "workspace:ws_cloud",
    sessionId: "ses_cloud",
    sessionRef: {
      sessionId: "ses_cloud",
      host: "workspace",
      workspaceId: "ws_cloud",
      toolSandbox: { kind: "workspace", workspaceId: "ws_cloud", hosting: "cloud" },
    },
  },
} satisfies ContentMeta

const localBackedSessionWithStaleDirectory = {
  id: "local-backed",
  type: "session",
  scope: "directory",
  directory: "workspace:stale",
  sessionId: "ses_local",
  content: {
    type: "session",
    directory: "workspace:stale",
    sessionId: "ses_local",
    sessionRef: {
      sessionId: "ses_local",
      host: "workspace",
      cwd: "/repo/main",
      toolSandbox: { kind: "local", cwd: "/repo/main" },
    },
  },
} satisfies ContentMeta

describe("workspace surface gates", () => {
  test("blocks workspace tools for central authz-scoped sessions without backing", () => {
    expect(workspaceToolsBlockedForContent(centralAuthzSession)).toBe(true)
    expect(workspaceToolDirectoryForContent(centralAuthzSession)).toBeUndefined()
    expect(workspacePanelTargetForContent(centralAuthzSession, "pane-1")).toBeUndefined()
  })

  test("allows workspace tools for workspace-backed sessions", () => {
    expect(workspaceToolsBlockedForContent(workspaceBackedSession)).toBe(false)
    expect(workspaceToolDirectoryForContent(workspaceBackedSession)).toBe("workspace:ws_cloud")
    expect(workspacePanelTargetForContent(workspaceBackedSession, "pane-1")).toEqual({
      workspaceDir: "workspace:ws_cloud",
      targetPaneId: "pane-1",
    })
  })

  test("uses local SessionRef cwd as the workspace tool directory", () => {
    expect(workspaceToolsBlockedForContent(localBackedSessionWithStaleDirectory)).toBe(false)
    expect(workspaceToolDirectoryForContent(localBackedSessionWithStaleDirectory)).toBe("/repo/main")
    expect(workspacePanelTargetForContent(localBackedSessionWithStaleDirectory, "pane-1")).toEqual({
      workspaceDir: "/repo/main",
      targetPaneId: "pane-1",
    })
  })

  test("keeps legacy directory surfaces workspace-capable when no SessionRef exists", () => {
    expect(
      workspacePanelTargetForContent(
        {
          id: "legacy",
          type: "session",
          scope: "directory",
          directory: "/repo/main",
          sessionId: "ses_legacy",
        },
        "pane-1",
      ),
    ).toEqual({
      workspaceDir: "/repo/main",
      targetPaneId: "pane-1",
    })
  })
})
