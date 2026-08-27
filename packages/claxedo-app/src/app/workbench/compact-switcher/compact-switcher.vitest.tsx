import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { CompactSwitcher } from "./compact-switcher"
import type { SwitcherItem } from "./switcher-items"
import { workbenchDrag } from "../workbench/index"

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
  vi.useRealTimers()
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
    expect(screen.getAllByTestId("compact-switcher-tab")[0].querySelector('[data-slot="workbench-tab"]')).not.toHaveAttribute(
      "data-selected",
    )
    expect(screen.getAllByTestId("compact-switcher-tab")[1].querySelector('[data-slot="workbench-tab"]')).toHaveAttribute(
      "data-selected",
      "true",
    )
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
    // The title ends on an ellipsis at the 220px cap, not on a fade mask that
    // reads as a render glitch.
    expect(screen.getByText("Dev server")).toHaveClass("truncate")
    expect(screen.getByText("Dev server").style.maskImage).toBe("")
  })

  test("opts the tab out of the coarse-pointer 40px touch floor", () => {
    render(() => <CompactSwitcher items={items} />)

    // app-shell.css floors every aria-labelled button to 40x40 under
    // `(max-width: 767px), (pointer: coarse)`. Inside a 28px tab that pushes the
    // title below the avatar and inflates the close glyph over it; the tab
    // itself is the tap target, so it carries the documented opt-out.
    for (const tab of screen.getAllByTestId("compact-switcher-tab")) {
      expect(tab.hasAttribute("data-claxedo-compact-touch")).toBe(true)
    }
  })

  test("renders project avatars as the metadata hover targets without grouping tabs", () => {
    render(() => <CompactSwitcher items={items} />)

    const icons = screen.getAllByTestId("switcher-identity")
    expect(icons).toHaveLength(2)
    expect(icons[0].querySelector("[data-switcher-project-avatar]")).toHaveTextContent("C")
    expect(screen.queryByText("+2")).not.toBeInTheDocument()
  })

  test("reveals Cmd+number hints only after Command is held for 500ms", async () => {
    vi.useFakeTimers()
    render(() => <CompactSwitcher items={items} />)
    const switcher = screen.getByTestId("compact-switcher")

    fireEvent.keyDown(window, { key: "Meta", metaKey: true })
    await vi.advanceTimersByTimeAsync(499)
    expect(switcher).not.toHaveAttribute("data-command-hints")

    await vi.advanceTimersByTimeAsync(1)
    expect(switcher).toHaveAttribute("data-command-hints", "true")
    expect(screen.getAllByTestId("switcher-command-hint").map((hint) => hint.textContent)).toEqual(["⌘1", "⌘2"])
    expect(screen.getAllByTestId("switcher-command-hint")[0]).toHaveClass(
      "group-data-[command-hints]/switcher:flex",
      "absolute",
      "h-5",
      "min-w-7",
      "rounded-full",
      "bg-surface-base-active",
    )
    expect(screen.getAllByTestId("switcher-command-hint")[0].closest('[data-component="tooltip-trigger"]')).toHaveClass("w-5")
    expect(screen.getAllByTestId("switcher-identity")[0]).toHaveClass("group-data-[command-hints]/switcher:hidden")

    fireEvent.keyUp(window, { key: "Meta" })
    expect(switcher).not.toHaveAttribute("data-command-hints")
  })

  test("does not reveal Cmd+number hints for a short Command press", async () => {
    vi.useFakeTimers()
    render(() => <CompactSwitcher items={items} />)

    fireEvent.keyDown(window, { key: "Meta", metaKey: true })
    await vi.advanceTimersByTimeAsync(250)
    fireEvent.keyUp(window, { key: "Meta" })
    await vi.advanceTimersByTimeAsync(500)

    expect(screen.getByTestId("compact-switcher")).not.toHaveAttribute("data-command-hints")
  })

  test("clears pending and visible hints when the window blurs", async () => {
    vi.useFakeTimers()
    render(() => <CompactSwitcher items={items} />)
    const switcher = screen.getByTestId("compact-switcher")

    fireEvent.keyDown(window, { key: "Meta", metaKey: true })
    await vi.advanceTimersByTimeAsync(250)
    fireEvent.blur(window)
    await vi.advanceTimersByTimeAsync(500)
    expect(switcher).not.toHaveAttribute("data-command-hints")

    fireEvent.keyDown(window, { key: "Meta", metaKey: true })
    await vi.advanceTimersByTimeAsync(500)
    expect(switcher).toHaveAttribute("data-command-hints", "true")
    fireEvent.blur(window)
    expect(switcher).not.toHaveAttribute("data-command-hints")
  })

  test("renders hints only for the nine registered number shortcuts", async () => {
    vi.useFakeTimers()
    const manyItems = Array.from({ length: 10 }, (_, index): SwitcherItem => ({
      ...items[0],
      contentId: `content-${index + 1}`,
      title: `Surface ${index + 1}`,
      active: index === 0,
    }))
    render(() => <CompactSwitcher items={manyItems} />)

    fireEvent.keyDown(window, { key: "Meta", metaKey: true })
    await vi.advanceTimersByTimeAsync(500)

    expect(screen.getAllByTestId("switcher-command-hint").map((hint) => hint.textContent)).toEqual(
      Array.from({ length: 9 }, (_, index) => `⌘${index + 1}`),
    )
  })

  test("renders the effective shortcut labels supplied by the command registry", () => {
    render(() => <CompactSwitcher items={items} shortcutHints={["⌘1", ""]} />)

    expect(screen.getAllByTestId("switcher-command-hint").map((hint) => hint.textContent)).toEqual(["⌘1"])
    expect(screen.getAllByTestId("switcher-identity")[1]).not.toHaveClass("group-data-[command-hints]/switcher:hidden")
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
