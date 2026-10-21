import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"

export type Manifest = { name?: string; private?: boolean; gypfile?: boolean; scripts?: Record<string, string> }

type LockWorkspace = { name?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
type LockMeta = {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  optionalPeers?: string[]
  os?: unknown
  cpu?: unknown
}
export type Lock = { workspaces: Record<string, LockWorkspace>; packages: Record<string, [string, string?, LockMeta?, string?]> }

/** What one installed package can read from disk about itself. */
export type Installed = { manifest: Manifest; bindingGyp: boolean; prebuilds: string[] }

export type InstallStep = { name: string; step: string; via: string }

const LIFECYCLE = ["preinstall", "install", "postinstall"] as const

/**
 * What `npm install` runs for a package, in words a reviewer can pin. npm runs
 * `node-gyp rebuild` for a package that ships a `binding.gyp` and defines no
 * install or preinstall script, unless it sets `gypfile: false`. A
 * `node-gyp-build` install compiles on every platform its `prebuilds` folder
 * does not name.
 */
export function installStep(installed: Installed): string | undefined {
  const scripts = installed.manifest.scripts ?? {}
  const steps = LIFECYCLE.flatMap((name) => (scripts[name] ? [`${name}: ${scripts[name]}`] : []))
  if (installed.bindingGyp && !scripts.install && !scripts.preinstall && installed.manifest.gypfile !== false) {
    steps.push("install: node-gyp rebuild (implicit, binding.gyp), compiles on every platform")
  }
  if (!steps.length) return undefined
  if (/^node-gyp-build(?:\s|$)/.test(scripts.install ?? "")) {
    const platforms = installed.prebuilds.map((entry) => entry.replace(/\.node$/, "")).sort()
    steps.push(platforms.length ? `prebuilds: ${platforms.join(" ")}` : "no prebuilds, compiles on every platform")
  }
  return steps.join("; ")
}

function packageNames(key: string): string[] {
  const parts = key.split("/")
  const names: string[] = []
  for (let index = 0; index < parts.length; index++) {
    names.push(parts[index]!.startsWith("@") ? `${parts[index]}/${parts[++index]}` : parts[index]!)
  }
  return names
}

/** The lock key a dependency resolves to from inside `parent`, the way bun nests a package that cannot be hoisted. */
function resolveKey(lock: Lock, parent: string[], dependency: string): string | undefined {
  for (let depth = parent.length; depth >= 0; depth--) {
    const key = [...parent.slice(0, depth), dependency].join("/")
    if (lock.packages[key]) return key
  }
  return undefined
}

/**
 * Every install step in the closure `npm install` would fetch for `roots`.
 * A private workspace package is bundled into the one that depends on it, so
 * its dependencies join the closure and its own scripts never run; any other
 * workspace package is installed, scripts and all. A package restricted to
 * another operating system or CPU is not installed here and cannot be read.
 */
export function installSteps(input: {
  roots: readonly string[]
  lock: Lock
  workspaceManifest: (directory: string) => Manifest
  installed: (name: string, version: string) => Installed | undefined
}): { steps: InstallStep[]; unreadable: string[] } {
  const { lock } = input
  const workspaces = new Map(Object.entries(lock.workspaces).flatMap(([directory, entry]) => (entry.name ? [[entry.name, { directory, entry }] as const] : [])))
  const steps: InstallStep[] = []
  const unreadable: string[] = []
  const seen = new Set<string>()

  const visitWorkspace = (name: string, via: string[], published: boolean) => {
    const workspace = workspaces.get(name)!
    const manifest = input.workspaceManifest(workspace.directory)
    if (published) {
      const step = installStep({ manifest, bindingGyp: false, prebuilds: [] })
      if (step) steps.push({ name, step, via: via.join(" > ") })
    }
    for (const dependency of Object.keys({ ...workspace.entry.dependencies, ...workspace.entry.optionalDependencies })) {
      visit([], dependency, [...via, name], name)
    }
  }

  const visit = (parent: string[], dependency: string, via: string[], workspace: string) => {
    if (workspaces.has(dependency)) {
      if (seen.has(`workspace:${dependency}`)) return
      seen.add(`workspace:${dependency}`)
      const manifest = input.workspaceManifest(workspaces.get(dependency)!.directory)
      return visitWorkspace(dependency, via, manifest.private !== true)
    }
    const key = resolveKey(lock, parent, dependency) ?? resolveKey(lock, [workspace], dependency)
    if (!key) return unreadable.push(`${via.at(-1)} depends on ${dependency}, which bun.lock does not resolve`)
    if (seen.has(key)) return
    seen.add(key)
    const [spec, , meta = {}] = lock.packages[key]!
    const at = spec.lastIndexOf("@")
    const name = spec.slice(0, at)
    const installed = input.installed(name, spec.slice(at + 1))
    if (installed) {
      const step = installStep(installed)
      if (step) steps.push({ name, step, via: via.join(" > ") })
    } else if (!meta.os && !meta.cpu) {
      unreadable.push(`${spec} is in bun.lock but not installed`)
    }
    const peers = Object.keys(meta.peerDependencies ?? {}).filter((peer) => !(meta.optionalPeers ?? []).includes(peer))
    for (const child of [...Object.keys({ ...meta.dependencies, ...meta.optionalDependencies }), ...peers]) {
      visit(packageNames(key), child, [...via, name], workspace)
    }
  }

  for (const root of input.roots) {
    if (seen.has(`workspace:${root}`)) continue
    seen.add(`workspace:${root}`)
    visitWorkspace(root, [], true)
  }
  return { steps: steps.sort((a, b) => a.name.localeCompare(b.name)), unreadable }
}

/** Reads installed packages out of bun's store, where a peer-resolved copy carries a `+hash` suffix. */
export function bunStore(repository: string) {
  const store = path.join(repository, "node_modules", ".bun")
  const entries = readdirSync(store)
  return (name: string, version: string): Installed | undefined => {
    const prefix = `${name.replace("/", "+")}@${version}`
    const entry = entries.find((candidate) => candidate === prefix || candidate.startsWith(`${prefix}+`))
    if (!entry) return undefined
    const directory = path.join(store, entry, "node_modules", name)
    const prebuildsDirectory = path.join(directory, "prebuilds")
    const manifest: Manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"))
    return {
      manifest,
      bindingGyp: existsSync(path.join(directory, "binding.gyp")),
      prebuilds: existsSync(prebuildsDirectory) ? readdirSync(prebuildsDirectory) : [],
    }
  }
}
