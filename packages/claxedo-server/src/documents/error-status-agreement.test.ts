/**
 * `DocumentWorkspaceError.status` agrees with the status the documents router
 * actually answers.
 *
 * Two places decide what a document failure becomes on the wire: the
 * `DOCUMENT_ERROR_STATUS` table in `errors.ts`, which every
 * `DocumentWorkspaceError` carries, and the ladder in `routes/index.ts`, which
 * is what a client actually receives. They were introduced independently and
 * silently disagreed on three codes — the error object said 400/400/503 while
 * the wire said 422/422/500.
 *
 * Nothing crashed, because no production code reads `error.status` on this
 * path yet. That is exactly why it needed a test: the divergence is invisible
 * until the first handler reaches for `statusOf(err)` and starts serving a
 * different status than the router does for the identical error.
 *
 * The router is the source of truth here — it is the observable contract — so
 * this parses its ladder out of the source rather than duplicating it.
 */

import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "vitest"
import {
  DocumentAlreadyExistsError,
  DocumentInvalidEntryError,
  DocumentLockTimeoutError,
  DocumentNotFoundError,
  DocumentPathError,
  DocumentSnapshotCorruptError,
  DocumentSnapshotNotFoundError,
  DocumentStorageError,
  DocumentTooLargeError,
  DocumentVersionConflictError,
  type DocumentErrorCode,
} from "./errors"
import { DocumentNotTextError } from "./errors"

/** One instance per code, so the table is exercised through real construction. */
const SAMPLES: ReadonlyArray<{ code: DocumentErrorCode; error: { status: number } }> = [
  { code: "document_already_exists", error: new DocumentAlreadyExistsError("doc_1") },
  { code: "document_invalid_entry", error: new DocumentInvalidEntryError("bad") },
  { code: "document_lock_timeout", error: new DocumentLockTimeoutError("doc_1") },
  { code: "document_not_found", error: new DocumentNotFoundError("doc_1") },
  { code: "document_not_text", error: new DocumentNotTextError("doc_1", { hash: "h", bytes: 1 } as never) },
  { code: "document_path_outside_root", error: new DocumentPathError("escape") },
  { code: "document_permission_denied", error: new DocumentStorageError("document_permission_denied", "reading") },
  { code: "document_snapshot_corrupt", error: new DocumentSnapshotCorruptError("snap_1") },
  { code: "document_snapshot_not_found", error: new DocumentSnapshotNotFoundError("snap_1") },
  { code: "document_storage_failed", error: new DocumentStorageError("document_storage_failed", "writing") },
  { code: "document_too_large", error: new DocumentTooLargeError(10, 5) },
  { code: "document_version_conflict", error: new DocumentVersionConflictError(null) },
]

/** Error classes the router answers via `instanceof`, not via the code ladder. */
const INSTANCEOF_CODES: Record<string, string | undefined> = {
  DocumentVersionConflictError: "document_version_conflict",
}

/**
 * Read the router's `error.code === "x" ? NNN` ladder. Parsed from source
 * rather than invoked because reaching that branch through the real handler
 * needs a composed backend, an authenticated request and a stored document —
 * none of which this invariant depends on.
 */
function routerLadder() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "routes/index.ts"), "utf8")
  const ladder = new Map<string, number>()
  for (const match of source.matchAll(
    /error\.code === "(document_[a-z_]+)"(?:\s*\|\|\s*error\.code === "(document_[a-z_]+)")?\s*\?\s*(\d{3})/g,
  )) {
    ladder.set(match[1]!, Number(match[3]))
    if (match[2]) ladder.set(match[2], Number(match[3]))
  }
  // Codes handled by an `instanceof` branch ABOVE the ladder rather than inside
  // it — those never reach the `error.code === ...` chain at all.
  for (const match of source.matchAll(
    /error instanceof (Document[A-Za-z]+Error)\)\s*\{[\s\S]{0,400}?\{ status: (\d{3}) \}/g,
  )) {
    const code = INSTANCEOF_CODES[match[1]!]
    if (code) ladder.set(code, Number(match[2]))
  }
  return ladder
}

/** The ladder's terminal `: NNN`, which every unlisted code falls through to. */
function routerFallback() {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, "routes/index.ts"), "utf8")
  return Number(/document_permission_denied"\s*\?\s*\d{3}\s*:\s*(\d{3})/.exec(source)?.[1])
}

describe("document error status agreement", () => {
  test("the router ladder is parsed, not silently empty", () => {
    // Without this the comparison below passes vacuously if the regex stops
    // matching — which a refactor of the ladder into a lookup table would do.
    const ladder = routerLadder()
    expect(ladder.size).toBeGreaterThanOrEqual(7)
    expect(routerFallback()).toBe(500)
  })

  test("every DocumentWorkspaceError carries the status the router answers for it", () => {
    const ladder = routerLadder()
    const fallback = routerFallback()
    const mismatches = SAMPLES.filter(({ code, error }) => error.status !== (ladder.get(code) ?? fallback)).map(
      ({ code, error }) => `${code}: error.status=${error.status} router=${ladder.get(code) ?? fallback}`,
    )

    // A mismatch means one document error has two statuses, and which one a
    // client sees depends on whether the router or a generic handler caught it.
    expect(mismatches).toEqual([])
  })
})
