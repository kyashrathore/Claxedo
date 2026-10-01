import * as fs from "fs"
import * as path from "path"
import type { StatusHookTemplate } from "@claxedo/plugin-api"
import { CLAXEDO_DIR, NOTIFY_SCRIPT } from "./constants"
import { writeIfChanged } from "./utils"
import { generateNotifyScript } from "./hooks"
import { hookArtifact } from "./render"
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
  dirs: { root: string; bin: string; hooks: string; shell: string; bash: string }
  files: { notify: string }
}

export interface WriteStatusHooksOptions extends StatusHooksSetupOptions {
  templates: readonly StatusHookTemplate[]
  genericWrappers?: readonly string[]
}

export function createStatusHooksManifest(root = CLAXEDO_DIR): StatusHooksManifest {
  const hooks = path.join(root, "hooks")
  return {
    dirs: { root, bin: path.join(root, "bin"), hooks, shell: path.join(root, "shell"), bash: path.join(root, "bash") },
    files: { notify: path.join(hooks, NOTIFY_SCRIPT) },
  }
}

export async function writeStatusHooksArtifacts(
  manifest: StatusHooksManifest,
  options: WriteStatusHooksOptions,
): Promise<StatusHooksManifest> {
  const { port = 7860, force = false, wrappers, replaceWrappers = false, templates, genericWrappers = [] } = options
  for (const dir of Object.values(manifest.dirs)) await fs.promises.mkdir(dir, { recursive: true, mode: 0o755 })
  await writeIfChanged(manifest.files.notify, generateNotifyScript(port, templates), 0o755, force)
  for (const template of templates) {
    for (const artifact of template.artifacts ?? []) {
      const file = path.join(manifest.dirs.hooks, artifact.file)
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      await writeIfChanged(file, hookArtifact(template, artifact.file, manifest.files.notify), artifact.mode, force)
    }
    for (const command of template.wrapper === false ? [] : [template.command, ...(template.aliases ?? [])]) {
      await writeIfChanged(
        path.join(manifest.dirs.bin, command),
        generateTemplateWrapper(template, manifest.files.notify, command),
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
      path.join(manifest.dirs.bin, agent),
      generateGenericWrapper(agent, manifest.files.notify),
      0o755,
      force,
    )
  }
  for (const [file, content] of [
    [path.join(manifest.dirs.shell, ".zshenv"), generateZshenv()],
    [path.join(manifest.dirs.shell, ".zprofile"), generateZshprofile()],
    [path.join(manifest.dirs.shell, ".zshrc"), generateZshrc()],
    [path.join(manifest.dirs.shell, ".zlogin"), generateZshlogin()],
    [path.join(manifest.dirs.bash, "rcfile"), generateBashrc()],
  ])
    await writeIfChanged(file, content, 0o644, force)
  return manifest
}

export function isStatusHooksSetupComplete(templates: readonly StatusHookTemplate[]): boolean {
  const manifest = createStatusHooksManifest()
  const required = [
    manifest.files.notify,
    ...templates.flatMap((template) => [
      ...(template.artifacts ?? []).map((artifact) => path.join(manifest.dirs.hooks, artifact.file)),
      ...(template.wrapper === false ? [] : [template.command, ...(template.aliases ?? [])]).map((command) =>
        path.join(manifest.dirs.bin, command),
      ),
    ]),
    path.join(manifest.dirs.shell, ".zshrc"),
    path.join(manifest.dirs.shell, ".zlogin"),
    path.join(manifest.dirs.bash, "rcfile"),
  ]
  return required.every((file) => fs.existsSync(file))
}
