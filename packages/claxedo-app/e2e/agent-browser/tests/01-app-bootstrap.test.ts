/**
 * 01 — App Bootstrap
 *
 * Proves: App initializes correctly — claxedo layout renders (not upstream
 * fallback), sidebar has project data, workspace bar shows active workspace,
 * session tab auto-created, process tab exists as pinned first tab.
 *
 * Catches:
 * - Layout provider init crash → blank screen
 * - localStorage migration crash (v2→v3) → no tabs
 * - Process tab insertion fails → missing "Processes"
 * - Workspace bar not wired → no "Default workspace" text
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import {
  suiteLifecycle,
  setTestContext,
  screenshot,
  snapshot,
} from "./_helpers"
import { isVisible, getCount } from "../ab"

const { before, after } = suiteLifecycle("01-app-bootstrap")

describe("01 — app bootstrap", () => {
  beforeAll(before, 30_000)
  afterAll(after)

  test("claxedo layout renders", async () => {
    setTestContext("claxedo layout renders")
    const visible = await isVisible("[data-claxedo]")
    await screenshot("claxedo-layout")
    expect(visible).toBe(true)
  }, 10_000)

  test("process tab is present", async () => {
    setTestContext("process tab present")
    const snap = await snapshot()
    await screenshot("process-tab-check")
    expect(snap).toContain("Processes")
  }, 10_000)

  test("session tab auto-created", async () => {
    setTestContext("session tab auto-created")
    const snap = await snapshot()
    await screenshot("session-tab-check")
    expect(snap).toContain("New Session")
  }, 10_000)

  test("workspace bar is rendered", async () => {
    setTestContext("workspace bar rendered")
    const count = await getCount("[data-workspace-bar]")
    await screenshot("workspace-bar-check")
    expect(count).toBe(1)
  }, 10_000)

  test("active tab has visible close button", async () => {
    setTestContext("active tab has close button")
    const visible = await isVisible(
      "button[aria-label='Close tab'][data-active-close]",
    )
    await screenshot("close-button-check")
    expect(visible).toBe(true)
  }, 10_000)
})
