/**
 * Agent Hooks Core Setup
 *
 * Writes the reusable status-hook artifacts and returns a manifest that
 * host integrations can consume.
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "../../log"
import {
  CLAXEDO_DIR,
  CODEX_LOG_WATCHER,
  CODEX_NOTIFY,
  COPILOT_HOOK,
  CURSOR_HOOK,
  GEMINI_HOOK,
  NOTIFY_SCRIPT,
  DEBUG,
  SHIMMED_BINARIES,
  DEFAULT_GENERIC_WRAPPERS,
} from "./constants"
import { writeIfChanged } from "./utils"
import {
  cleanupCodexHooks,
  generateCodexLogWatcher,
  generateCodexNotify,
  generateCopilotHook,
  generateCursorHook,
  generateGeminiHook,
  generateNotifyScript,
  upsertClaudeSettings,
  upsertCodexHooks,
  upsertCursorHooks,
  upsertDroidSettings,
  upsertGeminiHooks,
  upsertMastraHooks,
} from "./hooks"
import {
  generateClaudeWrapper,
  generateCodexWrapper,
  generateCopilotWrapper,
  generateGenericWrapper,
  generatePassthroughWrapper,
  loadCustomWrappers,
  normalizeWrappers,
  saveCustomWrappers,
} from "./wrappers"
import {
  generateBashrc,
  generateZshenv,
  generateZshlogin,
  generateZshprofile,
  generateZshrc,
} from "./shell"

const log = Log.create({ service: "agent-hooks-core" })

export interface StatusHooksSetupOptions {
  port?: number
  force?: boolean
  wrappers?: string[]
  replaceWrappers?: boolean
}

export interface StatusHooksManifest {
  dirs: {
    root: string
    bin: string
    hooks: string
    shell: string
    bash: string
  }
  files: {
    notify: string
    codexNotify: string
    codexWatcher: string
    geminiHook: string
    cursorHook: string
    copilotHook: string
  }
}

export interface WriteStatusHooksOptions extends StatusHooksSetupOptions {
  configureExternal?: boolean
}

export function createStatusHooksManifest(root = CLAXEDO_DIR): StatusHooksManifest {
  const bin = path.join(root, "bin")
  const hooks = path.join(root, "hooks")
  const shell = path.join(root, "shell")
  const bash = path.join(root, "bash")
  return {
    dirs: { root, bin, hooks, shell, bash },
    files: {
      notify: path.join(hooks, NOTIFY_SCRIPT),
      codexNotify: path.join(hooks, CODEX_NOTIFY),
      codexWatcher: path.join(hooks, CODEX_LOG_WATCHER),
      geminiHook: path.join(hooks, GEMINI_HOOK),
      cursorHook: path.join(hooks, CURSOR_HOOK),
      copilotHook: path.join(hooks, COPILOT_HOOK),
    },
  }
}

export async function writeStatusHooksArtifacts(
  manifest: StatusHooksManifest,
  options: WriteStatusHooksOptions = {},
): Promise<StatusHooksManifest> {
  const {
    port = 7860,
    force = false,
    wrappers,
    replaceWrappers = false,
    configureExternal = true,
  } = options
  const codexNative = process.env.CLAXEDO_CODEX_NATIVE_HOOKS === "1"

  await fs.promises.mkdir(manifest.dirs.bin, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(manifest.dirs.hooks, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(manifest.dirs.shell, { recursive: true, mode: 0o755 })
  await fs.promises.mkdir(manifest.dirs.bash, { recursive: true, mode: 0o755 })

  await writeIfChanged(
    manifest.files.notify,
    generateNotifyScript(port, manifest.dirs.root),
    0o755,
    force,
  )
  if (!codexNative) {
    await writeIfChanged(
      manifest.files.codexWatcher,
      generateCodexLogWatcher(manifest.files.notify),
      0o755,
      force,
    )
    await writeIfChanged(
      manifest.files.codexNotify,
      generateCodexNotify(manifest.files.notify, manifest.files.codexWatcher),
      0o755,
      force,
    )
  }
  await writeIfChanged(manifest.files.geminiHook, generateGeminiHook(manifest.files.notify), 0o755, force)
  await writeIfChanged(manifest.files.cursorHook, generateCursorHook(manifest.files.notify), 0o755, force)
  await writeIfChanged(manifest.files.copilotHook, generateCopilotHook(manifest.files.notify), 0o755, force)

  await writeIfChanged(
    path.join(manifest.dirs.bin, "claude"),
    generateClaudeWrapper(manifest.files.notify),
    0o755,
    force,
  )
  await writeIfChanged(
    path.join(manifest.dirs.bin, "codex"),
    generateCodexWrapper({
      notifyPath: codexNative ? manifest.files.notify : manifest.files.codexNotify,
      watcherPath: manifest.files.codexWatcher,
      native: codexNative,
    }),
    0o755,
    force,
  )
  await writeIfChanged(path.join(manifest.dirs.bin, "droid"), generatePassthroughWrapper("droid"), 0o755, force)
  await writeIfChanged(path.join(manifest.dirs.bin, "gemini"), generatePassthroughWrapper("gemini"), 0o755, force)
  await writeIfChanged(path.join(manifest.dirs.bin, "cursor"), generatePassthroughWrapper("cursor"), 0o755, force)
  await writeIfChanged(
    path.join(manifest.dirs.bin, "cursor-agent"),
    generatePassthroughWrapper("cursor-agent"),
    0o755,
    force,
  )
  await writeIfChanged(
    path.join(manifest.dirs.bin, "copilot"),
    generateCopilotWrapper(manifest.files.copilotHook),
    0o755,
    force,
  )
  await writeIfChanged(
    path.join(manifest.dirs.bin, "mastracode"),
    generatePassthroughWrapper("mastracode"),
    0o755,
    force,
  )

  if (configureExternal) {
    await upsertClaudeSettings(manifest.files.notify, force).catch((err) => {
      log.warn("Failed to configure Claude settings", { err })
    })
    if (codexNative) {
      await upsertCodexHooks(manifest.files.notify, force).catch((err) => {
        log.warn("Failed to configure Codex hooks", { err })
      })
    } else {
      await cleanupCodexHooks(manifest.files.notify, force).catch((err) => {
        log.warn("Failed to clean Codex hooks", { err })
      })
    }
    await upsertDroidSettings(manifest.files.notify, force).catch((err) => {
      log.warn("Failed to configure Droid settings", { err })
    })
    await upsertGeminiHooks(manifest.files.geminiHook, force).catch((err) => {
      log.warn("Failed to configure Gemini hooks", { err })
    })
    await upsertCursorHooks(manifest.files.cursorHook, force).catch((err) => {
      log.warn("Failed to configure Cursor hooks", { err })
    })
    await upsertMastraHooks(manifest.files.notify, force).catch((err) => {
      log.warn("Failed to configure Mastra hooks", { err })
    })
  }

  const existing = await loadCustomWrappers(manifest.dirs.root)
  const incoming = normalizeWrappers(wrappers ?? [])
  const custom =
    wrappers === undefined
      ? existing
      : replaceWrappers
        ? await saveCustomWrappers(incoming, manifest.dirs.root)
        : await saveCustomWrappers([...existing, ...incoming], manifest.dirs.root)

  for (const agent of normalizeWrappers([...DEFAULT_GENERIC_WRAPPERS, ...custom]).filter(
    (item) => !SHIMMED_BINARIES.has(item),
  )) {
    await writeIfChanged(
      path.join(manifest.dirs.bin, agent),
      generateGenericWrapper(agent, manifest.files.notify),
      0o755,
      force,
    )
  }

  await writeIfChanged(path.join(manifest.dirs.shell, ".zshenv"), generateZshenv(), 0o644, force)
  await writeIfChanged(path.join(manifest.dirs.shell, ".zprofile"), generateZshprofile(), 0o644, force)
  await writeIfChanged(path.join(manifest.dirs.shell, ".zshrc"), generateZshrc(), 0o644, force)
  await writeIfChanged(path.join(manifest.dirs.shell, ".zlogin"), generateZshlogin(), 0o644, force)
  await writeIfChanged(path.join(manifest.dirs.bash, "rcfile"), generateBashrc(), 0o644, force)

  return manifest
}

export async function setupStatusHooks(options: StatusHooksSetupOptions = {}): Promise<StatusHooksManifest> {
  const { port = 7860, force = false } = options
  const manifest = createStatusHooksManifest()

  log.info("Setting up status hooks", { port, force, DEBUG })
  if (DEBUG) {
    log.info("Status hook directories", manifest.dirs)
  }

  return writeStatusHooksArtifacts(manifest, options)
}

export function isStatusHooksSetupComplete(): boolean {
  const manifest = createStatusHooksManifest()
  const required = [
    manifest.files.notify,
    manifest.files.geminiHook,
    manifest.files.cursorHook,
    manifest.files.copilotHook,
    path.join(manifest.dirs.bin, "claude"),
    path.join(manifest.dirs.bin, "codex"),
    path.join(manifest.dirs.bin, "gemini"),
    path.join(manifest.dirs.bin, "cursor"),
    path.join(manifest.dirs.bin, "cursor-agent"),
    path.join(manifest.dirs.bin, "copilot"),
    path.join(manifest.dirs.bin, "mastracode"),
    path.join(manifest.dirs.bin, "droid"),
    path.join(manifest.dirs.bin, "amp"),
    path.join(manifest.dirs.shell, ".zshrc"),
    path.join(manifest.dirs.shell, ".zlogin"),
    path.join(manifest.dirs.bash, "rcfile"),
  ]
  return required.every((file) => fs.existsSync(file))
}

export async function cleanupStatusHooks(): Promise<void> {
  await fs.promises.rm(CLAXEDO_DIR, { recursive: true, force: true })
}
