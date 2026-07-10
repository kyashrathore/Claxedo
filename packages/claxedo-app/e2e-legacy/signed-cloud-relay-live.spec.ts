import { expect, test, type Page, type Route } from "@playwright/test"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3318)
const CHILD_PATH = process.env.PATH ?? ""

type Fixture = {
  backendUrl: string
  relayUrl: string
  workspaceId: string
  hostId: string
  runtimeAccessToken: string
  role: "viewer" | "editor" | "owner"
  workspaceDir: string
  directory: string
}

type RequestHit = {
  method: string
  url: string
  authorization?: string
}

let fixture: Fixture
let child: ChildProcess | undefined
let fixtureLog = ""

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr" || type === "eventsource" || route.request().method() === "OPTIONS"
}

function forbiddenDirectPath(pathname: string) {
  if (legacyMetadataPath(pathname)) return false
  return pathname === "/global/dispose" ||
    pathname === "/global/event" ||
    pathname === "/event" ||
    pathname === "/permission" ||
    pathname.startsWith("/permission/") ||
    pathname === "/question" ||
    pathname.startsWith("/question/") ||
    pathname === "/session" ||
    pathname === "/experimental/worktree" ||
    pathname.startsWith("/experimental/worktree/") ||
    pathname.startsWith("/session/") ||
    pathname === "/config" ||
    pathname.startsWith("/config/") ||
    pathname === "/mcp" ||
    pathname.startsWith("/mcp/") ||
    pathname === "/agent" ||
    pathname === "/command" ||
    pathname === "/file" ||
    pathname.startsWith("/file/") ||
    pathname === "/find" ||
    pathname.startsWith("/find/") ||
    pathname === "/lsp" ||
    pathname === "/vcs" ||
    /^\/api\/claxedo\/(pty|process|diff|hook)(?:\/|$)/.test(pathname)
}

function legacyMetadataPath(pathname: string) {
  return pathname === "/path" ||
    pathname === "/project" ||
    pathname.startsWith("/project/") ||
    pathname === "/experimental/project" ||
    pathname.startsWith("/experimental/project/") ||
    pathname === "/global/config" ||
    pathname === "/provider" ||
    pathname.startsWith("/provider/")
}

function backendApiPath(pathname: string) {
  return pathname.startsWith("/api/") ||
    pathname.startsWith("/global/") ||
    legacyMetadataPath(pathname) ||
    forbiddenDirectPath(pathname)
}

