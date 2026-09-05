import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { grantProjectExtensionTrust } from "@claxedo/agent-extensions"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import type { HarnessConnectionDescriptor } from "./connections"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
const prevDeploymentMode = process.env.CLAXEDO_DEPLOYMENT_MODE
const prevWorkspaceAuthorityUrl = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
const prevControlPlaneServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./index")
const { ControlPlaneAuthError } = await import("@claxedo/server-core/platform/auth/auth")
const { ClaxedoDB } = await import("../platform/db/db")
const { closeAuthorityDatabases } = await import("../authority/adapters/sqlite/workspace-authority-store")

/**
 * Release every sqlite file under the temp root before wiping it. ClaxedoDB
 * covers claxedo.db; the runtime-snapshot paths also memoize a local SQLite
 * workspace authority whose authority.db(-wal/-shm) stays open across tests —
 * Windows refuses the unlink with EBUSY while it does (run 361: 19 failures).
 * Both closes are registry resets, so the next use reopens cleanly.
 */
function closeSqliteHandles() {
  ClaxedoDB.close()
  closeAuthorityDatabases()
}

function unavailableWorkspaceAuthority() {
  return {
    listWorkspaceAgentExtensionsForRuntime: vi.fn(async () => {
      throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
    }),
    listAgentExtensionPolicyOverridesForRuntime: vi.fn(async () => {
      throw new ControlPlaneAuthError(503, "workspace_authority_unavailable", "Workspace authority is not configured")
    }),
  }
}

function cfgFile() {
  return path.join(root, "user-agent-config.json")
}

