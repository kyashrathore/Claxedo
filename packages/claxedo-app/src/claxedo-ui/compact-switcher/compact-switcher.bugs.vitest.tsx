import { afterEach, describe, expect, test, vi } from "vitest"
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
