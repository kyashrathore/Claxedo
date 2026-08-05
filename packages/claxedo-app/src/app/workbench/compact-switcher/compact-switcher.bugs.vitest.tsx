import { afterEach, describe, expect, test, vi } from "vitest"
import { createSignal } from "solid-js"
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { CompactSwitcher } from "./compact-switcher"
import type { SwitcherItem } from "./switcher-items"

afterEach(() => {
  cleanup()
})

// items[0] inactive, items[1] active — mirrors the shared fixture.
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

// SWITCH_COMMIT_DELAY_MS is 48ms inside the component; wait comfortably past it.
const PAST_COMMIT = 90

describe("CompactSwitcher — pending-select cancellation (regression guard)", () => {
  // BUG 1: Clicking a non-active tab schedules a debounced select. If the user
  // then closes that same tab before the 48ms commit fires, close() never clears
  // the pending timer, so onSelect fires for a tab that is being destroyed.
  test("closing a tab cancels its pending select", async () => {
    const onSelect = vi.fn()
    const onClose = vi.fn()
    render(() => <CompactSwitcher items={items} onSelect={onSelect} onClose={onClose} />)

    // Click the inactive tab -> schedules select("content-session") in 48ms.
    fireEvent.click(screen.getByRole("button", { name: "Build fix" }))
    // Close it before the commit fires.
    fireEvent.click(screen.getByRole("button", { name: "Close Build fix" }))
    expect(onClose).toHaveBeenCalledWith("content-session")

    await new Promise((resolve) => setTimeout(resolve, PAST_COMMIT))

    // The tab is gone; selecting it afterwards is a stale navigation.
    expect(onSelect).not.toHaveBeenCalled()
  })

  // BUG 2: Clicking a non-active tab schedules a debounced select. If the user
  // then clicks the *active* tab (immediate-commit path), select() returns early
  // without clearing the pending timer, so the stale select fires AFTER the
  // explicit click and wins — the user lands on the wrong tab.
  test("clicking the active tab cancels a pending select of another tab", async () => {
    const onSelect = vi.fn()
    render(() => <CompactSwitcher items={items} onSelect={onSelect} />)

    // Scrub the inactive tab -> schedules select("content-session").
    fireEvent.click(screen.getByRole("button", { name: "Build fix" }))
    // Then explicitly click the active tab -> commits immediately.
    fireEvent.click(screen.getByRole("button", { name: "Dev server" }))

    await new Promise((resolve) => setTimeout(resolve, PAST_COMMIT))

    // The user's last intent was the active tab; the stale scrub must not override it.
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenLastCalledWith("content-terminal")
  })
})

describe("CompactSwitcher — tab element identity (regression guard)", () => {
  // BUG 3: `switcherItems` (rail-header-surfaces.ts) is a memo that rebuilds
  // every SwitcherItem OBJECT on every recompute — a focus change, a session
  // status tick, a worktree-info resolve. `<For>` keys on object identity, so
  // each of those recomputes disposed and re-created the entire tab strip's
  // DOM. Re-created children mean the strip's horizontal scroll position is
  // thrown away, which is what makes clicking a tab visibly jump.
  test("re-emitting the same tabs as fresh objects keeps the tab elements", () => {
    const [list, setList] = createSignal(items)
    render(() => <CompactSwitcher items={list()} />)

    const before = screen.getAllByTestId("compact-switcher-tab")
    expect(before).toHaveLength(2)

    // Exactly what the memo emits on any tick: same tabs, new object identities,
    // with focus moved from the terminal to the session.
    setList(items.map((item) => ({ ...item, active: item.contentId === "content-session" })))

    const after = screen.getAllByTestId("compact-switcher-tab")
    expect(after[0]).toBe(before[0])
    expect(after[1]).toBe(before[1])
  })

  test("a title change updates in place instead of replacing the tab", () => {
    const [list, setList] = createSignal(items)
    render(() => <CompactSwitcher items={list()} />)

    const before = screen.getAllByTestId("compact-switcher-tab")[0]
    setList(items.map((item) => ({ ...item, title: `${item.title} (renamed)` })))

    const after = screen.getAllByTestId("compact-switcher-tab")[0]
    expect(after).toBe(before)
    expect(screen.getByRole("button", { name: "Build fix (renamed)" })).toBeTruthy()
  })
})
