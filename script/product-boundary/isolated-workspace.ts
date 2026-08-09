import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { REPO_ROOT } from "./closure"
import { emittedManifestFindings, readBuildManifest } from "./emitted-manifest"
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
  "script/product-boundary/prepare-native.ts",
  "packages/core/script/fix-node-pty.ts",
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

type WorkspaceManifest = {
  name?: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

function matchesPackage(specifier: string, name: string) {
  return specifier === name || specifier.startsWith(`${name}/`)
}

/** A product cannot declare a forbidden runtime role even when it is unused. */
export function productManifestRoleFindings(policy: Policy, root = REPO_ROOT): string[] {
  const file = path.join(root, policy.packageDir, "package.json")
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as WorkspaceManifest
  const dependencies = Object.keys({
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  })
  return dependencies.flatMap((dependency) =>
    (policy.manifestForbiddenPackages ?? policy.forbiddenPackages).some((forbidden) => matchesPackage(dependency, forbidden))
      ? [`forbidden manifest dependency: ${dependency}`]
      : [],
  )
}

/** Derive source access from the exact normalized graph emitted by the entry build. */
export function workspaceClosureFromBuildManifest(policy: Policy, root = REPO_ROOT): string[] {
  if (!policy.emitted) throw new Error(`${policy.id} isolation requires an emitted entry manifest`)
  const manifest = readBuildManifest(path.join(root, policy.emitted.file))
  const workspaceDirs = workspacePackageDirs(root).sort((a, b) => b.length - a.length)
  const allowed = new Set<string>([policy.packageDir])
  for (const module of manifest.modules) {
    const packageDir = workspaceDirs.find((dir) => module === dir || module.startsWith(`${dir}/`))
    if (packageDir) allowed.add(packageDir)
  }
  return [...allowed].sort()
}

function workspaceBuildInputClosure(packageDirs: string[], root: string): string[] {
  const byName = new Map<string, string>()
  for (const dir of workspacePackageDirs(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, dir, "package.json"), "utf8")) as WorkspaceManifest
    if (manifest.name) byName.set(manifest.name, dir)
  }
  const closure = new Set<string>()
  const frontier = [...packageDirs]
  while (frontier.length > 0) {
    const dir = frontier.shift()!
    if (closure.has(dir)) continue
    const file = path.join(root, dir, "package.json")
    if (!fs.existsSync(file)) throw new Error(`isolation build input is not a workspace: ${dir}`)
    closure.add(dir)
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as WorkspaceManifest
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
      // Repository-owned build scripts may import workspace tools declared as
      // dev dependencies (OpenCode's node build imports @opencode-ai/script).
      ...(manifest as WorkspaceManifest & { devDependencies?: Record<string, string> }).devDependencies,
    })) {
      const dependency = byName.get(name)
      if (dependency && !closure.has(dependency)) frontier.push(dependency)
    }
  }
  return [...closure]
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

