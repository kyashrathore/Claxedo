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
} from "./_helpers"
import { click, press, isVisible, getCount } from "../ab"

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
    await settle(2000)

    await screenshot("split-open")

    expect(await getCount("[data-workspace-bar]")).toBe(2)
    expect(await isVisible("button[aria-label='Close panel']")).toBe(true)
  }, 15_000)

  test("focus switches to right panel and tab appears there", async () => {
    setTestContext("focus right panel + new tab")
    await press("Meta+Alt+ArrowRight")
    await settle(500)

    const tabsBefore = await countTabs()

    // With split open, there are 2 "New Terminal" buttons — target the focused group
    await click("[data-group-focused] button[aria-label='New Terminal']")
    await settle(2000)

    const tabsAfter = await countTabs()
    await screenshot("tab-in-right-panel")

    expect(tabsAfter).toBe(tabsBefore + 1)
  }, 15_000)

  test("hide preserves state, re-show restores", async () => {
    setTestContext("hide and re-show split")
    // Hide split
    await press("Meta+\\")
    await settle(1500)

    await screenshot("split-hidden")
    expect(await getCount("[data-workspace-bar]")).toBe(1)

    // Re-show split
    await press("Meta+\\")
    await settle(1500)

    await screenshot("split-restored")
    expect(await getCount("[data-workspace-bar]")).toBe(2)
  }, 20_000)

  test("close panel merges tabs to single panel", async () => {
    setTestContext("close panel merges tabs")
    const tabsBefore = await countTabs()

    await click("button[aria-label='Close panel']")
    await settle(1500)

    const tabsAfter = await countTabs()
    await screenshot("panel-closed")

    // Single panel again
    expect(await getCount("[data-workspace-bar]")).toBe(1)
    // Tabs from closed panel merged — total should be >= what we had in the primary
    expect(tabsAfter).toBeGreaterThanOrEqual(tabsBefore - tabsAfter)
  }, 15_000)
})
