import { describe, expect, test } from "bun:test"

import { createRailHeaderActions } from "./rail-header-actions"

describe("createRailHeaderActions", () => {
  test("session creation forwards the resolved workspace and focused pane", () => {
    const calls: Array<[string | undefined, string | undefined, string | undefined]> = []
    const actions = createRailHeaderActions({
      focusedPaneWorkspaceDir: (paneId) => paneId ? `/fallback/${paneId}` : undefined,
      focusedSplitPaneId: () => "pane-1",
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      workspaceRouteId: (workspaceDir) => workspaceDir === "/repo/sidebar" ? "ws_sidebar" : undefined,
      onNewSession: (workspaceDir, paneId, workspaceRouteId) => calls.push([workspaceDir, paneId, workspaceRouteId]),
      sidebarDir: () => "/repo/sidebar",
    })

    actions.createSession()

    expect(calls).toEqual([["/repo/sidebar", "pane-1", "ws_sidebar"]])
  })

  test("terminal creation no-ops when workspace tools are blocked", () => {
    const calls: string[] = []
    const actions = createRailHeaderActions({
      focusedPaneWorkspaceDir: () => "/repo/fallback",
      focusedSplitPaneId: () => "pane-1",
      focusedSurfaceWorkspaceToolsBlocked: () => true,
      workspaceRouteId: () => "ws_sidebar",
      onNewTerminal: (workspaceDir) => calls.push(workspaceDir),
      sidebarDir: () => "/repo/sidebar",
    })

    actions.createTerminal("bun dev", "Dev")

    expect(calls).toEqual([])
  })

  test("terminal creation prefers the sidebar workspace before focused pane fallback", () => {
    const calls: Array<[string, string | undefined, string | undefined, string | undefined, string | undefined]> = []
    const actions = createRailHeaderActions({
      focusedPaneWorkspaceDir: () => "/repo/fallback",
      focusedSplitPaneId: () => "pane-2",
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      workspaceRouteId: (workspaceDir) => workspaceDir === "/repo/sidebar" ? "ws_sidebar" : undefined,
      onNewTerminal: (workspaceDir, command, title, paneId, workspaceRouteId) => calls.push([workspaceDir, command, title, paneId, workspaceRouteId]),
      sidebarDir: () => "/repo/sidebar",
    })

    actions.createTerminal("codex", "Codex")

    expect(calls).toEqual([["/repo/sidebar", "codex", "Codex", "pane-2", "ws_sidebar"]])
  })

  test("terminal creation falls back to the focused pane workspace and no-ops without one", () => {
    const calls: string[] = []
    createRailHeaderActions({
      focusedPaneWorkspaceDir: (paneId) => paneId === "pane-3" ? "/repo/focused" : undefined,
      focusedSplitPaneId: () => "pane-3",
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      workspaceRouteId: () => "ws_focused",
      onNewTerminal: (workspaceDir) => calls.push(workspaceDir),
      sidebarDir: () => undefined,
    }).createTerminal()
    createRailHeaderActions({
      focusedPaneWorkspaceDir: () => undefined,
      focusedSplitPaneId: () => undefined,
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      workspaceRouteId: () => undefined,
      onNewTerminal: (workspaceDir) => calls.push(workspaceDir),
      sidebarDir: () => undefined,
    }).createTerminal()

    expect(calls).toEqual(["/repo/focused"])
  })

  test("task creation carries the visible workspace but remains available globally", () => {
    const calls: Array<[string | undefined, string | undefined]> = []
    const task = (sidebarDir: string | undefined) => createRailHeaderActions({
      focusedPaneWorkspaceDir: () => undefined,
      focusedSplitPaneId: () => "pane-task",
      focusedSurfaceWorkspaceToolsBlocked: () => true,
      workspaceRouteId: () => undefined,
      onNewTask: (workspaceDir, paneId) => calls.push([workspaceDir, paneId]),
      sidebarDir: () => sidebarDir,
    }).createTask()

    task("/repo/main")
    task(undefined)

    expect(calls).toEqual([
      ["/repo/main", "pane-task"],
      [undefined, "pane-task"],
    ])
  })

  test("missing callbacks do not throw", () => {
    const actions = createRailHeaderActions({
      focusedPaneWorkspaceDir: () => "/repo/fallback",
      focusedSplitPaneId: () => "pane-1",
      focusedSurfaceWorkspaceToolsBlocked: () => false,
      workspaceRouteId: () => undefined,
      sidebarDir: () => undefined,
    })

    expect(() => actions.createSession()).not.toThrow()
    expect(() => actions.createTerminal()).not.toThrow()
    expect(() => actions.createTask()).not.toThrow()
  })
})
