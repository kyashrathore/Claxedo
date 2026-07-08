import { test, expect, type Page } from "@playwright/test"
import fs from "node:fs/promises"
import http, { type IncomingMessage, type ServerResponse } from "node:http"
import os from "node:os"
import path from "node:path"
import { spawn, execFile, type ChildProcess } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import { promisify } from "node:util"

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3379)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const execFileAsync = promisify(execFile)

let backend: ChildProcess | undefined
let fakeOpencode: http.Server | undefined
let fakeOpencodeUrl = ""
let fakeOpencodeHits: string[] = []
let backendLog = ""
let dataDir = ""
let workspaceDir = ""
let extensionRepoDir = ""

type RequestHit = {
  method: string
  url: string
  authorization?: string
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function until<T>(fn: () => Promise<T | undefined>, ms = 60_000, step = 250): Promise<T> {
  const end = Date.now() + ms
  let err: unknown
  while (Date.now() < end) {
    try {
      const out = await fn()
      if (out !== undefined) return out
    } catch (next) {
      err = next
    }
    await new Promise((resolve) => setTimeout(resolve, step))
  }
  throw err instanceof Error ? err : new Error("Timed out")
}

async function live(ms = 1_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(`${BACKEND_URL}/global/health`, { signal: ctrl.signal }).catch(() => undefined)
    return !!res?.ok
  } finally {
    clearTimeout(timer)
  }
}

function textPart(input: unknown) {
  if (!Array.isArray(input)) return ""
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const row = item as { type?: unknown; text?: unknown; content?: unknown }
    if (row.type !== "text") return []
    return [typeof row.text === "string" ? row.text : typeof row.content === "string" ? row.content : ""]
  }).join("")
}

function readJson(req: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolve) => {
    let raw = ""
    req.on("data", (chunk) => {
      raw += chunk.toString()
    })
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as Record<string, unknown>)
      } catch {
        resolve({})
      }
    })
  })
}

function writeJson(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(value))
}

