import fs from "node:fs"
import path from "node:path"

export const CODEX_INSTALL_HINT =
  "Install it with `npm install -g @openai/codex` (or see https://developers.openai.com/codex/cli), then restart Claxedo."

const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"])

const WINDOWS_TARGET_BY_ARCH: Partial<Record<NodeJS.Architecture, {
  packageName: string
  targetTriple: string
}>> = {
  x64: {
    packageName: "codex-win32-x64",
    targetTriple: "x86_64-pc-windows-msvc",
  },
  arm64: {
    packageName: "codex-win32-arm64",
    targetTriple: "aarch64-pc-windows-msvc",
  },
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
 * The Windows npm launchers are shell scripts, and Node cannot execute a
 * `.cmd`/`.ps1` file with `spawn()` unless it enables a shell. Follow the
 * official `@openai/codex` package layout to the platform-native executable
 * instead. This preserves stdio and process ownership for the app-server.
 */
function resolveWindowsNativeBinary(shim: string, arch: NodeJS.Architecture): string | undefined {
  if (!WINDOWS_SHIM_EXTENSIONS.has(path.extname(shim).toLowerCase())) return shim
  const target = WINDOWS_TARGET_BY_ARCH[arch]
  if (!target) return undefined
  const launcherDirectory = path.dirname(shim)
  const platformPackageSegments = ["@openai", target.packageName, "vendor", target.targetTriple, "bin", "codex.exe"]
  const candidates = [
    // npm's current global layout: the optional platform package is nested
    // under `@openai/codex`.
    path.join(launcherDirectory, "node_modules", "@openai", "codex", "node_modules", ...platformPackageSegments),
    // Hoisted package-manager layout.
    path.join(launcherDirectory, "node_modules", ...platformPackageSegments),
    // Candidate used by the official launcher when the platform binary is
    // copied into the main package.
    path.join(
      launcherDirectory,
      "node_modules",
      "@openai",
      "codex",
      "vendor",
      target.targetTriple,
      "bin",
      "codex.exe",
    ),
  ]
  return candidates.find((candidate) => isExecutableFile(candidate, "win32"))
}

/** Resolve the installed Codex CLI to a binary Node can spawn directly. */
export function resolveCodexExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string | undefined {
  const resolved = resolveOnPath("codex", platform, env)
  if (!resolved) return undefined
  return platform === "win32" ? resolveWindowsNativeBinary(resolved, arch) : resolved
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
