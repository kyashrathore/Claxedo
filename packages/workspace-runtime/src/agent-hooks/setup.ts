/**
 * Agent Hooks Setup
 *
 * Orchestration — wires together core status hooks and Claxedo integrations.
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { materializeAgentHooks, OPENCODE_DOC_AGENT_FILE } from "@claxedo/agent-extensions"
import { Log } from "../log"
import {
  BIN_DIR,
  CLAXEDO_DIR,
} from "./core/constants"
import { setupStatusHooks, isStatusHooksSetupComplete, type StatusHooksSetupOptions } from "./core/setup"
import {
  OPENCODE_PLUGIN,
  opencodeAgentDir,
  opencodePluginDir,
} from "./opencode/constants"
import { setupOpencodeIntegration } from "./opencode/setup"

const log = Log.create({ service: "agent-hooks" })

// ── Setup options ──────────────────────────────────────────────────────────

export type SetupOptions = StatusHooksSetupOptions

// ── Main setup ─────────────────────────────────────────────────────────────

export async function setupAgentHooks(options: SetupOptions = {}): Promise<void> {
  const {
    port = 7860,
    force = false,
    wrappers,
    replaceWrappers = false,
    codexNativeHooks = process.env.CLAXEDO_CODEX_NATIVE_HOOKS === "1",
  } = options

  log.info("Setting up agent hooks", { port, force })

  const manifest = await setupStatusHooks({ port, force, wrappers, replaceWrappers, codexNativeHooks })
  const results = await materializeAgentHooks({
    homeDir: os.homedir(),
    notifyPath: manifest.files.notify,
    geminiHookPath: manifest.files.geminiHook,
    cursorHookPath: manifest.files.cursorHook,
    codexNativeHooks,
    force,
  })
  for (const result of results) {
    if (result.status !== "failed") continue
    log.warn("Failed to materialize agent hooks", { runner: result.runner, path: result.path, reason: result.reason })
  }
  await setupOpencodeIntegration({ manifest, force })

  log.info("Agent hooks setup complete", { binDir: BIN_DIR })
}

// ── Status check ───────────────────────────────────────────────────────────

export function isSetupComplete(): boolean {
  if (!isStatusHooksSetupComplete()) return false
  const requiredFiles = [
    path.join(BIN_DIR, "opencode"),
    path.join(opencodePluginDir(CLAXEDO_DIR), OPENCODE_PLUGIN),
    path.join(opencodeAgentDir(CLAXEDO_DIR), OPENCODE_DOC_AGENT_FILE),
  ]
  return requiredFiles.every((file) => fs.existsSync(file))
}

// ── Cleanup ────────────────────────────────────────────────────────────────

export async function cleanupAgentHooks(): Promise<void> {
  log.info("Cleaning up agent hooks")
  await fs.promises.rm(CLAXEDO_DIR, { recursive: true, force: true })
  log.info("Agent hooks cleanup complete")
}
