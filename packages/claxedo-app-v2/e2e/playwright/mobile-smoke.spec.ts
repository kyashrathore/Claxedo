import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { expectAssistantReplyVisible, ensureComposerModelSelected, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-mobile-smoke"
const SESSION_ID = "ses_mobile_smoke"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  await page.addInitScript((d: string) => {
    localStorage.clear()
    ;(window as typeof window & { __CLAXEDO__?: { serverUrl?: string; activeDirectory?: string } }).__CLAXEDO__ = {
      serverUrl: window.location.origin,
      activeDirectory: d,
    }
    localStorage.setItem(
      "claxedo.global.dat:server",
      JSON.stringify({
        list: [],
        projects: { local: [{ worktree: d, expanded: true }] },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
  }, dir)
}

async function openWorkbench(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  // WAIT for the composer instead of probing it with a zero-wait `isVisible()`:
  // the app DOES render the composer for `/{slug}/session` at 390px (verified
  // with a standalone probe against the prebuilt preview: invisible at
  // `[data-claxedo]`-paint time, visible well within 15s — the session surface
  // is a lazy chunk), so the instant probe was racy-by-construction. Worse, its
  // fallback — `getByRole("button", { name: "New Session" }).first()` — is a
  // SUBSTRING role match that resolves to the sidebar row's "New session in
  // main" hover action, which lives inside the closed drawer OUTSIDE the 390px
  // viewport; Playwright then retries "element is outside of the viewport"
  // until the 60s test timeout. That fallback click was the entire failure
  // mode of behaviors 2 and 3, not any app regression.
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 15_000 })
}

/** Opens the workspace side panel via the header `workspace-panel-toggle`, the only
 * opener present at a narrow boot: the "Open Processes" toolbar toggle
 * `core-processes.spec.ts` uses renders only once a review/process context is up. */
async function openWorkspacePanel(page: Page) {
  const toggle = page.locator('[data-testid="workspace-panel-toggle"]').first()
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  if ((await toggle.getAttribute("aria-label")) === "Close workspace panel") return
  await toggle.click()
  await expect(page.locator('[data-testid="workspace-panel-shell"]')).toHaveAttribute("data-open", "true", {
    timeout: 10_000,
  })
}

async function sendTurn(page: Page, promptText: string, turn: number) {
  await ensureComposerModelSelected(page)
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await input.click()
  await input.fill(promptText)
  await expect(input).toContainText(promptText, { timeout: 10_000 })
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, `ack ${turn}: ${promptText}`, {
    spec: "mobile-smoke",
    scenario: `seeded-session-turn-${turn}`,
  })
}

function timelineScroller(page: Page) {
  return page.locator('[data-scrollable]:has([data-slot="session-turn-message-content"])').first()
}

/** Mocks the terminal PTY create route (`/api/wr/pty`) so a pane can mount and
 * activate; websocket I/O is not modeled. `GET /pty/agents` reports the agent
 * binaries the machine can start (`workspace-runtime/src/routes/pty.ts`); the
 * creator offers a tile only for an agent named there. */
function installPtyMock(page: Page) {
  let counter = 0
  return page.route("**/api/wr/pty**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "GET" && url.pathname.endsWith("/api/wr/pty/agents")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ installed: ["claude"] }),
      })
      return
    }
    if (request.method() === "POST" && url.pathname.endsWith('/api/wr/pty')) {
      counter += 1
      const body = request.postDataJSON?.() as { title?: string } | undefined
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: `pty_test_${counter}`, title: body?.title ?? `Terminal ${counter}`, cwd: DIR }),
      })
      return
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "true" })
  })
}

/** Playwright's bundled Chromium reports `navigator.platform === "Win32"` regardless of
 * host OS, so the modifier is resolved in the page, not from `process.platform`. */
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const isMac = await page.evaluate(() => /(Mac|iPod|iPhone|iPad)/.test(navigator.platform))
  return isMac ? "Meta" : "Control"
}

/** The compact switcher tab strip only renders while the sidebar is unpinned
 * (`workbench-shell-header.tsx`'s `<Show when={!sidebarPinned()}>`). */
async function unpinSidebarForSwitcher(page: Page) {
  const mod = await modKey(page)
  await page.keyboard.press(`${mod}+b`)
  await expect(page.locator('[data-testid="compact-switcher"]')).toBeVisible({ timeout: 10_000 })
}

function backgroundTitleButtons(page: Page) {
  return page.locator('[data-testid="switcher-title-button"]:not([aria-current="page"])')
}

