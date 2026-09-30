import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PI_LAUNCH_PROVIDERS, piCredentialProviderIDs } from "@claxedo/agent-runtime-contract"
import { piEnvironment, piMcpServerConfig, piProjectionArgs, preparePiProfile, selectPiProfile, type PiProfileOptions } from "./index"

const credentials = { machineLoginAllowed: true, accountOwner: "fixture-owner", providers: {}, secrets: {}, leaseGeneration: "g1" }
const brokeredOnly = { ...credentials, machineLoginAllowed: false }

test.each([...PI_LAUNCH_PROVIDERS])("projects the canonical URL for connected Pi provider %s", async (provider) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-provider-overlay-"))
  try {
    const profile = selectPiProfile({ ...credentials, providers: {
      [piCredentialProviderIDs(provider)[0]!]: {
        baseUrl: "https://broker.test", apiPath: "/selected/provider/api", placeholder: "member-account", authMode: "api-key",
      },
    } }, root, "session", { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
      stateRoot: path.join(root, "state"), ownerAgentDir: path.join(root, "owner") })
    await preparePiProfile(profile, { providerID: "pi", modelID: `${provider}/model` })
    expect(JSON.parse(await fs.readFile(path.join(profile.agentDir, "models.json"), "utf8"))).toEqual({
      providers: { [provider]: { baseUrl: "https://broker.test/selected/provider/api", apiKey: "member-account" } },
    })
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

describe("Pi profile selection", () => {
  test("keeps the owner's files unchanged and isolates brokered credentials", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-profile-"))
    try {
      const ownerAgentDir = path.join(root, "own")
      const options: PiProfileOptions = { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
        stateRoot: path.join(root, "state"), ownerAgentDir }
      await fs.mkdir(ownerAgentDir)
      const auth = path.join(ownerAgentDir, "auth.json")
      const original = Buffer.from('{"owner":"login"}\n')
      await fs.writeFile(auth, original)
      const own = selectPiProfile(credentials, root, "owner-session", options)
      await preparePiProfile(own)
      expect(await fs.readFile(auth)).toEqual(original)
      expect(own.agentDir).toBe(ownerAgentDir)
      const remote = selectPiProfile(brokeredOnly, root, "member-session", options)
      expect(remote.kind).toBe("brokered")
      expect(remote.agentDir).not.toBe(own.agentDir)
      await preparePiProfile(remote)
      expect(await fs.readFile(path.join(remote.agentDir, "models.json"), "utf8")).toBe('{"providers":{}}')
      const env = piEnvironment(remote, { OPENAI_API_KEY: "owner-secret", HOME: root })
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.PI_CODING_AGENT_DIR).toBe(remote.agentDir)
      expect(await fs.readFile(auth)).toEqual(original)
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  test("selects a profile from the session owner's machine-login permission", () => {
    const options: PiProfileOptions = { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true, stateRoot: "/tmp/pi-test", ownerAgentDir: "/tmp/pi-agent" }
    expect(selectPiProfile(credentials, "/work", "owner-session", options).kind).toBe("owner-login")
    expect(selectPiProfile(brokeredOnly, "/work", "member-session", options).kind).toBe("brokered")
    expect(selectPiProfile(brokeredOnly, "/work", "member-session", options, "owner-login").kind).toBe("brokered")
  })

  test("the machine owner's stored Claxedo account wins over its own Pi login", () => {
    const options: PiProfileOptions = { placement: "desktop", machineOwnerUserId: "", canUseOwnLogin: true, stateRoot: "/tmp/pi-test", ownerAgentDir: "/tmp/pi-agent" }
    const stored = { ...credentials, providers: { openai: { baseUrl: "http://127.0.0.1:1/v1", placeholder: "stored", authMode: "api-key" as const } } }
    expect(selectPiProfile(stored, "/work", "stored-session", options).kind).toBe("brokered")
    expect(selectPiProfile(credentials, "/work", "login-session", options).kind).toBe("owner-login")
    expect(selectPiProfile(stored, "/work", "kept-session", options, "owner-login").kind).toBe("owner-login")
  })

  test("isolates concurrent member overlays within one workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-concurrent-profiles-"))
    try {
      const options: PiProfileOptions = { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
        stateRoot: path.join(root, "state"), ownerAgentDir: path.join(root, "owner") }
      const first = selectPiProfile({ ...credentials, providers: { openai: {
        baseUrl: "http://127.0.0.1:1001", placeholder: "first-member", authMode: "api-key",
      } } }, root, "session-one", options)
      const second = selectPiProfile({ ...credentials, providers: { openai: {
        baseUrl: "http://127.0.0.1:1002", placeholder: "second-member", authMode: "api-key",
      } } }, root, "session-two", options)
      await Promise.all([preparePiProfile(first), preparePiProfile(second)])
      expect(first.agentDir).not.toBe(second.agentDir)
      expect(await fs.readFile(path.join(first.agentDir, "models.json"), "utf8")).toContain("first-member")
      expect(await fs.readFile(path.join(second.agentDir, "models.json"), "utf8")).toContain("second-member")
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  test("adds a Pi package with -e", () => {
    const projection = { generation: "g1", pluginRoots: [{ pluginInstanceId: "plugin", root: "/tmp/pi-extension", skillNames: [], dataRoot: "/tmp/pi-data" }],
      mcpServers: [], notApplied: [] }
    expect(piProjectionArgs(projection)).toEqual(["-e", "/tmp/pi-extension"])
  })

  test("an MCP server takes Pi's mcp.json shape, declared to the model, with every header and env value kept literal", () => {
    expect(piMcpServerConfig({ kind: "http", name: "docs", url: "https://example.test/mcp", headers: { authorization: "Bearer $TOKEN", "x-run": "!echo hi" } }))
      .toEqual({ type: "http", url: "https://example.test/mcp", headers: { authorization: "Bearer $$TOKEN", "x-run": "$!echo hi" }, exposure: "direct" })
    expect(piMcpServerConfig({ kind: "stdio", name: "local", command: "node", args: ["server.js"], env: { KEY: "${HOME}" }, cwd: "/work" }))
      .toEqual({ type: "stdio", command: "node", args: ["server.js"], env: { KEY: "$${HOME}" }, cwd: "/work", exposure: "direct" })
    expect(() => piMcpServerConfig({ kind: "sse", name: "old", url: "https://example.test/sse" })).toThrow("Pi cannot load SSE MCP server old")
  })
})