function cmdDir() {
  return path.join(root, "opencode-config", "command")
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
    if (prevDeploymentMode === undefined) delete process.env.CLAXEDO_DEPLOYMENT_MODE
    else process.env.CLAXEDO_DEPLOYMENT_MODE = prevDeploymentMode
    if (prevWorkspaceAuthorityUrl === undefined) delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    else process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = prevWorkspaceAuthorityUrl
    if (prevControlPlaneServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = prevControlPlaneServiceToken
  })

  // ── defaultHarness ────────────────────────────────────────────────────

  test("leaves the default unresolved when no explicit selection is configured", () => {
    expect(mod.defaultHarness()).toBeUndefined()
    expect(mod.defaultHarness({ version: 3, connections: {}, mcp: {}, auth: {} })).toBeUndefined()
  })

  test("selects an explicit default connection without exposing its trusted config", () => {
    const selected = mod.defaultHarness({
      version: 3,
      mcp: {},
      auth: {},
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
      auth: {},
      defaultHarness: { kind: "native", harnessId: "claude" },
    })).toEqual({ kind: "native", harnessId: "claude" })
  })

  test("rejects legacy runner, harness, and ACP config instead of adopting it", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {},
      mcp: {},
      auth: {},
      harness: { id: "openclaw", access: "acp" },
      acp: { openclaw: { label: "OpenClaw", command: ["openclaw", "acp"] } },
    }))
    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      code: "user_agent_config_invalid_schema",
    })
  })

  test("rejects OpenCode as a native default", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      version: 3,
      connections: {},
      mcp: {},
      defaultHarness: { kind: "native", harnessId: "opencode" },
    }))
    await expect(mod.loadUserConfig()).rejects.toMatchObject({ code: "user_agent_config_invalid_schema" })
  })

  // ── loadUserConfig / saveUserConfig ──────────────────────────────────

  test("returns default config when file does not exist", async () => {
    const config = await mod.loadUserConfig()
    expect(config).toEqual({ version: 3, connections: {}, mcp: {}, auth: {}, sandbox_driver: {} })
  })

  test("rejects v1, v2, and unversioned files without compatibility decoding", async () => {
    await fs.mkdir(root, { recursive: true })
    for (const legacy of [
      { mcp: {}, connections: {} },
      { version: 1, mcp: {}, connections: {} },
      { version: 2, mcp: {}, harnesses: [] },
    ]) {
      await fs.writeFile(cfgFile(), JSON.stringify(legacy))
      await expect(mod.loadUserConfig()).rejects.toMatchObject({
        code: "user_agent_config_invalid_schema",
      })
    }
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
      auth: { "claude-sdk": "sk-ant-test" },
      sandbox_driver: { default_driver: "daytona" as const },
    }
    await mod.saveUserConfig(original)
    const loaded = await mod.loadUserConfig()

    expect(loaded.mcp["my-server"]).toEqual(original.mcp["my-server"])
    expect(loaded.connections).toEqual(original.connections)
    expect(loaded.defaultConnectionId).toEqual(original.defaultConnectionId)
    expect(loaded.auth).toEqual(original.auth)
    expect(loaded.sandbox_driver).toEqual(original.sandbox_driver)
    expect((loaded as { sandbox?: unknown }).sandbox).toBeUndefined()
  })

  test("keeps only canonical sandbox driver config", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {},
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

  test("rejects legacy sandbox provider config", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({ version: 3, connections: {},
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

    await expect(mod.loadUserConfig()).rejects.toMatchObject({
      code: "user_agent_config_invalid_schema",
    })
  })

  test("save creates directory if it doesn't exist", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })
    const exists = await fs
      .stat(cfgFile())
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  // ── getRuntimeConfigSnapshot ────────────────────────────────────────

  test("snapshot includes v3 connections, explicit default, mcp, and no command side channel", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      mcp: { "test-mcp": { type: "remote", url: "http://localhost:9000" } },
      defaultConnectionId: "conn-primary",
      auth: { "codex-app-server": "sk-test" },
    })
    await mod.saveCommand("triage", "Triage $ARGUMENTS")
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.version).toBe(3)
    expect(snap.mcp["test-mcp"]).toBeDefined()
    expect(snap.connections).toEqual([trustedConnection()])
    expect(snap.defaultHarness).toEqual({ kind: "connection", connectionId: "conn-primary" })
    expect(snap.auth["codex-app-server"]).toBe("sk-test")
    expect("commands" in snap).toBe(false)
    expect(await mod.listCommands()).toContainEqual({ name: "triage", content: "Triage $ARGUMENTS" })
  })

  test("snapshot does not alias native provider auth into generic connection identities", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      mcp: {},
      auth: {
        openai: "sk-openai-managed",
      },
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.auth.openai).toBe("sk-openai-managed")
    expect(snap.auth["conn-primary"]).toBeUndefined()
  })

  test("snapshot preserves trusted native auth without selecting a harness", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
      mcp: {},
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
    expect(snap.defaultHarness).toBeUndefined()
  })

  test("snapshot remains unresolved when no harness is configured", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.defaultHarness).toBeUndefined()
    expect(snap.connections).toEqual([])
  })

  test("snapshot includes Agent Extensions replay metadata for a workspace directory", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await fs.mkdir(path.join(project, ".agent-extensions"), { recursive: true })
    await fs.writeFile(
      path.join(project, ".agent-extensions", "installed.json"),
      JSON.stringify({
        version: 1,
        installs: [
          {
            id: "review",
            package_name: "review",
            source: { type: "github", owner: "acme", repo: "review" },
            scope: "project",
            enabled: true,
            targets: ["cursor"],
            installed_at: 1,
            updated_at: 2,
          },
        ],
      }),
    )
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })

    // Repo-shipped extension declarations are ignored until this host has
    // recorded trust for the checkout (project-scope consent gate).
    const unconsented = await mod.getRuntimeConfigSnapshot(undefined, { workspaceDir: project })
    expect(unconsented.agent_extensions).toEqual({ version: 1, installs: [] })

    await grantProjectExtensionTrust({
      dataRoot: process.env.CLAXEDO_DATA_DIR!,
      projectDir: project,
      installIds: ["review"],
    })

    const snap = await mod.getRuntimeConfigSnapshot(undefined, { workspaceDir: project })

    expect(snap.agent_extensions).toMatchObject({
      version: 1,
      installs: [
        {
          desired: {
            id: "review",
          },
        },
      ],
    })
  })

  test("snapshot emits only the clean v3 connection contract", async () => {
    await mod.saveUserConfig({ version: 3, connections: { "conn-primary": trustedConnection() },
      mcp: {},
      defaultConnectionId: "conn-primary",
      auth: {},
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap).toMatchObject({
      version: 3,
      connections: [trustedConnection()],
      defaultHarness: { kind: "connection", connectionId: "conn-primary" },
    })
    expect("harnesses" in snap).toBe(false)
  })

  test("shared cloud snapshot keeps the v3 contract without implicit selection", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({ version: 3, connections: {},
      mcp: {},
      auth: {},
    })
    const snap = await mod.getRuntimeConfigSnapshot(undefined, {
      secretScope: "shared",
      workspaceDir: project,
      workspaceId: "ws_1",
      authority: unavailableWorkspaceAuthority(),
    })
    expect(snap.version).toBe(3)
    expect(snap.connections).toEqual([])
    expect(snap.defaultHarness).toBeUndefined()
  })

  test("local workspace snapshot hydrates from SQLite despite an ambient workspace-authority URL", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })
    const deploymentMode = process.env.CLAXEDO_DEPLOYMENT_MODE
    const authorityUrl = process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
    const serviceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
    process.env.CLAXEDO_DEPLOYMENT_MODE = "local"
    process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = "http://127.0.0.1:9"
    process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = "test-service-token"
    try {
      const snap = await mod.getRuntimeConfigSnapshot(undefined, {
        secretScope: "shared",
        workspaceDir: project,
        workspaceId: "ws_local",
      })

      expect(snap.agent_extensions).toMatchObject({
        version: 1,
        installs: [],
      })
    } finally {
      if (deploymentMode === undefined) delete process.env.CLAXEDO_DEPLOYMENT_MODE
      else process.env.CLAXEDO_DEPLOYMENT_MODE = deploymentMode
      if (authorityUrl === undefined) delete process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL
      else process.env.CLAXEDO_WORKSPACE_AUTHORITY_URL = authorityUrl
      if (serviceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
      else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = serviceToken
    }
  })

  test("shared workspace Agent Extensions snapshot fails closed when Control Plane hydration is unavailable", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })

    await expect(
      mod.getRuntimeConfigSnapshot(undefined, {
        secretScope: "shared",
        workspaceDir: project,
        workspaceId: "ws_1",
        authority: unavailableWorkspaceAuthority(),
        requireWorkspaceAgentExtensions: true,
      }),
    ).rejects.toMatchObject({
      code: "workspace_authority_unavailable",
    })
  })

  test("shared workspace Agent Extensions snapshot falls back to empty when service hydration is optional", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })

    const snap = await mod.getRuntimeConfigSnapshot(undefined, {
      secretScope: "shared",
      workspaceDir: project,
      workspaceId: "ws_1",
      authority: unavailableWorkspaceAuthority(),
    })

    expect(snap.agent_extensions).toMatchObject({
      version: 1,
      installs: [],
    })
  })

  test("shared workspace Agent Extensions snapshot hydrates runtime policy overrides from Control Plane", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    const listWorkspaceAgentExtensionsForRuntime = vi.fn(async () => [
      {
        desired: {
          id: "review",
          package_name: "review",
          source: { type: "github", owner: "acme", repo: "review" },
          scope: "workspace",
          enabled: true,
          targets: ["cursor"],
          installed_at: 1,
          updated_at: 1,
        },
        lock: {
          source: { type: "github", owner: "acme", repo: "review" },
          resolved_sha: "abcdef1234567890",
          manifest_digests: { package: "abc" },
          component_digests: { package: "abc" },
          targets: ["cursor"],
        },
      },
    ])
    const listAgentExtensionPolicyOverridesForRuntime = vi.fn(async () => [
      {
        id: "review",
        scope: "org" as const,
        enabled: false,
        reason: "blocked by org policy",
      },
    ])
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })

    const snap = await mod.getRuntimeConfigSnapshot(undefined, {
      secretScope: "shared",
      workspaceDir: project,
      workspaceId: "ws_1",
      authority: {
        listWorkspaceAgentExtensionsForRuntime,
        listAgentExtensionPolicyOverridesForRuntime,
      },
    })

    expect(snap.agent_extensions?.installs).toEqual([{
      desired: {
        id: "review",
        package_name: "review",
        source: { type: "github", owner: "acme", repo: "review" },
        scope: "workspace",
        enabled: false,
        targets: ["cursor"],
        installed_at: 1,
        updated_at: 1,
      },
      lock: {
        source: { type: "github", owner: "acme", repo: "review" },
        resolved_sha: "abcdef1234567890",
        manifest_digests: { package: "abc" },
        component_digests: { package: "abc" },
        targets: ["cursor"],
      },
      effective: {
        enabled: false,
        source: "org",
        reason: "blocked by org policy",
      },
      components: [],
    }])
    expect(listWorkspaceAgentExtensionsForRuntime).toHaveBeenCalledWith({
      workspaceId: "ws_1",
    })
    expect(listAgentExtensionPolicyOverridesForRuntime).toHaveBeenCalledWith({
      workspaceId: "ws_1",
    })
  })

  // ── getEffectiveConfig ──────────────────────────────────────────────

  test("effective config retains its canonical version when no user MCP servers exist", async () => {
    await mod.saveUserConfig({ version: 3, connections: {}, mcp: {}, auth: {} })
    const config = await mod.getEffectiveConfig()
    expect(config).toEqual({ version: 3, mcp: {}, connections: [], auth: {} })
  })

  test("effective config resolves stdio servers into the provider-neutral format", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
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
    expect(config.mcp).toEqual({ "my-tool": { name: "my-tool", source: "user", transport: "stdio", command: "npx", args: ["-y", "tool-server"], env: { TOOL_MODE: "test" } } })
  })

  test("effective config transforms remote servers", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
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
    expect(config.mcp).toEqual({ "remote-tool": { name: "remote-tool", source: "user", transport: "remote", url: "https://mcp.example.com", headers: { Authorization: "Bearer token" } } })
  })

  test("effective config excludes disabled servers", async () => {
    await mod.saveUserConfig({ version: 3, connections: {},
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
