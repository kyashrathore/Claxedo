import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test"
import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"

const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const LOCAL_DIR = clean(process.env.CLAXEDO_LIVE_LOCAL_DIR) ??
  REPO_ROOT
const FIRST_PROMPT = "Live happy-flow first prompt. Reply with one short sentence."
const SECOND_PROMPT = "Live happy-flow second prompt in the same session. Reply with one short sentence."
const RESUME_PROMPT = "Live happy-flow resume prompt after reload. Reply with one short sentence."
const CANCEL_PROMPT = "Live happy-flow cancellation pass. Run `sleep 8 && echo live-cancel-ready` before replying."
const AUTH_EMAIL = clean(process.env.E2E_CLERK_USER_EMAIL) ?? "claxedo-e2e+clerk_test@example.com"
const AUTH_PASSWORD = clean(process.env.E2E_CLERK_USER_PASSWORD) ?? "claxedo-e2e-password-2026"

type Runtime = "local" | "cloud"
type AuthState = "unsigned" | "authenticated"

type Mode = {
  name: string
  runtime: Runtime
  auth: AuthState
  route: string | undefined
  routeDirectory: string | undefined
  workspaceLabel: string | undefined
  modelName: string | undefined
  modelFallbackNames: string[]
  required: string[]
}

type Hit = {
  method: string
  url: string
  pathname: string
  authorization?: string
  status?: number
}

type Telemetry = {
  requests: Hit[]
  responses: Array<Hit & { status: number }>
  failed: string[]
  console: string[]
}

loadEnvFile(path.join(APP_DIR, ".env.local"))
loadEnvFile(path.join(REPO_ROOT, "packages", "claxedo-server", ".env.local"))

function clean(value: string | undefined) {
  return value?.trim() || undefined
}

function slug(value: string) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
}

function loadEnvFile(file: string) {
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const index = trimmed.indexOf("=")
      if (index < 1) continue
      process.env[trimmed.slice(0, index)] ??= trimmed.slice(index + 1).replace(/^"(.*)"$/, "$1")
    }
  } catch {}
}

function modeRoute(name: string, fallback?: string) {
  return clean(process.env[`CLAXEDO_LIVE_${name}_ROUTE`]) ?? fallback
}

function modeWorkspaceLabel(name: string, fallback?: string) {
  return clean(process.env[`CLAXEDO_LIVE_${name}_WORKSPACE_LABEL`]) ?? fallback
}

function modeModelName(name: string) {
  return clean(process.env[`CLAXEDO_LIVE_${name}_MODEL_NAME`]) ??
    clean(process.env.CLAXEDO_LIVE_MODEL_NAME) ??
    "DeepSeek V4 Flash Free"
}

