import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

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

function cmdDir() {
  return path.join(root, "opencode-config", "command")
}

function processBinary(input: { connection?: { kind: string; binary?: string } }) {
  return input.connection?.kind === "process" ? input.connection.binary : undefined
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

  test("defaults to opencode when no runner is configured", () => {
    expect(mod.defaultHarness()).toEqual({ id: "opencode", access: "native" })
    expect(mod.defaultHarness({ mcp: {}, auth: {} })).toEqual({ id: "opencode", access: "native" })
  })

  test("preserves an operator ACP connection's explicit binary path", () => {
    const runner = mod.defaultHarness({
      mcp: {},
      auth: {},
      harness: {
        id: "openclaw",
        access: "acp",
        connection: { kind: "process", binary: "/custom/openclaw", args: ["acp"] },
      },
    })
    expect(runner).toMatchObject({ id: "openclaw", access: "acp" })
    expect(processBinary(runner)).toBe("/custom/openclaw")
  })

  test("native runners do not inherit ACP binary defaults", () => {
    expect(mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "claude-sdk" },
    })).toEqual({ id: "claude", access: "native" })
    expect(mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "codex-app-server", model: "default" },
    })).toEqual({ id: "codex", access: "native" })
  })

  test("loads a canonical operator ACP harness and model", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      auth: {},
      harness: { id: "openclaw", access: "acp" },
      model: "operator-default",
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
    }))
    const config = await mod.loadUserConfig()
    expect(config.harness).toEqual({ id: "openclaw", access: "acp" })
    expect(config.model).toBe("operator-default")
  })

  test("opencode runner has no binary or model", () => {
    const runner = mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "opencode" },
    })
    expect(runner).toEqual({ id: "opencode", access: "native" })
    expect(processBinary(runner)).toBeUndefined()
  })

  // ── loadUserConfig / saveUserConfig ──────────────────────────────────

  test("returns default config when file does not exist", async () => {
    const config = await mod.loadUserConfig()
    expect(config).toEqual({ mcp: {}, auth: {}, sandbox_driver: {} })
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
      mcp: {
        "my-server": {
          type: "stdio" as const,
          command: "node",
          args: ["server.js"],
          env: { PORT: "3000" },
        },
      },
      harness: { id: "openclaw" as const, access: "acp" as const },
      model: "operator-default",
      auth: { "claude-sdk": "sk-ant-test" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
      sandbox_driver: { default_driver: "daytona" as const },
    }
    await mod.saveUserConfig(original)
    const loaded = await mod.loadUserConfig()

    expect(loaded.mcp["my-server"]).toEqual(original.mcp["my-server"])
    expect(loaded.harness).toEqual(original.harness)
    expect(loaded.model).toEqual(original.model)
    expect(loaded.auth).toEqual(original.auth)
    expect(loaded.sandbox_driver).toEqual(original.sandbox_driver)
    expect((loaded as { sandbox?: unknown }).sandbox).toBeUndefined()
  })

  test("keeps only canonical sandbox driver config", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      auth: {},
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

  test("ignores legacy sandbox provider config", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      auth: {},
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

    const loaded = await mod.loadUserConfig()

    expect(loaded.sandbox_driver).toEqual({})
    expect(mod.sandboxDriverConfig(loaded)).toEqual(loaded.sandbox_driver)
  })

  test("save creates directory if it doesn't exist", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const exists = await fs
      .stat(cfgFile())
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  // ── getRuntimeConfigSnapshot ────────────────────────────────────────

  test("snapshot includes version, mcp, harnesses, auth, and no command side channel", async () => {
    await mod.saveUserConfig({
      mcp: { "test-mcp": { type: "remote", url: "http://localhost:9000" } },
      harness: { id: "openclaw", access: "acp" },
      acp: { openclaw: { label: "OpenClaw", command: ["/opt/openclaw", "acp"] } },
      auth: { "codex-app-server": "sk-test" },
    })
    await mod.saveCommand("triage", "Triage $ARGUMENTS")
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.version).toBe(2)
    expect(snap.mcp["test-mcp"]).toBeDefined()
    expect(snap.harnesses[0]).toMatchObject({ id: "openclaw", access: "acp" })
    expect(snap.auth["codex-app-server"]).toBe("sk-test")
    expect("commands" in snap).toBe(false)
    expect(await mod.listCommands()).toContainEqual({ name: "triage", content: "Triage $ARGUMENTS" })
  })

  test("snapshot does not alias native provider auth into operator ACP identities", async () => {
    await mod.saveUserConfig({
      mcp: {},
      harness: { id: "openclaw", access: "acp" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
      auth: {
        openai: "sk-openai-managed",
      },
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.auth.openai).toBe("sk-openai-managed")
    expect(snap.auth["acp:openclaw"]).toBeUndefined()
  })

  test("snapshot preserves plain OpenCode OAuth without ACP aliases", async () => {
    await mod.saveUserConfig({
      mcp: {},
      runner: { type: "opencode" },
      auth: {
        openai: JSON.stringify({
          type: "oauth",
          refresh: "refresh-openai",
          access: "access-openai",
          expires: 1_790_000_000_000,
        }),
      },
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.auth.openai).toBe(
      JSON.stringify({
        type: "oauth",
        refresh: "refresh-openai",
        access: "access-openai",
        expires: 1_790_000_000_000,
      }),
    )
    expect(Object.keys(snap.auth).some((key) => key.startsWith("acp:"))).toBe(false)
  })

  test("snapshot defaults harness to opencode when no harness configured", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.harnesses[0]).toEqual({ id: "opencode", access: "native" })
  })

  test("snapshot obtains opaque harness launch options from the composition", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
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

  // Forward wire contract: every snapshot the control plane pushes must be
  // accepted by the *current* workspace runtime validator. This guards
  // against emitter/validator drift like the `version: 2` rollout — if the
  // two sides disagree, `config push` fails with 400 and the composer never
  // unlocks. (Deployed sandboxes must run a matching runtime version; that
  // is enforced separately by the image version pin.)
  test("snapshot is accepted by the current workspace runtime validator", async () => {
    await mod.saveUserConfig({
      mcp: {},
      harness: { id: "openclaw", access: "acp" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
      auth: {},
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(normalizeRuntimeSnapshot(snap)).toBeDefined()
  })

  test("shared cloud snapshot is accepted by the current workspace runtime validator", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({
      mcp: {},
      harness: { id: "openclaw", access: "acp" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
      auth: {},
    })
    const snap = await mod.getRuntimeConfigSnapshot(undefined, {
      secretScope: "shared",
      workspaceDir: project,
      workspaceId: "ws_1",
    })
    expect(normalizeRuntimeSnapshot(snap)).toBeDefined()
  })

  // ── getEffectiveConfig ──────────────────────────────────────────────

  test("effective config is empty when no user MCP servers exist", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const config = await mod.getEffectiveConfig()
    expect(config).toEqual({})
  })

  test("effective config transforms stdio servers into local format", async () => {
    await mod.saveUserConfig({
      mcp: {
        "my-tool": {
          type: "stdio",
          command: "npx",
          args: ["-y", "tool-server"],
          env: { TOOL_MODE: "test" },
        },
      },
      auth: {},
    })
    const config = await mod.getEffectiveConfig()
    expect(config.mcp).toBeDefined()
    const mcp = config.mcp as Record<string, { type: string; command: string[]; environment: Record<string, string> }>
    expect(mcp["my-tool"].type).toBe("local")
    expect(mcp["my-tool"].command).toEqual(["npx", "-y", "tool-server"])
    expect(mcp["my-tool"].environment).toEqual({ TOOL_MODE: "test" })
  })

  test("effective config transforms remote servers", async () => {
    await mod.saveUserConfig({
      mcp: {
        "remote-tool": {
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer token" },
        },
      },
      auth: {},
    })
    const config = await mod.getEffectiveConfig()
    const mcp = config.mcp as Record<string, { type: string; url: string; headers: Record<string, string> }>
    expect(mcp["remote-tool"].type).toBe("remote")
    expect(mcp["remote-tool"].url).toBe("https://mcp.example.com")
    expect(mcp["remote-tool"].headers.Authorization).toBe("Bearer token")
  })

  test("effective config excludes disabled servers", async () => {
    await mod.saveUserConfig({
      mcp: {
        active: { type: "stdio", command: "node", args: [] },
        disabled: { type: "stdio", command: "node", args: [], disabled: true },
      },
      auth: {},
    })
    const config = await mod.getEffectiveConfig()
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

describe("operator ACP connections", () => {
  beforeEach(async () => {
    // The first describe's afterAll restores CLAXEDO_DATA_DIR; pin it back to
    // this file's temp root for every test here.
    process.env.CLAXEDO_DATA_DIR = root
    // See the first describe's beforeEach: Windows needs the sqlite handles
    // closed before the wipe can unlink the database files.
    closeSqliteHandles()
    await fs.rm(root, { recursive: true, force: true })
    mod.configureAgentConfig({})
  })

  afterAll(async () => {
    closeSqliteHandles()
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("validates the whole proposed map and defaults enabled to true", () => {
    const valid = mod.normalizeAcpConnections({
      gemini: { label: "Gemini", command: ["gemini", "--acp"], env: { GEMINI_API_KEY: "g-key" } },
      hermes: { label: "Hermes", command: ["hermes", "acp"], enabled: false },
    })
    expect(valid.problems).toEqual([])
    expect(valid.accepted.gemini).toEqual({
      label: "Gemini",
      command: ["gemini", "--acp"],
      env: { GEMINI_API_KEY: "g-key" },
    })
    expect(valid.accepted.hermes).toEqual({ label: "Hermes", command: ["hermes", "acp"], enabled: false })

    const invalid = mod.normalizeAcpConnections({
      gemini: { label: "Gemini", command: ["gemini"] },
      "Bad Slug": { label: "Nope", command: ["nope"] },
      empty: { label: "Empty", command: [] },
    })
    expect(invalid.problems.map((problem) => problem.id).sort()).toEqual(["Bad Slug", "empty"])
    expect(Object.keys(invalid.accepted)).toEqual(["gemini"])
  })

  test("loadUserConfig keeps valid provisioned connections and drops invalid ones", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      acp: {
        gemini: { label: "Gemini", command: ["gemini", "--acp"] },
        broken: { label: "", command: ["x"] },
      },
    }))
    const config = await mod.loadUserConfig()
    expect(Object.keys(config.acp ?? {})).toEqual(["gemini"])
  })

  test("the runtime snapshot fans out every enabled connection behind the active harness", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      acp: {
        gemini: { label: "Gemini", command: ["gemini", "--acp"], env: { GEMINI_API_KEY: "g-key" } },
        hermes: { label: "Hermes", command: ["hermes", "acp"], enabled: false },
      },
    }))
    const snapshot = await mod.getRuntimeConfigSnapshot()
    expect(snapshot.harnesses[0]).toMatchObject({ id: "opencode", access: "native" })
    expect(snapshot.harnesses.slice(1)).toEqual([{
      id: "gemini",
      access: "acp",
      connection: {
        kind: "process",
        binary: "gemini",
        args: ["--acp"],
        env: { GEMINI_API_KEY: "g-key" },
      },
    }])
    // The fanned-out snapshot round-trips through the runtime's own
    // normalization with the registry intact.
    const normalized = normalizeRuntimeSnapshot(snapshot)
    expect(normalized?.harnesses?.map((row) => row.id)).toEqual(["opencode", "gemini"])
  })

  test("params.supportsMcpServers rides the trusted descriptor and survives runtime normalization", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      acp: {
        gemini: { label: "Gemini", command: ["gemini", "--acp"], params: { supportsMcpServers: false } },
      },
    }))
    const snapshot = await mod.getRuntimeConfigSnapshot()
    expect(snapshot.harnesses.slice(1)).toEqual([{
      id: "gemini",
      access: "acp",
      connection: {
        kind: "process",
        binary: "gemini",
        args: ["--acp"],
        supportsMcpServers: false,
      },
    }])
    const normalized = normalizeRuntimeSnapshot(snapshot)
    const row = normalized?.harnesses?.find((item) => item.id === "gemini")
    expect(row?.connection).toMatchObject({ kind: "process", supportsMcpServers: false })
  })

  test("a selected operator connection resolves its descriptor from the registry", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      harness: { id: "gemini", access: "acp" },
      acp: {
        gemini: { label: "Gemini", command: ["gemini", "--acp"] },
      },
    }))
    const snapshot = await mod.getRuntimeConfigSnapshot()
    expect(snapshot.harnesses[0]).toEqual({
      id: "gemini",
      access: "acp",
      connection: { kind: "process", binary: "gemini", args: ["--acp"] },
    })
    // The registry row is not duplicated behind the selected identity.
    expect(snapshot.harnesses.filter((row) => row.id === "gemini")).toHaveLength(1)
  })

  test("discovery rows carry identity and label but never command or env", async () => {
    const rows = mod.acpConnectionRows({
      acp: {
        gemini: { label: "Gemini", command: ["gemini", "--acp"], env: { GEMINI_API_KEY: "secret" } },
        hermes: { label: "Hermes", command: ["hermes"], enabled: false },
      },
    })
    expect(rows).toEqual([
      { key: "acp:gemini", id: "gemini", label: "Gemini", access: "acp", enabled: true },
      { key: "acp:hermes", id: "hermes", label: "Hermes", access: "acp", enabled: false },
    ])
    expect(JSON.stringify(rows)).not.toContain("secret")
    expect(JSON.stringify(rows)).not.toContain("--acp")
  })
})
