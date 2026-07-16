import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import {
  DocumentInvalidEntryError,
  DocumentSnapshotCorruptError,
  DocumentSnapshotNotFoundError,
  documentErrorFromCause,
  nodeErrorCode,
} from "./errors"
import { mapBounded } from "./map-bounded"
import { boundedSnapshotPins, expiredSnapshotLease, requireBoundedSnapshotMetadata } from "./snapshot-pins"
import type { DocumentActor, SnapshotID, SnapshotRef } from "./port"
import { contentHash } from "./version"

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export type HistoryOptions = Readonly<{
  root: string
  maxSnapshots: number
  maxAgeMs: number
  now?: () => number
  faults?: Readonly<{
    beforeMkdir?: () => void | Promise<void>
    beforeCleanup?: () => void | Promise<void>
    beforeContentCleanup?: (snapshotId: SnapshotID) => void | Promise<void>
    beforeMetadataRead?: (snapshotId: SnapshotID) => void | Promise<void>
  }>
}>

type CreateSnapshotInput = Readonly<{
  markdown: string
  reason: string
  actor: DocumentActor
  sessionId?: string
}>

export type DocumentHistory = ReturnType<typeof createDocumentHistory>

export function createDocumentHistory(options: HistoryOptions) {
  if (!Number.isSafeInteger(options.maxSnapshots) || options.maxSnapshots < 1) {
    throw new DocumentInvalidEntryError("Snapshot retention must keep at least one unpinned snapshot")
  }
  if (options.maxAgeMs < 0 || Number.isNaN(options.maxAgeMs)) {
    throw new DocumentInvalidEntryError("Snapshot retention age must be a non-negative duration")
  }
  const now = options.now ?? Date.now

  return {
    async create(documentId: string, input: CreateSnapshotInput) {
      if (!input.reason.trim()) throw new DocumentInvalidEntryError("Snapshot reason is required")
      if (!input.actor.id.trim()) throw new DocumentInvalidEntryError("Snapshot actor id is required")
      const content = Buffer.from(input.markdown)
      const sha256 = contentHash(content)
      const existing = (await list(documentId))[0]
      if (existing?.sha256 === sha256) return existing

      const createdAt = Math.max(now(), (existing?.createdAt ?? 0) + 1)
      const metadata: SnapshotRef = {
        id: ulid(createdAt) as SnapshotID,
        sha256,
        size: content.byteLength,
        reason: input.reason,
        actor: input.actor,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        createdAt,
        pins: [],
      }
      const directory = historyDirectory(options.root, documentId)
      await Promise.resolve()
        .then(() => options.faults?.beforeMkdir?.())
        .then(() => fs.mkdir(directory, { recursive: true, mode: 0o700 }))
        .catch((error: unknown) => {
          throw documentErrorFromCause(error, `creating snapshot directory for ${documentId}`)
        })
      const markdownPath = path.join(directory, `${metadata.id}.md`)

      try {
        const file = await fs.open(markdownPath, "wx", 0o400)
        try {
          await file.writeFile(content)
          await file.sync()
        } finally {
          await file.close()
        }
        await atomicWrite(metadataPath(directory, metadata.id), JSON.stringify(metadata), 0o600)
        await syncDirectory(directory)
      } catch (error) {
        await removeIfPresent(markdownPath).catch((cleanupError: unknown) => {
          throw documentErrorFromCause(cleanupError, `cleaning failed snapshot ${metadata.id}`)
        })
        throw documentErrorFromCause(error, `creating snapshot ${metadata.id}`)
      }

      await collect(documentId)
      return metadata
    },

    list,

    async read(documentId: string, snapshotId: SnapshotID) {
      const directory = historyDirectory(options.root, documentId)
      const metadata = await readMetadata(directory, snapshotId)
      const content = await fs.readFile(path.join(directory, `${snapshotId}.md`)).catch((error: unknown) => {
        if (nodeErrorCode(error) === "ENOENT") throw new DocumentSnapshotNotFoundError(snapshotId, { cause: error })
        throw documentErrorFromCause(error, `reading snapshot ${snapshotId}`)
      })
      if (content.byteLength !== metadata.size || contentHash(content) !== metadata.sha256) {
        throw new DocumentSnapshotCorruptError(snapshotId)
      }
      try {
        return {
          markdown: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content),
          metadata,
        }
      } catch (error) {
        throw new DocumentSnapshotCorruptError(snapshotId, { cause: error })
      }
    },

    pin: (documentId: string, snapshotId: SnapshotID, pin: string) => {
      requirePin(pin)
      return updatePins(documentId, snapshotId, (pins) => [...pins, pin])
    },
    unpin: (documentId: string, snapshotId: SnapshotID, pin: string) => {
      requirePin(pin)
      return updatePins(documentId, snapshotId, (pins) => pins.filter((candidate) => candidate !== pin))
    },
    collect,
  }

  async function list(documentId: string): Promise<SnapshotRef[]> {
    const directory = historyDirectory(options.root, documentId)
    const names = await fs.readdir(directory).catch((error: unknown) => {
      if (nodeErrorCode(error) === "ENOENT") return []
      throw documentErrorFromCause(error, `listing document ${documentId} snapshots`)
    })
    return (
      await mapBounded(
        names.filter((name) => name.endsWith(".json")),
        (name) => {
          const snapshotId = name.slice(0, -5) as SnapshotID
          return Promise.resolve(options.faults?.beforeMetadataRead?.(snapshotId)).then(() =>
            readMetadata(directory, snapshotId),
          )
        },
      )
    ).sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  async function updatePins(
    documentId: string,
    snapshotId: SnapshotID,
    update: (pins: readonly string[]) => readonly string[],
  ) {
    const directory = historyDirectory(options.root, documentId)
    const metadata = await readMetadata(directory, snapshotId)
    const pins = boundedSnapshotPins(update(metadata.pins), now())
    const updated = { ...metadata, pins }
    const body = new TextDecoder().decode(requireBoundedSnapshotMetadata(updated))
    await atomicWrite(metadataPath(directory, snapshotId), body, 0o600).catch((error: unknown) => {
      throw documentErrorFromCause(error, `updating snapshot ${snapshotId} pins`)
    })
    return updated
  }

  async function collect(documentId: string) {
    const snapshots = await list(documentId)
    const unpinned = snapshots.filter((snapshot) => snapshot.pins.every((pin) => expiredSnapshotLease(pin, now())))
    const expiredBefore = now() - options.maxAgeMs
    const directory = historyDirectory(options.root, documentId)
    await Promise.resolve()
      .then(() => options.faults?.beforeCleanup?.())
      .then(async () => {
        await unpinned
          .filter(
            (snapshot, index) => index >= options.maxSnapshots || (index > 0 && snapshot.createdAt < expiredBefore),
          )
          .reduce(async (previous, snapshot) => {
            await previous
            await removeIfPresent(metadataPath(directory, snapshot.id))
            await syncDirectory(directory)
            await options.faults?.beforeContentCleanup?.(snapshot.id)
            await removeIfPresent(path.join(directory, `${snapshot.id}.md`))
            await syncDirectory(directory)
          }, Promise.resolve())

        const names = await fs.readdir(directory).catch((error: unknown) => {
          if (nodeErrorCode(error) === "ENOENT") return []
          throw error
        })
        const metadata = new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)))
        const orphans = names.filter((name) => name.endsWith(".md") && !metadata.has(name.slice(0, -3)))
        await mapBounded(orphans, (name) => removeIfPresent(path.join(directory, name)))
        if (orphans.length) await syncDirectory(directory)
      })
      .catch((error: unknown) => {
        throw documentErrorFromCause(error, `collecting document ${documentId} snapshots`)
      })
  }
}

