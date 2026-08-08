import type { ConditionalObjectStore } from "./managed"
import {
  applyToProjectIndex,
  projectIndexKey,
  projectIndexSnapshot,
  readProjectIndex,
  writeProjectIndex,
  type ProjectIndexRecord,
  type ProjectIndexSnapshot,
} from "./project-index"
import {
  defaultDocumentStatuses,
  DocumentIndexEntrySchema,
  type DocumentIndexEntry,
  type DocumentIndexScope,
} from "../../index-contract"
import { mapBounded } from "../../map-bounded"

type Locator = Readonly<{
  version: 1
  state: "active" | "deleting" | "deleted"
  orgId: string
  projectId: string
  documentId: string
  objectKey: string
}>

class HostedIndexError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "HostedIndexError"
  }
}

export function createHostedDocumentIndex(store: ConditionalObjectStore) {
  return {
    async list(scope: DocumentIndexScope, options?: { archived?: "active" | "archived" | "all" }) {
      return filterArchived(entriesOf(await snapshot(scope)), options?.archived ?? "active")
    },
    /**
     * Same as `list`, but surfaces whether the project ran past the listing bound. Callers that
     * page (or that must not present a partial project as complete) read this instead.
     */
    async listPage(scope: DocumentIndexScope, options?: { archived?: "active" | "archived" | "all" }) {
      const current = await snapshot(scope)
      return {
        entries: filterArchived(entriesOf(current), options?.archived ?? "active"),
        truncated: current.truncated,
      }
    },
    async find(orgId: string, documentId: string) {
      const pointerKey = locatorKey(orgId, documentId)
      for (const _attempt of [0, 1, 2]) {
        const pointer = await store.get(pointerKey)
        if (!pointer) return undefined
        const locator = parseLocator(pointer.body, orgId, documentId)
        if (locator.state !== "active") return undefined
        const value = await store.get(locator.objectKey)
        if (!value) return undefined
        if ((await store.get(pointerKey))?.etag !== pointer.etag) continue
        return parse(value.body, { orgId, projectId: locator.projectId, documentId })
      }
      throw new Error(`Document ${documentId} changed during index lookup`)
    },
    async findRepository(scope: DocumentIndexScope, repositoryId: string) {
      // A repository document is registered under a per-repository pointer at create time, so the
      // hot path is one GET. The roll-up (itself one GET) covers documents created before the
      // pointer existed, and a hit there re-registers the pointer so the scan never repeats.
      const registration = await store.get(repositoryPointerKey(scope, repositoryId))
      if (registration) {
        const documentId = parseRepositoryPointer(registration.body)
        const entry = documentId ? await this.find(scope.orgId, documentId) : undefined
        if (
          entry &&
          entry.project_id === scope.projectId &&
          entry.origin_kind === "repository" &&
          entry.repository_id === repositoryId
        ) {
          return entry
        }
        // Stale pointer: the document moved repositories or was removed. Drop it so the next call
        // does not pay for a dead lookup, then fall through to the roll-up.
        await store.delete(repositoryPointerKey(scope, repositoryId)).catch(() => undefined)
      }
      const found = entriesOf(await snapshot(scope)).find(
        (entry) => entry.origin_kind === "repository" && entry.repository_id === repositoryId,
      )
      if (found) await registerRepository(scope, repositoryId, found.id)
      return found
    },
    async create(input: DocumentIndexEntry) {
      const entry = DocumentIndexEntrySchema.parse(input)
      const created = await createDocument(entry)
      const scope = { orgId: entry.org_id, projectId: entry.project_id }
      if (entry.origin_kind === "repository") await registerRepository(scope, entry.repository_id, entry.id)
      await reconcile(scope, entry.id, created)
      return created.entry
    },
    async remove(scope: DocumentIndexScope, documentId: string) {
      const removed = await removeDocument(scope, documentId)
      // The authoritative objects are gone by now; the roll-up is only catching up.
      if (removed) await reconcile(scope, documentId, undefined)
    },
    update(scope: DocumentIndexScope, documentId: string, input: Record<string, unknown>) {
      return update(
        scope,
        documentId,
        (entry) => ({ ...entry, ...input, updated_at: new Date().toISOString() }) as DocumentIndexEntry,
      )
    },
    relocate(scope: DocumentIndexScope, documentId: string, input: Record<string, unknown>) {
      return update(scope, documentId, (entry) => {
        if (entry.origin_kind !== "repository")
          throw new HostedIndexError("document_index_not_found", `Document ${documentId} was not found`)
        return { ...entry, ...input, updated_at: new Date().toISOString() } as DocumentIndexEntry
      })
    },
    archive(scope: DocumentIndexScope, documentId: string) {
      return update(scope, documentId, (entry) => {
        if (entry.archived_at) return entry
        const now = new Date().toISOString()
        return { ...entry, archived_at: now, updated_at: now }
      })
    },
    restore(scope: DocumentIndexScope, documentId: string) {
      return update(scope, documentId, (entry) => ({
        ...entry,
        archived_at: null,
        updated_at: new Date().toISOString(),
      }))
    },
    async listStatuses() {
      return defaultDocumentStatuses
    },
    async resolveLocalProjectId() {
      throw new Error("Hosted documents require an authenticated project id")
    },
  }

  async function update(
    scope: DocumentIndexScope,
    documentId: string,
    mutate: (entry: DocumentIndexEntry) => DocumentIndexEntry,
  ) {
    const next = await updateDocument(scope, documentId, mutate)
    await reconcile(scope, documentId, next)
    return next.entry
  }

  async function updateDocument(
    scope: DocumentIndexScope,
    documentId: string,
    mutate: (entry: DocumentIndexEntry) => DocumentIndexEntry,
  ): Promise<ProjectIndexRecord> {
    const objectKey = await activeKey(scope, documentId)
    for (const _attempt of [0, 1, 2]) {
      const object = await store.get(objectKey)
      if (!object) throw new HostedIndexError("document_index_not_found", `Document ${documentId} was not found`)
      const next = mutate(parse(object.body, { orgId: scope.orgId, projectId: scope.projectId, documentId }))
      const written = await store.put(objectKey, encode(next), { etag: object.etag })
      if (written) return { entry: next, objectKey, etag: written.etag }
    }
    throw new Error(`Document ${documentId} changed during index update`)
  }

  async function createDocument(entry: DocumentIndexEntry): Promise<ProjectIndexRecord> {
    const pointerKey = locatorKey(entry.org_id, entry.id)
    for (const _attempt of [0, 1, 2]) {
      const pointer = await store.get(pointerKey)
      if (!pointer) {
        const locator = activeLocator(entry)
        if (await store.put(pointerKey, encode(locator), { absent: true })) return await publish(locator, entry)
        continue
      }
      const locator = parseLocator(pointer.body, entry.org_id, entry.id)
      if (locator.state === "active") {
        if (locator.projectId !== entry.project_id) throw duplicate(entry.id)
        if (await store.get(locator.objectKey)) throw duplicate(entry.id)
        // The locator survived a failed attempt whose entry object was never written. Reuse it
        // rather than minting a new UUID key, so retries stop leaving an orphan behind.
        return await publish(locator, entry)
      }
      if (locator.state === "deleting") throw duplicate(entry.id)
      const replacement = activeLocator(entry)
      if (await store.put(pointerKey, encode(replacement), { etag: pointer.etag })) {
        // A previous life of this document id may have left entry objects under the old locator.
        await sweepOrphans({ orgId: entry.org_id, projectId: entry.project_id }, entry.id, replacement.objectKey)
        return await publish(replacement, entry)
      }
    }
    throw new Error(`Document ${entry.id} changed during index creation`)
  }

  async function removeDocument(scope: DocumentIndexScope, documentId: string) {
    const pointerKey = locatorKey(scope.orgId, documentId)
    const initial = await store.get(pointerKey)
    if (!initial) return false
    const target = parseLocator(initial.body, scope.orgId, documentId)
    if (target.projectId !== scope.projectId || target.state === "deleted") return false
    for (const _attempt of [0, 1, 2]) {
      const pointer = await store.get(pointerKey)
      if (!pointer) return false
      const locator = parseLocator(pointer.body, scope.orgId, documentId)
      if (
        locator.projectId !== scope.projectId ||
        locator.objectKey !== target.objectKey ||
        locator.state === "deleted"
      ) {
        return false
      }
      if (locator.state === "active") {
        if (await store.put(pointerKey, encode({ ...locator, state: "deleting" }), { etag: pointer.etag })) continue
        continue
      }
      await store.delete(locator.objectKey)
      // Nothing is authoritative for this document any more, so any sibling object under its
      // prefix is an orphan from an interrupted create.
      await sweepOrphans(scope, documentId, undefined)
      if (await store.put(pointerKey, encode({ ...locator, state: "deleted" }), { etag: pointer.etag })) return true
    }
    throw new Error(`Document ${documentId} changed during index removal`)
  }

  /**
   * Resolves a project's entries. Costs one GET (the roll-up) plus one LIST (the authoritative key
   * set) regardless of document count, plus a GET for each object whose ETag the roll-up does not
   * already match. A warm cache over an unchanged project therefore does zero per-document work,
   * while a changed, corrupt, or poisoned object is always re-read from source. See the invariant in
   * `backends/hosted/project-index.ts`.
   */
  async function snapshot(scope: DocumentIndexScope): Promise<ProjectIndexSnapshot> {
    const rollup = await readProjectIndex(store, scope)
    const cached = new Map((rollup?.snapshot.records ?? []).map((record) => [record.objectKey, record]))
    const objects = await store.list(prefix(scope.orgId, scope.projectId))
    const candidates = objects.filter((object) => object.key.endsWith(".json"))
    const orphans: string[] = []
    const records = (
      await mapBounded(candidates, async (object) => {
        const documentId = documentIdFromKey(object.key, scope)
        const known = cached.get(object.key)
        // The ETag is the whole verification: same key, same ETag means the authoritative object is
        // byte-identical to what the cache was built from, so re-reading it could not differ.
        if (known?.etag === object.etag) return known
        const pointer = await store.get(locatorKey(scope.orgId, documentId))
        if (!pointer) {
          orphans.push(object.key)
          return undefined
        }
        const locator = parseLocator(pointer.body, scope.orgId, documentId)
        if (locator.state !== "active" || locator.projectId !== scope.projectId) {
          orphans.push(object.key)
          return undefined
        }
        // A key under an active locator's document that is not the locator's own key is an orphan
        // left by a create attempt that minted a UUID and then failed before publishing.
        if (locator.objectKey !== object.key) {
          orphans.push(object.key)
          return undefined
        }
        const value = await store.get(object.key)
        if (!value) return undefined
        const entry = parse(value.body, { orgId: scope.orgId, projectId: scope.projectId, documentId })
        return { entry, objectKey: object.key, etag: value.etag }
      })
    ).filter((record): record is ProjectIndexRecord => Boolean(record))
    // Orphan cleanup rides the natural path: a read that proves an object dead also clears it.
    // Locator-less objects are left alone — they are not ours to delete (see the guard test).
    const collectable = orphans.filter((key) => key.slice(prefix(scope.orgId, scope.projectId).length).includes("/"))
    if (collectable.length) {
      await mapBounded(collectable, async (key) => await store.delete(key).catch(() => undefined))
      console.warn(
        `[hosted-documents] removed ${collectable.length} orphaned index object(s) under ${scope.projectId}`,
      )
    }
    const next = projectIndexSnapshot(records, objects.truncated)
    if (diverged(rollup?.snapshot, next)) await writeProjectIndex(store, scope, next, rollup?.etag).catch(() => undefined)
    return next
  }

  function diverged(previous: ProjectIndexSnapshot | undefined, next: ProjectIndexSnapshot) {
    if (!previous) return true
    if (previous.truncated !== next.truncated || previous.records.length !== next.records.length) return true
    return previous.records.some(
      (record, position) =>
        record.objectKey !== next.records[position]?.objectKey || record.etag !== next.records[position]?.etag,
    )
  }

  /**
   * Folds one entry change into the roll-up under CAS. Losing the race, or hitting a change the
   * roll-up cannot represent locally, invalidates it so the next read rebuilds — the roll-up is
   * never allowed to look authoritative while being wrong.
   */
  /**
   * Folds a completed write into the cache. Never throws: the authoritative objects are already
   * durable by the time this runs, so a cache that cannot be updated must degrade to a stale cache
   * (which the next verified read repairs) rather than fail a write that actually succeeded.
   */
  async function reconcile(scope: DocumentIndexScope, documentId: string, record: ProjectIndexRecord | undefined) {
    await reconcileRollup(scope, documentId, record).catch((error) => {
      console.warn(`[hosted-documents] project index reconcile failed for ${scope.projectId}:`, error)
    })
  }

  async function reconcileRollup(
    scope: DocumentIndexScope,
    documentId: string,
    record: ProjectIndexRecord | undefined,
  ) {
    for (const _attempt of [0, 1]) {
      const rollup = await readProjectIndex(store, scope)
      if (!rollup) {
        // No roll-up yet. Seed it now, while the project is at its smallest, rather than leaving the
        // first reader to pay a per-document pass over a project that has since grown.
        await snapshot(scope)
        return
      }
      const next = applyToProjectIndex(rollup.snapshot, documentId, record)
      if (!next) {
        await invalidate(scope, rollup.etag)
        return
      }
      if (await writeProjectIndex(store, scope, next, rollup.etag)) return
    }
    await invalidate(scope, (await readProjectIndex(store, scope))?.etag)
  }

  /** Deletes the roll-up so the next read rebuilds it from the authoritative objects. */
  async function invalidate(scope: DocumentIndexScope, _etag: string | undefined) {
    await store.delete(projectIndexKey(scope)).catch(() => undefined)
  }

  /** Deletes every entry object under a document's prefix except the one that is authoritative. */
  async function sweepOrphans(scope: DocumentIndexScope, documentId: string, keep: string | undefined) {
    const stale = (await store.list(`${prefix(scope.orgId, scope.projectId)}${segment(documentId)}/`)).filter(
      (object) => object.key.endsWith(".json") && object.key !== keep,
    )
    if (!stale.length) return
    await mapBounded(stale, async (object) => await store.delete(object.key).catch(() => undefined))
  }

  async function registerRepository(scope: DocumentIndexScope, repositoryId: string, documentId: string) {
    const key = repositoryPointerKey(scope, repositoryId)
    const body = encode({ version: 1, documentId })
    if (await store.put(key, body, { absent: true })) return
    const current = await store.get(key)
    if (!current) return
    if (parseRepositoryPointer(current.body) === documentId) return
    await store.put(key, body, { etag: current.etag })
  }

  async function activeKey(scope: DocumentIndexScope, documentId: string) {
    const pointer = await store.get(locatorKey(scope.orgId, documentId))
    if (!pointer) throw new HostedIndexError("document_index_not_found", `Document ${documentId} was not found`)
    const locator = parseLocator(pointer.body, scope.orgId, documentId)
    if (locator.state !== "active" || locator.projectId !== scope.projectId) {
      throw new HostedIndexError("document_index_not_found", `Document ${documentId} was not found`)
    }
    return locator.objectKey
  }

  async function publish(locator: Locator, entry: DocumentIndexEntry): Promise<ProjectIndexRecord> {
    const written = await store.put(locator.objectKey, encode(entry), { absent: true })
    if (written) return { entry, objectKey: locator.objectKey, etag: written.etag }
    throw duplicate(entry.id)
  }
}

