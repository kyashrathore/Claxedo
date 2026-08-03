/**
 * The R2 object store behind hosted documents.
 *
 * Marked `.cf.ts` because it is written against R2's conditional-write
 * semantics: `onlyIf.etagMatches` is what makes compare-and-set work without a
 * lock, and `etagDoesNotMatch: "*"` is create-if-absent. Those are R2's
 * contract, not a generic blob store's, so a caller cannot swap in S3 or a
 * filesystem without re-deriving the concurrency argument.
 *
 * The binding is described structurally rather than imported from
 * `@cloudflare/workers-types`, so this compiles in the Node build too — the
 * suffix records the runtime it TARGETS, not a compile-time dependency.
 */

import {
  DocumentInvalidEntryError,
  DocumentTooLargeError,
  DocumentVersionConflictError,
} from "../../errors"
import {
  DEFAULT_MAX_DOCUMENT_BYTES,
  DEFAULT_MAX_LIST_OBJECTS,
  objectListing,
  type ConditionalObjectStore,
  type ObjectListingItem,
} from "./managed"

export type R2ObjectBody = Readonly<{
  etag: string
  uploaded: Date
  size: number
  body: ReadableStream<Uint8Array>
}>

export type R2BucketBinding = Readonly<{
  get(key: string): Promise<R2ObjectBody | null>
  put(
    key: string,
    value: Uint8Array,
    options?: Readonly<{ onlyIf?: Readonly<{ etagMatches?: string; etagDoesNotMatch?: string }> }>,
  ): Promise<Readonly<{ etag: string; uploaded: Date }> | null>
  delete(key: string): Promise<void>
  list(options: Readonly<{ prefix: string; cursor?: string; startAfter?: string }>): Promise<
    Readonly<{
      objects: readonly Readonly<{ key: string; etag: string; uploaded: Date }>[]
      truncated: boolean
      cursor?: string
    }>
  >
}>

export function createR2ConditionalObjectStore(
  bucket: R2BucketBinding,
  options: Readonly<{ maxListObjects?: number; maxObjectBytes?: number }> = {},
): ConditionalObjectStore {
  const maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_DOCUMENT_BYTES
  return {
    async get(key) {
      const object = await bucket.get(key)
      if (!object) return undefined
      if (object.size > maxObjectBytes) throw new DocumentTooLargeError(object.size, maxObjectBytes)
      const body = await readR2Body(object, maxObjectBytes)
      return {
        key,
        body,
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
    async list(prefix, listOptions) {
      // The bound used to throw, which made a large project unreadable rather than slow. It now
      // truncates and says so: the caller sees `truncated` plus a cursor to resume from, so a
      // project past the bound degrades to paging instead of failing.
      const limit = Math.max(1, Math.min(listOptions?.limit ?? Infinity, options.maxListObjects ?? DEFAULT_MAX_LIST_OBJECTS))
      const results: ObjectListingItem[] = []
      const startAfter = resumeAfterKey(listOptions?.cursor)
      let cursor = startAfter ? undefined : listOptions?.cursor
      let first = true
      do {
        const page = await bucket.list({
          prefix,
          ...(cursor ? { cursor } : {}),
          ...(first && startAfter ? { startAfter } : {}),
        })
        first = false
        for (const object of page.objects) {
          // Defensive: a binding that ignores `startAfter` would replay keys we already returned,
          // silently duplicating a page. Filtering by key makes resumption correct either way.
          if (startAfter && object.key <= startAfter) continue
          results.push({ key: object.key, etag: object.etag, uploadedAt: object.uploaded.getTime() })
        }
        if (page.truncated && !page.cursor) throw new Error("R2 list response is truncated without a cursor")
        cursor = page.truncated ? page.cursor : undefined
        if (results.length >= limit) {
          if (results.length > limit || cursor) {
            const kept = results.slice(0, limit)
            console.warn(
              `[hosted-documents] R2 listing for ${prefix} truncated at ${limit} objects; ` +
                `resume with the returned cursor`,
            )
            return objectListing(kept, {
              truncated: true,
              // Prefer R2's own cursor when the page boundary lines up; otherwise resume by key so
              // the caller can page even when the bound cut a page in half.
              ...(results.length === limit && cursor ? { cursor } : { cursor: keyCursor(kept.at(-1)!.key) }),
            })
          }
          return objectListing(results, cursor ? { truncated: true, cursor } : { truncated: false })
        }
      } while (cursor)
      return objectListing(results, { truncated: false })
    },
  }
}
/**
 * R2 cursors are opaque, so a listing cut mid-page cannot hand one back. `startAfter` semantics are
 * recovered by encoding the last key we returned; `resumeAfterKey` reads it back.
 */
function keyCursor(key: string) {
  return `after:${key}`
}

export function resumeAfterKey(cursor: string | undefined) {
  return cursor?.startsWith("after:") ? cursor.slice("after:".length) : undefined
}

async function readR2Body(object: R2ObjectBody, maxBytes: number) {
  const buffer = new Uint8Array(Math.min(maxBytes + 1, object.size + 1))
  const reader = object.body.getReader()
  let offset = 0
  let complete = false
  try {
    while (offset < buffer.byteLength) {
      const result = await reader.read()
      if (result.done) {
        complete = true
        break
      }
      const available = Math.min(result.value.byteLength, buffer.byteLength - offset)
      buffer.set(result.value.subarray(0, available), offset)
      offset += available
      if (available < result.value.byteLength) throw new DocumentTooLargeError(offset + 1, maxBytes)
    }
    if (offset > maxBytes) throw new DocumentTooLargeError(offset, maxBytes)
    if (!complete && !(await reader.read()).done) throw new DocumentTooLargeError(offset + 1, maxBytes)
    if (offset !== object.size) throw new DocumentInvalidEntryError("R2 object size changed while reading")
    return buffer.subarray(0, offset)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}