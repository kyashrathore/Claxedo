import { expect, test, type Page } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { createPublicKey, generateKeyPairSync } from "node:crypto"
import {
  applyClerkEnvDefaults,
  CLERK_FRONTEND_API,
  loadEnvFile,
  realCloudPreflightMissingWithConfiguredCredentials,
} from "./real-provider-preflight"

type BrowserAuthModule = {
  getAuthToken(options: { template: "convex" }): Promise<string | null>
}

type BrowserConvexModule = {
  resetClaxedoConvexClient(): Promise<void>
  getClaxedoConvexClient(): {
    enabled: boolean
    isReady(): boolean
    isAuthenticated(): boolean
    mutation<T = unknown>(name: string, args?: unknown): Promise<T>
    query<T = unknown>(name: string, args?: unknown): Promise<T>
    close(): Promise<void>
  }
}

const execFileAsync = promisify(execFile)
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const REPO_ROOT = path.resolve(APP_DIR, "../..")
const SERVER_DIR = path.join(REPO_ROOT, "packages", "claxedo-server")
const FRONTEND_PORT = Number(process.env.PLAYWRIGHT_PORT ?? 4444)
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3335)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const EMAIL = process.env.E2E_CLERK_USER_EMAIL ?? "claxedo-e2e+clerk_test@example.com"
const PASSWORD = process.env.E2E_CLERK_USER_PASSWORD ?? "claxedo-e2e-password-2026"
const CLOUD_REPO = process.env.CLAXEDO_E2E_CLOUD_REPO ?? "https://github.com/octocat/Hello-World.git"
const CHILD_PATH = process.env.PATH ?? ""

let server: ChildProcess | undefined
let forbiddenOpenCode: Server | undefined
let serverLog = ""
let openCodeRequests: string[] = []
let relay: { url: string; close: () => Promise<void> } | undefined
let runtimePrivateKeyPem = ""
let runtimePublicKeyPem = ""
let runtimePublicKeyJwk = ""
let relayHostPublicKeyJwk = ""

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function wireLocalBackend(page: Page) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    ;(window as unknown as {
      __claxedoFetchFailures?: string[]
    }).__claxedoFetchFailures = []
    window.fetch = async (input, init) => {
      try {
        return await originalFetch(input, init)
      } catch (err) {
        const url = typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
        ;(window as unknown as {
          __claxedoFetchFailures?: string[]
        }).__claxedoFetchFailures?.push(`${init?.method ?? "GET"} ${url} ${err instanceof Error ? err.message : String(err)}`)
        throw err
      }
    }
  })
  await page.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/.*$/, async (route, request) => {
    if (relay && isRelayRequest(request.url(), relay.url)) {
      await route.continue()
      return
    }
    const current = new URL(request.url())
    if (Number(current.port || (current.protocol === "https:" ? "443" : "80")) === FRONTEND_PORT) {
      await route.continue()
      return
    }
    await route.continue({
      url: `${BACKEND_URL}${current.pathname}${current.search}`,
      headers: request.headers(),
    })
  })
}

async function ensureClerkUser() {
  await loadEnvFile(path.join(APP_DIR, ".env.local"))
  await loadEnvFile(path.join(SERVER_DIR, ".env.local"))
  applyClerkEnvDefaults()
  test.skip(!process.env.CLERK_SECRET_KEY, "CLERK_SECRET_KEY is required for real Clerk browser auth")

  const res = await fetch("https://api.clerk.com/v1/users", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email_address: [EMAIL],
      password: PASSWORD,
      skip_password_checks: true,
      skip_legal_checks: true,
    }),
  })
  if (res.ok) return
  const body = await res.json().catch(() => ({})) as { errors?: Array<{ code?: string; message?: string }> }
  const duplicate = body.errors?.some((item) => `${item.code ?? ""} ${item.message ?? ""}`.toLowerCase().match(/exist|taken/))
  if (!duplicate) throw new Error(`Failed to prepare Clerk test user: ${res.status}`)
  const found = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(EMAIL)}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
  })
  if (!found.ok) throw new Error(`Failed to find Clerk test user: ${found.status}`)
  const users = await found.json() as { data?: Array<{ id?: string }> } | Array<{ id?: string }>
  const userId = (Array.isArray(users) ? users : users.data ?? [])[0]?.id
  if (!userId) throw new Error("Failed to find Clerk test user id")
  const update = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: PASSWORD, skip_password_checks: true }),
  })
  if (!update.ok) throw new Error(`Failed to reset Clerk test user password: ${update.status}`)
}

