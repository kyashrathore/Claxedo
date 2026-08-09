/**
 * SPEC: Empty inventory import recovery
 *
 * PURPOSE — A transient harness-list failure must not permanently hide the
 * user's existing sessions after workspace-runtime starts.
 *
 * STATE MODEL — `session_inventory_import` is the durable once-per-directory
 * marker in the real SQLite store. A non-2xx upstream response produces an
 * empty first list but no marker; after the upstream recovers, the second list
 * imports the real session and writes exactly one marker.
 *
 * ANATOMY — This server regression has no DOM. It drives generic
 * `GET /session` against a real workspace-runtime and probes the real SQLite
 * marker; the controllable HTTP service occupies the external OpenCode seam.
 *
 * BEHAVIORS — 1. Two failed inventory attempts yield an empty list. 2. No
 * import marker is written. 3. Recovery makes the second generic list expose
 * the upstream session. 4. Successful import writes exactly one marker.
 *
 * INVARIANTS — Empty is an answer only for a successful response; a failed
 * read remains retryable; the marker is never synthesized by the test.
 *
 * HARNESS NOTES — The only controlled component is the external OpenCode HTTP
 * endpoint; workspace-runtime, routing, and persistence are real.
 *
 * OUT OF SCOPE — UI rendering and non-OpenCode harness discovery.
 */
import { expect, test } from "@playwright/test"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { createServer as createHttpServer, type Server } from "node:http"
import { createServer as createPortProbe } from "node:net"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const TIER_REAL = process.env.CLAXEDO_TIER_REAL_E2E === "1"
const APP_DIR = path.resolve(import.meta.dirname, "../..")
const RUNTIME_DIR = path.resolve(APP_DIR, "../workspace-runtime")

let runtime: ChildProcess | undefined
let upstream: Server | undefined
let runtimeLog = ""
let root = ""
let directory = ""
let storeDir = ""
let runtimeUrl = ""
let healthy = false

async function availablePort() {
  const probe = createPortProbe()
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", resolve)
  })
  const address = probe.address()
  if (!address || typeof address === "string") throw new Error("could not reserve a Tier R port")
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return address.port
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (await fetch(`${runtimeUrl}/api/wr/health`, { signal: AbortSignal.timeout(3_000) })
      .then((response) => response.ok)
      .catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`GATING: inventory runtime did not boot. Log tail:\n${runtimeLog.split("\n").slice(-80).join("\n")}`)
}

async function listIds() {
  const response = await fetch(`${runtimeUrl}/session?directory=${encodeURIComponent(directory)}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json() as Array<{ id: string }>).map((session) => session.id)
}

async function importMarkerCount() {
  const script = [
    'import Database from "better-sqlite3"',
    "const [file, directory] = process.argv.slice(1)",
    "const db = new Database(file, { readonly: true })",
    'const row = db.prepare("SELECT count(*) AS count FROM session_inventory_import WHERE directory = ?").get(directory)',
    "console.log(row.count)",
    "db.close()",
  ].join(";")
  const result = await execFileAsync("node", ["--input-type=module", "-e", script, path.join(storeDir, "state.db"), directory], {
    cwd: RUNTIME_DIR,
  })
  const count = Number.parseInt(result.stdout.replace(/\x1b\[[0-9;]*m/g, "").trim(), 10)
  if (!Number.isInteger(count)) {
    throw new Error(`inventory marker probe returned no count; stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`)
  }
  return count
}

test.describe("empty inventory import recovery @core @tier-real @surface-web", () => {
  test.skip(!TIER_REAL, "Tier R requires CLAXEDO_TIER_REAL_E2E=1")

  test.beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-empty-import-"))
    directory = await fs.mkdtemp(path.join(root, "workspace-"))
    storeDir = path.join(root, "store")

    const upstreamPort = await availablePort()
    upstream = createHttpServer((request, response) => {
      if (request.url?.split("?")[0] !== "/session" || request.method !== "GET") {
        response.writeHead(404).end("Not Found")
        return
      }
      if (!healthy) {
        response.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "restarting" }))
        return
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify([{
        id: "ses_recovered_after_503",
        title: "Present before import",
        slug: "ses_recovered_after_503",
        version: "test",
        directory,
        time: { created: 1, updated: 2 },
      }]))
    })
    await new Promise<void>((resolve, reject) => {
      upstream!.once("error", reject)
      upstream!.listen(upstreamPort, "127.0.0.1", resolve)
    })

    const runtimePort = await availablePort()
    runtimeUrl = `http://127.0.0.1:${runtimePort}`
    runtime = spawn("node", ["--import", "./src/text-imports.mjs", "--import", "tsx", "src/cli.ts"], {
      cwd: RUNTIME_DIR,
      env: {
        ...process.env,
        OPENCODE_URL: `http://127.0.0.1:${upstreamPort}`,
        WORKSPACE_RUNTIME_PORT: String(runtimePort),
        WORKSPACE_RUNTIME_DIRECTORY: directory,
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_tier_real_empty_import",
        WORKSPACE_RUNTIME_STORE_DIR: storeDir,
        WORKSPACE_RUNTIME_RUNNER: "opencode",
        WORKSPACE_RUNTIME_OPENCODE_COMPAT: "1",
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
    if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()))
    if (root) await fs.rm(root, { recursive: true, force: true })
  })

  test("retries after a non-2xx and records completion only after recovery", async () => {
    expect(await listIds()).toEqual([])
    expect(await importMarkerCount()).toBe(0)

    healthy = true
    expect(await listIds()).toEqual(["ses_recovered_after_503"])
    expect(await importMarkerCount()).toBe(1)
  })
})
