import { describe, expect, test } from "bun:test"
import { createOpenSurfaceActions } from "./open-surface-actions-ui"
import { sessionRoute, workspacePageRoute, workspaceSessionRoute } from "@/platform/identity/route"
import type { ContentMeta } from "../state/index"

function makeProps(dir?: string) {
  const props: Parameters<typeof createOpenSurfaceActions>[0] & { routeWorkspace?: string } = {
    routeWorkspace: dir,
    flowLog: () => undefined,
    routeDirectory: () => props.routeWorkspace,
    activeDirectory: () => dir,
    params: { id: "session-1" },
    state: {
      wb: {
        state: { focusedPaneId: "g1" },
      },
    },
  }
  return props
}

function meta(input: ContentMeta) {
  return input
}

describe("createOpenSurfaceActions", () => {
  test("navigates session tabs using canonical session routes", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-session-1",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses-123",
    }))
    await Promise.resolve()

    expect(calls).toEqual([
      {
        path: sessionRoute("ses-123"),
        reason: "tab-select",
        details: {
          surfaceId: "tab-session-1",
          tabType: "session",
          workspaceDir: "/workspace/main",
          sessionId: "ses-123",
          pageId: undefined,
          terminalId: undefined,
        },
      },
    ])
  })

  test("navigates typed session tabs using canonical session routes", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-session-typed",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses-typed",
      content: {
        type: "session",
        directory: "/workspace/main",
        sessionId: "ses-typed",
        sessionRef: {
          sessionId: "ses-typed",
          host: "workspace",
          cwd: "/workspace/main",
          toolSandbox: { kind: "local", cwd: "/workspace/main" },
        },
      },
    }))
    await Promise.resolve()

    // A typed session tab (sessionRef with a workspace host + cwd) resolves to the
    // canonical /w/<dir>/session/<id> route, not the legacy /s/<id> form.
    expect(calls.map((call) => call.path)).toEqual([workspaceSessionRoute("/workspace/main", "ses-typed")])
  })

  test("navigates legacy session tabs using the payload session id", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-session-legacy",
      type: "session",
      directory: "/workspace/main",
      content: {
        type: "session",
        directory: "/workspace/main",
        sessionId: "ses-legacy",
        title: "New session - 2026-05-29T03:52:00.000Z",
      },
    }))
    await Promise.resolve()

    expect(calls.map((call) => call.path)).toEqual([
      sessionRoute("ses-legacy"),
    ])
  })

  test("does not navigate when the selected tab already matches the current route", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-session-1",
      type: "session",
      directory: "/workspace/main",
      sessionId: "session-1",
    }))
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("does not navigate if route mirroring already caught up before the deferred tab navigation", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const props = makeProps("/workspace/main")
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(props, nav)

    actions.handleTabSelect(meta({
      id: "tab-session-1",
      type: "session",
      directory: "/workspace/other",
      sessionId: "session-2",
    }))
    props.routeWorkspace = "/workspace/other"
    props.params = { id: "session-2" }
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("tab selection syncs the route on the next microtask without timer delay", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-session-fast",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses-fast",
    }))

    expect(calls).toEqual([])
    await Promise.resolve()
    expect(calls.map((call) => call.path)).toEqual([sessionRoute("ses-fast")])
  })

  test("navigates page surfaces using typed workspace page routes", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/other"), nav)

    actions.handleTabSelect(meta({
      id: "tab-page-0",
      type: "page",
      directory: "/workspace/main",
      pageId: "page-123",
    }))
    await Promise.resolve()

    expect(calls).toEqual([
      {
        path: workspacePageRoute("/workspace/main", "page-123"),
        reason: "tab-select",
        details: {
          surfaceId: "tab-page-0",
          tabType: "page",
          workspaceDir: "/workspace/main",
          pageId: "page-123",
          terminalId: undefined,
          sessionId: undefined,
        },
      },
    ])
  })

  test("uses active workspace for global page tabs", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-page-1",
      type: "page",
      scope: "global",
      pageId: "page-123",
    }))
    await Promise.resolve()

    expect(calls).toEqual([
      {
        path: workspacePageRoute("/workspace/main", "page-123"),
        reason: "tab-select",
        details: {
          surfaceId: "tab-page-1",
          tabType: "page",
          workspaceDir: "/workspace/main",
          pageId: "page-123",
          terminalId: undefined,
          sessionId: undefined,
        },
      },
    ])
  })

  test("does not navigate page tabs when no active workspace is available", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps(undefined), nav)

    actions.handleTabSelect(meta({
      id: "tab-page-2",
      type: "page",
      scope: "global",
      pageId: "page-456",
    }))
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("navigates terminal surfaces to typed workspace terminal routes", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-terminal-1",
      type: "terminal",
      directory: "/workspace/main",
      terminalId: "pty-1",
    }))
    await Promise.resolve()

    expect(calls.length).toBe(1)
    expect(calls[0].path).toBe("/w/%2Fworkspace%2Fmain/terminal/pty-1")
  })

  test("does not navigate terminal surfaces with pending PTY ids", async () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect(meta({
      id: "tab-terminal-2",
      type: "terminal",
      directory: "/workspace/main",
      terminalId: "pending-xyz",
    }))
    await Promise.resolve()

    expect(calls).toEqual([])
  })
})
