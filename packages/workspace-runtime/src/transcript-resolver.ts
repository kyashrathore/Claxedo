import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import fsSync from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

export type TranscriptProvider = {
  root: string
  format: "jsonl" | "json"
}

export type TranscriptUnavailable = {
  state: "unavailable"
  reason: string
}

export type TranscriptResolution =
  | { state: "ready"; messages: unknown[] }
  | { state: "empty"; messages: [] }
  | TranscriptUnavailable

export type TranscriptHandleBinding = {
  workspaceId: string
  parentSessionId: string
  providerKind: string
  sourcePath: string
  canonicalPath: string
  canonicalRoot: string
  format: TranscriptProvider["format"]
  digest: string
}

export type TranscriptHandleStore = {
  create(binding: TranscriptHandleBinding): string
  get(handle: string): TranscriptHandleBinding | undefined
  invalidateParent(workspaceId: string, parentSessionId: string): void
}

export function createMemoryTranscriptHandleStore(createHandle = () => `transcript_${randomUUID()}`): TranscriptHandleStore {
  const bindings = new Map<string, TranscriptHandleBinding>()
  return {
    create(binding) {
      const handle = createHandle()
      bindings.set(handle, binding)
      return handle
    },
    get(handle) {
      return bindings.get(handle)
    },
    invalidateParent(workspaceId, parentSessionId) {
      bindings.forEach((binding, handle) => {
        if (binding.workspaceId === workspaceId && binding.parentSessionId === parentSessionId) bindings.delete(handle)
      })
    },
  }
}

