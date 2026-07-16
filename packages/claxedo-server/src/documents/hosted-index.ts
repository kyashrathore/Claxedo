import type { ConditionalObjectStore } from "./hosted-managed"
import {
  defaultDocumentStatuses,
  DocumentIndexEntrySchema,
  type DocumentIndexEntry,
  type DocumentIndexScope,
} from "./index-contract"
import { mapBounded } from "./map-bounded"

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
      const objects = await store.list(prefix(scope.orgId, scope.projectId))
      const entries = (
        await mapBounded(
          objects.filter((object) => object.key.endsWith(".json")),
          async (object) => {
            const documentId = documentIdFromKey(object.key, scope)
            const pointer = await store.get(locatorKey(scope.orgId, documentId))
            if (!pointer) return undefined
            const locator = parseLocator(pointer.body, scope.orgId, documentId)
            if (
              locator.state !== "active" ||
              locator.projectId !== scope.projectId ||
              locator.objectKey !== object.key
            ) {
              return undefined
            }
            const value = await store.get(object.key)
            if (!value) return undefined
            const entry = parse(value.body, {
              orgId: scope.orgId,
              projectId: scope.projectId,
              documentId,
            })
            return entry
          },
        )
      ).filter((entry): entry is DocumentIndexEntry => Boolean(entry))
      const archived = options?.archived ?? "active"
      return entries
        .filter((entry) => archived === "all" || (archived === "archived") === Boolean(entry.archived_at))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id))
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
      return (await this.list(scope, { archived: "all" })).find(
        (entry) => entry.origin_kind === "repository" && entry.repository_id === repositoryId,
      )
    },
    async create(input: DocumentIndexEntry) {
      const entry = DocumentIndexEntrySchema.parse(input)
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
          return await publish(locator, entry)
        }
        if (locator.state === "deleting") throw duplicate(entry.id)
        const replacement = activeLocator(entry)
        if (await store.put(pointerKey, encode(replacement), { etag: pointer.etag })) {
          return await publish(replacement, entry)
        }
      }
      throw new Error(`Document ${entry.id} changed during index creation`)
    },
    async remove(scope: DocumentIndexScope, documentId: string) {
      const pointerKey = locatorKey(scope.orgId, documentId)
      const initial = await store.get(pointerKey)
      if (!initial) return
      const target = parseLocator(initial.body, scope.orgId, documentId)
      if (target.projectId !== scope.projectId || target.state === "deleted") return
      for (const _attempt of [0, 1, 2]) {
        const pointer = await store.get(pointerKey)
        if (!pointer) return
        const locator = parseLocator(pointer.body, scope.orgId, documentId)
        if (
          locator.projectId !== scope.projectId ||
          locator.objectKey !== target.objectKey ||
          locator.state === "deleted"
        ) {
          return
        }
        if (locator.state === "active") {
          if (await store.put(pointerKey, encode({ ...locator, state: "deleting" }), { etag: pointer.etag })) continue
          continue
        }
        await store.delete(locator.objectKey)
        if (await store.put(pointerKey, encode({ ...locator, state: "deleted" }), { etag: pointer.etag })) return
      }
      throw new Error(`Document ${documentId} changed during index removal`)
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
    transitionStatus(scope: DocumentIndexScope, documentId: string, status: string) {
      return update(scope, documentId, (entry) => {
        const current = defaultDocumentStatuses.find((candidate) => candidate.id === entry.status)
        if (!current)
          throw new HostedIndexError("document_status_not_found", `Document status ${entry.status} was not found`)
        if (!(current.transitions as readonly string[]).includes(status)) {
          throw new HostedIndexError(
            "document_status_transition_not_allowed",
            `Cannot transition ${entry.status} to ${status}`,
          )
        }
        return { ...entry, status, updated_at: new Date().toISOString() }
      })
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
    const objectKey = await activeKey(scope, documentId)
    for (const _attempt of [0, 1, 2]) {
      const object = await store.get(objectKey)
      if (!object) throw new HostedIndexError("document_index_not_found", `Document ${documentId} was not found`)
      const next = mutate(parse(object.body, { orgId: scope.orgId, projectId: scope.projectId, documentId }))
      if (await store.put(objectKey, encode(next), { etag: object.etag })) return next
    }
    throw new Error(`Document ${documentId} changed during index update`)
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

  async function publish(locator: Locator, entry: DocumentIndexEntry) {
    if (await store.put(locator.objectKey, encode(entry), { absent: true })) return entry
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
