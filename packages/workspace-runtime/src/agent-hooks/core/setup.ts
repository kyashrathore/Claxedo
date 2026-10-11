import * as fs from "fs"
import * as path from "path"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { CLAXEDO_DIR } from "./constants"
import { writeIfChanged } from "./utils"
import { generateNotifyScript } from "./hooks"
import { hookArtifact } from "./render"
import {
  hookPlatform,
  installedTemplates,
  notifyScriptName,
  wrappedCommands,
  wrapperFile,
  type HookPlatform,
} from "./platform"
import {
  generateTemplateWrapper,
  generateGenericWrapper,
  loadCustomWrappers,
  normalizeWrappers,
  saveCustomWrappers,
} from "./wrappers"
import { generateBashrc, generateZshenv, generateZshlogin, generateZshprofile, generateZshrc } from "./shell"

export interface StatusHooksSetupOptions {
  port?: number
  force?: boolean
  wrappers?: string[]
  replaceWrappers?: boolean
}

export interface StatusHooksManifest {
  platform: HookPlatform
  dirs: { root: string; bin: string; hooks: string; shell: string; bash: string }
  files: { notify: string }
}

export interface WriteStatusHooksOptions extends StatusHooksSetupOptions {
  templates: readonly StatusHookTemplate[]
  genericWrappers?: readonly string[]
}

export function createStatusHooksManifest(root = CLAXEDO_DIR, platform = hookPlatform()): StatusHooksManifest {
  const hooks = path.join(root, "hooks")
  return {
    platform,
    dirs: { root, bin: path.join(root, "bin"), hooks, shell: path.join(root, "shell"), bash: path.join(root, "bash") },
    files: { notify: path.join(hooks, notifyScriptName(platform)) },
  }
}

/** The zsh and bash startup files; cmd.exe and PowerShell find the wrappers through PATH alone. */
function shellIntegrationFiles(manifest: StatusHooksManifest): [string, () => string][] {
  if (manifest.platform === "windows") return []
  return [
    [path.join(manifest.dirs.shell, ".zshenv"), generateZshenv],
    [path.join(manifest.dirs.shell, ".zprofile"), generateZshprofile],
    [path.join(manifest.dirs.shell, ".zshrc"), generateZshrc],
    [path.join(manifest.dirs.shell, ".zlogin"), generateZshlogin],
    [path.join(manifest.dirs.bash, "rcfile"), generateBashrc],
  ]
}

export async function writeStatusHooksArtifacts(
  manifest: StatusHooksManifest,
  options: WriteStatusHooksOptions,
): Promise<StatusHooksManifest> {
  const { port = 7860, force = false, wrappers, replaceWrappers = false, templates, genericWrappers = [] } = options
  const { platform } = manifest
  const shellFiles = shellIntegrationFiles(manifest)
  for (const dir of [manifest.dirs.root, manifest.dirs.bin, manifest.dirs.hooks, ...shellFiles.map(([file]) => path.dirname(file))])
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 })
  await writeIfChanged(manifest.files.notify, generateNotifyScript(port, templates, platform), 0o755, force)
  for (const template of installedTemplates(templates, platform)) {
    for (const artifact of template.artifacts ?? []) {
      const file = path.join(manifest.dirs.hooks, artifact.file)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await writeIfChanged(
        file,
        hookArtifact(template, artifact.file, manifest.files.notify, platform),
        artifact.mode,
        force,
      )
    }
    for (const command of wrappedCommands(template)) {
      await writeIfChanged(
        wrapperFile(manifest.dirs.bin, command, platform),
        generateTemplateWrapper(template, manifest.files.notify, platform, command),
        0o755,
        force,
      )
    }
  }
  const existing = await loadCustomWrappers(manifest.dirs.root)
  const incoming = normalizeWrappers(wrappers ?? [])
  const custom =
    wrappers === undefined
      ? existing
      : await saveCustomWrappers(replaceWrappers ? incoming : [...existing, ...incoming], manifest.dirs.root)
  const shimmed = new Set(templates.flatMap((template) => [template.command, ...(template.aliases ?? [])]))
  for (const agent of normalizeWrappers([...genericWrappers, ...custom]).filter((item) => !shimmed.has(item))) {
    await writeIfChanged(
      wrapperFile(manifest.dirs.bin, agent, platform),
      generateGenericWrapper(agent, manifest.files.notify, platform),
      0o755,
      force,
    )
  }
  for (const [file, generate] of shellFiles) await writeIfChanged(file, generate(), 0o644, force)
  return manifest
}

export function isStatusHooksSetupComplete(templates: readonly StatusHookTemplate[], platform = hookPlatform()): boolean {
  const manifest = createStatusHooksManifest(CLAXEDO_DIR, platform)
  const required = [
    manifest.files.notify,
    ...installedTemplates(templates, platform).flatMap((template) => [
      ...(template.artifacts ?? []).map((artifact) => path.join(manifest.dirs.hooks, artifact.file)),
      ...wrappedCommands(template).map((command) => wrapperFile(manifest.dirs.bin, command, platform)),
    ]),
    ...shellIntegrationFiles(manifest).map(([file]) => file),
  ]
  return required.every((file) => fs.existsSync(file))
}