async function startFixture(role: Fixture["role"] = "editor") {
  child = spawn("node", ["--import", "./src/text-imports.mjs", "--import", "tsx", "src/signed-browser-relay-fixture.mjs"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_E2E_BACKEND_PORT: String(BACKEND_PORT),
      CLAXEDO_E2E_WORKSPACE_ID: "ws_signed_cloud_relay",
      CLAXEDO_E2E_HOST_ID: "host_signed_cloud_relay",
      CLAXEDO_E2E_RELAY_FIXTURE_ACCESS: "cloud",
      CLAXEDO_E2E_RELAY_FIXTURE_ROLE: role,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  fixture = await new Promise<Fixture>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      stopFixture().finally(() => reject(err))
    }
    const timeout = setTimeout(() => {
      fail(new Error(`Signed cloud relay fixture did not start\n${fixtureLog}`))
    }, 120_000)

    child?.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      fixtureLog += text
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as Fixture
          if (!parsed.backendUrl || !parsed.relayUrl || !parsed.workspaceId || !parsed.runtimeAccessToken || !parsed.role || !parsed.directory) continue
          settled = true
          clearTimeout(timeout)
          resolve(parsed)
        } catch {
          continue
        }
      }
    })
    child?.stderr?.on("data", (chunk) => {
      fixtureLog += chunk.toString()
    })
    child?.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Signed cloud relay fixture exited before start (${code ?? signal})\n${fixtureLog}`))
    })
    child?.once("error", fail)
  })
}

async function stopFixture() {
  if (!child) return
  if (child.exitCode === null) {
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      child?.once("exit", () => resolve())
      setTimeout(resolve, 10_000)
    })
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  child = undefined
}

async function seed(page: Page) {
  await page.addInitScript((input: Fixture) => {
    localStorage.clear()
    ;(window as typeof window & {
      __OPENCODE__?: {
        serverUrl?: string
        activeDirectory?: string
      }
    }).__OPENCODE__ = {
      serverUrl: input.backendUrl,
      activeDirectory: input.directory,
    }
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [{ worktree: input.directory, expanded: true }],
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
          id: "proj_signed_browser_relay",
          name: "Signed Cloud Relay",
          worktree: input.directory,
          sandboxes: [input.directory],
          workspaces: {
            [input.directory]: {
              id: input.workspaceId,
              kind: "cloud",
              workspace_name: "Signed Cloud Relay",
              directory: input.directory,
            },
          },
        }],
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
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_TOKEN__ = "signed-browser-token"
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_USER__ = { id: "user_browser" }
  }, fixture)
}

async function wire(page: Page, hits: {
  directForbidden: RequestHit[]
  relayRuntime: RequestHit[]
  workspaceLists: RequestHit[]
  sessionLists: RequestHit[]
  connections: RequestHit[]
  failed: string[]
}) {
  page.on("requestfailed", (request) => {
    const failure = `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim()
    if (!failure.endsWith(" net::ERR_ABORTED")) hits.failed.push(failure)
  })

  await page.route("**/*", async (route) => {
    if (!api(route)) return route.continue()

    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "OPTIONS") {
      await route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "authorization,content-type,accept,x-opencode-directory,x-workspace-id",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
        },
      })
      return
    }

    const hit = {
      method: request.method(),
      url: request.url(),
      authorization: request.headers().authorization,
    }
    const frontend = Number(url.port || (url.protocol === "https:" ? "443" : "80")) === FRONTEND_PORT
    const backend = request.url().startsWith(fixture.backendUrl)
    const relay = request.url().startsWith(fixture.relayUrl)
    const localWorkspaceRelay = ["localhost", "127.0.0.1"].includes(url.hostname) &&
      !frontend &&
      !backend &&
      !relay &&
      url.pathname.startsWith(`/workspaces/${fixture.workspaceId}/`)
    const localApiBackend = ["localhost", "127.0.0.1"].includes(url.hostname) &&
      !frontend &&
      !relay &&
      backendApiPath(url.pathname)
    const central = backend || localApiBackend

    if ((frontend || central) && forbiddenDirectPath(url.pathname)) {
      hits.directForbidden.push(hit)
      await route.fulfill({
        status: 599,
        contentType: "application/json",
        body: JSON.stringify({ error: "old direct runtime path used", path: url.pathname }),
      })
      return
    }

    if ((relay || frontend || localWorkspaceRelay) && url.pathname.startsWith(`/workspaces/${fixture.workspaceId}/`)) {
      hits.relayRuntime.push(hit)
      if (frontend || localWorkspaceRelay) {
        const headers = request.headers()
        if (!headers.authorization || headers.authorization === "Bearer signed-browser-token") {
          headers.authorization = `Bearer ${fixture.runtimeAccessToken}`
        }
        await route.continue({
          url: `${fixture.relayUrl}${url.pathname}${url.search}`,
          headers,
        })
        return
      }
      await route.continue()
      return
    }

    if ((frontend || central) && url.pathname === "/api/workspace") hits.workspaceLists.push(hit)
    if ((frontend || central) && url.pathname === "/api/control/sessions") hits.sessionLists.push(hit)
    if ((frontend || central) && url.pathname === `/api/workspace/${fixture.workspaceId}/connection`) hits.connections.push(hit)

    if ((frontend || localApiBackend) && backendApiPath(url.pathname)) {
      await route.continue({
        url: `${fixture.backendUrl}${url.pathname}${url.search}`,
        headers: {
          ...request.headers(),
          "x-opencode-directory": fixture.directory,
        },
      })
      return
    }

    if (backend) {
      await route.continue({
        headers: {
          ...request.headers(),
          "x-opencode-directory": fixture.directory,
        },
      })
      return
    }

    await route.continue()
  })
}

