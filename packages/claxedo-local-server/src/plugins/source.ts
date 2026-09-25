import fs from "node:fs/promises"
import path from "node:path"

export const SOURCE_SKIPPED_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"])
export const SOURCE_FILE_MAX_BYTES = 256 * 1024
export const SOURCE_LIST_MAX_FILES = 500
const SOURCE_MAX_DEPTH = 12

export type PluginSourceFile = { path: string; size: number }
export type PluginSourceListing = { files: PluginSourceFile[]; truncated: boolean }
export type PluginSourceText = { path: string; size: number; text: string }

export class PluginSourceError extends Error {
  readonly status: 400 | 403 | 404 | 413 | 415
  readonly code: string

  constructor(status: 400 | 403 | 404 | 413 | 415, code: string, message: string) {
    super(message)
    this.name = "PluginSourceError"
    this.status = status
    this.code = code
  }
}

async function lstatOrUndefined(file: string) {
  try {
    return await fs.lstat(file)
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return undefined
    throw error
  }
}

async function folderRoot(directory: string): Promise<string> {
  const stat = await lstatOrUndefined(directory)
  if (!stat) throw new PluginSourceError(404, "live_plugin_source_folder_missing", `${directory} no longer exists`)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new PluginSourceError(403, "live_plugin_source_folder_replaced", `${directory} is no longer the registered folder`)
  }
  return directory
}

export async function listPluginSource(directory: string): Promise<PluginSourceListing> {
  const root = await folderRoot(directory)
  const files: PluginSourceFile[] = []
  let truncated = false
  const walk = async (relative: string, depth: number): Promise<void> => {
    if (depth > SOURCE_MAX_DEPTH) {
      truncated = true
      return
    }
    const entries = await fs.readdir(path.join(root, relative), { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (files.length >= SOURCE_LIST_MAX_FILES) {
        truncated = true
        return
      }
      if (SOURCE_SKIPPED_NAMES.has(entry.name)) continue
      const child = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(child, depth + 1)
      else if (entry.isFile()) files.push({ path: child, size: (await fs.lstat(path.join(root, child))).size })
    }
  }
  await walk("", 0)
  return { files, truncated }
}

function sourceSegments(requested: string): string[] {
  const refuse = () => {
    throw new PluginSourceError(400, "live_plugin_source_path_invalid", "A source path is relative to the plugin folder and stays inside it")
  }
  if (!requested || requested.includes("\0") || requested.includes("\\") || requested.startsWith("/")) refuse()
  const segments = requested.split("/")
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") refuse()
    if (SOURCE_SKIPPED_NAMES.has(segment)) {
      throw new PluginSourceError(403, "live_plugin_source_skipped", `${segment} is not part of a plugin's source`)
    }
  }
  return segments
}

export async function readPluginSource(directory: string, requested: string): Promise<PluginSourceText> {
  const root = await folderRoot(directory)
  const segments = sourceSegments(requested)
  let current = root
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment)
    const stat = await lstatOrUndefined(current)
    if (!stat) throw new PluginSourceError(404, "live_plugin_source_not_found", `${requested} is not in the plugin folder`)
    if (stat.isSymbolicLink()) throw new PluginSourceError(403, "live_plugin_source_symlink", `${requested} goes through a symbolic link`)
    const last = index === segments.length - 1
    if (!last && !stat.isDirectory()) throw new PluginSourceError(404, "live_plugin_source_not_found", `${requested} is not in the plugin folder`)
    if (last && !stat.isFile()) throw new PluginSourceError(404, "live_plugin_source_not_found", `${requested} is not a file`)
    if (last && stat.size > SOURCE_FILE_MAX_BYTES) {
      throw new PluginSourceError(413, "live_plugin_source_too_large", `${requested} is ${stat.size} bytes; the viewer shows files up to ${SOURCE_FILE_MAX_BYTES}`)
    }
  }
  const handle = await fs.open(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > SOURCE_FILE_MAX_BYTES) {
      throw new PluginSourceError(403, "live_plugin_source_changed", `${requested} changed while it was being read`)
    }
    const buffer = Buffer.alloc(SOURCE_FILE_MAX_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > SOURCE_FILE_MAX_BYTES) {
      throw new PluginSourceError(403, "live_plugin_source_changed", `${requested} changed while it was being read`)
    }
    bytes = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  if (bytes.includes(0)) throw new PluginSourceError(415, "live_plugin_source_binary", `${requested} is not a text file`)
  return { path: segments.join("/"), size: bytes.byteLength, text: bytes.toString("utf8") }
}
