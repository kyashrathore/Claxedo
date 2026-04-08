/**
 * 04 — Process Pane
 *
 * Proves: the Processes toolbar action opens the process tab, the active
 * process-tab controls appear, and the tab can be closed and reopened.
 *
 * Catches:
 * - Process tab not opening from the workspace toolbar
 * - Process-tab controls not appearing when active
 * - Process tab close path leaving the UI wedged
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
  settle,
  waitFor,
  runtimeSkip,
} from "./_helpers"
import { click, isVisible } from "../ab"

const { before, after } = suiteLifecycle("04-process-pane")

describe("04 — process pane", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("process controls are hidden initially", async () => {
    setTestContext("process controls hidden initially")
    const visible = await isVisible("button[aria-label='Add process']")
    await screenshot("process-pane-initial")
    expect(visible).toBe(false)
  }, 10_000)

  test("Processes button opens process tab (when processes exist)", async () => {
    setTestContext("processes button opens tab")
    const processVisible = await isVisible("button[aria-label='Processes']")
    if (!processVisible) {
      runtimeSkip("Processes button opens process tab", "Processes button not visible — no active processes in this environment")
      return
    }

    await click("button[aria-label='Processes']")
    await waitFor("button[aria-label='Add process']", 5000)
    await settle(500)

    const visible = await isVisible("button[aria-label='Add process']")
    const snap = await snapshot()
    await screenshot("process-pane-shown")

    expect(visible).toBe(true)
    expect(
      snap.includes("Process not running") ||
        snap.includes("No processes configured") ||
        snap.includes("Start process"),
    ).toBe(true)
  }, 10_000)

  test("closing the active process tab hides process controls", async () => {
    setTestContext("closing process tab hides controls")
    const processVisible = await isVisible("button[aria-label='Add process']")
    if (!processVisible) {
      runtimeSkip("closing process tab", "Process tab not open — previous test was skipped")
      return
    }

    await click("button[aria-label='Close tab'][data-active-close]")
    await settle(500)

    const visible = await isVisible("button[aria-label='Add process']")
    await screenshot("process-pane-hidden")
    expect(visible).toBe(false)
  }, 10_000)

  test("Processes button reopens the process tab (when processes exist)", async () => {
    setTestContext("processes button reopens tab")
    const processVisible = await isVisible("button[aria-label='Processes']")
    if (!processVisible) {
      runtimeSkip("Processes button reopens tab", "Processes button not visible — no active processes in this environment")
      return
    }

    await click("button[aria-label='Processes']")
    await waitFor("button[aria-label='Add process']", 5000)
    await settle(500)

    const visible = await isVisible("button[aria-label='Add process']")
    await screenshot("process-pane-via-cmd1")
    expect(visible).toBe(true)
  }, 10_000)
})
