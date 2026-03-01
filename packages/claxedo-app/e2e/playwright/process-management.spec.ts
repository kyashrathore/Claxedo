/**
 * Process Management E2E Tests
 *
 * Tests the process pane UI:
 * 1. Toggle process pane via keyboard shortcut
 * 2. See empty state
 * 3. Open "Add Process" dialog, fill form, submit
 * 4. See process appear in pane
 * 5. Start the process
 * 6. Close pane and reopen — verify state persists
 *
 * Uses Playwright route interception to mock HTTP APIs
 * so the test runs without a live backend.
 */

import { test, expect, type Page, type Route } from "@playwright/test"

// ── Constants ───────────────────────────────────────────────────────────

const PANE_SELECTOR = '[data-component="process-pane"]'
const modKey = process.platform === "darwin" ? "Meta" : "Control"

/** Fake workspace directory for testing */
const TEST_DIR = "/tmp/e2e-process-test"

/** URL-safe base64 encode (matches @opencode-ai/util/encode) */
function base64Encode(value: string): string {
  const bytes = Buffer.from(value, "utf-8")
  return bytes.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

const TEST_DIR_SLUG = base64Encode(TEST_DIR)
const SESSION_URL = `/${TEST_DIR_SLUG}/session`

// ── Helpers ─────────────────────────────────────────────────────────────

/** Seed localStorage so the app recognizes our fake project */
async function seedApp(page: Page) {
  await page.addInitScript(
    (args: { directory: string; slug: string }) => {
      // Seed server/project storage so the workspace is recognized
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [{ worktree: args.directory, expanded: true }],
          },
          lastProject: {},
        }),
      )

      // Seed model storage to prevent model picker blocking
      localStorage.setItem(
        "opencode.global.dat:model",
        JSON.stringify({
          recent: [{ providerID: "opencode", modelID: "test-model" }],
          user: [],
          variant: {},
        }),
      )
    },
    { directory: TEST_DIR, slug: TEST_DIR_SLUG },
  )
}

/** Wait for the app to finish loading */
async function waitForAppReady(page: Page) {
  // Wait for a key UI element that indicates the layout has rendered
  await page.waitForLoadState("domcontentloaded")
  // The workspace bar or empty state should be visible
  await expect(
    page.locator('[data-claxedo]'),
  ).toBeVisible({ timeout: 30_000 })
  // Small delay for SolidJS reactivity to settle
  await page.waitForTimeout(500)
}

/** Toggle process pane — uses keyboard shortcut mod+shift+; */
async function toggleProcessPane(page: Page) {
  // Click the page body to ensure focus, then try keyboard shortcut
  await page.locator("body").click({ position: { x: 400, y: 300 } })
  await page.waitForTimeout(100)

  // Use keyboard.down/up to send the combo (mod+shift+;)
  if (modKey === "Meta") {
    await page.keyboard.down("Meta")
  } else {
    await page.keyboard.down("Control")
  }
  await page.keyboard.down("Shift")
  await page.keyboard.press(";")
  await page.keyboard.up("Shift")
  if (modKey === "Meta") {
    await page.keyboard.up("Meta")
  } else {
    await page.keyboard.up("Control")
  }

  // Give the framework a moment to react
  await page.waitForTimeout(200)
}

/** Wait for the process pane to become visible */
async function waitForPaneVisible(page: Page) {
  const pane = page.locator(PANE_SELECTOR)
  await expect(pane).toBeVisible({ timeout: 10_000 })
  return pane
}

/** Wait for the process pane to be hidden */
async function waitForPaneHidden(page: Page) {
  const pane = page.locator(PANE_SELECTOR)
  await expect(pane).toBeHidden({ timeout: 5000 })
}

// ── Mock data ───────────────────────────────────────────────────────────

let nextConfigId = 1
let mockConfigs: any[] = []
let mockProcesses: any[] = []

function resetMockData() {
  nextConfigId = 1
  mockConfigs = []
  mockProcesses = []
}

function createMockConfig(body: any) {
  const config = {
    id: `cfg-${nextConfigId++}`,
    name: body.name,
    command: body.command,
    args: [],
    cwd: body.cwd || "",
    env: body.env || {},
    autoStart: body.autoStart ?? false,
    restartPolicy: body.restartPolicy ?? "never",
    maxRestarts: body.maxRestarts ?? 3,
    color: body.color || "",
  }
  mockConfigs.push(config)
  return config
}

