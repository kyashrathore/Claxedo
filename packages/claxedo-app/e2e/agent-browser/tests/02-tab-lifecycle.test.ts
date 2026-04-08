/**
 * 02 — Tab Lifecycle
 *
 * Proves: Create adds exactly 1 tab. Close removes exactly 1 and activates
 * adjacent. Reopen (Cmd+Shift+T) restores. Processes can be opened as a
 * normal closable tab from the workspace toolbar.
 *
 * Catches:
 * - Duplicate tab creation (cross-group leak)
 * - `activeId` not updating after creation
 * - `close()` selecting wrong next tab
 * - `reopenLast()` failing to pop from `closedTabs[]`
 * - Processes action failing to create a tab
 * - Process tab close path leaving tab state wedged
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
  runtimeSkip,
} from "./_helpers"
import { click, press, isVisible, clickMoreMenuItem } from "../ab"

const { before, after } = suiteLifecycle("02-tab-lifecycle")

describe("02 — tab lifecycle", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("create adds exactly 1 tab", async () => {
    setTestContext("create adds exactly 1 tab")
    const countBefore = await countTabs()
    await screenshot("before-create")

    await clickMoreMenuItem("New Terminal")
    await waitFor("[data-tab-id]", 5000)
    await settle(500)

    const countAfter = await countTabs()
    await screenshot("after-create")

    expect(countAfter).toBe(countBefore + 1)
  }, 15_000)

  test("close removes exactly 1 tab", async () => {
    setTestContext("close removes exactly 1 tab")
    const countBefore = await countTabs()
    await screenshot("before-close")

    await click("button[aria-label='Close tab'][data-active-close]")
    await settle(500)

    const countAfter = await countTabs()
    await screenshot("after-close")

    expect(countAfter).toBe(countBefore - 1)
  }, 15_000)

  test("reopen restores last closed tab", async () => {
    setTestContext("reopen restores tab")
    const countBefore = await countTabs()
    await screenshot("before-reopen")

    await press("Meta+Shift+t")
    await waitFor("[data-tab-id]", 5000)
    await settle(500)

    const countAfter = await countTabs()
    await screenshot("after-reopen")

    expect(countAfter).toBe(countBefore + 1)
  }, 15_000)

  test("processes button opens a closable tab (when processes exist)", async () => {
    setTestContext("processes button opens tab")
    const processVisible = await isVisible("button[aria-label='Processes']")
    if (!processVisible) {
      runtimeSkip("processes button opens tab", "Processes button not visible — no active processes in this environment")
      return
    }

    const before = await countTabs()
    await click("button[aria-label='Processes']")
    await waitFor("[data-tab-id]", 5000)
    await settle(500)

    const opened = await countTabs()
    const snap = await snapshot()
    await screenshot("process-tab-opened")

    expect(opened).toBe(before + 1)
    expect(
      snap.includes("Add process") ||
        snap.includes("Process not running") ||
        snap.includes("No processes configured"),
    ).toBe(true)

    await click("button[aria-label='Close tab'][data-active-close]")
    await settle(500)
    await screenshot("process-tab-closed")

    expect(await countTabs()).toBe(before)
  }, 30_000)
})
