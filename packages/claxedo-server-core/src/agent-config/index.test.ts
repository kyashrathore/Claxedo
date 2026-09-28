import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import nodeFs, { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type { HarnessConnectionDescriptor } from "./connections"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./index")
const { ClaxedoDB } = await import("../platform/db/db")

/**
 * Release every sqlite file under the temp root before wiping it. ClaxedoDB
 * covers claxedo.db. Windows refuses the unlink with EBUSY while it is open.
 */
function closeSqliteHandles() {
  ClaxedoDB.close()
}

function cfgFile() {
  return path.join(root, "user-agent-config.json")
}

function trustedConnection(overrides: Partial<HarnessConnectionDescriptor> = {}): HarnessConnectionDescriptor {
  return {
    connectionId: "conn-primary",
    providerKey: "acp",
    configRevision: 1,
    enabled: true,
    config: {
      label: "Primary agent",
      connection: { kind: "process", command: "agent", args: ["--serve"] },
      modelSelection: { status: "optional" },
    },
    secretRefs: { token: "credentials/agent" },
    ...overrides,
  }
}

describe("agent config", () => {
  beforeEach(async () => {
    // Windows cannot unlink an sqlite file while its handle is open (EBUSY);
    // close them all so the wipe releases the files. The lazy handles reopen
    // on next use, preserving fresh-database-per-test semantics on every OS.
    closeSqliteHandles()
    mod.configureAgentConfig({})
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    closeSqliteHandles()
    mod.configureAgentConfig({})
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("stores settings in SQLite and ignores an old JSON file", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {}, defaultHarness: { kind: "native", harnessId: "claude" } }))
    expect((await mod.loadUserConfig()).defaultHarness).toBeUndefined()
    await mod.saveUserConfig({ version: 3, connections: {}, defaultHarness: { kind: "native", harnessId: "pi" } })
    ClaxedoDB.close()
    expect((await mod.loadUserConfig()).defaultHarness).toEqual({ kind: "native", harnessId: "pi" })
    expect((await fs.readFile(cfgFile(), "utf8"))).toContain("claude")
  })

  // ── defaultHarness ────────────────────────────────────────────────────

  test("leaves the default unresolved when no explicit selection is configured", () => {
    expect(mod.defaultHarness()).toBeUndefined()
    expect(mod.defaultHarness({ version: 3, connections: {} })).toBeUndefined()
  })

  test("selects an explicit default connection without exposing its trusted config", () => {
    const selected = mod.defaultHarness({
      version: 3,
      connections: { "conn-primary": trustedConnection() },
      defaultConnectionId: "conn-primary",
    })
    expect(selected).toEqual({ kind: "connection", connectionId: "conn-primary" })
    expect(JSON.stringify(selected)).not.toContain("command")
  })

  test("selects only an explicit supported native default", () => {
    expect(mod.defaultHarness({
      version: 3,
      connections: {},
      defaultHarness: { kind: "native", harnessId: "claude" },
    })).toEqual({ kind: "native", harnessId: "claude" })
  })

  test("rejects obsolete config keys", async () => {
    await expect(mod.saveUserConfig({ version: 3, connections: {}, harness: { id: "pi" } } as never))
      .rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("accepts the embedded-SDK OpenCode harness as a native default", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, defaultHarness: { kind: "native", harnessId: "opencode" } })
    expect((await mod.loadUserConfig()).defaultHarness).toEqual({ kind: "native", harnessId: "opencode" })
  })

  test("rejects an unknown native default", async () => {
    await expect(mod.saveUserConfig({ version: 3, connections: {}, defaultHarness: { kind: "native", harnessId: "mystery" } } as never))
      .rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("returns default config when the SQLite row does not exist", async () => {
    expect(await mod.loadUserConfig()).toEqual({ version: 3, connections: {}, sandbox_driver: {} })
  })

  test("rejects an invalid schema stored in SQLite", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    ClaxedoDB.raw().prepare("update claxedo_user_agent_config set config_json = ? where user_id = ?")
      .run(JSON.stringify({ version: 4, mcp: {}, connections: {} }), "__local__")
    await expect(mod.loadUserConfig()).rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("rejects invalid SQLite JSON without logging its contents or overwriting the row", async () => {
    const secret = "sk-secret-that-must-stay-private"
    await mod.saveUserConfig({ version: 3, connections: {} })
    const malformed = `{"mcp":{},"auth":{"openai":"${secret}"},`
    ClaxedoDB.raw().prepare("update claxedo_user_agent_config set config_json = ? where user_id = ?")
      .run(malformed, "__local__")
    await expect(mod.loadUserConfig()).rejects.not.toThrow(secret)
    const row = ClaxedoDB.raw().prepare("select config_json from claxedo_user_agent_config where user_id = ?").get("__local__") as { config_json: string }
    expect(row.config_json).toBe(malformed)
  })

  test("round-trips config through save and load", async () => {
    const original = {
      version: 3 as const,
      connections: { "conn-primary": trustedConnection() },
      defaultConnectionId: "conn-primary",
      sandbox_driver: { default_driver: "daytona" as const },
    }
    await mod.saveUserConfig(original)
    const loaded = await mod.loadUserConfig()

    expect(loaded.connections).toEqual(original.connections)
    expect(loaded.defaultConnectionId).toEqual(original.defaultConnectionId)
    expect(loaded.sandbox_driver).toEqual(original.sandbox_driver)
    expect((loaded as { sandbox?: unknown }).sandbox).toBeUndefined()
  })

  test("keeps only canonical sandbox driver config", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, sandbox_driver: {
      default_driver: "modal",
      auth: {
        daytona: { api_key: " dtn " },
        modal: { token_id: "id", token_secret: " secret " },
      },
    } })
    const loaded = await mod.loadUserConfig()
    expect(loaded.sandbox_driver).toEqual({
      default_driver: "modal",
      auth: { daytona: { api_key: "dtn" }, modal: { token_id: "id", token_secret: "secret" } },
    })
  })

  test("rejects the removed sandbox provider config", async () => {
    await expect(mod.saveUserConfig({ version: 3, connections: {}, sandbox: { default_driver: "modal" } } as never))
      .rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("save creates the SQLite database under the data directory", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    expect((await fs.stat(path.join(root, "claxedo.db"))).isFile()).toBe(true)
  })

  // ── getRuntimeConfigSnapshot ────────────────────────────────────────

  test("snapshot includes v4 connections, explicit default, and saved commands", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      defaultConnectionId: "conn-primary",
    })
    await mod.saveCommand("triage", "Triage $ARGUMENTS")
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.version).toBe(4)
    expect(snap.mcp).toEqual({})
    expect(snap.connections).toEqual([trustedConnection()])
    expect(snap.defaultHarness).toEqual({ kind: "connection", connectionId: "conn-primary" })
    expect(snap).toHaveProperty("commands", [{ name: "triage", content: "Triage $ARGUMENTS" }])
    expect(normalizeRuntimeSnapshot(snap)?.commands).toEqual([{ name: "triage", content: "Triage $ARGUMENTS" }])
    expect(await mod.listCommands()).toContainEqual({ name: "triage", content: "Triage $ARGUMENTS" })
    await mod.deleteCommand("triage")
    expect(await mod.getRuntimeConfigSnapshot()).toHaveProperty("commands", [])
  })

  /**
   * The producer holds no credential of its own any more. Everything in `auth`
   * comes from the installed authority, which hands out broker endpoints and
   * placeholders; a key typed into the user config file reaches no harness.
   */
  test("snapshot auth is exactly what the credential authority projects", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
    })
    const projection = {
      baseUrl: "http://127.0.0.1:2595/bindings/61b4",
      placeholder: "signed-placeholder",
      authMode: "api-key" as const,
      expiresAt: 1_800_000_000_000,
    }
    mod.configureAgentConfig({ projectAuth: async () => ({ machineOwnerUserId: "local", accounts: { local: { "claude-sdk": projection } } }) })

    const snap = await mod.getRuntimeConfigSnapshot(undefined, { workspaceId: "ws_1" })

    expect(snap.auth.accounts.local).toEqual({ "claude-sdk": projection })
    expect(JSON.stringify(snap)).not.toContain("sk-openai-typed-into-the-config-file")
    expect(normalizeRuntimeSnapshot(snap)?.auth.accounts.local).toEqual({ "claude-sdk": projection })
  })

  test("a composition with no authority sends no credentials at all", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    mod.configureAgentConfig({})

    expect((await mod.getRuntimeConfigSnapshot(undefined, { workspaceId: "ws_1" })).auth).toEqual({ machineOwnerUserId: "", accounts: {} })
  })

  test("snapshot remains unresolved when no harness is configured", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.defaultHarness).toBeUndefined()
    expect(snap.connections).toEqual([])
  })

  test("snapshot carries the plugin module's launch rows and its ACP MCP map", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    const docs = { name: "review-1a2b3c4d-docs", source: "plugin" as const, transport: "remote" as const, url: "https://docs.example/mcp", headers: {} }
    mod.configureAgentConfig({
      pluginRuntime: async () => ({
        harnessLaunch: { claude: { pluginRoots: ["/runtime/plugins/review"] } },
        mcp: { [docs.name]: docs },
      }),
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.harnessLaunch).toEqual({
      claude: { pluginRoots: ["/runtime/plugins/review"] },
    })
    expect(snap.mcp).toEqual({ [docs.name]: docs })
    const applied = normalizeRuntimeSnapshot(snap)
    expect(applied?.harnessLaunch).toEqual(snap.harnessLaunch)
    expect(applied?.mcp).toEqual(snap.mcp)
  })

  test("snapshot emits only the clean v4 connection contract", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      defaultConnectionId: "conn-primary",
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap).toMatchObject({
      version: 4,
      connections: [trustedConnection()],
      defaultHarness: { kind: "connection", connectionId: "conn-primary" },
    })
    expect("harnesses" in snap).toBe(false)
  })

  /**
   * A cloud sandbox reaches its credential through its own provider's edge, so
   * the authority answers with the variable that edge fills rather than a
   * placeholder this machine minted. The scope reaches the authority either
   * way; this producer does not decide delivery.
   */
  test("a shared cloud snapshot carries what the authority projects for that scope", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({ version: 3, connections: {} })
    const scopes: string[] = []
    mod.configureAgentConfig({
      projectAuth: async ({ scope }) => {
        scopes.push(scope)
        return { machineOwnerUserId: "local", accounts: { local: {
          "claude-sdk": {
            baseUrl: "https://api.anthropic.com",
            placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
            authMode: "api-key",
            apiPath: "/v1",
          },
        } } }
      },
    })

    const snap = await mod.getRuntimeConfigSnapshot(undefined, {
      secretScope: "shared",
      workspaceDir: project,
      workspaceId: "ws_1",
    })

    expect(snap.version).toBe(4)
    expect(snap.connections).toEqual([])
    expect(scopes).toEqual(["shared"])
    expect(snap.auth.accounts.local).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
    expect(normalizeRuntimeSnapshot(snap, { CLAXEDO_PROVIDER_CLAUDE_SDK: "dtn-placeholder" })?.auth.accounts.local).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholder: "dtn-placeholder",
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
    expect(snap.defaultHarness).toBeUndefined()
  })

  test("the snapshot retains its canonical version", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    const config = await mod.getRuntimeConfigSnapshot()
    expect(config).toEqual({ version: 4, mcp: {}, connections: [], auth: { machineOwnerUserId: "", accounts: {} }, providerDefinitions: [], commands: [] })
  })

  test("refuses to publish an empty command set when command storage cannot be read", async () => {
    await mod.saveUserConfig({ version: 3, connections: {} })
    await fs.writeFile(path.join(root, "commands"), "not a directory")
    await expect(mod.getRuntimeConfigSnapshot()).rejects.toMatchObject({ code: "EEXIST" })
  })

  // ── Commands ────────────────────────────────────────────────────────

  test("lists empty commands when no files exist", async () => {
    const cmds = await mod.listCommands()
    expect(cmds).toEqual([])
  })

  test("round-trips a command through save, get, and list", async () => {
    const name = await mod.saveCommand("deploy", "Run the deployment pipeline")
    expect(name).toBe("deploy")

    const cmd = await mod.getCommand("deploy")
    expect(cmd).toEqual({ name: "deploy", content: "Run the deployment pipeline" })

    const list = await mod.listCommands()
    expect(list.some((c) => c.name === "deploy")).toBe(true)
  })

  test("sanitizes command names to remove special characters", async () => {
    const name = await mod.saveCommand("my command!@#$", "content")
    expect(name).toBe("my-command----")
  })

  test("deletes an existing command", async () => {
    await mod.saveCommand("temp-cmd", "temporary")
    await mod.deleteCommand("temp-cmd")

    const after = await mod.getCommand("temp-cmd")
    expect(after).toBeNull()
  })

  test("delete propagates filesystem failures instead of claiming absence", async () => {
    await mod.saveCommand("blocked", "content")
    await fs.unlink(path.join(root, "commands", "blocked.md"))
    await fs.mkdir(path.join(root, "commands", "blocked.md"))
    await expect(mod.deleteCommand("blocked")).rejects.toThrow()
  })

  test("get propagates filesystem failures instead of claiming absence", async () => {
    await fs.mkdir(path.join(root, "commands", "unreadable.md"), { recursive: true })
    await expect(mod.getCommand("unreadable")).rejects.toMatchObject({ code: "EISDIR" })
  })

  test("deleting a nonexistent command succeeds", async () => {
    await expect(mod.deleteCommand("nonexistent-" + randomUUID())).resolves.toBeUndefined()
  })

  test("a command removed between listing and reading is left out of the list", async () => {
    await mod.saveCommand("kept", "Kept")
    const listed = await nodeFs.promises.readdir(path.join(root, "commands"))
    const readdir = vi.spyOn(nodeFs.promises, "readdir").mockResolvedValueOnce([...listed, "vanished.md"] as never)
    try {
      expect(await mod.listCommands()).toEqual([{ name: "kept", content: "Kept" }])
    } finally {
      readdir.mockRestore()
    }
  })

  test("get returns null for nonexistent command", async () => {
    const cmd = await mod.getCommand("nonexistent-" + randomUUID())
    expect(cmd).toBeNull()
  })
})
