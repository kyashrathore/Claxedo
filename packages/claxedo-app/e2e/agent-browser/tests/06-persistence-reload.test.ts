/**
 * 06 — Persistence & Reload
 *
 * Proves: Layout state survives reload well enough to keep the session usable
 * and preserve the sidebar state.
 *
 * Catches:
 * - `persisted()` not writing to localStorage
 * - Migration crash on re-read
 * - Reload dropping the session layout entirely
 * - Toolbar actions disappearing after reload
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  countTabs,
  settle,
  waitFor,
} from "./_helpers"
import { click, press, open, isVisible, clickMoreMenuItem } from "../ab"

const { before, after } = suiteLifecycle("06-persistence-reload")

describe("06 — persistence & reload", () => {
  let sessionUrl: string
  let tabCountBefore: number
  let sidebarHiddenBefore: boolean

  beforeAll(async () => {
    const result = await before()
    sessionUrl = result.sessionUrl
  }, 30_000)
  afterAll(after)

  test("set up state: create tab and hide sidebar", async () => {
    setTestContext("setup state for persistence")

    // Create an extra terminal tab via more menu
    await clickMoreMenuItem("New Terminal")
    await waitFor("[data-tab-id]", 5000)
    await settle(500)

    // Hide sidebar
    await press("Meta+b")
    await waitFor("button[aria-label='Show Sidebar']", 5000)

    // Record state
    tabCountBefore = await countTabs()
    sidebarHiddenBefore = await isVisible("button[aria-label='Show Sidebar']")
    await screenshot("before-reload")

    expect(tabCountBefore).toBeGreaterThanOrEqual(2) // Process + at least 1 terminal
    expect(sidebarHiddenBefore).toBe(true)
  }, 20_000)

  test("reload keeps the session layout usable", async () => {
    setTestContext("reload keeps session usable")

    // Navigate to same URL (reload)
    await open(sessionUrl)
    await waitFor("[data-component='workspace-more-menu']", 10_000)
    await settle(500)

    const tabCountAfter = await countTabs()
    const snap = await snapshot()
    await screenshot("after-reload-tabs")

    expect(tabCountAfter).toBeGreaterThanOrEqual(1)
    expect(snap).toContain("New Session")
  }, 15_000)

  test("reload preserves sidebar state", async () => {
    setTestContext("reload preserves sidebar")
    const showSidebarVisible = await isVisible(
      "button[aria-label='Show Sidebar']",
    )
    await screenshot("after-reload-sidebar")

    expect(showSidebarVisible).toBe(sidebarHiddenBefore)
  }, 10_000)

  test("more menu trigger present after reload", async () => {
    setTestContext("more menu trigger after reload")
    const visible = await isVisible("[data-component='workspace-more-menu']")
    await screenshot("after-reload-more-menu")

    expect(visible).toBe(true)
  }, 10_000)
})
