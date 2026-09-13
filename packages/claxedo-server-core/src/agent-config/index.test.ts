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

function backupFile(legacyVersion: number) {
  return path.join(root, `user-agent-config.legacy-v${legacyVersion}.json`)
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
    process.env.CLAXEDO_DATA_DIR = prev
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

  test("rejects a v3 file that carries legacy runner, harness, and ACP keys", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {},
      mcp: {},
      harness: { id: "openclaw", access: "acp" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
    }))
    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      code: "user_agent_config_invalid_schema",
    })
  })

  test("accepts the embedded-SDK OpenCode harness as a native default", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      version: 3,
      connections: {},
      mcp: {},
      defaultHarness: { kind: "native", harnessId: "opencode" },
    }))
    expect((await mod.loadUserConfig()).defaultHarness).toEqual({ kind: "native", harnessId: "opencode" })
  })

  test("still rejects an unknown native default", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      version: 3,
      connections: {},
      mcp: {},
      defaultHarness: { kind: "native", harnessId: "mystery" },
    }))
    await expect(mod.loadUserConfig()).rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  // ── loadUserConfig / saveUserConfig ──────────────────────────────────

  test("returns default config when file does not exist", async () => {
    const config = await mod.loadUserConfig()
    expect(config).toEqual({ version: 3, connections: {}, mcp: {}, sandbox_driver: {} })
  })

  test("migrates the operator's unversioned file to v3, backs it up, and stays migrated", async () => {
    await fs.mkdir(root, { recursive: true })
    const legacy = JSON.stringify({
      mcp: {},
      harness: { id: "opencode", access: "native" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
      sandbox_driver: { default_driver: "daytona" },
    })
    await fs.writeFile(cfgFile(), legacy)

    const expected = {
      version: 3,
      mcp: {},
      connections: {},
      defaultHarness: { kind: "native", harnessId: "opencode" },
      sandbox_driver: { default_driver: "daytona" },
    }
    expect(await mod.loadUserConfig()).toEqual(expected)
    expect(await fs.readFile(backupFile(2), "utf-8")).toBe(legacy)
    expect(JSON.parse(await fs.readFile(cfgFile(), "utf-8"))).toEqual(expected)

    expect(await mod.loadUserConfig()).toEqual(expected)
    expect(await fs.readFile(backupFile(2), "utf-8")).toBe(legacy)
  })

  test("migrates declared v1 and v2 files, keeping mcp and the sandbox driver", async () => {
    await fs.mkdir(root, { recursive: true })
    for (const version of [1, 2]) {
      await fs.rm(backupFile(version), { force: true })
      await fs.writeFile(cfgFile(), JSON.stringify({
        version,
        mcp: { "my-tool": { type: "stdio", command: "npx", args: ["tool"] } },
          sandbox_driver: { default_driver: "modal", auth: { modal: { token_id: "id" } } },
        harnesses: [],
      }))

      expect(await mod.loadUserConfig()).toEqual({
        version: 3,
        mcp: { "my-tool": { type: "stdio", command: "npx", args: ["tool"] } },
        connections: {},
          sandbox_driver: { default_driver: "modal", auth: { modal: { token_id: "id" } } },
      })
      expect(JSON.parse(await fs.readFile(backupFile(version), "utf-8")).version).toBe(version)
    }
  })

  test("drops legacy ACP and runner selections that have no v3 equivalent", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      harness: { id: "openclaw", access: "acp" },
      model: "some-model",
      runner: { type: "claude-sdk" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
    }))

    const migrated = await mod.loadUserConfig()
    expect(migrated).toEqual({ version: 3, mcp: {}, connections: {}, sandbox_driver: {} })
    expect(migrated.defaultHarness).toBeUndefined()
    expect(await fs.readFile(cfgFile(), "utf-8")).not.toContain("openclaw")
    expect(await fs.readFile(backupFile(2), "utf-8")).toContain("openclaw")
  })

  test("fails closed on a malformed legacy file without backing it up or rewriting it", async () => {
    await fs.mkdir(root, { recursive: true })
    const malformed = JSON.stringify({ mcp: "not-a-map", harness: { id: "opencode", access: "native" } })
    await fs.writeFile(cfgFile(), malformed)

    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      code: "user_agent_config_invalid_schema",
    })
    expect(await fs.readFile(cfgFile(), "utf-8")).toBe(malformed)
    await expect(fs.stat(backupFile(2))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("rejects a file declaring a version that is neither legacy nor current", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 4, mcp: {}, connections: {} }))
    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      code: "user_agent_config_invalid_schema",
    })
  })

  test("rejects malformed config without exposing or overwriting its contents", async () => {
    const secret = "sk-secret-that-must-stay-private"
    const malformed = `{"mcp":{},"auth":{"openai":"${secret}"},`
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), malformed)

    const mutation = async () => {
      const config = await mod.loadUserConfig()
      config.mcp.added = { type: "remote", url: "https://example.test" }
      await mod.saveUserConfig(config)
    }

    const result = mutation()
    await expect(result).rejects.toMatchObject({
      name: "UserAgentConfigLoadError",
      code: "user_agent_config_invalid_json",
      message: "User agent config contains invalid JSON",
    })
    await expect(result).rejects.not.toThrow(secret)
    expect(await fs.readFile(cfgFile(), "utf-8")).toBe(malformed)
  })

  test("propagates non-missing config read errors instead of treating them as first run", async () => {
    await fs.mkdir(cfgFile(), { recursive: true })

    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      name: "UserAgentConfigLoadError",
      code: "user_agent_config_read_failed",
      message: "Failed to read user agent config",
    })
    expect((await fs.stat(cfgFile())).isDirectory()).toBe(true)
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
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {},
      mcp: {},
      sandbox_driver: {
        default_provider: "vercel",
        default_driver: "modal",
        auth: {
          default_provider: { api_key: "legacy" },
          daytona: { api_key: " dtn ", provider_secret: "legacy-secret" },
          modal: { token_id: "id", token_secret: " secret ", extra: "ignored" },
          unknown: { api_key: "ignored" },
        },
      },
    }))

    const loaded = await mod.loadUserConfig()

    expect(loaded.sandbox_driver).toEqual({
      default_driver: "modal",
      auth: {
        daytona: { api_key: "dtn" },
        modal: { token_id: "id", token_secret: "secret" },
      },
    })
    expect(mod.sandboxDriverConfig(loaded)).toEqual(loaded.sandbox_driver)
  })

  test("rejects legacy sandbox provider config", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {},
      mcp: {},
      sandbox: {
        default_driver: "modal",
        auth: {
          modal: {
            token_id: "id",
            token_secret: "secret",
          },
        },
      },
    }))

    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      code: "user_agent_config_invalid_schema",
    })
  })

  test("save creates directory if it doesn't exist", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {} })
    const exists = await fs
      .stat(cfgFile())
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
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
