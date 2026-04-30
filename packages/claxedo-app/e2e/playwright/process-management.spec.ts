/**
 * Process Management E2E Tests
 *
 * Tests the current process side-panel UI:
 * 1. Open the process panel from the Processes toolbar action
 * 2. See empty state / process controls
 * 3. Open "Add Process" dialog, fill form, submit
 * 4. See process appear in the panel
 * 5. Start the process
 * 6. Close the panel and reopen — verify state persists
 *
 * Uses Playwright route interception to mock HTTP APIs
 * so the test runs without a live backend.
 */

import { test, expect, type Page, type Route } from "@playwright/test"

// ── Constants ───────────────────────────────────────────────────────────

const PROCESS_BUTTON = 'button[aria-label="Processes"]'
const ACTIVE_CLOSE = 'button[aria-label="Close tab"][data-active-close]'

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
  await expect(
    page.locator('[data-claxedo]'),
  ).toBeVisible({ timeout: 30_000 })
  // Small delay for SolidJS reactivity to settle
  await page.waitForTimeout(500)
}

async function showProcessTab(page: Page) {
  const add = page.getByRole("button", { name: "Add process" })
  if (await add.isVisible().catch(() => false)) return

  const tab = page.locator("[data-tab-id]").filter({ hasText: "Processes" }).first()
  if (await tab.count()) {
    await tab.click()
  } else {
    await page.locator(PROCESS_BUTTON).click()
  }

  await expect(add).toBeVisible({ timeout: 10_000 })
}

async function showSessionTab(page: Page) {
  await page.locator("[data-tab-id]").filter({ hasText: "New Session" }).first().click()
  await expect(page.getByRole("button", { name: "Add process" })).toBeHidden({ timeout: 10_000 })
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

  // Mock health check — opencode startup health check must return healthy
  await page.route("**/health", async (route: Route) => {
    if (!isAPICall(route)) { await route.continue(); return }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ healthy: true, version: "1.0.0-test" }),
    })
  })

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
  await page.route("**/path**", async (route: Route) => {
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

  // GET/POST /process
  await page.route(/\/process\/?(?:\?.*)?$/, async (route: Route) => {
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
  await page.route("**/process/*/start**", async (route: Route) => {
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
  await page.route("**/process/*/stop**", async (route: Route) => {
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
  await page.route("**/process/*/restart**", async (route: Route) => {
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
  await page.route("**/process/start-all**", async (route: Route) => {
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
  await page.route("**/process/stop-all**", async (route: Route) => {
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
    await expect(page.getByRole("button", { name: "Add process" })).toBeHidden()

    await showProcessTab(page)
    await expect(page.getByText("No processes configured")).toBeVisible()
    await expect(page.getByRole("button", { name: "Add process" })).toBeVisible()

    await showSessionTab(page)
  })

  test("add process via dialog", async ({ page }) => {
    await showProcessTab(page)
    await page.getByRole("button", { name: "Add process" }).click()

    // Dialog should appear
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Add Process")).toBeVisible()

    // Fill in name
    const nameInput = dialog.getByTestId("process-name-input")
    await nameInput.fill("dev-server")

    const commandInput = dialog.getByTestId("process-command-input")
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

    await showProcessTab(page)
    await page.getByRole("button", { name: "Add process" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Add Process")).toBeVisible()

    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden({ timeout: 3000 })
  })

  test("dialog form validation — submit disabled without required fields", async ({ page }) => {
    await showProcessTab(page)
    await page.getByRole("button", { name: "Add process" }).click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    const addButton = dialog.getByRole("button", { name: "Add", exact: true })
    await expect(addButton).toBeDisabled()

    // Fill just name — still disabled
    const nameInput = dialog.getByTestId("process-name-input")
    await nameInput.fill("test")
    await expect(addButton).toBeDisabled()

    // Fill command — enabled
    const commandInput = dialog.getByTestId("process-command-input")
    await commandInput.fill("echo test")
    await expect(addButton).toBeEnabled()

    // Clear name — disabled
    await nameInput.clear()
    await expect(addButton).toBeDisabled()
  })

  test("dialog env variables — add and remove", async ({ page }) => {
    await showProcessTab(page)
    await page.getByRole("button", { name: "Add process" }).click()

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

  test("switching back to the session hides process actions", async ({ page }) => {
    await showProcessTab(page)
    await showSessionTab(page)
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

    await showProcessTab(page)
    await expect(page.getByRole("button", { name: "Start All" })).toBeVisible()
    await expect(page.getByRole("button", { name: "Stop All" })).toBeVisible()
  })

  test("full happy flow: create, start, close, reopen", async ({ page }) => {
    await showProcessTab(page)
    await expect(page.getByTestId("process-empty-state")).toBeVisible({ timeout: 10_000 })

    await page.getByRole("button", { name: "Add process" }).click()
    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()

    await dialog.getByTestId("process-name-input").fill("dev-server")
    await dialog.getByTestId("process-command-input").fill("echo 'hello world'")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    await expect(page.getByText("Process created")).toBeVisible({ timeout: 3000 })

    await expect(page.locator('[data-testid="process-pane-panel"][data-process-name="dev-server"]')).toBeVisible({ timeout: 5_000 })

    const startButton = page.getByRole("button", { name: "Start process", exact: true }).first()
    await expect(startButton).toBeVisible()
    await startButton.click()
    await expect(page.getByRole("button", { name: "Stop process" }).first()).toBeVisible({ timeout: 5000 })

    await page.locator(ACTIVE_CLOSE).click()
    await expect(page.getByRole("button", { name: "Add process" })).toBeHidden({ timeout: 10_000 })

    await showProcessTab(page)
    await expect(page.locator('[data-testid="process-pane-panel"][data-process-name="dev-server"]')).toBeVisible({ timeout: 5_000 })
  })

  test("edit process dialog shows pre-filled values", async ({ page }) => {
    mockConfigs.push({
      id: "cfg-edit",
      name: "build-watcher",
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

    await showProcessTab(page)
    await page.getByRole("button", { name: "Edit process" }).first().click()

    const dialog = page.getByRole("dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText("Edit Process")).toBeVisible()

    await expect(dialog.getByTestId("process-name-input")).toHaveValue("build-watcher")
    await expect(dialog.getByTestId("process-command-input")).toHaveValue("npm run watch")
    await expect(dialog.getByRole("button", { name: "Save" })).toBeVisible()
    await expect(dialog.getByRole("button", { name: "Delete" })).toBeVisible()

    await dialog.getByRole("button", { name: "Cancel" }).click()
    await expect(dialog).toBeHidden({ timeout: 3000 })
  })

  test("delete process with confirmation", async ({ page }) => {
    mockConfigs.push({
      id: "cfg-del",
      name: "to-delete",
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

    await showProcessTab(page)
    await page.getByRole("button", { name: "Edit process" }).first().click()
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
    await dialog.getByTestId("process-confirm-delete").click()

    await expect(dialog).toBeHidden({ timeout: 5000 })
    await expect(page.getByText("Process removed")).toBeVisible({ timeout: 3000 })
  })

  test("multiple configs render multiple process panes", async ({ page }) => {
    mockConfigs.push(
      {
        id: "cfg-s1",
        name: "server-1",
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
        name: "server-2",
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

    await showProcessTab(page)

    await expect(page.locator('[data-testid="process-pane-panel"][data-process-name="server-1"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.locator('[data-testid="process-pane-panel"][data-process-name="server-2"]')).toBeVisible({ timeout: 5_000 })
    await expect(page.getByRole("button", { name: "Edit process" })).toHaveCount(2)
  })
})
