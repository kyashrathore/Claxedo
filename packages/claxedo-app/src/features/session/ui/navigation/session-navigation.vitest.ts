import { describe, expect, test, vi } from "vitest"
import { WORKBENCH_DRAG_MIME } from "@/features/session/app-ports"
import {
  deriveTerminalSurfaceRows,
  navigationDragPayload,
  reconcileSessionRowsAfterArchive,
  setWorkbenchDragMime,
  type SessionNavigationRow,
} from "./session-navigation"
import type { ContentMeta } from "@/features/session/app-ports"

vi.mock("@/features/session/app-ports", async () => {
  const status = await import("@/app/workbench/compact-switcher/surface-status")
  const drag = await import("@/lib/workbench-drag")
  return {
    WORKBENCH_DRAG_MIME: drag.WORKBENCH_DRAG_MIME,
    terminalSurfaceStatus: status.terminalSurfaceStatus,
  }
})
import { terminalSurfaceSwitcherStatus } from "../../../terminal/ui/navigation/terminal-surface-navigation"

const row = (input: Partial<SessionNavigationRow> & { sessionId: string }): SessionNavigationRow => ({
  type: "session",
  sessionRef: input.sessionRef ?? `local:/repo:session:${input.sessionId}`,
  sessionId: input.sessionId,
  title: input.title ?? input.sessionId,
  directory: input.directory ?? "/repo",
  createdAt: input.createdAt ?? 1,
  updatedAt: input.updatedAt ?? 2,
  tags: input.tags ?? [],
  attachments: input.attachments ?? [],
  ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
  ...(input.projectId ? { projectId: input.projectId } : {}),
  ...(input.archivedAt ? { archivedAt: input.archivedAt } : {}),
  ...(input.environment ? { environment: input.environment } : {}),
  ...(input.git ? { git: input.git } : {}),
})

describe("session navigation islands", () => {
  test("derives terminal surface rows only from open terminal content", () => {
    const metas: ContentMeta[] = [
      {
        id: "content_terminal",
        type: "terminal",
        directory: "/repo",
        terminalId: "term_1",
        content: { type: "terminal", directory: "/repo", terminalId: "term_1", title: "Dev server" },
      },
      {
        id: "content_session",
        type: "session",
        directory: "/repo",
        sessionId: "ses_1",
        content: { type: "session", directory: "/repo", sessionId: "ses_1", title: "Session" },
      },
      {
        id: "other_terminal",
        type: "terminal",
        directory: "/other",
        terminalId: "term_2",
      },
    ]

    expect(
      deriveTerminalSurfaceRows({
        metas,
        directory: "/repo",
        focusedContentId: "content_terminal",
        agentStatus: { term_1: "working" },
      }),
    ).toEqual([
      {
        type: "terminal",
        contentId: "content_terminal",
        terminalId: "term_1",
        title: "Dev server",
        directory: "/repo",
        activity: { state: "working", source: "event" },
        active: true,
      },
    ])
  })

  test("derives pending terminal identity without durable session fields", () => {
    const rows = deriveTerminalSurfaceRows({
      metas: [
        {
          id: "content_pending",
          type: "terminal",
          directory: "/repo",
          terminalId: "pending-term",
          content: { type: "terminal", directory: "/repo", terminalId: "pending-term", title: " Claude " },
        },
      ],
      focusedContentId: "other",
      lifecycle: { "pending-term": "creating" },
    })

    expect(rows).toEqual([
      {
        type: "terminal",
        contentId: "content_pending",
        terminalId: "pending-term",
        title: "Claude",
        directory: "/repo",
        activity: { state: "idle", source: "initial" },
        active: false,
        pending: true,
      },
    ])
    expect(rows[0]).not.toHaveProperty("sessionId")
    expect(rows[0]).not.toHaveProperty("sessionRef")
  })

  test("maps terminal activity to existing switcher statuses", () => {
    expect(terminalSurfaceSwitcherStatus({ state: "needs_input", source: "event" })).toBe("permission")
    expect(terminalSurfaceSwitcherStatus({ state: "working", source: "event" })).toBe("working")
    expect(terminalSurfaceSwitcherStatus({ state: "done", source: "event" })).toBe("done")
    expect(terminalSurfaceSwitcherStatus({ state: "idle", source: "initial" })).toBe("idle")
  })

  test("builds explicit drag payloads and workbench MIME data", () => {
    expect(navigationDragPayload(row({ sessionId: "ses_1" }))).toEqual({
      type: "session",
      sessionRef: "local:/repo:session:ses_1",
    })
    expect(
      navigationDragPayload({
        type: "terminal",
        contentId: "content_terminal",
        terminalId: "term_1",
        title: "Terminal",
        directory: "/repo",
        activity: { state: "idle", source: "initial" },
        active: false,
      }),
    ).toEqual({
      type: "terminal",
      terminalId: "term_1",
      contentId: "content_terminal",
    })

    const data = new Map<string, string>()
    const transfer = {
      effectAllowed: "none",
      setData: (type: string, value: string) => data.set(type, value),
    }
    setWorkbenchDragMime({
      dataTransfer: transfer,
      mime: WORKBENCH_DRAG_MIME,
      contentId: "content_session",
    })

    expect(data.get(WORKBENCH_DRAG_MIME)).toBe("content_session")
    expect(transfer.effectAllowed).toBe("copy")
  })

  test("reconciles archive commands without resetting loaded pagination rows", () => {
    const rows = [row({ sessionId: "ses_1" }), row({ sessionId: "ses_2" }), row({ sessionId: "ses_3" })]

    expect(
      reconcileSessionRowsAfterArchive({
        rows,
        sessionRef: "local:/repo:session:ses_2",
        archivedAt: 10,
        archiveView: "active",
      }).map((item) => item.sessionId),
    ).toEqual(["ses_1", "ses_3"])

    expect(
      reconcileSessionRowsAfterArchive({
        rows,
        sessionRef: "local:/repo:session:ses_2",
        archivedAt: 10,
        archiveView: "all",
      }),
    ).toEqual([rows[0], { ...rows[1], archivedAt: 10 }, rows[2]])
  })
})