function historyDirectory(root: string, documentId: string) {
  return path.join(root, "document-history", documentId)
}

function metadataPath(directory: string, snapshotId: SnapshotID) {
  return path.join(directory, `${snapshotId}.json`)
}

async function readMetadata(directory: string, snapshotId: SnapshotID): Promise<SnapshotRef> {
  const raw = await fs.readFile(metadataPath(directory, snapshotId), "utf8").catch((error: unknown) => {
    if (nodeErrorCode(error) === "ENOENT") throw new DocumentSnapshotNotFoundError(snapshotId, { cause: error })
    throw documentErrorFromCause(error, `reading snapshot ${snapshotId} metadata`)
  })
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isSnapshotRef(parsed) || parsed.id !== snapshotId) throw new Error("Invalid snapshot metadata")
    return parsed
  } catch (error) {
    throw new DocumentSnapshotCorruptError(snapshotId, { cause: error })
  }
}

function isSnapshotRef(value: unknown): value is SnapshotRef {
  if (!value || typeof value !== "object") return false
  if (!("id" in value) || typeof value.id !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value.id)) return false
  if (!("sha256" in value) || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return false
  if (!("size" in value) || typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0)
    return false
  if (!("reason" in value) || typeof value.reason !== "string" || !value.reason) return false
  if (!("createdAt" in value) || typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false
  if (!("pins" in value) || !Array.isArray(value.pins) || !value.pins.every((pin) => typeof pin === "string" && !!pin))
    return false
  if (!("actor" in value) || !isActor(value.actor)) return false
  if ("sessionId" in value && value.sessionId !== undefined && typeof value.sessionId !== "string") return false
  return true
}

function isActor(value: unknown): value is DocumentActor {
  if (!value || typeof value !== "object") return false
  if (!("type" in value) || !["user", "agent", "system"].includes(String(value.type))) return false
  return "id" in value && typeof value.id === "string" && !!value.id
}

function requirePin(pin: string) {
  if (!pin.trim()) throw new DocumentInvalidEntryError("Snapshot pin must be a non-empty stable identifier")
}

async function atomicWrite(file: string, content: string, mode: number) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`)
  const handle = await fs.open(temporary, "wx", mode)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, file)
    await syncDirectory(path.dirname(file))
  } catch (error) {
    await removeIfPresent(temporary)
    throw error
  }
}

async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error
  } finally {
    await handle.close()
  }
}

function directorySyncUnsupported(error: unknown) {
  return ["EINVAL", "ENOTSUP", "EBADF", "EISDIR"].includes(nodeErrorCode(error) ?? "")
}

async function removeIfPresent(file: string) {
  await fs.unlink(file).catch((error: unknown) => {
    if (nodeErrorCode(error) !== "ENOENT") throw error
  })
}

function ulid(timestamp: number) {
  return (
    encodeBase32(BigInt(Math.floor(timestamp)), 10) + encodeBase32(BigInt(`0x${randomBytes(10).toString("hex")}`), 16)
  )
}

function encodeBase32(value: bigint, length: number) {
  const output = Array.from({ length }, () => "0")
  for (let index = length - 1; index >= 0; index--) {
    output[index] = CROCKFORD[Number(value & 31n)]!
    value >>= 5n
  }
  return output.join("")
}
