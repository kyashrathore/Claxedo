import { expect, test, type Page } from "@playwright/test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3371)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const oldLocalRoutes = [
  "/path",
  "/provider",
  "/provider/auth",
  "/config",
  "/config/providers",
  "/global/config",
  "/project",
  "/project/current",
  "/mcp",
  "/agent",
  "/command",
  "/auth",
]

let repo = ""
let repoToAdd = ""
let data = ""
let active = ""
let backend: ChildProcess | undefined
let backendLog = ""
let forbidden: Server | undefined
let forbiddenHits: string[] = []

function run(cwd: string, ...cmd: string[]) {
  const out = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf-8" })
  if (out.status === 0) return out.stdout.trim()
  throw new Error([out.stdout, out.stderr].filter(Boolean).join("\n") || `${cmd.join(" ")} failed`)
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
    const res = await fetch(`${BACKEND_URL}/api/claxedo/health`, { signal: ctrl.signal }).catch(() => undefined)
    return !!res?.ok
  } finally {
    clearTimeout(timer)
  }
}

async function setupRepo() {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cutover-local-"))
  repo = await fs.realpath(repo).catch(() => repo)
  await fs.writeFile(path.join(repo, "README.md"), "# compat disabled local workflow\n")
  run(repo, "git", "init", "-b", "main")
  run(repo, "git", "config", "user.email", "e2e@example.com")
  run(repo, "git", "config", "user.name", "Playwright E2E")
  run(repo, "git", "add", "README.md")
  run(repo, "git", "commit", "-m", "init")

  repoToAdd = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cutover-add-"))
  repoToAdd = await fs.realpath(repoToAdd).catch(() => repoToAdd)
  await fs.writeFile(path.join(repoToAdd, "README.md"), "# add project workflow\n")
  await fs.writeFile(path.join(repoToAdd, "AGENTS.md"), "# repo agent instructions\n")
  await fs.mkdir(path.join(repoToAdd, ".agents", "skills", "e2e-skill"), { recursive: true })
  await fs.writeFile(path.join(repoToAdd, ".agents", "skills", "e2e-skill", "SKILL.md"), "# E2E skill\n")
  await fs.mkdir(path.join(repoToAdd, ".cursor"), { recursive: true })
  await fs.writeFile(path.join(repoToAdd, ".cursor", "rules.md"), "# Cursor rules\n")
  run(repoToAdd, "git", "init", "-b", "main")
  run(repoToAdd, "git", "config", "user.email", "e2e@example.com")
  run(repoToAdd, "git", "config", "user.name", "Playwright E2E")
  run(repoToAdd, "git", "add", "README.md")
  run(repoToAdd, "git", "commit", "-m", "init")
}

async function setupData() {
  data = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-cutover-data-"))
  const now = Date.now()
  await fs.writeFile(
    path.join(data, "user-agent-config.json"),
    JSON.stringify({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", model: "claude-sonnet-4-6" },
    }, null, 2) + "\n",
  )
  await fs.writeFile(
    path.join(data, "workspaces.json"),
    JSON.stringify({
      version: 3,
      workspaces: [{
        id: "ws_local_cutover",
        project_id: "ws_local_cutover",
        project_name: "compat-disabled-local",
        workspace_name: "main",
        directory: repo,
        kind: "local",
        created_at: now,
        updated_at: now,
      }],
    }, null, 2) + "\n",
  )
}

async function startForbidden() {
  forbiddenHits = []
  forbidden = createServer((req, res) => {
    forbiddenHits.push(`${req.method ?? "GET"} ${req.url ?? "/"}`)
    res.statusCode = 500
    res.end("forbidden")
  })
  await new Promise<void>((resolve) => forbidden!.listen(0, "127.0.0.1", resolve))
  return `http://127.0.0.1:${(forbidden.address() as AddressInfo).port}`
}

