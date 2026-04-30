/**
 * Agent Hooks Setup
 *
 * Orchestration — wires together core status hooks and Claxedo integrations.
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "../log"
import { loadUserConfig } from "../agent-config"
import {
  loadManagedMcpState,
  resolveEffectiveMcp,
  saveManagedMcpState,
} from "../mcp-resolver"
import {
  BIN_DIR,
  CLAXEDO_DIR,
  DEBUG,
  DOC_AGENT_MD,
  OPENCODE_AGENT_DIR,
  OPENCODE_CONFIG_DIR,
  OPENCODE_JSONC,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_DIR,
} from "./constants"
import { setupStatusHooks, isStatusHooksSetupComplete, type StatusHooksSetupOptions } from "./core/setup"
import { applyManagedMcpSetup } from "./integrations/mcp"
import { setupOpencodeIntegration } from "./integrations/opencode/setup"

const log = Log.create({ service: "agent-hooks" })

// ── Setup options ──────────────────────────────────────────────────────────

export type SetupOptions = StatusHooksSetupOptions

// ── Main setup ─────────────────────────────────────────────────────────────

export async function setupAgentHooks(options: SetupOptions = {}): Promise<void> {
  const { port = 7860, force = false, wrappers, replaceWrappers = false } = options

  log.info("Setting up agent hooks", { port, force, DEBUG })

  const manifest = await setupStatusHooks({ port, force, wrappers, replaceWrappers })
  const mcpConfig = await loadManagedMcpState(port)
  await applyManagedMcpSetup({ state: mcpConfig, force })
  const userAgentConfig = await loadUserConfig()
  const opencode = resolveEffectiveMcp({
    state: mcpConfig,
    agent: "opencode",
    control: "managed",
    userMcp: userAgentConfig.mcp,
    strict: true,
  })
  await setupOpencodeIntegration({ manifest, force, mcp: opencode.mcp })

  // Persist MCP config with current port (for toggle API)
  await saveManagedMcpState({ ...mcpConfig, port })

  log.info("Agent hooks setup complete", { binDir: BIN_DIR })
}

// ── Status check ───────────────────────────────────────────────────────────

export function isSetupComplete(): boolean {
  if (!isStatusHooksSetupComplete()) return false
  const requiredFiles = [
    path.join(BIN_DIR, "opencode"),
    path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN),
    path.join(OPENCODE_AGENT_DIR, DOC_AGENT_MD),
    path.join(OPENCODE_CONFIG_DIR, OPENCODE_JSONC),
  ]
  return requiredFiles.every((file) => fs.existsSync(file))
}

// ── Cleanup ────────────────────────────────────────────────────────────────

export async function cleanupAgentHooks(): Promise<void> {
  log.info("Cleaning up agent hooks")
  await fs.promises.rm(CLAXEDO_DIR, { recursive: true, force: true })
  log.info("Agent hooks cleanup complete")
}
