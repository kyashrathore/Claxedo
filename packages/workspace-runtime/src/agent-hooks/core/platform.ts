import path from "node:path"
import type { StatusHookTemplate } from "@claxedo/plugin-api"

export type HookPlatform = "posix" | "windows"

export function hookPlatform(platform: NodeJS.Platform = process.platform): HookPlatform {
  return platform === "win32" ? "windows" : "posix"
}

/** Each template as `platform` installs it; a template that declares no Windows installation has none there. */
export function installedTemplates(
  templates: readonly StatusHookTemplate[],
  platform: HookPlatform,
): StatusHookTemplate[] {
  if (platform === "posix") return [...templates]
  return templates.flatMap(({ windows, artifacts: _artifacts, wrapper: _wrapper, ...template }) =>
    windows
      ? [
          {
            ...template,
            install: windows.install ?? template.install,
            ...(windows.artifacts ? { artifacts: windows.artifacts } : {}),
            ...(windows.wrapper === undefined ? {} : { wrapper: windows.wrapper }),
          },
        ]
      : [],
  )
}

/**
 * cmd.exe by its full path, which starts the same way from cmd.exe and from PowerShell. Codex runs a Windows
 * hook command with `powershell -NoProfile -Command`, where a quoted script path is a string, not a command,
 * and a bare `cmd` would first go through PowerShell's command discovery.
 */
export const WINDOWS_CMD = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe")

export function notifyScriptName(platform: HookPlatform) {
  return platform === "windows" ? "notify.cmd" : "notify.sh"
}

/** cmd.exe and PowerShell resolve a bare command through PATHEXT, which has no entry for an extensionless file. */
export function wrapperFile(bin: string, command: string, platform: HookPlatform) {
  return path.join(bin, platform === "windows" ? `${command}.cmd` : command)
}

export function wrappedCommands(template: StatusHookTemplate) {
  return template.wrapper === false ? [] : [template.command, ...(template.aliases ?? [])]
}
