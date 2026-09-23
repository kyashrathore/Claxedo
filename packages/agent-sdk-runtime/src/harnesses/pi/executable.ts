import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { isRecord } from "@claxedo/agent-runtime-contract"

export const PI_VERSION = "0.85.1"
export const PI_EXECUTABLE_ENV = "PI_EXECUTABLE"
export const PI_INSTALL_HINT = `Install npm package @earendil-works/pi-coding-agent@${PI_VERSION}, or set ${PI_EXECUTABLE_ENV}.`

export function resolvePiExecutable(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const requested = env[PI_EXECUTABLE_ENV]?.trim()
  const candidates =
    requested && /[\\/]/.test(requested)
      ? [requested]
      : (env.PATH ?? "").split(path.delimiter).flatMap((directory) => {
          const name = requested || "pi"
          return process.platform === "win32"
            ? [path.join(directory, `${name}.exe`), path.join(directory, `${name}.cmd`)]
            : [path.join(directory, name)]
        })
  for (const candidate of candidates) {
    try {
      fs.accessSync(
        candidate,
        process.platform === "win32"
          ? fs.constants.F_OK
          : /\.(?:cjs|mjs|js)$/.test(candidate)
            ? fs.constants.R_OK
            : fs.constants.X_OK,
      )
      if (!fs.statSync(candidate).isFile()) continue
      if (/\.(cmd|bat)$/i.test(candidate)) {
        const packageRoot = shimmedPackageRoot(path.dirname(candidate))
        if (!packageRoot) continue
        const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"))
        const binary = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.pi
        if (typeof binary !== "string" || !binary) continue
        const entry = path.resolve(packageRoot, binary)
        fs.accessSync(entry, fs.constants.R_OK)
        if (fs.statSync(entry).isFile()) return entry
        continue
      }
      return candidate
    } catch {
      /* Continue PATH discovery; an explicit path has only one candidate. */
    }
  }
  return undefined
}
/**
 * Where npm put the package a Windows shim launches: a global prefix keeps
 * `pi.cmd` beside its `node_modules`, a project install keeps it inside
 * `node_modules/.bin`, one level below the package.
 */
function shimmedPackageRoot(shimDirectory: string) {
  for (const root of [
    path.join(shimDirectory, "node_modules", "@earendil-works", "pi-coding-agent"),
    path.join(shimDirectory, "..", "@earendil-works", "pi-coding-agent"),
  ]) {
    if (fs.existsSync(path.join(root, "package.json"))) return root
  }
  return undefined
}

export function requirePiExecutable() {
  const binary = resolvePiExecutable()
  if (!binary) throw new Error(`Pi executable not found. ${PI_INSTALL_HINT}`)
  return binary
}

/** Walk from the resolved binary to the pinned `@earendil-works/pi-coding-agent` package. */
export function piPackageRoot(binary: string): string | undefined {
  let current: string
  try {
    current = fs.realpathSync(binary)
  } catch {
    return undefined
  }
  if (!fs.statSync(current).isFile()) return undefined
  current = path.dirname(current)
  for (let depth = 0; depth < 8 && current !== path.dirname(current); depth++) {
    try {
      const manifest: unknown = JSON.parse(fs.readFileSync(path.join(current, "package.json"), "utf8"))
      if (isRecord(manifest) && manifest.name === "@earendil-works/pi-coding-agent") return current
    } catch {}
    current = path.dirname(current)
  }
  return undefined
}

/**
 * Why the pinned Pi cannot run here, or `undefined` when it can be attempted.
 *
 * `verifyPiExecutable` refuses any binary whose `--version` is not the pin, so
 * a test that drives a real Pi cannot pass on a machine carrying another one.
 * Only a proven mismatch answers a reason: a binary outside the npm package
 * has no manifest to read and is attempted rather than skipped, because an
 * unknown version is not evidence of a broken environment.
 */
export function unpinnedPiReason(): string | undefined {
  const binary = resolvePiExecutable()
  if (!binary) return `no Pi executable found; expected ${PI_VERSION}`
  const root = piPackageRoot(binary)
  if (!root) return undefined
  let installed: unknown
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    installed = isRecord(manifest) ? manifest.version : undefined
  } catch {
    return undefined
  }
  if (typeof installed !== "string" || installed === PI_VERSION) return undefined
  return `Pi ${installed} is installed, pinned ${PI_VERSION}`
}

export function piCommand(binary: string, args: string[]) {
  return /\.(?:cjs|mjs|js)$/.test(binary) ? { file: process.execPath, args: [binary, ...args] } : { file: binary, args }
}

const verified = new Map<string, Promise<void>>()
export function verifyPiExecutable(binary: string): Promise<void> {
  const key = `${binary}:${fs.statSync(binary).mtimeMs}`
  const cached = verified.get(key)
  if (cached) return cached
  const command = piCommand(binary, ["--version"])
  const result = new Promise<void>((resolve, reject) => {
    execFile(command.file, command.args, { timeout: 10_000, maxBuffer: 4096 }, (error, stdout) => {
      if (error) {
        reject(new Error(`Cannot check Pi version. ${PI_INSTALL_HINT}`, { cause: error }))
        return
      }
      if (stdout.trim() !== PI_VERSION) {
        reject(new Error(`Unsupported Pi version ${stdout.trim()}; expected ${PI_VERSION}. ${PI_INSTALL_HINT}`))
        return
      }
      resolve()
    })
  })
  verified.set(key, result)
  void result.catch(() => verified.delete(key))
  return result
}
