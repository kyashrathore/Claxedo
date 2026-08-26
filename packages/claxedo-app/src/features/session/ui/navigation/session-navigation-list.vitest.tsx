import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { afterEach, describe, expect, test, vi } from "vitest"
import { workbenchDrag } from "@/features/session/app-ports"
import { SessionNavigation, type SessionNavigationDisplayRow } from "./session-navigation-list"
import { TerminalSurfaceNavigation } from "../../../terminal/ui/navigation/terminal-surface-navigation"
import type { TerminalSurfaceRow } from "./session-navigation"

vi.mock("@/features/session/app-ports", async () => {
  const navigation = await import("@/app/workbench/navigation/navigation-row")
  const workbench = await import("@/app/workbench/workbench")
  return {
    NavigationRow: navigation.NavigationRow,
    NavigationStatusDot: navigation.NavigationStatusDot,
    workbenchDrag: workbench.workbenchDrag,
  }
})

vi.mock("@/features/terminal/app-ports", async () => {
  const navigation = await import("@/app/workbench/navigation/navigation-row")
  return {
    NavigationRow: navigation.NavigationRow,
    NavigationStatusDot: navigation.NavigationStatusDot,
  }
})

function dispatchPointer(
  target: EventTarget,
  type: string,
  init: { clientX?: number; clientY?: number; pointerId?: number; pointerType?: string; button?: number },
) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(ev, "clientX", { value: init.clientX ?? 0 })
  Object.defineProperty(ev, "clientY", { value: init.clientY ?? 0 })
  Object.defineProperty(ev, "pointerId", { value: init.pointerId ?? 1 })
  Object.defineProperty(ev, "pointerType", { value: init.pointerType ?? "mouse" })
  Object.defineProperty(ev, "button", { value: init.button ?? 0 })
  target.dispatchEvent(ev)
}

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
  workbenchDrag.cancel()
  cleanup()
})

