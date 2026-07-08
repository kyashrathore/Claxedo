import { test, expect, type Locator, type Page } from "@playwright/test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = 3000
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const mod = process.platform === "darwin" ? "Meta" : "Control"
const PROC_ID = "proc_shared_server"
const PROC_NAME = "Shared Server"
const PANEL = `[data-component="process-pane-panel"][data-process-id="${PROC_ID}"]`

type ProcessList = {
  configs: Array<{ id: string; name: string }>
  processes: Array<{
    configId: string
    status: string
    assignedPort?: number
    ptyId?: string
  }>
}

type Diagnostics = {
  leaks: Array<{
    key: string
    children?: Array<{
      process_id?: string
      workspace_id?: string
    }>
  }>
}

let repo = ""
let sandbox = ""
let backend: ChildProcess | undefined
let log = ""
let own = false
let port = 0
let active = ""
let portHolder: net.Server | undefined

function run(cwd: string, ...cmd: string[]) {
  const out = spawnSync(cmd[0]!, cmd.slice(1), {
    cwd,
    encoding: "utf-8",
  })
  if (out.status === 0) return out.stdout.trim()
  throw new Error([out.stdout, out.stderr].filter(Boolean).join("\n") || `${cmd.join(" ")} failed`)
}

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function url(dir: string) {
  return `/${slug(dir)}/session`
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
    await new Promise((r) => setTimeout(r, step))
  }
  throw err instanceof Error ? err : new Error("Timed out")
}

async function call<T>(dir: string, input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}/api/wr${input}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": dir,
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    throw new Error(`${input} ${res.status}: ${await res.text()}`)
  }
  return await res.json() as T
}

async function ensureWorkspace(dir: string) {
  const url = new URL(`${BACKEND_URL}/api/workspace/resolve`)
  url.searchParams.set("directory", dir)
  url.searchParams.set("create", "true")
  const res = await fetch(url, {
    headers: {
      "x-opencode-directory": dir,
    },
  })
  if (!res.ok) {
    throw new Error(`/api/workspace/resolve ${res.status}: ${await res.text()}`)
  }
}

async function list(dir: string) {
  return await call<ProcessList>(dir, "/process")
}

async function diag(dir: string) {
  return await call<Diagnostics>(dir, "/process/diagnostics")
}

async function startWithPickNew(dir: string) {
  const res = await fetch(`${BACKEND_URL}/api/wr/process/${PROC_ID}/start?directory=${encodeURIComponent(dir)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": dir,
    },
    body: JSON.stringify({ portConflict: "pick-new" }),
  })
  return {
    url: res.url,
    code: res.status,
    text: await res.text(),
  }
}

async function stopDirect(dir: string) {
  const res = await fetch(`${BACKEND_URL}/api/wr/process/${PROC_ID}/stop?directory=${encodeURIComponent(dir)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-opencode-directory": dir,
    },
  })
  return {
    url: res.url,
    code: res.status,
    text: await res.text(),
  }
}

function proc(data: ProcessList) {
  return data.processes.find((item) => item.configId === PROC_ID)
}

function leaks(data: Diagnostics, dir: string) {
  return data.leaks.filter((item) =>
    (item.children ?? []).some((row) => row.process_id === PROC_ID || row.workspace_id === dir),
  ).length
}

async function free(port: number) {
  return await new Promise<boolean>((resolve) => {
    const server = net.createServer()
    server.once("error", () => resolve(false))
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true))
    })
  })
}

async function pickPort(start = 45100) {
  for (let next = start; next < start + 200; next += 1) {
    if (!await free(next)) continue
    if (!await free(next + 1)) continue
    return next
  }
  throw new Error("Could not find two adjacent free ports for process-project-shared e2e")
}

async function occupyIfFree(next: number) {
  if (!await free(next)) return
  return await new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(next, "127.0.0.1", () => resolve(server))
  })
}

