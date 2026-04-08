/**
 * MCP Server Management
 *
 * Types, upsert into agent configs, toggle API, opencode.jsonc generation.
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "../log"
import { loadUserConfig } from "../agent-config"
import {
  MCP_CAPABLE_AGENTS,
  MANAGED_MCP_SERVERS,
  type ManagedMcpServer,
  type McpCapableAgent,
  type ManagedMcpState,
  type ResolvedMcpServer,
  describeManagedMcp,
  isManagedMcpServer,
  loadManagedMcpState,
  mcpControl,
  resolveEffectiveMcp,
  setManagedMcpOverride,
  toOpencodeConfig,
} from "../mcp-resolver"
import {
  CLAUDE_MCP_PATH,
  CURSOR_MCP_PATH,
  GEMINI_SETTINGS_PATH,
  HOOKS_DIR,
  NOTIFY_SCRIPT,
  OPENCODE_CONFIG_DIR,
  OPENCODE_JSONC,
} from "./constants"
import { asRecord, readJSON, writeIfChanged } from "./utils"
import { upsertClaudeSettings } from "./hooks"

const log = Log.create({ service: "agent-hooks" })

// ── Types ───────────────────────────────────────────────────────────────────

export type McpConfig = {
  command: string
  args: string[]
  env: Record<string, string>
}

export const toStdio = (mcp: Record<string, ResolvedMcpServer>) => {
  const out: Record<string, McpConfig> = {}
  for (const [name, cfg] of Object.entries(mcp)) {
    if (cfg.transport !== "stdio") continue
    out[name] = { command: cfg.command, args: cfg.args, env: cfg.env }
  }
  return out
}

// ── Upsert MCP into agent configs ───────────────────────────────────────────

const applyMcp = (root: Record<string, unknown>, mcp: Record<string, McpConfig>) => {
  const mcpServers = asRecord(root.mcpServers)
  for (const server of MANAGED_MCP_SERVERS) {
    delete mcpServers[server]
  }
  for (const [server, cfg] of Object.entries(mcp)) {
    mcpServers[server] = cfg
  }

  if (Object.keys(mcpServers).length > 0) {
    root.mcpServers = mcpServers
    return
  }
  delete root.mcpServers
}

const applyClaudeMcp = (root: Record<string, unknown>, mcp: Record<string, McpConfig>) => {
  const list = asRecord(root.mcpServers)
  for (const server of MANAGED_MCP_SERVERS) {
    delete list[server]
  }
  for (const [server, cfg] of Object.entries(mcp)) {
    list[server] = { type: "stdio", command: cfg.command, args: cfg.args, env: cfg.env }
  }

  if (Object.keys(list).length > 0) {
    root.mcpServers = list
    return
  }
  delete root.mcpServers
}

export const upsertGeminiMcp = async (mcp: Record<string, McpConfig>, force: boolean) => {
  await fs.promises.mkdir(path.dirname(GEMINI_SETTINGS_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(GEMINI_SETTINGS_PATH))
  applyMcp(root, mcp)
  await writeIfChanged(GEMINI_SETTINGS_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

export const upsertClaudeMcp = async (mcp: Record<string, McpConfig>, force: boolean) => {
  const root = asRecord(await readJSON(CLAUDE_MCP_PATH))
  applyClaudeMcp(root, mcp)
  await writeIfChanged(CLAUDE_MCP_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

export const upsertCursorMcp = async (mcp: Record<string, McpConfig>, force: boolean) => {
  await fs.promises.mkdir(path.dirname(CURSOR_MCP_PATH), { recursive: true, mode: 0o755 })
  const root = asRecord(await readJSON(CURSOR_MCP_PATH))
  applyMcp(root, mcp)
  await writeIfChanged(CURSOR_MCP_PATH, JSON.stringify(root, null, 2) + "\n", 0o644, force)
}

// ── Config generation ───────────────────────────────────────────────────────

export function generateOpencodeJsonc(mcp: Record<string, ResolvedMcpServer>): string {
  return JSON.stringify(toOpencodeConfig(mcp), null, 2) + "\n"
}

// ── Toggle API ──────────────────────────────────────────────────────────────

export type McpAgentsState = ManagedMcpState

export async function loadMcpAgentConfig(): Promise<McpAgentsState> {
  return loadManagedMcpState()
}

export function describeAgentMcp(server: ManagedMcpServer, agent: McpCapableAgent, state: McpAgentsState) {
  return describeManagedMcp(state, server, agent, mcpControl(agent))
}

export async function toggleAgentMcp(server: string, agent: string, enabled: boolean): Promise<void> {
  if (!isManagedMcpServer(server)) {
    throw new Error(`Unknown managed MCP server: ${server}`)
  }
  if (!MCP_CAPABLE_AGENTS.includes(agent as McpCapableAgent)) {
    throw new Error(`Unknown MCP-capable agent: ${agent}`)
  }
  const state = await setManagedMcpOverride(server, agent as McpCapableAgent, enabled)

  const { port } = state
  const force = true
  const row = agent as McpCapableAgent
  const control = row === "gemini" ? "generated-config" : mcpControl(row)
  const mcp = resolveEffectiveMcp({
    state,
    agent: row,
    control,
    ...(row === "opencode" ? { userMcp: (await loadUserConfig()).mcp } : {}),
    strict: true,
  }).mcp

  switch (agent) {
    case "claude": {
      const notifyPath = path.join(HOOKS_DIR, NOTIFY_SCRIPT)
      await upsertClaudeSettings(notifyPath, force)
      await upsertClaudeMcp(toStdio(mcp), force)
      break
    }
    case "codex":
      break
    case "gemini":
      await upsertGeminiMcp(toStdio(mcp), force)
      break
    case "cursor":
      await upsertCursorMcp(toStdio(mcp), force)
      break
    case "opencode": {
      await writeIfChanged(
        path.join(OPENCODE_CONFIG_DIR, OPENCODE_JSONC),
        generateOpencodeJsonc(mcp),
        0o644,
        force,
      )
      break
    }
    default:
      log.warn("Unknown MCP-capable agent", { agent })
  }
}

export async function rebuildOpencodeJsonc(): Promise<void> {
  const mcpState = await loadMcpAgentConfig()
  const userCfg = await loadUserConfig()
  const mcp = resolveEffectiveMcp({
    state: mcpState,
    agent: "opencode",
    control: "managed",
    userMcp: userCfg.mcp,
    strict: true,
  }).mcp
  await fs.promises.mkdir(OPENCODE_CONFIG_DIR, { recursive: true, mode: 0o755 })
  await writeIfChanged(
    path.join(OPENCODE_CONFIG_DIR, OPENCODE_JSONC),
    generateOpencodeJsonc(mcp),
    0o644,
    true,
  )
  log.info("Rebuilt opencode.jsonc")
}