function restrictPackageExports(
  destination: string,
  restriction: NonNullable<NonNullable<Policy["isolation"]>["packageExports"]>[number],
) {
  const file = path.join(destination, restriction.packageDir, "package.json")
  const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
  if (!manifest.exports || typeof manifest.exports !== "object" || Array.isArray(manifest.exports)) {
    throw new Error(`${restriction.packageDir} has no subpath export map to restrict`)
  }
  const existing = manifest.exports as Record<string, unknown>
  const selected: Record<string, unknown> = {}
  for (const name of restriction.exports) {
    if (!(name in existing)) throw new Error(`${restriction.packageDir} does not export ${name}`)
    selected[name] = existing[name]
  }
  manifest.exports = selected
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

/** Materialize sources for only the policy's allowlisted workspace packages. */
export function materializeIsolatedWorkspace(policy: Policy, destination: string, root = REPO_ROOT) {
  if (!policy.isolation) throw new Error(`${policy.id} declares no isolation commands`)
  const roleFindings = productManifestRoleFindings(policy, root)
  if (roleFindings.length > 0) throw new Error(`${policy.id} ${roleFindings.join(", ")}`)
  const emittedAllowed = new Set(workspaceClosureFromBuildManifest(policy, root))
  const runtimeBuildPackages = (policy.isolation.buildPackages ?? []).filter((item) => !item.inputOnly)
  for (const buildPackage of runtimeBuildPackages) {
    if (!emittedAllowed.has(buildPackage.packageDir)) {
      throw new Error(
        `${policy.id} isolation build package is outside its emitted workspace closure: ${buildPackage.packageDir}`,
      )
    }
  }
  const buildInputs = [
    ...runtimeBuildPackages.map((item) => item.packageDir),
    ...(policy.isolation.additionalPackageDirs ?? []),
  ]
  const buildInputAllowed = new Set(workspaceBuildInputClosure(buildInputs, root))
  for (const buildPackage of (policy.isolation.buildPackages ?? []).filter((item) => item.inputOnly)) {
    if (!buildInputAllowed.has(buildPackage.packageDir)) {
      throw new Error(
        `${policy.id} isolation input-only build package is outside its declared build-input closure: ` +
          buildPackage.packageDir,
      )
    }
  }
  const allowed = new Set([
    ...emittedAllowed,
    ...buildInputAllowed,
  ])

  fs.mkdirSync(destination, { recursive: true })
  for (const file of ROOT_FILES) copy(path.join(root, file), path.join(destination, file))
  copy(path.join(root, "patches"), path.join(destination, "patches"))
  for (const file of policy.isolation.additionalFiles ?? []) {
    const source = path.resolve(root, file)
    if (source !== root && !source.startsWith(`${root}${path.sep}`)) {
      throw new Error(`${policy.id} isolation file leaves the repository: ${file}`)
    }
    if (!fs.existsSync(source)) throw new Error(`${policy.id} isolation file does not exist: ${file}`)
    copy(source, path.join(destination, file))
  }

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
  for (const restriction of policy.isolation.packageExports ?? []) {
    if (!allowed.has(restriction.packageDir)) {
      throw new Error(`${policy.id} isolation export restriction names an excluded package: ${restriction.packageDir}`)
    }
    restrictPackageExports(destination, restriction)
  }
  for (const buildPackage of policy.isolation.buildPackages ?? []) {
    const dir = buildPackage.packageDir
    const manifest = JSON.parse(fs.readFileSync(path.join(destination, dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>
    }
    const script = buildPackage.script ?? "build"
    if (!manifest.scripts?.[script]) {
      throw new Error(`${policy.id} isolation build package has no declared ${script} script: ${dir}`)
    }
  }
}

export type IsolatedCommand = { cwd: string; command: string[]; environment?: Record<string, string> }
export type IsolatedRunner = (input: IsolatedCommand) => number

const spawn: IsolatedRunner = (input) => {
  const { cwd, command } = input
  const [executable, ...args] = command
  if (!executable) return 2
  const result = spawnSync(executable, args, {
    cwd,
    env: { ...process.env, ...input.environment },
    stdio: "inherit",
  })
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
      ...(policy.isolation.native ?? []).map((native): IsolatedCommand => {
        if (native === "node-pty") {
          return { cwd: temporary, command: ["bun", "packages/core/script/fix-node-pty.ts"] }
        }
        return {
          cwd: temporary,
          command: [
            "bun",
            "script/product-boundary/prepare-native.ts",
            "better-sqlite3",
            "--package-dir",
            policy.packageDir,
          ],
        }
      }),
      ...(policy.isolation.buildPackages ?? []).map((buildPackage): IsolatedCommand => ({
        cwd: path.join(temporary, buildPackage.packageDir),
        command: ["bun", "run", buildPackage.script ?? "build"],
        environment: buildPackage.environment,
      })),
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
    if (policy.isolation.native?.includes("node-pty")) {
      const input = {
        cwd: temporary,
        command: ["bun", "script/product-boundary/prepare-native.ts", "node-pty", "--package-dir", policy.packageDir],
      }
      console.log(`→ ${policy.id} isolated: ${input.command.join(" ")}`)
      const status = runner(input)
      if (status !== 0) {
        console.error(`✗ ${policy.id} isolated native probe exited ${status}`)
        return false
      }
    }
    const emittedFindings = emittedManifestFindings(policy, temporary)
    if (emittedFindings.length > 0) {
      console.error(`✗ ${policy.id} isolated emitted manifest`)
      for (const finding of emittedFindings) console.error(`  ${finding}`)
      return false
    }
    if (policy.emitted) console.log(`✓ ${policy.id} isolated emitted manifest`)
    console.log(`✓ ${policy.id} isolated frozen build and smoke`)
    return true
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
