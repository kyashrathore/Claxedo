import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const ARTIFACTS = path.resolve(import.meta.dirname, "../.artifacts")

export type PinnedPackage = { label: string; npmPackage: string; bin: string; version: string }

export type TestedRange = { readonly min: string; readonly max: string }

export function rangeEnd(range: TestedRange, variable: string): string {
  const end = process.env[variable] ?? "max"
  if (end !== "min" && end !== "max") throw new Error(`${variable} must be min or max, not ${end}`)
  return range[end]
}

function prefix(pinned: PinnedPackage): string {
  return path.join(ARTIFACTS, pinned.label, pinned.version)
}

export function pinnedBin(pinned: PinnedPackage): string {
  return path.join(prefix(pinned), "node_modules/.bin", process.platform === "win32" ? `${pinned.bin}.cmd` : pinned.bin)
}

function installedVersion(pinned: PinnedPackage): string | undefined {
  const manifest = path.join(prefix(pinned), "node_modules", pinned.npmPackage, "package.json")
  if (!existsSync(manifest) || !existsSync(pinnedBin(pinned))) return undefined
  return (JSON.parse(readFileSync(manifest, "utf8")) as { version?: string }).version
}

export async function ensurePinned(pinned: PinnedPackage): Promise<{ installed: boolean; version: string }> {
  if (installedVersion(pinned) === pinned.version) return { installed: false, version: pinned.version }
  const root = prefix(pinned)
  await fs.mkdir(root, { recursive: true })
  const node = process.env.CLAXEDO_E2E_NODE ?? "node"
  const executable = process.platform === "win32" ? (await execFileAsync(node, ["-p", "process.execPath"])).stdout.trim() : node
  const command = process.platform === "win32" ? executable : "npm"
  const args = process.platform === "win32" ? [path.join(path.dirname(executable), "node_modules/npm/bin/npm-cli.js")] : []
  await execFileAsync(command, [...args, "install", "--prefix", root, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `${pinned.npmPackage}@${pinned.version}`], {
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(ARTIFACTS, pinned.label, "npm-cache") },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (installedVersion(pinned) !== pinned.version) throw new Error(`npm install did not install ${pinned.npmPackage} ${pinned.version}`)
  return { installed: true, version: pinned.version }
}
