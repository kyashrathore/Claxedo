import { test, expect, type Page, type Route } from "@playwright/test"

const DIR = "/tmp/e2e-workspace-shell-test"
const MOD = process.platform === "darwin" ? "Meta" : "Control"
const ACTIVE_CLOSE = "button[aria-label='Close tab'][data-active-close]"
const GROUP = "[data-group-id]"

let pty = 1
let configs: Array<Record<string, unknown>>

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seed(page: Page) {
  await page.addInitScript((dir: string) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: window.location.origin,
      activeDirectory: dir,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [{ worktree: dir, expanded: true }],
        },
        lastProject: {},
        workspaceServer: {},
        closedProjects: {},
      }),
    )
    localStorage.setItem(
      "opencode.global.dat:model",
      JSON.stringify({
        recent: [{ providerID: "claude-acp", modelID: "claude-sonnet-4-6" }],
        user: [],
        variant: {},
      }),
    )
  }, DIR)
}

async function setup(page: Page) {
  pty = 1
  configs = [
    {
      id: "cfg-dev",
      name: "dev-server",
      command: "echo dev",
      args: [],
      cwd: "",
      env: {},
      autoStart: false,
      restartPolicy: "never",
      maxRestarts: 3,
      color: "#3b82f6",
    },
  ]

  const api = (route: Route) => {
    const type = route.request().resourceType()
    return type === "fetch" || type === "xhr"
  }

  await page.route("**/health", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ healthy: true, version: "1.0.0-test" }),
    })
  })

  await page.route("**/event?**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: "data: {}\n\n",
    })
  })

  await page.route("**/path**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ worktree: DIR }),
    })
  })

  await page.route("**/session", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    })
  })

  await page.route("**/session/**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({}),
    })
  })

  await page.route(/\/process\/?(?:\?.*)?$/, async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configs, processes: [] }),
    })
  })

  await page.route("**/provider", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        all: [
          {
            id: "claude-acp",
            name: "Claude",
            models: {
              "claude-sonnet-4-6": {
                id: "claude-sonnet-4-6",
                name: "Sonnet 4.6",
                providerID: "claude-acp",
              },
            },
          },
        ],
        default: { "claude-acp": "claude-sonnet-4-6" },
        connected: [],
      }),
    })
  })

  await page.route("**/provider/auth", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ "claude-acp": [{ type: "api", label: "API key" }] }),
    })
  })

  await page.route("**/api/claxedo/agent-config/runner**", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ type: "claude-acp", ok: true }),
    })
  })

  await page.route("**/api/claxedo/pty", async (route) => {
    if (!api(route)) return route.continue()
    const body = route.request().postDataJSON() as { title?: string; cwd?: string } | undefined
    const id = `pty-${pty++}`
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id, title: body?.title ?? `Terminal ${pty}`, cwd: body?.cwd ?? DIR }),
    })
  })

  await page.route("**/api/claxedo/pty/*", async (route) => {
    if (!api(route)) return route.continue()
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(true),
    })
  })
}

async function ready(page: Page) {
  await page.goto(`/${slug(DIR)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

function root(page: Page, scope = "") {
  return scope ? page.locator(scope).first() : page.locator("body")
}

async function terminal(page: Page, scope = "") {
  await root(page, scope).getByRole("button", { name: "New Claude Terminal" }).first().click({ force: !!scope })
}

async function tabs(page: Page) {
  return await page.locator("[data-tab-id]").count()
}

async function close(page: Page, title?: string | RegExp) {
  const tab = title ? page.locator("[data-tab-id]").filter({ hasText: title }).last() : page.locator("[data-tab-id]").filter({ has: page.locator(ACTIVE_CLOSE) }).first()
  await tab.evaluate((node: HTMLElement) => {
    node.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }))
  })
}

test.describe("Claxedo workspace shell", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page)
    await setup(page)
    await ready(page)
  })

  test("boots the Claxedo layout with workspace controls", async ({ page }) => {
    await expect(page.locator("[data-claxedo]")).toBeVisible()
    await expect(page.locator("[data-component='workspace-more-menu']").first()).toBeVisible()
    await expect(page.locator(GROUP)).toHaveCount(1)
    await expect(page.locator("[data-tab-id]").filter({ hasText: "New Session" }).first()).toBeVisible()
    await expect(page.locator(ACTIVE_CLOSE).first()).toBeVisible()
  })

  test("creates, closes, and reopens a terminal tab", async ({ page }) => {
    const before = await tabs(page)
    await terminal(page)
    await expect.poll(() => tabs(page)).toBe(before + 1)

    await close(page, /Claude|Codex|Terminal/)
    await expect.poll(() => tabs(page)).toBe(before)

    await page.keyboard.press(`${MOD}+Shift+T`)
    await expect.poll(() => tabs(page)).toBe(before + 1)
  })

  test("splits, hides, restores, and closes a workspace panel", async ({ page }) => {
    await page.keyboard.press(`${MOD}+\\`)
    await expect(page.locator("button[aria-label='Close panel']").first()).toBeVisible({ timeout: 10_000 })
    await expect(page.locator(GROUP)).toHaveCount(2)

    const before = await tabs(page)
    await page.keyboard.press(`${MOD}+Alt+ArrowRight`)
    await terminal(page, "[data-group-focused]")
    await expect.poll(() => tabs(page)).toBe(before + 1)

    await page.keyboard.press(`${MOD}+\\`)
    await expect(page.locator(GROUP)).toHaveCount(1)

    await page.keyboard.press(`${MOD}+\\`)
    await expect(page.locator(GROUP)).toHaveCount(2)

    await page.locator("button[aria-label='Close panel']").first().click()
    await expect(page.locator(GROUP)).toHaveCount(1)
  })

  test("toggles sidebar and keeps the shell usable after reload", async ({ page }) => {
    await terminal(page)
    await expect.poll(() => tabs(page)).toBeGreaterThanOrEqual(2)

    await page.keyboard.press(`${MOD}+B`)
    await expect(page.getByRole("button", { name: "Show Sidebar" })).toBeVisible({ timeout: 10_000 })

    await page.reload()
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.locator("[data-component='workspace-more-menu']").first()).toBeVisible()
    await expect(page.locator("[data-tab-id]").first()).toBeVisible()
  })

  test("renders the runner selector without the old duplicated selector pattern", async ({ page }) => {
    await expect(page.getByText(/OpenCode|Default/).first()).toBeVisible({ timeout: 20_000 })
    await expect(page.locator("body")).not.toContainText(/something went wrong|uncaught error|crash/i)
    const count = await page.locator("text=OpenCode").count()
    expect(count).toBeLessThan(10)
  })
})
