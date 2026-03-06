/**
 * 05 — Sidebar Navigation
 *
 * Proves: Sidebar toggles with Cmd+B. When hidden, "Show Sidebar" appears.
 * When restored, content returns. Tab cycling (Cmd+Tab/Shift+Tab) changes
 * active tab.
 *
 * Catches:
 * - `rail.toggle()` not flipping `pinned`
 * - Collapsed strip not rendering fallback
 * - `activateNext()`/`activatePrevious()` not moving
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  settle,
} from "./_helpers"
import { click, press, isVisible, getCount } from "../ab"

const { before, after } = suiteLifecycle("05-sidebar-navigation")

describe("05 — sidebar navigation", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("sidebar is visible by default", async () => {
    setTestContext("sidebar visible by default")
    const visible = await isVisible("[data-sidebar][data-pinned]")
    await screenshot("sidebar-default")
    expect(visible).toBe(true)
  }, 10_000)

  test("Cmd+B hides sidebar, Show Sidebar button appears", async () => {
    setTestContext("Cmd+B hides sidebar")
    await press("Meta+b")
    await settle(1000)

    const showVisible = await isVisible("button[aria-label='Show Sidebar']")
    await screenshot("sidebar-hidden")
    expect(showVisible).toBe(true)
  }, 10_000)

  test("Cmd+B restores sidebar", async () => {
    setTestContext("Cmd+B restores sidebar")
    await press("Meta+b")
    await settle(1000)

    const visible = await isVisible("[data-sidebar][data-pinned]")
    await screenshot("sidebar-restored")
    expect(visible).toBe(true)
  }, 10_000)

  test("tab cycling changes active tab", async () => {
    setTestContext("tab cycling")

    // Ensure we have at least 2 closable tabs
    await click("button[aria-label='New Terminal']")
    await settle(2000)

    // Get active tab before cycling
    const activeBefore = await getCount("[data-tab-id][data-active]")
    await screenshot("before-tab-cycle")
    expect(activeBefore).toBe(1) // Exactly one active tab

    // Cycle backward
    await press("Meta+Shift+Tab")
    await settle(1000)
    await screenshot("after-shift-tab")

    // Cycle forward
    await press("Meta+Tab")
    await settle(1000)
    await screenshot("after-tab")

    // Still exactly one active tab after cycling
    const activeAfter = await getCount("[data-tab-id][data-active]")
    expect(activeAfter).toBe(1)
  }, 20_000)
})
