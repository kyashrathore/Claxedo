import fs from "node:fs"
import path from "node:path"

type PackageEntry = { name: string; version: string; directory: string }

/** Check the real external SDK files, not just electron-builder's input globs. */
export function verifyOpenCodeSdkResources(resources: string, expected: Record<string, string>): void {
  const inventory: unknown = JSON.parse(fs.readFileSync(path.join(resources, "opencode-sdk-inventory.json"), "utf8"))
  if (!Array.isArray(inventory) || inventory.length === 0) throw new Error("Missing embedded SDK inventory")
  const modules = path.resolve(resources, "node_modules")
  const directories = new Set<string>()
  const entries: PackageEntry[] = []
  for (const value of inventory) {
    if (!value || typeof value.name !== "string" || typeof value.version !== "string" || typeof value.directory !== "string") {
      throw new Error("Invalid embedded SDK inventory entry")
    }
    const directory = path.resolve(modules, value.directory)
    if (!directory.startsWith(modules + path.sep) || directories.has(directory)) throw new Error("Invalid embedded SDK package path")
    directories.add(directory)
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"))
    if (pkg.name !== value.name || pkg.version !== value.version) throw new Error("Embedded SDK package does not match inventory: " + value.directory)
    if (pkg.name === "bun" || pkg.name.startsWith("@oven/bun-")) throw new Error("Bun must not ship in the embedded Node runtime")
    entries.push(value)
  }
  for (const [name, version] of Object.entries(expected)) {
    const matches = entries.filter((entry) => entry.name === name)
    if (matches.length !== 1 || matches[0]!.version !== version) throw new Error("Expected one pinned embedded dependency: " + name + "@" + version)
  }
  function walk(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Embedded SDK must not contain checkout symlinks: " + entry.name)
      if (entry.isDirectory()) walk(path.join(directory, entry.name))
    }
  }
  walk(modules)
}

export function embeddedSdkPins() {
  const owner = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../../workspace-runtime/package.json"), "utf8"))
  return {
    "@opencode-ai/sdk": owner.dependencies["@opencode-ai/sdk"],
    "@opencode-ai/core": owner.dependencies["@opencode-ai/sdk"],
    koffi: owner.dependencies.koffi,
  }
}
