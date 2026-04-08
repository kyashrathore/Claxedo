/**
 * Agent Hooks Setup
 *
 * Orchestration — wires together hooks, MCP, wrappers, shell, and plugins.
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "../log"
import { loadUserConfig } from "../agent-config"
import {
  loadManagedMcpState,
  resolveEffectiveMcp,
  resolveManagedMcp,
  saveManagedMcpState,
} from "../mcp-resolver"
import {
  BASH_DIR,
  BIN_DIR,
  CLAXEDO_DIR,
  COPILOT_HOOK,
  CURSOR_HOOK,
  DEBUG,
  DEFAULT_GENERIC_WRAPPERS,
  DOC_AGENT_MD,
  CODEX_NOTIFY,
  CODEX_LOG_WATCHER,
  GEMINI_HOOK,
  HOOKS_DIR,
  NOTIFY_SCRIPT,
  OPENCODE_AGENT_DIR,
  OPENCODE_CONFIG_DIR,
  OPENCODE_JSONC,
  OPENCODE_PLUGIN,
  OPENCODE_PLUGIN_DIR,
  SHELL_DIR,
  SHIMMED_BINARIES,
} from "./constants"
import { writeIfChanged } from "./utils"
import {
  generateNotifyScript,
  generateGeminiHook,
  generateCursorHook,
  generateCopilotHook,
  generateCodexLogWatcher,
  generateCodexNotify,
  upsertClaudeSettings,
  cleanupCodexHooks,
  upsertCodexHooks,
  upsertDroidSettings,
  upsertGeminiHooks,
  upsertCursorHooks,
  upsertMastraHooks,
} from "./hooks"
import {
  toStdio,
  upsertClaudeMcp,
  upsertGeminiMcp,
  upsertCursorMcp,
  generateOpencodeJsonc,
} from "./mcp"
import {
  generateClaudeWrapper,
  generateCodexWrapper,
  generatePassthroughWrapper,
  generateGenericWrapper,
  generateOpenCodeWrapper,
  generateCopilotWrapper,
  normalizeWrappers,
  loadCustomWrappers,
  saveCustomWrappers,
} from "./wrappers"
import {
  generateZshenv,
  generateZshprofile,
  generateZshrc,
  generateZshlogin,
  generateBashrc,
} from "./shell"
import { generateOpenCodePlugin, generateDocAgentMd } from "./plugins"

const log = Log.create({ service: "agent-hooks" })

// ── Setup options ──────────────────────────────────────────────────────────

export interface SetupOptions {
  port?: number
  force?: boolean
  wrappers?: string[]
  replaceWrappers?: boolean
}

// ── Main setup ─────────────────────────────────────────────────────────────

export async function setupAgentHooks(options: SetupOptions = {}): Promise<void> {
  const { port = 7860, force = false, wrappers, replaceWrappers = false } = options

  log.info("Setting up agent hooks", { port, force, DEBUG })

  if (DEBUG) {
    log.info("Agent hooks directories", { CLAXEDO_DIR, BIN_DIR, HOOKS_DIR, SHELL_DIR, BASH_DIR })
  }

  // Create directories
  await fs.promises.mkdir(BIN_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(HOOKS_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(SHELL_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(BASH_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(OPENCODE_PLUGIN_DIR, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(OPENCODE_AGENT_DIR, { recursive: true, mode: 0o755 })

  const codexNative = process.env.CLAXEDO_CODEX_NATIVE_HOOKS === "1"

  // Resolve hook paths
  const notifyPath = path.join(HOOKS_DIR, NOTIFY_SCRIPT)
  const codexNotifyPath = path.join(HOOKS_DIR, CODEX_NOTIFY)
  const codexWatcherPath = path.join(HOOKS_DIR, CODEX_LOG_WATCHER)
  const geminiHookPath = path.join(HOOKS_DIR, GEMINI_HOOK)
  const cursorHookPath = path.join(HOOKS_DIR, CURSOR_HOOK)
  const copilotHookPath = path.join(HOOKS_DIR, COPILOT_HOOK)

  // Write hook scripts
  await writeIfChanged(notifyPath, generateNotifyScript(port), 0o755, force)
  if (!codexNative) {
    await writeIfChanged(codexWatcherPath, generateCodexLogWatcher(notifyPath), 0o755, force)
    await writeIfChanged(codexNotifyPath, generateCodexNotify(notifyPath, codexWatcherPath), 0o755, force)
  }
  await writeIfChanged(geminiHookPath, generateGeminiHook(notifyPath), 0o755, force)
  await writeIfChanged(cursorHookPath, generateCursorHook(notifyPath), 0o755, force)
  await writeIfChanged(copilotHookPath, generateCopilotHook(notifyPath), 0o755, force)

  // Load managed MCP state
  const mcpConfig = await loadManagedMcpState(port)

  // Claude: wrapper + settings.json merge + MCP
  await writeIfChanged(path.join(BIN_DIR, "claude"), generateClaudeWrapper(notifyPath), 0o755, force)
  await upsertClaudeSettings(notifyPath, force).catch((error) => {
    log.warn("Failed to configure Claude settings", { error })
  })
  await upsertClaudeMcp(toStdio(resolveManagedMcp({
    state: mcpConfig,
    agent: "claude",
    control: "managed",
    strict: true,
  }).mcp), force)

  // Codex: wrapper + optional native hooks.json management
  await writeIfChanged(
    path.join(BIN_DIR, "codex"),
    generateCodexWrapper({
      notifyPath: codexNative ? notifyPath : codexNotifyPath,
      watcherPath: codexWatcherPath,
      native: codexNative,
    }),
    0o755,
    force,
  )
  if (codexNative) {
    await upsertCodexHooks(notifyPath, force).catch((error) => {
      log.warn("Failed to configure Codex hooks", { error })
    })
  } else {
    await cleanupCodexHooks(notifyPath, force).catch((error) => {
      log.warn("Failed to clean Codex hooks", { error })
    })
  }

  // OpenCode: wrapper + plugin
  await writeIfChanged(path.join(BIN_DIR, "opencode"), generateOpenCodeWrapper(), 0o755, force)
  await writeIfChanged(
    path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN),
    generateOpenCodePlugin(notifyPath),
    0o644,
    force,
  )

  // Droid (Factory): wrapper + settings.json merge
  await writeIfChanged(path.join(BIN_DIR, "droid"), generatePassthroughWrapper("droid"), 0o755, force)
  await upsertDroidSettings(notifyPath, force).catch((error) => {
    log.warn("Failed to configure Droid settings", { error })
  })

  // Amp: wrapper (no hook support yet)
  await writeIfChanged(path.join(BIN_DIR, "amp"), generatePassthroughWrapper("amp"), 0o755, force)

  // Passthrough wrappers (agents with native hook files)
  await writeIfChanged(path.join(BIN_DIR, "gemini"), generatePassthroughWrapper("gemini"), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "cursor"), generatePassthroughWrapper("cursor"), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "cursor-agent"), generatePassthroughWrapper("cursor-agent"), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "copilot"), generateCopilotWrapper(copilotHookPath), 0o755, force)
  await writeIfChanged(path.join(BIN_DIR, "mastracode"), generatePassthroughWrapper("mastracode"), 0o755, force)

  // Upsert native hook configs (merge to preserve user hooks)
  await upsertGeminiHooks(geminiHookPath, force).catch((error) => {
    log.warn("Failed to configure Gemini hooks", { error })
  })
  await upsertCursorHooks(cursorHookPath, force).catch((error) => {
    log.warn("Failed to configure Cursor hooks", { error })
  })
  await upsertMastraHooks(notifyPath, force).catch((error) => {
    log.warn("Failed to configure Mastra hooks", { error })
  })

  // Inject managed MCP servers into agent configs
  await upsertGeminiMcp(toStdio(resolveManagedMcp({
    state: mcpConfig,
    agent: "gemini",
    control: "generated-config",
    strict: true,
  }).mcp), force)
  await upsertCursorMcp(toStdio(resolveManagedMcp({
    state: mcpConfig,
    agent: "cursor",
    control: "managed",
    strict: true,
  }).mcp), force)

  // Custom wrappers
  const existingCustom = await loadCustomWrappers()
  const incoming = normalizeWrappers(wrappers ?? [])
  const custom =
    wrappers === undefined
      ? existingCustom
      : replaceWrappers
        ? await saveCustomWrappers(incoming)
        : await saveCustomWrappers([...existingCustom, ...incoming])

  // Generic wrappers
  for (const agent of normalizeWrappers([...DEFAULT_GENERIC_WRAPPERS, ...custom]).filter(
    (agent) => !SHIMMED_BINARIES.has(agent),
  )) {
    await writeIfChanged(path.join(BIN_DIR, agent), generateGenericWrapper(agent, notifyPath), 0o755, force)
  }

  // Doc agent config
  await writeIfChanged(path.join(OPENCODE_AGENT_DIR, DOC_AGENT_MD), generateDocAgentMd(), 0o644, force)

  // OpenCode MCP config (merges managed + user-defined)
  const userAgentConfig = await loadUserConfig()
  const opencode = resolveEffectiveMcp({
    state: mcpConfig,
    agent: "opencode",
    control: "managed",
    userMcp: userAgentConfig.mcp,
    strict: true,
  })
  await writeIfChanged(
    path.join(OPENCODE_CONFIG_DIR, OPENCODE_JSONC),
    generateOpencodeJsonc(opencode.mcp),
    0o644,
    force,
  )

  // Persist MCP config with current port (for toggle API)
  await saveManagedMcpState({ ...mcpConfig, port })

  // Shell integration
  await writeIfChanged(path.join(SHELL_DIR, ".zshenv"), generateZshenv(), 0o644, force)
  await writeIfChanged(path.join(SHELL_DIR, ".zprofile"), generateZshprofile(), 0o644, force)
  await writeIfChanged(path.join(SHELL_DIR, ".zshrc"), generateZshrc(), 0o644, force)
  await writeIfChanged(path.join(SHELL_DIR, ".zlogin"), generateZshlogin(), 0o644, force)
  await writeIfChanged(path.join(BASH_DIR, "rcfile"), generateBashrc(), 0o644, force)

  log.info("Agent hooks setup complete", { binDir: BIN_DIR })
}

// ── Status check ───────────────────────────────────────────────────────────

export function isSetupComplete(): boolean {
  const requiredFiles = [
    path.join(HOOKS_DIR, NOTIFY_SCRIPT),
    path.join(HOOKS_DIR, GEMINI_HOOK),
    path.join(HOOKS_DIR, CURSOR_HOOK),
    path.join(HOOKS_DIR, COPILOT_HOOK),
    path.join(BIN_DIR, "claude"),
    path.join(BIN_DIR, "codex"),
    path.join(BIN_DIR, "opencode"),
    path.join(BIN_DIR, "gemini"),
    path.join(BIN_DIR, "cursor"),
    path.join(BIN_DIR, "cursor-agent"),
    path.join(BIN_DIR, "copilot"),
    path.join(BIN_DIR, "mastracode"),
    path.join(BIN_DIR, "droid"),
    path.join(BIN_DIR, "amp"),
    path.join(OPENCODE_PLUGIN_DIR, OPENCODE_PLUGIN),
    path.join(SHELL_DIR, ".zshrc"),
    path.join(SHELL_DIR, ".zlogin"),
    path.join(BASH_DIR, "rcfile"),
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
