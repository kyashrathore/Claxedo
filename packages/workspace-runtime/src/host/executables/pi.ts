import fs from "node:fs"
import path from "node:path"

export const PI_EXECUTABLE_ENV = "PI_EXECUTABLE"
export const PI_INSTALL_HINT = `Install npm package @earendil-works/pi-coding-agent, or set ${PI_EXECUTABLE_ENV}.`

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

export function requirePiExecutable(env: NodeJS.ProcessEnv) {
  const binary = resolvePiExecutable(env)
  if (!binary) throw new Error(`Pi executable not found. ${PI_INSTALL_HINT}`)
  return binary
}

/**
 * A JavaScript entry runs under Node, the interpreter Pi's npm shim and POSIX
 * shebang both name. Bun 1.3.14 cannot load Pi 0.85.1's bundle (its undici
 * calls `webidl.util.markAsUncloneable`, which Bun leaves undefined), so a
 * Bun host hands the entry to `node` on PATH instead of to itself.
 */
export function piRuntime() {
  return process.versions.bun ? "node" : process.execPath
}