/** A rendered content slot bound to a live pane (`[data-pane-id]` present — a
 * stashed/unpaned content slot has none). */
function visiblePaneContents(page: Page) {
  return page.locator("[data-workbench-content][data-pane-id]")
}

/** CDP `Input.dispatchTouchEvent`, which drives Chromium's real touch -> PointerEvent
 * synthesis; Playwright's `page.touchscreen` only offers a single-shot `tap()`.
 * Every touch point carries the same `id`: without it Chromium mints a new
 * `pointerId` per event and `useDragSource`'s `pointermove` guard
 * (`event.pointerId !== pointerId`, `pointer-drag.ts`) drops every move.
 * `touchPoints: []` on `touchEnd` is full release. */
async function openTouch(page: Page) {
  const client = await page.context().newCDPSession(page)
  const TOUCH_ID = 7
  return {
    async start(x: number, y: number) {
      await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y, id: TOUCH_ID }] })
    },
    async move(x: number, y: number) {
      await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y, id: TOUCH_ID }] })
    },
    async end() {
      await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    },
    async detach() {
      await client.detach().catch(() => {})
    },
  }
}

/** Long-press-drags from `source` to a point on `targetBox`'s edge (`axis:"x",
 * edgeFraction:0.94` is near the right edge; `axis:"y", edgeFraction:0.08` near the
 * top). Holds longer than `TOUCH_LONG_PRESS_MS` (250ms, `pointer-drag.ts`) before
 * moving; moving first reads as a scroll and aborts the drag. Returns the open touch
 * session so the caller can assert mid-drag state before `.end()`.
 *
 * The path goes down first, then across, in many small steps. The tab strip keeps
 * `touch-action: pan-x`, and Chromium's compositor still arbitrates that axis
 * mid-drag: movement along it yields a native `pointercancel` despite
 * `setPointerCapture()`, so an initial diagonal jump cancels a tab drag. */
async function touchLongPressDragTo(
  page: Page,
  source: { x: number; y: number },
  targetBox: { x: number; y: number; width: number; height: number },
  axis: "x" | "y",
  edgeFraction: number,
) {
  const touch = await openTouch(page)
  await touch.start(source.x, source.y)
  await page.waitForTimeout(400)
  const targetX = axis === "x" ? targetBox.x + targetBox.width * edgeFraction : targetBox.x + targetBox.width / 2
  const targetY = axis === "y" ? targetBox.y + targetBox.height * edgeFraction : targetBox.y + targetBox.height / 2
  const waypointX = source.x + 5
  const waypointY = targetBox.y + targetBox.height / 2
  const STEPS = 20
  const STEP_DELAY_MS = 16 // ~60fps, matching a real touch sample rate
  for (let i = 1; i <= STEPS; i++) {
    await touch.move(source.x + ((waypointX - source.x) * i) / STEPS, source.y + ((waypointY - source.y) * i) / STEPS)
    await page.waitForTimeout(STEP_DELAY_MS)
  }
  for (let i = 1; i <= STEPS; i++) {
    await touch.move(waypointX + ((targetX - waypointX) * i) / STEPS, waypointY + ((targetY - waypointY) * i) / STEPS)
    await page.waitForTimeout(STEP_DELAY_MS)
  }
  return touch
}

