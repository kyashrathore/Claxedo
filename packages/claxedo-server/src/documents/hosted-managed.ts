import {
  DocumentAlreadyExistsError,
  DocumentInvalidEntryError,
  DocumentNotFoundError,
  DocumentSnapshotCorruptError,
  DocumentSnapshotNotFoundError,
  DocumentTooLargeError,
  DocumentVersionConflictError,
} from "./errors"
import type {
  DocumentActor,
  DocumentEntry,
  DocumentHandle,
  DocumentVersion,
  DocumentWorkspace,
  SnapshotID,
  SnapshotRef,
  WriteResult,
} from "./port"
import {
  boundedSnapshotPins,
  expiredSnapshotLease,
  MAX_SNAPSHOT_METADATA_BYTES,
  requireBoundedSnapshotMetadata,
} from "./snapshot-pins"
import { mapBounded } from "./map-bounded"

const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const DEFAULT_MAX_SNAPSHOTS = 50
const DEFAULT_MAX_SNAPSHOT_AGE_MS = 30 * 24 * 60 * 60 * 1_000
const PENDING_SNAPSHOT_LEASE_MS = 5 * 60_000
const SNAPSHOT_DELETE_GRACE_MS = 60_000
const DEFAULT_MAX_LIST_OBJECTS = 10_000

export type ConditionalObject = Readonly<{
  key: string
  body: Uint8Array
  etag: string
  uploadedAt: number
}>

export type ConditionalObjectStore = Readonly<{
  get(key: string): Promise<ConditionalObject | undefined>
  put(
    key: string,
    body: Uint8Array,
    condition: Readonly<{ etag?: string; absent?: true }>,
  ): Promise<Readonly<{ etag: string; uploadedAt: number }> | undefined>
  delete(key: string): Promise<void>
  list(prefix: string): Promise<readonly Readonly<{ key: string; etag: string; uploadedAt: number }>[]>
}>

export type HostedManagedHandle = DocumentHandle &
  Readonly<{
    origin: "managed"
    placement: "hosted"
    orgId: string
    relativePath: string
    objectKey: string
  }>

export type HostedManagedWorkspace = DocumentWorkspace<HostedManagedHandle> &
  Readonly<{
    create(
      entry: DocumentEntry,
      request: Readonly<{ markdown: string; actor: DocumentActor; sessionId?: string }>,
    ): Promise<WriteResult>
  }>

export function hostedManagedRelativePath(input: Readonly<{ documentId: string; slug: string }>) {
  requireSegment(input.documentId, "document id")
  const slug =
    input.slug
      .trim()
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-|-$/g, "") || "document"
  return `${input.documentId}/${slug}.md`
}

