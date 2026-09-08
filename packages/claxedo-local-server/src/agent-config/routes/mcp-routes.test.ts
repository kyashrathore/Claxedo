import { afterAll, beforeAll, describe, expect, test } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-mcp-routes-"))
const previousHome = process.env.HOME
const previousUserProfile = process.env.USERPROFILE
const previousCodexHome = process.env.CODEX_HOME
// `installHostedMcpEntry` resolves the user's home through `os.homedir()`,
// which reads these before anything else on both platforms.
process.env.HOME = home
process.env.USERPROFILE = home
process.env.CODEX_HOME = path.join(home, ".codex")

const { agentConfigMcpRoutes } = await import("./mcp-routes")

const app = agentConfigMcpRoutes()

beforeAll(() => {
  expect(os.homedir()).toBe(home)
})

afterAll(async () => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousUserProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousUserProfile
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = previousCodexHome
  await fs.rm(home, { recursive: true, force: true })
})

function install(body: unknown) {
  return app.request("/mcp-install", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("one-click hosted MCP install", () => {
  test("writes the hosted entry into every harness on this machine", async () => {
    const response = await install({ controlPlaneUrl: "https://api.claxedo.com" })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      url: "https://api.claxedo.com/api/claxedo/mcp",
      results: [
        { harness: "claude", state: "written" },
        { harness: "cursor", state: "written" },
        { harness: "codex", state: "written" },
      ],
    })
    const claude: unknown = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"))
    expect(claude).toMatchObject({
      mcpServers: { claxedo: { type: "http", url: "https://api.claxedo.com/api/claxedo/mcp" } },
    })
  })

  test("refuses the loopback endpoint rather than writing a URL nothing will admit", async () => {
    const response = await install({ controlPlaneUrl: "https://127.0.0.1:2593" })

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "agent_config_mcp_control_plane_invalid" },
    })
  })

  test("refuses a request that names no control plane", async () => {
    const response = await install({})

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: "agent_config_mcp_control_plane_required" },
    })
  })

  test("takes the entry back", async () => {
    const response = await app.request("/mcp-install", { method: "DELETE" })

    expect(response.status).toBe(200)
    const claude: unknown = JSON.parse(await fs.readFile(path.join(home, ".claude.json"), "utf8"))
    expect(claude).toEqual({ mcpServers: {} })
  })

  test("does not shadow the named-server route", async () => {
    const response = await app.request("/mcp/mcp-install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "remote" }),
    })

    expect(await response.json()).toMatchObject({ error: { code: "agent_config_mcp_url_required" } })
  })
})
