import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { WORKBENCH_DRAG_MIME } from "../layout"
import { SessionNavigation, type SessionNavigationDisplayRow } from "./session-navigation-list"
import { TerminalSurfaceNavigation } from "./terminal-surface-navigation"
import type { TerminalSurfaceRow } from "./session-navigation"

const row = (input: Partial<SessionNavigationDisplayRow> = {}): SessionNavigationDisplayRow => ({
  source: {
    type: "session",
    sessionRef: "local:/repo:session:ses_1",
    sessionId: "ses_1",
    title: "Build sidebar",
    directory: "/repo",
    createdAt: 1,
    updatedAt: 2,
    tags: [],
    attachments: [],
  },
  title: "Build sidebar",
  directory: "/repo",
  active: false,
  status: "idle",
  ...input,
})

const terminalRow = (index: number, input: Partial<TerminalSurfaceRow> = {}): TerminalSurfaceRow => ({
  type: "terminal",
  contentId: `terminal-content-${index}`,
  terminalId: `terminal-${index}`,
  title: `Terminal ${index}`,
  directory: "/repo",
  activity: { state: "idle", source: "initial" },
  active: false,
  ...input,
})

afterEach(() => {
  cleanup()
})

describe("SessionNavigation", () => {
  test("emits activation and archive commands from row controls", () => {
    const onActivate = vi.fn()
    const onArchive = vi.fn()
    const view = render(() => (
      <SessionNavigation
        rows={[row()]}
        onActivate={onActivate}
        onArchive={onArchive}
        onPrepareDrag={() => undefined}
      />
    ))

    fireEvent.click(view.getByTestId("rail-sidebar-session-row"))
    fireEvent.keyDown(view.getByTestId("rail-sidebar-session-row"), { key: "Enter" })
    fireEvent.click(view.getByRole("button", { name: "Archive Build sidebar" }))

    expect(onActivate).toHaveBeenCalledTimes(2)
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ sessionRef: "local:/repo:session:ses_1" }),
    }))
  })

  test("prepares internal drag data and exposes the typed drag payload", () => {
    const onDragStart = vi.fn()
    const data = new Map<string, string>()
    const transfer = {
      effectAllowed: "none",
      setData: (type: string, value: string) => data.set(type, value),
    }
    const view = render(() => (
      <SessionNavigation
        rows={[row()]}
        onActivate={() => {}}
        onPrepareDrag={() => "content_session"}
        onDragStart={onDragStart}
      />
    ))
    const event = new Event("dragstart", { bubbles: true }) as DragEvent
    Object.defineProperty(event, "dataTransfer", { value: transfer })

    view.getByTestId("rail-sidebar-session-row").dispatchEvent(event)

    expect(data.get(WORKBENCH_DRAG_MIME)).toBe("content_session")
    expect(transfer.effectAllowed).toBe("copy")
    expect(onDragStart).toHaveBeenCalledWith(expect.objectContaining({
      row: expect.objectContaining({ sessionId: "ses_1" }),
      payload: {
        type: "session",
        sessionRef: "local:/repo:session:ses_1",
      },
    }))
  })

  test("marks terminal lifecycle status with the sidebar status attribute", () => {
    const view = render(() => (
      <TerminalSurfaceNavigation
        rows={[terminalRow(1, {
          activity: { state: "working", source: "event" },
        })]}
        onActivate={() => {}}
        onClose={() => {}}
      />
    ))

    expect(view.getByTestId("rail-sidebar-terminal-row").querySelector('[data-sidebar-status="working"]')).not.toBeNull()
  })

  test("keeps unrelated rows mounted across large activity bursts", async () => {
    const [sessions, setSessions] = createSignal(
      Array.from({ length: 500 }, (_, index) =>
        row({
          source: {
            type: "session",
            sessionRef: `workspace:ws_perf:session:ses_${index}`,
            sessionId: `ses_${index}`,
            title: `Session ${index}`,
            directory: "/repo",
            createdAt: index,
            updatedAt: 1_000 - index,
            tags: [],
            attachments: [],
          },
          title: `Session ${index}`,
          status: "idle",
        })
      )
    )
    const [terminals, setTerminals] = createSignal(
      Array.from({ length: 50 }, (_, index) => terminalRow(index))
    )
    const view = render(() => (
      <>
        <TerminalSurfaceNavigation
          rows={terminals()}
          onActivate={() => {}}
          onClose={() => {}}
        />
        <SessionNavigation
          rows={sessions()}
          onActivate={() => {}}
          onPrepareDrag={() => undefined}
        />
      </>
    ))
    const stableSession = view.getAllByTestId("rail-sidebar-session-row")[0]
    const stableTerminal = view.getAllByTestId("rail-sidebar-terminal-row")[0]

    for (let index = 0; index < 100; index++) {
      const sessionIndex = 100 + (index % 100)
      const terminalIndex = 10 + (index % 20)
      setSessions((current) => current.map((item, itemIndex) => itemIndex === sessionIndex
        ? {
          ...item,
          title: `Session ${sessionIndex} event ${index}`,
          status: index % 2 === 0 ? "working" : "idle",
        }
        : item
      ))
      setTerminals((current) => current.map((item, itemIndex) => itemIndex === terminalIndex
        ? {
          ...item,
          activity: {
            state: index % 2 === 0 ? "working" : "idle",
            source: "event",
          },
        }
        : item
      ))
    }
    await Promise.resolve()

    expect(view.getAllByTestId("rail-sidebar-session-row")).toHaveLength(500)
    expect(view.getAllByTestId("rail-sidebar-terminal-row")).toHaveLength(50)
    expect(view.getAllByTestId("rail-sidebar-session-row")[0]).toBe(stableSession)
    expect(view.getAllByTestId("rail-sidebar-terminal-row")[0]).toBe(stableTerminal)
    expect(view.getByText("Session 150 event 50")).toBeTruthy()
  })
})