export function createHostedManagedDocumentWorkspace(
  options: Readonly<{
    store: ConditionalObjectStore
    maxDocumentBytes?: number
    maxSnapshots?: number
    maxSnapshotAgeMs?: number
    now?: () => number
    beforeSnapshotGcClaim?: (snapshotId: SnapshotID) => void | Promise<void>
    afterSnapshotGcClaim?: (snapshotId: SnapshotID) => void | Promise<void>
    snapshotDeleteGraceMs?: number
    beforeCanonicalWrite?: () => void | Promise<void>
  }>,
): HostedManagedWorkspace {
  const maxDocumentBytes = options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
  const maxSnapshots = options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? DEFAULT_MAX_SNAPSHOT_AGE_MS
  const now = options.now ?? Date.now
  const snapshotDeleteGraceMs = options.snapshotDeleteGraceMs ?? SNAPSHOT_DELETE_GRACE_MS

  return {
    async create(entry, request) {
      const handle = await resolve(entry)
      const body = encode(request.markdown, maxDocumentBytes)
      const claimKey = `document-publish/${handle.orgId}/${handle.projectId}/${handle.documentId}.json`
      const sha256 = await hash(request.markdown)
      const claimed = await options.store.put(claimKey, new TextEncoder().encode(JSON.stringify({ sha256 })), {
        absent: true,
      })
      if (!claimed) {
        const existing = await options.store.get(claimKey)
        const claim = existing ? parseClaim(existing) : undefined
        if (!claim || claim.sha256 !== sha256 || (await options.store.get(handle.objectKey))) {
          throw new DocumentAlreadyExistsError(handle.documentId)
        }
      }
      const snapshot = await captureMarkdown(handle, request.markdown, {
        reason: "document.created",
        actor: request.actor,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      })
      const created = await options.store.put(handle.objectKey, body, { absent: true })
      if (!created) throw new DocumentAlreadyExistsError(handle.documentId)
      return {
        markdown: request.markdown,
        version: created.etag as DocumentVersion,
        modifiedAt: created.uploadedAt,
        snapshot,
      }
    },

    resolve,

    async read(handle) {
      const object = await options.store.get(handle.objectKey)
      if (!object) throw new DocumentNotFoundError(handle.documentId)
      return {
        markdown: decode(object.body, handle.documentId),
        version: object.etag as DocumentVersion,
        modifiedAt: object.uploadedAt,
      }
    },

    async write(handle, request) {
      const snapshot = await captureMarkdown(
        handle,
        request.markdown,
        {
          reason: "document.written",
          actor: request.actor,
          ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        },
        "pending",
      )
      await options.beforeCanonicalWrite?.()
      const written = await options.store.put(handle.objectKey, encode(request.markdown, maxDocumentBytes), {
        etag: request.expectedVersion,
      })
      if (!written)
        throw new DocumentVersionConflictError(
          ((await options.store.get(handle.objectKey))?.etag as DocumentVersion) ?? null,
        )
      await finalizeSnapshot(handle, snapshot.id).catch((error) => {
        console.error(`[hosted-documents] snapshot finalize failed for ${handle.documentId}:`, error)
      })
      await collect(handle).catch((error) => {
        console.error(`[hosted-documents] snapshot maintenance failed for ${handle.documentId}:`, error)
      })
      return {
        markdown: request.markdown,
        version: written.etag as DocumentVersion,
        modifiedAt: written.uploadedAt,
        snapshot,
      }
    },

    snapshot: capture,
    listSnapshots,

    async readSnapshot(handle, snapshotId) {
      const snapshot = await readSnapshot(handle, snapshotId)
      return {
        markdown: snapshot.markdown,
        version: snapshot.object.etag as DocumentVersion,
        modifiedAt: snapshot.metadata.createdAt,
      }
    },

    async restore(handle, snapshotId, request) {
      const desired = await readSnapshot(handle, snapshotId)
      const current = await options.store.get(handle.objectKey)
      if ((current?.etag ?? null) !== request.expectedVersion) {
        throw new DocumentVersionConflictError((current?.etag as DocumentVersion) ?? null)
      }
      const restored = await options.store.put(
        handle.objectKey,
        desired.object.body,
        current ? { etag: current.etag } : { absent: true },
      )
      if (!restored)
        throw new DocumentVersionConflictError(
          ((await options.store.get(handle.objectKey))?.etag as DocumentVersion) ?? null,
        )
      return {
        markdown: desired.markdown,
        version: restored.etag as DocumentVersion,
        modifiedAt: restored.uploadedAt,
        snapshot: desired.metadata,
      }
    },

    pinSnapshot: (handle, snapshotId, pin) => updatePins(handle, snapshotId, (pins) => [...pins, pin]),
    unpinSnapshot: (handle, snapshotId, pin) =>
      updatePins(handle, snapshotId, (pins) => pins.filter((candidate) => candidate !== pin)),
    collectSnapshots: collect,
  }

  async function resolve(entry: DocumentEntry): Promise<HostedManagedHandle> {
    if (entry.origin !== "managed" || entry.placement !== "hosted") {
      throw new DocumentInvalidEntryError("Hosted managed storage requires managed hosted entries")
    }
    if (!entry.orgId) throw new DocumentInvalidEntryError("Hosted managed storage requires authenticated org scope")
    requireSegment(entry.orgId, "org id")
    requireSegment(entry.projectId, "project id")
    requireSegment(entry.documentId, "document id")
    const relativePath = requireRelativePath(entry.relativePath)
    return {
      origin: "managed",
      placement: "hosted",
      orgId: entry.orgId,
      projectId: entry.projectId,
      documentId: entry.documentId,
      relativePath,
      objectKey: `documents/${entry.orgId}/${entry.projectId}/${entry.documentId}/${relativePath.split("/").at(-1)}`,
    }
  }

  async function capture(
    handle: HostedManagedHandle,
    request: Readonly<{ reason: string; actor: DocumentActor; sessionId?: string }>,
  ) {
    const current = await options.store.get(handle.objectKey)
    if (!current) throw new DocumentNotFoundError(handle.documentId)
    return await captureMarkdown(handle, decode(current.body, handle.documentId), request)
  }

  async function captureMarkdown(
    handle: HostedManagedHandle,
    markdown: string,
    request: Readonly<{ reason: string; actor: DocumentActor; sessionId?: string }>,
    state: "active" | "pending" = "active",
  ) {
    const sha256 = await hash(markdown)
    const id = sha256 as SnapshotID
    const contentKey = `${historyPrefix(handle)}${id}.md`
    const metadataKey = `${historyPrefix(handle)}${id}.json`
    const existing = await options.store.get(metadataKey)
    if (existing) {
      const value = parseSnapshotState(existing, id, maxDocumentBytes)
      if (state === "active" && value.state === "pending") await finalizeSnapshot(handle, id)
      return publicSnapshot(value)
    }
    const latest = (await listSnapshots(handle))[0]
    const metadata: SnapshotRef & { state: "active" | "pending" } = {
      id,
      sha256,
      size: encode(markdown, maxDocumentBytes).byteLength,
      reason: request.reason,
      actor: request.actor,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
      createdAt: Math.max(now(), (latest?.createdAt ?? 0) + 1),
      pins: [],
      state,
      ...(state === "pending" ? { leaseUntil: now() + PENDING_SNAPSHOT_LEASE_MS } : {}),
    }
    await options.store.put(contentKey, new TextEncoder().encode(markdown), { absent: true })
    const created = await options.store.put(metadataKey, requireBoundedSnapshotMetadata(metadata), {
      absent: true,
    })
    if (!created) {
      const winner = await options.store.get(metadataKey)
      if (!winner) throw new DocumentVersionConflictError(null)
      return parseSnapshot(winner, id, maxDocumentBytes)
    }
    if (state === "active")
      await collect(handle).catch((error) => {
        console.error(`[hosted-documents] snapshot maintenance failed for ${handle.documentId}:`, error)
      })
    return publicSnapshot(metadata)
  }

  async function listSnapshots(handle: HostedManagedHandle) {
    const objects = await options.store.list(historyPrefix(handle))
    return (
      await mapBounded(
        objects.filter((object) => object.key.endsWith(".json")),
        async (object) => {
          const value = await options.store.get(object.key)
          if (!value) return undefined
          const snapshot = parseSnapshotState(
            value,
            object.key.split("/").at(-1)!.slice(0, -5) as SnapshotID,
            maxDocumentBytes,
          )
          if (snapshot.state !== "active") return undefined
          return publicSnapshot(snapshot)
        },
      )
    )
      .filter((snapshot): snapshot is SnapshotRef => Boolean(snapshot))
      .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
  }

  async function readSnapshot(handle: HostedManagedHandle, snapshotId: SnapshotID) {
    const metadataObject = await options.store.get(`${historyPrefix(handle)}${snapshotId}.json`)
    if (!metadataObject) throw new DocumentSnapshotNotFoundError(snapshotId)
    const metadata = parseSnapshot(metadataObject, snapshotId, maxDocumentBytes)
    const object = await options.store.get(`${historyPrefix(handle)}${snapshotId}.md`)
    if (!object) throw new DocumentSnapshotNotFoundError(snapshotId)
    const markdown = decode(object.body, handle.documentId)
    if ((await hash(markdown)) !== metadata.sha256 || object.body.byteLength !== metadata.size) {
      throw new DocumentSnapshotCorruptError(snapshotId)
    }
    return { markdown, metadata, object }
  }

  async function updatePins(
    handle: HostedManagedHandle,
    snapshotId: SnapshotID,
    update: (pins: readonly string[]) => readonly string[],
  ) {
    const key = `${historyPrefix(handle)}${snapshotId}.json`
    for (const _attempt of [0, 1, 2]) {
      const object = await options.store.get(key)
      if (!object) throw new DocumentSnapshotNotFoundError(snapshotId)
      const state = parseSnapshotState(object, snapshotId, maxDocumentBytes)
      if (
        state.state === "pending" ||
        state.state === "deleting-final" ||
        (state.state === "deleting" && (state.deleteAfter ?? 0) <= now())
      ) {
        throw new DocumentSnapshotNotFoundError(snapshotId)
      }
      const { deleteAfter: _deleteAfter, leaseUntil: _leaseUntil, ...current } = state
      const next = { ...current, state: "active" as const, pins: boundedSnapshotPins(update(current.pins), now()) }
      if (await options.store.put(key, requireBoundedSnapshotMetadata(next), { etag: object.etag })) return next
    }
    throw new DocumentVersionConflictError(null)
  }

  async function collect(handle: HostedManagedHandle) {
    const metadataObjects = (await options.store.list(historyPrefix(handle))).filter((object) =>
      object.key.endsWith(".json"),
    )
    const canonical = await options.store.get(handle.objectKey)
    const canonicalHash = canonical ? await hash(decode(canonical.body, handle.documentId)) : undefined
    await metadataObjects.reduce(async (previous, listed) => {
      await previous
      const object = await options.store.get(listed.key)
      if (!object) return
      const snapshotId = listed.key.split("/").at(-1)!.slice(0, -5) as SnapshotID
      const snapshot = parseSnapshotState(object, snapshotId, maxDocumentBytes)
      if (snapshot.state === "pending" && canonicalHash === snapshot.id) {
        const { leaseUntil: _leaseUntil, ...active } = snapshot
        await options.store.put(listed.key, requireBoundedSnapshotMetadata({ ...active, state: "active" }), {
          etag: object.etag,
        })
        return
      }
      if (snapshot.state === "pending" && (snapshot.leaseUntil ?? 0) > now()) return
      if (snapshot.state === "deleting" && (snapshot.deleteAfter ?? 0) > now()) return
      if (
        snapshot.state === "deleting" &&
        !(await options.store.put(
          listed.key,
          requireBoundedSnapshotMetadata({ ...snapshot, state: "deleting-final" }),
          { etag: object.etag },
        ))
      )
        return
      if (snapshot.state !== "deleting" && snapshot.state !== "deleting-final" && snapshot.state !== "pending") return
      await options.store.delete(`${historyPrefix(handle)}${snapshotId}.md`)
      await options.store.delete(listed.key)
    }, Promise.resolve())
    const snapshots = await listSnapshots(handle)
    const unpinned = snapshots.filter((snapshot) => snapshot.pins.every((pin) => expiredSnapshotLease(pin, now())))
    const expiredBefore = now() - maxSnapshotAgeMs
    await unpinned
      .filter((snapshot, index) => index >= maxSnapshots || (index > 0 && snapshot.createdAt < expiredBefore))
      .reduce(async (previous, snapshot) => {
        await previous
        await options.beforeSnapshotGcClaim?.(snapshot.id)
        const key = `${historyPrefix(handle)}${snapshot.id}.json`
        const object = await options.store.get(key)
        if (!object) return
        let current = parseSnapshotState(object, snapshot.id, maxDocumentBytes)
        if (current.state !== "active") return
        const activePins = current.pins.filter((pin) => !expiredSnapshotLease(pin, now()))
        if (activePins.length) return
        let etag = object.etag
        if (current.pins.length) {
          const pruned = await options.store.put(
            key,
            requireBoundedSnapshotMetadata({
              ...current,
              pins: activePins,
            }),
            { etag },
          )
          if (!pruned) return
          etag = pruned.etag
          current = { ...current, pins: activePins }
        }
        const claimed = await options.store.put(
          key,
          requireBoundedSnapshotMetadata({
            ...current,
            state: "deleting",
            deleteAfter: now() + snapshotDeleteGraceMs,
          }),
          {
            etag,
          },
        )
        if (!claimed) return
        await options.afterSnapshotGcClaim?.(snapshot.id)
        if (snapshotDeleteGraceMs > 0) return
        const final = await options.store.put(
          key,
          requireBoundedSnapshotMetadata({ ...current, state: "deleting-final", deleteAfter: now() }),
          { etag: claimed.etag },
        )
        if (!final) return
        await options.store.delete(`${historyPrefix(handle)}${snapshot.id}.md`)
        await options.store.delete(key)
      }, Promise.resolve())
  }

  async function finalizeSnapshot(handle: HostedManagedHandle, snapshotId: SnapshotID) {
    const key = `${historyPrefix(handle)}${snapshotId}.json`
    const object = await options.store.get(key)
    if (!object) throw new DocumentSnapshotNotFoundError(snapshotId)
    const snapshot = parseSnapshotState(object, snapshotId, maxDocumentBytes)
    if (snapshot.state === "active") return
    const { leaseUntil: _leaseUntil, ...active } = snapshot
    if (
      snapshot.state !== "pending" ||
      !(await options.store.put(key, requireBoundedSnapshotMetadata({ ...active, state: "active" }), {
        etag: object.etag,
      }))
    )
      throw new DocumentVersionConflictError(null)
  }
}