function modeModelFallbackNames(name: string) {
  return [
    clean(process.env[`CLAXEDO_LIVE_${name}_MODEL_FALLBACK_NAMES`]),
    clean(process.env.CLAXEDO_LIVE_MODEL_FALLBACK_NAMES),
    "DeepSeek V4 Flash Free",
  ]
    .filter((value): value is string => !!value)
    .flatMap((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function logStep(mode: Mode, step: string) {
  console.log(`[live-happyflows] ${mode.name}: ${step}`)
}

function modes(): Mode[] {
  const authRequired = [
    !(clean(process.env.CLERK_PUBLISHABLE_KEY) ?? clean(process.env.VITE_CLERK_PUBLISHABLE_KEY))
      ? "CLERK_PUBLISHABLE_KEY or VITE_CLERK_PUBLISHABLE_KEY"
      : undefined,
    !clean(process.env.CLERK_SECRET_KEY) ? "CLERK_SECRET_KEY" : undefined,
  ].filter((item): item is string => !!item)
  return [
    {
      name: "unsigned local",
      runtime: "local",
      auth: "unsigned",
      route: modeRoute("UNSIGNED_LOCAL", `/${slug(LOCAL_DIR)}/session`),
      routeDirectory: LOCAL_DIR,
      workspaceLabel: modeWorkspaceLabel("UNSIGNED_LOCAL", path.basename(LOCAL_DIR)),
      modelName: modeModelName("UNSIGNED_LOCAL"),
      modelFallbackNames: modeModelFallbackNames("UNSIGNED_LOCAL"),
      required: [],
    },
    {
      name: "unsigned cloud",
      runtime: "cloud",
      auth: "unsigned",
      route: modeRoute("UNSIGNED_CLOUD"),
      routeDirectory: undefined,
      workspaceLabel: modeWorkspaceLabel("UNSIGNED_CLOUD"),
      modelName: modeModelName("UNSIGNED_CLOUD"),
      modelFallbackNames: modeModelFallbackNames("UNSIGNED_CLOUD"),
      required: ["CLAXEDO_LIVE_UNSIGNED_CLOUD_ROUTE"].filter(() => !modeRoute("UNSIGNED_CLOUD")),
    },
    {
      name: "authenticated local",
      runtime: "local",
      auth: "authenticated",
      route: modeRoute("AUTH_LOCAL", `/${slug(LOCAL_DIR)}/session`),
      routeDirectory: LOCAL_DIR,
      workspaceLabel: modeWorkspaceLabel("AUTH_LOCAL", path.basename(LOCAL_DIR)),
      modelName: modeModelName("AUTH_LOCAL"),
      modelFallbackNames: modeModelFallbackNames("AUTH_LOCAL"),
      required: authRequired,
    },
    {
      name: "authenticated cloud",
      runtime: "cloud",
      auth: "authenticated",
      route: modeRoute("AUTH_CLOUD"),
      routeDirectory: undefined,
      workspaceLabel: modeWorkspaceLabel("AUTH_CLOUD"),
      modelName: modeModelName("AUTH_CLOUD"),
      modelFallbackNames: modeModelFallbackNames("AUTH_CLOUD"),
      required: [
        ...authRequired,
        ...["CLAXEDO_LIVE_AUTH_CLOUD_ROUTE"].filter(() => !modeRoute("AUTH_CLOUD")),
      ],
    },
  ]
}

function telemetry(page: Page): Telemetry {
  const authValue = (value: string | undefined) => value?.startsWith("Bearer ") ? "Bearer" : value ? "present" : undefined
  const out: Telemetry = {
    requests: [],
    responses: [],
    failed: [],
    console: [],
  }
  page.on("request", (request) => {
    const url = new URL(request.url())
    out.requests.push({
      method: request.method(),
      url: request.url(),
      pathname: url.pathname,
      authorization: authValue(request.headers().authorization),
    })
  })
  page.on("response", (response) => {
    const request = response.request()
    const url = new URL(response.url())
    if (response.status() >= 400) {
      out.responses.push({
        method: request.method(),
        url: response.url(),
        pathname: url.pathname,
        authorization: authValue(request.headers().authorization),
        status: response.status(),
      })
    }
  })
  page.on("requestfailed", (request) => {
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim()
    if (!failure.endsWith(" net::ERR_ABORTED")) out.failed.push(failure)
  })
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      const text = message.text()
      if (
        !text.includes("Clerk:") &&
        !text.includes("development keys") &&
        !text.includes("GL Driver Message") &&
        !text.includes("GPU stall due to ReadPixels")
      ) out.console.push(`${message.type()}: ${text}`)
    }
  })
  page.on("pageerror", (error) => {
    out.console.push(`pageerror: ${error.message}`)
  })
  return out
}

async function signIn(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("opencode_test_auth", JSON.stringify({
      token: "test-bypass-token",
      user: {
        id: "test-user",
        primaryEmailAddress: { emailAddress: "test@claxedo.test" },
        fullName: "Test User",
      },
    }))
  })
  await page.goto("/")
  await page.evaluate(() => {
    window.localStorage.setItem("opencode_test_auth", JSON.stringify({
      token: "test-bypass-token",
      user: {
        id: "test-user",
        primaryEmailAddress: { emailAddress: "test@claxedo.test" },
        fullName: "Test User",
      },
    }))
  })
}