function startMockProcess(configId: string) {
  const existing = mockProcesses.find((p) => p.configId === configId)
  if (existing) {
    existing.status = "running"
    existing.ptyId = `pty-${configId}`
    existing.startedAt = Date.now()
    existing.exitedAt = undefined
    existing.exitCode = undefined
    return existing
  }
  const proc = {
    configId,
    ptyId: `pty-${configId}`,
    status: "running",
    restartCount: 0,
    startedAt: Date.now(),
  }
  mockProcesses.push(proc)
  return proc
}

function stopMockProcess(configId: string) {
  const proc = mockProcesses.find((p) => p.configId === configId)
  if (proc) {
    proc.status = "stopped"
    proc.exitCode = 0
    proc.exitedAt = Date.now()
  }
  return !!proc
}

// ── Route interception ──────────────────────────────────────────────────

async function setupAPIMocks(page: Page) {
  resetMockData()

  // Only intercept fetch/XHR API calls, never document navigations.
  // The `resourceType` check prevents route mocks from hijacking SPA navigation.
  const isAPICall = (route: Route) => {
    const type = route.request().resourceType()
    return type === "fetch" || type === "xhr"
  }

  // Mock SSE event stream — return empty and close
  await page.route("**/event?**", async (route: Route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "data: {}\n\n",
    })
  })

  // Mock /path endpoint
  await page.route("**/path", async (route: Route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ worktree: TEST_DIR }),
    })
  })

  // Mock /session endpoints (list returns empty)
  await page.route("**/session", async (route: Route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })
  await page.route("**/session/**", async (route: Route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  // GET/POST /process/
  await page.route("**/process/", async (route: Route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ configs: mockConfigs, processes: mockProcesses }),
      })
    } else if (route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      const config = createMockConfig(body)
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(config),
      })
    } else {
      await route.continue()
    }
  })

  // POST /process/:id/start
  await page.route("**/process/*/start", async (route: Route) => {
    const url = route.request().url()
    const match = url.match(/\/process\/([^/]+)\/start/)
    const configId = match?.[1]
    if (!configId) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) })
      return
    }
    const proc = startMockProcess(configId)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(proc),
    })
  })

  // POST /process/:id/stop
  await page.route("**/process/*/stop", async (route: Route) => {
    const url = route.request().url()
    const match = url.match(/\/process\/([^/]+)\/stop/)
    const configId = match?.[1]
    if (!configId) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) })
      return
    }
    stopMockProcess(configId)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(true),
    })
  })

  // POST /process/:id/restart
  await page.route("**/process/*/restart", async (route: Route) => {
    const url = route.request().url()
    const match = url.match(/\/process\/([^/]+)\/restart/)
    const configId = match?.[1]
    if (!configId) {
      await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) })
      return
    }
    stopMockProcess(configId)
    const proc = startMockProcess(configId)
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(proc),
    })
  })

  // POST /process/start-all
  await page.route("**/process/start-all", async (route: Route) => {
    for (const c of mockConfigs) {
      if (c.autoStart) startMockProcess(c.id)
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(true),
    })
  })

  // POST /process/stop-all
  await page.route("**/process/stop-all", async (route: Route) => {
    for (const p of mockProcesses) {
      p.status = "stopped"
      p.exitCode = 0
      p.exitedAt = Date.now()
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(true),
    })
  })

  // PUT/DELETE /process/:id
  await page.route(/\/process\/[^/]+$/, async (route: Route) => {
    const url = route.request().url()
    const method = route.request().method()

    if (method === "GET") {
      await route.continue()
      return
    }

    const match = url.match(/\/process\/([^/]+)$/)
    const configId = match?.[1]

    if (!configId) {
      await route.continue()
      return
    }

    if (method === "PUT") {
      const body = route.request().postDataJSON()
      const idx = mockConfigs.findIndex((c: any) => c.id === configId)
      if (idx === -1) {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) })
        return
      }
      mockConfigs[idx] = { ...mockConfigs[idx], ...body }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockConfigs[idx]),
      })
    } else if (method === "DELETE") {
      const idx = mockConfigs.findIndex((c: any) => c.id === configId)
      if (idx === -1) {
        await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not found" }) })
        return
      }
      mockConfigs.splice(idx, 1)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(true),
      })
    } else {
      await route.continue()
    }
  })
}

// ── Tests ───────────────────────────────────────────────────────────────

