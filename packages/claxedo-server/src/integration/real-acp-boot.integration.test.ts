import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { defined } from "../fixtures/assert-helpers"
import { realpathSync } from "fs"
import fs from "fs/promises"
import { existsSync } from "fs"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (!addr || typeof addr === "string") {
        srv.close()
        reject(new Error("failed to allocate port"))
        return
      }
      srv.close(() => resolve(addr.port))
    })
    srv.on("error", reject)
  })
}

const root = await fs.mkdtemp(path.join(realpathSync(os.tmpdir()), "claxedo-real-acp-"))
const home = path.join(root, "home")
const data = path.join(home, ".claxedo")

await fs.mkdir(path.join(data, "state"), { recursive: true })

const prev: Record<string, string | undefined> = {
  HOME: process.env.HOME,
  CLAXEDO_DATA_DIR: process.env.CLAXEDO_DATA_DIR,
  CLAXEDO_STATE_DIR: process.env.CLAXEDO_STATE_DIR,
  CLAXEDO_WORKGRAPH_REPOSITORY: process.env.CLAXEDO_WORKGRAPH_REPOSITORY,
  POSTHOG_KEY: process.env.POSTHOG_KEY,
  CLAXEDO_ACP_IDLE_TIMEOUT_MS: process.env.CLAXEDO_ACP_IDLE_TIMEOUT_MS,
  CLAXEDO_ACP_PROMPT_TIMEOUT_MS: process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS,
  CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS: process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS,
}

process.env.HOME = home
process.env.CLAXEDO_DATA_DIR = data
process.env.CLAXEDO_STATE_DIR = path.join(data, "state")
process.env.CLAXEDO_WORKGRAPH_REPOSITORY = path.resolve(import.meta.dirname, "../../../..")
process.env.POSTHOG_KEY = ""
process.env.CLAXEDO_ACP_IDLE_TIMEOUT_MS = "60000"
process.env.CLAXEDO_ACP_PROMPT_TIMEOUT_MS = "15000"
process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "1000"

const [serverMod, supervisor, store, agent, embedded] = await Promise.all([
  import("../deployments/local/server.js"),
  import("../workspace/supervisor/index.js"),
  import("../workspace/store/index.js"),
  import("../agent-config.js"),
  import("../deployments/local/embedded-workspace-runtime.js"),
])

const realBinary = path.resolve(__dirname, "../../workspace-runtime/node_modules/.bin/claude-agent-acp")

let upstreamPort = 0
let serverPort = 0
let upstream: Server
let server: ReturnType<typeof serverMod.startServer>

function startUpstreamMock(port: number) {
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`)
    if (url.pathname === "/global/event") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      })
      return
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end("{}")
  })
  srv.listen(port, "127.0.0.1")
  return srv
}

async function workspace(label: string) {
  const directory = path.join(root, "workspaces", `${label}-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  execFileSync("git", ["init", directory])
  execFileSync("git", ["-C", directory, "commit", "--allow-empty", "-m", "init"])
  return defined(await store.ensureWorkspace({
    workspaceId: `ws_${randomUUID()}`,
    directory,
  }))
}

function base() {
  return `http://127.0.0.1:${serverPort}`
}

function q(ws: { id: string; directory: string }) {
  return `workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}`
}

describe.skipIf(!existsSync(realBinary))("real claude ACP boot", () => {
  beforeAll(async () => {
    upstreamPort = await freePort()
    serverPort = await freePort()
    upstream = startUpstreamMock(upstreamPort)
    await new Promise<void>((resolve) => upstream.once("listening", resolve))
    server = serverMod.startServer(serverPort, `http://127.0.0.1:${upstreamPort}`)
  })

  beforeEach(async () => {
    embedded.shutdownEmbeddedWorkspaceRuntimes()
    await supervisor.shutdownWorkspaceSupervisor()
    await agent.saveUserConfig({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", binary: realBinary },
    })
  })

  afterAll(async () => {
    embedded.shutdownEmbeddedWorkspaceRuntimes()
    await supervisor.shutdownWorkspaceSupervisor()
    server?.close()
    upstream?.close()
    for (const [k, v] of Object.entries(prev)) {
      if (v !== undefined) (process.env as Record<string, string | undefined>)[k] = v
      else delete process.env[k]
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  })

  it("returns instead of hanging when session boot stalls", async () => {
    const ws = await workspace("real-acp")
    const out = await Promise.race([
      fetch(`${base()}/session?${q(ws)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Real ACP" }),
      }).then((res) => ({ kind: "http" as const, status: res.status })),
      new Promise<{ kind: "hung" }>((resolve) => setTimeout(() => resolve({ kind: "hung" }), 4000)),
    ])

    expect(out.kind).not.toBe("hung")
    if (out.kind === "http") expect([201, 500]).toContain(out.status)
  }, 15000)

  it("boots a real ACP session while runner options are probed", async () => {
    const ws = await workspace("real-acp-race")
    const prev = process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
    process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = "4000"

    try {
      const out = await Promise.race([
        Promise.all([
          fetch(`${base()}/session?${q(ws)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: "Real ACP race" }),
          }).then((res) => ({ status: res.status })),
          fetch(
            `${base()}/api/claxedo/agent-config/runner/options?workspaceId=${encodeURIComponent(ws.id)}&directory=${encodeURIComponent(ws.directory)}&type=claude-acp`,
          ).then((res) => ({ status: res.status })),
        ]),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 6000)),
      ])

      expect(out).not.toBe("hung")
      if (out === "hung") return
      expect(out[0].status).toBe(201)
      expect(out[1].status).toBe(200)
    } finally {
      if (prev === undefined) delete process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS
      else process.env.CLAXEDO_ACP_NEW_SESSION_TIMEOUT_MS = prev
    }
  }, 20000)
})