async function ensureClerkUser() {
  if (!clean(process.env.CLERK_SECRET_KEY)) return
  const create = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [AUTH_EMAIL],
      password: AUTH_PASSWORD,
      skip_password_checks: true,
      skip_legal_checks: true,
    }),
  })
  if (create.ok) return
  const body = await create.json().catch(() => ({})) as { errors?: Array<{ code?: string; message?: string }> }
  const duplicate = body.errors?.some((item) => {
    const text = `${item.code ?? ""} ${item.message ?? ""}`.toLowerCase()
    return text.includes("exist") || text.includes("taken")
  })
  if (!duplicate) throw new Error(`Failed to prepare Clerk test user: ${create.status}`)

  const found = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(AUTH_EMAIL)}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
  })
  if (!found.ok) throw new Error(`Failed to find Clerk test user: ${found.status}`)
  const data = await found.json() as { data?: Array<{ id?: string }> } | Array<{ id?: string }>
  const userID = (Array.isArray(data) ? data : data.data ?? [])[0]?.id
  if (!userID) throw new Error("Failed to find Clerk test user id")
  const update = await fetch(`https://api.clerk.com/v1/users/${userID}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password: AUTH_PASSWORD,
      skip_password_checks: true,
    }),
  })
  if (!update.ok) throw new Error(`Failed to reset Clerk test user password: ${update.status}`)
}

async function signOut(page: Page) {
  await page.addInitScript(() => {
    ;(window as typeof window & { __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean })
      .__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__ = true
  })
  await page.context().clearCookies()
  await page.goto("/")
  await page.evaluate(() => {
    localStorage.removeItem("opencode_test_auth")
    sessionStorage.clear()
  }).catch(() => undefined)
}

async function installPtyFrameCapture(page: Page) {
  await page.addInitScript(() => {
    const key = "__claxedoPtyFrames"
    ;(window as unknown as Record<string, string[]>)[key] = []
    const NativeWebSocket = window.WebSocket
    const CapturingWebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        if (protocols === undefined) super(url)
        else super(url, protocols)
        const target = String(url)
        if (target.includes("/api/claxedo/pty/") && target.includes("/connect")) {
          this.addEventListener("message", (event) => {
            if (typeof event.data === "string") {
              ;(window as unknown as Record<string, string[]>)[key]?.push(event.data)
            }
          })
        }
      }
    }
    window.WebSocket = CapturingWebSocket as typeof WebSocket
  })
}

function promptInput(page: Page) {
  return page.locator('[data-component="prompt-input"]:visible').first()
}

function submitButton(page: Page) {
  return page.locator('[data-action="prompt-submit"]:visible').last()
}

function activeSessionTitle(page: Page) {
  return page.locator("[data-claxedo] h1:visible").first()
}

async function activeSessionTitleText(page: Page) {
  return await activeSessionTitle(page).textContent({ timeout: 500 }).catch(() => "")
}

async function activeSessionId(page: Page) {
  return await page.locator('[data-testid="session-content"]:visible').last().getAttribute("data-session-id", {
    timeout: 500,
  }).catch(() => "")
}

async function visible(locator: Locator) {
  return await locator.isVisible().catch(() => false)
}

async function visibleStopButtonCenter(page: Page) {
  return await page.evaluate(() => {
    const isVisible = (el: Element) => {
      const style = window.getComputedStyle(el)
      const box = el.getBoundingClientRect()
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0
    }
    const button = [...document.querySelectorAll<HTMLElement>('[data-action="prompt-submit"]')]
      .reverse()
      .find((el) => el.getAttribute("aria-label") === "Stop" && isVisible(el))
    if (!button) return undefined
    const box = button.getBoundingClientRect()
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
  })
}

async function selectLiveModel(page: Page, mode: Mode, testInfo: TestInfo) {
  if (!mode.modelName) return
  const modelControls = page.locator('[data-action="prompt-runner-model"]:visible, [data-action="prompt-model"]:visible')
  const modelNames = [mode.modelName, ...mode.modelFallbackNames]
    .filter((name): name is string => !!name)
    .filter((name, index, names) => names.indexOf(name) === index)
  const pageText = await page.locator("[data-claxedo]").innerText().catch(() => "")
  for (const modelName of modelNames) {
    if (await visible(modelControls.filter({ hasText: modelName }).first()) || pageText.includes(modelName)) {
      mode.modelName = modelName
      logStep(mode, `model already selected: ${modelName}`)
      return
    }
  }
  const sampler = startNoBlankSampler(page, testInfo, "select-model")
  try {
    const trigger = modelControls.last()
    await expect(trigger, `expected a visible model selector for ${mode.name}`).toBeVisible({ timeout: 30_000 })
    await trigger.click()
    const selected = await firstVisibleModelOption(page, modelNames)
    mode.modelName = selected.name
    logStep(mode, `select model: ${selected.name}`)
    await selected.option.click()
    await expect(
      modelControls.filter({ hasText: mode.modelName }).first(),
      `expected selected live model "${mode.modelName}"`,
    ).toBeVisible({ timeout: 10_000 })
  } finally {
    await sampler.stop()
  }
}

async function firstVisibleModelOption(page: Page, modelNames: string[]) {
  for (const name of modelNames) {
    const option = page.getByRole("button", { name: new RegExp(escapeRegExp(name), "i") }).first()
    if (await option.isVisible({ timeout: 2_000 }).catch(() => false)) return { name, option }
  }
  throw new Error(`expected one live model option to be visible: ${modelNames.join(", ")}`)
}

async function expectSelectedLiveModel(page: Page, mode: Mode) {
  if (!mode.modelName) return
  const selected = page
    .locator('[data-action="prompt-runner-model"]:visible, [data-action="prompt-model"]:visible')
    .filter({ hasText: mode.modelName })
    .first()
  if (await visible(selected)) return
  const normalized = mode.modelName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  await expect.poll(async () => {
    const text = await page.locator("[data-claxedo]").innerText().catch(() => "")
    return text.includes(mode.modelName!) || (!!normalized && text.toLowerCase().includes(normalized))
  }, {
    timeout: 30_000,
    message: `expected restored live model "${mode.modelName}"`,
  }).toBe(true)
}

async function clickNewSession(page: Page, mode: Mode, testInfo: TestInfo) {
  const sampler = startNoBlankSampler(page, testInfo, "create-session", { allowSurfaceSwap: true })
  const previousTitle = await activeSessionTitleText(page)
  const previousSessionId = await activeSessionId(page)
  const waitForNewSession = async () => {
    await expect(promptInput(page)).toBeVisible({ timeout: 30_000 }).catch(async (err) => {
      if (mode.runtime !== "cloud") throw err
      await page.reload({ waitUntil: "domcontentloaded" })
      await expect(promptInput(page)).toBeVisible({ timeout: 60_000 })
    })
    await expect.poll(async () => await activeSessionId(page), {
      timeout: 30_000,
      message: "expected New Session to switch to a fresh draft surface",
    }).toBe("new")
    if (mode.runtime === "cloud") {
      const cloud = page.getByRole("button", { name: /^cloud$/i }).first()
      if (await visible(cloud)) {
        if ((await cloud.getAttribute("aria-pressed").catch(() => "")) !== "true") await cloud.click()
        await expect(cloud).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })
      }
      const selectExisting = page.getByRole("button", { name: /^Select$/i }).first()
      if (await visible(selectExisting)) {
        if ((await selectExisting.getAttribute("aria-pressed").catch(() => "")) !== "true") await selectExisting.click()
        await expect(selectExisting).toHaveAttribute("aria-pressed", "true", { timeout: 5_000 })
      }
    }
    if (!previousSessionId || previousSessionId === "new" || !previousTitle) return
    await expect.poll(async () => await activeSessionTitleText(page), {
      timeout: 30_000,
      message: "expected New Session to switch away from the previously active session title",
    }).not.toBe(previousTitle)
  }
  try {
    if (mode.runtime === "cloud") {
      await sampler.stop()
      await page.goto(mode.route, { waitUntil: "domcontentloaded" })
      await waitForNewSession()
      return
    }
    const header = mode.workspaceLabel
      ? page.getByTestId("workspace-header").filter({ hasText: mode.workspaceLabel }).first()
      : page.getByTestId("workspace-header").first()
    if (await visible(header)) {
      await header.hover().catch(() => undefined)
      const action = mode.workspaceLabel
        ? header.getByRole("button", { name: new RegExp(`^New session in ${escapeRegExp(mode.workspaceLabel)}$`, "i") }).first()
        : header.getByRole("button", { name: /New session in/i }).first()
      if (await visible(action)) {
        await action.click({ timeout: 5_000 })
        await waitForNewSession()
        return
      }
    }
    if (mode.workspaceLabel) {
      const action = page.getByRole("button", {
        name: new RegExp(`^New session in ${escapeRegExp(mode.workspaceLabel)}$`, "i"),
      }).first()
      if (await visible(action)) {
        await action.click({ timeout: 5_000 })
        await waitForNewSession()
        return
      }
    }
    const workspaceAction = page.getByRole("button", { name: /New session in/i }).first()
    if (await visible(workspaceAction)) {
      await workspaceAction.click({ timeout: 5_000 })
      await waitForNewSession()
      return
    }
    await page.getByRole("button", { name: /^New Session$/i }).first().click({ timeout: 5_000 })
    await waitForNewSession()
  } finally {
    await sampler.stop()
  }
}

async function fillAndEnter(page: Page, text: string, testInfo: TestInfo) {
  await expect(promptInput(page)).toBeVisible({ timeout: 30_000 })
  await promptInput(page).click()
  await page.keyboard.type(text)
  await expect(submitButton(page), "expected typing a prompt to enable Send; check live provider/auth configuration").toBeEnabled({
    timeout: 5_000,
  })
  const sampler = startNoBlankSampler(page, testInfo, `submit-${text.slice(0, 16)}`)
  await submitButton(page).click({ force: true })
  try {
    await expect.poll(async () => {
      if (await visibleStopButtonCenter(page)) return true
      const submitLabel = await submitButton(page).getAttribute("aria-label")
      if (submitLabel === "Stop") return true
      if (submitLabel && !/^Send$/i.test(submitLabel)) return true
      if (await visible(page.getByText(/Booting|Creating session|Opening session|Sending first message|Loading models|Preparing workspace|Runtime ready/i).last())) return true
      if (await visible(page.locator('[data-component="cloud-startup-view"]:visible').last())) return true
      if (await visibleBusyIndicator(page)) return true
      const editorText = (await promptInput(page).textContent().catch(() => "") ?? "").trim()
      return !editorText.includes(text) && await visible(page.getByText(text, { exact: false }).first())
    }, {
      timeout: 3 * 60_000,
      intervals: [50, 100, 150, 250, 500, 1_000],
      message: "expected visible submission feedback within 180s",
    }).toBe(true)
    return sampler
  } catch (err) {
    await sampler.stop()
    throw err
  }
}

async function visibleBusyIndicator(page: Page) {
  return await page.evaluate(() => {
    const visibleElement = (el: Element) => {
      const style = window.getComputedStyle(el)
      const box = el.getBoundingClientRect()
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0
    }
    return [...document.querySelectorAll('[data-claxedo] [class*="animate-spin"], [data-claxedo] [aria-busy="true"]')]
      .some(visibleElement)
  }).catch(() => false)
}

async function cancelActiveTurn(page: Page, testInfo: TestInfo) {
  const sampler = await fillAndEnter(page, CANCEL_PROMPT, testInfo)
  try {
    await expect.poll(async () => {
      const point = await visibleStopButtonCenter(page)
      if (!point) return false
      await page.mouse.click(point.x, point.y)
      return true
    }, {
      timeout: 3 * 60_000,
      intervals: [50, 100, 150, 250],
      message: "expected Stop to become visible and clickable for cancellation",
    }).toBe(true)
    await expect(submitButton(page)).toHaveAttribute("aria-label", /Send/i, { timeout: 30_000 })
  } finally {
    await sampler.stop()
  }
}

async function sendAndWaitForReply(page: Page, prompt: string, testInfo: TestInfo) {
  const beforeText = await page.locator("[data-claxedo]").innerText({ timeout: 30_000 }).catch(() => "")
  const sampler = await fillAndEnter(page, prompt, testInfo)
  try {
    await expect.poll(async () => await page.locator("[data-claxedo]").innerText().catch(() => ""), {
      timeout: 10_000,
      message: "expected submitted prompt to appear in the visible timeline",
    }).toContain(prompt)
    await expect(submitButton(page)).toHaveAttribute("aria-label", /Send/i, { timeout: 5 * 60_000 })
    await expect.poll(async () => {
      const nextText = await page.locator("[data-claxedo]").innerText().catch(() => "")
      return nextText.length > beforeText.length && nextText !== beforeText
    }, {
      timeout: 30_000,
      message: "expected assistant response content to appear without reloading",
    }).toBe(true)
  } finally {
    await sampler.stop()
  }
}

async function expectPromptsInVisibleTimeline(page: Page, prompts: string[]) {
  for (const prompt of prompts) {
    await expect.poll(async () => {
      const text = await page.locator("[data-claxedo]").innerText().catch(() => "")
      return visiblePromptVariants(prompt).some((variant) => text.includes(variant))
    }, {
      timeout: 10_000,
      message: `expected "${prompt}" to remain visible in the same session`,
    }).toBe(true)
  }
}

function visiblePromptVariants(prompt: string) {
  if (prompt === FIRST_PROMPT) return [prompt, "Live happy-flow first prompt"]
  return [prompt]
}

async function reloadAndResumeSession(page: Page, mode: Mode, testInfo: TestInfo) {
  const sessionID = await activeSessionId(page)
  expect(sessionID, "expected a real created session before reload").toBeTruthy()
  expect(sessionID, "expected reload coverage to target a persisted session").not.toBe("new")
  await expectSelectedLiveModel(page, mode)

  logStep(mode, `reload session ${sessionID}`)
  await page.reload({ waitUntil: "domcontentloaded" })
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  const sampler = startNoBlankSampler(page, testInfo, "resume-session")
  try {
    await expect(
      page.locator(`[data-testid="session-content"][data-session-id="${sessionID}"]:visible`).last(),
      "expected reload to restore the same session surface",
    ).toBeVisible({ timeout: 30_000 })
    await expect(promptInput(page)).toBeVisible({ timeout: 30_000 })
    await expectPromptsInVisibleTimeline(page, [FIRST_PROMPT, SECOND_PROMPT])
    await expectSelectedLiveModel(page, mode)
    await sendAndWaitForReply(page, RESUME_PROMPT, testInfo)
    await expectPromptsInVisibleTimeline(page, [FIRST_PROMPT, SECOND_PROMPT, RESUME_PROMPT])
  } finally {
    await sampler.stop()
  }
}

async function clickNewTerminal(page: Page, mode: Mode, testInfo: TestInfo) {
  const sampler = startNoBlankSampler(page, testInfo, "terminal-create", { allowSurfaceSwap: true })
  try {
    const header = mode.workspaceLabel
      ? page.getByTestId("workspace-header").filter({ hasText: mode.workspaceLabel }).first()
      : page.getByTestId("workspace-header").first()
    if (await visible(header)) {
      await header.hover().catch(() => undefined)
      const action = mode.workspaceLabel
        ? header.getByRole("button", { name: new RegExp(`^New terminal in ${escapeRegExp(mode.workspaceLabel)}$`, "i") }).first()
        : header.getByRole("button", { name: /New terminal in/i }).first()
      if (await visible(action)) {
        await action.click({ timeout: 5_000 })
        return sampler
      }
    }
    if (mode.workspaceLabel) {
      const action = page.getByRole("button", {
        name: new RegExp(`^New terminal in ${escapeRegExp(mode.workspaceLabel)}$`, "i"),
      }).first()
      if (await visible(action)) {
        await action.click({ timeout: 5_000 })
        return sampler
      }
    }
    const workspaceAction = page.getByRole("button", { name: /New terminal in/i }).first()
    if (await visible(workspaceAction)) {
      await workspaceAction.click({ timeout: 5_000 })
      return sampler
    }
    await page.getByRole("button", { name: /^New Terminal$/i }).first().click({ timeout: 5_000 })
    return sampler
  } catch (err) {
    await sampler.stop()
    throw err
  }
}

async function terminalOutput(page: Page) {
  return await page.evaluate(() => {
    const frames = ((window as unknown as Record<string, string[]>).__claxedoPtyFrames ?? []).join("")
    const dom = [...document.querySelectorAll<HTMLElement>('[data-component="terminal"]')]
      .map((el) => el.innerText)
      .join("\n")
    return `${dom}\n${frames}`
  }).catch(() => "")
}

async function focusTerminal(page: Page) {
  const terminal = page.locator('[data-component="terminal"]:visible').last()
  await expect(terminal).toBeVisible({ timeout: 60_000 })
  await terminal.click({ force: true, position: { x: 20, y: 20 } })
  await expect.poll(() => terminalOutput(page), {
    timeout: 30_000,
    message: "expected terminal shell prompt before typing",
  }).toMatch(/[#$>] ?$/m)
  await terminal.evaluate((el) => {
    const textarea = el.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea, textarea")
    if (textarea) {
      textarea.focus()
      return
    }
    ;(el as HTMLElement).focus()
  })
  await expect.poll(async () => await page.evaluate(() => {
    const active = document.activeElement
    return !!active?.closest?.('[data-component="terminal"]')
  }), {
    timeout: 5_000,
    message: "expected xterm input to receive focus",
  }).toBe(true)
}

async function typeTerminalCommand(page: Page, command: string) {
  await focusTerminal(page)
  await page.keyboard.type(command, { delay: 5 })
  await page.keyboard.press("Enter")
  await expect.poll(() => terminalOutput(page), {
    timeout: 10_000,
    message: "expected typed terminal command to echo",
  }).toContain(command)
}

async function runTerminalScenario(page: Page, mode: Mode, testInfo: TestInfo) {
  const sessionID = await activeSessionId(page)
  expect(sessionID, "expected a session surface before creating a terminal").toBeTruthy()
  const sessionTitle = (await activeSessionTitleText(page))?.trim()
  const sidebar = page.getByRole("navigation", { name: "Projects and sessions" })
  const ptyResponse = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return url.pathname.endsWith("/api/claxedo/pty")
      && response.request().method() === "POST"
      && response.status() === 200
  }, { timeout: 60_000 })

  const sampler = await clickNewTerminal(page, mode, testInfo)
  let samplerStopped = false
  try {
    const pty = await (await ptyResponse).json() as { id?: string; title?: string }
    expect(pty.id, "expected live PTY create to return an id").toMatch(/^pty_/)
    await expect(page.locator('[data-component="terminal"]:visible').last()).toBeVisible({ timeout: 60_000 })

    const marker = `CLAXEDO_LIVE_TERMINAL_${Date.now()}`
    const command = `printf '${marker}\\n'`
    if (mode.runtime === "cloud") {
      await expect.poll(() => terminalOutput(page), {
        timeout: 60_000,
        message: "expected cloud terminal shell prompt to appear",
      }).toMatch(/[#$>] ?$/m)
    }
    await typeTerminalCommand(page, command)
    await expect.poll(() => terminalOutput(page), {
      timeout: 60_000,
      message: "expected typed terminal command output to appear",
    }).toContain(marker)
    await sampler.stop()
    samplerStopped = true

    const terminalTab = sidebar.getByRole("button", { name: /^Terminal\b/i }).first()
    await expect(terminalTab).toBeVisible({ timeout: 10_000 })
    const titledSessionTab = sessionTitle
      ? sidebar.getByRole("button").filter({ hasText: sessionTitle }).first()
      : sidebar.getByRole("button", { name: /Session|Live|Happy|Prompt|First/i }).first()
    const sessionTab = await visible(titledSessionTab)
      ? titledSessionTab
      : sidebar.getByRole("button", { name: /Session|Live|Happy|Flow|Prompt|First/i }).first()
    await expect(sessionTab).toBeVisible({ timeout: 10_000 })
    await sessionTab.click()
    await expect(
      page.locator(`[data-testid="session-content"][data-session-id="${sessionID}"]:visible`).last(),
      "expected session tab switch to restore the chat surface",
    ).toBeVisible({ timeout: 15_000 })
    await expectPromptsInVisibleTimeline(page, [FIRST_PROMPT, SECOND_PROMPT, RESUME_PROMPT])
    await terminalTab.click()
    await expect(page.locator('[data-component="terminal"]:visible').last()).toBeVisible({ timeout: 15_000 })
    const terminalSurvived = expect.poll(() => terminalOutput(page), {
      timeout: 15_000,
      message: "expected terminal output to survive tab switching",
    })
    await terminalSurvived.toContain(marker)
  } finally {
    if (!samplerStopped) await sampler.stop()
  }
}

async function workspaceSidebarText(page: Page) {
  return await page.getByRole("navigation", { name: "Projects and sessions" }).innerText().catch(() => "")
}

async function sessionTitleEvidence(page: Page, mode: Mode) {
  const title = await activeSessionTitleText(page)
  return [
    await workspaceSidebarText(page),
    title ?? "",
    await activeControlPlaneTitle(page, mode),
  ].filter(Boolean).join("\n")
}

async function activeControlPlaneTitle(page: Page, mode: Mode) {
  if (mode.runtime !== "local" || !mode.routeDirectory) return ""
  const sessionID = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1)
  if (!sessionID || sessionID === "session") return ""
  return await page.evaluate(async ({ directory, sessionID }) => {
    const url = new URL("/api/control/sessions", window.location.origin.replace(/:\d+$/, ":3001"))
    url.searchParams.set("directory", directory)
    const res = await fetch(url)
    if (!res.ok) return ""
    const body = await res.json().catch(() => ({ sessions: [] }))
    const sessions = Array.isArray(body?.sessions) ? body.sessions : []
    const match = sessions.find((item: { sessionID?: string; id?: string }) => item.sessionID === sessionID || item.id === sessionID)
    return typeof match?.title === "string" ? match.title : ""
  }, { directory: mode.routeDirectory, sessionID }).catch(() => "")
}

async function runCanonicalScenario(page: Page, mode: Mode, testInfo: TestInfo) {
  logStep(mode, "start")
  await installPtyFrameCapture(page)
  if (mode.auth === "authenticated") await signIn(page)
  else await signOut(page)

  logStep(mode, `goto ${mode.route}`)
  await page.goto(mode.route!)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

  if (mode.runtime === "cloud") await assertProvisioningTransitionIfPresent(page, testInfo)

  logStep(mode, "create cancellation session")
  await clickNewSession(page, mode, testInfo)
  await expect(promptInput(page)).toBeVisible({ timeout: 30_000 })
  logStep(mode, "select cancellation model")
  await selectLiveModel(page, mode, testInfo)
  logStep(mode, "cancel active turn")
  await cancelActiveTurn(page, testInfo)
  await expect(promptInput(page)).toBeVisible({ timeout: 30_000 })

  logStep(mode, "create completion session")
  await clickNewSession(page, mode, testInfo)
  logStep(mode, "select completion model")
  await selectLiveModel(page, mode, testInfo)
  await expect.poll(() => workspaceSidebarText(page), {
    timeout: 10_000,
    message: "expected the new session to appear in the workspace sidebar immediately",
  }).toMatch(/new|session/i)
  logStep(mode, "send first prompt")
  await sendAndWaitForReply(page, FIRST_PROMPT, testInfo)
  logStep(mode, "wait for title update")
  await expect.poll(() => sessionTitleEvidence(page, mode), {
    timeout: 2 * 60_000,
    message: "expected the session title inventory to update from the first prompt",
  }).toMatch(/live|happy|flow|first|prompt/i)
  logStep(mode, "send second prompt")
  await sendAndWaitForReply(page, SECOND_PROMPT, testInfo)
  logStep(mode, "assert same-session prompts")
  await expectPromptsInVisibleTimeline(page, [FIRST_PROMPT, SECOND_PROMPT])
  logStep(mode, "reload and resume session")
  await reloadAndResumeSession(page, mode, testInfo)
  logStep(mode, "create terminal and switch tabs")
  await runTerminalScenario(page, mode, testInfo)
  logStep(mode, "scenario complete")
}

async function assertProvisioningTransitionIfPresent(page: Page, testInfo: TestInfo) {
  const provisioning = page.getByText(/Provisioning|Starting sandbox|Preparing workspace|Starting runtime/i).first()
  if (!await visible(provisioning)) return
  const sampler = startNoBlankSampler(page, testInfo, "cloud-provisioning")
  try {
    await expect(promptInput(page)).toBeVisible({ timeout: 5 * 60_000 })
  } finally {
    await sampler.stop()
  }
}

function startNoBlankSampler(page: Page, testInfo: TestInfo, label: string, options: { allowSurfaceSwap?: boolean } = {}) {
  const samples: string[] = []
  let stopped = false
  let failed: Error | undefined
  const loop = (async () => {
    let blankSamples = 0
    let surfaceSeen = false
    while (!stopped && !failed) {
      const state = await page.evaluate(() => {
        const visibleElement = (el: Element) => {
          const style = window.getComputedStyle(el)
          const box = el.getBoundingClientRect()
          return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0
        }
        const root = document.querySelector("[data-claxedo]")
        if (!root) return { root: false, surface: false, content: false, text: "" }
        const terminal = [...root.querySelectorAll('[data-component="terminal"]')]
          .some(visibleElement)
        const surface = terminal || [...root.querySelectorAll('[data-testid="session-content"], [data-component="prompt-input"], [role="textbox"]')]
          .some(visibleElement)
        const controls = [...root.querySelectorAll("button, input, textarea, [contenteditable='true'], [role='textbox']")]
          .some(visibleElement)
        const text = (root as HTMLElement).innerText.trim()
        return { root: true, surface, terminal, content: controls || text.length > 0, text: text.slice(0, 400) }
      }).catch((err) => {
        return { root: false, surface: false, terminal: false, content: false, text: String(err) }
      })
      samples.push(`${Date.now()} root=${state.root} surface=${state.surface} terminal=${state.terminal} content=${state.content} text=${state.text.replace(/\s+/g, " ").slice(0, 160)}`)
      if (!state.root) failed = new Error(`[${label}] [data-claxedo] disappeared`)
      if (state.surface) surfaceSeen = true
      if (surfaceSeen && !state.surface && !options.allowSurfaceSwap) failed = new Error(`[${label}] active session surface disappeared`)
      blankSamples = state.content ? 0 : blankSamples + 1
      if (blankSamples > 1) failed = new Error(`[${label}] workbench had no visible user-facing content for more than one sample`)
      await page.waitForTimeout(50)
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop.catch((err) => {
        failed = err instanceof Error ? err : new Error(String(err))
      })
      if (!failed) return
      await testInfo.attach(`${label}-dom-summary.txt`, {
        body: samples.slice(-40).join("\n"),
        contentType: "text/plain",
      })
      await testInfo.attach(`${label}-screenshot.png`, {
        body: await page.screenshot({ fullPage: true }).catch(() => Buffer.from("")),
        contentType: "image/png",
      })
      throw failed
    },
  }
}

function assertRouting(mode: Mode, hits: Telemetry) {
  const sessionPosts = hits.requests.filter((item) =>
    item.method === "POST" && (item.pathname === "/session" || /\/session\/[^/]+\/prompt_async$/.test(item.pathname))
  )
  const abortPosts = hits.requests.filter((item) =>
    item.method === "POST" && /\/session\/[^/]+\/abort$/.test(item.pathname)
  )
  expect(sessionPosts.length, "expected session creation/prompt POSTs").toBeGreaterThan(0)
  expect(abortPosts.length, "expected cancellation through the real runtime abort route").toBeGreaterThan(0)
  if (mode.runtime === "local") {
    expect(sessionPosts.filter((item) => item.authorization)).toEqual([])
  }
  if (mode.runtime === "cloud") {
    expect(hits.requests.some((item) => item.pathname.includes("/workspaces/") && item.pathname.includes("/prompt_async")))
      .toBe(true)
  }
  if (mode.auth === "authenticated" && mode.runtime === "cloud") {
    expect(hits.requests.some((item) => item.authorization === "Bearer")).toBe(true)
  }
}

function unexpectedResponses(mode: Mode, hits: Telemetry) {
  return hits.responses.filter((item) => {
    if (mode.auth === "authenticated" && item.status === 401 && item.pathname.startsWith("/api/workspace")) return false
    return true
  })
}

test.describe.serial("live happy flows", () => {
  test.describe.configure({ timeout: 12 * 60_000 })

  test.beforeAll(async () => {
    await fsp.mkdir(LOCAL_DIR, { recursive: true })
    if (process.env.CLAXEDO_LIVE_HAPPYFLOWS === "1" && modes().some((mode) => mode.auth === "authenticated" && mode.required.length === 0)) {
      await ensureClerkUser()
    }
  })

  for (const mode of modes()) {
    test(`${mode.name} creates, cancels, completes, and continues a session`, async ({ page }, testInfo) => {
      test.setTimeout(12 * 60_000)
      test.skip(process.env.CLAXEDO_LIVE_HAPPYFLOWS !== "1", "set CLAXEDO_LIVE_HAPPYFLOWS=1 to run live happy flows")
      test.skip(!mode.route, `missing live route for ${mode.name}`)
      test.skip(mode.required.length > 0, `missing ${mode.required.join(", ")}`)

      const hits = telemetry(page)
      try {
        await runCanonicalScenario(page, mode, testInfo)
        assertRouting(mode, hits)
        expect(unexpectedResponses(mode, hits)).toEqual([])
        expect(hits.failed).toEqual([])
        expect(hits.console).toEqual([])
      } finally {
        await testInfo.attach(`${mode.name.replace(/\s+/g, "-")}-telemetry.json`, {
          body: JSON.stringify(hits, null, 2),
          contentType: "application/json",
        })
      }
    })
  }
})