async function startBackend() {
  if (await live()) throw new Error(`Port ${BACKEND_PORT} is already in use`)
  const opencodeUrl = await startForbidden()
  backend = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      CLAXEDO_DEBUG: "1",
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      CLAXEDO_DATA_DIR: data,
      CLAXEDO_STATE_DIR: path.join(data, "state"),
      CLAXEDO_DISABLE_OPENCODE_COMPAT: "1",
      CLAXEDO_SIGNED_CLOUD_AUTH: "0",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-ant-e2e-provider-key",
      OPENCODE_URL: opencodeUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  backend.stdout?.on("data", (chunk: Buffer | string) => {
    backendLog += chunk.toString()
  })
  backend.stderr?.on("data", (chunk: Buffer | string) => {
    backendLog += chunk.toString()
  })
  await until(async () => {
    const res = await fetch(`${BACKEND_URL}/api/claxedo/health`).catch(() => undefined)
    if (!res?.ok) return
    const body = await res.json().catch(() => undefined) as { ok?: boolean } | undefined
    if (body?.ok) return true
  }, 120_000).catch((err) => {
    throw new Error(`${String(err)}\n${backendLog}`)
  })
}

async function stopBackend() {
  if (backend && backend.exitCode === null) {
    backend.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      backend?.once("exit", () => resolve())
      setTimeout(resolve, 10_000)
    })
    if (backend.exitCode === null) backend.kill("SIGKILL")
  }
  backend = undefined
  if (forbidden) await new Promise<void>((resolve) => forbidden!.close(() => resolve()))
  forbidden = undefined
}

async function seed(page: Page) {
  await page.addInitScript(({ directory, backendUrl }) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: backendUrl,
      activeDirectory: directory,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [{ worktree: directory, expanded: true }],
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
  }, { directory: repo, backendUrl: BACKEND_URL })
}

async function wire(page: Page) {
  await page.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/.*$/, async (route, request) => {
    const current = new URL(request.url())
    if (Number(current.port || (current.protocol === "https:" ? "443" : "80")) === FRONTEND_PORT) {
      await route.continue()
      return
    }
    await route.continue({
      url: `${BACKEND_URL}${current.pathname}${current.search}`,
      headers: {
        ...request.headers(),
        "x-opencode-directory": active,
      },
    })
  })
}

function isOldLocalRoute(url: string) {
  const current = new URL(url)
  const pathname = current.pathname
  if (pathname === "/provider" && current.searchParams.has("harness")) return false
  return oldLocalRoutes.some((route) => pathname === route || pathname.startsWith(route + "/"))
}

async function openWorkspacePanel(page: Page) {
  if (await page.getByRole("button", { name: "Open Files", exact: true }).isVisible().catch(() => false)) return
  const panel = page.getByRole("button", { name: "Open workspace panel", exact: true }).first()
  if (await panel.isVisible().catch(() => false)) {
    await panel.click()
    return
  }
  await page.getByRole("button", { name: /Sidepanel/i }).first().click()
}

