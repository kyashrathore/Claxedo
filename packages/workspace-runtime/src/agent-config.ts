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
import { Log } from "./log"
import { dataDir } from "./paths"
import { loadManagedMcpState, resolveEffectiveMcp, toOpencodeConfig } from "./mcp-resolver"

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
}

export interface CommandItem {
  name: string
  content: string
}

// ── Helpers ────────────────────────────────────────────────────────────────

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64)
}

// ── User config (MCP servers) ──────────────────────────────────────────────

export async function loadUserConfig(): Promise<UserAgentConfig> {
  try {
    const raw = await fs.promises.readFile(USER_CONFIG_FILE, "utf-8")
    const data = JSON.parse(raw) as Partial<UserAgentConfig>
    return { mcp: data.mcp ?? {} }
  } catch {
    return { mcp: {} }
  }
}

export async function saveUserConfig(config: UserAgentConfig): Promise<void> {
  await fs.promises.mkdir(CLAXEDO_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.writeFile(USER_CONFIG_FILE, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 })
  log.info("Saved user agent config", { mcpServers: Object.keys(config.mcp) })
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
