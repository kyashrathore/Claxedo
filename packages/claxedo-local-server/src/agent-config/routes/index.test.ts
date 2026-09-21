import { afterAll, afterEach, expect, test, vi } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { execFileSync } from "child_process"
import { sandboxFetch } from "@claxedo/server-core/workspace/http/sandbox-target-fetch"

const root = path.join(os.tmpdir(), `agent-config-snapshot-${randomUUID().slice(0, 8)}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

vi.mock("@claxedo/server-core/workspace/http/sandbox-target-fetch", () => ({ sandboxFetch: vi.fn() }))

const [{ createAgentConfigRoutes }, { configureAgentConfig, disposeAgentConfig }, { resolveWorkspace }] = await Promise.all([
  import("./index"),
  import("@claxedo/server-core/agent-config/index"),
  import("@claxedo/server-core/workspace/store/index"),
])

afterEach(async () => {
  vi.clearAllMocks()
  disposeAgentConfig()
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

/**
 * The runtime snapshot carries broker placeholders — bearer authority over the
 * operator's stored credentials for the next hour. The runtime receives them
 * over its own management channel; this route is the config surface a page
 * reads, and it has no reason to hand them to anything that can call it.
 */
test("the agent-config snapshot route serves the snapshot with its auth map removed", async () => {
  // The composition's broker projects nothing for a call that names no
  // workspace, and this route names none; only a fake can put a placeholder
  // into the snapshot this route strips.
  const projectAuth = vi.fn(async () => ({
    "claude-sdk": {
      baseUrl: "http://127.0.0.1:2595/bindings/b1",
      placeholder: "placeholder-that-must-not-travel",
      authMode: "bearer" as const,
      expiresAt: Date.now() + 60 * 60 * 1000,
    },
  }))
  configureAgentConfig({ projectAuth })

  const response = await createAgentConfigRoutes().request("http://localhost/")
  const body = await response.text()

  expect(response.status).toBe(200)
  expect(projectAuth).toHaveBeenCalledTimes(1)
  expect(JSON.parse(body)).toEqual({ version: 4, mcp: {}, connections: [] })
  expect(body).not.toContain("placeholder-that-must-not-travel")
})

/**
 * The discovery read is not a provisioning path. `?directory=` scopes the
 * lookup; only the explicit create flag the app passes through
 * `/api/claxedo/workspace/resolve` may register one. A GET that names an
 * unregistered directory must leave the store untouched and never reach the
 * sandbox fetch — reaching it is what used to start a runtime for any
 * caller-named path.
 */
test("the agents discovery GET resolves read-only and never creates a workspace", async () => {
  await fs.mkdir(root, { recursive: true })
  const directory = await fs.realpath(await fs.mkdtemp(path.join(root, "agents-discovery-")))
  execFileSync("git", ["init", "-b", "main"], { cwd: directory, stdio: "ignore" })
  const scoped = `http://localhost/agents?directory=${encodeURIComponent(directory)}`
  const routes = createAgentConfigRoutes()

  const unknown = await routes.request(scoped)
  expect(unknown.status).toBe(200)
  expect(await unknown.json()).toEqual([])
  expect(sandboxFetch).not.toHaveBeenCalled()
  expect(await resolveWorkspace({ directory })).toBeUndefined()

  const created = await resolveWorkspace({ directory, create: true })
  expect(created).toBeDefined()

  vi.mocked(sandboxFetch).mockResolvedValueOnce(Response.json([{ name: "build" }]))
  const listed = await routes.request(scoped)
  expect(listed.status).toBe(200)
  expect(await listed.json()).toEqual([{ name: "build" }])
  expect(vi.mocked(sandboxFetch).mock.calls[0]?.[0]?.id).toBe(created?.id)
})
