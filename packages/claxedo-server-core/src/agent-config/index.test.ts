import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { realpathSync } from "fs"
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
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, mcp: { old: { type: "remote", url: "https://old.test" } }, connections: {} }))
    expect((await mod.loadUserConfig()).mcp).toEqual({})
    await mod.saveUserConfig({ version: 3, mcp: { current: { type: "remote", url: "https://current.test" } }, connections: {} })
    ClaxedoDB.close()
    expect((await mod.loadUserConfig()).mcp.current?.url).toBe("https://current.test")
    expect((await fs.readFile(cfgFile(), "utf8"))).toContain("old.test")
  })

  // ── defaultHarness ────────────────────────────────────────────────────

  test("leaves the default unresolved when no explicit selection is configured", () => {
    expect(mod.defaultHarness()).toBeUndefined()
    expect(mod.defaultHarness({ version: 3, connections: {}, mcp: {} })).toBeUndefined()
  })

  test("selects an explicit default connection without exposing its trusted config", () => {
    const selected = mod.defaultHarness({
      version: 3,
      mcp: {},
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
      mcp: {},
      defaultHarness: { kind: "native", harnessId: "claude" },
    })).toEqual({ kind: "native", harnessId: "claude" })
  })

  test("rejects obsolete config keys", async () => {
    await expect(mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, harness: { id: "pi" } } as never))
      .rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("accepts the embedded-SDK OpenCode harness as a native default", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, defaultHarness: { kind: "native", harnessId: "opencode" } })
    expect((await mod.loadUserConfig()).defaultHarness).toEqual({ kind: "native", harnessId: "opencode" })
  })

  test("rejects an unknown native default", async () => {
    await expect(mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, defaultHarness: { kind: "native", harnessId: "mystery" } } as never))
      .rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("returns default config when the SQLite row does not exist", async () => {
    expect(await mod.loadUserConfig()).toEqual({ version: 3, connections: {}, mcp: {}, sandbox_driver: {} })
  })

  test("rejects an invalid schema stored in SQLite", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    ClaxedoDB.raw().prepare("update claxedo_user_agent_config set config_json = ? where user_id = ?")
      .run(JSON.stringify({ version: 4, mcp: {}, connections: {} }), "__local__")
    await expect(mod.loadUserConfig()).rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("rejects invalid SQLite JSON without logging its contents or overwriting the row", async () => {
    const secret = "sk-secret-that-must-stay-private"
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
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
      mcp: {
        "my-server": {
          type: "stdio" as const,
          command: "node",
          args: ["server.js"],
          env: { PORT: "3000" },
        },
      },
      sandbox_driver: { default_driver: "daytona" as const },
    }
    await mod.saveUserConfig(original)
    const loaded = await mod.loadUserConfig()

    expect(loaded.mcp["my-server"]).toEqual(original.mcp["my-server"])
    expect(loaded.connections).toEqual(original.connections)
    expect(loaded.defaultConnectionId).toEqual(original.defaultConnectionId)
    expect(loaded.sandbox_driver).toEqual(original.sandbox_driver)
    expect((loaded as { sandbox?: unknown }).sandbox).toBeUndefined()
  })

  test("keeps only canonical sandbox driver config", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, sandbox_driver: {
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
    await expect(mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, sandbox: { default_driver: "modal" } } as never))
      .rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  test("save creates the SQLite database under the data directory", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    expect((await fs.stat(path.join(root, "claxedo.db"))).isFile()).toBe(true)
  })

  // ── getRuntimeConfigSnapshot ────────────────────────────────────────

  test("snapshot includes v4 connections, explicit default, mcp, and no command side channel", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      mcp: { "test-mcp": { type: "remote", url: "http://localhost:9000" } },
      defaultConnectionId: "conn-primary",
    })
    await mod.saveCommand("triage", "Triage $ARGUMENTS")
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.version).toBe(4)
    expect(snap.mcp["test-mcp"]).toBeDefined()
    expect(snap.connections).toEqual([trustedConnection()])
    expect(snap.defaultHarness).toEqual({ kind: "connection", connectionId: "conn-primary" })
    expect("commands" in snap).toBe(false)
    expect(await mod.listCommands()).toContainEqual({ name: "triage", content: "Triage $ARGUMENTS" })
  })

  /**
   * The producer holds no credential of its own any more. Everything in `auth`
   * comes from the installed authority, which hands out broker endpoints and
   * placeholders; a key typed into the user config file reaches no harness.
   */
  test("snapshot auth is exactly what the credential authority projects", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      mcp: {},
    })
    const projection = {
      baseUrl: "http://127.0.0.1:2595/bindings/61b4",
      placeholder: "signed-placeholder",
      authMode: "api-key" as const,
      expiresAt: 1_800_000_000_000,
    }
    mod.configureAgentConfig({ projectAuth: async () => ({ "claude-sdk": projection }) })

    const snap = await mod.getRuntimeConfigSnapshot(undefined, { workspaceId: "ws_1" })

    expect(snap.auth).toEqual({ "claude-sdk": projection })
    expect(JSON.stringify(snap)).not.toContain("sk-openai-typed-into-the-config-file")
    expect(normalizeRuntimeSnapshot(snap)?.auth).toEqual({ "claude-sdk": projection })
  })

  test("a composition with no authority sends no credentials at all", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    mod.configureAgentConfig({})

    expect((await mod.getRuntimeConfigSnapshot(undefined, { workspaceId: "ws_1" })).auth).toEqual({})
  })

  test("snapshot remains unresolved when no harness is configured", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.defaultHarness).toBeUndefined()
    expect(snap.connections).toEqual([])
  })

  test("snapshot obtains opaque harness launch options from the composition", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    mod.configureAgentConfig({
      harnessLaunch: async () => ({
        claude: { pluginRoots: ["/runtime/plugins/review"] },
      }),
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.harnessLaunch).toEqual({
      claude: { pluginRoots: ["/runtime/plugins/review"] },
    })
    expect(normalizeRuntimeSnapshot(snap)?.harnessLaunch).toEqual(snap.harnessLaunch)
  })

  test("snapshot emits only the clean v4 connection contract", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      mcp: {},
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
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    const scopes: string[] = []
    mod.configureAgentConfig({
      projectAuth: async ({ scope }) => {
        scopes.push(scope)
        return {
          "claude-sdk": {
            baseUrl: "https://api.anthropic.com",
            placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
            authMode: "api-key",
            apiPath: "/v1",
          },
        }
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
    expect(snap.auth).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholderEnv: "CLAXEDO_PROVIDER_CLAUDE_SDK",
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
    expect(normalizeRuntimeSnapshot(snap, { CLAXEDO_PROVIDER_CLAUDE_SDK: "dtn-placeholder" })?.auth).toEqual({
      "claude-sdk": {
        baseUrl: "https://api.anthropic.com",
        placeholder: "dtn-placeholder",
        authMode: "api-key",
        apiPath: "/v1",
      },
    })
    expect(snap.defaultHarness).toBeUndefined()
  })

  test("the snapshot retains its canonical version when no user MCP servers exist", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    const config = await mod.getRuntimeConfigSnapshot()
    expect(config).toEqual({ version: 4, mcp: {}, connections: [], auth: {} })
  })

  test("the snapshot resolves stdio servers into the provider-neutral format", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
      mcp: {
        "my-tool": {
          type: "stdio",
          command: "npx",
          args: ["-y", "tool-server"],
          env: { TOOL_MODE: "test" },
        },
      },
    })
    const config = await mod.getRuntimeConfigSnapshot()
    expect(config.mcp).toBeDefined()
    expect(config.mcp).toEqual({ "my-tool": { name: "my-tool", source: "user", transport: "stdio", command: "npx", args: ["-y", "tool-server"], env: { TOOL_MODE: "test" } } })
  })

  test("the snapshot transforms remote servers", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
      mcp: {
        "remote-tool": {
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer token" },
        },
      },
    })
    const config = await mod.getRuntimeConfigSnapshot()
    expect(config.mcp).toEqual({ "remote-tool": { name: "remote-tool", source: "user", transport: "remote", url: "https://mcp.example.com", headers: { Authorization: "Bearer token" } } })
  })

  test("the snapshot excludes disabled servers", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
      mcp: {
        active: { type: "stdio", command: "node", args: [] },
        disabled: { type: "stdio", command: "node", args: [], disabled: true },
      },
    })
    const config = await mod.getRuntimeConfigSnapshot()
    const mcp = config.mcp as Record<string, unknown>
    expect(mcp["active"]).toBeDefined()
    expect(mcp["disabled"]).toBeUndefined()
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
    const deleted = await mod.deleteCommand("temp-cmd")
    expect(deleted).toBe(true)

    const after = await mod.getCommand("temp-cmd")
    expect(after).toBeNull()
  })

  test("delete returns false for nonexistent command", async () => {
    const deleted = await mod.deleteCommand("nonexistent-" + randomUUID())
    expect(deleted).toBe(false)
  })

  test("get returns null for nonexistent command", async () => {
    const cmd = await mod.getCommand("nonexistent-" + randomUUID())
    expect(cmd).toBeNull()
  })
})
