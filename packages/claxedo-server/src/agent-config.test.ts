import { describe, expect, test, beforeEach, afterAll } from "vitest"
import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `agent-config-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./agent-config")

function cfgFile() {
  return path.join(root, "user-agent-config.json")
}

function cmdDir() {
  return path.join(root, "opencode-config", "command")
}

describe("agent config", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  // ── defaultRunner ────────────────────────────────────────────────────

  test("defaults to opencode when no runner is configured", () => {
    expect(mod.defaultRunner()).toEqual({ type: "opencode" })
    expect(mod.defaultRunner({ mcp: {}, auth: {} })).toEqual({ type: "opencode" })
  })

  test("infers the codex binary when codex-acp is selected without an explicit path", () => {
    const runner = mod.defaultRunner({
      mcp: {},
      auth: {},
      runner: { type: "codex-acp" },
    })
    expect(runner.type).toBe("codex-acp")
    expect(runner.binary).toContain("codex-acp")
  })

  test("infers a cursor binary when cursor-acp is selected without an explicit path", () => {
    const runner = mod.defaultRunner({
      mcp: {},
      auth: {},
      runner: { type: "cursor-acp" },
    })
    expect(runner.type).toBe("cursor-acp")
    expect(runner.binary).toBeTruthy()
  })

  test("infers claude-agent-acp binary for claude-acp type", () => {
    const runner = mod.defaultRunner({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp" },
    })
    expect(runner.type).toBe("claude-acp")
    expect(runner.binary).toContain("claude-agent-acp")
  })

  test("preserves explicit binary path", () => {
    const runner = mod.defaultRunner({
      mcp: {},
      auth: {},
      runner: { type: "codex-acp", binary: "/custom/codex" },
    })
    expect(runner.binary).toBe("/custom/codex")
  })

  test("preserves model when provided", () => {
    const runner = mod.defaultRunner({
      mcp: {},
      auth: {},
      runner: { type: "claude-acp", model: "claude-opus-4-6" },
    })
    expect(runner.model).toBe("claude-opus-4-6")
  })

  test("opencode runner has no binary or model", () => {
    const runner = mod.defaultRunner({
      mcp: {},
      auth: {},
      runner: { type: "opencode" },
    })
    expect(runner).toEqual({ type: "opencode" })
    expect(runner.binary).toBeUndefined()
    expect(runner.model).toBeUndefined()
  })

  // ── loadUserConfig / saveUserConfig ──────────────────────────────────

  test("returns default config when file does not exist", async () => {
    const config = await mod.loadUserConfig()
    expect(config.mcp).toEqual({})
    expect(config.auth).toEqual({})
    expect(config.harness).toEqual({})
    expect(config.runner).toBeUndefined()
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
      runner: { type: "claude-acp" as const, model: "claude-opus-4-6" },
      auth: { "claude-acp": "sk-ant-test" },
      sandbox: {},
      harness: { mode: "central" as const },
    }
    await mod.saveUserConfig(original)
    const loaded = await mod.loadUserConfig()

    expect(loaded.mcp["my-server"]).toEqual(original.mcp["my-server"])
    expect(loaded.runner).toEqual(original.runner)
    expect(loaded.auth).toEqual(original.auth)
    expect(loaded.harness).toEqual(original.harness)
  })

  test("save creates directory if it doesn't exist", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const exists = await fs.stat(cfgFile()).then(() => true).catch(() => false)
    expect(exists).toBe(true)
  })

  // ── getRuntimeConfigSnapshot ────────────────────────────────────────

  test("snapshot includes version, mcp, runner, and auth", async () => {
    await mod.saveUserConfig({
      mcp: { "test-mcp": { type: "remote", url: "http://localhost:9000" } },
      runner: { type: "codex-acp" },
      auth: { "codex-acp": "sk-test" },
    })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.version).toBe(1)
    expect(snap.mcp["test-mcp"]).toBeDefined()
    expect(snap.runner.type).toBe("codex-acp")
    expect(snap.auth["codex-acp"]).toBe("sk-test")
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
    expect(snap.auth.openai).toBe(JSON.stringify({
      type: "oauth",
      refresh: "refresh-openai",
      access: "access-openai",
      expires: 1_790_000_000_000,
    }))
    expect(snap.auth["codex-acp"]).toBeUndefined()
  })

  test("snapshot defaults runner to opencode when no runner configured", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const snap = await mod.getRuntimeConfigSnapshot()
    expect(snap.runner.type).toBe("opencode")
  })

  // ── getEffectiveConfig ──────────────────────────────────────────────

  test("effective config includes managed MCP defaults when no user MCP servers exist", async () => {
    await mod.saveUserConfig({ mcp: {}, auth: {} })
    const config = await mod.getEffectiveConfig()
    const mcp = config.mcp as Record<string, { type: string; command: string[] }>
    expect(mcp["claxedo-mcp"]).toBeDefined()
    expect(mcp["claxedo-mcp"].type).toBe("local")
  })

  test("effective config transforms stdio servers into local format", async () => {
    await mod.saveUserConfig({
      mcp: {
        "my-tool": {
          type: "stdio",
          command: "npx",
          args: ["-y", "tool-server"],
          env: { DEBUG: "1" },
        },
      },
      auth: {},
    })
    const config = await mod.getEffectiveConfig()
    expect(config.mcp).toBeDefined()
    const mcp = config.mcp as Record<string, { type: string; command: string[]; environment: Record<string, string> }>
    expect(mcp["claxedo-mcp"]).toBeDefined()
    expect(mcp["my-tool"].type).toBe("local")
    expect(mcp["my-tool"].command).toEqual(["npx", "-y", "tool-server"])
    expect(mcp["my-tool"].environment).toEqual({ DEBUG: "1" })
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
    expect(mcp["claxedo-mcp"]).toBeDefined()
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
    expect(mcp["claxedo-mcp"]).toBeDefined()
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
