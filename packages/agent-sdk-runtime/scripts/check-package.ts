import fs from "fs"
import path from "path"
import { pathToFileURL } from "url"

const root = path.resolve(import.meta.dirname, "..")
const dist = path.join(root, "dist")
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  exports: Record<string, { import: string }>
}
const maxEntryBytes = 256 * 1024
const maxRuntimeBytes = 2 * 1024 * 1024

function runtimeFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) return runtimeFiles(target)
    return target.endsWith(".mjs") ? [target] : []
  })
}

const files = runtimeFiles(dist)
const oversized = files.filter((file) => !file.includes(`${path.sep}chunks${path.sep}`) && fs.statSync(file).size > maxEntryBytes)
if (oversized.length > 0) {
  throw new Error(`package entry exceeds ${maxEntryBytes} bytes: ${oversized.map((file) => path.relative(dist, file)).join(", ")}`)
}
const total = files.reduce((bytes, file) => bytes + fs.statSync(file).size, 0)
if (total > maxRuntimeBytes) throw new Error(`package runtime output is ${total} bytes; limit is ${maxRuntimeBytes}`)

for (const [entrypoint, target] of Object.entries(packageJson.exports)) {
  await import(pathToFileURL(path.resolve(root, target.import)).href)
  console.log(`imported ${entrypoint}`)
}
