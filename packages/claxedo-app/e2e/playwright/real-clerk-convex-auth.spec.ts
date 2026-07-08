import { expect, test, type Page } from "@playwright/test"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { generateKeyPairSync } from "node:crypto"
import {
  applyClerkEnvDefaults,
  CLERK_FRONTEND_API,
  loadEnvFile,
  realClerkPreflightMissing,
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
const BACKEND_PORT = Number(process.env.CLAXEDO_E2E_BACKEND_PORT ?? 3331)
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`
const EMAIL = process.env.E2E_CLERK_USER_EMAIL ?? "claxedo-e2e+clerk_test@example.com"
const PASSWORD = process.env.E2E_CLERK_USER_PASSWORD ?? "claxedo-e2e-password-2026"
const CHILD_PATH = process.env.PATH ?? ""

type RequestHit = {
  method: string
  url: string
  authorization?: string
}

let workspaceDir = ""
let workspaceId = ""
let dataDir = ""
let fakeBinDir = ""
let server: ChildProcess | undefined
let forbiddenOpenCode: Server | undefined
let serverLog = ""
let openCodeRequests: string[] = []
let relay: { url: string; close: () => Promise<void> } | undefined
let relayHostId = ""
let runtimePrivateKeyPem = ""
let relayHostPublicKeyJwk = ""

function slug(value: string) {
  return Buffer.from(value, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "")
}

async function wireLocalBackend(page: Page) {
  await page.route(/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/.*$/, async (route, request) => {
    const current = new URL(request.url())
    if (relay && request.url().startsWith(relay.url)) {
      await route.continue()
      return
    }
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
  const duplicate = body.errors?.some((item) => {
    const text = `${item.code ?? ""} ${item.message ?? ""}`.toLowerCase()
    return text.includes("exist") || text.includes("taken")
  })
  if (duplicate) {
    await resetClerkUserPassword()
    return
  }
  throw new Error(`Failed to prepare Clerk test user: ${res.status}`)
}

async function resetClerkUserPassword() {
  const res = await fetch(`https://api.clerk.com/v1/users?email_address=${encodeURIComponent(EMAIL)}`, {
    headers: { Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}` },
  })
  if (!res.ok) throw new Error(`Failed to find Clerk test user: ${res.status}`)
  const body = await res.json() as { data?: Array<{ id?: string }> } | Array<{ id?: string }>
  const userId = (Array.isArray(body) ? body : body.data ?? [])[0]?.id
  if (!userId) throw new Error("Failed to find Clerk test user id")
  const update = await fetch(`https://api.clerk.com/v1/users/${userId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${process.env.CLERK_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      password: PASSWORD,
      skip_password_checks: true,
    }),
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

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

async function realClaudeBinary() {
  const binary = process.env.CLAXEDO_E2E_CLAUDE_BIN ?? "claude"
  if (binary.includes("/")) {
    await execFileAsync(binary, ["--version"], { timeout: 10_000 })
    return binary
  }
  const found = await execFileAsync("which", [binary], { timeout: 10_000 })
  const resolved = found.stdout.trim() || binary
  await execFileAsync(resolved, ["--version"], { timeout: 10_000 })
  return resolved
}

function claudePrintArgs(prompt: string) {
  return [
    "-p",
    prompt,
    "--dangerously-skip-permissions",
    ...(process.env.CLAXEDO_E2E_CLAUDE_MODEL ? ["--model", process.env.CLAXEDO_E2E_CLAUDE_MODEL] : []),
    ...(process.env.CLAXEDO_E2E_CLAUDE_FALLBACK_MODEL ? ["--fallback-model", process.env.CLAXEDO_E2E_CLAUDE_FALLBACK_MODEL] : []),
  ]
}

async function realClaudeCommand(prompt: string) {
  const binary = await realClaudeBinary()
  const marker = `CLAXEDO_CLAUDE_PREFLIGHT_${Date.now()}`
  const preflight = await execFileAsync(binary, claudePrintArgs(`Reply exactly ${marker}. Do not include any other words.`), {
    timeout: 60_000,
  }).catch(() => undefined)
  if (!preflight?.stdout.includes(marker)) return
  return [binary, ...claudePrintArgs(prompt)].map(shellQuote).join(" ")
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
        if ((target.includes("/api/claxedo/pty/") || target.includes("/api/wr/pty/")) && target.includes("/connect")) {
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

function isPtyCreatePath(pathname: string) {
  return pathname.endsWith("/api/claxedo/pty") || pathname.endsWith("/api/wr/pty")
}

function runtimeHookUrl(pathname: "agent-lifecycle" | "terminal-session") {
  return `${BACKEND_URL}/api/wr/hook/${pathname}`
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

async function startRelayFixture(input: {
  runtimePublicKeyJwk: JsonWebKey
  relayHostPrivateKeyJwk: JsonWebKey
}) {
  const logs: string[] = []
  const child = spawn("bun", ["src/user-hosted-relay-fixture.mjs"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: fakeBinDir ? `${fakeBinDir}:${CHILD_PATH}` : CHILD_PATH,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_RELAY_FIXTURE_WORKSPACE_ID: workspaceId,
      CLAXEDO_RELAY_FIXTURE_HOST_ID: relayHostId,
      CLAXEDO_RELAY_FIXTURE_RUNTIME_PUBLIC_KEY_JWK: JSON.stringify(input.runtimePublicKeyJwk),
      CLAXEDO_RELAY_FIXTURE_HOST_PRIVATE_KEY_JWK: JSON.stringify(input.relayHostPrivateKeyJwk),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  return await new Promise<{
    url: string
    close: () => Promise<void>
  }>((resolve, reject) => {
    let settled = false
    let stdout = ""
    const fail = (err: Error) => {
      if (settled) return
      settled = true
      stopChild(child).finally(() => reject(err))
    }
    const timeout = setTimeout(() => {
      fail(new Error(`Workspace Relay fixture did not start\n${logs.join("")}`))
    }, 10_000)

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
          resolve({
            url: parsed.url.replace(/\/$/, ""),
            close: () => stopChild(child),
          })
        } catch {
          continue
        }
      }
    })
    child.stderr?.on("data", (chunk) => {
      logs.push(chunk.toString())
    })
    child.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(new Error(`Workspace Relay fixture exited before start (${code ?? signal})\n${logs.join("")}`))
    })
    child.once("error", fail)
  })
}

