import { expect, test, type Page, type Route } from "@playwright/test"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3312)
const CHILD_PATH = process.env.PATH ?? ""

type Fixture = {
  backendUrl: string
  relayUrl: string
  workspaceId: string
  hostId: string
  runtimeAccessToken: string
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

function runtimeAccessTokenJti(token: string) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>
    return typeof payload.jti === "string" ? payload.jti : undefined
  } catch {
    return undefined
  }
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

async function startFixture() {
  child = spawn("node", ["--import", "./src/text-imports.mjs", "--import", "tsx", "src/signed-browser-relay-fixture.mjs"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_E2E_BACKEND_PORT: String(BACKEND_PORT),
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
      fail(new Error(`Signed browser relay fixture did not start\n${fixtureLog}`))
    }, 120_000)

    child?.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      fixtureLog += text
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as Fixture
          if (!parsed.backendUrl || !parsed.relayUrl || !parsed.workspaceId || !parsed.hostId || !parsed.runtimeAccessToken || !parsed.directory) continue
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
      reject(new Error(`Signed browser relay fixture exited before start (${code ?? signal})\n${fixtureLog}`))
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
          name: "Signed Browser Relay",
          worktree: input.directory,
          sandboxes: [input.directory],
          workspaces: {
            [input.directory]: {
              id: input.workspaceId,
              kind: "user-hosted",
              workspace_name: "Signed Browser Relay",
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
  bootstraps: RequestHit[]
  workspaceLists: RequestHit[]
  sessionLists: RequestHit[]
  connections: RequestHit[]
  connectionRefreshes: RequestHit[]
  pauses: RequestHit[]
  failed: string[]
}) {
  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? ""
    const url = new URL(request.url())
    if (error === "net::ERR_ABORTED" && url.pathname.endsWith("/api/claxedo/runtime-events")) return
    hits.failed.push(`${request.method()} ${request.url()} ${error}`.trim())
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
          "Access-Control-Allow-Headers": "authorization,content-type,accept",
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
        body: JSON.stringify({
          error: "old direct runtime path used",
          method: request.method(),
          path: url.pathname,
          directory: request.headers()["x-opencode-directory"],
        }),
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

    if ((frontend || central) && url.pathname === "/api/claxedo/bootstrap") hits.bootstraps.push(hit)
    if ((frontend || central) && url.pathname === "/api/workspace") hits.workspaceLists.push(hit)
    if ((frontend || central) && url.pathname === "/api/control/sessions") hits.sessionLists.push(hit)
    if ((frontend || central) && url.pathname === `/api/workspace/${fixture.workspaceId}/connection`) hits.connections.push(hit)
    if ((frontend || central) && url.pathname === `/api/workspace/${fixture.workspaceId}/connection/refresh`) hits.connectionRefreshes.push(hit)
    if ((frontend || central) && url.pathname === `/api/workspace/${fixture.workspaceId}/user-hosted/pause`) hits.pauses.push(hit)

    if ((frontend || localApiBackend) && backendApiPath(url.pathname)) {
      const headers: Record<string, string> = {
        ...request.headers(),
        "x-opencode-directory": fixture.directory,
      }
      if (url.pathname === `/api/workspace/${fixture.workspaceId}/connection`) {
        headers.authorization = "Bearer signed-browser-token"
        headers.Authorization = "Bearer signed-browser-token"
        hit.authorization = headers.authorization
      }
      await route.continue({
        url: `${fixture.backendUrl}${url.pathname}${url.search}`,
        headers,
      })
      return
    }

    if (backend) {
      const headers: Record<string, string> = {
        ...request.headers(),
        "x-opencode-directory": fixture.directory,
      }
      if (url.pathname === `/api/workspace/${fixture.workspaceId}/connection`) {
        headers.authorization = "Bearer signed-browser-token"
        headers.Authorization = "Bearer signed-browser-token"
        hit.authorization = headers.authorization
      }
      await route.continue({
        headers,
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
}

async function openFilesPanel(page: Page) {
  await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 30_000 })

  if (!await page.locator('[data-testid="review-pane-root"]').isVisible().catch(() => false)) {
    if (await page.getByRole("button", { name: "Open workspace panel", exact: true }).isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Open workspace panel", exact: true }).click()
    }
  }
  await expect(page.locator('[data-testid="review-pane-root"]')).toBeVisible({ timeout: 10_000 })
  await page.getByRole("button", { name: "Open Files", exact: true }).click()
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
    }
  }, { path, init })
}