export type R2ObjectBody = Readonly<{
  etag: string
  uploaded: Date
  arrayBuffer(): Promise<ArrayBuffer>
}>

export type R2BucketBinding = Readonly<{
  get(key: string): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: Uint8Array,
    options?: Readonly<{ onlyIf?: Readonly<{ etagMatches?: string; etagDoesNotMatch?: string }> }>,
  ): Promise<Readonly<{ etag: string; uploaded: Date }> | null>
  delete(key: string): Promise<void>
  list(options: Readonly<{ prefix: string; cursor?: string }>): Promise<
    Readonly<{
      objects: readonly Readonly<{ key: string; etag: string; uploaded: Date }>[]
      truncated: boolean
      cursor?: string
    }>
  >
}>

export function createR2ConditionalObjectStore(
  bucket: R2BucketBinding,
  options: Readonly<{ maxListObjects?: number }> = {},
): ConditionalObjectStore {
  return {
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return undefined
      return {
        key,
        body: new Uint8Array(await object.arrayBuffer()),
        etag: object.etag,
        uploadedAt: object.uploaded.getTime(),
      }
    },
    async put(key, body, condition) {
      const object = await bucket.put(key, body, {
        onlyIf: condition.etag ? { etagMatches: condition.etag } : { etagDoesNotMatch: "*" },
      })
      return object ? { etag: object.etag, uploadedAt: object.uploaded.getTime() } : undefined
    },
    delete: (key) => bucket.delete(key),
    async list(prefix) {
      const results: Array<{ key: string; etag: string; uploadedAt: number }> = []
      let cursor: string | undefined
      do {
        const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
        results.push(
          ...page.objects.map((object) => ({
            key: object.key,
            etag: object.etag,
            uploadedAt: object.uploaded.getTime(),
          })),
        )
        if (results.length > (options.maxListObjects ?? DEFAULT_MAX_LIST_OBJECTS)) {
          throw new Error("R2 object listing exceeds the configured bound")
        }
        if (page.truncated && !page.cursor) throw new Error("R2 list response is truncated without a cursor")
        cursor = page.truncated ? page.cursor : undefined
      } while (cursor)
      return results
    },
  }
}

