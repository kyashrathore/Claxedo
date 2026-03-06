/**
 * 04 — Process Pane
 *
 * Proves: Cmd+Shift+; activates process tab and renders process pane component.
 * Second toggle returns to previous tab. Cmd+1 also activates process tab
 * (index 0).
 *
 * Catches:
 * - `requestToggle()` not toggling
 * - Process pane component not mounting
 * - "Return to previous tab" broken
 * - Tab index off-by-one for pinned tabs
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  settle,
} from "./_helpers"
import { press, isVisible } from "../ab"

const { before, after } = suiteLifecycle("04-process-pane")

describe("04 — process pane", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("process pane not visible initially", async () => {
    setTestContext("process pane not visible initially")
    const visible = await isVisible('[data-component="process-pane"]')
    await screenshot("process-pane-initial")
    expect(visible).toBe(false)
  }, 10_000)

  test("Cmd+Shift+; shows process pane", async () => {
    setTestContext("toggle shows process pane")
    await press("Meta+Shift+;")
    await settle(1500)

    const visible = await isVisible('[data-component="process-pane"]')
    const snap = await snapshot()
    await screenshot("process-pane-shown")

    expect(visible).toBe(true)
    expect(snap).toContain("Processes")
  }, 10_000)

  test("Cmd+Shift+; hides process pane (returns to previous tab)", async () => {
    setTestContext("toggle hides process pane")
    await press("Meta+Shift+;")
    await settle(1500)

    const visible = await isVisible('[data-component="process-pane"]')
    await screenshot("process-pane-hidden")
    expect(visible).toBe(false)
  }, 10_000)

  test("Cmd+1 activates process tab (index 0)", async () => {
    setTestContext("Cmd+1 activates process tab")
    await press("Meta+1")
    await settle(1500)

    const visible = await isVisible('[data-component="process-pane"]')
    await screenshot("process-pane-via-cmd1")
    expect(visible).toBe(true)
  }, 10_000)
})