export function createPersistentTranscriptHandleStore(input: {
  file: string
  createHandle?: () => string
}): TranscriptHandleStore {
  const open = () => {
    fsSync.mkdirSync(path.dirname(input.file), { recursive: true, mode: 0o700 })
    const requireDatabase = createRequire(import.meta.url)
    const Database = process.versions.bun
      ? (requireDatabase("bun:sqlite") as { Database: TranscriptDatabaseConstructor }).Database
      : ((requireDatabase("better-sqlite3") as { default?: TranscriptDatabaseConstructor } | TranscriptDatabaseConstructor) as {
          default?: TranscriptDatabaseConstructor
        }).default ?? requireDatabase("better-sqlite3") as TranscriptDatabaseConstructor
    const database = new Database(input.file)
    fsSync.chmodSync(input.file, 0o600)
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec(`
      CREATE TABLE IF NOT EXISTS transcript_handle (
        handle TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_session_id TEXT NOT NULL,
        provider_kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        canonical_path TEXT NOT NULL,
        canonical_root TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('jsonl', 'json')),
        digest TEXT NOT NULL
      )
    `)
    database.exec(`
      CREATE INDEX IF NOT EXISTS transcript_handle_parent_idx
      ON transcript_handle (workspace_id, parent_session_id)
    `)
    return database
  }
  return {
    create(binding) {
      const handle = input.createHandle?.() ?? `transcript_${randomUUID()}`
      const database = open()
      try {
        database.prepare(`
          INSERT INTO transcript_handle (
            handle, workspace_id, parent_session_id, provider_kind, source_path,
            canonical_path, canonical_root, format, digest
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          handle,
          binding.workspaceId,
          binding.parentSessionId,
          binding.providerKind,
          binding.sourcePath,
          binding.canonicalPath,
          binding.canonicalRoot,
          binding.format,
          binding.digest,
        )
      } finally {
        database.close()
      }
      return handle
    },
    get(handle) {
      const database = open()
      try {
        const row = database.prepare(`
          SELECT workspace_id, parent_session_id, provider_kind, source_path,
            canonical_path, canonical_root, format, digest
          FROM transcript_handle
          WHERE handle = ?
        `).get(handle) as TranscriptHandleRow | undefined
        if (!row) return
        return {
          workspaceId: row.workspace_id,
          parentSessionId: row.parent_session_id,
          providerKind: row.provider_kind,
          sourcePath: row.source_path,
          canonicalPath: row.canonical_path,
          canonicalRoot: row.canonical_root,
          format: row.format,
          digest: row.digest,
        }
      } finally {
        database.close()
      }
    },
    invalidateParent(workspaceId, parentSessionId) {
      const database = open()
      try {
        database.prepare(`
          DELETE FROM transcript_handle
          WHERE workspace_id = ? AND parent_session_id = ?
        `).run(workspaceId, parentSessionId)
      } finally {
        database.close()
      }
    },
  }
}

type TranscriptDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): {
    run(...params: unknown[]): unknown
    get(...params: unknown[]): unknown
  }
  close(): unknown
}

type TranscriptDatabaseConstructor = new(file: string) => TranscriptDatabase

type TranscriptHandleRow = {
  workspace_id: string
  parent_session_id: string
  provider_kind: string
  source_path: string
  canonical_path: string
  canonical_root: string
  format: TranscriptProvider["format"]
  digest: string
}

export function createTranscriptResolver(options: {
  workspaceId: string
  providers: Record<string, TranscriptProvider>
  authorizeParent: (input: {
    workspaceId: string
    parentSessionId: string
    providerKind: string
  }) => boolean | Promise<boolean>
  createHandle?: () => string
  handleStore?: TranscriptHandleStore
  maxBytes?: number
  maxEntries?: number
}) {
  const maxBytes = Math.max(1, Math.floor(options.maxBytes ?? 5 * 1024 * 1024))
  const maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 10_000))
  const handles = options.handleStore ?? createMemoryTranscriptHandleStore(options.createHandle)

  return {
    async register(input: {
      workspaceId: string
      parentSessionId: string
      providerKind: string
      filePath: string
    }): Promise<{ state: "ready"; handle: string } | TranscriptUnavailable> {
      if (input.workspaceId !== options.workspaceId) return unavailable("unauthorized")
      const provider = options.providers[input.providerKind]
      if (!provider) return unavailable("unsupported-provider")
      if (!await options.authorizeParent(input)) return unavailable("unauthorized")

      const inspected = await inspectSource(provider.root, input.filePath, maxBytes)
      if (inspected.state === "unavailable") return inspected
      return {
        state: "ready",
        handle: handles.create({
          workspaceId: input.workspaceId,
          parentSessionId: input.parentSessionId,
          providerKind: input.providerKind,
          sourcePath: path.resolve(input.filePath),
          canonicalPath: inspected.canonicalPath,
          canonicalRoot: inspected.canonicalRoot,
          format: provider.format,
          digest: inspected.digest,
        }),
      }
    },

    async open(input: {
      workspaceId: string
      parentSessionId: string
      handle: string
    }): Promise<TranscriptResolution> {
      const binding = handles.get(input.handle)
      if (!binding) return unavailable("invalid-handle")
      if (binding.workspaceId !== options.workspaceId ||
        binding.workspaceId !== input.workspaceId ||
        binding.parentSessionId !== input.parentSessionId) return unavailable("unauthorized")
      if (!await options.authorizeParent({
        workspaceId: binding.workspaceId,
        parentSessionId: binding.parentSessionId,
        providerKind: binding.providerKind,
      })) return unavailable("unauthorized")

      const provider = options.providers[binding.providerKind]
      if (!provider || provider.format !== binding.format) return unavailable("unsupported-provider")
      const inspected = await inspectSource(provider.root, binding.sourcePath, maxBytes)
      if (inspected.state === "unavailable") return inspected
      if (inspected.canonicalRoot !== binding.canonicalRoot ||
        inspected.canonicalPath !== binding.canonicalPath ||
        inspected.digest !== binding.digest) return unavailable("mutated")
      return parseTranscript(inspected.text, binding.format, maxEntries)
    },

    invalidateParent(workspaceId: string, parentSessionId: string) {
      handles.invalidateParent(workspaceId, parentSessionId)
    },
  }
}

function unavailable(reason: string): TranscriptUnavailable {
  return { state: "unavailable", reason }
}

async function inspectSource(root: string, source: string, maxBytes: number): Promise<
  | { state: "ready"; canonicalRoot: string; canonicalPath: string; text: string; digest: string }
  | TranscriptUnavailable
> {
  const canonicalRoot = await fs.realpath(root).catch(() => undefined)
  const canonicalPath = await fs.realpath(source).catch(() => undefined)
  if (!canonicalRoot || !canonicalPath) return unavailable("missing")
  if (!isWithin(canonicalRoot, canonicalPath)) return unavailable("outside-root")
  if (isSensitive(root, source) || isSensitive(canonicalRoot, canonicalPath)) return unavailable("sensitive-path")

  const opened = await readBounded(canonicalPath, maxBytes)
  if (opened.state === "unavailable") return opened
  const rootAfterRead = await fs.realpath(root).catch(() => undefined)
  const pathAfterRead = await fs.realpath(source).catch(() => undefined)
  if (rootAfterRead !== canonicalRoot || pathAfterRead !== canonicalPath) return unavailable("mutated")
  return { state: "ready", canonicalRoot, canonicalPath, text: opened.text, digest: opened.digest }
}

async function readBounded(filePath: string, maxBytes: number): Promise<
  | { state: "ready"; text: string; digest: string }
  | TranscriptUnavailable
> {
  const file = await fs.open(filePath, "r").catch(() => undefined)
  if (!file) return unavailable("missing")
  try {
    const before = await file.stat()
    if (!before.isFile()) return unavailable("not-a-file")
    if (before.size > maxBytes) return unavailable("oversized")
    const buffer = Buffer.alloc(before.size + 1)
    let bytesRead = 0
    while (bytesRead < buffer.length) {
      const result = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxBytes) return unavailable("oversized")
    const after = await file.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      return unavailable("mutated")
    }
    const bytes = buffer.subarray(0, bytesRead)
    return {
      state: "ready",
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      digest: createHash("sha256").update(bytes).digest("hex"),
    }
  } catch {
    return unavailable("unreadable")
  } finally {
    await file.close()
  }
}

function isWithin(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)
}

function isSensitive(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false
  return relative.split(path.sep).some((segment) => {
    const value = segment.toLowerCase()
    const stem = path.parse(value).name
    return stem === "credentials" || stem === "credential" || stem === "config" || stem === "auth" ||
      stem === "secrets" || value === ".config" || value === ".git" || value === ".env" || value.startsWith(".env.")
  })
}

function parseTranscript(text: string, format: TranscriptProvider["format"], maxEntries: number): TranscriptResolution {
  if (!text.trim()) return { state: "empty", messages: [] }
  try {
    const lines = format === "jsonl" ? text.split(/\r?\n/).filter((line) => line.trim()) : undefined
    if (lines && lines.length > maxEntries) return unavailable("oversized")
    const messages = lines
      ? lines.map((line) => JSON.parse(line) as unknown)
      : messagesFromJson(JSON.parse(text) as unknown)
    if (!messages || messages.length > maxEntries) return unavailable(messages ? "oversized" : "malformed")
    if (messages.length === 0) return { state: "empty", messages: [] }
    return { state: "ready", messages }
  } catch {
    return unavailable("malformed")
  }
}

function messagesFromJson(value: unknown) {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object" && "messages" in value && Array.isArray(value.messages)) return value.messages
  return undefined
}
