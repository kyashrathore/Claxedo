import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { createOpenSurfaceActions } from "./open-surface-actions-ui"

function makeProps(dir?: string) {
  return {
    flowLog: () => undefined,
    activeWorkspaceId: () => dir,
    params: { id: "session-1", pageId: "page-0" },
    claxedo: {} as any,
    state: {
      wb: {
        state: { focusedPaneId: "g1" },
      },
    } as any,
  } as any
}

describe("createOpenSurfaceActions", () => {
  test("navigates session tabs using stable session routes", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect({
      id: "tab-session-1",
      type: "session",
      directory: "/workspace/main",
      sessionId: "ses-123",
      title: "Session",
    } as any)

    expect(calls).toEqual([
      {
        path: `/${base64Encode("/workspace/main")}/session/ses-123`,
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

  test("navigates page surfaces using stable page routes", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/other"), nav)

    actions.handleTabSelect({
      id: "tab-page-0",
      type: "page",
      directory: "/workspace/main",
      pageId: "page-123",
    } as any)

    expect(calls).toEqual([
      {
        path: `/${base64Encode("/workspace/main")}/page/page-123`,
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

  test("uses active workspace for global page tabs", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect({
      id: "tab-page-1",
      type: "page",
      scope: "global",
      pageId: "page-123",
    } as any)

    expect(calls).toEqual([
      {
        path: `/${base64Encode("/workspace/main")}/page/page-123`,
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

  test("does not navigate page tabs when no active workspace is available", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps(undefined), nav)

    actions.handleTabSelect({
      id: "tab-page-2",
      type: "page",
      scope: "global",
      pageId: "page-456",
    } as any)

    expect(calls).toEqual([])
  })

  test("navigates terminal surfaces to /<dir>/terminal/<terminalId>", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect({
      id: "tab-terminal-1",
      type: "terminal",
      directory: "/workspace/main",
      terminalId: "pty-1",
    } as any)

    expect(calls.length).toBe(1)
    expect(calls[0].path).toMatch(/\/terminal\/pty-1$/)
  })

  test("does not navigate terminal surfaces with pending PTY ids", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createOpenSurfaceActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect({
      id: "tab-terminal-2",
      type: "terminal",
      directory: "/workspace/main",
      terminalId: "pending-xyz",
    } as any)

    expect(calls).toEqual([])
  })
})
