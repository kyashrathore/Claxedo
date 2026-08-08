import { ClaxedoError } from "@claxedo/server-core/platform/errors/base"
import type { DocumentVersion } from "./port"

export type DocumentErrorCode =
  | "document_already_exists"
  | "document_invalid_entry"
  | "document_lock_timeout"
  | "document_not_found"
  | "document_not_text"
  | "document_path_outside_root"
  | "document_permission_denied"
  | "document_snapshot_corrupt"
  | "document_snapshot_not_found"
  | "document_storage_failed"
  | "document_too_large"
  | "document_version_conflict"

// Narrows `code` to this class's union. Merged rather than written as a
// `declare` class field: Playwright's babel transform rejects those unless
// @babel/plugin-transform-typescript is configured, and it loads this file.
export interface DocumentWorkspaceError {
  readonly code: DocumentErrorCode
}

export class DocumentWorkspaceError extends ClaxedoError {
  constructor(code: DocumentErrorCode, message: string, options?: ErrorOptions) {
    super({
      code,
      message,
      status: DOCUMENT_ERROR_STATUS[code],
      // A lock timeout is the one document failure a second attempt can clear
      // on its own; the rest describe the request or the stored state.
      retryable: code === "document_lock_timeout",
      ...(options?.cause !== undefined ? { cause: options.cause } : {}),
    })
  }
}

/**
 * The status each code surfaces as. These MIRROR the ladder in
 * `documents/routes/index.ts` — that router is what actually answers, so a
 * value here that disagrees with it gives one error object two different
 * statuses depending on which layer reads it.
 */
const DOCUMENT_ERROR_STATUS: Record<DocumentErrorCode, number> = {
  document_already_exists: 409,
  document_invalid_entry: 422,
  document_lock_timeout: 500,
  document_not_found: 404,
  document_not_text: 415,
  document_path_outside_root: 422,
  document_permission_denied: 403,
  document_snapshot_corrupt: 500,
  document_snapshot_not_found: 404,
  document_storage_failed: 500,
  document_too_large: 413,
  document_version_conflict: 409,
}

export class DocumentAlreadyExistsError extends DocumentWorkspaceError {
  constructor(documentId: string) {
    super("document_already_exists", `Document ${documentId} already exists`)
  }
}

export class DocumentInvalidEntryError extends DocumentWorkspaceError {
  constructor(message: string) {
    super("document_invalid_entry", message)
  }
}

export class DocumentLockTimeoutError extends DocumentWorkspaceError {
  constructor(documentId: string) {
    super("document_lock_timeout", `Timed out waiting for document ${documentId}`)
  }
}

export class DocumentNotFoundError extends DocumentWorkspaceError {
  constructor(documentId: string, options?: ErrorOptions) {
    super("document_not_found", `Document ${documentId} is missing`, options)
  }
}

export class DocumentNotTextError extends DocumentWorkspaceError {
  readonly currentVersion: DocumentVersion

  constructor(documentId: string, currentVersion: DocumentVersion, options?: ErrorOptions) {
    super("document_not_text", `Document ${documentId} is not valid UTF-8 text`, options)
    this.currentVersion = currentVersion
  }
}

export class DocumentPathError extends DocumentWorkspaceError {
  constructor(message: string, options?: ErrorOptions) {
    super("document_path_outside_root", message, options)
  }
}

export class DocumentStorageError extends DocumentWorkspaceError {
  readonly operation: string

  constructor(code: "document_permission_denied" | "document_storage_failed", operation: string, options?: ErrorOptions) {
    super(code, code === "document_permission_denied" ? `Permission denied while ${operation}` : `Failed while ${operation}`, options)
    this.operation = operation
  }
}

export class DocumentSnapshotCorruptError extends DocumentWorkspaceError {
  constructor(snapshotId: string, options?: ErrorOptions) {
    super("document_snapshot_corrupt", `Document snapshot ${snapshotId} failed its content hash check`, options)
  }
}

export class DocumentSnapshotNotFoundError extends DocumentWorkspaceError {
  constructor(snapshotId: string, options?: ErrorOptions) {
    super("document_snapshot_not_found", `Document snapshot ${snapshotId} is missing`, options)
  }
}

export class DocumentTooLargeError extends DocumentWorkspaceError {
  readonly actualBytes: number
  readonly maxBytes: number

  constructor(actualBytes: number, maxBytes: number) {
    super("document_too_large", `Document is ${actualBytes} bytes; the limit is ${maxBytes} bytes`)
    this.actualBytes = actualBytes
    this.maxBytes = maxBytes
  }
}

export class DocumentVersionConflictError extends DocumentWorkspaceError {
  readonly currentVersion: DocumentVersion | null

  constructor(currentVersion: DocumentVersion | null) {
    super("document_version_conflict", "Document content changed since it was read")
    this.currentVersion = currentVersion
  }
}

export function documentErrorFromCause(error: unknown, operation: string, documentId?: string) {
  if (error instanceof DocumentWorkspaceError) return error
  const code = nodeErrorCode(error)
  if (code === "ENOENT" && documentId) return new DocumentNotFoundError(documentId, { cause: error })
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
    return new DocumentStorageError("document_permission_denied", operation, { cause: error })
  }
  return new DocumentStorageError("document_storage_failed", operation, { cause: error })
}

export function nodeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string") return undefined
  return error.code
}
