#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repository = path.resolve(__dirname, "../../..")

// `--native-source <repo>`: a host repository whose node-pty carries the
// compiled native addon. The npm tarball ships prebuilds for darwin/win32
// only — on Linux `build/Release/pty.node` exists solely because the real
// install ran node-gyp. An isolated `--ignore-scripts` copy (the product
// boundary probes) therefore has NO loadable binary; it inherits the host's
// build output instead of running scripts.
const sourceFlag = process.argv.indexOf("--native-source")
const nativeSource = sourceFlag === -1 ? undefined : path.resolve(process.argv[sourceFlag + 1] ?? "")

if (process.platform !== "win32") {
  // Bun keeps the installed package in its root content-addressed store; a
  // package-local node_modules link exists only when that workspace declares
  // the package directly. So repair every installed pty copy at the
  // authoritative store. The repo's PTY is @lydell/node-pty, whose darwin
  // platform packages (`@lydell/node-pty-darwin-*`) carry the `spawn-helper`
  // binary that must stay executable — bun may strip the execute bit, and
  // without it posix_spawnp fails and PTY creation throws.
  const store = path.join(repository, "node_modules", ".bun")
  const packages = await fs.readdir(store, { withFileTypes: true }).catch(() => [])
  const roots = packages
    .filter((entry) => entry.isDirectory() && /^@lydell\+node-pty-[a-z0-9]+-[a-z0-9]+@/.test(entry.name))
    .map((entry) => {
      const name = entry.name.slice(0, entry.name.lastIndexOf("@")).replace("+", "/")
      return path.join(store, entry.name, "node_modules", name, "prebuilds")
    })
  const files = (await Promise.all(roots.map(async (root) => {
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
    return dirs.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name, "spawn-helper"))
  }))).flat()
  const result = await Promise.all(
    files.map(async (file) => {
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat) return
      if ((stat.mode & 0o111) === 0o111) return
      await fs.chmod(file, stat.mode | 0o755)
      return file
    }),
  )
  const fixed = result.filter(Boolean)
  if (fixed.length) {
    console.log(`fixed node-pty permissions for ${fixed.length} helper${fixed.length === 1 ? "" : "s"}`)
  }

  if (nativeSource) {
    for (const entry of packages) {
      if (!entry.isDirectory() || !entry.name.startsWith("node-pty@")) continue
      const target = path.join(store, entry.name, "node_modules", "node-pty")
      const prebuilt = path.join(target, "prebuilds", `${process.platform}-${process.arch}`, "pty.node")
      const built = path.join(target, "build", "Release", "pty.node")
      const hasBinary = await fs.stat(prebuilt).then(() => true, () => false)
        || await fs.stat(built).then(() => true, () => false)
      if (hasBinary) continue
      const sourceBuild = path.join(
        nativeSource, "node_modules", ".bun", entry.name, "node_modules", "node-pty", "build",
      )
      const sourceExists = await fs.stat(path.join(sourceBuild, "Release", "pty.node")).then(() => true, () => false)
      if (!sourceExists) {
        console.error(`node-pty native source has no built binary at ${sourceBuild}`)
        process.exit(2)
      }
      await fs.cp(sourceBuild, path.join(target, "build"), { recursive: true })
      console.log(`copied node-pty native build from ${sourceBuild}`)
    }
  }
}