function historyPrefix(handle: HostedManagedHandle) {
  return `document-history/${handle.orgId}/${handle.projectId}/${handle.documentId}/`
}

function parseSnapshot(object: ConditionalObject, snapshotId: SnapshotID, maxDocumentBytes: number) {
  const value = parseSnapshotState(object, snapshotId, maxDocumentBytes)
  if (value.state !== "active") throw new DocumentSnapshotNotFoundError(snapshotId)
  return publicSnapshot(value)
}

function parseSnapshotState(object: ConditionalObject, snapshotId: SnapshotID, maxDocumentBytes: number) {
  try {
    if (object.body.byteLength > MAX_SNAPSHOT_METADATA_BYTES) throw new DocumentSnapshotCorruptError(snapshotId)
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(object.body))
    const snapshot = snapshotState(value, snapshotId, maxDocumentBytes)
    if (!snapshot) throw new DocumentSnapshotCorruptError(snapshotId)
    return snapshot
  } catch (error) {
    if (error instanceof DocumentSnapshotCorruptError) throw error
    throw new DocumentSnapshotCorruptError(snapshotId, { cause: error })
  }
}

type SnapshotState = SnapshotRef &
  Readonly<{
    state: "active" | "pending" | "deleting" | "deleting-final"
    leaseUntil?: number
    deleteAfter?: number
  }>