function prefix(orgId: string, projectId: string) {
  return `document-index/${segment(orgId)}/${segment(projectId)}/`
}

function activeLocator(entry: DocumentIndexEntry): Locator {
  return {
    version: 1,
    state: "active",
    orgId: entry.org_id,
    projectId: entry.project_id,
    documentId: entry.id,
    objectKey: `${prefix(entry.org_id, entry.project_id)}${segment(entry.id)}/${crypto.randomUUID()}.json`,
  }
}

function locatorKey(orgId: string, documentId: string) {
  return `document-index-locators/${segment(orgId)}/${segment(documentId)}.json`
}

/**
 * Repository identity keys are arbitrary strings (paths, blob shas), so they are hashed into a key
 * rather than embedded — an unencoded path would escape the prefix.
 */
function repositoryPointerKey(scope: DocumentIndexScope, repositoryId: string) {
  return `document-index-repositories/${segment(scope.orgId)}/${segment(scope.projectId)}/${digest(repositoryId)}.json`
}

function digest(value: string) {
  // FNV-1a over the UTF-8 bytes, widened by hashing forwards and backwards. This is a key-space
  // spreader, not a security primitive: `findRepository` re-validates `repository_id` on the entry
  // it loads, so a collision costs one wasted GET and falls through to the roll-up.
  const bytes = new TextEncoder().encode(value)
  let forward = 0x811c9dc5
  let backward = 0x01000193
  for (let position = 0; position < bytes.length; position++) {
    forward = Math.imul(forward ^ bytes[position]!, 0x01000193) >>> 0
    backward = Math.imul(backward ^ bytes[bytes.length - 1 - position]!, 0x811c9dc5) >>> 0
  }
  return `${forward.toString(16).padStart(8, "0")}${backward.toString(16).padStart(8, "0")}${bytes.length.toString(16)}`
}

