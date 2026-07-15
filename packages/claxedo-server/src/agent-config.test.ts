import { describe, expect, test, beforeEach, afterAll, vi } from "vitest"
import { normalizeRuntimeSnapshot } from "@claxedo/workspace-runtime/config"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
const prevAcpDir = process.env.CLAXEDO_ACP_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./agent-config")
const { ControlPlaneAuthError } = await import("./control-plane/auth")

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

function processBinary(input: { connection?: { kind: string; binary?: string } }) {
  return input.connection?.kind === "process" ? input.connection.binary : undefined
}

describe("agent config", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    mod.configureAgentConfig({})
    delete process.env.CLAXEDO_ACP_DIR
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
    if (prevAcpDir === undefined) delete process.env.CLAXEDO_ACP_DIR
    else process.env.CLAXEDO_ACP_DIR = prevAcpDir
  })

  // ── defaultHarness ────────────────────────────────────────────────────

  test("defaults to opencode when no runner is configured", () => {
    expect(mod.defaultHarness()).toEqual({ id: "opencode", access: "native" })
    expect(mod.defaultHarness({ mcp: {}, auth: {} })).toEqual({ id: "opencode", access: "native" })
  })

  test("infers the codex binary when codex-acp is selected without an explicit path", () => {
    const runner = mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "codex-acp" },
    })
    expect(runner).toMatchObject({ id: "codex", access: "acp" })
    expect(processBinary(runner)).toContain("codex-acp")
  })

  test("uses injected ACP directory instead of ambient CLAXEDO_ACP_DIR", async () => {
    const ambient = path.join(root, "ambient-acp")
    const injected = path.join(root, "injected-acp")
    await fs.mkdir(ambient, { recursive: true })
    await fs.mkdir(injected, { recursive: true })
    await fs.writeFile(path.join(ambient, "codex-acp"), "")
    await fs.writeFile(path.join(injected, "codex-acp"), "")
    process.env.CLAXEDO_ACP_DIR = ambient

    expect(
      processBinary(mod.defaultHarness({
        mcp: {},
        auth: {},
        runner: { type: "codex-acp" },
      })),
    ).not.toBe(path.join(ambient, "codex-acp"))

    expect(
      processBinary(mod.defaultHarness(
        {
          mcp: {},
          auth: {},
          runner: { type: "codex-acp" },
        },
        { acpDir: injected },
      )),
    ).toBe(path.join(injected, "codex-acp"))

    mod.configureAgentConfig({ acpDir: injected })
    expect(
      processBinary(mod.defaultHarness({
        mcp: {},
        auth: {},
        runner: { type: "codex-acp" },
      })),
    ).toBe(path.join(injected, "codex-acp"))
  })

  test("infers a cursor binary when cursor-acp is selected without an explicit path", () => {
    const runner = mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "cursor-acp" },
    })
    expect(runner).toMatchObject({ id: "cursor", access: "acp" })
    expect(processBinary(runner)).toBeTruthy()
  })

  test("infers claude-agent-acp binary for claude-acp type", () => {
    const runner = mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })
    expect(runner).toMatchObject({ id: "claude", access: "acp" })
    expect(processBinary(runner)).toContain("claude-agent-acp")
  })

  test("preserves explicit binary path", () => {
    const runner = mod.defaultHarness({
      mcp: {},
      auth: {},
      runner: { type: "codex-acp", binary: "/custom/codex" },
    })
    expect(processBinary(runner)).toBe("/custom/codex")
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

  test("migrates legacy runner model to top-level config model", async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(cfgFile(), JSON.stringify({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", model: "claude-opus-4-6" },
    }))
    const config = await mod.loadUserConfig()
    expect(config.harness).toMatchObject({ id: "claude", access: "acp" })
    expect(config.model).toBe("claude-opus-4-6")
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
    expect(config.mcp).toEqual({})
    expect(config.auth).toEqual({})
    expect(config.harness).toBeUndefined()
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
      harness: { id: "claude" as const, access: "acp" as const },
      model: "claude-opus-4-6",
      auth: { "claude-acp": "sk-ant-test" },
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
      runner: { type: "codex-acp" },
      auth: { "codex-acp": "sk-test" },
    })
    await mod.saveCommand("triage", "Triage $ARGUMENTS")
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.version).toBe(2)
    expect(snap.mcp["test-mcp"]).toBeDefined()
    expect(snap.harnesses[0]).toMatchObject({ id: "codex", access: "acp" })
    expect(snap.auth["codex-acp"]).toBe("sk-test")
    expect("commands" in snap).toBe(false)
    expect(await mod.listCommands()).toContainEqual({ name: "triage", content: "Triage $ARGUMENTS" })
  })

  test("snapshot aliases OpenAI auth into codex-acp for runtime consumers", async () => {
    await mod.saveUserConfig({
      mcp: {},
      runner: { type: "codex-acp" },
      auth: {
        openai: "sk-openai-managed",
      },
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.auth.openai).toBe("sk-openai-managed")
    expect(snap.auth["codex-acp"]).toBe("sk-openai-managed")
  })

  test("snapshot does not alias plain OpenCode oauth auth into codex-acp", async () => {
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
    expect(snap.auth["codex-acp"]).toBeUndefined()
  })

  test("snapshot defaults harness to opencode when no harness configured", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.harnesses[0]).toEqual({ id: "opencode", access: "native" })
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
    await mod.saveUserConfig({ mcp: {}, auth: {} })

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

  // Forward wire contract: every snapshot the control plane pushes must be
  // accepted by the *current* workspace runtime validator. This guards
  // against emitter/validator drift like the `version: 2` rollout — if the
  // two sides disagree, `config push` fails with 400 and the composer never
  // unlocks. (Deployed sandboxes must run a matching runtime version; that
  // is enforced separately by the image version pin.)
  test("snapshot is accepted by the current workspace runtime validator", async () => {
    await mod.saveUserConfig({
      mcp: {},
      runner: { type: "claude-acp" },
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
      runner: { type: "claude-acp" },
      auth: {},
    })
    const snap = await mod.getRuntimeConfigSnapshot(undefined, {
      secretScope: "shared",
      workspaceDir: project,
      workspaceId: "ws_1",
      authority: unavailableWorkspaceAuthority(),
    })
    expect(normalizeRuntimeSnapshot(snap)).toBeDefined()
  })

  test("shared workspace Agent Extensions snapshot fails closed when Control Plane hydration is unavailable", async () => {
    const project = path.join(root, "project")
    await fs.mkdir(project, { recursive: true })
    await mod.saveUserConfig({ mcp: {}, auth: {} })

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
    await mod.saveUserConfig({ mcp: {}, auth: {} })

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
    await mod.saveUserConfig({ mcp: {}, auth: {} })

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
