import { describe, expect, test } from "vitest"
import { fireEvent } from "@solidjs/testing-library"
import { mountWorkbench } from "./dom-helpers"
import { WORKBENCH_DRAG_MIME } from "../index"

function dispatchDragEvent(
  el: Element,
  type: string,
  init: { clientX?: number; clientY?: number; dataTransfer?: DataTransfer },
) {
  const ev = new Event(type, { bubbles: true, cancelable: true })
  if (init.clientX !== undefined) Object.defineProperty(ev, "clientX", { value: init.clientX })
  if (init.clientY !== undefined) Object.defineProperty(ev, "clientY", { value: init.clientY })
  if (init.dataTransfer) Object.defineProperty(ev, "dataTransfer", { value: init.dataTransfer })
  el.dispatchEvent(ev)
}

function makeDataTransfer() {
  const data: Record<string, string> = {}
  const types: string[] = []
  const transfer = {
    get types() {
      return types
    },
    setData(type: string, value: string) {
      if (!(type in data)) types.push(type)
      data[type] = value
    },
    getData(type: string) {
      return data[type] ?? ""
    },
    setDragImage() {},
    dropEffect: "move",
    effectAllowed: "all",
    files: [] as File[],
    items: [] as DataTransferItem[],
    clearData() {
      for (const k of Object.keys(data)) delete data[k]
      types.length = 0
    },
  }
  return transfer as DataTransfer
}

describe("H. drag & drop", () => {
  test("drag from pane chrome sets application/x-workbench-content with contentId", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const handle = h.utils.queryByTestId(`pane-handle-${h.api().selectors.contentPane("a")!}`)!
    const dt = makeDataTransfer()
    fireEvent.dragStart(handle, { dataTransfer: dt })
    expect(dt.getData(WORKBENCH_DRAG_MIME)).toBe("a")
  })

  test("drop with right-edge content adds a horizontal split", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const targetId = h.api().selectors.contentPane("a")!
    const targetPane = h.utils.queryByTestId(`pane-${targetId}`)!
    // Stub getBoundingClientRect on the target.
    targetPane.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const dt = makeDataTransfer()
    dt.setData(WORKBENCH_DRAG_MIME, "b")
    dispatchDragEvent(targetPane, "dragover", { dataTransfer: dt, clientX: 195, clientY: 50 })
    dispatchDragEvent(targetPane, "drop", { dataTransfer: dt, clientX: 195, clientY: 50 })
    expect(h.state().split.root).toMatchObject({ t: "split", dir: "h" })
    expect(h.api().selectors.contentPane("b")).not.toBeNull()
  })

  test("drop over rendered content body routes to its pane", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const slot = h.utils.container.querySelector('[data-workbench-content="a"]')!
    slot.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const dt = makeDataTransfer()
    dt.setData(WORKBENCH_DRAG_MIME, "b")
    dispatchDragEvent(slot, "dragover", { dataTransfer: dt, clientX: 195, clientY: 50 })
    dispatchDragEvent(slot, "drop", { dataTransfer: dt, clientX: 195, clientY: 50 })
    expect(h.state().split.root).toMatchObject({ t: "split", dir: "h" })
    expect(h.api().selectors.contentPane("b")).not.toBeNull()
  })

  test("drop on pane middle chooses the nearest split edge", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    h.api().split.split(p1, "right", "b")
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    p1El.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const dt = makeDataTransfer()
    dt.setData(WORKBENCH_DRAG_MIME, "b")
    dispatchDragEvent(p1El, "drop", { dataTransfer: dt, clientX: 100, clientY: 100 })
    expect(h.state().split.root).toMatchObject({ t: "split", dir: "h" })
    expect(h.api().selectors.contentPane("b")).not.toBeNull()
  })

  test("drop on own pane middle keeps self-drop as a no-op", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    p1El.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const beforePanes = JSON.stringify(h.state().panes)
    const dt = makeDataTransfer()
    dt.setData(WORKBENCH_DRAG_MIME, "a")
    dispatchDragEvent(p1El, "drop", { dataTransfer: dt, clientX: 100, clientY: 100 })
    expect(JSON.stringify(h.state().panes)).toBe(beforePanes)
  })

  test("escape during drag-over cancels the drop", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    p1El.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const dt = makeDataTransfer()
    dt.setData(WORKBENCH_DRAG_MIME, "b")
    dispatchDragEvent(p1El, "dragover", { dataTransfer: dt, clientX: 195, clientY: 50 })
    fireEvent.keyDown(window, { key: "Escape" })
    dispatchDragEvent(p1El, "drop", { dataTransfer: dt, clientX: 195, clientY: 50 })
    expect(h.api().selectors.contentPane("b")).toBeNull()
  })

  test("external drop with content not in registry is rejected", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    const p1 = h.api().selectors.contentPane("a")!
    const p1El = h.utils.queryByTestId(`pane-${p1}`)!
    p1El.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const dt = makeDataTransfer()
    dt.setData(WORKBENCH_DRAG_MIME, "external-ghost")
    dispatchDragEvent(p1El, "drop", { dataTransfer: dt, clientX: 195, clientY: 50 })
    expect(h.state().contentIds).not.toContain("external-ghost")
  })
})
