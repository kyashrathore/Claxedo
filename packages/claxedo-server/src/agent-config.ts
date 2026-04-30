/**
 * Centralized Agent Configuration
 *
 * Stores user-defined additions to the opencode agent config:
 *   - User MCP servers (beyond the managed claxedo-mcp)
 *   - Slash commands (markdown files in ~/.claxedo/opencode-config/command/)
 *
 * User config persisted at: ~/.claxedo/user-agent-config.json
 * Command .md files at:     ~/.claxedo/opencode-config/command/<name>.md
 *
 * The opencode wrapper sets OPENCODE_CONFIG_DIR=~/.claxedo/opencode-config/,
 * so opencode automatically picks up both the opencode.jsonc (MCP) and the
 * command/ directory (slash commands) on every startup.
 */

import * as fs from "fs"
import * as path from "path"
import os from "os"
import { Log } from "./log"
import { dataDir } from "./paths"
import type { SandboxConfig } from "./cloud/types"
import {
  loadManagedMcpState,
  mcpControl,
  resolveEffectiveMcp,
  runnerAgent,
  toOpencodeConfig,
  type ResolvedMcpServer,
} from "../../workspace-runtime/src/mcp-resolver"
import { resolveAllSecrets } from "./credentials/registry"

const log = Log.create({ service: "agent-config" })

const CLAXEDO_DIR = dataDir()
const OPENCODE_CONFIG_DIR = path.join(CLAXEDO_DIR, "opencode-config")
const COMMAND_DIR = path.join(OPENCODE_CONFIG_DIR, "command")
const USER_CONFIG_FILE = path.join(CLAXEDO_DIR, "user-agent-config.json")

// ── Types ──────────────────────────────────────────────────────────────────

