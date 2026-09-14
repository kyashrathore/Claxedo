import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { PI_EXECUTABLE_ENV, PI_VERSION, piPackageRoot, resolvePiExecutable } from "../harnesses/pi/executable"

const packageDir = path.resolve(import.meta.dirname, "../..")
const localBin = path.join(packageDir, ".artifacts", "pi", "node_modules", ".bin")

function pinned(binary: string | undefined): string | undefined {
  const root = binary ? piPackageRoot(binary) : undefined
  if (!binary || !root) return undefined
  try {
    const manifest: unknown = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
    return typeof manifest === "object" && manifest !== null && "version" in manifest && manifest.version === PI_VERSION
      ? binary
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The Pi 0.85.1 a real-process test drives; never a skip. `PI_EXECUTABLE`
 * wins when set. Otherwise the machine's own Pi serves when it is the pin, and
 * when it is not, `bun run pi:install` puts the pin under `.artifacts/pi` and
 * that copy serves, so a machine carrying another Pi or none still proves the
 * pinned one.
 */
export function pinnedPiExecutable(): string {
  const explicit = process.env[PI_EXECUTABLE_ENV]?.trim()
  if (explicit) return explicit
  const onPath = pinned(resolvePiExecutable())
  if (onPath) return onPath
  const installed = pinned(resolvePiExecutable({ PATH: localBin }))
  if (installed) return installed
  const install = spawnSync(process.execPath, ["run", "pi:install"], { cwd: packageDir, stdio: "inherit" })
  if (install.status !== 0) throw new Error(`bun run pi:install exited with ${install.status}`)
  const binary = pinned(resolvePiExecutable({ PATH: localBin }))
  if (!binary) throw new Error(`pi:install left no Pi ${PI_VERSION} under ${localBin}`)
  return binary
}
