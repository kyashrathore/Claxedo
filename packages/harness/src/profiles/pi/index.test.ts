import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CredentialSelectionError } from "../../registry/credentials"
import { piEnvironment, piProjectionArgs, preparePiProfile, selectPiProfile, type PiProfileOptions } from "./index"

const credentials = { providers: {}, secrets: {}, leaseGeneration: "g1" }
const owner = { actor: { kind: "machine-owner" as const }, via: "loopback" as const, reissued: false }
const member = { actor: { kind: "person" as const, userId: "member" }, via: "relay" as const, reissued: false }

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
      const own = selectPiProfile(owner, credentials, root, "owner-session", options)
      await preparePiProfile(own)
      expect(await fs.readFile(auth)).toEqual(original)
      expect(own.agentDir).toBe(ownerAgentDir)
      const remote = selectPiProfile(member, credentials, root, "member-session", options)
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

  test("rejects mismatched and reissued origins", () => {
    const options: PiProfileOptions = { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true, stateRoot: "/tmp/pi-test" }
    const grant = { actor: { kind: "person" as const, userId: "owner" }, via: "owner-grant" as const, reissued: false }
    expect(selectPiProfile(grant, credentials, "/work", "grant-session", options).kind).toBe("owner-login")
    expect(selectPiProfile({ ...grant, via: "relay" }, credentials, "/work", "relay-session", options).kind).toBe("brokered")
    expect(selectPiProfile({ ...member, reissued: true }, credentials, "/work", "queued-session", options).kind).toBe("brokered")
    expect(() => selectPiProfile(member, credentials, "/work", "session", options, "owner-login")).toThrow(CredentialSelectionError)
    expect(() => selectPiProfile({ ...member, reissued: true }, credentials, "/work", "session", options, "owner-login"))
      .toThrow(CredentialSelectionError)
    expect(() => selectPiProfile(owner, credentials, "/work", "session", options, "brokered")).toThrow(CredentialSelectionError)
  })

  test("isolates concurrent member overlays within one workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-concurrent-profiles-"))
    try {
      const options: PiProfileOptions = { placement: "loopback", machineOwnerUserId: "owner", canUseOwnLogin: true,
        stateRoot: path.join(root, "state") }
      const first = selectPiProfile(member, { ...credentials, providers: { openai: {
        baseUrl: "http://127.0.0.1:1001", placeholder: "first-member", authMode: "api-key",
      } } }, root, "session-one", options)
      const second = selectPiProfile(member, { ...credentials, providers: { openai: {
        baseUrl: "http://127.0.0.1:1002", placeholder: "second-member", authMode: "api-key",
      } } }, root, "session-two", options)
      await Promise.all([preparePiProfile(first), preparePiProfile(second)])
      expect(first.agentDir).not.toBe(second.agentDir)
      expect(await fs.readFile(path.join(first.agentDir, "models.json"), "utf8")).toContain("first-member")
      expect(await fs.readFile(path.join(second.agentDir, "models.json"), "utf8")).toContain("second-member")
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })

  test("adds a Pi package without admitting MCP", () => {
    const projection = { generation: "g1", pluginRoots: [{ pluginInstanceId: "plugin", root: "/tmp/pi-extension", dataRoot: "/tmp/pi-data" }],
      mcpServers: [], notApplied: [] }
    expect(piProjectionArgs(projection)).toEqual(["-e", "/tmp/pi-extension"])
    expect(() => piProjectionArgs({ ...projection, mcpServers: [{ kind: "http", name: "server", url: "https://example.test", origin: "configured" }] }))
      .toThrow("Pi has no MCP intake")
  })
})
