#!/usr/bin/env bun
/**
 * Packaging invariants, checked against an already-packaged app (the app.asar
 * under dist, any platform). Wire in after electron-builder (package.ts).
 *
 * 1. Every JavaScript dependency is bundled from an entry point at build time,
 *    so the packaged asar must contain no node_modules beyond the native
 *    modules that cannot be bundled (better-sqlite3, node-pty,
 *    @lydell/node-pty, plus @vscode/windows-process-tree on Windows).
 *
 * 1b. And nothing else structural: every remaining asar entry must fall under
 *    a root `electron-builder.config.ts` declares. Both files read that
 *    declaration from `package-structure.ts`, so a `files` glob added without
 *    a declaration fails here rather than quietly enlarging the installer.
 *
 * 2. The English Chromium locale ships. `electronLanguages` DELETES every
 *    locale it does not name exactly, and the mac (`.lproj`, underscores) and
 *    win/linux (`.pak`, hyphens) spellings differ — so a plausible-looking
 *    name is a silent delete with no build error. Shipping without English
 *    left Chromium falling back to another bundled locale, which made
 *    `navigator.language` report that locale and the renderer render its
 *    dictionary: v0.0.64 showed a German UI on an English machine.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

import { ALL_NATIVE_MODULES, isDeclaredStructuralEntry, requiredPackagedBoundaryEntries } from "./package-structure"
import { verifyHostConnectorChildArtifact } from "../src/main/host-connector/child-artifact"

const ALLOWED_NATIVE_MODULES = new Set(ALL_NATIVE_MODULES)

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

/**
 * The directory holding Chromium's locale resources, for whichever platform
 * this app was packaged for: `<App>.app/Contents/Frameworks/Electron
 * Framework.framework/Resources/*.lproj` on mac, `resources/../locales/*.pak`
 * on win/linux. Returns the English entries found alongside the total count.
 */
function inspectLocales(archive: string) {
  // archive is <...>/<App>.app/Contents/Resources/app.asar (mac) or
  // <...>/resources/app.asar (win/linux); Chromium's locales are siblings.
  const resources = path.dirname(archive)
  const macDir = path.join(
    path.dirname(resources),
    "Frameworks",
    "Electron Framework.framework",
    "Resources",
  )
  const pakDir = path.join(path.dirname(resources), "locales")

  const read = (dir: string, ext: string) => {
    if (!fs.existsSync(dir)) return null
    const names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(ext))
      .map((name) => path.basename(name, ext))
    return names.length > 0 ? names : null
  }

  const mac = read(macDir, ".lproj")
  if (mac) return { dir: macDir, locales: mac, english: mac.filter((n) => n === "en" || n.startsWith("en_")) }

  const pak = read(pakDir, ".pak")
  if (pak) return { dir: pakDir, locales: pak, english: pak.filter((n) => n === "en" || n.startsWith("en-")) }

  return null
}

export type PackageTarget = { platform: NodeJS.Platform; arch: string }

export function canSmokePackagedBinary(target: PackageTarget) {
  return target.platform === process.platform && target.arch === process.arch
}

