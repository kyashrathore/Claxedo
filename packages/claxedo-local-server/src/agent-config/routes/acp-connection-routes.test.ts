import { afterAll, afterEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(os.tmpdir(), `agent-config-acp-${randomUUID().slice(0, 8)}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const [{ agentConfigAcpConnectionRoutes }, { loadUserConfig, saveUserConfig }] = await Promise.all([
  import("./acp-connection-routes"),
  import("@claxedo/server-core/agent-config/index"),
])

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

function app() {
  return agentConfigAcpConnectionRoutes()
}

async function upsert(routes: ReturnType<typeof app>, id: string, body: unknown) {
  return routes.request(`/harness/acp-connections/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("operator ACP connection config API", () => {
  test("adds connections through one trusted mutation and serves sanitized discovery rows", async () => {
    const routes = app()
    const first = await upsert(routes, "gemini", {
      label: "Gemini",
      command: ["gemini", "--acp"],
      env: { GEMINI_API_KEY: "secret-key" },
    })
    expect(first.status).toBe(200)
    const second = await upsert(routes, "hermes", { label: "Hermes", command: ["hermes", "acp"], enabled: false })
    expect(second.status).toBe(200)

    const listed = await routes.request("/harness/acp-connections")
    expect(listed.status).toBe(200)
    const body = await listed.json() as { connections: unknown[] }
    expect(body.connections).toEqual([
      { key: "acp:gemini", id: "gemini", label: "Gemini", access: "acp", enabled: true },
      { key: "acp:hermes", id: "hermes", label: "Hermes", access: "acp", enabled: false },
    ])
    // Discovery never exposes commands or environment values.
    expect(JSON.stringify(body)).not.toContain("secret-key")
    expect(JSON.stringify(body)).not.toContain("--acp")

    const config = await loadUserConfig()
    expect(config.acp?.gemini).toEqual({
      label: "Gemini",
      command: ["gemini", "--acp"],
      env: { GEMINI_API_KEY: "secret-key" },
    })
  })

  test("a malformed mutation rejects whole and leaves the accepted config untouched", async () => {
    const routes = app()
    await upsert(routes, "gemini", { label: "Gemini", command: ["gemini", "--acp"] })

    const rejected = await upsert(routes, "broken", { label: "", command: [] })
    expect(rejected.status).toBe(400)
    const body = await rejected.json() as { problems?: Array<{ id: string }> }
    expect(body.problems?.length).toBeGreaterThan(0)

    const config = await loadUserConfig()
    expect(Object.keys(config.acp ?? {})).toEqual(["gemini"])
  })

  test("removal deletes the entry and unrelated config fields survive ACP mutations", async () => {
    await fs.mkdir(root, { recursive: true })
    await saveUserConfig({
      mcp: { docs: { type: "stdio", command: "docs-mcp" } },
      auth: { anthropic: "sk-ant-keep" },
    })
    const routes = app()
    await upsert(routes, "gemini", { label: "Gemini", command: ["gemini"] })

    const removedMissing = await routes.request("/harness/acp-connections/absent", { method: "DELETE" })
    expect(removedMissing.status).toBe(404)

    const removed = await routes.request("/harness/acp-connections/gemini", { method: "DELETE" })
    expect(removed.status).toBe(200)

    const config = await loadUserConfig()
    expect(config.acp).toBeUndefined()
    expect(config.mcp.docs).toEqual({ type: "stdio", command: "docs-mcp" })
    expect(config.auth).toEqual({ anthropic: "sk-ant-keep" })
  })
})