async function startRelay() {
  relayHostId = `host_real_auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const runtime = generateKeyPairSync("ed25519")
  const relayHost = generateKeyPairSync("ed25519")
  runtimePrivateKeyPem = runtime.privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  relayHostPublicKeyJwk = JSON.stringify(relayHost.publicKey.export({ format: "jwk" }))
  relay = await startRelayFixture({
    runtimePublicKeyJwk: runtime.publicKey.export({ format: "jwk" }) as JsonWebKey,
    relayHostPrivateKeyJwk: relayHost.privateKey.export({ format: "jwk" }) as JsonWebKey,
  })
}

async function startServer() {
  const opencodeUrl = await startForbiddenOpenCode()
  if (!dataDir) dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-real-auth-data-"))
  server = spawn("bun", ["run", "start"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_SERVER_PORT: String(BACKEND_PORT),
      CLAXEDO_DISABLE_OPENCODE_COMPAT: "1",
      CLAXEDO_WORKSPACE_RUNTIME_SOURCE: "1",
      ...(relay ? { CLAXEDO_WORKSPACE_RELAY_URL: relay.url } : {}),
      ...(runtimePrivateKeyPem ? { CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: runtimePrivateKeyPem } : {}),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      ...(relayHostPublicKeyJwk ? { CLAXEDO_RELAY_HOST_PUBLIC_KEY_JWK: relayHostPublicKeyJwk } : {}),
      CLAXEDO_RELAY_JWT_ALG: "EdDSA",
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

async function prepareWorkspace() {
  if (!dataDir) dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-real-auth-data-"))
  workspaceId = `ws_real_auth_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  workspaceDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-real-auth-workspace-")))
  fakeBinDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-real-auth-bin-")))
  await fs.writeFile(path.join(fakeBinDir, "claude"), `#!/bin/sh
notify() {
  EVENT="$1"
  curl -fsS -G "http://127.0.0.1:\${CLAXEDO_PORT:-3001}/api/claxedo/hook/agent-lifecycle" \\
    --data-urlencode "tabId=\${CLAXEDO_TAB_ID:-\${CLAXEDO_TERMINAL_ID:-}}" \\
    --data-urlencode "terminalId=\${CLAXEDO_TERMINAL_ID:-\${CLAXEDO_TAB_ID:-}}" \\
    --data-urlencode "workspaceId=\${CLAXEDO_WORKSPACE_ID:-}" \\
    --data-urlencode "provider=claude" \\
    --data-urlencode "sessionId=fake-claude-e2e-session" \\
    --data-urlencode "prompt=hello from real auth terminal e2e" \\
    --data-urlencode "lastAssistantMessage=fake claude lifecycle response" \\
    --data-urlencode "eventType=$EVENT" >/dev/null 2>&1 || true
}
printf 'fake claude received: %s\\n' "$*"
notify Busy
sleep 10
printf 'fake claude lifecycle response\\n'
notify Idle
`, { mode: 0o755 })
  await execFileAsync("git", ["init"], { cwd: workspaceDir })
  await fs.writeFile(path.join(workspaceDir, "real-auth-proof.txt"), "real Clerk and Convex auth\n")
  const now = Date.now()
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, "workspaces.json"), JSON.stringify({
    version: 3,
    workspaces: [{
      id: workspaceId,
      project_id: workspaceId,
      project_name: "Real Auth Workspace",
      workspace_name: "main",
      directory: workspaceDir,
      kind: "local",
      created_at: now,
      updated_at: now,
    }],
  }, null, 2) + "\n")
}

async function verifyWorkspace() {
  const res = await fetch(`${BACKEND_URL}/api/workspace/resolve?directory=${encodeURIComponent(workspaceDir)}&create=true`)
  if (!res.ok) throw new Error(`Failed to create local workspace: ${res.status} ${await res.text()}`)
  const body = await res.json() as { workspaceId?: string }
  if (!body.workspaceId) throw new Error(`Workspace resolve did not return an id: ${JSON.stringify(body)}`)
  expect(body.workspaceId).toBe(workspaceId)
}