export function verifyPackageContents(
  root = path.resolve(import.meta.dir, ".."),
  target: PackageTarget = { platform: process.platform, arch: process.arch },
) {
  const asars = findAsars(root)
  if (asars.length === 0) {
    throw new Error(`no packaged app.asar found under ${path.resolve(root, "dist")} — run packaging first`)
  }
  const failures: string[] = []
  for (const archive of asars) {
    const resourceDir = path.join(path.dirname(archive), "host-connector")
    try {
      verifyHostConnectorChildArtifact(resourceDir)
    } catch (error) {
      failures.push(`${archive}: ${String(error)}`)
    }
    const richContent = path.join(path.dirname(archive), "rich-content")
    const binaries = [
      path.join(richContent, "claxedo-rich-content-renderer"),
      path.join(richContent, "claxedo-rich-content-renderer.exe"),
    ].filter((entry) => fs.existsSync(entry) && fs.statSync(entry).isFile())
    if (binaries.length !== 1) {
      failures.push(`${archive}: expected one packaged rich-content renderer in ${richContent}`)
      continue
    }
    if (!binaries[0]!.endsWith(".exe") && (fs.statSync(binaries[0]!).mode & 0o111) === 0) {
      failures.push(`${archive}: packaged rich-content renderer is not executable: ${binaries[0]}`)
      continue
    }
    // Cross-packaging creates binaries the host cannot execute (for example a
    // win32 .exe produced on macOS, or an x64 helper on arm64). Presence and
    // permissions remain packaging invariants; the functional smoke belongs to
    // a host with the same OS and architecture as the target.
    if (!canSmokePackagedBinary(target)) continue
    const markdown = spawnSync(binaries[0]!, ["markdown"], {
      input: JSON.stringify({ source: "# Packaged renderer\n\n| a | b |\n|---|---|\n| 1 | 2 |" }),
      encoding: "utf8",
    })
    if (markdown.status !== 0 || !markdown.stdout.includes("<table>")) {
      failures.push(`${archive}: packaged rich-content renderer failed its Markdown smoke`)
    }
    const mermaid = spawnSync(binaries[0]!, ["mermaid"], {
      input: JSON.stringify({ source: "flowchart LR\nA --> B", theme: { primaryColor: "#123456" } }),
      encoding: "utf8",
    })
    const svg = mermaid.stdout
    if (mermaid.status !== 0 || !svg.startsWith("<svg") || !svg.includes("#123456")) {
      failures.push(`${archive}: packaged rich-content renderer failed its Mermaid smoke`)
    }
  }
  for (const archive of asars) {
    const found = inspectLocales(archive)
    // Only assert when a locale directory is actually present: some targets
    // (and the asar-only fixtures in tests) have no Chromium resources beside
    // them, and a missing directory is not evidence of a dropped locale.
    if (!found) continue
    if (found.english.length === 0) {
      failures.push(
        `${archive}: no English Chromium locale in ${found.dir} — electronLanguages deleted it. ` +
          `Locale names differ per platform (mac .lproj uses "en"/"en_GB"; win/linux .pak uses ` +
          `"en-US"/"en-GB"); fix the list in electron-builder.config.ts. ` +
          `Shipped locales: ${found.locales.sort().join(", ") || "(none)"}`,
      )
    }
  }
  for (const archive of asars) {
    const entries = asarHeaderFiles(archive)
    for (const required of requiredPackagedBoundaryEntries(entries)) {
      if (!entries.includes(required)) {
        failures.push(`${archive}: required product-boundary manifest is missing: ${required}`)
      }
    }
    const offenders = entries
      .filter((entry) => entry.startsWith("node_modules/"))
      .map((entry) => {
        const parts = entry.split("/")
        return parts[1]!.startsWith("@") ? parts.slice(1, 3).join("/") : parts[1]!
      })
      .filter((top) => !ALLOWED_NATIVE_MODULES.has(top))
    for (const offender of new Set(offenders)) {
      failures.push(
        `${archive}: node_modules/${offender} ships but is not a declared native module — ` +
          `bundle it from an entry point instead (electron.vite.config.ts / bundle-claxedo-server.ts)`,
      )
    }

    // Everything that is not a native module must be declared build output.
    // Reported by ROOT rather than per file: an undeclared directory is one
    // decision, and listing its thousands of members would bury it.
    const undeclared = new Set(
      entries
        .filter((entry) => !entry.startsWith("node_modules/") && !isDeclaredStructuralEntry(entry))
        .map((entry) => entry.split("/")[0]!),
    )
    for (const root of undeclared) {
      failures.push(
        `${archive}: ${root} ships but is not a declared structural resource — ` +
          `add it to ASAR_STRUCTURAL_ROOTS in scripts/package-structure.ts, or remove the ` +
          `\`files\` glob in electron-builder.config.ts that admitted it`,
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
  console.log(
    `[verify-package-contents] ok — ${asars.length} package(s) contain only bundled output + native modules and a working rich-content renderer`,
  )
}
