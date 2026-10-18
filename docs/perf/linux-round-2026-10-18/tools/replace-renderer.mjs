import { createPackageWithOptions, extractAll } from "@electron/asar"
import { cpSync, existsSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"

const [asarPath, rendererDir] = process.argv.slice(2)
if (!asarPath || !rendererDir || !existsSync(path.join(rendererDir, "index.local.html"))) {
  throw new Error("usage: replace-renderer.mjs <resources/app.asar> <built out/renderer dir>")
}
const unpackedRoot = `${asarPath}.unpacked`
const unpackedFiles = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full)
    else unpackedFiles.push(path.relative(unpackedRoot, full))
  }
}
if (existsSync(unpackedRoot)) walk(unpackedRoot)
const work = mkdtempSync(path.join(os.tmpdir(), "claxedo-repack-"))
const tree = path.join(work, "app")
extractAll(asarPath, tree)
rmSync(path.join(tree, "out", "renderer"), { recursive: true, force: true })
cpSync(rendererDir, path.join(tree, "out", "renderer"), { recursive: true })
const next = path.join(work, "app.asar")
const unpack = unpackedFiles.length ? `{${unpackedFiles.map((file) => `**/${file}`).join(",")}}` : undefined
await createPackageWithOptions(tree, next, unpack ? { unpack } : {})
rmSync(unpackedRoot, { recursive: true, force: true })
renameSync(next, asarPath)
if (existsSync(`${next}.unpacked`)) renameSync(`${next}.unpacked`, unpackedRoot)
rmSync(work, { recursive: true, force: true })
console.log(`replaced out/renderer in ${asarPath} (${String(unpackedFiles.length)} unpacked files kept unpacked)`)
