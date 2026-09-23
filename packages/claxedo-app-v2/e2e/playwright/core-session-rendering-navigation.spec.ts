/**
 * Session-to-terminal navigation must publish the focused surface's route before
 * background session resolution can reclaim focus. The mock streams a real turn
 * transition through its HTTP event endpoint; no terminal process is launched here.
 * Rail visits must be made through the UI: direct URL navigation creates browser
 * history entries independently of the workbench's route publication.
 * File tabs share a workspace working set; session-return checks must choose
 * different files through the panel before inspecting the restored selection.
 */
import { expect, test } from "@playwright/test"
import { installMockRuntime } from "../helpers/mock-runtime"
import { ensureComposerModelSelected, expectAssistantReplyVisible, selectComposerAgent, SELECTORS } from "../helpers/turn-oracle"
import { expectRailRowVisible } from "../helpers/rail-oracle"
import { readControlLabelSpacing } from "../helpers/geometry-oracle"
import { writeFile } from "node:fs/promises"

test("the harness selector keeps its caret beside a short model label @core", async ({ page }, testInfo) => {
  const dir = "/tmp/e2e-harness-trigger-spacing"
  await installMockRuntime(page, { dir, harness: "claude-sdk" })
  await page.goto(`/${Buffer.from(dir).toString("base64url")}/session`)
  await selectComposerAgent(page, "Claude Code")
  await ensureComposerModelSelected(page)
  await page.locator('[data-component="prompt-input"]').last().fill("compact selector reply")
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: compact selector reply")
  const trigger = page.locator('[data-action="prompt-harness-model"]').last()
  const geometry = await readControlLabelSpacing(trigger)
  await writeFile(testInfo.outputPath("harness-trigger-spacing.json"), JSON.stringify(geometry, null, 2))
  await page.screenshot({ path: testInfo.outputPath("harness-trigger.png") })
  expect(geometry.textWidth).toBeLessThan(120)
  expect(geometry.caretGap, "short model label and caret stay adjacent").toBeLessThanOrEqual(16)
})