async function openApp(page: Page) {
  await page.goto(`/${slug(fixture.directory)}/session/signed-browser-relay-session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 30_000 })
}

async function openWorkspaceApp(page: Page) {
  await page.goto(`/w/${encodeURIComponent(fixture.workspaceId)}/session`)
  await page.waitForLoadState("domcontentloaded")
  await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole("textbox", { name: /Ask anything|Read-only workspace/i })).toBeVisible({ timeout: 30_000 })
}

async function openFilesPanel(page: Page) {
  if (!await page.locator('[data-testid="review-pane-root"]').isVisible().catch(() => false)) {
    if (await page.getByRole("button", { name: "Open workspace panel", exact: true }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Open workspace panel", exact: true }).click()
    }
  }
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Files", exact: true }).click()
}

async function openProcessesPanel(page: Page) {
  if (!await page.getByRole("button", { name: "Open Processes", exact: true }).isVisible().catch(() => false)) {
    if (await page.getByRole("button", { name: "Open workspace panel", exact: true }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Open workspace panel", exact: true }).click()
    }
  }
  await expect(page.getByRole("button", { name: "Open Processes", exact: true })).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Processes", exact: true }).click()
  await expect(page.getByText("Processes").first()).toBeVisible({ timeout: 10_000 })
}

async function signedJson(page: Page, path: string, init: RequestInit = {}) {
  return await page.evaluate(async (input) => {
    const res = await fetch(input.path, {
      ...input.init,
      headers: {
        authorization: "Bearer signed-browser-token",
        "content-type": "application/json",
        ...input.init.headers,
      },
    })
    return {
      ok: res.ok,
      status: res.status,
      body: await res.json().catch(() => undefined),
      text: await res.text().catch(() => ""),
    }
  }, { path, init })
}

async function relayJson(page: Page, token: string, path: string, init: RequestInit = {}) {
  return await page.evaluate(async (input) => {
    const res = await fetch(input.path, {
      ...input.init,
      headers: {
        authorization: `Bearer ${input.token}`,
        accept: "application/json",
        "x-opencode-directory": input.directory,
        "x-workspace-id": input.workspaceId,
        ...input.init.headers,
      },
    })
    const text = await res.text().catch(() => "")
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {}
    return { ok: res.ok, status: res.status, body, text }
  }, {
    path,
    init,
    token,
    directory: fixture.workspaceDir,
    workspaceId: fixture.workspaceId,
  })
}

test.describe.serial("signed cloud browser relay live", () => {
  test.beforeAll(async () => {
    test.setTimeout(150_000)
    await startFixture()
  })

  test.afterAll(async () => {
    await stopFixture()
  })

  test.skip("opens cloud workspace session, file, diff, and process surfaces through Workspace Relay", async ({ page }) => {
    test.setTimeout(120_000)
    const hits = {
      directForbidden: [] as RequestHit[],
      relayRuntime: [] as RequestHit[],
      workspaceLists: [] as RequestHit[],
      sessionLists: [] as RequestHit[],
      connections: [] as RequestHit[],
      failed: [] as string[],
    }
    await seed(page)
    await wire(page, hits)
    await openApp(page)
    await expect(page.getByText("Signed cloud relay replay message")).toBeVisible({ timeout: 30_000 })

    const connection = await signedJson(page, `/api/workspace/${fixture.workspaceId}/connection`)
    expect(connection.status, JSON.stringify(connection)).toBe(200)
    expect(connection.body).toMatchObject({
      access: "cloud",
      backing: "cloud-vm",
      workspaceId: fixture.workspaceId,
      relayUrl: fixture.relayUrl,
      runtimeAccessToken: expect.any(String),
    })
    const runtimeAccessToken = String((connection.body as { runtimeAccessToken?: unknown }).runtimeAccessToken)

    await openFilesPanel(page)
    await page.getByTestId("workspace-files-navigator").getByRole("button", { name: /hello\.txt/ }).click()
    await expect(page.getByText("hello through signed browser relay").first()).toBeVisible({ timeout: 10_000 })

    const diff = await relayJson(
      page,
      runtimeAccessToken,
      `/workspaces/${fixture.workspaceId}/api/claxedo/diff/vcs?directory=${encodeURIComponent(fixture.workspaceDir)}`,
    )
    expect(diff.status, JSON.stringify(diff)).toBe(200)
    expect(diff.body).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: "hello.txt" }),
    ]))

    const processes = await relayJson(page, runtimeAccessToken, `/workspaces/${fixture.workspaceId}/api/claxedo/process`)
    expect(processes.status, JSON.stringify(processes)).toBe(200)
    expect(processes.body).toMatchObject({
      configs: expect.any(Array),
      processes: expect.any(Array),
    })

    expect(hits.directForbidden).toEqual([])
    expect(hits.failed).toEqual([])
    expect(hits.workspaceLists.map((item) => item.url)).toContainEqual(expect.stringContaining("access=cloud"))
    expect(hits.sessionLists.map((item) => item.url)).toContainEqual(expect.stringContaining(`workspaceId=${fixture.workspaceId}`))
    expect(hits.connections.map((item) => item.url)).toContainEqual(expect.stringContaining(`/api/workspace/${fixture.workspaceId}/connection`))
    expect(hits.relayRuntime.map((item) => new URL(item.url).pathname)).toEqual(expect.arrayContaining([
      `/workspaces/${fixture.workspaceId}/file`,
      `/workspaces/${fixture.workspaceId}/api/claxedo/diff/vcs`,
      `/workspaces/${fixture.workspaceId}/api/claxedo/process`,
    ]))
  })
})

test.describe.serial("signed cloud browser relay live viewer", () => {
  test.beforeAll(async () => {
    test.setTimeout(150_000)
    await startFixture("viewer")
  })

  test.afterAll(async () => {
    await stopFixture()
  })

  test("viewer token renders workspace UI read-only", async ({ page }, testInfo) => {
    test.setTimeout(120_000)
    const hits = {
      directForbidden: [] as RequestHit[],
      relayRuntime: [] as RequestHit[],
      workspaceLists: [] as RequestHit[],
      sessionLists: [] as RequestHit[],
      connections: [] as RequestHit[],
      failed: [] as string[],
    }
    await seed(page)
    await wire(page, hits)
    await openWorkspaceApp(page)

    const connection = await signedJson(page, `/api/workspace/${fixture.workspaceId}/connection`)
    expect(connection.status, JSON.stringify(connection)).toBe(200)
    expect(connection.body).toMatchObject({
      access: "cloud",
      role: "viewer",
      workspaceId: fixture.workspaceId,
      relayUrl: fixture.relayUrl,
      runtimeAccessToken: expect.any(String),
    })
    await expect.poll(async () => await page.evaluate((workspaceId) => {
      const api = (window as typeof window & {
        __claxedoConnections?: {
          snapshot?: () => Record<string, { rolePlacement?: unknown }>
        }
      }).__claxedoConnections
      return api?.snapshot?.()[workspaceId]?.rolePlacement ?? null
    }, fixture.workspaceId), { timeout: 30_000 }).toMatchObject({
      state: "role-known",
      workspaceId: fixture.workspaceId,
      role: "viewer",
    })
    await expect(page.getByRole("button", { name: "Read-only workspace" })).toBeDisabled()

    await openProcessesPanel(page)
    await expect(page.getByRole("button", { name: "Add process" })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /^(Start|Stop|Restart) process$/ })).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath("viewer-read-only.png"), fullPage: true })

    expect(hits.directForbidden).toEqual([])
    expect(hits.failed).toEqual([])
    expect(hits.relayRuntime.filter((item) =>
      item.method === "POST" &&
      new URL(item.url).pathname === `/workspaces/${fixture.workspaceId}/api/claxedo/process`
    )).toEqual([])
  })
})