export interface UserMcpServer {
  /** "stdio" spawns a local subprocess; "remote" connects to an HTTP/SSE endpoint */
  type: "stdio" | "remote"
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // remote
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export interface UserAgentConfig {
  mcp: Record<string, UserMcpServer>
  runner?: { type: RunnerType; binary?: string; model?: string }
  auth?: Record<string, string>  // providerID → API key, e.g. "claude-acp" → "sk-ant-..."
  sandbox?: SandboxConfig
  harness?: {
    mode?: "workspace" | "central"
  }
}

export interface RuntimeConfigSnapshot {
  version: 1
  mcp: Record<string, ResolvedMcpServer>
  runner: NonNullable<UserAgentConfig["runner"]>
  auth: Record<string, string>
}

export interface CommandItem {
  name: string
  content: string
}

export type AcpRunnerType = "claude-acp" | "codex-acp" | "cursor-acp"
export type RunnerType = AcpRunnerType | "opencode" | "pi"

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

function cursorBinary() {
  const bin = path.join(os.homedir(), ".local", "bin")
  const choices = [path.join(bin, "agent"), path.join(bin, "cursor-agent")]
  return choices.find((item) => fs.existsSync(item)) ?? "agent"
}

function acpBinary(type: AcpRunnerType) {
  if (type === "cursor-acp") return cursorBinary()
  const name = type === "codex-acp" ? "codex-acp" : "claude-agent-acp"
  // In packaged Electron app, CLAXEDO_ACP_DIR points to the resources/acp directory
  const acpDir = process.env.CLAXEDO_ACP_DIR
  if (acpDir) {
    const candidate = path.join(acpDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return path.resolve(import.meta.dirname, "../../workspace-runtime/node_modules/.bin", name)
}

// ── User config (MCP servers) ──────────────────────────────────────────────

export async function loadUserConfig(): Promise<UserAgentConfig> {
  try {
    const raw = await fs.promises.readFile(USER_CONFIG_FILE, "utf-8")
    const data = JSON.parse(raw) as Partial<UserAgentConfig>
    return {
      mcp: data.mcp ?? {},
      runner: data.runner,
      auth: data.auth ?? {},
      sandbox: data.sandbox ?? {},
      harness: data.harness ?? {},
    }
  } catch {
    return { mcp: {}, auth: {}, sandbox: {}, harness: {} }
  }
}

export async function saveUserConfig(config: UserAgentConfig): Promise<void> {
  await fs.promises.mkdir(CLAXEDO_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.writeFile(USER_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 })
  log.info("Saved user agent config", { mcpServers: Object.keys(config.mcp) })
}

export function defaultRunner(config?: UserAgentConfig): NonNullable<UserAgentConfig["runner"]> {
  if (config?.runner?.type) {
    if (config.runner.type === "opencode") return { type: "opencode" }
    if (config.runner.type === "pi") {
      return {
        type: "pi",
        ...(config.runner.model ? { model: config.runner.model } : {}),
      }
    }
    return {
      type: config.runner.type,
      binary: config.runner.binary ?? acpBinary(config.runner.type),
      ...(config.runner.model ? { model: config.runner.model } : {}),
    }
  }
  return { type: "opencode" }
}

async function runtimeMcp(config: UserAgentConfig, runner: NonNullable<UserAgentConfig["runner"]>) {
  const agent = runnerAgent(runner.type)
  if (!agent) return {}
  const state = await loadManagedMcpState()
  return resolveEffectiveMcp({
    state,
    agent,
    control: runner.type === "opencode" ? mcpControl("opencode") : "managed",
    userMcp: config.mcp,
    strict: runner.type !== "opencode" || !process.env.OPENCODE_URL,
  }).mcp
}

function codexCompatible(input: string | undefined) {
  if (!input) return false
  try {
    const value = JSON.parse(input) as Record<string, unknown>
    if (typeof value.OPENAI_API_KEY === "string" && value.OPENAI_API_KEY) return true
    if (value.type === "codex_auth") return true
    if (
      typeof value.auth_mode === "string"
      && value.tokens
      && typeof value.tokens === "object"
    ) return true
    return false
  } catch {
    return true
  }
}

export async function getRuntimeConfigSnapshot(
  current?: NonNullable<UserAgentConfig["runner"]>,
): Promise<RuntimeConfigSnapshot> {
  const config = await loadUserConfig()
  const runner = current ?? defaultRunner(config)
  const mcp = await runtimeMcp(config, runner)
  // Merge legacy config auth with credential registry secrets (registry takes precedence)
  const legacyAuth = config.auth ?? {}
  let registryAuth: Record<string, string> = {}
  try {
    registryAuth = await resolveAllSecrets()
  } catch {
    // Registry may not be initialized yet during early startup
  }
  const auth = { ...legacyAuth, ...registryAuth }
  if (!auth["codex-acp"] && codexCompatible(auth.openai)) auth["codex-acp"] = auth.openai
  if (!auth.openai && auth["codex-acp"]) auth.openai = auth["codex-acp"]
  return {
    version: 1,
    mcp,
    runner,
    auth,
  }
}

// ── Commands ───────────────────────────────────────────────────────────────

export async function listCommands(): Promise<CommandItem[]> {
  try {
    await fs.promises.mkdir(COMMAND_DIR, { recursive: true, mode: 0o755 })
    const files = await fs.promises.readdir(COMMAND_DIR)
    const commands: CommandItem[] = []
    for (const file of files) {
      if (!file.endsWith(".md")) continue
      const name = file.slice(0, -3)
      const content = await fs.promises.readFile(path.join(COMMAND_DIR, file), "utf-8")
      commands.push({ name, content })
    }
    return commands
  } catch {
    return []
  }
}

export async function getCommand(name: string): Promise<CommandItem | null> {
  const safe = sanitizeName(name)
  try {
    const content = await fs.promises.readFile(path.join(COMMAND_DIR, `${safe}.md`), "utf-8")
    return { name: safe, content }
  } catch {
    return null
  }
}

export async function saveCommand(name: string, content: string): Promise<string> {
  await fs.promises.mkdir(COMMAND_DIR, { recursive: true, mode: 0o755 })
  const safe = sanitizeName(name)
  await fs.promises.writeFile(path.join(COMMAND_DIR, `${safe}.md`), content, { mode: 0o644 })
  log.info("Saved command", { name: safe })
  return safe
}

export async function deleteCommand(name: string): Promise<boolean> {
  const safe = sanitizeName(name)
  try {
    await fs.promises.unlink(path.join(COMMAND_DIR, `${safe}.md`))
    log.info("Deleted command", { name: safe })
    return true
  } catch {
    return false
  }
}

// ── Full config for on-demand injection ───────────────────────────────────

/**
 * Returns the effective opencode config as a plain object, suitable for:
 *   - OPENCODE_CONFIG_CONTENT env var (pass to any opencode instance)
 *   - Display in the claxedo UI
 *
 * Includes managed MCP defaults plus user-defined MCP servers.
 */
export async function getEffectiveConfig(): Promise<Record<string, unknown>> {
  const userConfig = await loadUserConfig()
  const state = await loadManagedMcpState()
  return toOpencodeConfig(resolveEffectiveMcp({
    state,
    agent: "opencode",
    control: "generated-config",
    userMcp: userConfig.mcp,
    strict: true,
  }).mcp)
}
