/**
 * SPEC: Spawned OpenCode prompt idle lease
 *
 * PURPOSE — Keep a healthy OpenCode child alive throughout a silent model or
 * tool interval, then reclaim it normally when the turn has finished.
 *
 * STATE MODEL — The shared process lifecycle owns one spawned child and a
 * reference-counted activity lease. The test injects a one-second idle grace;
 * a five-second real provider response holds the lease, completion releases
 * it, and the next grace expiry reaps that exact process generation.
 *
 * ANATOMY — This process/server regression has no DOM. It drives the real
 * workspace-runtime prompt route, installed `opencode serve` child, isolated
 * OpenCode data directories, process table, persisted messages, and the shared
 * scripted model HTTP seam.
 *
 * BEHAVIORS — 1. The configured provider reaches the spawned child. 2. A turn
 * stays alive for three grace periods while the provider is silent. 3. The
 * exact marker completes through the public session surface. 4. The same child
 * is reaped after the lease releases.
 *
 * INVARIANTS — The upstream must be called; survival targets the exact PID;
 * zombie state is not counted as alive; polling does not stand in for the
 * silent interval; the fix must not disable idle reaping.
 *
 * HARNESS NOTES — OpenCode configuration is inherited and merged at spawn;
 * the model endpoint is the only fake allowed in Tier R.
 *
 * OUT OF SCOPE — Renderer reply geometry, other harnesses, and long tool loops.
 */
import { expect, test } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { createServer as createPortProbe } from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import {
  opencodeScriptedProviderConfig,
  startScriptedModelServer,
  type ScriptedModelServer,
} from "../helpers/scripted-model-server"

const execFileAsync = promisify(execFile)
const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const RUNTIME_DIR = path.resolve(APP_DIR, "../workspace-runtime")
const IDLE_GRACE_MS = 1_000
const MODEL_STALL_MS = 5_000

let runtime: ChildProcess | undefined
let scripted: ScriptedModelServer | undefined
let runtimeLog = ""
let root = ""
let directory = ""
let runtimeUrl = ""

async function availablePort() {
  const probe = createPortProbe()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a Tier R runtime port")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}

async function waitForHealth() {
  await expect.poll(
    async () => fetch(`${runtimeUrl}/api/wr/health`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false),
    { timeout: 90_000, message: `runtime did not boot; log tail:\n${runtimeLog.split("\n").slice(-80).join("\n")}` },
  ).toBe(true)
}

async function descendantOpenCodePid() {
  if (!runtime?.pid) return undefined
  const result = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="])
  const rows = result.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3]! }] : []
  })
  const descendants = new Set([runtime.pid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (!descendants.has(row.ppid) || descendants.has(row.pid)) continue
      descendants.add(row.pid)
      changed = true
    }
  }
  return rows.find((row) => descendants.has(row.pid) && /opencode(?:\s|$).*serve/.test(row.command))?.pid
}

async function processAlive(pid: number) {
  const state = await execFileAsync("ps", ["-p", String(pid), "-o", "stat="])
    .then((result) => result.stdout.trim())
    .catch(() => "")
  return state.length > 0 && !state.startsWith("Z")
}

