import { expect, test, type Page } from "@playwright/test"
import { installMockRuntime, type MockRuntimeHandles } from "../helpers/mock-runtime"
import { ensureComposerModelSelected, expectAssistantReplyVisible, SELECTORS } from "../helpers/turn-oracle"

const DIR = "/tmp/e2e-core-model-effort-agent-controls"
const SESSION_ID = "ses_core_model_effort_agent"

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function seedOneProject(page: Page, dir: string) {
  // `addInitScript` re-runs on every navigation including `page.reload()`, so an
  // unconditional `localStorage.clear()` would wipe state the app persisted mid-test and
  // break the reload-persistence check. The marker limits the clear to a fresh context.
  await page.addInitScript((d: string) => {
    if (!sessionStorage.getItem("__e2e_seed_done__")) {
      localStorage.clear()
      sessionStorage.setItem("__e2e_seed_done__", "1")
    }
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

async function openDraftPrompt(page: Page, dir: string) {
  await page.goto(`/${slug(dir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
  await expect(input).toBeVisible({ timeout: 20_000 })
  return input
}

function isApiRequest(route: import("@playwright/test").Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr"
}

function paidProviderBody() {
  return {
    all: [
      {
        id: "opencode",
        name: "opencode",
        env: [],
        models: {
          "big-pickle-1": {
            id: "big-pickle-1",
            name: "Big Pickle",
            family: "big-pickle",
            release_date: "2026-06-15",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
      },
      {
        id: "anthropic",
        name: "Anthropic",
        env: [],
        models: {
          "claude-sonnet-4-6": {
            id: "claude-sonnet-4-6",
            name: "Sonnet 4.6",
            family: "claude-sonnet",
            release_date: "2026-06-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 3, output: 15 },
            options: {},
            variants: { high: {}, low: {} },
          },
          "claude-opus-4-7": {
            id: "claude-opus-4-7",
            name: "Opus 4.7",
            family: "claude-opus",
            release_date: "2026-06-02",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 15, output: 75 },
            options: {},
          },
          "claude-haiku-3": {
            id: "claude-haiku-3",
            name: "Haiku 3 (legacy)",
            family: "claude-haiku",
            release_date: "2020-03-01",
            attachment: true,
            reasoning: true,
            temperature: true,
            tool_call: true,
            limit: { context: 200000, output: 8192 },
            cost: { input: 0.25, output: 1.25 },
            options: {},
          },
        },
      },
    ],
    default: { opencode: "big-pickle-1", anthropic: "claude-sonnet-4-6" },
    connected: ["opencode", "anthropic"],
  }
}

/** Registered after the shared runtime so these routes win Playwright's
 * reverse-registration match order. Bootstrap carries only each connected provider's
 * configured default, mirroring the real endpoint's compact index. */
async function installPaidProviderFixture(page: Page, mock: MockRuntimeHandles) {
  const body = paidProviderBody()
  const defaults: Record<string, string> = body.default
  const index = {
    ...body,
    all: body.all.map((provider) => ({
      ...provider,
      models: Object.fromEntries(Object.entries(provider.models).filter(([id]) => defaults[provider.id] === id)),
    })),
  }
  // The OpenCode harness reads its models from the control plane's provider catalog,
  // not from an engine `/provider` route.
  await page.route("**/api/claxedo/agent-config/providers**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/claxedo/agent-config/providers") return route.fallback()
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
  await page.route("**/api/claxedo/bootstrap**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        healthy: true,
        events: { hostAggregate: true },
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: mock.session.dir, directory: mock.session.dir, home: "/tmp" },
        project: [{ id: mock.session.projectId, worktree: mock.session.dir, name: "mock-runtime", time: { created: Date.now(), updated: Date.now() } }],
        provider: index,
        provider_auth: { opencode: [{ type: "api", label: "API key" }], anthropic: [{ type: "api", label: "API key" }] },
        config: { provider: { id: "opencode", model: "big-pickle-1" }, agent: { id: "build" } },
      }),
    })
  })
}

/** Zero connected providers at all — no model is resolvable, selected or fallback. */
async function installNoModelFixture(page: Page, mock: MockRuntimeHandles) {
  const body = { all: [], default: {}, connected: [] }
  await page.route("**/api/claxedo/agent-config/providers**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    if (new URL(route.request().url()).pathname !== "/api/claxedo/agent-config/providers") return route.fallback()
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
  })
  await page.route("**/api/claxedo/bootstrap**", (route) => {
    if (!isApiRequest(route)) return route.continue()
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        healthy: true,
        events: { hostAggregate: true },
        version: "1.0.0-test",
        path: { state: "", config: "", worktree: mock.session.dir, directory: mock.session.dir, home: "/tmp" },
        project: [{ id: mock.session.projectId, worktree: mock.session.dir, name: "mock-runtime", time: { created: Date.now(), updated: Date.now() } }],
        provider: body,
        provider_auth: {},
        config: {},
      }),
    })
  })
}

function modelTrigger(page: Page) {
  return page.locator('[data-action="prompt-harness-model"]').last()
}

async function openModelPopover(page: Page) {
  await modelTrigger(page).click()
  const list = page.locator('[data-slot="list-scroll"]').last()
  await expect(list).toBeVisible({ timeout: 25_000 })
  return list
}

async function pickModelFromPopover(page: Page, modelName: string) {
  await openModelPopover(page)
  const item = page.locator('[data-slot="list-item"]', { hasText: modelName }).first()
  // The list waits on the provider fetch, which is slow under parallel-suite load.
  await expect(item).toBeVisible({ timeout: 25_000 })
  await item.click()
}

test.describe("core model, effort/variant, and agent controls @core", () => {
  test("model picked before first send is reflected in the prompt payload", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await pickModelFromPopover(page, "Sonnet 4.6")
    await expect(modelTrigger(page)).toContainText("Sonnet 4.6", { timeout: 10_000 })

    const promptText = "which model answered this"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

    expect(mock.requests.promptBodies[0]?.providerID).toBe("anthropic")
    expect(mock.requests.promptBodies[0]?.modelID).toBe("claude-sonnet-4-6")
  })

  test("the Effort section only renders for a multi-variant model, and the pick reaches the payload", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // Big Pickle has zero variants configured in the bootstrap index — no effort section.
    await pickModelFromPopover(page, "Big Pickle")
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 10_000 })
    await modelTrigger(page).click()
    const opusPicker = page.locator('[data-component="harness-model-picker"]')
    await expect(opusPicker.locator('[data-slot="harness-picker-section"]', { hasText: /^Effort/ })).toHaveCount(0)
    await page.keyboard.press("Escape")

    // Sonnet has {high, low} — the effort section appears once it's current.
    await pickModelFromPopover(page, "Sonnet 4.6")
    await expect(modelTrigger(page)).toContainText("Sonnet 4.6", { timeout: 10_000 })
    await modelTrigger(page).click()
    const picker = page.locator('[data-component="harness-model-picker"]')
    const effortSection = picker.locator('[data-slot="harness-picker-section"]', { hasText: /^Effort/ })
    await expect(effortSection).toContainText(/Default/i)
    await effortSection.click()
    const highOption = picker.getByRole("button", { name: /^high$/i })
    await expect(highOption).toBeVisible({ timeout: 10_000 })
    await highOption.click()
    await expect(modelTrigger(page)).toContainText(/high/i, { timeout: 10_000 })

    const promptText = "how hard did you think about this"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptBodies[0]?.variant).toBe("high")
  })

  test("mid-session model change PATCHes the session config immediately", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    await pickModelFromPopover(page, "Sonnet 4.6")
    await expect(modelTrigger(page)).toContainText("Sonnet 4.6", { timeout: 10_000 })

    const promptText = "first turn before the model swap"
    await input.click()
    await input.fill(promptText)
    await page.locator(SELECTORS.submitControl).last().click()
    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)

    const patchesBeforeSwap = mock.requests.configPatchCount
    await pickModelFromPopover(page, "Big Pickle")
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 10_000 })

    await expect
      .poll(() => mock.requests.configPatchCount, { timeout: 15_000 })
      .toBeGreaterThan(patchesBeforeSwap)
    const swapPatch = mock.requests.configPatchBodies.at(-1)?.body as { model?: { providerID?: string; modelID?: string } } | undefined
    expect(swapPatch?.model).toMatchObject({ providerID: "opencode", modelID: "big-pickle-1" })
  })

  test("a freshly picked model survives a page reload of the same draft", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await pickModelFromPopover(page, "Big Pickle")
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 10_000 })

    // The pick lands in the model store's "recent" list, persisted per (server,
    // workspace). Wait for that write to land before reloading.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const name = Object.keys(localStorage).find(
            (key) => key.startsWith("claxedo.server.") && key.endsWith(":workspace:model"),
          )
          const raw = name ? localStorage.getItem(name) : null
          if (!raw) return null
          try {
            const parsed = JSON.parse(raw) as { recent?: Array<{ modelID?: string }> }
            return parsed.recent?.some((m) => m.modelID === "big-pickle-1") ?? false
          } catch {
            return null
          }
        }),
        { timeout: 10_000 },
      )
      .toBe(true)

    await page.reload({ waitUntil: "domcontentloaded" })
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(modelTrigger(page)).toContainText("Big Pickle", { timeout: 20_000 })
  })

  test("zero-paid-provider path still opens the standard model picker", async ({ page }) => {
    // Deliberately the default mock, whose only provider is priced at 0. The model
    // control opens the ordinary picker in every state; the picker carries its own
    // connect affordances for an unconfigured workspace.
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    await openModelPopover(page)
    await expect(page.getByText("Free models provided by OpenCode")).toHaveCount(0)
    await expect(page.getByText("Add more models from popular providers")).toHaveCount(0)
  })

  test("multi-agent selector renders and the pick reaches the payload", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await page.route("**/api/claxedo/agent-config/agents**", (route) => {
      if (!isApiRequest(route)) return route.continue()
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "build", name: "build", mode: "primary" },
          { id: "review", name: "review", mode: "primary" },
        ]),
      })
    })
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    // The agent picker is a radio group inside the `+` menu. build+review is not the
    // build+plan pair that collapses into a single "Plan mode" checkbox, so the radio
    // group renders.
    const addTrigger = page.locator('[data-action="prompt-add"]').last()
    await expect(addTrigger).toBeVisible({ timeout: 15_000 })
    await expect(addTrigger).not.toBeDisabled()

    await addTrigger.click()
    const agentItems = page.locator('[data-action="prompt-agent"]')
    await expect(agentItems.filter({ hasText: /^build$/i })).toHaveAttribute("data-checked", "", { timeout: 10_000 })
    const reviewOption = agentItems.filter({ hasText: /^review$/i }).first()
    await expect(reviewOption).toBeVisible({ timeout: 10_000 })
    await reviewOption.click()

    // The checked indicator is the only place the current agent shows, so reopen to read it.
    await addTrigger.click()
    await expect(agentItems.filter({ hasText: /^review$/i })).toHaveAttribute("data-checked", "", { timeout: 10_000 })
    await page.keyboard.press("Escape")

    const promptText = "which agent handled this"
    await input.click()
    await input.fill(promptText)
    await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
    await page.locator(SELECTORS.submitControl).last().click()

    await expect.poll(() => mock.requests.promptCount, { timeout: 15_000 }).toBe(1)
    await expectAssistantReplyVisible(page, `ack 1: ${promptText}`)
    expect(mock.requests.promptBodies[0]?.agent).toBe("review")
  })

  test("session config rejects a harness identity change with the canonical 409 contract", async ({ page }) => {
    await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    const result = await page.evaluate(async ({ directory, sessionID }) => {
      const response = await fetch(`/session/${sessionID}/config?directory=${encodeURIComponent(directory)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // The client sends a structured `{id, access}` identity. `acp:<slug>` is only a
        // string form: inside a structured identity the slug must arrive as `id` beside
        // `access: "acp"`, or the harness key is dropped and the PATCH 200s unchanged.
        body: JSON.stringify({ harness: { id: "claude", access: "acp" } }),
      })
      return { status: response.status, body: await response.json() }
    }, { directory: DIR, sessionID: SESSION_ID })

    expect(result).toEqual({
      status: 409,
      body: {
        ok: false,
        error: {
          code: "unsupported_operation",
          operation: "harness_switch",
          capability: "session_harness",
          // The mock session runs on the embedded OpenCode harness, so the rejection names it.
          harness: "opencode",
          transport: "opencode",
          reason: "harness_switch_not_supported",
          message: "opencode sessions cannot switch to claude through session config patch",
        },
      },
    })
  })

  test(
    "failed initial config persistence preserves the unpublished draft",
    async ({ page }) => {
      const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID, configPatchFailure: true })
      await seedOneProject(page, DIR)
      const input = await openDraftPrompt(page, DIR)

      const promptText = "does the save-failed toast appear"
      await input.click()
      await input.fill(promptText)
      await ensureComposerModelSelected(page, { modelName: /^Big Pickle$/i, search: "Big Pickle" })
      await page.locator(SELECTORS.submitControl).last().click()

      await expect.poll(() => mock.requests.createSessionCount, { timeout: 15_000 }).toBeGreaterThan(0)
      await expect(page.locator('[data-slot="toast-title"]', { hasText: "Failed to create session" })).toBeVisible({
        timeout: 10_000,
      })
      await expect(input).toContainText(promptText)
      await expect.poll(() => mock.requests.promptCount, { intervals: [500, 1000, 1000], timeout: 3_000 }).toBe(0)
      expect(mock.requests.configPatchCount).toBe(0)
      expect(mock.requests.createSessionCount).toBe(1)
    },
  )

  test("missing model blocks submit and opens the model picker on Enter", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installNoModelFixture(page, mock)
    await seedOneProject(page, DIR)
    const input = await openDraftPrompt(page, DIR)

    const promptText = "this should never be sent"
    await input.click()
    await input.fill(promptText)
    await expect(input).toContainText(promptText, { timeout: 10_000 })

    await input.press("Enter")

    await expect(page.locator('[data-slot="toast-title"]', { hasText: "Select an agent and model" })).toHaveCount(0)
    // Missing-model Enter clicks the unified harness+model control, which opens the
    // harness-model picker popover (not the Settings dialog-container).
    await expect(page.getByRole("dialog", { name: /Select harness, model and effort/i })).toBeVisible({
      timeout: 10_000,
    })
    await expect(page.locator('[data-component="harness-model-picker"]')).toBeVisible()
    await expect(input).toContainText(promptText)
    expect(mock.requests.promptCount).toBe(0)
    expect(mock.requests.createSessionCount).toBe(0)
  })

  test("Settings -> Models visibility toggle propagates to the composer's model list", async ({ page }) => {
    const mock = await installMockRuntime(page, { dir: DIR, sessionId: SESSION_ID })
    await installPaidProviderFixture(page, mock)
    await seedOneProject(page, DIR)
    await openDraftPrompt(page, DIR)

    // Haiku 3's 2020 release date and absent visibility row default it hidden.
    await openModelPopover(page)
    await expect(page.locator('[data-slot="list-item"]', { hasText: "Haiku 3 (legacy)" })).toHaveCount(0)
    await page.keyboard.press("Escape")

    await page.getByTestId("rail-account-trigger").click()
    await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
    const dialog = page.locator('[data-slot="dialog-container"]')
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await page.getByRole("tab", { name: "Models" }).click()
    // Settings reads under an explicit (workspace, harness) and nothing is remembered for
    // a draft that never switched, so pick the harness the draft is on.
    await page.locator('[data-action="settings-scope-harness"]').click()
    await page.locator('[data-slot="select-select-item"][data-key="%7B%22kind%22%3A%22native%22%2C%22harnessId%22%3A%22opencode%22%7D"]').click()

    const toggle = page.getByRole("switch", { name: "Haiku 3 (legacy)" })
    await expect(toggle).toBeVisible({ timeout: 10_000 })
    const toggleVisual = page
      .locator('[data-component="switch"]')
      .filter({ has: toggle })
      .locator('[data-slot="switch-control"]')
    await toggleVisual.click()
    await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 10_000 })

    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)

    await openModelPopover(page)
    await expect(page.locator('[data-slot="list-item"]', { hasText: "Haiku 3 (legacy)" })).toBeVisible({ timeout: 10_000 })
  })
})
