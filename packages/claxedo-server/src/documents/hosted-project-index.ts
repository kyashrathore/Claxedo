import type { ConditionalObjectStore } from "./hosted-managed"
import { DocumentIndexEntrySchema, type DocumentIndexEntry, type DocumentIndexScope } from "./index-contract"

/**
 * A per-project roll-up of every document entry in one R2 object, so listing a project costs one
 * GET plus one LIST instead of a LIST plus two GETs per document.
 *
 * INVARIANT — the roll-up is a cache, never a source of truth. The per-document objects
 * (`document-index/<org>/<project>/<doc>/<uuid>.json`) and their locators stay authoritative, and
 * every read *verifies* the roll-up against them rather than trusting it: each cached entry carries
 * the object key and ETag it was read from, and a listing (one operation for the whole project)
 * confirms that set still matches. Any key that is new, missing, or has moved on to a different
 * ETag is re-read from the authoritative object, so a divergence — including a corrupt or poisoned
 * entry object — surfaces on the next read instead of being masked by the cache. Writers fold their
 * own change in under ETag CAS; a lost race only leaves a stale cache, which the next read repairs.
 * Nothing may ever exist *only* in the roll-up.
 */

const PROJECT_INDEX_VERSION = 3

/** Bounds one roll-up object. Past this a project is served truncated rather than growing forever. */
export const MAX_PROJECT_INDEX_ENTRIES = 5_000

/** A cached entry plus the identity of the authoritative object it was read from. */
export type ProjectIndexRecord = Readonly<{
  entry: DocumentIndexEntry
  objectKey: string
  etag: string
}>

export type ProjectIndexSnapshot = Readonly<{
  version: number
  records: readonly ProjectIndexRecord[]
  /** True when the roll-up covers only part of the project; callers must not present it as whole. */
  truncated: boolean
}>

export type ProjectIndexRollup = Readonly<{ snapshot: ProjectIndexSnapshot; etag: string | undefined }>

export function projectIndexKey(scope: DocumentIndexScope) {
  return `document-project-index/${segment(scope.orgId)}/${segment(scope.projectId)}.json`
}

/** Reads the roll-up. Absent or corrupt both return undefined, which callers treat as a cold cache. */
export async function readProjectIndex(
  store: ConditionalObjectStore,
  scope: DocumentIndexScope,
): Promise<ProjectIndexRollup | undefined> {
  const object = await store.get(projectIndexKey(scope))
  if (!object) return undefined
  const snapshot = parseProjectIndex(object.body, scope)
  return snapshot ? { snapshot, etag: object.etag } : undefined
}

/**
 * Publishes a roll-up under CAS. `expected` is the ETag the caller read; undefined means create-only.
 * A false return is a lost race, not an error — the authoritative objects are already written, so
 * the worst case is a stale cache that the next read verifies and repairs.
 */
export async function writeProjectIndex(
  store: ConditionalObjectStore,
  scope: DocumentIndexScope,
  snapshot: ProjectIndexSnapshot,
  expected: string | undefined,
) {
  const body = new TextEncoder().encode(JSON.stringify(snapshot))
  return Boolean(
    await store.put(projectIndexKey(scope), body, expected ? { etag: expected } : { absent: true }),
  )
}

export function projectIndexSnapshot(
  records: readonly ProjectIndexRecord[],
  truncated: boolean,
): ProjectIndexSnapshot {
  const sorted = sortRecords(records)
  const over = sorted.length > MAX_PROJECT_INDEX_ENTRIES
  return {
    version: PROJECT_INDEX_VERSION,
    records: over ? sorted.slice(0, MAX_PROJECT_INDEX_ENTRIES) : sorted,
    truncated: truncated || over,
  }
}

/**
 * Folds one record change into a roll-up. `undefined` removes. Returns undefined when the change
 * cannot be represented locally — a truncated roll-up gaining an unknown entry could push a real
 * document out of the covered window, so the cache is invalidated rather than guessed at.
 */
export function applyToProjectIndex(
  snapshot: ProjectIndexSnapshot,
  documentId: string,
  record: ProjectIndexRecord | undefined,
): ProjectIndexSnapshot | undefined {
  const without = snapshot.records.filter((candidate) => candidate.entry.id !== documentId)
  if (!record) return { ...snapshot, records: without }
  const known = without.length !== snapshot.records.length
  if (snapshot.truncated && !known) return undefined
  const records = sortRecords([...without, record])
  if (records.length > MAX_PROJECT_INDEX_ENTRIES) return undefined
  return { ...snapshot, records }
}

export function sortRecords(records: readonly ProjectIndexRecord[]) {
  return [...records].sort(
    (left, right) =>
      right.entry.updated_at.localeCompare(left.entry.updated_at) || right.entry.id.localeCompare(left.entry.id),
  )
}

function parseProjectIndex(body: Uint8Array, scope: DocumentIndexScope): ProjectIndexSnapshot | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body))
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const outer = value as Record<string, unknown>
    if (outer.version !== PROJECT_INDEX_VERSION) return undefined
    if (typeof outer.truncated !== "boolean" || !Array.isArray(outer.records)) return undefined
    if (outer.records.length > MAX_PROJECT_INDEX_ENTRIES) return undefined
    const records: ProjectIndexRecord[] = []
    for (const candidate of outer.records) {
      if (!candidate || typeof candidate !== "object") return undefined
      const record = candidate as Record<string, unknown>
      if (typeof record.objectKey !== "string" || typeof record.etag !== "string") return undefined
      const parsed = DocumentIndexEntrySchema.safeParse(record.entry)
      // A single unparseable record invalidates the whole roll-up. Keeping the parseable remainder
      // would serve a silently-partial project — exactly what the invariant above forbids.
      if (!parsed.success) return undefined
      if (parsed.data.org_id !== scope.orgId || parsed.data.project_id !== scope.projectId) return undefined
      records.push({ entry: parsed.data, objectKey: record.objectKey, etag: record.etag })
    }
    if (new Set(records.map((record) => record.entry.id)).size !== records.length) return undefined
    if (new Set(records.map((record) => record.objectKey)).size !== records.length) return undefined
    return { version: PROJECT_INDEX_VERSION, records: sortRecords(records), truncated: outer.truncated }
  } catch {
    return undefined
  }
}

function segment(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Hosted document index segment is invalid")
  return value
}
