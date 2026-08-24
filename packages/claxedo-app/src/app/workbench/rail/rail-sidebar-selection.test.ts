import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"

import type { ContentMeta } from "../state/types"
import type { ProjectItem } from "./domain-types"
import { useRailSidebarSelection } from "./rail-sidebar-selection"

const projects: ProjectItem[] = [
  { id: "project-main", worktree: "/repo/main", name: "Main" },
  { id: "project-active", worktree: "/repo/active", name: "Active" },
  { id: "project-surface", worktree: "/repo/surface", name: "Surface" },
]

describe("useRailSidebarSelection", () => {
  test("active workspace route wins over focused surface and pane worktree fallback", () => {
    withSelection(
      {
        activeDirectory: "/repo/active",
        focusedContent: sessionMeta("/repo/surface"),
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (selection) => {
        expect(selection.sidebarDir()).toBe("/repo/active")
        expect(selection.sidebarWorkspaceName()).toBe("active-workspace")
        expect(selection.sidebarProjectName()).toBe("caption:project-active")
        expect(selection.focusedPaneWorkspaceDir("pane-1")).toBe("/repo/surface")
      },
    )
  })

  test("focused surface tool directory wins over pane pinned and default worktrees", () => {
    withSelection(
      {
        focusedContent: sessionMeta("/repo/surface"),
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (selection) => {
        expect(selection.sidebarDir()).toBe("/repo/surface")
        expect(selection.sidebarWorkspaceName()).toBe("surface-workspace")
        expect(selection.sidebarProjectName()).toBe("caption:project-surface")
        expect(selection.focusedPaneWorkspaceDir("pane-1")).toBe("/repo/surface")
      },
    )
  })

  test("blocked virtual sessions do not fall through to pane worktree labels", () => {
    withSelection(
      {
        focusedContent: centralVirtualSessionMeta(),
        pinned: "/repo/pinned",
        fallback: "/repo/default",
      },
      (selection) => {
        expect(selection.sidebarDir()).toBeUndefined()
        expect(selection.sidebarWorkspaceName()).toBe("")
        expect(selection.sidebarProjectName()).toBe("")
        expect(selection.focusedPaneWorkspaceDir("pane-1")).toBeUndefined()
      },
    )
  })
})

function withSelection(
  input: {
    activeProjectId?: string
    activeDirectory?: string
    focusedContent?: ContentMeta
    pinned?: string
    fallback?: string
  },
  run: (selection: ReturnType<typeof useRailSidebarSelection>) => void,
) {
  createRoot((dispose) => {
    run(
      useRailSidebarSelection({
        state: fakeState(input),
        projects: () => projects,
        activeProjectId: () => input.activeProjectId,
        activeDirectory: () => input.activeDirectory,
        projectCaption: (project) => `caption:${project.id}`,
        worktreeInfo: (workspaceDir) => ({
          name: `${workspaceDir.split("/").at(-1)}-workspace`,
          projectName: "unused",
          projectWorktree: workspaceDir,
          isMain: false,
          tooltip: workspaceDir,
        }),
      }),
    )
    dispose()
  })
}

function fakeState(input: { focusedContent?: ContentMeta; pinned?: string; fallback?: string }) {
  return {
    wb: {
      state: {
        focusedPaneId: "pane-1",
        panes: [{ id: "pane-1", contentId: input.focusedContent?.id }],
      },
      selectors: {
        focusedContent: () => input.focusedContent?.id,
      },
    },
    meta: {
      get: (id?: string) => (id && id === input.focusedContent?.id ? input.focusedContent : undefined),
    },
    workspace: {
      paneWorktree: () => ({
        pinned: input.pinned,
        default: input.fallback,
      }),
    },
  }
}

function sessionMeta(workspaceDir: string): ContentMeta {
  return {
    id: "surface-session",
    type: "session",
    scope: "directory",
    directory: workspaceDir,
    sessionId: "ses_surface",
    content: {
      type: "session",
      directory: workspaceDir,
      sessionId: "ses_surface",
      sessionRef: {
        sessionId: "ses_surface",
        host: "workspace",
        cwd: workspaceDir,
        toolSandbox: { kind: "local", cwd: workspaceDir },
      },
    },
  }
}

function centralVirtualSessionMeta(): ContentMeta {
  return {
    id: "surface-central",
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
  }
}