test("browser Back and Forward preserve a chat visit made through the rail @core", async ({ page }) => {
  const dir = "/tmp/e2e-session-browser-history"
  const sessionId = "ses_browser_history"
  await installMockRuntime(page, {
    dir,
    sessionId,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({
      list: [], projects: { local: [{ worktree: directory, expanded: true }] },
      lastProject: {}, workspaceServer: {}, closedProjects: {},
    }))
  }, dir)
  await page.goto(`/${Buffer.from(dir).toString("base64url")}/session`)
  await ensureComposerModelSelected(page)
  await page.locator('[data-component="prompt-input"]').last().fill("history reply")
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: history reply")
  await page.getByRole("button", { name: "New Session", exact: true }).last().click()
  await expect(page).toHaveURL(/\/session$/)
  const draftUrl = page.url()
  const row = await expectRailRowVisible({ page, sessionId })
  await row.click()
  await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`))
  await expectAssistantReplyVisible(page, "ack 1: history reply")
  await page.goBack()
  await expect(page).toHaveURL(draftUrl)
  await page.goForward()
  await expect(page).toHaveURL(new RegExp(`/s/${sessionId}$`))
  await expectAssistantReplyVisible(page, "ack 1: history reply")
})

test("New Terminal stays focused when opened from a completed chat @core @first-interaction", async ({ page }) => {
  const directory = "/tmp/e2e-session-terminal-navigation"
  const sessionId = "ses_terminal_navigation"
  await installMockRuntime(page, {
    dir: directory,
    sessionId,
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
  })
  await page.addInitScript((dir) => {
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({
      list: [], projects: { local: [{ worktree: dir, expanded: true }] },
      lastProject: {}, workspaceServer: {}, closedProjects: {},
    }))
  }, directory)
  await page.goto(`/${Buffer.from(directory).toString("base64url")}/session`)
  await ensureComposerModelSelected(page)
  await page.locator('[data-component="prompt-input"]').last().fill("terminal navigation probe")
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: terminal navigation probe")
  await page.goto(`/s/${sessionId}`)
  await expectAssistantReplyVisible(page, "ack 1: terminal navigation probe")
  await page.getByRole("button", { name: "New Terminal", exact: true }).last().click()
  const launcher = page.locator('[data-slot="terminal-launcher"][data-launcher-id="shell"]')
  await expect(launcher).toBeVisible()
  await expect(page).toHaveURL(/\/terminal\/new$/)
  await page.reload()
  await expect(launcher).toBeVisible()
  await page.screenshot({ path: "test-results/evidence/core-session-rendering-navigation/terminal-creator-after-reload.png" })
})

// Hold real requests rather than guessing a sleep long enough for a slow boot.
function gate() {
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  return { pending, release }
}

test("cold boot keeps one steady logo through shell readiness and accepts the first prompt @core @first-interaction", async ({ page }, testInfo) => {
  const dir = "/tmp/e2e-cold-boot-first-prompt"
  const mock = await installMockRuntime(page, {
    dir,
    sessionId: "ses_cold_boot_first_prompt",
    harnessModels: { opencode: [{ id: "gpt-5", name: "GPT-5" }] },
  })
  await page.addInitScript(() => {
    const samples: { logo: number; shell: boolean; composer: boolean }[] = []
    Object.assign(window, { __bootContinuityProbe: samples })
    let started = false
    const sample = () => {
      const visible = (element: Element) => {
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.top >= innerHeight) return false
        for (let parent: Element | null = element; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent)
          if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false
        }
        return true
      }
      const logo = [...document.querySelectorAll('[data-component="claxedo-splash"]')].filter(visible).length
      const shell = [...document.querySelectorAll("[data-claxedo]")].some(visible)
      const composer = [...document.querySelectorAll('[data-component="prompt-input"]')].some(visible)
      started ||= logo > 0
      if (started) samples.push({ logo, shell, composer })
      if (samples.length < 600) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  })
  const shell = gate()
  let requested = false
  await page.route(/\/assets\/app-shell-[^/]+\.js$/, async route => {
    // The bootstrap is a different lazy boundary; let it reveal its fallback.
    if (route.request().url().includes("app-shell-bootstrap-")) return route.continue()
    requested = true
    await shell.pending
    await route.continue()
  })
  try {
    await page.goto(`/${Buffer.from(dir).toString("base64url")}/session`, { waitUntil: "domcontentloaded" })
    await expect.poll(() => requested).toBe(true)
    const splash = page.locator('[data-component="claxedo-splash"]:visible')
    await expect(splash).toHaveCount(1)
    const frames = await splash.evaluate(async element => {
      const samples: { opacity: string; animation: string; visible: boolean }[] = []
      for (let frame = 0; frame < 45; frame++) {
        await new Promise(requestAnimationFrame)
        const style = getComputedStyle(element)
        samples.push({ opacity: style.opacity, animation: style.animationName, visible: element.getBoundingClientRect().width > 0 })
      }
      return samples
    })
    expect(frames.every(frame => frame.visible && frame.animation === "none" && frame.opacity === frames[0].opacity)).toBe(true)
    await testInfo.attach("boot-held", {
      body: await page.screenshot({ path: testInfo.outputPath("boot-held.png") }), contentType: "image/png",
    })
  } finally {
    shell.release()
  }
  await expect(page.locator("[data-claxedo]")).toBeVisible()
  await expect(page.locator('[data-component="claxedo-splash"]:visible')).toHaveCount(0)
  const samples = await page.evaluate(async () => {
    for (let frame = 0; frame < 45; frame++) await new Promise(requestAnimationFrame)
    return (window as unknown as { __bootContinuityProbe: { logo: number; shell: boolean; composer: boolean }[] }).__bootContinuityProbe
  })
  await testInfo.attach("boot-frames", { body: JSON.stringify(samples), contentType: "application/json" })
  expect(samples.length).toBeGreaterThan(45)
  expect(samples.every(frame => frame.logo <= 1)).toBe(true)
  // The shell container can mount with only a top divider while the cold draft is still empty.
  expect.soft(samples.filter(frame => frame.logo === 0 && !frame.composer), "the splash stays until the draft composer is visibly rendered").toEqual([])
  const revealed = samples.findIndex(frame => frame.composer && frame.logo === 0)
  expect(revealed).toBeGreaterThanOrEqual(0)
  expect(samples.slice(revealed).every(frame => frame.logo === 0 && frame.shell)).toBe(true)
  await ensureComposerModelSelected(page)
  await page.locator('[data-component="prompt-input"]').last().fill("cold boot first reply")
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: cold boot first reply")
  expect(mock.requests.createSessionCount).toBe(1)
  expect(mock.requests.promptCount).toBe(1)
  expect(mock.requests.unhandled).toEqual([])
})

for (const width of [1280, 720]) test(`permission control is visible before hydration and preserves composer geometry at ${width}px @core @first-interaction`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 800 })
  const dir = "/tmp/e2e-composer-geometry"
  const permissions = gate()
  const models = gate()
  let permissionRequested = false
  let modelRequested = false
  await installMockRuntime(page, {
    dir, harness: "claude-sdk", existingSession: { prompt: "geometry", reply: "geometry ready" },
    beforePermissionModesResponse: async () => { permissionRequested = true; await permissions.pending },
  })
  await page.route("**/api/claxedo/agent-config/harness/options**", async route => { modelRequested = true; await models.pending; await route.fallback() })
  try {
    await page.goto(`/${Buffer.from(dir).toString("base64url")}/session`)
    const controls = page.locator('[data-slot="composer-selection-controls"]').last()
    await expect(controls).toBeVisible()
    await expect.poll(() => permissionRequested && modelRequested).toBe(true)
    const before = await controls.boundingBox()
    const editor = page.locator('[data-component="prompt-input"]').last()
    const editorBefore = await editor.boundingBox()
    await page.screenshot({ path: testInfo.outputPath("permission-before-hydration.png") })
    const permission = page.locator('[data-action="prompt-permission-mode"]').last()
    await expect.soft(permission, "permission control has visible content before its report arrives").toBeVisible({ timeout: 1000 })
    models.release()
    permissions.release()
    await expect(page.locator('[data-action="prompt-permission-mode"]').last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Select harness and model" }).last()).not.toContainText(/Loading|Select agent/)
    const after = await controls.boundingBox()
    const editorAfter = await editor.boundingBox()
    // The cluster is right-anchored and its trigger is content-sized: a resolved
    // label legitimately differs in width from the loading text. What must not
    // move is the anchored right edge, the row's height, or its vertical slot.
    expect(after?.y).toBe(before?.y)
    expect(after?.height).toBe(before?.height)
    expect(after!.x + after!.width).toBeCloseTo(before!.x + before!.width, 1)
    expect(editorAfter).toEqual(editorBefore)
    await page.screenshot({ path: `test-results/evidence/core-session-rendering-navigation/toolbar-ready-${width}.png` })
    await selectComposerAgent(page, "Claude Code")
    await ensureComposerModelSelected(page)
    await page.locator('[data-component="prompt-input"]').last().fill("permission hydration reply")
    await page.locator(SELECTORS.submitControl).last().click()
    await expectAssistantReplyVisible(page, "ack 1: permission hydration reply")
  } finally {
    models.release()
    permissions.release()
  }
})


test("workspace file selection returns to the file chosen by each session @core", async ({ page }, testInfo) => {
  const dir = "/tmp/e2e-session-file-selection"
  const sessionId = "ses_file_selection_a"
  const otherId = "ses_file_selection_b"
  const mock = await installMockRuntime(page, {
    dir, sessionId,
    otherSessions: [{ id: otherId, title: "File selection B", prompt: "Second file session", reply: "Second file session reply" }],
    workspaceFiles: [
      { path: "first.txt", content: "First session file contents" },
      { path: "second.txt", content: "Second session file contents" },
    ],
  })
  await page.addInitScript((directory) => {
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({
      list: [], projects: { local: [{ worktree: directory, expanded: true }] },
      lastProject: {}, workspaceServer: {}, closedProjects: {},
    }))
  }, dir)
  await page.goto(`/${Buffer.from(dir).toString("base64url")}/session`)
  await ensureComposerModelSelected(page)
  await page.locator('[data-component="prompt-input"]').last().fill("First file session")
  await page.locator(SELECTORS.submitControl).last().click()
  await expectAssistantReplyVisible(page, "ack 1: First file session", { spec: "core-session-rendering-navigation", scenario: `file-first-${testInfo.repeatEachIndex}` })
  await page.getByRole("button", { name: "Open workspace panel", exact: true }).click()
  await page.locator('[data-file-tree-path="first.txt"]').click()
  const selectedTab = page.locator('[data-slot="workspace-tab"][data-selected="true"]')
  await expect(selectedTab).toHaveAttribute("data-workspace-tab-id", "file://first.txt")
  await page.screenshot({ path: testInfo.outputPath("file-a-selected.png") })
  await (await expectRailRowVisible({ page, sessionId: otherId })).click()
  await expectAssistantReplyVisible(page, "Second file session reply", { spec: "core-session-rendering-navigation", scenario: `file-second-${testInfo.repeatEachIndex}` })
  const openPanel = page.getByRole("button", { name: "Open workspace panel", exact: true })
  if (await openPanel.isVisible()) await openPanel.click()
  await page.locator('[data-file-tree-path="second.txt"]').click()
  await expect(selectedTab).toHaveAttribute("data-workspace-tab-id", "file://second.txt")
  await page.screenshot({ path: testInfo.outputPath("file-b-selected.png") })
  await (await expectRailRowVisible({ page, sessionId })).click()
  await expectAssistantReplyVisible(page, "ack 1: First file session", { spec: "core-session-rendering-navigation", scenario: `file-return-${testInfo.repeatEachIndex}` })
  await page.screenshot({ path: testInfo.outputPath("file-a-return.png") })
  expect(mock.requests.unhandled).toEqual([])
  await expect(selectedTab).toHaveAttribute("data-workspace-tab-id", "file://first.txt")
})

test("a human turn landing on another pane reorders this pane's rail @core", async ({ page }, testInfo) => {
  const dir = "/tmp/e2e-rail-cross-pane-recency"
  const sessionA = "ses_rail_recency_a"
  const sessionB = "ses_rail_recency_b"
  const mock = await installMockRuntime(page, {
    dir,
    sessionId: "ses_rail_recency_main",
    otherSessions: [
      { id: sessionA, title: "Earlier session", prompt: "earlier prompt", reply: "earlier reply" },
      { id: sessionB, title: "Later session", prompt: "later prompt", reply: "later reply" },
    ],
  })
  await page.addInitScript((d: string) => {
    localStorage.clear()
    localStorage.setItem("claxedo.global.dat:server", JSON.stringify({
      list: [], projects: { local: [{ worktree: d, expanded: true }] },
      lastProject: {}, workspaceServer: {}, closedProjects: {},
    }))
  }, dir)
  await page.goto(`/${Buffer.from(dir).toString("base64url")}/session`)
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expectRailRowVisible({ page, sessionId: sessionB, index: 0 })
  await expectRailRowVisible({ page, sessionId: sessionA, index: 1 })

  // The submitting pane bumps its own rail optimistically; this pane only sees
  // the user message's `message.updated` on the directory stream.
  const sentAt = Date.now() + 60_000
  mock.emit({
    type: "message.updated",
    properties: {
      info: { id: "msg_rail_recency", role: "user", sessionID: sessionA, time: { created: sentAt, completed: sentAt } },
    },
  })
  await expectRailRowVisible({ page, sessionId: sessionA, index: 0 })
  await expectRailRowVisible({ page, sessionId: sessionB, index: 1 })
  await page.screenshot({ path: testInfo.outputPath("rail-recency.png") })

  // A replayed stale message must not drag the row back down.
  mock.emit({
    type: "message.updated",
    properties: {
      info: { id: "msg_rail_recency_old", role: "user", sessionID: sessionB, time: { created: 1, completed: 1 } },
    },
  })
  await expectRailRowVisible({ page, sessionId: sessionA, index: 0 })
  await expectRailRowVisible({ page, sessionId: sessionB, index: 1 })
  expect(mock.requests.unhandled).toEqual([])
})