function parseRepositoryPointer(body: Uint8Array) {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) as Record<string, unknown>
    return value?.version === 1 && typeof value.documentId === "string" && /^[A-Za-z0-9_-]+$/.test(value.documentId)
      ? value.documentId
      : undefined
  } catch {
    return undefined
  }
}

function entriesOf(snapshot: ProjectIndexSnapshot) {
  return snapshot.records.map((record) => record.entry)
}

function filterArchived(entries: readonly DocumentIndexEntry[], archived: "active" | "archived" | "all") {
  return entries.filter((entry) => archived === "all" || (archived === "archived") === Boolean(entry.archived_at))
}

function segment(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Hosted document index segment is invalid")
  return value
}

function encode(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value))
}

function parse(body: Uint8Array, expected: Readonly<{ orgId: string; projectId: string; documentId: string }>) {
  const value = JSON.parse(new TextDecoder().decode(body)) as unknown
  const parsed = DocumentIndexEntrySchema.safeParse(value)
  if (!parsed.success) throw new HostedIndexError("document_index_corrupt", "Hosted document index entry is invalid")
  const entry = parsed.data
  if (entry.id !== expected.documentId || entry.org_id !== expected.orgId || entry.project_id !== expected.projectId) {
    throw new HostedIndexError(
      "document_index_scope_mismatch",
      "Hosted document index entry does not match its storage scope",
    )
  }
  return entry
}