function snapshotState(value: unknown, snapshotId: SnapshotID, maxDocumentBytes: number): SnapshotState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  const record = value as Record<string, unknown>
  if (record.id !== snapshotId || typeof record.id !== "string" || !/^[a-f0-9]{64}$/.test(record.id)) return
  if (record.sha256 !== snapshotId || typeof record.sha256 !== "string") return
  if (
    typeof record.size !== "number" ||
    !Number.isSafeInteger(record.size) ||
    record.size < 0 ||
    record.size > maxDocumentBytes
  )
    return
  if (typeof record.reason !== "string" || !record.reason.trim()) return
  if (!snapshotActor(record.actor)) return
  if (typeof record.createdAt !== "number" || !validTimestamp(record.createdAt)) return
  if (record.sessionId !== undefined && (typeof record.sessionId !== "string" || !record.sessionId.trim())) return
  if (!Array.isArray(record.pins) || !record.pins.every((pin) => typeof pin === "string")) return
  const pinValues = record.pins as string[]
  const state = record.state ?? "active"
  if (!isSnapshotState(state)) return
  if (record.leaseUntil !== undefined && !validTimestamp(record.leaseUntil)) return
  if (record.deleteAfter !== undefined && !validTimestamp(record.deleteAfter)) return
  if (
    state === "pending"
      ? record.leaseUntil === undefined || record.deleteAfter !== undefined
      : record.leaseUntil !== undefined
  )
    return
  if (
    state === "deleting" || state === "deleting-final"
      ? record.deleteAfter === undefined
      : record.deleteAfter !== undefined
  )
    return

  try {
    const pins = boundedSnapshotPins(pinValues, Number.NEGATIVE_INFINITY)
    if (pins.length !== pinValues.length || pins.some((pin, index) => pin !== pinValues[index])) return
    return {
      id: record.id as SnapshotID,
      sha256: record.sha256,
      size: record.size,
      reason: record.reason,
      actor: record.actor,
      ...(typeof record.sessionId === "string" ? { sessionId: record.sessionId } : {}),
      createdAt: record.createdAt,
      pins,
      state,
      ...(typeof record.leaseUntil === "number" ? { leaseUntil: record.leaseUntil } : {}),
      ...(typeof record.deleteAfter === "number" ? { deleteAfter: record.deleteAfter } : {}),
    }
  } catch {
    return
  }
}

function validTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && Number.isFinite(new Date(value).getTime())
  )
}

function isSnapshotState(value: unknown): value is SnapshotState["state"] {
  return value === "active" || value === "pending" || value === "deleting" || value === "deleting-final"
}

function snapshotActor(value: unknown): value is DocumentActor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  if (!("type" in value) || !["user", "agent", "system"].includes(String(value.type))) return false
  return "id" in value && typeof value.id === "string" && Boolean(value.id.trim())
}

function parseClaim(object: ConditionalObject) {
  const value = JSON.parse(new TextDecoder().decode(object.body)) as { sha256?: unknown }
  return typeof value.sha256 === "string" ? { sha256: value.sha256 } : undefined
}

function publicSnapshot(value: ReturnType<typeof parseSnapshotState>) {
  const { state: _state, leaseUntil: _leaseUntil, deleteAfter: _deleteAfter, ...snapshot } = value
  return snapshot
}

function encode(markdown: string, maxBytes: number) {
  if (markdown.includes("\0")) throw new DocumentInvalidEntryError("Document Markdown cannot contain NUL bytes")
  const body = new TextEncoder().encode(markdown)
  if (body.byteLength > maxBytes) throw new DocumentTooLargeError(body.byteLength, maxBytes)
  return body
}

function decode(body: Uint8Array, documentId: string) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body)
  } catch {
    throw new DocumentInvalidEntryError(`Hosted document ${documentId} is not valid UTF-8`)
  }
}

function requireSegment(value: string, name: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new DocumentInvalidEntryError(`Hosted ${name} is invalid`)
}

function requireRelativePath(value: string) {
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.md$/.test(value)) {
    throw new DocumentInvalidEntryError("Hosted managed relative path is invalid")
  }
  return value
}

async function hash(markdown: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(markdown))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}
