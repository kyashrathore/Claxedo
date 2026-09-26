import * as fs from "node:fs"
import * as path from "node:path"

import {
  CLAXEDO_COMPILE_CACHE_MANIFEST_NAME,
  CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME,
  compileCacheEntrySource,
  parseCompileCacheManifest,
} from "../src/shared/compile-cache"
import { readRecord, readString } from "@claxedo/helpers/readers"

type AsarFile = { size: number; offset: number; unpacked: boolean }

const RENDERER_ASSETS = "out/renderer/assets/"
const SERVER_BUNDLE_ROOT = "out/main/claxedo-server"
const MINIFY_CHECK_MIN_BYTES = 64 * 1024
// Minified output packs statements into lines thousands of bytes long; only
// embedded multi-line strings (CSS, templates) keep short lines. Unminified
// output averages about forty bytes per line.
const LONG_LINE_BYTES = 1000
const MINIFIED_LONG_LINE_SHARE = 0.5

function readAsar(archive: string): { files: Map<string, AsarFile>; dataOffset: number } {
  const fd = fs.openSync(archive, "r")
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const headerPickleSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    const jsonBuf = Buffer.alloc(jsonLen)
    fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
    const files = new Map<string, AsarFile>()
    const walk = (node: unknown, prefix: string) => {
      for (const [name, child] of Object.entries(readRecord(node, "files") ?? {})) {
        const p = prefix ? `${prefix}/${name}` : name
        if (readRecord(child, "files")) {
          walk(child, p)
          continue
        }
        const record = child as { size?: unknown; offset?: unknown; unpacked?: unknown }
        files.set(p, {
          size: typeof record.size === "number" ? record.size : 0,
          offset: Number(readString(child, "offset") ?? 0),
          unpacked: record.unpacked === true,
        })
      }
    }
    walk(JSON.parse(jsonBuf.toString()), "")
    return { files, dataOffset: 8 + headerPickleSize }
  } finally {
    fs.closeSync(fd)
  }
}

function readAsarText(archive: string, file: AsarFile, dataOffset: number): string {
  const fd = fs.openSync(archive, "r")
  try {
    const buffer = Buffer.alloc(file.size)
    fs.readSync(fd, buffer, 0, file.size, dataOffset + file.offset)
    return buffer.toString("utf8")
  } finally {
    fs.closeSync(fd)
  }
}

export function isMinifiedScript(text: string): boolean {
  let longLineBytes = 0
  let start = 0
  while (start <= text.length) {
    const end = text.indexOf("\n", start)
    const stop = end === -1 ? text.length : end
    if (stop - start >= LONG_LINE_BYTES) longLineBytes += stop - start
    start = stop + 1
  }
  return longLineBytes >= text.length * MINIFIED_LONG_LINE_SHARE
}

/** The manifest entries whose source is not where the runtime's seeding looks for it. */
export function unresolvedCompileCacheEntries(
  manifestRaw: string,
  rootDir: string,
  exists: (file: string) => boolean,
): string[] {
  return parseCompileCacheManifest(manifestRaw)
    .entries.filter((entry) => compileCacheEntrySource(rootDir, entry.file, exists) === undefined)
    .map((entry) => entry.file)
}

/**
 * Startup costs a package can regress without any build error: an unminified
 * renderer chunk (electron-vite's renderer preset defaults minify off), and a
 * server compile-cache manifest naming files the packaged layout does not
 * put where seeding resolves them (seeding then installs nothing).
 */
export function verifyPackagedStartupArtifacts(archive: string): string[] {
  const failures: string[] = []
  const { files, dataOffset } = readAsar(archive)

  for (const [name, file] of files) {
    if (file.unpacked || !name.startsWith(RENDERER_ASSETS) || !name.endsWith(".js") || file.size < MINIFY_CHECK_MIN_BYTES) continue
    if (!isMinifiedScript(readAsarText(archive, file, dataOffset))) {
      failures.push(`${archive}: ${name} is not minified — set build.minify in the renderer's Vite config`)
    }
  }

  const resources = path.dirname(archive)
  const manifest = path.join(resources, CLAXEDO_SERVER_COMPILE_CACHE_DIR_NAME, CLAXEDO_COMPILE_CACHE_MANIFEST_NAME)
  if (!fs.existsSync(manifest)) {
    failures.push(`${archive}: the claxedo-server compile cache manifest is missing at ${manifest}`)
    return failures
  }
  const inArchive = archive + path.sep
  const exists = (file: string) =>
    file.startsWith(inArchive) ? files.has(file.slice(inArchive.length).split(path.sep).join("/")) : fs.existsSync(file)
  const unresolved = unresolvedCompileCacheEntries(fs.readFileSync(manifest, "utf8"), path.join(archive, SERVER_BUNDLE_ROOT), exists)
  if (unresolved.length > 0) {
    failures.push(
      `${archive}: ${String(unresolved.length)} claxedo-server compile cache entries have no packaged source ` +
        `(first: ${unresolved[0]}); seeding would install none of them`,
    )
  }
  return failures
}