function parseLocator(body: Uint8Array, orgId: string, documentId: string): Locator {
  const value = JSON.parse(new TextDecoder().decode(body)) as unknown
  if (!value || typeof value !== "object") throw corruptLocator()
  const locator = value as Record<string, unknown>
  if (
    Object.keys(locator).some(
      (field) => !["version", "state", "orgId", "projectId", "documentId", "objectKey"].includes(field),
    ) ||
    locator.version !== 1 ||
    !["active", "deleting", "deleted"].includes(locator.state as string) ||
    locator.orgId !== orgId ||
    locator.documentId !== documentId ||
    typeof locator.projectId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(locator.projectId) ||
    typeof locator.objectKey !== "string"
  )
    throw corruptLocator()
  const expected = `${prefix(orgId, locator.projectId)}${segment(documentId)}/`
  if (
    !locator.objectKey.startsWith(expected) ||
    !/^[-A-Za-z0-9]+\.json$/.test(locator.objectKey.slice(expected.length))
  ) {
    throw corruptLocator()
  }
  return locator as Locator
}

function documentIdFromKey(objectKey: string, scope: DocumentIndexScope) {
  const relative = objectKey.slice(prefix(scope.orgId, scope.projectId).length)
  return relative.includes("/") ? relative.split("/", 1)[0]! : relative.slice(0, -5)
}

function duplicate(documentId: string) {
  return new Error(`Document ${documentId} already exists`)
}

function corruptLocator() {
  return new HostedIndexError("document_index_corrupt", "Hosted document index locator is invalid")
}
