import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, type Entry } from "@zip.js/zip.js"
import {
  MAX_AGENT_PLUGIN_BYTES,
  MAX_AGENT_PLUGIN_FILES,
  agentPluginTree,
  type AgentPluginTreeEntry,
} from "@claxedo/server-core/agent-plugins/artifacts/tree"
import type {
  AgentPluginCollectionSource,
  AgentPluginSourceKind,
} from "@claxedo/server-core/agent-plugins/catalog/types"
import type { CatalogSourceProvider } from "@claxedo/server-core/agent-plugins/ports"

const OWNER_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,99})$/
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024
const MAX_ARCHIVE_ENTRIES = 25_000
const MAX_COLLECTION_UNCOMPRESSED_BYTES = 200 * 1024 * 1024
const MAX_GITHUB_METADATA_BYTES = 256 * 1024
const GITHUB_REQUEST_TIMEOUT_MS = 15_000

export type PublicGitHubCollection = {
  id: string
  kind: AgentPluginSourceKind
  label: string
  owner: string
  repository: string
  ref: string
}

type Fetch = typeof globalThis.fetch

function unavailable(collection: PublicGitHubCollection, message: string): AgentPluginCollectionSource {
  return {
    id: collection.id,
    kind: collection.kind,
    label: collection.label,
    revision: collection.ref,
    plugins: [],
    errors: [{ relativePath: ".", code: "source_unavailable", message }],
  }
}

