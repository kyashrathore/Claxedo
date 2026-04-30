import { afterEach, describe, expect, test, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { CompactSwitcher } from "./CompactSwitcher"
import type { SwitcherItem } from "./switcher-items"
import { WORKBENCH_DRAG_MIME } from "../layout"

afterEach(() => {
  cleanup()
})

const items: SwitcherItem[] = [
  {
    contentId: "content-session",
    kind: "session",
    title: "Build fix",
    workspaceDir: "/workspace",
    active: false,
  },
  {
    contentId: "content-terminal",
    kind: "terminal",
    title: "Dev server",
    workspaceDir: "/workspace",
    active: true,
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
          { ...items[0]!, status: "working" },
          { ...items[1]!, status: "permission" },
        ]}
      />
    ))

    expect(screen.getByRole("button", { name: "Build fix" }).querySelector("[data-switcher-status='working']")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Dev server" }).querySelector("[data-switcher-status='permission']")).toBeInTheDocument()
  })

  test("keeps collapsed tab controls constrained to one row", () => {
    render(() => <CompactSwitcher items={items} />)

    expect(screen.getByTestId("compact-switcher")).toHaveClass("h-full")
    expect(screen.getByTestId("compact-switcher")).toHaveClass("overflow-x-auto")
    expect(screen.getByRole("button", { name: "Dev server" })).toHaveClass("h-7")
    expect(screen.getByRole("button", { name: "Dev server" })).toHaveClass("shrink-0")
    expect(screen.getByRole("button", { name: "Dev server" })).toHaveClass("max-w-[240px]")
    expect(screen.getByText("Dev server")).toHaveClass("truncate")
  })

  test("renders workspace groups with overflow counts", () => {
    render(() => (
      <CompactSwitcher
        groups={[{
          id: "/workspace",
          label: "main",
          projectLabel: "claxedo",
          workspaceDir: "/workspace",
          items: [items[0]!],
          hiddenItems: [items[1]!],
          hiddenCount: 2,
          hiddenAttentionCount: 0,
        }]}
      />
    ))

    expect(screen.getByTestId("compact-switcher-group")).toHaveAttribute("title", "main · claxedo")
    expect(screen.getByText("+2")).toHaveAttribute("aria-label", "2 more main surfaces")
  })

  test("selects an item by content id", () => {
    const onSelect = vi.fn()
    render(() => <CompactSwitcher items={items} onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: "Build fix" }))

    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith("content-session")
  })

  test("allows sessions and terminals to start a surface drag", () => {
    const onDragStart = vi.fn()
    render(() => <CompactSwitcher items={items} onDragStart={onDragStart} />)

    const data = new Map<string, string>()
    const row = screen.getByRole("button", { name: "Build fix" })
    fireEvent.dragStart(row, {
      dataTransfer: {
        setData: (type: string, value: string) => data.set(type, value),
        effectAllowed: "copy",
      },
    })

    expect(row).toHaveAttribute("draggable", "true")
    expect(data.get(WORKBENCH_DRAG_MIME)).toBe("content-session")
    expect(data.get("text/plain")).toBeUndefined()
    expect(onDragStart).toHaveBeenCalledWith("content-session")
  })

  test("renders no placeholder text for an empty list", () => {
    const view = render(() => <CompactSwitcher items={[]} />)

    expect(view.container.textContent).toBe("")
    expect(screen.queryAllByRole("button")).toHaveLength(0)
  })
})