async function relayFileStatus(page: Page, token: string) {
  return await page.evaluate(async (input) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 2_000)
    const res = await fetch(input.path, {
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.token}`,
      },
    }).catch((err) => ({
      ok: false,
      status: 0,
      text: async () => err instanceof Error ? err.message : String(err),
    }))
    clearTimeout(timeout)
    return {
      ok: res.ok,
      status: res.status,
      body: await res.text().catch(() => ""),
    }
  }, {
    path: `/workspaces/${fixture.workspaceId}/file/content?path=hello.txt`,
    token,
  })
}

test.describe.serial("signed user-hosted browser relay live", () => {
  test.beforeAll(async () => {
    test.setTimeout(150_000)
    await startFixture()
  })

  test.afterAll(async () => {
    await stopFixture()
  })

  test.skip("loads a signed user-hosted workspace file through real Workspace Relay", async ({ page }) => {
    test.setTimeout(120_000)
    const hits = {
      directForbidden: [] as RequestHit[],
      relayRuntime: [] as RequestHit[],
      bootstraps: [] as RequestHit[],
      workspaceLists: [] as RequestHit[],
      sessionLists: [] as RequestHit[],
      connections: [] as RequestHit[],
      connectionRefreshes: [] as RequestHit[],
      pauses: [] as RequestHit[],
      failed: [] as string[],
    }
    await seed(page)
    await wire(page, hits)
    await openApp(page)
    await expect(page.getByText("Signed browser relay replay message")).toBeVisible({ timeout: 30_000 })

    await openFilesPanel(page)
    await page.getByTestId("workspace-files-navigator").getByRole("button", { name: /hello\.txt/ }).click()
    await expect(page.getByText("hello through signed browser relay").first()).toBeVisible({ timeout: 10_000 })

    expect(hits.directForbidden).toEqual([])
    expect(hits.failed).toEqual([])
    expect(hits.relayRuntime.map((item) => new URL(item.url).pathname)).toContain(
      `/workspaces/${fixture.workspaceId}/file/content`,
    )

    const refreshed = await signedJson(page, `/api/workspace/${fixture.workspaceId}/connection/refresh`, {
      method: "POST",
      body: JSON.stringify({
        previousJti: runtimeAccessTokenJti(fixture.runtimeAccessToken),
      }),
    })
    expect(refreshed, JSON.stringify(refreshed)).toMatchObject({ ok: true })
    const refreshedToken = String((refreshed.body as { runtimeAccessToken?: unknown })?.runtimeAccessToken ?? "")
    expect(refreshedToken).toContain(".")
    expect(refreshedToken).not.toBe(fixture.runtimeAccessToken)

    const beforePause = await relayFileStatus(page, refreshedToken)
    expect(beforePause.ok).toBe(true)
    expect(beforePause.body).toContain("hello through signed browser relay")

    const paused = await signedJson(page, `/api/workspace/${fixture.workspaceId}/user-hosted/pause`, {
      method: "POST",
      body: JSON.stringify({
        hostId: fixture.hostId,
        paused: true,
      }),
    })
    expect(paused.ok).toBe(true)

    await expect.poll(async () => {
      const afterPause = await relayFileStatus(page, refreshedToken)
      return afterPause.status
    }, { timeout: 10_000 }).not.toBe(200)

    expect(hits.connectionRefreshes.length).toBeGreaterThan(0)
    expect(hits.pauses.length).toBeGreaterThan(0)
  })
})
