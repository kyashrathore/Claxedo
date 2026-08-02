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

export class DocumentWorkspaceError extends Error {
  readonly code: DocumentErrorCode

  constructor(code: DocumentErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "DocumentWorkspaceError"
    this.code = code
  }
}

export class DocumentAlreadyExistsError extends DocumentWorkspaceError {
  constructor(documentId: string) {
    super("document_already_exists", `Document ${documentId} already exists`)
    this.name = "DocumentAlreadyExistsError"
  }
}

export class DocumentInvalidEntryError extends DocumentWorkspaceError {
  constructor(message: string) {
    super("document_invalid_entry", message)
    this.name = "DocumentInvalidEntryError"
  }
}

export class DocumentLockTimeoutError extends DocumentWorkspaceError {
  constructor(documentId: string) {
    super("document_lock_timeout", `Timed out waiting for document ${documentId}`)
    this.name = "DocumentLockTimeoutError"
  }
}

export class DocumentNotFoundError extends DocumentWorkspaceError {
  constructor(documentId: string, options?: ErrorOptions) {
    super("document_not_found", `Document ${documentId} is missing`, options)
    this.name = "DocumentNotFoundError"
  }
}

export class DocumentNotTextError extends DocumentWorkspaceError {
  readonly currentVersion: DocumentVersion

  constructor(documentId: string, currentVersion: DocumentVersion, options?: ErrorOptions) {
    super("document_not_text", `Document ${documentId} is not valid UTF-8 text`, options)
    this.name = "DocumentNotTextError"
    this.currentVersion = currentVersion
  }
}

export class DocumentPathError extends DocumentWorkspaceError {
  constructor(message: string, options?: ErrorOptions) {
    super("document_path_outside_root", message, options)
    this.name = "DocumentPathError"
  }
}

export class DocumentStorageError extends DocumentWorkspaceError {
  readonly operation: string

  constructor(code: "document_permission_denied" | "document_storage_failed", operation: string, options?: ErrorOptions) {
    super(code, code === "document_permission_denied" ? `Permission denied while ${operation}` : `Failed while ${operation}`, options)
    this.name = "DocumentStorageError"
    this.operation = operation
  }
}

export class DocumentSnapshotCorruptError extends DocumentWorkspaceError {
  constructor(snapshotId: string, options?: ErrorOptions) {
    super("document_snapshot_corrupt", `Document snapshot ${snapshotId} failed its content hash check`, options)
    this.name = "DocumentSnapshotCorruptError"
  }
}

export class DocumentSnapshotNotFoundError extends DocumentWorkspaceError {
  constructor(snapshotId: string, options?: ErrorOptions) {
    super("document_snapshot_not_found", `Document snapshot ${snapshotId} is missing`, options)
    this.name = "DocumentSnapshotNotFoundError"
  }
}

export class DocumentTooLargeError extends DocumentWorkspaceError {
  readonly actualBytes: number
  readonly maxBytes: number

  constructor(actualBytes: number, maxBytes: number) {
    super("document_too_large", `Document is ${actualBytes} bytes; the limit is ${maxBytes} bytes`)
    this.name = "DocumentTooLargeError"
    this.actualBytes = actualBytes
    this.maxBytes = maxBytes
  }
}

export class DocumentVersionConflictError extends DocumentWorkspaceError {
  readonly currentVersion: DocumentVersion | null

  constructor(currentVersion: DocumentVersion | null) {
    super("document_version_conflict", "Document content changed since it was read")
    this.name = "DocumentVersionConflictError"
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