describe("SessionNavigation", () => {
  test("emits activation and archive commands from row controls", () => {
    const onPrepareActivate = vi.fn()
    const onActivate = vi.fn()
    const onArchive = vi.fn()
    const view = render(() => (
      <SessionNavigation
        rows={[row()]}
        onPrepareActivate={onPrepareActivate}
        onActivate={onActivate}
        onArchive={onArchive}
        onPrepareDrag={() => undefined}
      />
    ))

    // WP-C1: the row activates through its native <button> (named after the row
    // title) and the archive control is a sibling button — both inside the row
    // container. Enter/Space activation is the platform's job now, so this drives
    // the click path rather than a synthesized keydown jsdom won't turn into one.
    const activateButton = view.getByRole("button", { name: "Build sidebar" })
    fireEvent.pointerDown(activateButton)
    fireEvent.click(activateButton)
    fireEvent.click(view.getByRole("button", { name: "Archive Build sidebar" }))

    expect(onPrepareActivate).toHaveBeenCalledTimes(1)
    expect(onPrepareActivate).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ sessionId: "ses_1" }),
      }),
    )
    expect(onActivate).toHaveBeenCalledTimes(1)
    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(onArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ sessionRef: "local:/repo:session:ses_1" }),
      }),
    )
  })

  test("keeps the archive control stable while the archive request is pending", async () => {
    let resolveArchive!: () => void
    const onArchive = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveArchive = resolve
        }),
    )
    const view = render(() => (
      <SessionNavigation rows={[row()]} onActivate={() => {}} onArchive={onArchive} onPrepareDrag={() => undefined} />
    ))
    const archive = view.getByRole("button", { name: "Archive Build sidebar" })

    fireEvent.click(archive)
    fireEvent.click(archive)

    expect(onArchive).toHaveBeenCalledTimes(1)
    expect(archive).toBeDisabled()

    resolveArchive()
    await Promise.resolve()
    await Promise.resolve()

    expect(archive).not.toBeDisabled()
  })

  test("keeps hovered row controls mounted when the active session changes", () => {
    const [active, setActive] = createSignal("ses_1")
    const sessions = ["ses_1", "ses_2"]
    const view = render(() => (
      <SessionNavigation
        rows={sessions.map((sessionId) =>
          row({
            source: {
              ...row().source,
              sessionRef: `local:/repo:session:${sessionId}`,
              sessionId,
              title: `Session ${sessionId.at(-1)}`,
            },
            title: `Session ${sessionId.at(-1)}`,
            active: active() === sessionId,
          }),
        )}
        onActivate={(item) => setActive(item.source.sessionId)}
        onArchive={() => {}}
        onPrepareDrag={() => undefined}
      />
    ))
    const firstRow = view.getAllByTestId("rail-sidebar-session-row")[0]
    const firstArchive = view.getByRole("button", { name: "Archive Session 1" })

    fireEvent.click(view.getByRole("button", { name: "Session 2" }))

    expect(view.getAllByTestId("rail-sidebar-session-row")[0]).toBe(firstRow)
    expect(view.getByRole("button", { name: "Archive Session 1" })).toBe(firstArchive)
  })

  test("prepares the workbench drag payload from a pointer drag", () => {
    // WP-C3 replaced native HTML5 DnD with the pointer-drag engine
    // (`useDragSource`), so drags begin on a pointerdown+move past threshold and
    // the payload lives in the in-memory `workbenchDrag` controller — there is no
    // `DataTransfer` to seed anymore.
    const onDragStart = vi.fn()
    const view = render(() => (
      <SessionNavigation
        rows={[row()]}
        onActivate={() => {}}
        onPrepareDrag={() => "content_session"}
        onDragStart={onDragStart}
      />
    ))
    const rowEl = view.getByTestId("rail-sidebar-session-row")
    dispatchPointer(rowEl, "pointerdown", { clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { clientX: 20, clientY: 0 })

    expect(workbenchDrag.active()).toBe(true)
    expect(workbenchDrag.contentId()).toBe("content_session")
    expect(onDragStart).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ sessionId: "ses_1" }),
        payload: {
          type: "session",
          sessionRef: "local:/repo:session:ses_1",
        },
      }),
    )
  })

  test("marks terminal lifecycle status with the sidebar status attribute", () => {
    const view = render(() => (
      <TerminalSurfaceNavigation
        rows={[
          terminalRow(1, {
            activity: { state: "working", source: "event" },
          }),
        ]}
        onActivate={() => {}}
        onClose={() => {}}
      />
    ))

    expect(
      view.getByTestId("rail-sidebar-terminal-row").querySelector('[data-sidebar-status="working"]'),
    ).not.toBeNull()
  })

  test("uses the semantic terminal glyph and an optically centered bare close glyph", () => {
    const view = render(() => (
      <TerminalSurfaceNavigation rows={[terminalRow(1)]} onActivate={() => {}} onClose={() => {}} />
    ))

    const row = view.getByTestId("rail-sidebar-terminal-row")
    expect(row.querySelector('[data-slot="terminal-row-icon"] [data-icon="terminal"]')).not.toBeNull()
    expect(row.querySelector('[data-slot="terminal-row-icon"]')?.textContent).not.toContain(">")
    expect(row.querySelector('[data-slot="terminal-row-close"] > svg[data-slot="icon-svg"]')).not.toBeNull()
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
        }),
      ),
    )
    const [terminals, setTerminals] = createSignal(Array.from({ length: 50 }, (_, index) => terminalRow(index)))
    const view = render(() => (
      <>
        <TerminalSurfaceNavigation rows={terminals()} onActivate={() => {}} onClose={() => {}} />
        <SessionNavigation rows={sessions()} onActivate={() => {}} onPrepareDrag={() => undefined} />
      </>
    ))
    const stableSession = view.getAllByTestId("rail-sidebar-session-row")[0]
    const stableTerminal = view.getAllByTestId("rail-sidebar-terminal-row")[0]

    for (let index = 0; index < 100; index++) {
      const sessionIndex = 100 + (index % 100)
      const terminalIndex = 10 + (index % 20)
      setSessions((current) =>
        current.map((item, itemIndex) =>
          itemIndex === sessionIndex
            ? {
                ...item,
                title: `Session ${sessionIndex} event ${index}`,
                status: index % 2 === 0 ? "working" : "idle",
              }
            : item,
        ),
      )
      setTerminals((current) =>
        current.map((item, itemIndex) =>
          itemIndex === terminalIndex
            ? {
                ...item,
                activity: {
                  state: index % 2 === 0 ? "working" : "idle",
                  source: "event",
                },
              }
            : item,
        ),
      )
    }
    await Promise.resolve()

    expect(view.getAllByTestId("rail-sidebar-session-row")).toHaveLength(500)
    expect(view.getAllByTestId("rail-sidebar-terminal-row")).toHaveLength(50)
    expect(view.getAllByTestId("rail-sidebar-session-row")[0]).toBe(stableSession)
    expect(view.getAllByTestId("rail-sidebar-terminal-row")[0]).toBe(stableTerminal)
    expect(view.getByText("Session 150 event 50")).toBeTruthy()
  })
})