test.describe("Process Management", () => {
  test.beforeEach(async ({ page }) => {
    await seedApp(page)
    await setupAPIMocks(page)
    await page.goto(SESSION_URL)
    await waitForAppReady(page)
  })

  test("toggle pane shows empty state and hides on re-toggle", async ({ page }) => {
    // Pane should be hidden initially
    await waitForPaneHidden(page)

    // Toggle open — should see empty state
    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)
    await expect(pane.getByText("No processes configured")).toBeVisible()
    await expect(pane.getByRole("button", { name: "Add Process", exact: true })).toBeVisible()

    // Toggle closed
    await toggleProcessPane(page)
    await waitForPaneHidden(page)
  })

  test("add process via dialog", async ({ page }) => {
    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    // Click "Add Process" in empty state
    await pane.getByRole("button", { name: "Add Process", exact: true }).click()

    // Dialog should appear
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Add Process")).toBeVisible()

    // Fill in name
    const nameInput = dialog.locator('input[type="text"]').first()
    await nameInput.fill("Dev Server")

    // Fill in command
    const commandInput = dialog.locator('input[type="text"]').nth(1)
    await commandInput.fill("echo hello")

    // Submit
    await dialog.getByRole("button", { name: "Add", exact: true }).click()

    // Dialog should close
    await expect(dialog).toBeHidden({ timeout: 5000 })

    // Toast should appear
    await expect(page.getByText("Process created")).toBeVisible({ timeout: 3000 })
  })

  test("add process via header + button", async ({ page }) => {
    // Pre-seed a config so the header "+" is visible
    mockConfigs.push({
      id: "cfg-existing",
      name: "Existing",
      command: "echo existing",
      args: [],
      cwd: "",
      env: {},
      autoStart: false,
      restartPolicy: "never",
      maxRestarts: 3,
      color: "",
    })

    await page.reload()
    await waitForAppReady(page)

    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    // Click header "+" (aria-label="Add process")
    await pane.getByRole("button", { name: "Add process" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Add Process")).toBeVisible()

    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden({ timeout: 3000 })
  })

  test("dialog form validation — submit disabled without required fields", async ({ page }) => {
    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)
    await pane.getByRole("button", { name: "Add Process", exact: true }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    const addButton = dialog.getByRole("button", { name: "Add", exact: true })
    await expect(addButton).toBeDisabled()

    // Fill just name — still disabled
    const nameInput = dialog.locator('input[type="text"]').first()
    await nameInput.fill("Test")
    await expect(addButton).toBeDisabled()

    // Fill command — enabled
    const commandInput = dialog.locator('input[type="text"]').nth(1)
    await commandInput.fill("echo test")
    await expect(addButton).toBeEnabled()

    // Clear name — disabled
    await nameInput.clear()
    await expect(addButton).toBeDisabled()
  })

  test("dialog env variables — add and remove", async ({ page }) => {
    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)
    await pane.getByRole("button", { name: "Add Process", exact: true }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    await dialog.getByText("Add variable").click()

    const keyInput = dialog.locator('input[placeholder="KEY"]')
    const valueInput = dialog.locator('input[placeholder="value"]')
    await expect(keyInput).toBeVisible()
    await expect(valueInput).toBeVisible()

    await keyInput.fill("NODE_ENV")
    await valueInput.fill("development")

    await dialog.getByText("Add variable").click()
    await expect(dialog.locator('input[placeholder="KEY"]')).toHaveCount(2)

    // Remove first
    await dialog.getByRole("button", { name: "Remove variable" }).first().click()
    await expect(dialog.locator('input[placeholder="KEY"]')).toHaveCount(1)
  })

  test("minimize pane button", async ({ page }) => {
    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    await pane.getByRole("button", { name: "Minimize process pane" }).click()
    await waitForPaneHidden(page)
  })

  test("start and stop all buttons visible when configs exist", async ({ page }) => {
    mockConfigs.push({
      id: "cfg-1",
      name: "Server",
      command: "echo server",
      args: [],
      cwd: "",
      env: {},
      autoStart: false,
      restartPolicy: "never",
      maxRestarts: 3,
      color: "#3b82f6",
    })

    await page.reload()
    await waitForAppReady(page)

    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    await expect(pane.getByText("Start All")).toBeVisible()
    await expect(pane.getByText("Stop All")).toBeVisible()
  })

  test("full happy flow: create, start, close, reopen", async ({ page }) => {
    // 1. Toggle pane open
    await toggleProcessPane(page)
    let pane = await waitForPaneVisible(page)

    // 2. Verify empty state
    await expect(pane.getByText("No processes configured")).toBeVisible()

    // 3. Create a process via dialog
    await pane.getByRole("button", { name: "Add Process", exact: true }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    await dialog.locator('input[type="text"]').first().fill("Dev Server")
    await dialog.locator('input[type="text"]').nth(1).fill("echo 'hello world'")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    await expect(page.getByText("Process created")).toBeVisible({ timeout: 3000 })

    // 4. Process appears in pane (refresh fetches updated mock data)
    await expect(pane.getByText("Dev Server")).toBeVisible({ timeout: 5000 })

    // 5. Start the process
    const startButton = pane.getByRole("button", { name: "Start process", exact: true })
    await expect(startButton).toBeVisible()
    await startButton.click()

    // 6. Close pane
    await toggleProcessPane(page)
    await waitForPaneHidden(page)

    // 7. Reopen — config still there
    await toggleProcessPane(page)
    pane = await waitForPaneVisible(page)
    await expect(pane.getByText("Dev Server")).toBeVisible({ timeout: 5000 })
  })

  test("edit process dialog shows pre-filled values", async ({ page }) => {
    mockConfigs.push({
      id: "cfg-edit",
      name: "Build Watcher",
      command: "npm run watch",
      args: [],
      cwd: "./packages/app",
      env: { NODE_ENV: "development" },
      autoStart: true,
      restartPolicy: "on-failure",
      maxRestarts: 5,
      color: "#22c55e",
    })

    await page.reload()
    await waitForAppReady(page)

    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    await pane.getByRole("button", { name: "Edit process" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Edit Process")).toBeVisible()

    await expect(dialog.locator('input[type="text"]').first()).toHaveValue("Build Watcher")
    await expect(dialog.locator('input[type="text"]').nth(1)).toHaveValue("npm run watch")
    await expect(dialog.getByRole("button", { name: "Save" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible()

    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden({ timeout: 3000 })
  })

  test("delete process with confirmation", async ({ page }) => {
    mockConfigs.push({
      id: "cfg-del",
      name: "To Delete",
      command: "echo delete-me",
      args: [],
      cwd: "",
      env: {},
      autoStart: false,
      restartPolicy: "never",
      maxRestarts: 3,
      color: "",
    })

    await page.reload()
    await waitForAppReady(page)

    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    await pane.getByRole("button", { name: "Edit process" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    // Delete → shows confirmation
    await dialog.getByRole("button", { name: "Delete" }).click()
    await expect(dialog.getByText("Delete this process?")).toBeVisible()

    // Cancel the delete confirmation (first Cancel = confirmation's, last = dialog's)
    await dialog.getByRole("button", { name: "Cancel" }).first().click()
    await expect(dialog.getByText("Delete this process?")).toBeHidden()

    // Delete → Confirm
    await dialog.getByRole("button", { name: "Delete" }).click()
    await expect(dialog.getByText("Delete this process?")).toBeVisible()
    await dialog.getByRole("button", { name: "Confirm" }).click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    await expect(page.getByText("Process removed")).toBeVisible({ timeout: 3000 })
  })

  test("scroll navigation buttons work with multiple configs", async ({ page }) => {
    mockConfigs.push(
      {
        id: "cfg-s1",
        name: "Server 1",
        command: "echo s1",
        args: [],
        cwd: "",
        env: {},
        autoStart: false,
        restartPolicy: "never",
        maxRestarts: 3,
        color: "#3b82f6",
      },
      {
        id: "cfg-s2",
        name: "Server 2",
        command: "echo s2",
        args: [],
        cwd: "",
        env: {},
        autoStart: false,
        restartPolicy: "never",
        maxRestarts: 3,
        color: "#22c55e",
      },
    )

    await page.reload()
    await waitForAppReady(page)

    await toggleProcessPane(page)
    const pane = await waitForPaneVisible(page)

    await expect(pane.getByText("Server 1")).toBeVisible({ timeout: 5000 })
    await expect(pane.getByText("Server 2")).toBeVisible({ timeout: 5000 })

    const scrollLeft = pane.getByRole("button", { name: "Scroll left" })
    const scrollRight = pane.getByRole("button", { name: "Scroll right" })
    await expect(scrollLeft).toBeVisible()
    await expect(scrollRight).toBeVisible()

    // At index 0 — left disabled
    await expect(scrollLeft).toBeDisabled()

    await scrollRight.click()
    await expect(scrollLeft).toBeEnabled()
  })
})
