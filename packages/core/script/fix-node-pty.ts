#!/usr/bin/env bun

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repository = path.resolve(__dirname, "../../..")

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
}
