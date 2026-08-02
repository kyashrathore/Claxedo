import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const pkgDir = path.join(root, "packages", "agent-extensions")
const pkg = await Bun.file(path.join(pkgDir, "package.json")).json() as {
  exports: Record<string, { types: string; import: string }>
  bin: Record<string, string>
}

const missing: string[] = []

for (const [name, entry] of Object.entries(pkg.exports)) {
  for (const file of [entry.types, entry.import]) {
    const target = path.join(pkgDir, file)
    if (!await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) {
      missing.push(`${name}:${file}`)
    }
  }
}

for (const [name, file] of Object.entries(pkg.bin)) {
  const target = path.join(pkgDir, file)
  if (!await fs.stat(target).then((stat) => stat.isFile()).catch(() => false)) {
    missing.push(`bin:${name}:${file}`)
  }
}

if (missing.length > 0) {
  throw new Error(`@claxedo/agent-extensions package artifact is missing:\n${missing.join("\n")}`)
}

await import(path.join(pkgDir, pkg.exports["."].import))
await import(path.join(pkgDir, pkg.exports["./install"].import))
await import(path.join(pkgDir, pkg.exports["./runtime-config"].import))
await import(path.join(pkgDir, pkg.exports["./workspace"].import))

console.log("[agent-extensions-package] ok")
