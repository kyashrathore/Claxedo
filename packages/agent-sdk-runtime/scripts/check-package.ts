import fs from "fs"
import os from "os"
import path from "path"
import { spawnSync } from "child_process"
import { pathToFileURL } from "url"
import { readPackageJson } from "./manifest-files"

const root = path.resolve(import.meta.dirname, "..")
const dist = path.join(root, "dist")
const packageJson = readPackageJson(root)
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

// The gate child is spawned by path from a copy that sits alone outside this
// package (the desktop unpacks it from the asar), so it must run with nothing
// beside it. A lone copy that resolves a chunk or a package fails here with
// ERR_MODULE_NOT_FOUND instead of the exit code for "no parent channel".
const gateChild = path.join(dist, "launch/launch-gate-child.mjs")
const loneDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-gate-child-"))
try {
  const lone = path.join(loneDirectory, "launch-gate-child.mjs")
  fs.copyFileSync(gateChild, lone)
  const result = spawnSync(process.execPath, [lone], { encoding: "utf8", cwd: loneDirectory })
  if (result.status !== 23) {
    throw new Error(`a lone copy of launch-gate-child.mjs exited ${result.status} instead of 23 (no parent channel):\n${result.stderr}`)
  }
  console.log("launch-gate-child.mjs runs as a lone file")
} finally {
  fs.rmSync(loneDirectory, { recursive: true, force: true })
}