async function responseBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`)
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      size += result.value.byteLength
      if (size > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`)
      chunks.push(result.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

function safeArchivePath(filename: string): string[] | undefined {
  if (!filename || filename.startsWith("/") || filename.includes("\\") || filename.includes("\0")) return undefined
  const parts = filename.replace(/\/$/, "").split("/")
  if (parts.some((part) => !part || part === "." || part === "..")) return undefined
  return parts
}

function isSymlink(entry: Entry) {
  if (entry.msDosCompatible) return false
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  return (unixMode & 0o170000) === 0o120000
}

type PendingPlugin = {
  entries: Map<string, Entry | "directory">
  bytes: number
  error?: { code: "manifest_invalid" | "plugin_root_escape"; message: string }
}

function fail(plugin: PendingPlugin, code: "manifest_invalid" | "plugin_root_escape", message: string) {
  plugin.error ??= { code, message }
}

function addParents(entries: Map<string, Entry | "directory">, relativePath: string) {
  const parts = relativePath.split("/")
  for (let index = 1; index < parts.length; index++) {
    const parent = parts.slice(0, index).join("/")
    if (!entries.has(parent)) entries.set(parent, "directory")
  }
}

async function archiveSource(
  collection: PublicGitHubCollection,
  revision: string,
  archive: Uint8Array,
): Promise<AgentPluginCollectionSource> {
  const reader = new ZipReader(new Uint8ArrayReader(archive))
  try {
    const zipEntries = await reader.getEntries()
    if (zipEntries.length > MAX_ARCHIVE_ENTRIES) throw new Error(`archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`)
    const uncompressedBytes = zipEntries.reduce((total, entry) => total + (entry.directory ? 0 : entry.uncompressedSize), 0)
    if (!Number.isSafeInteger(uncompressedBytes) || uncompressedBytes > MAX_COLLECTION_UNCOMPRESSED_BYTES) {
      throw new Error(`archive expands beyond ${MAX_COLLECTION_UNCOMPRESSED_BYTES} bytes`)
    }
    const pending = new Map<string, PendingPlugin>()
    let archiveRoot: string | undefined
    for (const entry of zipEntries) {
      const parts = safeArchivePath(entry.filename)
      if (!parts) throw new Error(`archive contains an unsafe path: ${entry.filename}`)
      archiveRoot ??= parts[0]
      if (parts[0] !== archiveRoot) throw new Error("archive contains more than one root directory")
      if (parts.length < 3) continue // archive root itself or collection-level file/directory
      const pluginName = parts[1]
      const relativePath = parts.slice(2).join("/")
      const plugin = pending.get(pluginName) ?? { entries: new Map(), bytes: 0 }
      pending.set(pluginName, plugin)
      if (plugin.entries.has(relativePath)) {
        fail(plugin, "manifest_invalid", `archive contains duplicate path ${relativePath}`)
        continue
      }
      if (entry.encrypted) {
        fail(plugin, "manifest_invalid", `archive entry ${relativePath} is encrypted`)
        continue
      }
      if (isSymlink(entry)) {
        fail(plugin, "plugin_root_escape", `archive entry ${relativePath} is a symbolic link`)
        continue
      }
      if (entry.uncompressedSize > MAX_AGENT_PLUGIN_BYTES || plugin.bytes + entry.uncompressedSize > MAX_AGENT_PLUGIN_BYTES) {
        fail(plugin, "manifest_invalid", `plugin ${pluginName} exceeds ${MAX_AGENT_PLUGIN_BYTES} bytes`)
        continue
      }
      if (plugin.entries.size >= MAX_AGENT_PLUGIN_FILES) {
        fail(plugin, "manifest_invalid", `plugin ${pluginName} contains too many entries`)
        continue
      }
      addParents(plugin.entries, relativePath)
      plugin.entries.set(relativePath, entry.directory ? "directory" : entry)
      if (!entry.directory) plugin.bytes += entry.uncompressedSize
    }

    const plugins: AgentPluginCollectionSource["plugins"][number][] = []
    const errors: NonNullable<AgentPluginCollectionSource["errors"]>[number][] = []
    for (const [pluginName, plugin] of [...pending].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (plugin.error) {
        errors.push({ relativePath: pluginName, ...plugin.error })
        continue
      }
      try {
        const entries: AgentPluginTreeEntry[] = []
        for (const [relativePath, source] of [...plugin.entries].toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
          if (source === "directory") {
            entries.push({ path: relativePath, kind: "directory" })
          } else {
            if (!source.getData) throw new Error(`archive entry ${relativePath} cannot be read`)
            const bytes = await source.getData(new Uint8ArrayWriter())
            if (bytes.byteLength !== source.uncompressedSize) throw new Error(`archive entry ${relativePath} changed size while reading`)
            entries.push({
              path: relativePath,
              kind: "file",
              bytes,
              executableMode: source.executable ? 0o111 : 0,
            })
          }
        }
        plugins.push({ relativePath: pluginName, tree: agentPluginTree(entries) })
      } catch (cause) {
        errors.push({
          relativePath: pluginName,
          code: "manifest_invalid",
          message: cause instanceof Error ? cause.message : String(cause),
        })
      }
    }
    return {
      id: collection.id,
      kind: collection.kind,
      label: collection.label,
      revision,
      plugins,
      errors,
    }
  } finally {
    await reader.close().catch(() => undefined)
  }
}

async function resolveRevision(fetcher: Fetch, collection: PublicGitHubCollection) {
  const response = await fetcher(
    `https://api.github.com/repos/${collection.owner}/${collection.repository}/commits/${encodeURIComponent(collection.ref)}`,
    {
      headers: { accept: "application/vnd.github+json", "user-agent": "Claxedo-Agent-Plugins" },
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    },
  )
  if (!response.ok) throw new Error(`GitHub revision lookup failed with ${response.status}`)
  const raw = JSON.parse(new TextDecoder().decode(await responseBytes(response, MAX_GITHUB_METADATA_BYTES))) as unknown
  if (!raw || typeof raw !== "object" || !("sha" in raw) || typeof raw.sha !== "string" || !/^[a-f0-9]{40}$/.test(raw.sha)) {
    throw new Error("GitHub revision lookup returned an invalid commit")
  }
  return raw.sha
}

async function loadCollection(fetcher: Fetch, collection: PublicGitHubCollection) {
  if (!OWNER_REPOSITORY.test(collection.owner) || !OWNER_REPOSITORY.test(collection.repository) || !collection.ref.trim()) {
    return unavailable(collection, "Public GitHub collection configuration is invalid")
  }
  try {
    const revision = await resolveRevision(fetcher, collection)
    const response = await fetcher(
      `https://codeload.github.com/${collection.owner}/${collection.repository}/zip/${revision}`,
      {
        headers: { accept: "application/zip", "user-agent": "Claxedo-Agent-Plugins" },
        signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
      },
    )
    if (!response.ok) throw new Error(`GitHub archive download failed with ${response.status}`)
    return await archiveSource(collection, revision, await responseBytes(response, MAX_ARCHIVE_BYTES))
  } catch (cause) {
    return unavailable(collection, cause instanceof Error ? cause.message : String(cause))
  }
}

/** Public-only GitHub source adapter. Source selection remains a containing-product concern. */
export function publicGitHubCatalogSourceProvider(input: {
  collections: readonly PublicGitHubCollection[]
  fetch?: Fetch
}): CatalogSourceProvider {
  const fetcher = input.fetch ?? globalThis.fetch
  let cache: Promise<readonly AgentPluginCollectionSource[]> | undefined
  return {
    listAuthorizedSources(options = {}) {
      if (!cache || options.fresh) cache = Promise.all(input.collections.map((collection) => loadCollection(fetcher, collection)))
      return cache
    },
  }
}

/** The one public Claxedo collection used by products that include Agent Plugins. */
export function claxedoPublicGitHubCatalogSourceProvider(fetch?: Fetch) {
  return publicGitHubCatalogSourceProvider({
    collections: [{
      id: "claxedo",
      kind: "claxedo",
      label: "Claxedo",
      owner: "kyashrathore",
      repository: "plugins",
      ref: "main",
    }],
    ...(fetch ? { fetch } : {}),
  })
}
