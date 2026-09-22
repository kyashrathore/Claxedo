/**
 * NavigationRow / NavigationStatusMark: activation, drag source, and the status
 * mark shared by the sidebar rows and the compact tab.
 */

import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render } from "@solidjs/testing-library"
import { createSignal } from "solid-js"
import { NavigationRow, NavigationStatusMark } from "./navigation-row"
import type { SwitcherStatus } from "../compact-switcher/switcher-items"
import { workbenchDrag } from "../workbench/index"
import type { SessionNavigationRow } from "../../../features/session/ui/navigation/session-navigation"

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

afterEach(() => {
  workbenchDrag.cancel()
  cleanup()
})

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
  test("exposes a native <button> activate control that fires onActivate on click", () => {
    const onActivate = vi.fn()
    const view = render(() => (
      <NavigationRow data={{ "data-testid": "row" }} onActivate={onActivate} dragRow={sessionRow}>
        <span>child</span>
      </NavigationRow>
    ))
    // Enter/Space is the native button's job; jsdom would not turn synthesized
    // keydowns into a click, so only the tag and the click path are checked.
    const control = view.getByRole("button", { name: "Build sidebar" })
    expect(control.tagName).toBe("BUTTON")
    fireEvent.click(control)
    expect(onActivate).toHaveBeenCalledTimes(1)
  })

  test("prepares activation on pointerdown before committing it on click", () => {
    const calls: string[] = []
    const view = render(() => (
      <NavigationRow
        data={{ "data-testid": "row" }}
        onPrepareActivate={() => calls.push("prepare")}
        onActivate={() => calls.push("activate")}
        dragRow={sessionRow}
      >
        <span>child</span>
      </NavigationRow>
    ))
    const control = view.getByRole("button", { name: "Build sidebar" })

    fireEvent.pointerDown(control)
    expect(calls).toEqual(["prepare"])

    fireEvent.click(control)
    expect(calls).toEqual(["prepare", "activate"])
  })

  test("marks the active row with aria-current=page", () => {
    const view = render(() => (
      <NavigationRow data={{ "data-testid": "row" }} onActivate={() => {}} dragRow={sessionRow} active>
        <span>child</span>
      </NavigationRow>
    ))
    expect(view.getByRole("button", { name: "Build sidebar" }).getAttribute("aria-current")).toBe("page")
  })

  test("is a pointer drag source that still allows vertical touch scroll (pan-y) and exposes data attributes", () => {
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
    // `none` would kill sidebar touch scrolling; the drag is gated behind a
    // long-press instead.
    expect(row.style.touchAction).toBe("pan-y")
    expect(row.getAttribute("data-session-id")).toBe("ses_1")
    expect(row.getAttribute("role")).toBeNull()
    expect(view.getByRole("button", { name: "Build sidebar" }).tagName).toBe("BUTTON")
  })

  test("a pointer drag seeds the workbench payload and emits the typed drag-start", () => {
    const onDragStart = vi.fn()
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
    const row = view.getByTestId("row")
    dispatchPointer(row, "pointerdown", { clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { clientX: 20, clientY: 0 })

    expect(workbenchDrag.active()).toBe(true)
    expect(workbenchDrag.contentId()).toBe("content_session")
    expect(onDragStart).toHaveBeenCalledWith(
      expect.objectContaining({
        row: expect.objectContaining({ sessionId: "ses_1" }),
        payload: { type: "session", sessionRef: "local:/repo:session:ses_1" },
      }),
    )
  })

  test("does not start a drag when prepareContentId returns undefined", () => {
    const onDragStart = vi.fn()
    const view = render(() => (
      <NavigationRow
        data={{ "data-testid": "row" }}
        onActivate={() => {}}
        dragRow={sessionRow}
        prepareContentId={() => undefined}
        onDragStart={onDragStart}
      >
        <span>child</span>
      </NavigationRow>
    ))
    const row = view.getByTestId("row")
    dispatchPointer(row, "pointerdown", { clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { clientX: 20, clientY: 0 })

    expect(workbenchDrag.active()).toBe(false)
    expect(onDragStart).not.toHaveBeenCalled()
  })
})

describe("NavigationStatusMark", () => {
  const mark = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-sidebar-status]")

  test("working shows the app spinner in place of a dot", () => {
    const view = render(() => <NavigationStatusMark status="working" />)
    expect(mark(view.container)?.dataset.sidebarStatus).toBe("working")
    expect(mark(view.container)?.querySelector('[data-component="spinner"]')).not.toBeNull()
  })

  test("needs-input and error share the tinted square and differ only in tone", () => {
    const tone = (status: "permission" | "error") => {
      const view = render(() => <NavigationStatusMark status={status} />)
      const square = mark(view.container)!
      const dot = square.firstElementChild as HTMLElement
      const result = { square: [...square.classList].filter((c) => c.startsWith("bg-")), dot: [...dot.classList].filter((c) => c.startsWith("bg-")) }
      view.unmount()
      return result
    }
    expect(tone("permission")).toEqual({ square: ["bg-icon-warning-base/15"], dot: ["bg-icon-warning-base"] })
    expect(tone("error")).toEqual({ square: ["bg-icon-critical-base/15"], dot: ["bg-icon-critical-base"] })
  })

  test("done is a text-coloured dot and idle renders nothing", () => {
    const done = render(() => <NavigationStatusMark status="done" />)
    expect(mark(done.container)?.classList.contains("bg-text-base")).toBe(true)
    expect(mark(done.container)?.querySelector("*")).toBeNull()
    const idle = render(() => <NavigationStatusMark status="idle" />)
    expect(idle.container.innerHTML).toBe("")
  })

  test("a mounted mark follows its status instead of freezing at mount", () => {
    const [status, setStatus] = createSignal<SwitcherStatus>("idle")
    const view = render(() => <NavigationStatusMark status={status()} surface="switcher" />)
    expect(view.container.querySelector("[data-switcher-status]")).toBeNull()
    for (const next of ["working", "permission", "error", "done"] as const) {
      setStatus(next)
      expect(view.container.querySelector<HTMLElement>("[data-switcher-status]")?.dataset.switcherStatus).toBe(next)
    }
    expect(view.container.querySelector("[data-sidebar-status]")).toBeNull()
  })
})
