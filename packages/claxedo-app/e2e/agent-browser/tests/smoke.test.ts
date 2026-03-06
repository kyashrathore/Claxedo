/**
 * Smoke tests for Claxedo using agent-browser.
 *
 * Requires the dev server running at localhost:4444 (or AB_BASE_URL).
 * Run via: bun run test:agent-browser
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { setup, teardown } from "../setup"
import {
  snapshot,
  click,
  press,
  waitFor,
  settle,
  isVisible,
  getText,
  findLabelClick,
  close,
  initScreenshots,
  setTestContext,
  screenshot,
  compileVideo,
} from "../ab"

describe("agent-browser smoke tests", () => {
  beforeAll(async () => {
    initScreenshots()
    await setup()
  }, 30_000)

  afterAll(async () => {
    await compileVideo()
    await teardown()
  })

  test("app loads and shows claxedo UI", async () => {
    setTestContext("app loads and shows claxedo UI")
    const snap = await snapshot()
    await screenshot("app-loaded")

    // The app should have rendered something meaningful
    expect(snap.length).toBeGreaterThan(100)

    // Look for common UI elements in the snapshot
    const hasTabBar =
      snap.includes("tab") || snap.includes("Tab") || snap.includes("terminal")
    const hasButtons = snap.includes("button") || snap.includes("Button")
    expect(hasTabBar || hasButtons).toBe(true)

    console.log(
      "[smoke] App loaded. Snapshot length:",
      snap.length,
      "chars",
    )
  }, 15_000)

  test("tab management: create and close terminal tab", async () => {
    setTestContext("tab management: create and close terminal tab")
    // Snapshot to find current state
    const snapBefore = await snapshot()
    await screenshot("before-new-tab")
    const linesBefore = snapBefore.split("\n")

    // Try to create a new terminal tab via button or keyboard
    const terminalButtonClicked =
      (await findLabelClick("New Terminal").catch(() => null)) ||
      (await findLabelClick("New Claude Terminal").catch(() => null))

    if (!terminalButtonClicked) {
      // Fallback: try keyboard shortcut for new terminal
      await press("Meta+t")
    }

    await settle(2000)
    await screenshot("tab-created")

    const snapAfter = await snapshot()
    console.log(
      "[smoke] After new tab - snapshot length:",
      snapAfter.length,
      "chars",
    )

    // Close the active tab by clicking its visible X button
    // Only the active tab's close button has data-active-close; inactive ones are hidden
    await click("button[aria-label='Close tab'][data-active-close]")
    await settle(1500)
    await screenshot("tab-closed")

    const snapAfterClose = await snapshot()
    console.log(
      "[smoke] After close tab - snapshot length:",
      snapAfterClose.length,
      "chars",
    )
  }, 20_000)

  test("process pane toggle via keyboard", async () => {
    setTestContext("process pane toggle via keyboard")
    // Toggle process pane with Cmd+Shift+;
    await press("Meta+Shift+;")
    await settle(1500)
    await screenshot("process-pane-open")

    const snapWithPane = await snapshot()
    const hasProcessContent =
      snapWithPane.includes("process") ||
      snapWithPane.includes("Process") ||
      snapWithPane.includes("No processes")

    console.log(
      "[smoke] Process pane toggled. Has process content:",
      hasProcessContent,
    )

    // Switch away from process pane (Meta+Shift+; navigates back, doesn't close it)
    await press("Meta+Shift+;")
    await settle(1000)
    await screenshot("switched-from-processes")
  }, 15_000)

  test("split workspace toggle via keyboard", async () => {
    setTestContext("split workspace toggle via keyboard")
    const snapBefore = await snapshot()
    await screenshot("before-split")

    // Create split with Cmd+\
    await press("Meta+\\")
    await settle(2000)
    await screenshot("split-open")

    const snapAfterSplit = await snapshot()
    console.log(
      "[smoke] After split - snapshot delta:",
      snapAfterSplit.length - snapBefore.length,
      "chars",
    )

    // Hide split with Cmd+\ again
    await press("Meta+\\")
    await settle(1500)
    await screenshot("split-hidden")

    const snapAfterHide = await snapshot()
    console.log(
      "[smoke] After hide split - snapshot length:",
      snapAfterHide.length,
      "chars",
    )
  }, 20_000)

  test("multi-pane: split right and close pane", async () => {
    setTestContext("multi-pane: split right and close pane")
    // Check snapshot first to see if split buttons are available
    const snap = await snapshot()
    const hasSplitButton =
      snap.includes("Split right") ||
      snap.includes("Split vertical") ||
      snap.includes("split")

    if (!hasSplitButton) {
      console.log("[smoke] No split button found in snapshot, skipping multi-pane test")
      return
    }

    // Try to find and click split button
    const splitClicked =
      (await findLabelClick("Split vertical").catch(() => null)) ||
      (await findLabelClick("Split right").catch(() => null))

    if (!splitClicked) {
      console.log("[smoke] Could not click split button, skipping")
      return
    }

    await settle(2000)
    await screenshot("multi-pane")

    const snapAfterSplit = await snapshot()
    const hasTwoPanes =
      snapAfterSplit.includes("pane") || snapAfterSplit.includes("group")
    console.log("[smoke] After split-right, has pane references:", hasTwoPanes)

    // Close the pane
    const closePaneClicked = await findLabelClick("Close pane").catch(() => null)

    if (closePaneClicked) {
      await settle(1500)
      console.log("[smoke] Closed split pane")
    } else {
      // Fallback: use keyboard to toggle split off
      await press("Meta+\\")
      await settle(1000)
      console.log("[smoke] Toggled split off via keyboard")
    }
  }, 30_000)
})
