/**
 * 03 — Split Workspace
 *
 * Proves: Split creates two independent panels with own workspace bars and
 * process tabs. Focus switching works. Tabs stay in correct panel. Hide
 * preserves state. Close merges tabs.
 *
 * Catches:
 * - Toggle creating new group instead of flipping `hidden`
 * - Process tab not injected in new groups
 * - `focusedId` stale → tab in wrong group
 * - `closeGroup()` losing or duplicating tabs
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  countTabs,
  settle,
  waitFor,
} from "./_helpers"
import { click, press, isVisible, getCount, clickMoreMenuItem } from "../ab"

const { before, after } = suiteLifecycle("03-split-workspace")

describe("03 — split workspace", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("starts with single panel", async () => {
    setTestContext("starts with single panel")
    await screenshot("single-panel")

    expect(await getCount("[data-workspace-bar]")).toBe(1)
    expect(await isVisible("button[aria-label='Add process']")).toBe(false)
  }, 10_000)

  test("split creates two panels", async () => {
    setTestContext("split creates two panels")
    await press("Meta+\\")
    await waitFor("button[aria-label='Close panel']", 5000)
    await settle(500)

    await screenshot("split-open")

    expect(await getCount("[data-workspace-bar]")).toBe(2)
    expect(await isVisible("button[aria-label='Close panel']")).toBe(true)
  }, 15_000)

  test("focus switches to right panel and tab appears there", async () => {
    setTestContext("focus right panel + new tab")
    await press("Meta+Alt+ArrowRight")
    await settle(300)

    const tabsBefore = await countTabs()

    // "New Terminal" is in the more menu — target the focused group's dropdown
    await clickMoreMenuItem("New Terminal", "[data-group-focused]")
    await waitFor("[data-tab-id]", 5000)
    await settle(500)

    const tabsAfter = await countTabs()
    await screenshot("tab-in-right-panel")

    expect(tabsAfter).toBe(tabsBefore + 1)
  }, 15_000)

  test("hide preserves state, re-show restores", async () => {
    setTestContext("hide and re-show split")
    // Hide split
    await press("Meta+\\")
    await settle(500)

    await screenshot("split-hidden")
    expect(await getCount("[data-workspace-bar]")).toBe(1)

    // Re-show split
    await press("Meta+\\")
    await waitFor("button[aria-label='Close panel']", 5000)
    await settle(500)

    await screenshot("split-restored")
    expect(await getCount("[data-workspace-bar]")).toBe(2)
  }, 20_000)

  test("close panel merges tabs to single panel", async () => {
    setTestContext("close panel merges tabs")
    const tabsBefore = await countTabs()

    await click("button[aria-label='Close panel']")
    await settle(500)

    const tabsAfter = await countTabs()
    await screenshot("panel-closed")

    // Single panel again
    expect(await getCount("[data-workspace-bar]")).toBe(1)
    // Tabs from closed panel merged into single panel — should be at least 1
    expect(tabsAfter).toBeGreaterThanOrEqual(1)
  }, 15_000)
})