async function persistConversation(sessionId: string, text: string) {
  const messageId = `msg_${slug(sessionId).slice(0, 80)}`
  const partId = `part_${slug(sessionId).slice(0, 80)}`
  await execFileAsync("node", [
    "--import",
    "./src/text-imports.mjs",
    "--import",
    "tsx",
    "-e",
    `
      const { persistMessageEvent } = await import("./src/cloud/message-replay.ts")
      const { RuntimeStore } = await import("../workspace-runtime/src/store.ts")
      const path = await import("node:path")
      const sessionId = process.env.CLAXEDO_E2E_SESSION_ID
      const text = process.env.CLAXEDO_E2E_MESSAGE_TEXT
      const messageId = process.env.CLAXEDO_E2E_MESSAGE_ID
      const partId = process.env.CLAXEDO_E2E_PART_ID
      const workspaceId = process.env.CLAXEDO_E2E_WORKSPACE_ID
      const workspaceDir = process.env.CLAXEDO_E2E_WORKSPACE_DIR
      const store = new RuntimeStore(path.join(process.env.CLAXEDO_DATA_DIR, "agent-core", workspaceId))
      store.bindSession({
        sessionId,
        directory: workspaceDir,
        agentSessionId: sessionId,
        title: "Real auth replay session",
        createdAt: Date.now() - 1000,
      })
      store.updateSessionConfig(sessionId, {
        runner: {
          type: "claude",
          binary: path.join(process.env.CLAXEDO_E2E_FAKE_BIN_DIR, "claude"),
        },
      }, { directory: workspaceDir })
      persistMessageEvent(sessionId, {
        type: "message.updated",
        properties: {
          info: {
            id: messageId,
            sessionID: sessionId,
            role: "user",
            time: { created: Date.now() - 1000 },
          },
        },
      }, "workspace:" + process.env.CLAXEDO_E2E_WORKSPACE_ID)
      store.appendEvent({
        sessionId,
        agentSessionId: sessionId,
        payload: {
          type: "message.updated",
          properties: {
            info: {
              id: messageId,
              sessionID: sessionId,
              role: "user",
              time: { created: Date.now() - 1000 },
            },
          },
        },
      })
      persistMessageEvent(sessionId, {
        type: "message.part.updated",
        properties: {
          part: {
            id: partId,
            sessionID: sessionId,
            messageID: messageId,
            type: "text",
            text,
          },
        },
      }, "workspace:" + process.env.CLAXEDO_E2E_WORKSPACE_ID)
      store.appendEvent({
        sessionId,
        agentSessionId: sessionId,
        payload: {
          type: "message.part.updated",
          properties: {
            part: {
              id: partId,
              sessionID: sessionId,
              messageID: messageId,
              type: "text",
              text,
            },
          },
        },
      })
      const runtimeMessages = store.getMessages(sessionId)
      if (!JSON.stringify(runtimeMessages).includes(text)) {
        throw new Error("Runtime journal seed did not produce replay messages")
      }
      store.close()
    `,
  ], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_E2E_SESSION_ID: sessionId,
      CLAXEDO_E2E_MESSAGE_TEXT: text,
      CLAXEDO_E2E_MESSAGE_ID: messageId,
      CLAXEDO_E2E_PART_ID: partId,
      CLAXEDO_E2E_WORKSPACE_ID: workspaceId,
      CLAXEDO_E2E_WORKSPACE_DIR: workspaceDir,
      CLAXEDO_E2E_FAKE_BIN_DIR: fakeBinDir,
    },
  })
  return { messageId, partId }
}

async function bindRuntimeSession(sessionId: string, title: string) {
  await execFileAsync("node", [
    "--import",
    "tsx",
    "-e",
    `
      const { RuntimeStore } = await import("../workspace-runtime/src/store.ts")
      const path = await import("node:path")
      const sessionId = process.env.CLAXEDO_E2E_SESSION_ID
      const title = process.env.CLAXEDO_E2E_SESSION_TITLE
      const workspaceId = process.env.CLAXEDO_E2E_WORKSPACE_ID
      const workspaceDir = process.env.CLAXEDO_E2E_WORKSPACE_DIR
      const store = new RuntimeStore(path.join(process.env.CLAXEDO_DATA_DIR, "agent-core", workspaceId))
      store.bindSession({
        sessionId,
        directory: workspaceDir,
        agentSessionId: sessionId,
        title,
        createdAt: Date.now() - 1000,
      })
      store.updateSessionConfig(sessionId, {
        runner: {
          type: "claude",
          binary: path.join(process.env.CLAXEDO_E2E_FAKE_BIN_DIR, "claude"),
        },
      }, { directory: workspaceDir })
      store.close()
    `,
  ], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PATH: CHILD_PATH,
      CLAXEDO_DATA_DIR: dataDir,
      CLAXEDO_E2E_SESSION_ID: sessionId,
      CLAXEDO_E2E_SESSION_TITLE: title,
      CLAXEDO_E2E_WORKSPACE_ID: workspaceId,
      CLAXEDO_E2E_WORKSPACE_DIR: workspaceDir,
      CLAXEDO_E2E_FAKE_BIN_DIR: fakeBinDir,
    },
  })
}

