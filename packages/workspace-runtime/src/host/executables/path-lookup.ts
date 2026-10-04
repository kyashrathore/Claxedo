import fs from "node:fs"
import path from "node:path"

export function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

export function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  if (!isFile(candidate)) return false
  if (platform === "win32") return true
  try {
    fs.accessSync(candidate, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function windowsPathExtensions(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim().toLowerCase())
    .filter(Boolean)
}

/** Resolve a bare command against PATH (+ PATHEXT on Windows). */
export function resolveOnPath(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string | undefined {
  const extensions = platform === "win32" ? windowsPathExtensions(env) : [""]
  const hasExtension = extensions.some((extension) => command.toLowerCase().endsWith(extension))
  const names = platform === "win32" && !hasExtension ? extensions.map((extension) => `${command}${extension}`) : [command]
  for (const entry of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : path.delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!directory) continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}
