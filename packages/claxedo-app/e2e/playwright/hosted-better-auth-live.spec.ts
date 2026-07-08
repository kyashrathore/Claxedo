import { expect, test, type Page, type Route } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const EXAMPLE_DIR = path.join(REPO_ROOT, "examples", "hosted-team")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3339)
const WORKSPACE_ID = "ws_hosted_team_example"
const DIRECTORY = "/workspace/hosted-team-example"
const SESSION_ID = "hosted-team-session"
const TOKEN = "hosted-example-user"

type RequestHit = {
  method: string
  url: string
  authorization?: string
}

let child: ChildProcess | undefined
let backendUrl = ""
let fixtureLog = ""
let tempDir = ""

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

function api(route: Route) {
  const type = route.request().resourceType()
  return type === "fetch" || type === "xhr" || type === "eventsource" || route.request().method() === "OPTIONS"
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization,content-type,accept,x-opencode-directory",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  }
}

function backendApiPath(pathname: string) {
  return pathname.startsWith("/api/") ||
    pathname.startsWith("/global/") ||
    pathname === "/provider" ||
    pathname.startsWith("/provider/") ||
    pathname === "/session" ||
    pathname.startsWith("/session/") ||
    pathname === "/mcp" ||
    pathname === "/agent" ||
    pathname === "/command" ||
    pathname === "/vcs" ||
    pathname === "/lsp"
}

async function startHostedExample() {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-hosted-better-auth-"))
  child = spawn("bun", ["run", "src/main.ts"], {
    cwd: EXAMPLE_DIR,
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      CLAXEDO_DATA_DIR: path.join(tempDir, "data"),
      CLAXEDO_STATE_DIR: path.join(tempDir, "state"),
      CLAXEDO_WORKSPACE_RELAY_URL: `http://127.0.0.1:${BACKEND_PORT}`,
      BETTER_AUTH_ISSUER: "https://better-auth.e2e.test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  backendUrl = await new Promise<string>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      stopHostedExample().finally(() => reject(err))
    }
    const timeout = setTimeout(() => fail(new Error(`hosted-team example did not start\n${fixtureLog}`)), 60_000)

    child?.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      fixtureLog += text
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { serverUrl?: string }
          if (!parsed.serverUrl) continue
          settled = true
          clearTimeout(timeout)
          resolve(parsed.serverUrl)
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
      reject(new Error(`hosted-team example exited before start (${code ?? signal})\n${fixtureLog}`))
    })
    child?.once("error", fail)
  })
}

async function stopHostedExample() {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      child?.once("exit", () => resolve())
      setTimeout(resolve, 5_000)
    })
    if (child.exitCode === null) child.kill("SIGKILL")
  }
  child = undefined
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
  tempDir = ""
}