async function sessionMessages(sessionId: string) {
  const response = await fetch(
    `${runtimeUrl}/session/${encodeURIComponent(sessionId)}/message?directory=${encodeURIComponent(directory)}`,
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.text()
}

test.describe("OpenCode prompt idle lease @core @tier-real @surface-web", () => {
  test.skip(!TIER_REAL, "Tier R requires CLAXEDO_TIER_REAL_E2E=1")

  test.beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-idle-lease-"))
    directory = await fs.mkdtemp(path.join(root, "workspace-"))
    await execFileAsync("git", ["init"], { cwd: directory })
    await fs.writeFile(path.join(directory, "README.md"), "idle lease\n")
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: directory })
    await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: directory })

    scripted = await startScriptedModelServer()
    scripted.setReplyDelayMs(MODEL_STALL_MS)
    const port = await availablePort()
    runtimeUrl = `http://127.0.0.1:${port}`
    runtime = spawn("node", ["--import", "./src/text-imports.mjs", "--import", "tsx", "src/cli.ts"], {
      cwd: RUNTIME_DIR,
      env: {
        ...process.env,
        CLAXEDO_OC_IDLE_TIMEOUT_MS: String(IDLE_GRACE_MS),
        OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeScriptedProviderConfig(scripted.v1Url)),
        OPENCODE_DISABLE_MODELS_FETCH: "true",
        TIER_REAL_API_KEY: "test-key",
        XDG_CACHE_HOME: path.join(root, "xdg-cache"),
        XDG_CONFIG_HOME: path.join(root, "xdg-config"),
        XDG_DATA_HOME: path.join(root, "xdg-data"),
        WORKSPACE_RUNTIME_PORT: String(port),
        WORKSPACE_RUNTIME_DIRECTORY: directory,
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_tier_real_idle_lease",
        WORKSPACE_RUNTIME_STORE_DIR: path.join(root, "store"),
        WORKSPACE_RUNTIME_RUNNER: "opencode",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    runtime.stdout?.on("data", (chunk) => (runtimeLog += chunk.toString()))
    runtime.stderr?.on("data", (chunk) => (runtimeLog += chunk.toString()))
    await waitForHealth()
  })

  test.afterAll(async () => {
    if (runtime && runtime.exitCode === null) {
      runtime.kill("SIGTERM")
      await Promise.race([
        new Promise<void>((resolve) => runtime?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ])
      if (runtime.exitCode === null) runtime.kill("SIGKILL")
    }
    await scripted?.close()
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus && runtimeLog) {
      await testInfo.attach("workspace-runtime.log", { body: runtimeLog, contentType: "text/plain" })
    }
  })

  test("keeps a silent turn alive past grace, then reaps the child", async () => {
    const create = await fetch(`${runtimeUrl}/session?directory=${encodeURIComponent(directory)}&harness=opencode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Idle lease",
        model: { providerID: "tier-real", modelID: "scripted-model" },
      }),
    })
    expect(create.status, await create.clone().text()).toBe(201)
    const sessionId = (await create.json() as { id: string }).id
    const marker = "IDLE_LEASE_SURVIVED"
    const messageId = `msg_idle_lease_${randomUUID()}`

    const providerResponse = await fetch(`${runtimeUrl}/provider?directory=${encodeURIComponent(directory)}`)
    const providerText = await providerResponse.text()
    if (!providerResponse.ok || !providerText.includes("tier-real")) {
      throw new Error(`GATING: spawned OpenCode lost the scripted provider config (${providerResponse.status}): ${providerText}`)
    }

    const prompt = await fetch(
      `${runtimeUrl}/session/${encodeURIComponent(sessionId)}/prompt_async?directory=${encodeURIComponent(directory)}&harness=opencode`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageID: messageId,
          model: { providerID: "tier-real", modelID: "scripted-model" },
          agent: "build",
          parts: [{ type: "text", text: `Reply with exactly this one token: ${marker}` }],
        }),
      },
    )
    expect(prompt.status, await prompt.clone().text()).toBe(204)

    const modelDeadline = Date.now() + 20_000
    while (Date.now() < modelDeadline && scripted!.counts().chat === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (scripted!.counts().chat === 0) {
      throw new Error(
        `GATING: prompt never reached the scripted chat endpoint. messages=${await sessionMessages(sessionId)}\n` +
        `runtime log tail:\n${runtimeLog.split("\n").slice(-100).join("\n")}`,
      )
    }
    const childPid = await expect.poll(descendantOpenCodePid, { timeout: 10_000 }).toBeTruthy().then(() => descendantOpenCodePid())
    expect(childPid).toBeDefined()

    // The model has received the request and stays silent for five injected
    // grace periods. A missing activity lease reaps this exact PID here.
    await new Promise((resolve) => setTimeout(resolve, IDLE_GRACE_MS * 3))
    expect(await processAlive(childPid!)).toBe(true)

    await expect.poll(() => sessionMessages(sessionId), { timeout: 20_000 }).toContain(marker)

    // No polling request runs inside this interval. Once the turn releases its
    // lease, the same child must become eligible for the real idle reaper.
    await expect.poll(() => processAlive(childPid!), { timeout: 15_000 }).toBe(false)
  })
})