async function signInWithClerkUi(page: Page) {
  await disableTestAuthBypass(page)
  await page.goto("/login")
  const firstPartyContinue = page.getByRole("button", { name: "Continue", exact: true })
  if (await firstPartyContinue.isVisible().catch(() => false)) {
    await firstPartyContinue.click()
    await page.waitForLoadState("domcontentloaded").catch(() => undefined)
  }
  const email = await firstVisible(page, [
    page.getByLabel(/email/i),
    page.getByPlaceholder(/email/i),
    page.getByRole("textbox", { name: /email/i }),
  ], 30_000)
  await email.fill(EMAIL)
  await page.getByRole("button", { name: "Continue", exact: true }).click()
  const password = await firstVisible(page, [
    page.getByPlaceholder(/password/i),
    page.getByLabel(/password/i),
  ], 30_000)
  await password.fill(PASSWORD)
  await page.getByRole("button", { name: /continue|sign in/i }).last().click()
  await expect(page).toHaveURL((url) =>
    (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
    url.port === String(FRONTEND_PORT) &&
    url.pathname !== "/login", { timeout: 30_000 })
  await page.waitForLoadState("domcontentloaded")
}

async function firstVisible(page: Page, locators: ReturnType<Page["getByLabel"]>[], timeout: number) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    for (const locator of locators) {
      const first = locator.first()
      if (await first.isVisible().catch(() => false)) return first
    }
    await page.waitForTimeout(250)
  }
  await expect(locators[0].first()).toBeVisible({ timeout: 1 })
  return locators[0].first()
}

async function disableTestAuthBypass(page: Page) {
  await page.addInitScript(() => {
    ;(window as typeof window & { __CLAXEDO_DISABLE_TEST_AUTH_BYPASS__?: boolean })
      .__CLAXEDO_DISABLE_TEST_AUTH_BYPASS__ = true
  })
}

