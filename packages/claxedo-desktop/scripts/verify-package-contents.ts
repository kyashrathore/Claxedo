#!/usr/bin/env bun
/**
 * Packaging invariant: every JavaScript dependency is bundled from an entry
 * point at build time, so the packaged asar must contain no node_modules
 * beyond the native modules that cannot be bundled (better-sqlite3, node-pty,
 * @lydell/node-pty, plus @vscode/windows-process-tree on Windows).
 *
 * Runs against an already-packaged app (the app.asar under dist, any
 * platform). Wire in after electron-builder (package.ts).
 */

import * as fs from "node:fs"
import * as path from "node:path"

const ALLOWED_TOP_LEVEL = new Set(["better-sqlite3", "node-pty"])
const ALLOWED_SCOPED = new Set(["@lydell/node-pty", "@vscode/windows-process-tree"])

function findAsars(root: string): string[] {
  const dist = path.resolve(root, "dist")
  if (!fs.existsSync(dist)) return []
  const found: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(p, depth + 1)
      else if (entry.name === "app.asar") found.push(p)
    }
  }
  walk(dist, 0)
  return found
}

function asarHeaderFiles(archive: string): string[] {
  const fd = fs.openSync(archive, "r")
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const jsonLen = head.readUInt32LE(12)
    const jsonBuf = Buffer.alloc(jsonLen)
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
    const header = JSON.parse(jsonBuf.toString())
    const files: string[] = []
    const walk = (node: { files?: Record<string, unknown> }, prefix: string) => {
      for (const [name, child] of Object.entries(node.files ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name
        if (child && typeof child === "object" && "files" in child) {
          walk(child as { files?: Record<string, unknown> }, p)
          continue
        }
        // File entries carry content (size/offset); directory entries do not.
        // electron-builder leaves empty package-dir stubs for excluded
        // dependencies — harmless, and not a packaging-invariant violation.
        files.push(p)
      }
    }
    walk(header, "")
    return files
  } finally {
    fs.closeSync(fd)
  }
}

export function verifyPackageContents(root = path.resolve(import.meta.dir, "..")) {
  const asars = findAsars(root)
  if (asars.length === 0) {
    throw new Error(`no packaged app.asar found under ${path.resolve(root, "dist")} — run packaging first`)
  }
  const failures: string[] = []
  for (const archive of asars) {
    const offenders = asarHeaderFiles(archive)
      .filter((entry) => entry.startsWith("node_modules/"))
      .map((entry) => {
        const parts = entry.split("/")
        return parts[1]!.startsWith("@") ? parts.slice(1, 3).join("/") : parts[1]!
      })
      .filter((top) => !ALLOWED_TOP_LEVEL.has(top) && !ALLOWED_SCOPED.has(top))
    for (const offender of new Set(offenders)) {
      failures.push(
        `${archive}: node_modules/${offender} ships but is not a declared native module — ` +
          `bundle it from an entry point instead (electron.vite.config.ts / bundle-claxedo-server.ts)`,
      )
    }
  }
  return { asars, failures }
}

if (import.meta.main) {
  const { asars, failures } = verifyPackageContents()
  if (failures.length > 0) {
    console.error(`[verify-package-contents] packaging invariant violated:\n${failures.join("\n")}`)
    process.exit(1)
  }
  console.log(`[verify-package-contents] ok — ${asars.length} asar(s) contain only bundled output + native modules`)
}
