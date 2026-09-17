import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

type Manifest = {
  name: string
  version: string
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  peerDependenciesMeta?: Record<string, { optional?: boolean }>
  os?: string[]
  cpu?: string[]
}

/**
 * Specifiers a server bundle must leave to Node resolution against the staged
 * closure, never inline. The engine hoists one `ChildProcessSpawner` layer per
 * process and compares node implementations by identity, so a second module
 * instance of `@opencode-ai/core` or `@opencode-ai/util` reaching its graph —
 * one inlined node passed as an override was enough — fails every
 * location-scoped request with "Tag global has conflicting implementations".
 */
export const OPENCODE_SDK_EXTERNALS = [
  "@opencode-ai/sdk",
  "@opencode-ai/sdk/*",
  "@opencode-ai/core",
  "@opencode-ai/core/*",
  "@opencode-ai/util",
  "@opencode-ai/util/*",
  "@opencode-ai/server",
  "@opencode-ai/server/*",
  "@opencode-ai/client",
  "@opencode-ai/client/*",
  "@opencode-ai/protocol",
  "@opencode-ai/protocol/*",
  "@opencode-ai/schema",
  "@opencode-ai/schema/*",
  "@opencode-ai/plugin",
  "@opencode-ai/plugin/*",
  "koffi",
]

function manifest(directory: string): Manifest {
  return JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
}

function resolvePackage(name: string, from: string): string | undefined {
  // Bun treats node-fetch as a builtin and returns null from resolve.paths.
  // Packaging must follow Node's filesystem lookup, not build-runtime aliases.
  for (let ancestor = from; ; ancestor = path.dirname(ancestor)) {
    const directory = path.join(ancestor, "node_modules", name)
    if (fs.existsSync(path.join(directory, "package.json"))) return fs.realpathSync(directory)
    if (path.dirname(ancestor) === ancestor) break
  }
  return undefined
}

function supports(values: string[] | undefined, target: string) {
  return !values || (!values.includes("!" + target) && (!values.some((v) => !v.startsWith("!")) || values.includes(target)))
}

/**
 * Stage the installed, patched SDK closure as real packages, without symlinks
 * back to a checkout. Upstream uses import.meta-relative native/data resources
 * and computed imports: rebundling that graph is not a supported Node artifact.
 * Ordinary Node resolution keeps one shared version at the root; conflicting
 * versions are nested under the dependent, just as in an npm installation.
 */
export function stageOpenCodeSdk(
  nodeModules: string,
  target: { platform: string; arch: string } = { platform: process.platform, arch: process.arch },
  owner = path.resolve(import.meta.dirname, ".."),
) {
  const installed = new Map<string, string>()
  const inventory: Array<{ name: string; version: string; directory: string }> = []
  fs.mkdirSync(nodeModules, { recursive: true })

  function install(source: string, parent: string, name = manifest(source).name): string {
    const pkg = manifest(source)
    const root = path.join(nodeModules, name)
    let destination = root
    if (installed.has(root) && installed.get(root) !== source) destination = path.join(parent, "node_modules", name)
    if (installed.get(destination) === source) return destination
    if (installed.has(destination)) throw new Error("Conflicting staged dependency: " + pkg.name)
    installed.set(destination, source)
    fs.cpSync(source, destination, {
      recursive: true,
      dereference: true,
      filter: (file) => {
        const relative = path.relative(source, file)
        return !relative.split(path.sep).includes("node_modules")
          && !/\.(?:[cm]?js|[cm]?ts)\.map$/.test(relative)
          && !/\.d\.[cm]?ts$/.test(relative)
      },
    })
    inventory.push({ name: pkg.name, version: pkg.version, directory: path.relative(nodeModules, destination) })
    const optional = pkg.optionalDependencies ?? {}
    const platformSuffix = `${target.platform}-${target.arch}`
    const requiredNative = pkg.name === "koffi" ? `@koromix/koffi-${platformSuffix}`
      : pkg.name === "@opencode-ai/pty" && target.platform !== "win32"
        ? `@opencode-ai/pty-${platformSuffix}${target.platform === "linux" ? "-gnu" : ""}`
        : pkg.name === "@parcel/watcher" ? `@parcel/watcher-${platformSuffix}${target.platform === "linux" ? "-glibc" : ""}`
          : undefined
    const peers = Object.fromEntries(Object.entries(pkg.peerDependencies ?? {}).filter(([name]) => !pkg.peerDependenciesMeta?.[name]?.optional))
    for (const name of Object.keys({ ...peers, ...pkg.dependencies, ...optional }).sort()) {
      const dependency = resolvePackage(name, source)
      if (!dependency) {
        if (name in optional && name !== requiredNative) continue
        throw new Error("Missing SDK runtime dependency " + name + " required by " + pkg.name)
      }
      const info = manifest(dependency)
      if (!supports(info.os, target.platform) || !supports(info.cpu, target.arch)) {
        if (name === requiredNative) throw new Error("SDK native dependency does not support target: " + name)
        continue
      }
      install(dependency, destination, name)
    }
    return destination
  }

  // koffi is the temporary core process-lock patch's declared host dependency.
  for (const name of ["@opencode-ai/sdk", "koffi"]) {
    const source = resolvePackage(name, owner)
    if (!source) throw new Error("Missing embedded SDK dependency: " + name)
    install(source, path.dirname(nodeModules))
  }
  inventory.sort((a, b) => a.directory.localeCompare(b.directory))
  const serialized = JSON.stringify(inventory, null, 2) + "\n"
  fs.writeFileSync(path.join(path.dirname(nodeModules), "opencode-sdk-inventory.json"), serialized)
  return { packages: inventory.length, digest: createHash("sha256").update(serialized).digest("hex") }
}
