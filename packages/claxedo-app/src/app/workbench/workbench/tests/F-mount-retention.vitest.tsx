import { describe, expect, test } from "vitest"
import { createEffect, createSignal } from "solid-js"
import type { PaneCtx } from "../index"
import { mountWorkbench } from "./dom-helpers"

describe("F. mount retention", () => {
  test("navigating from A to B does not unmount A's renderContent", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().navigation.show("a")
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    h.api().contents.add("b")
    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-a")?.getAttribute("data-visible")).toBe("0")
    expect(h.utils.queryByTestId("content-b")?.getAttribute("data-visible")).toBe("1")
  })

  test("after a navigate-restore cycle, hidden content has its DOM intact", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    const aRoot = h.utils.queryByTestId("content-a")!
    ;(aRoot).dataset.markedByTest = "yes"
    h.api().split.split(h.api().selectors.contentPane("a")!, "right", "b")
    h.api().navigation.show("b")
    expect((h.utils.queryByTestId("content-a") as HTMLElement)?.dataset.markedByTest).toBe("yes")
    h.api().navigation.show("a")
    expect((h.utils.queryByTestId("content-a") as HTMLElement)?.dataset.markedByTest).toBe("yes")
  })

  test('mountPolicy="active-only" unmounts hidden content', () => {
    const h = mountWorkbench({ mountPolicy: "active-only" })
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")).toBeNull()
  })

  test('mountPolicy="visible-once" defers restored hidden content and retains it after opening', () => {
    const h = mountWorkbench({ mountPolicy: "visible-once" })
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")

    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-b")).toBeNull()

    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-b")).not.toBeNull()
  })

  test("contains each mounted surface without neutral filter or exposed hidden attributes", () => {
    const h = mountWorkbench({ mountPolicy: "visible-once" })
    h.api().contents.add("a")
    h.api().navigation.show("a")

    const activeSlot = h.utils.container.querySelector<HTMLElement>('[data-workbench-content="a"]')!
    expect(activeSlot.style.contain).toBe("strict")
    expect(activeSlot.classList.contains("saturate-100")).toBe(false)
    expect(activeSlot.classList.contains("opacity-100")).toBe(false)
    expect(activeSlot.hasAttribute("aria-hidden")).toBe(false)

    h.api().contents.add("b")
    h.api().navigation.show("b")

    expect(activeSlot.getAttribute("aria-hidden")).toBe("true")
    expect(activeSlot.inert).toBe(true)
    const nextSlot = h.utils.container.querySelector<HTMLElement>('[data-workbench-content="b"]')!
    expect(nextSlot.style.contain).toBe("strict")
    expect(nextSlot.hasAttribute("aria-hidden")).toBe(false)
  })

  test("maxMountedContents keeps visible content plus recent hidden content", () => {
    const h = mountWorkbench({ maxMountedContents: 2 })
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().contents.add("c")
    h.api().navigation.show("a")
    h.api().navigation.show("b")
    h.api().navigation.show("c")

    expect(h.utils.queryByTestId("content-c")).not.toBeNull()
    expect(h.utils.queryByTestId("content-b")).not.toBeNull()
    expect(h.utils.queryByTestId("content-a")).toBeNull()
  })

  test("mountCapCandidate leaves non-candidate hidden content mounted", () => {
    const h = mountWorkbench({
      maxMountedContents: 1,
      mountCapCandidate: (id) => id.startsWith("session-"),
    })
    h.api().contents.add("review-a")
    h.api().contents.add("session-a")
    h.api().contents.add("session-b")
    h.api().navigation.show("review-a")
    h.api().navigation.show("session-a")
    h.api().navigation.show("session-b")

    expect(h.utils.queryByTestId("content-review-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-session-b")).not.toBeNull()
    expect(h.utils.queryByTestId("content-session-a")).toBeNull()
  })

  test("paneCtx.isVisible reflects whether the pane is currently displaying this content", () => {
    const h = mountWorkbench()
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().navigation.show("a")
    h.api().navigation.show("b")
    expect(h.utils.queryByTestId("content-a")?.getAttribute("data-visible")).toBe("0")
    expect(h.utils.queryByTestId("content-b")?.getAttribute("data-visible")).toBe("1")
  })

  test("focusing another session does not recompute an unrelated retained surface", () => {
    const visibleRuns: Record<string, number> = {}
    const Surface = (props: { id: string; pane: PaneCtx }) => {
      createEffect(() => {
        void props.pane.isVisible()
        visibleRuns[props.id] = (visibleRuns[props.id] ?? 0) + 1
      })
      return <div data-testid={`content-${props.id}`} />
    }
    const h = mountWorkbench({
      mountPolicy: "visible-once",
      renderContent: (id, pane) => <Surface id={id} pane={pane} />,
    })
    for (const id of ["a", "b", "c"]) {
      h.api().contents.add(id)
      h.api().navigation.show(id)
    }
    h.api().navigation.show("a")

    const before = { ...visibleRuns }
    h.api().navigation.show("b")

    expect(visibleRuns.a).toBe((before.a ?? 0) + 1)
    expect(visibleRuns.b).toBe((before.b ?? 0) + 1)
    expect(visibleRuns.c).toBe(before.c)
  })

  test("renders pane-owned content even if contentIds briefly lags behind pane state", () => {
    const h = mountWorkbench()
    h.api().contents.add("route-session")
    h.api().navigation.show("route-session")

    h.setState("contentIds", [])

    expect(h.utils.queryByTestId("content-route-session")).not.toBeNull()
    expect(h.utils.queryByTestId("content-route-session")?.getAttribute("data-visible")).toBe("1")
  })

  test("retainedHiddenLimit=0 unloads hidden content even under the mount cap, keeping the visible pane", () => {
    const [limit, setLimit] = createSignal(Number.MAX_SAFE_INTEGER)
    const h = mountWorkbench({ maxMountedContents: 12, retainedHiddenLimit: limit })
    h.api().contents.add("a")
    h.api().contents.add("b")
    h.api().contents.add("c")
    h.api().navigation.show("a")
    h.api().navigation.show("b")
    h.api().navigation.show("c")
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-b")).not.toBeNull()

    setLimit(0)
    expect(h.utils.queryByTestId("content-c")).not.toBeNull()
    expect(h.utils.queryByTestId("content-c")?.getAttribute("data-visible")).toBe("1")
    expect(h.utils.queryByTestId("content-a")).toBeNull()
    expect(h.utils.queryByTestId("content-b")).toBeNull()

    // Refill restores the most-recent hidden content first.
    setLimit(1)
    expect(h.utils.queryByTestId("content-b")).not.toBeNull()
    expect(h.utils.queryByTestId("content-a")).toBeNull()
    setLimit(2)
    expect(h.utils.queryByTestId("content-a")).not.toBeNull()
  })

  test("retainedHiddenLimit never unloads exempt (non-cap-candidate) content", () => {
    const h = mountWorkbench({
      maxMountedContents: 12,
      mountCapCandidate: (id) => id.startsWith("session-"),
      retainedHiddenLimit: () => 0,
    })
    h.api().contents.add("terminal-a")
    h.api().contents.add("session-a")
    h.api().navigation.show("terminal-a")
    h.api().navigation.show("session-a")

    expect(h.utils.queryByTestId("content-session-a")).not.toBeNull()
    expect(h.utils.queryByTestId("content-terminal-a")).not.toBeNull()
  })
})
