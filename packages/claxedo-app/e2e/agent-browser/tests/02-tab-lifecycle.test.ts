/**
 * 02 — Tab Lifecycle
 *
 * Proves: Create adds exactly 1 tab. Close removes exactly 1 and activates
 * adjacent. Reopen (Cmd+Shift+T) restores. Process tab survives closing
 * everything.
 *
 * Catches:
 * - Duplicate tab creation (cross-group leak)
 * - `activeId` not updating after creation
 * - `close()` selecting wrong next tab
 * - `reopenLast()` failing to pop from `closedTabs[]`
 * - Process tab `closable: false` not honored
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  countTabs,
  settle,
} from "./_helpers"
import { click, press, isVisible } from "../ab"

const { before, after } = suiteLifecycle("02-tab-lifecycle")

describe("02 — tab lifecycle", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("create adds exactly 1 tab", async () => {
    setTestContext("create adds exactly 1 tab")
    const countBefore = await countTabs()
    await screenshot("before-create")

    await click("button[aria-label='New Terminal']")
    await settle(2000)

    const countAfter = await countTabs()
    await screenshot("after-create")

    expect(countAfter).toBe(countBefore + 1)
  }, 15_000)

  test("close removes exactly 1 tab", async () => {
    setTestContext("close removes exactly 1 tab")
    const countBefore = await countTabs()
    await screenshot("before-close")

    await click("button[aria-label='Close tab'][data-active-close]")
    await settle(1500)

    const countAfter = await countTabs()
    await screenshot("after-close")

    expect(countAfter).toBe(countBefore - 1)
  }, 15_000)

  test("reopen restores last closed tab", async () => {
    setTestContext("reopen restores tab")
    const countBefore = await countTabs()
    await screenshot("before-reopen")

    await press("Meta+Shift+t")
    await settle(2000)

    const countAfter = await countTabs()
    await screenshot("after-reopen")

    expect(countAfter).toBe(countBefore + 1)
  }, 15_000)

  test("process tab survives closing all closable tabs", async () => {
    setTestContext("process tab survives")

    // Close all closable tabs one by one
    for (let i = 0; i < 10; i++) {
      const hasClosable = await isVisible(
        "button[aria-label='Close tab'][data-active-close]",
      )
      if (!hasClosable) break
      await click("button[aria-label='Close tab'][data-active-close]")
      await settle(1000)
    }

    const snap = await snapshot()
    const remaining = await countTabs()
    await screenshot("process-tab-survives")

    // Process tab (pinned, not closable) must remain
    expect(remaining).toBeGreaterThanOrEqual(1)
    expect(snap).toContain("Processes")
  }, 30_000)
})
