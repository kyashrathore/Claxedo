import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { REPO_ROOT } from "./closure"
import type { Policy } from "./policy"

const ROOT_FILES = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "turbo.json",
  // Repository-owned build tool used by package scripts. This is infrastructure,
  // not another product's source, and keeping one copy is the point of the
  // normalized manifest contract.
  "script/product-boundary/normalize-build-manifest.ts",
]
const STRIPPED_STUB_FIELDS = ["exports", "main", "module", "types", "bin", "scripts", "files"]

function copy(source: string, destination: string) {
  if (!fs.existsSync(source)) return
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.cpSync(source, destination, { recursive: true })
}

function workspacePackageDirs(root: string): string[] {
  const dirs: string[] = []
  for (const parent of ["packages", "examples"]) {
    const absolute = path.join(root, parent)
    if (!fs.existsSync(absolute)) continue
    for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!item.isDirectory()) continue
      const relative = `${parent}/${item.name}`
      if (fs.existsSync(path.join(root, relative, "package.json"))) dirs.push(relative)
    }
  }
  if (fs.existsSync(path.join(root, "packages/sdk/js/package.json"))) dirs.push("packages/sdk/js")
  return [...new Set(dirs)].sort()
}

function writeStub(source: string, destination: string) {
  const manifest = JSON.parse(fs.readFileSync(source, "utf8")) as Record<string, unknown>
  for (const field of STRIPPED_STUB_FIELDS) delete manifest[field]
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, `${JSON.stringify(manifest, null, 2)}\n`)
}

function copyAllowedPackage(source: string, destination: string) {
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (item) => {
      const name = path.basename(item)
      return !["node_modules", "dist", ".artifacts", ".turbo"].includes(name)
    },
  })
}

/** Materialize sources for only the policy's allowlisted workspace packages. */
export function materializeIsolatedWorkspace(policy: Policy, destination: string, root = REPO_ROOT) {
  if (!policy.isolation) throw new Error(`${policy.id} declares no isolation commands`)
  const allowed = new Set(policy.isolation.packageDirs)

  fs.mkdirSync(destination, { recursive: true })
  for (const file of ROOT_FILES) copy(path.join(root, file), path.join(destination, file))
  copy(path.join(root, "patches"), path.join(destination, "patches"))

  for (const dir of workspacePackageDirs(root)) {
    const source = path.join(root, dir)
    const target = path.join(destination, dir)
    if (allowed.has(dir)) {
      copyAllowedPackage(source, target)
    } else {
      writeStub(path.join(source, "package.json"), path.join(target, "package.json"))
    }
  }

  for (const dir of allowed) {
    if (!fs.existsSync(path.join(destination, dir, "package.json"))) {
      throw new Error(`${policy.id} isolation package is not a workspace: ${dir}`)
    }
  }
}

export type IsolatedCommand = { cwd: string; command: string[] }
export type IsolatedRunner = (input: IsolatedCommand) => number

const spawn: IsolatedRunner = ({ cwd, command }) => {
  const [executable, ...args] = command
  if (!executable) return 2
  const result = spawnSync(executable, args, { cwd, env: process.env, stdio: "inherit" })
  if (result.error) console.error(result.error.message)
  return result.status ?? 2
}

/** Fresh frozen install, build, smoke, and unconditional cleanup. */
export function verifyIsolatedWorkspace(policy: Policy, runner: IsolatedRunner = spawn, root = REPO_ROOT): boolean {
  if (!policy.isolation) return true
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `claxedo-${policy.id}-`))
  try {
    materializeIsolatedWorkspace(policy, temporary, root)
    const commands: IsolatedCommand[] = [
      {
        cwd: temporary,
        command: ["bun", "install", "--frozen-lockfile", "--ignore-scripts", "--minimum-release-age=0"],
      },
      ...policy.isolation.commands.map((command) => ({
        cwd: path.join(temporary, policy.packageDir),
        command,
      })),
    ]

    for (const input of commands) {
      console.log(`→ ${policy.id} isolated: ${input.command.join(" ")}`)
      const status = runner(input)
      if (status !== 0) {
        console.error(`✗ ${policy.id} isolated command exited ${status}`)
        return false
      }
    }
    console.log(`✓ ${policy.id} isolated frozen build and smoke`)
    return true
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