async function waitFor(url: string) {
  const start = Date.now()
  while (Date.now() - start < 60_000) {
    const ok = await fetch(url).then((res) => res.ok).catch(() => false)
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for ${url}\n${serverLog}`)
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRelayRequest(requestUrl: string, relayUrl: string) {
  const request = new URL(requestUrl)
  const relay = new URL(relayUrl)
  if (request.origin === relay.origin) return true
  const requestLoopback = request.hostname === "127.0.0.1" || request.hostname === "localhost"
  const relayLoopback = relay.hostname === "127.0.0.1" || relay.hostname === "localhost"
  return requestLoopback && relayLoopback && request.protocol === relay.protocol && request.port === relay.port
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      resolve()
    }, 3_000)
    child.once("exit", () => {
      clearTimeout(timeout)
      resolve()
    })
    child.kill("SIGTERM")
  })
}

async function startForbiddenOpenCode() {
  openCodeRequests = []
  forbiddenOpenCode = createServer((req, res) => {
    openCodeRequests.push(`${req.method ?? "GET"} ${req.url ?? "/"}`)
    res.writeHead(599, { "content-type": "application/json" })
    res.end(JSON.stringify({ error: "old OpenCode path should not be used" }))
  })
  await new Promise<void>((resolve, reject) => {
    forbiddenOpenCode?.once("error", reject)
    forbiddenOpenCode?.listen(0, "127.0.0.1", () => {
      forbiddenOpenCode?.off("error", reject)
      resolve()
    })
  })
  const address = forbiddenOpenCode.address()
  if (!address || typeof address === "string") throw new Error("Forbidden OpenCode server did not bind")
  return `http://127.0.0.1:${address.port}`
}

async function startRelay() {
  const relayHost = generateKeyPairSync("ed25519")
  const configuredPrivatePem = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM?.trim().replaceAll("\\n", "\n")
  const configuredPublicPem = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM?.trim().replaceAll("\\n", "\n")
  if (configuredPrivatePem && configuredPublicPem) {
    runtimePrivateKeyPem = configuredPrivatePem
    runtimePublicKeyPem = configuredPublicPem
    runtimePublicKeyJwk = JSON.stringify(createPublicKey(runtimePublicKeyPem).export({ format: "jwk" }))
  } else {
    const runtime = generateKeyPairSync("ed25519")
    runtimePrivateKeyPem = runtime.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
    runtimePublicKeyPem = runtime.publicKey.export({ type: "spki", format: "pem" }).toString()
    runtimePublicKeyJwk = JSON.stringify(runtime.publicKey.export({ format: "jwk" }))
  }
  relayHostPublicKeyJwk = JSON.stringify(relayHost.publicKey.export({ format: "jwk" }))
  const logs: string[] = []
  const child = spawn("bun", ["src/user-hosted-relay-fixture.mjs"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID: "ws_cloud_fixture",
      CLAXEDO_RELAY_FIXTURE_HOST_ID: "host_cloud_fixture",
      CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK: runtimePublicKeyJwk,
      CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK: JSON.stringify(relayHost.privateKey.export({ format: "jwk" })),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  relay = await new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      stopChild(child).finally(() => reject(err))
    }
    const timeout = setTimeout(() => fail(new Error(`Workspace Relay fixture did not start\n${logs.join("")}`)), 10_000)
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString()
      logs.push(text)
      stdout += text
      for (const line of stdout.split("\n")) {
        if (settled || !line.trim()) continue
        try {
          const parsed = JSON.parse(line) as { url?: string }
          if (!parsed.url) continue
          settled = true
          clearTimeout(timeout)
          resolve({ url: parsed.url.replace(/\/$/, ""), close: () => stopChild(child) })
        } catch {}
      }
    })
    child.stderr?.on("data", (chunk) => logs.push(chunk.toString()))
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Workspace Relay fixture exited before start (${code ?? signal})\n${logs.join("")}`))
    })
    child.once("error", fail)
  })
}

async function startServer() {
  const opencodeUrl = await startForbiddenOpenCode()
  server = spawn("node", ["--import", "tsx", "src/main.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      CLAXEDO_DISABLE_OPENCODE_COMPAT: "1",
      CLAXEDO_WORKSPACE_RUNTIME_SOURCE: "1",
      CLAXEDO_WORKSPACE_RELAY_URL: relay!.url,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: runtimePrivateKeyPem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: runtimePublicKeyPem,
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK: relayHostPublicKeyJwk,
      CLAXEDO_RELAY_JWT_ALG: "EdDSA",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "sk-ant-e2e-provider-key",
      OPENCODE_URL: opencodeUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  server.stdout?.on("data", (chunk) => {
    serverLog += chunk.toString()
  })
  server.stderr?.on("data", (chunk) => {
    serverLog += chunk.toString()
  })
  await waitFor(`${BACKEND_URL}/api/claxedo/health`)
}

async function verifyRuntimeAccessTokenWithFixtureKey(token: string, workspaceId: string) {
  const { stdout } = await execFileAsync("node", [
    "--import",
    "tsx",
    "--eval",
    `
      const { importJWK, decodeJwt, decodeProtectedHeader } = await import("jose")
      const { verifyRuntimeAccessToken } = await import("@claxedo/workspace-relay")
      const token = process.env.CLAXEDO_E2E_RUNTIME_ACCESS_TOKEN
      const workspaceId = process.env.CLAXEDO_E2E_WORKSPACE_ID
      const publicJwk = JSON.parse(process.env.CLAXEDO_E2E_RUNTIME_PUBLIC_KEY_JWK)
      const key = await importJWK(publicJwk, "EdDSA")
      try {
        const claims = await verifyRuntimeAccessToken(token, key, { workspaceId })
        console.log(JSON.stringify({
          ok: true,
          header: decodeProtectedHeader(token),
          claims: {
            sub: claims.sub,
            org_id: claims.org_id,
            workspace_id: claims.workspace_id,
            host_id: claims.host_id,
            role: claims.role,
          },
        }))
      } catch (err) {
        console.log(JSON.stringify({
          ok: false,
          header: decodeProtectedHeader(token),
          payload: decodeJwt(token),
          code: err?.code,
          name: err?.name,
          message: err?.message,
        }))
      }
    `,
  ], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_E2E_RUNTIME_ACCESS_TOKEN: token,
      CLAXEDO_E2E_RUNTIME_PUBLIC_KEY_JWK: runtimePublicKeyJwk,
      CLAXEDO_E2E_WORKSPACE_ID: workspaceId,
    },
  })
  const result = JSON.parse(stdout) as { ok?: boolean }
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  return result
}

async function stopServer() {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM")
    await new Promise<void>((resolve) => {
      server?.once("exit", () => resolve())
      setTimeout(resolve, 5_000)
    })
    if (server.exitCode === null) server.kill("SIGKILL")
  }
  server = undefined
  await new Promise<void>((resolve) => forbiddenOpenCode?.close(() => resolve()) ?? resolve())
  forbiddenOpenCode = undefined
}

async function realConvexToken(page: Page) {
  return await page.evaluate(async () => {
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return null
    const auth = await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule
    return await auth.getAuthToken({ template: "convex" }) ?? null
  })
}

async function authedFetchFromPage(page: Page, input: {
  path: string
  method?: string
  body?: unknown
}) {
  return await page.evaluate(async (request: { backendUrl: string; path: string; method?: string; body?: unknown }) => {
    const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule).getAuthToken({ template: "convex" })
    const res = await fetch(`${request.backendUrl}${request.path}`, {
      method: request.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    })
    const text = await res.text().catch(() => "")
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, body, text }
  }, { backendUrl: BACKEND_URL, ...input })
}

async function persistConversation(sessionId: string, workspaceId: string, text: string) {
  const messageId = `msg_${slug(sessionId).slice(0, 80)}`
  const partId = `part_${slug(sessionId).slice(0, 80)}`
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await execFileAsync("node", [
        "--import",
        "./src/text-imports.mjs",
        "--import",
        "tsx",
        "-e",
        `
          const { persistMessageEvent } = await import("./src/cloud/message-replay.ts")
          persistMessageEvent(process.env.CLAXEDO_E2E_SESSION_ID, {
            type: "message.updated",
            properties: {
              info: {
                id: process.env.CLAXEDO_E2E_MESSAGE_ID,
                sessionID: process.env.CLAXEDO_E2E_SESSION_ID,
                role: "user",
                time: { created: Date.now() - 1000 },
              },
            },
          }, "workspace:" + process.env.CLAXEDO_E2E_WORKSPACE_ID)
          persistMessageEvent(process.env.CLAXEDO_E2E_SESSION_ID, {
            type: "message.part.updated",
            properties: {
              part: {
                id: process.env.CLAXEDO_E2E_PART_ID,
                sessionID: process.env.CLAXEDO_E2E_SESSION_ID,
                messageID: process.env.CLAXEDO_E2E_MESSAGE_ID,
                type: "text",
                text: process.env.CLAXEDO_E2E_MESSAGE_TEXT,
              },
            },
          }, "workspace:" + process.env.CLAXEDO_E2E_WORKSPACE_ID)
        `,
      ], {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          PATH: CHILD_PATH,
          CLAXEDO_E2E_SESSION_ID: sessionId,
          CLAXEDO_E2E_MESSAGE_TEXT: text,
          CLAXEDO_E2E_MESSAGE_ID: messageId,
          CLAXEDO_E2E_PART_ID: partId,
          CLAXEDO_E2E_WORKSPACE_ID: workspaceId,
        },
      })
      return
    } catch (err) {
      if (!String(err).includes("SQLITE_BUSY") || attempt === 7) throw err
      await delay(250)
    }
  }
}

test.describe.serial("real Clerk/Convex managed cloud workspace through Workspace Relay", () => {
  test.skip(process.env.CLAXEDO_E2E_REAL_CLOUD !== "1", "set CLAXEDO_E2E_REAL_CLOUD=1 to create a real provider-backed cloud workspace")

  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await loadEnvFile(path.join(APP_DIR, ".env.local"))
    await loadEnvFile(path.join(SERVER_DIR, ".env.local"))
    const missing = await realCloudPreflightMissingWithConfiguredCredentials(process.env, process.env.CLAXEDO_E2E_CLOUD_PROVIDER, SERVER_DIR)
    test.skip(missing.length > 0, `real cloud E2E requires: ${missing.join(", ")}`)
    await ensureClerkUser()
    await startRelay()
    await startServer()
  })

  test.afterAll(async () => {
    await stopServer()
    await relay?.close().catch(() => undefined)
    relay = undefined
  })

  test("creates a cloud workspace, resumes a session after reload, and routes runtime reads through Workspace Relay", async ({ page }) => {
    test.setTimeout(900_000)
    await wireLocalBackend(page)
    const relayHits: string[] = []
    const workspaceRuntimeProxyHits: string[] = []
    const forbiddenBackendRuntimeHits: string[] = []
    const sessionRequests: string[] = []
    const failedRequests: string[] = []
    const pageErrors: string[] = []
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`.trim())
    })
    page.on("pageerror", (error) => {
      pageErrors.push(error.stack ?? error.message)
    })
    page.on("request", (request) => {
      if (relay && isRelayRequest(request.url(), relay.url)) relayHits.push(request.url())
      const url = new URL(request.url())
      if (url.origin === BACKEND_URL) {
        if (url.pathname.startsWith("/workspaces/")) {
          workspaceRuntimeProxyHits.push(`${request.method()} ${url.pathname}`)
        }
        if (
          url.pathname === "/global/event"
          || url.pathname === "/mcp"
          || url.pathname.startsWith("/api/claxedo/pty")
          || url.pathname.startsWith("/api/claxedo/file")
        ) {
          forbiddenBackendRuntimeHits.push(`${request.method()} ${url.pathname}`)
        }
      }
    })

    openCodeRequests = []
    await signInWithClerkUi(page)
    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()

    const providers = await authedFetchFromPage(page, { path: "/api/workspace/providers" })
    expect(providers.status, JSON.stringify(providers.body)).toBe(200)
    const provider = process.env.CLAXEDO_E2E_CLOUD_PROVIDER?.trim() || (
      (providers.body as {
        default_provider?: string
        providers?: Array<{ id?: string; configured?: boolean; default?: boolean }>
      }).providers?.find((item) => item.default && item.configured)?.id
      ?? (providers.body as { providers?: Array<{ id?: string; configured?: boolean }> }).providers?.find((item) => item.configured)?.id
      ?? (providers.body as { default_provider?: string }).default_provider
      ?? "daytona"
    )

    const created = await authedFetchFromPage(page, {
      path: "/api/workspace/create",
      method: "POST",
      body: {
        provider,
        repoUrl: CLOUD_REPO,
        workspaceName: `real-cloud-relay-${Date.now()}`,
      },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const workspaceId = (created.body as { workspaceId?: string }).workspaceId
    expect(workspaceId).toMatch(/^ws_/)

    try {
      let ready = false
      let lastReadyPoll: unknown
      const readyDeadline = Date.now() + 780_000
      while (Date.now() < readyDeadline) {
        const current = await authedFetchFromPage(page, { path: `/api/workspace/resolve?workspaceId=${encodeURIComponent(workspaceId!)}` })
          .catch((err) => ({
            status: 0,
            body: { error: err instanceof Error ? err.message : String(err) },
            text: err instanceof Error ? err.message : String(err),
          }))
        lastReadyPoll = current
        const body = current.body as { status?: string; error?: string } | null
        if (body?.status === "ready") {
          ready = true
          break
        }
        if (current.status === 404 || (current.status !== 0 && body?.error)) break
        await delay(10_000)
      }
      if (!ready) {
        throw new Error([
          "cloud workspace did not become ready",
          `last readiness response: ${JSON.stringify(lastReadyPoll)}`,
          `server log tail:\n${serverLog.split("\n").slice(-180).join("\n")}`,
        ].join("\n\n"))
      }

      const connection = await authedFetchFromPage(page, { path: `/api/workspace/${workspaceId}/connection` })
      expect(connection.status, [
        JSON.stringify(connection.body),
        `server log tail:\n${serverLog.split("\n").slice(-120).join("\n")}`,
      ].join("\n")).toBe(200)
      expect(connection.body).toMatchObject({
        access: "cloud",
        backing: "cloud-vm",
        workspaceId,
        relayUrl: relay!.url,
        runtimeAccessToken: expect.any(String),
      })
      await verifyRuntimeAccessTokenWithFixtureKey((connection.body as { runtimeAccessToken: string }).runtimeAccessToken, workspaceId!)

      const relayHealth = await fetch(`${relay!.url}/workspaces/${workspaceId}/global/health`, {
        headers: { Authorization: `Bearer ${(connection.body as { runtimeAccessToken: string }).runtimeAccessToken}` },
      })
      expect(relayHealth.status, await relayHealth.text()).toBe(200)

      const sessionId = `real-cloud-replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const replayText = `real cloud relay replay ${Date.now()}`
      await page.evaluate(async (input: { workspaceId: string; sessionId: string }) => {
        const convex = await import("/src/utils/convex-client.ts" as string) as BrowserConvexModule
        await convex.resetClaxedoConvexClient()
        const client = convex.getClaxedoConvexClient()
        const start = Date.now()
        while ((!client.isReady() || !client.isAuthenticated()) && Date.now() - start < 30_000) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        await client.mutation("sessions:upsertVisibility", {
          workspace_id: input.workspaceId,
          sessions: [{
            session_id: input.sessionId,
            title: "Real cloud Relay replay session",
            created_at: Date.now() - 1000,
            updated_at: Date.now(),
          }],
        })
        await client.close()
      }, { workspaceId: workspaceId!, sessionId })
      await persistConversation(sessionId, workspaceId!, replayText)

      page.on("request", (request) => {
        const url = new URL(request.url())
        const prefix = `/api/control/sessions/${sessionId}/`
        if (url.pathname.startsWith(prefix)) sessionRequests.push(url.pathname.slice(prefix.length))
      })
      await page.goto(`/${slug(`workspace:${workspaceId}`)}/session/${sessionId}`)
      await page.reload()
      try {
        await expect(page.getByText(replayText)).toBeVisible({ timeout: 60_000 })
      } catch (err) {
        const fetchFailures = await page.evaluate(() =>
          (window as unknown as { __claxedoFetchFailures?: string[] }).__claxedoFetchFailures ?? [],
        ).catch(() => [])
        throw new Error([
          err instanceof Error ? err.message : String(err),
          `failed requests: ${JSON.stringify(failedRequests.slice(-20))}`,
          `fetch failures: ${JSON.stringify(fetchFailures.slice(-20))}`,
          `page errors: ${JSON.stringify(pageErrors.slice(-10))}`,
          `relay hits: ${JSON.stringify(relayHits.slice(-20))}`,
          `session requests: ${JSON.stringify(sessionRequests)}`,
        ].join("\n"))
      }
      const messagesBeforeReload = sessionRequests.filter((item) => item === "messages").length
      await page.reload()
      await expect(page.getByText(replayText)).toBeVisible({ timeout: 60_000 })
      await expect.poll(() => sessionRequests.filter((item) => item === "messages").length, { timeout: 30_000 })
        .toBeGreaterThan(messagesBeforeReload)

      expect(sessionRequests).toContain("messages")
      expect(sessionRequests).toContain("gateway")

      const promptText = `cloud ui send via relay ${Date.now()}`
      const input = page.getByRole("textbox", { name: /Ask anything/i }).last()
      await expect(input).toBeVisible({ timeout: 20_000 })
      await expect(page.getByText("Big Pickle").last()).toBeVisible({ timeout: 20_000 })
      await input.focus()
      await page.keyboard.press("Escape")
      await input.fill(promptText)
      await page.evaluate(() => {
        ;(window as typeof window & { __claxedoSubmitClicks?: number }).__claxedoSubmitClicks = 0
        ;(window as typeof window & { __claxedoFormSubmits?: number }).__claxedoFormSubmits = 0
        document.addEventListener("click", (event) => {
          if ((event.target as Element | null)?.closest("[data-action='prompt-submit']")) {
            ;(window as typeof window & { __claxedoSubmitClicks?: number }).__claxedoSubmitClicks =
              ((window as typeof window & { __claxedoSubmitClicks?: number }).__claxedoSubmitClicks ?? 0) + 1
          }
        }, { once: true, capture: true })
        document.addEventListener("submit", (event) => {
          if ((event.target as Element | null)?.querySelector("[data-action='prompt-submit']")) {
            ;(window as typeof window & { __claxedoFormSubmits?: number }).__claxedoFormSubmits =
              ((window as typeof window & { __claxedoFormSubmits?: number }).__claxedoFormSubmits ?? 0) + 1
          }
        }, { capture: true })
      })
      const sendButton = page.getByRole("button", { name: "Send", exact: true }).last()
      await expect(sendButton).toBeEnabled({ timeout: 10_000 })
      await sendButton.click()
      await expect(page.getByText(promptText)).toBeVisible({ timeout: 10_000 })
      await expect.poll(
        () =>
          relayHits.some((url) => url.includes(`/workspaces/${workspaceId}/`)) ||
          workspaceRuntimeProxyHits.some((url) => url.includes(`/workspaces/${workspaceId}/`)),
        { timeout: 20_000 },
      ).toBe(true)
      expect(sessionRequests).toContain("gateway")
      expect(forbiddenBackendRuntimeHits).toEqual([])
      expect(openCodeRequests).toEqual([])
    } finally {
      if (workspaceId) {
        await authedFetchFromPage(page, {
          path: `/api/workspace/${workspaceId}?access=cloud`,
          method: "DELETE",
        }).catch(() => undefined)
      }
    }
  })
})