// `@core`, not `@happy`: no script or CI job selects `@happy`, and under
// `CLAXEDO_E2E_SUITE=core` the `mobile` project would otherwise match zero tests.
// The `mobile` project's `testMatch` confines this file to iPhone-13 emulation and
// the chromium project `testIgnore`s `mobile-*`, so it never runs at desktop viewport.
test.describe("mobile smoke @core", () => {
  test("mobile sidebar drawer opens via the opener and scrim-closes", async ({ page }) => {
    // The desktop header's "Show Sidebar" button is `md:flex hidden`, so the
    // phone has its own opener (`md:hidden`, rail-sidebar-shell.tsx).
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)

    const opener = page.locator('[data-testid="mobile-sidebar-opener"]')
    const scrim = page.locator('[data-testid="mobile-sidebar-scrim"]')

    await expect(opener).toBeVisible({ timeout: 10_000 })
    await expect(scrim).toHaveCount(0)

    await opener.click()
    await expect(scrim).toBeVisible({ timeout: 5_000 })
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAttribute("aria-expanded", "true")

    const accountTrigger = page.getByTestId("rail-account-trigger")
    await expect(accountTrigger).toBeVisible()
    await accountTrigger.click()
    const accountMenu = page.getByRole("menu")
    await expect(accountMenu).toBeVisible()
    const menuBox = await accountMenu.boundingBox()
    expect(menuBox).not.toBeNull()
    expect(menuBox!.x).toBeGreaterThanOrEqual(0)
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
    await page.keyboard.press("Escape")
    await expect(accountMenu).toHaveCount(0)

    // Tapping the scrim (right of the 280px drawer) closes it; the opener stays
    // visible and flips back to its collapsed state.
    await scrim.click({ position: { x: 340, y: 400 } })
    await expect(scrim).toHaveCount(0)
    await expect(opener).toBeVisible()
    await expect(opener).toHaveAttribute("aria-expanded", "false")
  })

  test("workspace panel renders full-width with no resize handle below 640px", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)

    await openWorkspacePanel(page)
    const panel = page.locator('[data-testid="workspace-panel-shell"]')
    await expect(panel).toHaveAttribute("data-open", "true")

    // Asserted against the raw inline `style`: `toHaveCSS` resolves a percentage
    // width to pixels, so it can never observe the `"100%"` `panelStyleWidth()` writes.
    await expect(panel).toHaveAttribute("style", /(?:^|;)\s*width:\s*100%\s*(?:;|$)/)
    // The box must match the viewport, not a stale fixed desktop width.
    const viewportWidth = page.viewportSize()?.width ?? 0
    const panelBox = await panel.boundingBox()
    expect(panelBox).not.toBeNull()
    expect(Math.abs((panelBox?.width ?? 0) - viewportWidth)).toBeLessThan(4)

    // The resize handle is desktop-only (`!isMobile()`); it must be absent from the
    // DOM, not hidden.
    await expect(panel.locator('[role="separator"][aria-label="Resize workspace panel"]')).toHaveCount(0)
  })

  test("workspace review panel does not auto-open at narrow boot", async ({ page }) => {
    // `route-intent.ts`'s `workspaceBrowse` branch guards `workspacePanel.open("review", …)`
    // on width: at phone width the panel is 100% and would bury the composer with
    // no user action.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await page.goto(`/${slug(DIR)}/session`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    const panel = page.locator('[data-testid="workspace-panel-shell"]')
    if ((await panel.count()) > 0) {
      await expect(panel).toHaveAttribute("data-open", "false", { timeout: 10_000 })
    }
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  })

  test("seeded session timeline scrolls at a narrow viewport", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openWorkbench(page, DIR)

    await sendTurn(page, "mobile smoke turn one", 1)
    await sendTurn(page, "mobile smoke turn two", 2)
    await sendTurn(page, "mobile smoke turn three", 3)

    const scroller = timelineScroller(page)
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    const scrollTopBefore = await scroller.evaluate((el) => el.scrollTop)
    await scroller.hover()
    for (let attempt = 0; attempt < 40; attempt++) {
      await page.mouse.wheel(0, -400)
      const current = await scroller.evaluate((el) => el.scrollTop)
      if (current < scrollTopBefore) break
    }
    const scrollTopAfter = await scroller.evaluate((el) => el.scrollTop)
    expect(scrollTopAfter).toBeLessThan(scrollTopBefore)
  })

  test(
    "long-press-dragging a switcher tab, then a pane grip, splits the workbench via touch",
    async ({ page }) => {
      // TABLET-WIDTH OVERRIDE (this test only): split geometry is UNOBSERVABLE
      // below BP_MD (768, `workbench/collapse-projection.ts`) — the collapse
      // projection renders exactly one full-bleed pane and hides the rest at
      // phone width, so `drop-target-*` / split rects can't be asserted on the
      // `mobile` project's iPhone-13 viewport (390px). Every OTHER scenario in
      // this spec stays at the phone viewport this project emulates; only this
      // one widens past the breakpoint, keeping `hasTouch`/`isMobile` from the
      // `mobile` project's own device descriptor (`playwright.config.ts`).
      await page.setViewportSize({ width: 1024, height: 900 })

      await seedOneProject(page, DIR)
      await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
      await installPtyMock(page)
      await openWorkbench(page, DIR)
      await unpinSidebarForSwitcher(page)
      await expect(page.locator('[data-testid="session-content"][data-session-id="new"]')).toBeVisible({
        timeout: 20_000,
      })

      // Second surface: a mocked terminal. Creating it focuses it and backgrounds
      // the draft: 2 switcher tabs, 1 visible pane, nothing split yet.
      await page.locator('[data-testid="workspace-scope-new-terminal"]').first().click()
      const launchers = page.locator('[data-component="terminal-new-launchers"]')
      await expect(launchers).toBeVisible({ timeout: 20_000 })
      await launchers.locator('[data-slot="terminal-launcher"][data-launcher-id="claude"]').first().click()
      await expect(page.locator('[data-testid="terminal-pane"]')).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('[data-testid="compact-switcher-tab"]')).toHaveCount(2, { timeout: 10_000 })

      const backgroundTab = backgroundTitleButtons(page).first()
      const tabBox = await backgroundTab.boundingBox()
      const terminalPane = page
        .locator('[data-workbench-content][data-pane-id]')
        .filter({ has: page.locator('[data-testid="terminal-pane"]') })
      const terminalPaneId = await terminalPane.getAttribute("data-pane-id")
      const terminalPaneBox = await terminalPane.boundingBox()
      expect(tabBox).not.toBeNull()
      expect(terminalPaneId).not.toBeNull()
      expect(terminalPaneBox).not.toBeNull()
      if (!tabBox || !terminalPaneId || !terminalPaneBox) return

      const tabDrag = await touchLongPressDragTo(
        page,
        { x: tabBox.x + tabBox.width / 2, y: tabBox.y + tabBox.height / 2 },
        terminalPaneBox,
        "x",
        0.94, // near the right edge — `computeDropEdge` resolves to "right"
      )
      // The overlay shows the pointer stream reached the drop zone's hit-test
      // (`registerDropZone.onMove`), not just the source's `pointerdown`.
      await expect(page.locator(`[data-testid="drop-target-${terminalPaneId}"]`)).toBeVisible({ timeout: 5_000 })
      await tabDrag.end()
      await tabDrag.detach()

      await expect(page.locator('[data-testid="workbench-divider"]')).toBeVisible({ timeout: 10_000 })
      await expect(visiblePaneContents(page)).toHaveCount(2, { timeout: 10_000 })

      // --- Part 2: long-press-drag the draft pane's own grip onto the terminal
      //     pane's top edge. Re-query the draft's pane after the split above —
      //     it now lives in a freshly-created pane, not its pre-split slot.
      const draftPane = page
        .locator('[data-workbench-content][data-pane-id]')
        .filter({ has: page.locator('[data-testid="session-content"][data-session-id="new"]') })
      const draftPaneId = await draftPane.getAttribute("data-pane-id")
      expect(draftPaneId).not.toBeNull()
      if (!draftPaneId) return

      const grip = page.locator(`[data-testid="pane-handle-${draftPaneId}"]`)
      const gripBox = await grip.boundingBox()
      const terminalPaneBoxBeforeGripDrag = await terminalPane.boundingBox()
      const draftBoxBeforeGripDrag = await draftPane.boundingBox()
      expect(gripBox).not.toBeNull()
      expect(terminalPaneBoxBeforeGripDrag).not.toBeNull()
      if (!gripBox || !terminalPaneBoxBeforeGripDrag) return

      const gripDrag = await touchLongPressDragTo(
        page,
        { x: gripBox.x + gripBox.width / 2, y: gripBox.y + gripBox.height / 2 },
        terminalPaneBoxBeforeGripDrag,
        "y",
        0.08, // near the top edge — `computeDropEdge` resolves to "top"
      )
      await expect(page.locator(`[data-testid="drop-target-${terminalPaneId}"]`)).toBeVisible({ timeout: 5_000 })
      await gripDrag.end()
      await gripDrag.detach()

      // The dragged pane's own slot is now empty (`reducers/split.ts`'s `split()`
      // unbinds the source pane rather than deleting it) and the draft content's
      // box has moved.
      await expect(page.locator(`[data-testid="pane-${draftPaneId}"] [data-testid="empty"]`)).toBeVisible({
        timeout: 10_000,
      })
      const draftContentAfter = page
        .locator('[data-workbench-content][data-pane-id]')
        .filter({ has: page.locator('[data-testid="session-content"][data-session-id="new"]') })
      await expect(draftContentAfter).toHaveCount(1)
      const draftBoxAfterGripDrag = await draftContentAfter.boundingBox()
      expect(draftBoxAfterGripDrag).not.toBeNull()
      if (draftBoxBeforeGripDrag && draftBoxAfterGripDrag) {
        expect(
          draftBoxAfterGripDrag.x !== draftBoxBeforeGripDrag.x ||
            draftBoxAfterGripDrag.y !== draftBoxBeforeGripDrag.y ||
            draftBoxAfterGripDrag.width !== draftBoxBeforeGripDrag.width ||
            draftBoxAfterGripDrag.height !== draftBoxBeforeGripDrag.height,
        ).toBe(true)
      }
    },
  )
})