async function ready() {
  await until(async () => {
    const res = await fetch(`${BACKEND_URL}/global/health`).catch(() => undefined)
    if (!res?.ok) return
    const body = await res.json().catch(() => undefined) as { healthy?: boolean } | undefined
    if (body?.healthy) return true
  }, 120_000)
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

async function startBackend() {
  if (await live()) {
    throw new Error(`Port ${BACKEND_PORT} is already in use; stop the existing backend before running this spec`)
  }
  backend = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DEBUG: "1",
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  own = true
  backend.stdout?.on("data", (chunk: Buffer | string) => {
    log += chunk.toString()
  })
  backend.stderr?.on("data", (chunk: Buffer | string) => {
    log += chunk.toString()
  })
  backend.on("exit", (code) => {
    if (code === 0 || code === null) return
    log += `\n[backend exited ${code}]\n`
  })
  await ready().catch((err) => {
    throw new Error(`${String(err)}\n${log}`)
  })
}

async function stopBackend() {
  if (!own || !backend) return
  if (backend.exitCode !== null) {
    backend = undefined
    own = false
    return
  }
  backend.kill("SIGTERM")
  await new Promise<void>((resolve) => {
      backend?.once("exit", () => resolve())
      setTimeout(resolve, 10_000)
    })
  if (backend.exitCode === null) backend.kill("SIGKILL")
  backend = undefined
  own = false
}

async function setupRepo() {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-process-e2e-"))
  repo = await fs.realpath(repo).catch(() => repo)
  port = await pickPort()
  await fs.writeFile(path.join(repo, "README.md"), "# e2e\n")
  await fs.writeFile(
    path.join(repo, "server.js"),
    [
      "const { spawn } = require('node:child_process')",
      "const { createServer } = require('node:http')",
      "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })",
      "createServer((_req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')",
      "setInterval(() => {}, 1000)",
      "",
    ].join("\n"),
  )
  run(repo, "git", "init", "-b", "main")
  run(repo, "git", "config", "user.email", "e2e@example.com")
  run(repo, "git", "config", "user.name", "Playwright E2E")
  run(repo, "git", "add", "README.md", "server.js")
  run(repo, "git", "commit", "-m", "init")
  await fs.mkdir(path.join(repo, ".claxedo"), { recursive: true })
  await fs.writeFile(
    path.join(repo, ".claxedo", "processes.jsonc"),
    JSON.stringify(
      {
        $schema: "./processes.schema.json",
        processes: [
          {
            id: PROC_ID,
            name: PROC_NAME,
            command: "node server.js",
            autoStart: false,
            restartPolicy: "never",
            maxRestarts: 3,
            port: {
              name: "shared-server",
              inject: "PORT",
              preferred: port,
            },
          },
        ],
      },
      null,
      2,
    ) + "\n",
  )
  run(repo, "git", "add", ".claxedo/processes.jsonc")
  run(repo, "git", "commit", "-m", "add process config")
}

async function setupSandbox() {
  await ensureWorkspace(repo)
  sandbox = `${repo}-sandbox`
  run(repo, "git", "worktree", "add", "-b", "process-shared-e2e", sandbox)
  sandbox = await fs.realpath(sandbox).catch(() => sandbox)
  await ensureWorkspace(sandbox)
  await until(async () => {
    const data = await list(sandbox)
    if (data.configs.some((item) => item.id === PROC_ID)) return true
  }, 60_000)
}

async function cleanupSandbox() {
  if (!sandbox) return
  try {
    run(repo, "git", "worktree", "remove", "--force", sandbox)
  } catch {}
  await fs.rm(sandbox, { recursive: true, force: true }).catch(() => undefined)
}

async function seed(page: Page) {
  await page.addInitScript(
    (input: { repo: string; sandbox: string; backend: string }) => {
      localStorage.clear()
      ;(window as typeof window & {
        __OPENCODE__?: {
          serverUrl?: string
          activeDirectory?: string
        }
      }).__OPENCODE__ = {
        serverUrl: input.backend,
      }
      localStorage.setItem(
        "opencode.global.dat:server",
        JSON.stringify({
          list: [],
          projects: {
            local: [{ worktree: input.repo, sandboxes: [input.sandbox], expanded: true }],
          },
          lastProject: {},
          workspaceServer: {},
          closedProjects: {},
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
    { repo, sandbox, backend: BACKEND_URL },
  )
}

async function wire(page: Page) {
  await page.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/.*$/, async (route, request) => {
    const current = new URL(request.url())
    if (Number(current.port || (current.protocol === "https:" ? "443" : "80")) === FRONTEND_PORT) {
      await route.continue()
      return
    }
    const headers = {
      ...request.headers(),
      "x-opencode-directory": active,
    }
    await route.continue({
      url: `${BACKEND_URL}${current.pathname}${current.search}`,
      headers,
    })
  })
}

async function waitForApp(page: Page) {
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(500)
}

async function toggle(page: Page) {
  await page.locator("body").click({ position: { x: 400, y: 300 } })
  await page.waitForTimeout(100)
  await page.keyboard.down(mod)
  await page.keyboard.down("Shift")
  await page.keyboard.press(";")
  await page.keyboard.up("Shift")
  await page.keyboard.up(mod)
  await page.waitForTimeout(250)
}

async function pane(page: Page): Promise<Locator> {
  const item = page.locator(PANEL)
  if (await item.isVisible().catch(() => false)) return item
  const workspacePanel = page.getByRole("complementary", { name: "Workspace panel" })
  if (!await workspacePanel.isVisible().catch(() => false)) {
    const openWorkspacePanel = page.getByRole("button", { name: "Open workspace panel", exact: true }).first()
    const sidepanel = page.getByRole("button", { name: /Sidepanel/i }).first()
    if (await openWorkspacePanel.isVisible().catch(() => false)) await openWorkspacePanel.click()
    else if (await sidepanel.isVisible().catch(() => false)) await sidepanel.click()
    else await toggle(page)
  }
  await expect(page.getByRole("button", { name: "Open Processes", exact: true }).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Processes", exact: true }).first().click()
  await expect(page.getByRole("button", { name: PROC_NAME }).first()).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: PROC_NAME }).first().click()
  await expect(item).toBeVisible({ timeout: 10_000 })
  return item
}

async function launch(page: Page, dir: string) {
  const waitForStart = () => page.waitForResponse((res) => {
    return res.request().method() === "POST"
      && res.url().includes(`/process/${PROC_ID}/start`)
  }, { timeout: 15_000 })
  const view = await pane(page)
  await expect(view.locator('[data-process-action="start"]')).toBeVisible()
  const hit = waitForStart()
  await view.locator('[data-process-action="start"]').click()
  const initial = await hit
  if (initial.status() === 409) {
    await expect(view.locator('[data-process-action="start-fallback"]').first()).toBeVisible({ timeout: 10_000 })
    const res = await startWithPickNew(dir)
    return {
      ...res,
      list: await list(dir).catch((err) => ({ error: String(err) })),
      ui: await page.evaluate(() => ({
        serverUrl: window.__OPENCODE__?.serverUrl,
        activeDirectory: window.__OPENCODE__?.activeDirectory,
        persistedServer: localStorage.getItem("opencode.global.dat:server"),
      })),
    }
  }
  const res = initial
  return {
    url: res.url(),
    code: res.status(),
    text: await res.text(),
    list: await list(dir).catch((err) => ({ error: String(err) })),
    ui: await page.evaluate(() => ({
      serverUrl: window.__OPENCODE__?.serverUrl,
      activeDirectory: window.__OPENCODE__?.activeDirectory,
      persistedServer: localStorage.getItem("opencode.global.dat:server"),
    })),
  }
}

async function halt(page: Page, dir: string) {
  const hit = page.waitForResponse((res) => {
    return res.request().method() === "POST"
      && res.url().includes(`/process/${PROC_ID}/stop`)
  }, { timeout: 5_000 }).catch(() => undefined)
  const view = await pane(page)
  await expect(view.locator('[data-process-action="stop"]')).toBeVisible()
  await view.locator('[data-process-action="stop"]').click({ force: true })
  const res = await hit
  if (!res) return { ...await stopDirect(dir), list: await list(dir).catch((err) => ({ error: String(err) })) }
  return {
    url: res.url(),
    code: res.status(),
    text: await res.text(),
    list: await list(dir).catch((err) => ({ error: String(err) })),
  }
}

async function open(page: Page, dir: string) {
  active = dir
  await page.goto(url(dir))
  await waitForApp(page)
  if (!await page.getByRole("textbox", { name: /Ask anything/i }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "New Session" }).first().click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
  }
  await page.evaluate((next) => {
    window.__OPENCODE__ ??= {}
    window.__OPENCODE__.activeDirectory = next
  }, dir)
}

test.describe.serial("Project-shared process config", () => {
  test.skip(
    process.env.CLAXEDO_PROCESS_PROJECT_SHARED_LIVE !== "1",
    "set CLAXEDO_PROCESS_PROJECT_SHARED_LIVE=1 to run the live backend process/worktree flow",
  )

  test.skip(process.platform === "win32", "Worktree + diagnostics coverage is POSIX-only in this spec")

  test.beforeAll(async () => {
    test.setTimeout(180_000)
    await setupRepo()
    await startBackend()
    await setupSandbox()
  })

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      if (!portHolder) return resolve()
      portHolder.close(() => resolve())
    }).catch(() => undefined)
    portHolder = undefined
    await cleanupSandbox()
    await stopBackend()
    if (repo) await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined)
  })

  test("loads one shared config across workspaces, assigns sibling ports, and leaves no leaks after stop", async ({ page }) => {
    test.setTimeout(180_000)
    await wire(page)
    await seed(page)

    await open(page, repo)
    let data = await list(repo)
    expect(data.configs.some((item) => item.id === PROC_ID)).toBe(true)
    const first = await launch(page, repo)
    expect(first.code, first.text).toBe(200)

    await expect
      .poll(async () => proc(await list(repo))?.assignedPort, {
        message: JSON.stringify(first, null, 2),
      })
      .toBe(port)

    await expect
      .poll(async () => proc(await list(repo))?.status)
      .toBe("running")
    portHolder = await occupyIfFree(port)

    await open(page, sandbox)
    data = await list(sandbox)
    expect(data.configs.some((item) => item.id === PROC_ID)).toBe(true)
    const second = await launch(page, sandbox)
    expect(second.code, second.text).toBe(200)

    await expect
      .poll(async () => proc(await list(sandbox))?.assignedPort, {
        message: JSON.stringify(second, null, 2),
      })
      .toBe(port + 1)

    await expect
      .poll(async () => proc(await list(sandbox))?.status)
      .toBe("running")

    await expect
      .poll(async () => (await list(repo)).configs.some((item) => item.id === PROC_ID))
      .toBe(true)

    await expect
      .poll(async () => (await list(sandbox)).configs.some((item) => item.id === PROC_ID))
      .toBe(true)

    const stopSandbox = await halt(page, sandbox)
    expect(stopSandbox.code, stopSandbox.text).toBe(200)
    await expect
      .poll(async () => proc(await list(sandbox))?.status)
      .toBe("stopped")

    await open(page, repo)
    const stopRepo = await halt(page, repo)
    expect(stopRepo.code, stopRepo.text).toBe(200)
    await expect
      .poll(async () => proc(await list(repo))?.status)
      .toBe("stopped")

    await expect
      .poll(async () => leaks(await diag(repo), repo))
      .toBe(0)

    await expect
      .poll(async () => leaks(await diag(sandbox), sandbox))
      .toBe(0)
  })
})
