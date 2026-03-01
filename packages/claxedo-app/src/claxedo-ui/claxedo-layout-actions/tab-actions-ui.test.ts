import { describe, expect, test } from "bun:test"
import { base64Encode } from "@opencode-ai/util/encode"
import { createTabActions } from "./tab-actions-ui"

function makeProps(dir?: string) {
  return {
    flowLog: () => undefined,
    activeWorkspaceId: () => dir,
    params: { id: "session-1", pageId: "page-0", tabId: "tab-session-0" },
    claxedo: {
      split: {
        focusedId: () => "g1",
      },
    },
  } as any
}

describe("createTabActions", () => {
  test("navigates page tabs using canonical tab route", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createTabActions(makeProps("/workspace/other"), nav)

    actions.handleTabSelect({
      id: "tab-page-0",
      type: "page",
      directory: "/workspace/main",
      pageId: "page-123",
    } as any)

    expect(calls).toEqual([
      {
        path: `/${base64Encode("/workspace/main")}/tab/tab-page-0`,
        reason: "tab-select",
        details: {
          tabId: "tab-page-0",
          tabType: "page",
          workspaceDir: "/workspace/main",
          pageId: "page-123",
          terminalId: undefined,
          sessionId: undefined,
        },
      },
    ])
  })

  test("uses active workspace for virtual page tabs", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createTabActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect({
      id: "tab-page-1",
      type: "page",
      directory: "__pages__",
      pageId: "page-123",
    } as any)

    expect(calls).toEqual([
      {
        path: `/${base64Encode("/workspace/main")}/tab/tab-page-1`,
        reason: "tab-select",
        details: {
          tabId: "tab-page-1",
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
    const actions = createTabActions(makeProps(undefined), nav)

    actions.handleTabSelect({
      id: "tab-page-2",
      type: "page",
      directory: "__pages__",
      pageId: "page-456",
    } as any)

    expect(calls).toEqual([])
  })

  test("navigates terminal tabs to canonical tab route", () => {
    const calls: Array<{ path: string; reason: string; details?: Record<string, unknown> }> = []
    const nav = (path: string, reason: string, details?: Record<string, unknown>) =>
      calls.push({ path, reason, details })
    const actions = createTabActions(makeProps("/workspace/main"), nav)

    actions.handleTabSelect({
      id: "tab-terminal-1",
      type: "terminal",
      directory: "/workspace/main",
      terminalId: "pty-1",
    } as any)

    expect(calls).toEqual([
      {
        path: `/${base64Encode("/workspace/main")}/tab/tab-terminal-1`,
        reason: "tab-select",
        details: {
          tabId: "tab-terminal-1",
          tabType: "terminal",
          workspaceDir: "/workspace/main",
          terminalId: "pty-1",
          pageId: undefined,
          sessionId: undefined,
        },
      },
    ])
  })
})