async function startFakeOpencode() {
  fakeOpencodeHits = []
  const sessions = new Map<string, Record<string, unknown>>()
  const messages = new Map<string, unknown[]>()
  const streams = new Set<ServerResponse>()
  let nextSession = 1

  const sendEvent = (event: unknown) => {
    for (const stream of streams) {
      stream.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  }

  fakeOpencode = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    fakeOpencodeHits.push(`${req.method ?? "GET"} ${url.pathname}`)
    const directory = String(req.headers["x-opencode-directory"] ?? workspaceDir)

    if (req.method === "GET" && url.pathname === "/global/event") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      })
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
      streams.add(res)
      req.on("close", () => streams.delete(res))
      return
    }

    if (req.method === "GET" && url.pathname === "/session/status") {
      writeJson(res, {})
      return
    }

    if (req.method === "GET" && ["/mcp", "/lsp", "/vcs", "/agent", "/command"].includes(url.pathname)) {
      writeJson(res, url.pathname === "/agent" ? [{
        name: "build",
        description: "Build agent",
        mode: "primary",
        permission: [],
        options: {},
      }] : [])
      return
    }

    if (req.method === "GET" && url.pathname === "/provider") {
      writeJson(res, {
        all: [{
          id: "opencode",
          name: "OpenCode",
          env: [],
          models: {
            "test-model": {
              id: "test-model",
              name: "Test Model",
              release_date: "2026-01-01",
              attachment: true,
              reasoning: false,
              temperature: true,
              tool_call: true,
              limit: { context: 128000, output: 8192 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
        }],
        default: { opencode: "test-model" },
        connected: ["opencode"],
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/provider/auth") {
      writeJson(res, {})
      return
    }

    if (req.method === "GET" && (url.pathname === "/config" || url.pathname === "/global/config")) {
      writeJson(res, { provider: { id: "opencode", model: "test-model" }, agent: { id: "build" } })
      return
    }

    if (req.method === "GET" && url.pathname === "/config/providers") {
      writeJson(res, {
        providers: [{
          id: "opencode",
          name: "OpenCode",
          models: [{
            id: "test-model",
            providerID: "opencode",
            name: "Test Model",
          }],
        }],
        default: { opencode: "test-model" },
      })
      return
    }

    if (req.method === "GET" && url.pathname === "/session") {
      writeJson(res, [...sessions.values()])
      return
    }

    if (req.method === "POST" && url.pathname === "/session") {
      const body = await readJson(req)
      const id = `fake-local-session-${nextSession++}`
      const now = Date.now()
      const session = {
        id,
        title: typeof body.title === "string" ? body.title : null,
        directory,
        time: { created: now, updated: now },
      }
      sessions.set(id, session)
      messages.set(id, [])
      writeJson(res, session, 201)
      return
    }

    const prompt = url.pathname.match(/^\/session\/([^/]+)\/prompt_async$/)
    if (req.method === "POST" && prompt) {
      const sessionId = decodeURIComponent(prompt[1]!)
      const body = await readJson(req)
      const userId = typeof body.messageID === "string" ? body.messageID : `fake-user-${Date.now()}`
      const assistantId = `${userId}_r`
      const text = textPart(body.parts)
      const model = body.model && typeof body.model === "object"
        ? body.model as { providerID?: string; modelID?: string }
        : {}
      const agent = typeof body.agent === "string" ? body.agent : "build"
      const now = Date.now()
      const reply = `live local reply: ${text}`
      const nextMessages = [
        ...(messages.get(sessionId) ?? []),
        {
          info: {
            id: userId,
            sessionID: sessionId,
            role: "user",
            time: { created: now },
            agent,
            model: {
              providerID: model.providerID ?? "opencode",
              modelID: model.modelID ?? "test-model",
            },
          },
          parts: [{
            id: `${userId}-part`,
            sessionID: sessionId,
            messageID: userId,
            type: "text",
            text,
          }],
        },
        {
          info: {
            id: assistantId,
            sessionID: sessionId,
            role: "assistant",
            parentID: userId,
            time: { created: now, completed: now + 1 },
            agent,
            providerID: model.providerID ?? "opencode",
            modelID: model.modelID ?? "test-model",
            path: { cwd: directory, root: directory },
          },
          parts: [{
            id: `${assistantId}-part`,
            sessionID: sessionId,
            messageID: assistantId,
            type: "text",
            text: reply,
          }],
        },
      ]
      messages.set(sessionId, nextMessages)
      sendEvent({
        type: "message.part.updated",
        properties: {
          part: {
            id: `${assistantId}-part`,
            sessionID: sessionId,
            messageID: assistantId,
            type: "text",
            text: reply,
          },
        },
      })
      sendEvent({ type: "session.idle", properties: { sessionID: sessionId } })
      res.writeHead(204)
      res.end()
      return
    }

    const sessionMessages = url.pathname.match(/^\/session\/([^/]+)\/message$/)
    if (req.method === "GET" && sessionMessages) {
      writeJson(res, messages.get(decodeURIComponent(sessionMessages[1]!)) ?? [])
      return
    }

    const session = url.pathname.match(/^\/session\/([^/]+)$/)
    if (req.method === "GET" && session) {
      const hit = sessions.get(decodeURIComponent(session[1]!))
      writeJson(res, hit ?? { error: "Not found" }, hit ? 200 : 404)
      return
    }

    if (req.method === "GET" && (url.pathname === "/permission" || url.pathname === "/question")) {
      writeJson(res, [])
      return
    }

    const todo = url.pathname.match(/^\/session\/([^/]+)\/todo$/)
    if (req.method === "GET" && todo) {
      writeJson(res, [])
      return
    }

    writeJson(res, { error: `Unhandled fake opencode route ${req.method} ${url.pathname}` }, 404)
  })

  await new Promise<void>((resolve) => fakeOpencode!.listen(0, "127.0.0.1", resolve))
  const address = fakeOpencode.address()
  if (!address || typeof address === "string") throw new Error("Fake opencode did not bind to a TCP port")
  fakeOpencodeUrl = `http://127.0.0.1:${address.port}`
}

async function startBackend() {
  if (await live()) throw new Error(`Port ${BACKEND_PORT} is already in use`)
  const node22 = path.join(os.homedir(), ".nvm", "versions", "node", "v22.22.0", "bin", "node")
  const nodeBin = await fs.access(node22).then(() => node22).catch(async () =>
    (await execFileAsync("zsh", ["-lc", "command -v node"])).stdout.trim() || "node"
  )
  backend = spawn(nodeBin, ["--import", "tsx", "src/main.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      CLAXEDO_SIGNED_CLOUD_AUTH: "0",
      OPENCODE_URL: fakeOpencodeUrl,
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: `url.${pathToFileURL(extensionRepoDir).toString()}.insteadOf`,
      GIT_CONFIG_VALUE_0: "https://github.com/acme/claxedo-e2e-agent-extension.git",
      GIT_CONFIG_KEY_1: `url.${pathToFileURL(extensionRepoDir).toString()}.insteadOf`,
      GIT_CONFIG_VALUE_1: "https://github.com/other/claxedo-e2e-agent-extension.git",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  backend.stdout?.on("data", (chunk) => {
    backendLog += chunk.toString()
  })
  backend.stderr?.on("data", (chunk) => {
    backendLog += chunk.toString()
  })
  await until(async () => await live() ? true : undefined, 120_000).catch((err) => {
    throw new Error(`${String(err)}\n${backendLog}`)
  })
}

async function ensureLocalWorkspace() {
  const res = await fetch(`${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(workspaceDir)}&create=true`, {
    headers: { Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Failed to create local workspace: ${res.status} ${await res.text()}`)
  const workspace = await res.json() as { kind?: string; directory?: string }
  if (workspace.kind !== "local" || workspace.directory !== workspaceDir) {
    throw new Error(`Unexpected local workspace: ${JSON.stringify(workspace)}`)
  }
}

async function stopBackend() {
  if (!backend) return
  if (backend.exitCode === null) {
    backend.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      backend?.once("exit", () => resolve())
      setTimeout(resolve, 10_000)
    })
    if (backend.exitCode === null) backend.kill("SIGKILL")
  }
  backend = undefined
}

async function stopFakeOpencode() {
  if (!fakeOpencode) return
  await new Promise<void>((resolve) => fakeOpencode?.close(() => resolve()))
  fakeOpencode = undefined
  fakeOpencodeUrl = ""
}

async function seed(page: Page) {
  await page.addInitScript(
    (input: { backend: string; workspace: string }) => {
      localStorage.clear()
      ;(window as typeof window & {
        __OPENCODE__?: {
          serverUrl?: string
          activeDirectory?: string
        }
      }).__OPENCODE__ = {
        serverUrl: input.backend,
        activeDirectory: input.workspace,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [{ worktree: input.workspace, expanded: true }],
          },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:globalSync.project",
        JSON.stringify({
          value: [{
            id: "proj_local_personal",
            name: "Local Personal",
            worktree: input.workspace,
            sandboxes: [],
          }],
        }),
      )
      localStorage.setItem(
        "opencode.global.dat:model",
        JSON.stringify({
          recent: [{ providerID: "opencode", modelID: "test-model" }],
          user: [],
          variant: {},
        }),
      )
    },
    { backend: BACKEND_URL, workspace: workspaceDir },
  )
}

async function wire(page: Page, hits?: {
  backend: RequestHit[]
  signedControlPlane: RequestHit[]
  relayConnection: RequestHit[]
  failed: string[]
}) {
  page.on("requestfailed", (request) => {
    hits?.failed.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
  })

  await page.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/.*$/, async (route, request) => {
    const current = new URL(request.url())
    if (Number(current.port || (current.protocol === "https:" ? "443" : "80")) === FRONTEND_PORT) {
      await route.continue()
      return
    }
    const hit = {
      method: request.method(),
      url: request.url(),
      authorization: request.headers().authorization,
    }
    hits?.backend.push(hit)
    if (current.pathname.startsWith("/api/control/")) {
      hits?.signedControlPlane.push(hit)
    }
    if (/^\/api\/workspace\/[^/]+\/connection(?:\/refresh)?$/.test(current.pathname)) hits?.relayConnection.push(hit)
    await route.continue({
      url: `${BACKEND_URL}${current.pathname}${current.search}`,
      headers: {
        ...request.headers(),
        "x-opencode-directory": workspaceDir,
      },
    })
  })
}

async function openApp(page: Page) {
  await page.goto(`/${slug(workspaceDir)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
}

async function openFileDialog(page: Page) {
  if (!await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  }
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  if (!await page.locator('[data-testid="review-pane-root"]').isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
  }
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Add workspace tab", exact: true }).click()
  await page.getByRole("menuitem", { name: "File", exact: true }).click()
  await expect(page.getByRole("dialog").getByPlaceholder("Search files")).toBeVisible({ timeout: 10_000 })
}

async function openProcessPanel(page: Page) {
  if (!await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  }
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  if (!await page.locator('[data-testid="review-pane-root"]').isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
  }
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Processes", exact: true }).first().click()
  await expect(page.getByRole("button", { name: "Add process" }).first()).toBeVisible({ timeout: 10_000 })
}

async function openChangesPanel(page: Page) {
  if (!await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  }
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  if (!await page.locator('[data-testid="review-pane-root"]').isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Open workspace panel", exact: true }).first().click()
  }
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Changes", exact: true }).first().click()
}

async function openNewSession(page: Page) {
  if (await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) return
  await page.getByRole("button", { name: "New Session", exact: true }).first().click()
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
}

async function openRemoteAccessSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).first().click()
  await page.getByText("Remote Access", { exact: true }).click()
  await expect(page.getByRole("heading", { name: "Remote Access" })).toBeVisible({ timeout: 10_000 })
}

async function openAgentExtensionsSettings(page: Page) {
  await page.getByRole("button", { name: "Settings" }).first().click()
  await page.getByRole("tab", { name: "Extensions" }).click()
  await expect(page.getByRole("heading", { name: "Agent Extensions" })).toBeVisible({ timeout: 10_000 })
}

async function remoteAccessEnabled() {
  const res = await fetch(`${BACKEND_URL}/api/claxedo/tunnel/remote-access`)
  expect(res.status).toBe(200)
  return (await res.json() as { enabled: boolean }).enabled
}

test.describe.serial("Remote access settings live backend", () => {
  test.skip(
    process.env.CLAXEDO_REMOTE_ACCESS_LIVE !== "1",
    "set CLAXEDO_REMOTE_ACCESS_LIVE=1 to run local live backend remote-access flows",
  )

  test.beforeAll(async () => {
    test.setTimeout(150_000)
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-remote-access-data-"))
    workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-remote-access-workspace-")))
    extensionRepoDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-agent-extension-source-")))
    await execFileAsync("git", ["init"], { cwd: workspaceDir })
    await fs.writeFile(path.join(workspaceDir, "local-mode-proof.txt"), "hello through unsigned local mode\n")
    await fs.writeFile(path.join(workspaceDir, "diff-proof.txt"), "before\n")
    await execFileAsync("git", ["add", "diff-proof.txt"], { cwd: workspaceDir })
    await execFileAsync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", "commit", "-m", "baseline"], { cwd: workspaceDir })
    await fs.writeFile(path.join(workspaceDir, "diff-proof.txt"), "after\n")
    await execFileAsync("git", ["init", "-b", "main"], { cwd: extensionRepoDir })
    await fs.mkdir(path.join(extensionRepoDir, "review"), { recursive: true })
    await fs.writeFile(path.join(extensionRepoDir, "review", "SKILL.md"), "---\nname: review\n---\n\n# Review\n")
    await execFileAsync("git", ["add", "review/SKILL.md"], { cwd: extensionRepoDir })
    await execFileAsync("git", ["-c", "user.email=e2e@example.com", "-c", "user.name=E2E", "commit", "-m", "extension fixture"], { cwd: extensionRepoDir })
    await startFakeOpencode()
    await startBackend()
    await ensureLocalWorkspace()
  })

  test.afterAll(async () => {
    await stopBackend()
    await stopFakeOpencode()
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(extensionRepoDir, { recursive: true, force: true }).catch(() => undefined)
  })

  test.skip("toggles user-hosted remote access through the real settings UI and server route", async ({ page }) => {
    test.setTimeout(90_000)
    await wire(page)
    await seed(page)
    await openApp(page)
    await openRemoteAccessSettings(page)

    const toggleControl = page.getByRole("switch", { name: "User-hosted remote access" })
    const toggleVisual = page.locator('[data-component="switch"]').filter({ has: toggleControl }).locator('[data-slot="switch-control"]')
    const clickToggle = async () => {
      await toggleVisual.click()
    }
    const uiChecked = async () => await toggleControl.isChecked()
    const uiDisabled = async () => await toggleControl.isDisabled()
    await expect(toggleControl).toBeVisible()
    await expect.poll(uiDisabled).toBe(false)
    await expect.poll(uiChecked).toBe(false)
    const enable = page.waitForResponse((res) =>
      res.request().method() === "PUT" &&
      res.url().includes("/api/claxedo/tunnel/remote-access") &&
      res.status() === 200
    , { timeout: 10_000 })
    await clickToggle()
    await enable
    await expect.poll(uiChecked).toBe(true)
    await expect.poll(remoteAccessEnabled).toBe(true)

    const persistedEnabled = JSON.parse(await fs.readFile(path.join(dataDir, "remote-access.json"), "utf8")) as { enabled: boolean }
    expect(persistedEnabled.enabled).toBe(true)

    const disable = page.waitForResponse((res) =>
      res.request().method() === "PUT" &&
      res.url().includes("/api/claxedo/tunnel/remote-access") &&
      res.status() === 200
    , { timeout: 10_000 })
    await clickToggle()
    await disable
    await expect.poll(uiChecked).toBe(false)
    await expect.poll(remoteAccessEnabled).toBe(false)

    const persistedDisabled = JSON.parse(await fs.readFile(path.join(dataDir, "remote-access.json"), "utf8")) as { enabled: boolean }
    expect(persistedDisabled.enabled).toBe(false)
  })

  test("loads Local Personal Mode files without signed Control Plane or Workspace Relay", async ({ page }) => {
    test.setTimeout(90_000)
    const hits = {
      backend: [] as RequestHit[],
      signedControlPlane: [] as RequestHit[],
      relayConnection: [] as RequestHit[],
      failed: [] as string[],
    }
    await wire(page, hits)
    await seed(page)
    await openApp(page)

    await openFileDialog(page)
    await page.getByRole("dialog").getByRole("button", { name: /local-mode-proof\.txt/ }).click()
    await expect(page.getByText("hello through unsigned local mode")).toBeVisible({ timeout: 10_000 })

    expect(hits.failed).toEqual([])
    expect(hits.signedControlPlane).toEqual([])
    expect(hits.relayConnection).toEqual([])
    const runtimeFileHits = hits.backend.filter((item) => {
      const pathname = new URL(item.url).pathname
      return pathname === "/file" || pathname === "/file/content"
    })
    expect(runtimeFileHits.filter((item) => item.authorization)).toEqual([])
    expect(runtimeFileHits.map((item) => new URL(item.url).pathname)).toContain("/file")
    expect(runtimeFileHits.map((item) => new URL(item.url).pathname)).toContain("/file/content")
  })

  test("loads Local Personal Mode diffs without signed Control Plane or Workspace Relay", async ({ page }) => {
    test.setTimeout(90_000)
    const hits = {
      backend: [] as RequestHit[],
      signedControlPlane: [] as RequestHit[],
      relayConnection: [] as RequestHit[],
      failed: [] as string[],
    }
    await wire(page, hits)
    await seed(page)
    await openApp(page)

    await openChangesPanel(page)
    await expect(page.getByRole("button", { name: /diff-proof\.txt/ })).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText("after")).toBeVisible({ timeout: 15_000 })

    expect(hits.failed).toEqual([])
    expect(hits.signedControlPlane).toEqual([])
    expect(hits.relayConnection).toEqual([])
    const diffHits = hits.backend.filter((item) => new URL(item.url).pathname === "/api/claxedo/diff/vcs")
    expect(diffHits.map((item) => item.method)).toContain("GET")
    expect(diffHits.filter((item) => item.authorization)).toEqual([])
  })

  test("installs and manages a Local Personal Mode Agent Extension through the live settings UI", async ({ page }) => {
    test.setTimeout(120_000)
    const hits = {
      backend: [] as RequestHit[],
      signedControlPlane: [] as RequestHit[],
      relayConnection: [] as RequestHit[],
      failed: [] as string[],
    }
    await wire(page, hits)
    await seed(page)
    await openApp(page)
    await openAgentExtensionsSettings(page)

    await page.getByPlaceholder("/path/to/project").fill(workspaceDir)
    await page.getByText("Advanced: install from a custom GitHub source").click()
    await page.getByRole("button", { name: "Refresh" }).click()
    await expect(page.getByText("No Agent Extensions installed for this scope.")).toBeVisible({ timeout: 10_000 })
    const source = page.getByPlaceholder("owner/repo or https://github.com/owner/repo/tree/ref/package")
    await source.fill("https://github.com/acme/claxedo-e2e-agent-extension/tree/main/review")
    await expect(page.getByRole("button", { name: "Install" })).toBeEnabled({ timeout: 10_000 })
    const install = page.waitForResponse((res) =>
      res.request().method() === "POST" &&
      new URL(res.url()).pathname === "/api/claxedo/agent-config/extensions" &&
      res.status() === 201
    , { timeout: 30_000 })
    await page.getByRole("button", { name: "Install" }).click()
    await install

    await expect(page.getByText("acme/claxedo-e2e-agent-extension@main/review")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/claude, codex, cursor, opencode .* applied/)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => fs.readFile(path.join(workspaceDir, ".cursor", "skills", "review", "SKILL.md"), "utf8").catch(() => ""), {
      timeout: 30_000,
    }).toContain("name: review")
    await expect.poll(() => fs.readFile(path.join(workspaceDir, ".opencode", "skills", "review", "SKILL.md"), "utf8").catch(() => ""), {
      timeout: 30_000,
    }).toContain("name: review")

    await source.fill("https://github.com/other/claxedo-e2e-agent-extension/tree/main/review")
    const conflict = page.waitForResponse((res) =>
      res.request().method() === "POST" &&
      new URL(res.url()).pathname === "/api/claxedo/agent-config/extensions" &&
      res.status() === 409
    , { timeout: 30_000 })
    await page.getByRole("button", { name: "Install" }).click()
    await conflict
    await expect(page.getByLabel("Extensions").getByText("Agent Extension review is already installed from a different source")).toBeVisible({ timeout: 30_000 })

    const switches = page.getByRole("switch")
    await switches.last().press("Space")
    await expect(page.getByText("Desired state disabled: desired install is disabled")).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => fs.stat(path.join(workspaceDir, ".cursor", "skills", "review")).then(() => "exists").catch(() => "missing"), {
      timeout: 30_000,
    }).toBe("missing")

    await switches.last().press("Space")
    await expect(page.getByText(/claude, codex, cursor, opencode .* applied/)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => fs.readFile(path.join(workspaceDir, ".cursor", "skills", "review", "SKILL.md"), "utf8").catch(() => ""), {
      timeout: 30_000,
    }).toContain("name: review")
    await expect.poll(() => fs.readFile(path.join(workspaceDir, ".opencode", "skills", "review", "SKILL.md"), "utf8").catch(() => ""), {
      timeout: 30_000,
    }).toContain("name: review")

    await page.getByRole("button", { name: "Remove" }).click()
    await expect(page.getByText("No Agent Extensions installed for this scope.")).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => fs.stat(path.join(workspaceDir, ".cursor", "skills", "review")).then(() => "exists").catch(() => "missing"), {
      timeout: 30_000,
    }).toBe("missing")
    await expect.poll(() => fs.stat(path.join(workspaceDir, ".opencode", "skills", "review")).then(() => "exists").catch(() => "missing"), {
      timeout: 30_000,
    }).toBe("missing")

    expect(hits.failed).toEqual([])
    expect(hits.signedControlPlane).toEqual([])
    expect(hits.relayConnection).toEqual([])
    const extensionHits = hits.backend.filter((item) => new URL(item.url).pathname.startsWith("/api/claxedo/agent-config/extensions"))
    expect(extensionHits.map((item) => item.method)).toEqual(expect.arrayContaining(["GET", "POST", "DELETE"]))
    expect(extensionHits.filter((item) => item.authorization)).toEqual([])
  })

  test("sends a Local Personal Mode session message through the live local stream path", async ({ page }) => {
    test.setTimeout(90_000)
    const hits = {
      backend: [] as RequestHit[],
      signedControlPlane: [] as RequestHit[],
      relayConnection: [] as RequestHit[],
      failed: [] as string[],
    }
    await wire(page, hits)
    await seed(page)
    await openApp(page)

    await openNewSession(page)
    const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
    await expect(input).toHaveAttribute("contenteditable", "true")
    await input.fill("live local stream check")
    const send = page.getByRole("button", { name: "Send", exact: true }).last()
    await expect(send).toBeEnabled({ timeout: 10_000 })
    const promptAsyncResponse = page.waitForResponse((res) =>
      res.request().method() === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(new URL(res.url()).pathname)
    , { timeout: 10_000 })
    await page.locator('[data-action="prompt-submit"]').last().click()
    await expect.poll(() => hits.backend.map((item) => `${item.method} ${new URL(item.url).pathname}`).join("\n"), {
      timeout: 10_000,
    }).toContain("POST /session")
    const promptAsync = await promptAsyncResponse
    expect(promptAsync.ok(), `${await promptAsync.text()}\n${backendLog}`).toBe(true)
    await expect.poll(() => hits.backend.map((item) => `${item.method} ${new URL(item.url).pathname}`).join("\n"), {
      timeout: 10_000,
    }).toContain("/prompt_async")
    await expect.poll(() => fakeOpencodeHits.join("\n"), { timeout: 10_000 }).toContain("/prompt_async")
    const sessionId = await until(async () => {
      const hit = hits.backend.find((item) => {
        const pathname = new URL(item.url).pathname
        return item.method === "POST" && /^\/session\/[^/]+\/prompt_async$/.test(pathname)
      })
      return hit ? new URL(hit.url).pathname.split("/")[2] : undefined
    }, 10_000)
    await expect.poll(async () => {
      const res = await fetch(`${BACKEND_URL}/session/${encodeURIComponent(sessionId)}/message`, {
        headers: { Accept: "application/json", "x-opencode-directory": workspaceDir },
      })
      return await res.text()
    }, { timeout: 20_000 }).toContain("live local stream check")
    await page.reload()
    await expect(page.getByRole("log").getByText("live local stream check", { exact: true })).toBeVisible({ timeout: 20_000 })
    await expect(page.getByRole("log").getByText("live local reply: live local stream check", { exact: true })).toBeVisible({ timeout: 20_000 })

    expect(hits.failed.filter((item) =>
      !item.includes("/global/event net::ERR_ABORTED") &&
      !item.includes("/api/claxedo/events net::ERR_ABORTED") &&
      !item.includes("/@fs/") &&
      !item.includes("clerk.accounts.dev/")
    )).toEqual([])
    expect(hits.signedControlPlane).toEqual([])
    expect(hits.relayConnection).toEqual([])
    const sessionHits = hits.backend.filter((item) => {
      const pathname = new URL(item.url).pathname
      return pathname === "/session" || /^\/session\/[^/]+\/prompt_async$/.test(pathname)
    })
    expect(sessionHits.map((item) => `${item.method} ${new URL(item.url).pathname}`)).toContain("POST /session")
    expect(sessionHits.map((item) => `${item.method} ${new URL(item.url).pathname}`).some((item) =>
      item.startsWith("POST /session/") && item.endsWith("/prompt_async")
    )).toBe(true)
    expect(sessionHits.filter((item) => item.authorization)).toEqual([])
  })

  test("creates a process config through the live local process surface", async ({ page }) => {
    test.setTimeout(90_000)
    const hits = {
      backend: [] as RequestHit[],
      signedControlPlane: [] as RequestHit[],
      relayConnection: [] as RequestHit[],
      failed: [] as string[],
    }
    await wire(page, hits)
    await seed(page)
    await openApp(page)

    await openProcessPanel(page)

    const create = page.waitForResponse((res) =>
      res.request().method() === "POST" &&
      new URL(res.url()).pathname === "/api/claxedo/process"
    , { timeout: 10_000 })
    await page.getByRole("button", { name: "Add process" }).first().click()
    const dialog = page.getByRole("dialog", { name: "Add Process" })
    await expect(dialog).toBeVisible({ timeout: 10_000 })
    await dialog.getByTestId("process-name-input").fill("live-local-process")
    await dialog.getByTestId("process-command-input").fill("echo live process")
    await dialog.getByRole("button", { name: "Add", exact: true }).click()
    const createResponse = await create
    expect(createResponse.ok(), await createResponse.text()).toBe(true)

    await expect(page.getByRole("button", { name: /live-local-process/ }).first()).toBeVisible({ timeout: 10_000 })
    const saved = await fs.readFile(path.join(workspaceDir, ".claxedo", "processes.jsonc"), "utf8")
    expect(saved).toContain("live-local-process")

    expect(hits.failed).toEqual([])
    expect(hits.signedControlPlane).toEqual([])
    expect(hits.relayConnection).toEqual([])
    const processHits = hits.backend.filter((item) => new URL(item.url).pathname === "/api/claxedo/process")
    expect(processHits.map((item) => item.method)).toContain("GET")
    expect(processHits.map((item) => item.method)).toContain("POST")
    expect(processHits.filter((item) => item.authorization)).toEqual([])
  })
})