test.describe.serial("compat-disabled local workflow", () => {
  test.beforeAll(async () => {
    test.setTimeout(150_000)
    await setupRepo()
    await setupData()
    await startBackend()
  })

  test.afterAll(async () => {
    await stopBackend()
    if (repo) await fs.rm(repo, { recursive: true, force: true }).catch(() => undefined)
    if (repoToAdd) await fs.rm(repoToAdd, { recursive: true, force: true }).catch(() => undefined)
    if (data) await fs.rm(data, { recursive: true, force: true }).catch(() => undefined)
  })

  test.skip("boots visible local workspace without old OpenCode config/provider fallback", async ({ page }) => {
    active = repo
    await seed(page)
    await wire(page)

    const oldRequests: string[] = []
    const consoleErrors: string[] = []
    const localConfigRequests: Array<{ method: string; path: string; authorization?: string }> = []
    page.on("request", (request) => {
      if (!["fetch", "xhr", "eventsource"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (isOldLocalRoute(request.url())) oldRequests.push(`${request.method()} ${url.pathname}`)
      if (url.pathname === "/api/claxedo/agent-config/harness" || url.pathname === "/api/claxedo/agent-config/commands") {
        localConfigRequests.push({
          method: request.method(),
          path: url.pathname,
          authorization: request.headers().authorization,
        })
      }
    })
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text())
    })

    await page.goto(`/${slug(repo)}/session`)
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect(page.getByRole("button", { name: "New Session", exact: true })).toBeVisible()
    await expect(page.getByRole("button", { name: "New Claude Terminal", exact: true })).toBeVisible()

    await page.evaluate(() => {
      ;(window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: unknown
      }).__CLAXEDO_TEST_AUTH_TOKEN__ = "signed-local-token"
      ;(window as typeof window & {
        __CLAXEDO_TEST_AUTH_TOKEN__?: string
        __CLAXEDO_TEST_AUTH_USER__?: unknown
      }).__CLAXEDO_TEST_AUTH_USER__ = { id: "user_e2e" }
    })
    await page.getByRole("button", { name: "New Session", exact: true }).click()
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('[data-action="prompt-submit"]').last()).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => localConfigRequests).toContainEqual({
      method: "GET",
      path: "/api/claxedo/agent-config/harness",
      authorization: undefined,
    })
    await expect.poll(() => localConfigRequests).toContainEqual({
      method: "GET",
      path: "/api/claxedo/agent-config/commands",
      authorization: undefined,
    })
    await openWorkspacePanel(page)
    await expect(page.getByRole("button", { name: "Open Files", exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Open Files", exact: true }).click()
    await expect.poll(async () => await page.evaluate(async (input) => {
      const res = await fetch(`${input.backendUrl}/file?directory=${encodeURIComponent(input.directory)}`, {
        headers: { "x-opencode-directory": input.directory },
      })
      if (!res.ok) return []
      return (await res.json() as Array<{ name?: string }>).map((item) => item.name)
    }, { backendUrl: BACKEND_URL, directory: repo })).toContain("README.md")

    const pickerRequests: string[] = []
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname === "/api/claxedo/bootstrap" || url.pathname === "/file" || url.pathname === "/find/file") {
        pickerRequests.push(`${request.method()} ${url.pathname}`)
      }
    })
    await page.getByRole("button", { name: "New Project", exact: true }).click()
    await page.getByPlaceholder("Search folders").fill(repo)
    await expect(page.getByRole("dialog").getByText(path.basename(repo), { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => pickerRequests).toContainEqual("GET /api/claxedo/bootstrap")
    await expect.poll(() => pickerRequests).toContainEqual("GET /file")

    await page.keyboard.press("Escape")
    await expect(page.getByPlaceholder("Search folders")).toBeHidden()

    const signedPickerRequests: Array<{ path: string; authorization?: string }> = []
    await page.evaluate(() => {
      ;(window as typeof window & { __CLAXEDO_TEST_AUTH_TOKEN__?: string }).__CLAXEDO_TEST_AUTH_TOKEN__ = "signed-picker-token"
    })
    await page.route("**/api/claxedo/bootstrap", async (route, request) => {
      signedPickerRequests.push({
        path: new URL(request.url()).pathname,
        authorization: request.headers().authorization,
      })
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          healthy: true,
          version: "e2e",
          path: {
            home: path.dirname(repo),
            directory: repo,
          },
          project: [],
          provider: { providers: [], default: "" },
          provider_auth: {},
          config: {},
          config_providers: { providers: [], default: "" },
        }),
      })
    })
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname !== "/file" && url.pathname !== "/find/file") return
      signedPickerRequests.push({
        path: url.pathname,
        authorization: request.headers().authorization,
      })
    })

    await page.getByRole("button", { name: "New Project", exact: true }).click()
    await page.getByPlaceholder("Search folders").fill(path.basename(repo))
    await expect.poll(() => signedPickerRequests.map((item) => item.path)).toContain("/api/claxedo/bootstrap")
    await expect.poll(() => signedPickerRequests.map((item) => item.path)).toContain("/find/file")
    expect(signedPickerRequests.filter((item) => item.path === "/api/claxedo/bootstrap" || item.path === "/find/file")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "/api/claxedo/bootstrap", authorization: undefined }),
        expect.objectContaining({ path: "/find/file", authorization: undefined }),
      ]),
    )
    await page.keyboard.press("Escape")
    await expect(page.getByPlaceholder("Search folders")).toBeHidden()
    await page.unroute("**/api/claxedo/bootstrap")
    await page.evaluate(() => {
      delete (window as typeof window & { __CLAXEDO_TEST_AUTH_TOKEN__?: string }).__CLAXEDO_TEST_AUTH_TOKEN__
    })

    const addProjectRequests: Array<{ path: string; search: string; authorization?: string }> = []
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname !== "/api/workspace/resolve") return
      addProjectRequests.push({
        path: url.pathname,
        search: url.search,
        authorization: request.headers().authorization,
      })
    })

    await page.getByRole("button", { name: "New Project", exact: true }).click()
    await page.getByPlaceholder("Search folders").fill(repoToAdd)
    await page.getByRole("dialog").getByText(path.basename(repoToAdd), { exact: true }).click()
    await expect.poll(() => decodeURIComponent(new URL(page.url()).pathname), { timeout: 20_000 }).toContain(repoToAdd)
    expect(decodeURIComponent(new URL(page.url()).pathname)).toMatch(/\/session$/)
    expect(addProjectRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/api/workspace/resolve",
          authorization: undefined,
        }),
      ]),
    )

    const credentialRequests: Array<{ method: string; path: string; authorization?: string }> = []
    const commandMutationRequests: Array<{ method: string; path: string; authorization?: string }> = []
    const agentProfileRequests: Array<{ method: string; path: string; authorization?: string }> = []
    const extensionScanRequests: Array<{ method: string; path: string; authorization?: string }> = []
    const sessionWriteRequests: Array<{ method: string; path: string; authorization?: string }> = []
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname !== "/api/claxedo/credentials" && !url.pathname.startsWith("/api/claxedo/credentials/")) return
      credentialRequests.push({
        method: request.method(),
        path: url.pathname,
        authorization: request.headers().authorization,
      })
    })
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname !== "/api/claxedo/agent-config/commands" && !url.pathname.startsWith("/api/claxedo/agent-config/commands/")) return
      commandMutationRequests.push({
        method: request.method(),
        path: url.pathname,
        authorization: request.headers().authorization,
      })
    })
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname !== "/api/claxedo/agent-config/agents") return
      agentProfileRequests.push({
        method: request.method(),
        path: url.pathname,
        authorization: request.headers().authorization,
      })
    })
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (url.pathname !== "/api/claxedo/agent-config/extensions/scan") return
      extensionScanRequests.push({
        method: request.method(),
        path: url.pathname,
        authorization: request.headers().authorization,
      })
    })
    page.on("request", (request) => {
      if (!["fetch", "xhr"].includes(request.resourceType())) return
      const url = new URL(request.url())
      if (!/^\/session\/[^/]+\/(?:config|prompt_async)$/.test(url.pathname)) return
      sessionWriteRequests.push({
        method: request.method(),
        path: url.pathname.replace(/^\/session\/[^/]+/, "/session/:id"),
        authorization: request.headers().authorization,
      })
    })

    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("tab", { name: "Providers", exact: true }).click()
    await page.getByRole("button", { name: "Show more providers", exact: true }).click()
    await page.getByPlaceholder("Search providers").fill("claude")
    await page.getByRole("dialog").getByText("claude-acp", { exact: true }).click()
    await page.getByLabel("claude-acp API key").fill("sk-ant-e2e-provider-key")
    await page.getByRole("button", { name: "Continue", exact: true }).click()
    await expect.poll(() => credentialRequests).toContainEqual({
      method: "PUT",
      path: "/api/claxedo/credentials",
      authorization: undefined,
    })
    await page.keyboard.press("Escape")
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 10_000 })
    await page.evaluate(() => {
      ;(window as typeof window & { __CLAXEDO_TEST_AUTH_TOKEN__?: string }).__CLAXEDO_TEST_AUTH_TOKEN__ = "signed-submit-token"
    })
    await page.getByRole("textbox", { name: /Ask anything/i }).fill("Say hello from the compat disabled E2E path")
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled()
    await page.getByRole("button", { name: "Send", exact: true }).click()
    await expect.poll(() => sessionWriteRequests).toContainEqual({
      method: "PATCH",
      path: "/session/:id/config",
      authorization: undefined,
    })
    await expect.poll(() => sessionWriteRequests).toContainEqual({
      method: "POST",
      path: "/session/:id/prompt_async",
      authorization: undefined,
    })
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await page.getByRole("tab", { name: "Providers", exact: true }).click()
    await expect(page.getByText("claude-acp", { exact: true })).toBeVisible()
    await page.getByRole("button", { name: "Disconnect", exact: true }).click()
    await expect.poll(() => credentialRequests).toContainEqual({
      method: "DELETE",
      path: "/api/claxedo/credentials/provider/claude-acp",
      authorization: undefined,
    })
    await expect.poll(async () => await page.evaluate(async (input) => {
      const base = `${input.backendUrl}/api/claxedo/agent-config/commands`
      const created = await fetch(base, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-opencode-directory": input.directory,
        },
        body: JSON.stringify({ name: "e2e-review", content: "Review the active changes." }),
      })
      if (!created.ok) return { ok: false, step: "create", status: created.status }
      const listed = await fetch(base, {
        headers: { "x-opencode-directory": input.directory },
      })
      if (!listed.ok) return { ok: false, step: "list", status: listed.status }
      const names = (await listed.json() as Array<{ name?: string }>).map((item) => item.name)
      const deleted = await fetch(`${base}/e2e-review`, {
        method: "DELETE",
        headers: { "x-opencode-directory": input.directory },
      })
      return {
        ok: deleted.ok && names.includes("e2e-review"),
        step: deleted.ok ? "done" : "delete",
        status: deleted.status,
      }
    }, { backendUrl: BACKEND_URL, directory: repoToAdd })).toMatchObject({ ok: true, step: "done" })
    expect(commandMutationRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "POST", path: "/api/claxedo/agent-config/commands", authorization: undefined }),
        expect.objectContaining({ method: "GET", path: "/api/claxedo/agent-config/commands", authorization: undefined }),
        expect.objectContaining({ method: "DELETE", path: "/api/claxedo/agent-config/commands/e2e-review", authorization: undefined }),
      ]),
    )
    await expect.poll(async () => await page.evaluate(async (input) => {
      const url = new URL(`${input.backendUrl}/api/claxedo/agent-config/agents`)
      url.searchParams.set("directory", input.directory)
      url.searchParams.set("type", "claude-acp")
      const res = await fetch(url, {
        headers: { "x-opencode-directory": input.directory },
      })
      if (!res.ok) return []
      return (await res.json() as Array<{ name?: string }>).map((item) => item.name)
    }, { backendUrl: BACKEND_URL, directory: repoToAdd })).toContain("default")
    await expect.poll(() => agentProfileRequests).toContainEqual({
      method: "GET",
      path: "/api/claxedo/agent-config/agents",
      authorization: undefined,
    })
    await expect.poll(async () => await page.evaluate(async (input) => {
      const url = new URL(`${input.backendUrl}/api/claxedo/agent-config/extensions/scan`)
      url.searchParams.set("directory", input.directory)
      const res = await fetch(url, {
        headers: { "x-opencode-directory": input.directory },
      })
      if (!res.ok) return []
      return (await res.json() as Array<{ path?: string; kind?: string }>).map((item) => `${item.kind}:${item.path}`)
    }, { backendUrl: BACKEND_URL, directory: repoToAdd })).toEqual(expect.arrayContaining([
      "runner-config-dir:.cursor",
      "skills-dir:.agents/skills",
      "instruction-file:AGENTS.md",
    ]))
    await expect.poll(() => extensionScanRequests).toContainEqual({
      method: "GET",
      path: "/api/claxedo/agent-config/extensions/scan",
      authorization: undefined,
    })

    expect(oldRequests).toEqual([])
    expect(forbiddenHits).toEqual([])
    expect(consoleErrors.filter((line) => !/Failed to load resource/.test(line))).toEqual([])
  })
})