async function seed(page: Page) {
  await page.addInitScript((input: { backendUrl: string; directory: string; token: string; workspaceId: string }) => {
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
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_TOKEN__ = input.token
    ;(window as typeof window & {
      __CLAXEDO_TEST_AUTH_TOKEN__?: string
      __CLAXEDO_TEST_AUTH_USER__?: { id: string }
    }).__CLAXEDO_TEST_AUTH_USER__ = { id: input.token }
    const project = {
      id: "proj_hosted_team_example",
      name: "Hosted Team Example",
      worktree: input.directory,
      sandboxes: [input.directory],
      expanded: true,
      workspaces: {
        [input.directory]: {
          id: input.workspaceId,
          workspaceId: input.workspaceId,
          kind: "cloud",
          directory: input.directory,
          workspace_name: "Hosted Team Example",
        },
      },
      time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    }
    localStorage.setItem(
      "opencode.global.dat:globalSync.project",
      JSON.stringify({ value: [project] }),
    )
    localStorage.setItem(
      "opencode.global.dat:server",
      JSON.stringify({
        list: [],
        projects: {
          local: [project],
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
  }, { backendUrl, directory: DIRECTORY, token: TOKEN, workspaceId: WORKSPACE_ID })
}

async function wire(page: Page, hits: {
  workspaceLists: RequestHit[]
  workspaceResolves: RequestHit[]
  sessionLists: RequestHit[]
  sessionMessages: RequestHit[]
  sessionCapabilities: RequestHit[]
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
      await route.fulfill({ status: 204, headers: corsHeaders() })
      return
    }

    const hit = {
      method: request.method(),
      url: request.url(),
      authorization: request.headers().authorization,
    }
    const frontend = Number(url.port || (url.protocol === "https:" ? "443" : "80")) === FRONTEND_PORT
    const localApiBackend = ["localhost", "127.0.0.1"].includes(url.hostname) &&
      !request.url().startsWith(backendUrl) &&
      !frontend &&
      backendApiPath(url.pathname)

    if (url.pathname === "/api/workspace") hits.workspaceLists.push(hit)
    if (url.pathname === "/api/workspace/resolve") hits.workspaceResolves.push(hit)
    if (url.pathname === "/api/control/sessions") hits.sessionLists.push(hit)
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/messages`) hits.sessionMessages.push(hit)
    if (url.pathname === `/api/control/sessions/${SESSION_ID}/capabilities`) hits.sessionCapabilities.push(hit)

    if ((frontend || localApiBackend) && backendApiPath(url.pathname)) {
      await route.continue({
        url: `${backendUrl}${url.pathname}${url.search}`,
        headers: {
          ...request.headers(),
          "x-opencode-directory": DIRECTORY,
        },
      })
      return
    }

    await route.continue()
  })
}

test.describe.serial("hosted Better Auth browser flow", () => {
  test.skip(
    process.env.CLAXEDO_HOSTED_BETTER_AUTH_LIVE !== "1",
    "set CLAXEDO_HOSTED_BETTER_AUTH_LIVE=1 to run the hosted Better Auth example browser flow",
  )

  test.beforeAll(async () => {
    test.setTimeout(90_000)
    await startHostedExample()
  })

  test.afterAll(async () => {
    await stopHostedExample()
  })

  test("loads signed hosted workspace inventory and session replay from the example server", async ({ page }) => {
    test.setTimeout(90_000)
    const hits = {
      workspaceLists: [] as RequestHit[],
      workspaceResolves: [] as RequestHit[],
      sessionLists: [] as RequestHit[],
      sessionMessages: [] as RequestHit[],
      sessionCapabilities: [] as RequestHit[],
      failed: [] as string[],
    }
    await seed(page)
    await wire(page, hits)

    await page.goto(`/${slug(DIRECTORY)}/session/${SESSION_ID}`)
    await page.waitForLoadState("domcontentloaded")
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () =>
      await page.evaluate(() =>
        (window as typeof window & { __claxedoConnections?: { snapshot?: () => unknown } })
          .__claxedoConnections?.snapshot?.()
      ), {
      timeout: 30_000,
    }).toMatchObject({
      [WORKSPACE_ID]: {
        status: "ready",
      },
    })
    await expect(page.getByRole("textbox", { name: /Ask anything/i })).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText("Hosted Better Auth browser session")).toBeVisible({ timeout: 30_000 })

    expect(hits.failed.filter((item) =>
      item.includes(`${backendUrl}/api/`) ||
      item.includes("/api/control/") ||
      item.includes("/api/workspace")
    )).toEqual([])
    expect(hits.workspaceLists.map((item) => item.url)).toContainEqual(expect.stringContaining("access=cloud"))
    expect(hits.sessionLists.map((item) => item.url)).toContainEqual(expect.stringContaining("workspaceId=ws_hosted_team_example"))
    expect(hits.sessionMessages.map((item) => item.authorization)).toContain(`Bearer ${TOKEN}`)
    expect(hits.sessionCapabilities.map((item) => item.authorization)).toContain(`Bearer ${TOKEN}`)
  })
})
