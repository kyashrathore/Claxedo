import { describe, expect, test } from "bun:test"
import { createOpenSurfaceActions } from "./open-surface-actions-ui"
import {
  sessionRoute,
  workspacePageRoute,
  workspaceSessionRoute,
  workspaceTerminalRoute,
} from "@/platform/identity/route"
import type { ContentMeta } from "../state/index"

function makeProps(dir?: string) {
  const props: Parameters<typeof createOpenSurfaceActions>[0] & { routeWorkspace?: string } = {
    routeWorkspace: dir,
    flowLog: () => undefined,
    projects: () => [],
    routeDirectory: () => props.routeWorkspace,
    routeId: () => undefined,
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

// handleTabSelect mirrors the route with a raw history write (a real router
// navigation remounts the entire shell under the Solid 2 router), so the
// emitted route is observed through flowLog's navigate record rather than a
// nav() callback.
function captureMirrors(props: ReturnType<typeof makeProps>) {
  // The mirror self-guards on the live location; tests share one window, so
  // reset it or a prior test's mirror suppresses this one's. Under co-run the
  // workbench dom suites swap the global window for one whose history is not
  // writable - fall back cleanly, the flowLog capture below still observes.
  try {
    window.history.replaceState(null, "", "/")
  } catch {
    /* observed via flowLog */
  }
  const paths: string[] = []
  props.flowLog = (...args: unknown[]) => {
    const [event, detail] = args
    if (event === "navigate" && detail && typeof detail === "object") {
      const path = (detail as { path?: unknown }).path
      if (typeof path === "string") paths.push(path)
    }
  }
  return paths
}

function meta(input: ContentMeta) {
  return input
}

describe("createOpenSurfaceActions", () => {
  test("navigates session tabs using canonical session routes", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-session-1",
        type: "session",
        directory: "/workspace/main",
        sessionId: "ses-123",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([sessionRoute("ses-123")])
  })

  test("navigates typed session tabs using canonical session routes", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
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
      }),
    )
    await Promise.resolve()

    // A typed session tab (sessionRef with a workspace host + cwd) resolves to the
    // canonical /w/<dir>/session/<id> route, not the legacy /s/<id> form.
    expect(calls).toEqual([workspaceSessionRoute("/workspace/main", "ses-typed")])
  })

  test("navigates signed session tabs by canonical workspace id instead of runtime directory", async () => {
    const props = makeProps("/runtime/workspace")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-session-signed",
        type: "session",
        directory: "/runtime/workspace",
        sessionId: "ses-signed",
        content: {
          type: "session",
          directory: "/runtime/workspace",
          sessionId: "ses-signed",
          sessionRef: {
            sessionId: "ses-signed",
            host: "workspace",
            workspaceId: "ws-signed",
            toolSandbox: { kind: "workspace", workspaceId: "ws-signed", hosting: "cloud" },
          },
        },
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([workspaceSessionRoute("ws-signed", "ses-signed")])
  })

  test("navigates legacy session tabs using the payload session id", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-session-legacy",
        type: "session",
        directory: "/workspace/main",
        content: {
          type: "session",
          directory: "/workspace/main",
          sessionId: "ses-legacy",
          title: "New session - 2026-05-29T03:52:00.000Z",
        },
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([sessionRoute("ses-legacy")])
  })

  test("does not navigate when the selected tab already matches the current route", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-session-1",
        type: "session",
        directory: "/workspace/main",
        sessionId: "session-1",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("does not navigate if route mirroring already caught up before the deferred tab navigation", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-session-1",
        type: "session",
        directory: "/workspace/other",
        sessionId: "session-2",
      }),
    )
    // Another writer (rail activation, route bridge) catches the route props up
    // before the microtask fires - the deferred match check must swallow it.
    props.routeWorkspace = "/workspace/other"
    props.params = { id: "session-2" }
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("tab selection syncs the route on the next microtask without timer delay", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-session-fast",
        type: "session",
        directory: "/workspace/main",
        sessionId: "ses-fast",
      }),
    )

    expect(calls).toEqual([])
    await Promise.resolve()
    expect(calls).toEqual([sessionRoute("ses-fast")])
  })

  test("navigates page surfaces using typed workspace page routes", async () => {
    const props = makeProps("/workspace/other")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-page-0",
        type: "page",
        directory: "/workspace/main",
        pageId: "page-123",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([workspacePageRoute("/workspace/main", "page-123")])
  })

  test("uses active workspace for global page tabs", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-page-1",
        type: "page",
        scope: "global",
        pageId: "page-123",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([workspacePageRoute("/workspace/main", "page-123")])
  })

  test("does not navigate page tabs when no active workspace is available", async () => {
    const props = makeProps(undefined)
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-page-2",
        type: "page",
        scope: "global",
        pageId: "page-456",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("navigates terminal surfaces to typed workspace terminal routes", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-terminal-1",
        type: "terminal",
        directory: "/workspace/main",
        terminalId: "pty-1",
      }),
    )
    await Promise.resolve()

    expect(calls.length).toBe(1)
    expect(calls[0]).toBe("/w/%2Fworkspace%2Fmain/terminal/pty-1")
  })

  test("keeps a terminal creator selection on the directory route", async () => {
    const props = makeProps("/workspace/creator-probe")
    props.routeId = () => "project-123"
    props.projects = () => [
      {
        id: "project-123",
        worktree: "/workspace/creator-probe",
        name: "main",
      },
    ]
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-terminal-new",
        type: "terminal",
        directory: "/workspace/creator-probe",
        terminalId: "new",
      }),
    )
    await Promise.resolve()

    // Directory form for the same reason as session tabs: one URL form across
    // every writer keeps the :workspaceId param stable across tab switches.
    expect(calls).toEqual([workspaceTerminalRoute("/workspace/creator-probe", "new")])
  })

  test("does not renavigate a terminal already on its canonical workspace route", async () => {
    const props = makeProps("/workspace/main")
    props.params = { terminalId: "new" }
    props.routeId = () => "project-123"
    props.projects = () => [{ id: "project-123", worktree: "/workspace/main", name: "main" }]
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-terminal-new",
        type: "terminal",
        directory: "/workspace/main",
        terminalId: "new",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([])
  })

  test("does not navigate terminal surfaces with pending PTY ids", async () => {
    const props = makeProps("/workspace/main")
    const calls = captureMirrors(props)
    const actions = createOpenSurfaceActions(props)

    actions.handleTabSelect(
      meta({
        id: "tab-terminal-2",
        type: "terminal",
        directory: "/workspace/main",
        terminalId: "pending-xyz",
      }),
    )
    await Promise.resolve()

    expect(calls).toEqual([])
  })
})
