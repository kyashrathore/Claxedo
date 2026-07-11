/**
 * NavigationRow / NavigationStatusDot — shared sidebar row primitive.
 *
 * Locks the behavior both navigation islands (session + terminal rows) now
 * share through this primitive: click/Enter/Space activation, `draggable`
 * wiring that seeds the workbench drag mime + typed payload, and the
 * status-dot color/aria mapping. Regressions here would previously have had to
 * be caught in two separate row implementations.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { NavigationRow, NavigationStatusDot } from "./navigation-row"
import { WORKBENCH_DRAG_MIME } from "../workbench"
import type { SessionNavigationRow } from "./session-navigation"

afterEach(cleanup)

const sessionRow: SessionNavigationRow = {
  type: "session",
  sessionRef: "local:/repo:session:ses_1",
  sessionId: "ses_1",
  title: "Build sidebar",
  directory: "/repo",
  createdAt: 1,
  updatedAt: 2,
  tags: [],
  attachments: [],
}

describe("NavigationRow", () => {
  test("activates on click, Enter, and Space", () => {
    const onActivate = vi.fn()
    const view = render(() => (
      <NavigationRow data={{ "data-testid": "row" }} onActivate={onActivate} dragRow={sessionRow}>
        <span>child</span>
      </NavigationRow>
    ))
    const row = view.getByTestId("row")
    fireEvent.click(row)
    fireEvent.keyDown(row, { key: "Enter" })
    fireEvent.keyDown(row, { key: " " })
    fireEvent.keyDown(row, { key: "a" })
    expect(onActivate).toHaveBeenCalledTimes(3)
  })

  test("is draggable and exposes data attributes", () => {
    const view = render(() => (
      <NavigationRow
        data={{ "data-testid": "row", "data-session-id": "ses_1" }}
        onActivate={() => {}}
        dragRow={sessionRow}
      >
        <span>child</span>
      </NavigationRow>
    ))
    const row = view.getByTestId("row")
    expect(row.getAttribute("draggable")).toBe("true")
    expect(row.getAttribute("data-session-id")).toBe("ses_1")
    expect(row.getAttribute("role")).toBe("button")
  })

  test("seeds the workbench drag mime and the typed payload on dragstart", () => {
    const onDragStart = vi.fn()
    const data = new Map<string, string>()
    const transfer = {
      effectAllowed: "none",
      setData: (type: string, value: string) => data.set(type, value),
    }
    const view = render(() => (
      <NavigationRow
        data={{ "data-testid": "row" }}
        onActivate={() => {}}
        dragRow={sessionRow}
        prepareContentId={() => "content_session"}
        onDragStart={onDragStart}
      >
        <span>child</span>
      </NavigationRow>
    ))
    const event = new Event("dragstart", { bubbles: true }) as DragEvent
    Object.defineProperty(event, "dataTransfer", { value: transfer })
    view.getByTestId("row").dispatchEvent(event)

    expect(data.get(WORKBENCH_DRAG_MIME)).toBe("content_session")
    expect(onDragStart).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ sessionId: "ses_1" }),
        payload: { type: "session", sessionRef: "local:/repo:session:ses_1" },
      }),
    )
  })

  test("does not seed drag data when prepareContentId returns undefined", () => {
    const data = new Map<string, string>()
    const transfer = {
      effectAllowed: "none",
      setData: (type: string, value: string) => data.set(type, value),
    }
    const view = render(() => (
      <NavigationRow
        data={{ "data-testid": "row" }}
        onActivate={() => {}}
        dragRow={sessionRow}
        prepareContentId={() => undefined}
      >
        <span>child</span>
      </NavigationRow>
    ))
    const event = new Event("dragstart", { bubbles: true }) as DragEvent
    Object.defineProperty(event, "dataTransfer", { value: transfer })
    view.getByTestId("row").dispatchEvent(event)
    expect(data.size).toBe(0)
  })
})

describe("NavigationStatusDot", () => {
  test("working status renders the pulsing ringed dot", () => {
    const view = render(() => <NavigationStatusDot status="working" active />)
    const dot = view.container.querySelector('[data-sidebar-status="working"]')
    expect(dot).not.toBeNull()
    expect(dot?.querySelector(".animate-pulse")).not.toBeNull()
  })

  test("non-working status renders a solid colored dot", () => {
    const view = render(() => <NavigationStatusDot status="done" />)
    const dot = view.container.querySelector('[data-sidebar-status="done"]')
    expect(dot).not.toBeNull()
    expect(dot?.querySelector(".animate-pulse")).toBeNull()
    expect(dot?.classList.contains("bg-icon-success-base")).toBe(true)
  })
})