async function realConvexToken(page: Page) {
  return await page.evaluate(async () => {
    if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return null
    const auth = await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule
    return await auth.getAuthToken({ template: "convex" }) ?? null
  })
}

function decodeJwtPayload(token: string) {
  const parts = token.split(".")
  expect(parts, `expected Clerk Convex JWT, got token prefix ${token.slice(0, 16)}`).toHaveLength(3)
  return JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { aud?: unknown; iss?: unknown }
}

function isNavigationEvaluateError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("Execution context was destroyed") ||
    message.includes("Cannot find context with specified id")
}

async function directConvexWorkspaceState(page: Page, workspaceId: string) {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {})
    try {
      return await page.evaluate(async (input: { workspaceId: string }) => {
        if (location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return null
        const convex = await import("/src/utils/convex-client.ts" as string) as BrowserConvexModule
        await convex.resetClaxedoConvexClient()
        const client = convex.getClaxedoConvexClient()
        const start = Date.now()
        while ((!client.isReady() || !client.isAuthenticated()) && Date.now() - start < 30_000) {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
        const user = await client.mutation<{ user_id?: string }>("users:me")
        const workspaces = await client.query<Array<{ workspace_id?: string }>>("workspaces:list")
        const opened = await client.query<{ allowed?: boolean; workspace?: { workspace_id?: string } }>("workspaces:open", {
          workspace_id: input.workspaceId,
        })
        await client.close()
        return {
          enabled: client.enabled,
          ready: client.isReady(),
          authenticated: client.isAuthenticated(),
          user,
          workspaces,
          opened,
        }
      }, { workspaceId })
    } catch (err) {
      if (!isNavigationEvaluateError(err)) throw err
      lastError = err
      await page.waitForTimeout(250)
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Timed out waiting for stable app page")
}

async function registerWorkspaceForRealAuth(page: Page) {
  const started = Date.now()
  let existing = await readSignedWorkspaceConnection(page)
  while (existing.status === 429 && Date.now() - started < 30_000) {
    const retryAfter = typeof existing.body?.error?.retryAfterMs === "number"
      ? existing.body.error.retryAfterMs
      : 1_000
    await page.waitForTimeout(Math.min(Math.max(retryAfter, 250), 5_000))
    existing = await readSignedWorkspaceConnection(page)
  }
  if (existing.status === 200) return

  const registered = await page.evaluate(async (input: { backendUrl: string; workspaceId: string }) => {
    const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule).getAuthToken({ template: "convex" })
    const res = await fetch(`${input.backendUrl}/api/workspace/${input.workspaceId}/user-hosted/register`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ displayName: "Real Clerk Convex E2E", ttlMs: 10 * 60 * 1000 }),
    })
    return { status: res.status, body: await res.text() }
  }, { backendUrl: BACKEND_URL, workspaceId })
  if (registered.status >= 500 && registered.body.includes("Workspace not found")) {
    existing = await readSignedWorkspaceConnection(page)
    if (existing.status === 200) return
  }
  expect(registered.status, `${registered.body}\n\nserver log tail:\n${serverLog.split("\n").slice(-40).join("\n")}`).toBe(200)
}

type WorkspaceConnection = {
  relayUrl: string
  runtimeAccessToken: string
  access?: string
  backing?: string
  workspaceId?: string
}

async function readSignedWorkspaceConnection(page: Page) {
  return await page.evaluate(async (input: { backendUrl: string; workspaceId: string }) => {
    const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule).getAuthToken({ template: "convex" })
    const res = await fetch(`${input.backendUrl}/api/workspace/${input.workspaceId}/connection`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    return { status: res.status, body: await res.json().catch(() => null) }
  }, { backendUrl: BACKEND_URL, workspaceId })
}

async function signedWorkspaceConnection(page: Page) {
  const started = Date.now()
  let connection = await readSignedWorkspaceConnection(page)
  while (connection.status === 429 && Date.now() - started < 30_000) {
    const retryAfter = typeof connection.body?.error?.retryAfterMs === "number"
      ? connection.body.error.retryAfterMs
      : 1_000
    await new Promise((resolve) => setTimeout(resolve, Math.min(Math.max(retryAfter, 250), 5_000)))
    connection = await readSignedWorkspaceConnection(page)
  }
  expect(connection.status, JSON.stringify(connection.body)).toBe(200)
  expect(connection.body).toMatchObject({
    relayUrl: relay?.url,
    runtimeAccessToken: expect.any(String),
  })
  return connection.body as WorkspaceConnection
}

