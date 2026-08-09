/**
 * SPEC: Session directory isolation
 *
 * PURPOSE — Keep a caller-supplied session id owned by its original workspace
 * directory so an authenticated peer cannot move or hijack future routing.
 *
 * STATE MODEL — The real workspace-runtime SQLite store is authoritative for
 * session placement. A session created in directory A remains there. A caller
 * attempting to create that id in directory B receives 409 before the harness
 * is asked to bind it; harness-discovered relocation is deliberately out of
 * scope and remains allowed.
 *
 * ANATOMY — This server regression has no DOM. Its public contract is
 * `POST /session`, generic `GET /session`, and `GET /session/:id`, each scoped
 * by the `directory` query. Two actual git worktrees share one runtime/store.
 *
 * BEHAVIORS — 1. Create an explicit id in A. 2. Lists show it only in A.
 * 3. Reusing the id in B returns 409 and changes neither inventory. 4. A later
 * lookup carrying B still resolves the canonical A-owned session.
 *
 * INVARIANTS — Caller input never changes placement; rejection precedes
 * harness creation; failure leaves both inventories and routing unchanged.
 *
 * HARNESS NOTES — Pi is the real harness used because it honors explicit
 * session ids; the placement contract itself is harness-independent.
 *
 * OUT OF SCOPE — Harness-reported discovery relocation and renderer behavior.
 */
import { expect, test } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer } from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const RUNTIME_DIR = path.resolve(APP_DIR, "../workspace-runtime")

let server: ChildProcess | undefined
let serverLog = ""
let serverUrl = ""
let root = ""
let workspaceA = ""
let workspaceB = ""

async function availablePort() {
  const probe = createServer()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a Tier R server port")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await fetch(`${url}/api/wr/health`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`GATING: session-isolation server did not boot. Log tail:\n${serverLog.split("\n").slice(-80).join("\n")}`)
}

async function gitWorkspace(name: string) {
  const directory = await fs.mkdtemp(path.join(root, `${name}-`))
  await execFileAsync("git", ["init"], { cwd: directory })
  await fs.writeFile(path.join(directory, "README.md"), `${name}\n`)
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "add", "-A"], { cwd: directory })
  await execFileAsync("git", ["-c", "user.email=e2e@test.com", "-c", "user.name=e2e", "commit", "-m", "init"], { cwd: directory })
  return directory
}

async function sessionIds(directory: string) {
  const response = await fetch(`${serverUrl}/session?directory=${encodeURIComponent(directory)}&harness=pi`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json() as Array<{ id: string }>).map((session) => session.id)
}

async function runtimeWorktree(directory: string) {
  const response = await fetch(
    `${serverUrl}/api/wr/worktrees?directory=${encodeURIComponent(directory)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "ses_tier_real_second_workspace" }),
    },
  )
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json() as { worktree: { path: string } }).worktree.path
}

test.describe("session directory isolation @core @tier-real @surface-web", () => {
  test.skip(!TIER_REAL, "Tier R requires CLAXEDO_TIER_REAL_E2E=1")

  test.beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-session-isolation-"))
    const dataDir = path.join(root, "data")
    const port = await availablePort()
    serverUrl = `http://127.0.0.1:${port}`
    workspaceA = await gitWorkspace("workspace-a")
    server = spawn("node", ["--import", "./src/text-imports.mjs", "--import", "tsx", "src/cli.ts"], {
      cwd: RUNTIME_DIR,
      env: {
        ...process.env,
        WORKSPACE_RUNTIME_PORT: String(port),
        WORKSPACE_RUNTIME_DIRECTORY: workspaceA,
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_tier_real_directory_isolation",
        WORKSPACE_RUNTIME_STORE_DIR: path.join(dataDir, "store"),
        WORKSPACE_RUNTIME_WORKSPACES_DIR: path.join(dataDir, "workspaces"),
        WORKSPACE_RUNTIME_RUNNER: "pi",
        WORKSPACE_RUNTIME_OPENCODE_COMPAT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    server.stdout?.on("data", (chunk) => (serverLog += chunk.toString()))
    server.stderr?.on("data", (chunk) => (serverLog += chunk.toString()))
    await waitForHealth(serverUrl)
    workspaceB = await runtimeWorktree(workspaceA)
  })

  test.afterAll(async () => {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM")
      await Promise.race([
        new Promise<void>((resolve) => server?.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ])
      if (server.exitCode === null) server.kill("SIGKILL")
    }
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  test("refuses a cross-directory id claim and preserves ownership and routing", async () => {
    const sessionId = "ses_tier_real_directory_owner"
    const create = await fetch(`${serverUrl}/session?directory=${encodeURIComponent(workspaceA)}&harness=pi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sessionId, title: "Owned by A" }),
    })
    expect(create.status, await create.clone().text()).toBe(201)
    expect(await sessionIds(workspaceA)).toContain(sessionId)
    expect(await sessionIds(workspaceB)).not.toContain(sessionId)

    const claim = await fetch(`${serverUrl}/session?directory=${encodeURIComponent(workspaceB)}&harness=pi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sessionId, title: "Claimed by B" }),
    })
    expect(claim.status, await claim.clone().text()).toBe(409)
    expect(await sessionIds(workspaceA)).toContain(sessionId)
    expect(await sessionIds(workspaceB)).not.toContain(sessionId)

    // Session-aware routing must still resolve the authoritative owner even
    // when the caller repeats the rejected directory in its query.
    const routed = await fetch(
      `${serverUrl}/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(workspaceB)}&harness=pi`,
    )
    expect(routed.status, await routed.clone().text()).toBe(200)
    expect(await routed.json()).toMatchObject({ id: sessionId, directory: workspaceA })
  })
})
