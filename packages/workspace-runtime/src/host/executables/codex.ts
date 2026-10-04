import fs from "node:fs"
import path from "node:path"

export const CODEX_INSTALL_HINT =
  "Install it with `npm install -g @openai/codex` (or see https://developers.openai.com/codex/cli), then restart Claxedo."

const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"])

const NATIVE_TARGETS: Partial<Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, string>>>> = {
  darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
  linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
  win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
}

function isExecutableFile(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) return false
    if (platform === "win32") return true
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

function resolveOnPath(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const extensions = platform === "win32" ? windowsPathExtensions(env) : [""]
  const hasExtension = extensions.some((extension) => command.toLowerCase().endsWith(extension))
  const names = platform === "win32" && !hasExtension
    ? extensions.map((extension) => `${command}${extension}`)
    : [command]
  const delimiter = platform === "win32" ? ";" : path.delimiter

  for (const entry of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    const directory = entry.trim().replace(/^"(.*)"$/, "$1")
    if (!directory) continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      if (isExecutableFile(candidate, platform)) return candidate
    }
  }
  return undefined
}

/**
 * The `@openai/codex` npm package installs a Node launcher (`bin/codex.js`, or
 * a `.cmd`/`.ps1` shim on Windows) that only spawns the platform-native binary
 * from its optional platform package. Spawning that binary directly keeps
 * stdio and process ownership on the app-server and saves the launcher's Node
 * process. The 0.159.2 launcher adds nothing to the child's `PATH`; the
 * binary finds its bundled `rg` beside itself, and the `CODEX_MANAGED_*`
 * variables it sets only feed `codex doctor` and update hints.
 */
function codexPackageDirectory(launcher: string, platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") {
    return WINDOWS_SHIM_EXTENSIONS.has(path.extname(launcher).toLowerCase())
      ? path.join(path.dirname(launcher), "node_modules", "@openai", "codex")
      : undefined
  }
  const script = fs.realpathSync(launcher)
  return path.basename(script) === "codex.js" ? path.dirname(path.dirname(script)) : undefined
}

function nativeCodexBinary(packageDirectory: string, platform: NodeJS.Platform, arch: NodeJS.Architecture): string | undefined {
  const target = NATIVE_TARGETS[platform]?.[arch]
  if (!target) return undefined
  const platformPackage = `codex-${platform}-${arch}`
  const binary = ["vendor", target, "bin", platform === "win32" ? "codex.exe" : "codex"]
  return [
    path.join(packageDirectory, "node_modules", "@openai", platformPackage, ...binary),
    path.join(path.dirname(packageDirectory), platformPackage, ...binary),
    path.join(packageDirectory, ...binary),
  ].find((candidate) => isExecutableFile(candidate, platform))
}

/** Resolve the installed Codex CLI to a binary Node can spawn directly. */
export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  const resolved = resolveOnPath("codex", platform, env)
  if (!resolved) return undefined
  const packageDirectory = codexPackageDirectory(resolved, platform)
  return packageDirectory ? nativeCodexBinary(packageDirectory, platform, arch) : resolved
}

export function requireCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const resolved = resolveCodexExecutable(env, platform, arch)
  if (resolved) return resolved
  throw new Error(`Codex CLI is not installed or not runnable. ${CODEX_INSTALL_HINT}`)
}