async function upsertVisibleSessionForRealAuth(page: Page, input: {
  sessionId: string
  title: string
}) {
  await page.evaluate(async (input: { workspaceId: string; sessionId: string; title: string }) => {
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
        title: input.title,
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
      }],
    })
    await client.close()
  }, { workspaceId, sessionId: input.sessionId, title: input.title })

  await expect.poll(async () => {
    return await page.evaluate(async (input: { backendUrl: string; workspaceId: string; sessionId: string }) => {
      const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule)
        .getAuthToken({ template: "convex" })
      const url = new URL(`${input.backendUrl}/api/control/session-list`)
      url.searchParams.set("scope", "project")
      url.searchParams.set("projectId", input.workspaceId)
      url.searchParams.set("limit", "10")
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          "x-opencode-directory": `workspace:${input.workspaceId}`,
        },
      })
      const body = await res.json().catch(() => null) as {
        items?: Array<{ sessionId?: string; id?: string; session_ref?: string }>
      } | null
      if (!res.ok) return { found: false, status: res.status, body }
      return {
        found: body?.items?.some((item) => item.sessionId === input.sessionId || item.id === input.sessionId) ?? false,
        status: res.status,
        body,
      }
    }, { backendUrl: BACKEND_URL, workspaceId, sessionId: input.sessionId })
  }, {
    timeout: 45_000,
    message: `session ${input.sessionId} should be visible through signed session-list`,
  }).toMatchObject({ found: true, status: 200 })
}

async function relayWorkspaceContent(connection: WorkspaceConnection, filePath: string) {
  const res = await fetch(`${connection.relayUrl}/workspaces/${workspaceId}/file/content?path=${encodeURIComponent(filePath)}`, {
    headers: { Authorization: `Bearer ${connection.runtimeAccessToken}` },
  })
  if (!res.ok) return ""
  const body = await res.json().catch(() => null) as { content?: string } | null
  return body?.content ?? ""
}

async function directWorkspaceRuntimeMessages(sessionId: string) {
  const res = await fetch(`${BACKEND_URL}/workspaces/${workspaceId}/session/${encodeURIComponent(sessionId)}/message?limit=80`)
  return {
    status: res.status,
    body: await res.json().catch(() => null),
  }
}

