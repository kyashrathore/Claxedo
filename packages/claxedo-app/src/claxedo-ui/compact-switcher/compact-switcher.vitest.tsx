import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { CompactSwitcher } from "./compact-switcher"
import type { SwitcherItem } from "./switcher-items"
import { workbenchDrag } from "../workbench"

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

const items: SwitcherItem[] = [
  {
    contentId: "content-session",
    kind: "session",
    title: "Build fix",
    workspaceDir: "/workspace",
    projectLabel: "Claxedo",
    workspaceLabel: "main",
    active: false,
    closable: true,
  },
  {
    contentId: "content-terminal",
    kind: "terminal",
    title: "Dev server",
    workspaceDir: "/workspace",
    projectLabel: "Claxedo",
    workspaceLabel: "main",
    active: true,
    closable: true,
  },
]

describe("CompactSwitcher", () => {
  test("renders each item title as a button", () => {
    render(() => <CompactSwitcher items={items} />)

    expect(screen.getByRole("button", { name: "Build fix" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dev server" })).toBeInTheDocument()
  })

  test("marks the active item", () => {
    render(() => <CompactSwitcher items={items} />)

    expect(screen.getByRole("button", { name: "Build fix" })).not.toHaveAttribute("aria-current")
    expect(screen.getByRole("button", { name: "Dev server" })).toHaveAttribute("aria-current", "page")
  })

  test("renders item status dots", () => {
    render(() => (
      <CompactSwitcher
        items={[
          { ...items[0], status: "working" },
          { ...items[1], status: "permission" },
        ]}
      />
    ))

    expect(
      screen.getAllByTestId("switcher-prefix-trigger")[0].querySelector("[data-switcher-status='working']"),
    ).toBeInTheDocument()
    expect(
      screen.getAllByTestId("switcher-prefix-trigger")[1].querySelector("[data-switcher-status='permission']"),
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Build fix" }).querySelector("[data-switcher-status]")).toBeNull()
  })

  test("keeps collapsed tab controls constrained to one row", () => {
    render(() => <CompactSwitcher items={items} />)

    expect(screen.getByTestId("compact-switcher")).toHaveClass("h-full")
    expect(screen.getByTestId("compact-switcher")).toHaveClass("overflow-x-auto")
    expect(screen.getAllByTestId("compact-switcher-tab")[1]).toHaveClass("h-7")
    expect(screen.getAllByTestId("compact-switcher-tab")[1]).toHaveClass("shrink-0")
    expect(screen.getAllByTestId("compact-switcher-tab")[1]).toHaveClass("max-w-[220px]")
    expect(screen.getByText("Dev server")).toHaveClass("overflow-hidden")
    expect(screen.getByText("Dev server")).toHaveStyle({
      "mask-image": "linear-gradient(to right, #000 calc(100% - 16px), transparent)",
    })
  })

  test("renders fixed project and workspace prefix labels without grouping tabs", () => {
    render(() => <CompactSwitcher items={items} />)

    const icons = screen.getAllByTestId("switcher-identity")
    expect(icons).toHaveLength(2)
    expect(icons[0].querySelector("[data-switcher-compact-label]")?.textContent).toBe("c/m")
    expect(icons[0].querySelector("[data-switcher-expanded-label]")).toBeNull()
    expect(screen.queryByText("+2")).not.toBeInTheDocument()
  })

  test("keeps metadata hover affordance on the prefix without native tooltips", () => {
    render(() => <CompactSwitcher items={items} />)

    expect(screen.getByRole("button", { name: "Build fix" })).not.toHaveAttribute("title")
    expect(screen.getAllByTestId("switcher-prefix-trigger")[0]).toHaveAccessibleName("Claxedo / main")
    expect(screen.getAllByTestId("switcher-prefix-trigger")[0]).not.toHaveAttribute("title")
    expect(screen.getAllByTestId("switcher-identity")[0]).not.toHaveAttribute("title")
  })

  test("selects an item by content id after painting the active tab", async () => {
    const onSelect = vi.fn()
    render(() => <CompactSwitcher items={items} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: "Build fix" }))

    expect(screen.getByRole("button", { name: "Build fix" })).toHaveAttribute("aria-current", "page")
    expect(onSelect).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("content-session")
  })

  test("closes an item by content id", () => {
    const onClose = vi.fn()
    const onSelect = vi.fn()
    render(() => <CompactSwitcher items={items} onClose={onClose} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: "Close Build fix" }))

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledWith("content-session")
    expect(onSelect).not.toHaveBeenCalled()
  })

  test("a pointer drag past threshold starts a surface drag carrying the contentId", () => {
    const onDragStart = vi.fn()
    render(() => <CompactSwitcher items={items} onDragStart={onDragStart} />)

    const row = screen.getByRole("button", { name: "Build fix" })
    dispatchPointer(row, "pointerdown", { clientX: 0, clientY: 0 })
    dispatchPointer(window, "pointermove", { clientX: 20, clientY: 0 })

    expect(workbenchDrag.active()).toBe(true)
    expect(workbenchDrag.contentId()).toBe("content-session")
    expect(onDragStart).toHaveBeenCalledWith("content-session")

    dispatchPointer(window, "pointerup", { clientX: 20, clientY: 0 })
    expect(workbenchDrag.active()).toBe(false)
  })

  test("renders no placeholder text for an empty list", () => {
    const view = render(() => <CompactSwitcher items={[]} />)

    expect(view.container.textContent).toBe("")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