test.describe.serial("real Clerk and Convex signed auth", () => {
  test.beforeAll(async () => {
    test.setTimeout(120_000)
    await loadEnvFile(path.join(APP_DIR, ".env.local"))
    await loadEnvFile(path.join(SERVER_DIR, ".env.local"))
    const missing = realClerkPreflightMissing()
    test.skip(missing.length > 0, `real Clerk E2E requires: ${missing.join(", ")}`)
    await ensureClerkUser()
    await prepareWorkspace()
    await startRelay()
    await startServer()
    await verifyWorkspace()
  })

  test.afterAll(async () => {
    await stopServer()
    await relay?.close().catch(() => undefined)
    relay = undefined
    await fs.rm(workspaceDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => undefined)
    await fs.rm(fakeBinDir, { recursive: true, force: true }).catch(() => undefined)
  })

  test("browser session sends real Convex JWT through claxedo-server authority", async ({ page }) => {
    test.setTimeout(120_000)
    const hits: RequestHit[] = []
    const oldRuntimeHits: RequestHit[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      const hit = {
        method: request.method(),
        url: request.url(),
        authorization: request.headers().authorization,
      }
      if (url.pathname === "/global/event" || url.pathname === "/mcp") oldRuntimeHits.push(hit)
      if (!url.pathname.startsWith("/api/workspace")) return
      hits.push(hit)
    })

    openCodeRequests = []
    await signInWithClerkUi(page)

    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()
    const token = await realConvexToken(page)
    const payload = decodeJwtPayload(token!)
    expect(payload.aud).toBe("convex")
    expect(payload.iss).toBe(`https://${CLERK_FRONTEND_API}`)

    await registerWorkspaceForRealAuth(page)

    const listed = await page.evaluate(async (input: { backendUrl: string }) => {
      const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule).getAuthToken({ template: "convex" })
      const res = await fetch(`${input.backendUrl}/api/workspace?access=user-hosted`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }, { backendUrl: BACKEND_URL })
    expect(listed.status).toBe(200)
    expect((listed.body as { workspaces?: Array<{ workspace_id?: string }> }).workspaces)
      .toContainEqual(expect.objectContaining({ workspace_id: workspaceId }))

    const connection = await page.evaluate(async (input: { backendUrl: string; workspaceId: string }) => {
      const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule).getAuthToken({ template: "convex" })
      const res = await fetch(`${input.backendUrl}/api/workspace/${input.workspaceId}/connection`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: res.status, body: await res.json().catch(() => null) }
    }, { backendUrl: BACKEND_URL, workspaceId })
    expect(connection.status).toBe(200)
    expect(connection.body).toMatchObject({
      access: "user-hosted",
      backing: "local-worktree",
      workspaceId,
      relayUrl: relay?.url,
      runtimeAccessToken: expect.any(String),
    })
    const relayFile = await fetch(`${(connection.body as { relayUrl: string }).relayUrl}/workspaces/${workspaceId}/file/raw?path=real-auth-proof.txt`, {
      headers: {
        Authorization: `Bearer ${(connection.body as { runtimeAccessToken: string }).runtimeAccessToken}`,
      },
    })
    expect(relayFile.status).toBe(200)
    await expect(relayFile.text()).resolves.toBe("real Clerk and Convex auth\n")

    const directConvex = await directConvexWorkspaceState(page, workspaceId)
    expect(directConvex.enabled).toBe(true)
    expect(directConvex.ready).toBe(true)
    expect(directConvex.authenticated).toBe(true)
    expect(directConvex.user.user_id).toEqual(expect.any(String))
    expect(directConvex.workspaces).toContainEqual(expect.objectContaining({ workspace_id: workspaceId }))
    expect(directConvex.opened).toEqual(expect.objectContaining({
      allowed: true,
      workspace: expect.objectContaining({ workspace_id: workspaceId }),
    }))

    expect(hits.filter((item) => item.authorization?.startsWith("Bearer ")).length).toBeGreaterThanOrEqual(2)
    expect(oldRuntimeHits).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("browser reload resumes signed durable replay before live events", async ({ page }) => {
    test.setTimeout(120_000)
    const sessionId = `real-auth-replay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const replayText = "real Clerk Convex durable replay message"
    const sessionRequests: RequestHit[] = []
    const liveEventRequests: RequestHit[] = []
    const orderedReads: RequestHit[] = []
    const oldRuntimeHits: RequestHit[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      const hit = {
        method: request.method(),
        url: request.url(),
        authorization: request.headers().authorization,
      }
      if (url.pathname === "/global/event" || url.pathname === "/mcp") oldRuntimeHits.push(hit)
      const prefix = `/api/control/sessions/${sessionId}/`
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ""
      if (route === "messages" || route === "events" || route === "capabilities") {
        sessionRequests.push(hit)
        orderedReads.push(hit)
      }
      if (url.pathname === `/workspaces/${workspaceId}/global/event`) {
        liveEventRequests.push(hit)
        orderedReads.push(hit)
      }
    })

    openCodeRequests = []
    await signInWithClerkUi(page)
    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()
    await registerWorkspaceForRealAuth(page)

    await upsertVisibleSessionForRealAuth(page, {
      sessionId,
      title: "Real auth replay session",
    })
    const replay = await persistConversation(sessionId, replayText)

    const readReplayThenLive = async () => await page.evaluate(async (input: {
      backendUrl: string
      workspaceId: string
      sessionId: string
    }) => {
      const token = await (await import("/src/utils/auth-client.ts" as string) as BrowserAuthModule).getAuthToken({ template: "convex" })
      const sessionId = encodeURIComponent(input.sessionId)
      const workspaceId = encodeURIComponent(input.workspaceId)
      const messagesRes = await fetch(`${input.backendUrl}/api/control/sessions/${sessionId}/messages?workspaceId=${workspaceId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
      })
      const messages = await messagesRes.json().catch(() => null)
      const abort = new AbortController()
      const eventsRes = await fetch(`${input.backendUrl}/workspaces/${workspaceId}/global/event?sessionID=${sessionId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        signal: abort.signal,
      })
      const reader = eventsRes.body?.getReader()
      const first = reader ? await reader.read() : undefined
      abort.abort()
      return {
        messagesStatus: messagesRes.status,
        eventsStatus: eventsRes.status,
        messages,
        firstEventChunk: first?.value ? new TextDecoder().decode(first.value) : "",
      }
    }, { backendUrl: BACKEND_URL, workspaceId, sessionId })

    const firstRead = await readReplayThenLive()
    expect(firstRead.messagesStatus).toBe(200)
    expect(firstRead.eventsStatus).toBe(200)
    expect(firstRead.messages).toMatchObject({
      messages: [{
        info: {
          id: replay.messageId,
          sessionID: sessionId,
          role: "user",
        },
        parts: [{
          id: replay.partId,
          messageID: replay.messageId,
          type: "text",
          text: replayText,
        }],
      }],
    })
    expect(firstRead.firstEventChunk).toContain("server.connected")
    await expect.poll(
      () => sessionRequests.some((item) => new URL(item.url).pathname.endsWith("/messages")),
      { timeout: 30_000 },
    ).toBe(true)
    await expect.poll(() => liveEventRequests.length).toBeGreaterThan(0)
    expect(orderedReads.findIndex((item) => new URL(item.url).pathname.endsWith("/messages")))
      .toBeLessThan(orderedReads.findIndex((item) => new URL(item.url).pathname.endsWith("/global/event")))

    const messagesBeforeReload = sessionRequests.filter((item) => new URL(item.url).pathname.endsWith("/messages")).length
    const eventsBeforeReload = liveEventRequests.length
    await page.reload()
    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()
    const secondRead = await readReplayThenLive()
    expect(secondRead.messagesStatus).toBe(200)
    expect(secondRead.eventsStatus).toBe(200)
    expect(JSON.stringify(secondRead.messages)).toContain(replayText)
    expect(secondRead.firstEventChunk).toContain("server.connected")
    await expect.poll(() =>
      sessionRequests.filter((item) => new URL(item.url).pathname.endsWith("/messages")).length,
    ).toBeGreaterThan(messagesBeforeReload)
    await expect.poll(() =>
      liveEventRequests.length,
    ).toBeGreaterThan(eventsBeforeReload)

    expect(sessionRequests.filter((item) => new URL(item.url).pathname.endsWith("/messages")).map((item) => item.authorization))
      .toContainEqual(expect.stringMatching(/^Bearer /))
    expect(liveEventRequests.map((item) => item.authorization))
      .toContainEqual(expect.stringMatching(/^Bearer /))
    expect(oldRuntimeHits).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("browser UI resumes signed workspace session replay after reload", async ({ page }) => {
    test.setTimeout(120_000)
    await wireLocalBackend(page)
    const sessionId = `real-auth-ui-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const replayText = "real Clerk Convex UI replay message"
    const sessionRequests: RequestHit[] = []
    const oldRuntimeHits: RequestHit[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      const hit = {
        method: request.method(),
        url: request.url(),
        authorization: request.headers().authorization,
      }
      if (url.pathname === "/global/event" || url.pathname === "/mcp") oldRuntimeHits.push(hit)
      const prefix = `/api/control/sessions/${sessionId}/`
      const route = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : ""
      if (route === "messages" || route === "events" || route === "capabilities") {
        sessionRequests.push(hit)
      }
      if (url.pathname === `/workspaces/${workspaceId}/session/${sessionId}/message`) {
        sessionRequests.push(hit)
      }
    })

    openCodeRequests = []
    await signInWithClerkUi(page)
    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()
    await registerWorkspaceForRealAuth(page)

    await upsertVisibleSessionForRealAuth(page, {
      sessionId,
      title: "Real auth UI replay session",
    })
    await persistConversation(sessionId, replayText)
    await expect.poll(async () => JSON.stringify(await directWorkspaceRuntimeMessages(sessionId)), {
      timeout: 30_000,
      message: "seeded runtime journal messages should be readable from backend workspace-runtime",
    }).toContain(replayText)

    await page.goto(`/${slug(`workspace:${workspaceId}`)}/session/${sessionId}`)
    const messageReads = () => sessionRequests.filter((item) => {
      const url = new URL(item.url)
      return url.pathname.endsWith("/messages") || url.pathname.endsWith(`/session/${sessionId}/message`)
    })
    await expect.poll(
      () => messageReads().length > 0,
      { timeout: 30_000 },
    ).toBe(true)
    expect(messageReads().map((item) => item.authorization))
      .toContainEqual(expect.stringMatching(/^Bearer /))
    await expect(page.getByText(replayText)).toBeVisible({ timeout: 30_000 })

    const messagesBeforeReload = messageReads().length
    await page.reload()
    await expect(page.getByText(replayText)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() =>
      messageReads().length,
    ).toBeGreaterThan(messagesBeforeReload)

    expect(oldRuntimeHits).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("browser UI starts a Claude terminal and records lifecycle state", async ({ page }) => {
    test.setTimeout(180_000)
    await wireLocalBackend(page)
    const ptyRequests: RequestHit[] = []
    const lifecycleRequests: RequestHit[] = []
    const oldRuntimeHits: RequestHit[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      const hit = {
        method: request.method(),
        url: request.url(),
        authorization: request.headers().authorization,
      }
      if (url.pathname === "/global/event" || url.pathname === "/mcp") oldRuntimeHits.push(hit)
      if (isPtyCreatePath(url.pathname)) ptyRequests.push(hit)
      if (url.pathname.endsWith("/api/claxedo/hook/agent-lifecycle")) lifecycleRequests.push(hit)
    })

    openCodeRequests = []
    await signInWithClerkUi(page)
    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()
    await registerWorkspaceForRealAuth(page)
    const sessionId = `real-auth-claude-terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await upsertVisibleSessionForRealAuth(page, {
      sessionId,
      title: "Real auth Claude terminal session",
    })
    await bindRuntimeSession(sessionId, "Real auth Claude terminal session")

    await page.goto(`/${slug(`workspace:${workspaceId}`)}/session/${sessionId}`)
    await page.evaluate((command) => {
      localStorage.setItem("claxedo.terminalCommands", JSON.stringify({
        claude: command,
        codex: "codex",
        custom: [],
      }))
    }, `"${path.join(fakeBinDir, "claude")}" --dangerously-skip-permissions`)
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    const ptyResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return isPtyCreatePath(url.pathname)
        && response.request().method() === "POST"
        && response.status() === 200
    }, { timeout: 60_000 })
    await page.getByRole("button", { name: /New Claude terminal/i }).first().click({ force: true })
    const pty = await (await ptyResponse).json() as { id?: string; title?: string }
    expect(pty.id).toMatch(/^pty_/)
    expect(pty.title).toContain("Claude")

    const postLifecycle = async (eventType: "Busy" | "Idle") => {
      const res = await fetch(`${runtimeHookUrl("agent-lifecycle")}?workspaceId=${encodeURIComponent(workspaceId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tabId: pty.id,
          terminalId: pty.id,
          workspaceId,
          provider: "claude",
          sessionId: "fake-claude-e2e-session",
          prompt: "hello from real auth terminal e2e",
          lastAssistantMessage: "fake claude lifecycle response",
          eventType,
        }),
      })
      expect(res.status, await res.text()).toBe(200)
    }
    await postLifecycle("Busy")
    await expect.poll(async () => {
      const res = await fetch(`${runtimeHookUrl("terminal-session")}?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(pty.id!)}`)
      const body = await res.json().catch(() => null) as { session?: { eventType?: string } } | null
      return body?.session?.eventType
    }, { timeout: 90_000 }).toBe("Busy")
    await expect(page.locator('[data-sidebar-status="working"]').first()).toBeVisible({ timeout: 15_000 })
    await postLifecycle("Idle")
    await expect.poll(async () => {
      const res = await fetch(`${runtimeHookUrl("terminal-session")}?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(pty.id!)}`)
      const body = await res.json().catch(() => null) as { session?: { eventType?: string; provider?: string; sessionId?: string; lastAssistantMessage?: string } } | null
      return body?.session
    }, { timeout: 90_000 }).toMatchObject({
      eventType: "Idle",
      provider: "claude",
      sessionId: "fake-claude-e2e-session",
      lastAssistantMessage: "fake claude lifecycle response",
    })

    expect(ptyRequests.length).toBeGreaterThanOrEqual(1)
    expect(lifecycleRequests).toEqual([])
    expect(oldRuntimeHits).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

  test("browser UI runs real Claude chat and records lifecycle state", async ({ page }) => {
    test.setTimeout(300_000)
    const marker = `CLAXEDO_REAL_CLAUDE_BROWSER_OK_${Date.now()}`
    const claudeCommand = await realClaudeCommand(`Reply exactly ${marker}. Do not include any other words.`).catch(() => undefined)
    test.skip(!claudeCommand, "authenticated Claude CLI with an available model is required for real browser chat coverage")
    await wireLocalBackend(page)
    await installPtyFrameCapture(page)
    const ptyRequests: RequestHit[] = []
    const lifecycleRequests: RequestHit[] = []
    const oldRuntimeHits: RequestHit[] = []
    page.on("request", (request) => {
      const url = new URL(request.url())
      const hit = {
        method: request.method(),
        url: request.url(),
        authorization: request.headers().authorization,
      }
      if (url.pathname === "/global/event" || url.pathname === "/mcp") oldRuntimeHits.push(hit)
      if (isPtyCreatePath(url.pathname)) ptyRequests.push(hit)
      if (url.pathname.endsWith("/api/claxedo/hook/agent-lifecycle")) lifecycleRequests.push(hit)
    })

    openCodeRequests = []
    await signInWithClerkUi(page)
    await expect.poll(() => realConvexToken(page), { timeout: 30_000 }).not.toBeNull()
    await registerWorkspaceForRealAuth(page)
    const sessionId = `real-auth-real-claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await upsertVisibleSessionForRealAuth(page, {
      sessionId,
      title: "Real Claude browser chat session",
    })
    await bindRuntimeSession(sessionId, "Real Claude browser chat session")

    await page.goto(`/${slug(`workspace:${workspaceId}`)}/session/${sessionId}`)
    await page.evaluate((command) => {
      localStorage.setItem("claxedo.terminalCommands", JSON.stringify({
        claude: command,
        codex: "codex",
        custom: [],
      }))
    }, claudeCommand)
    await expect(page.locator("[data-claxedo]")).toBeVisible({ timeout: 30_000 })

    const ptyResponse = page.waitForResponse((response) => {
      const url = new URL(response.url())
      return isPtyCreatePath(url.pathname)
        && response.request().method() === "POST"
        && response.status() === 200
    }, { timeout: 60_000 })
    await page.getByRole("button", { name: /New Claude terminal/i }).first().click({ force: true })
    const pty = await (await ptyResponse).json() as { id?: string; title?: string }
    expect(pty.id).toMatch(/^pty_/)
    expect(pty.title).toContain("Claude")

    const terminalOutput = async () => {
      const frames = await page.evaluate(() =>
        ((window as unknown as Record<string, string[]>).__claxedoPtyFrames ?? []).join(""),
      )
      if (frames.includes(marker)) return frames
      const url = new URL(`${BACKEND_URL}/api/claxedo/process/logs`)
      url.searchParams.set("terminal_id", pty.id!)
      url.searchParams.set("workspaceId", workspaceId)
      url.searchParams.set("lines", "120")
      const logs = await fetch(url).then((res) => res.ok ? res.text() : "").catch(() => "")
      return `${frames}\n${logs}`
    }

    await expect.poll(terminalOutput, { timeout: 180_000 }).toContain(marker)

    await expect.poll(async () => {
      const res = await fetch(`${runtimeHookUrl("terminal-session")}?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(pty.id!)}`)
      const body = await res.json().catch(() => null) as { session?: { eventType?: string; provider?: string; prompt?: string; lastAssistantMessage?: string } } | null
      return body?.session
    }, { timeout: 120_000 }).toMatchObject({
      eventType: "Idle",
      provider: "claude",
    })
    await expect.poll(async () => {
      const res = await fetch(`${runtimeHookUrl("terminal-session")}?workspaceId=${encodeURIComponent(workspaceId)}&terminalId=${encodeURIComponent(pty.id!)}`)
      const body = await res.json().catch(() => null) as { session?: { prompt?: string; lastAssistantMessage?: string } } | null
      return `${body?.session?.prompt ?? ""}\n${body?.session?.lastAssistantMessage ?? ""}`
    }, { timeout: 30_000 }).toContain(marker)

    expect(ptyRequests.length).toBeGreaterThanOrEqual(1)
    expect(lifecycleRequests).toEqual([])
    expect(oldRuntimeHits).toEqual([])
    expect(openCodeRequests).toEqual([])
  })

})
