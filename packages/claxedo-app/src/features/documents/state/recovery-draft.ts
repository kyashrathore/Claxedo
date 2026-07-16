export interface RecoveryDraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export interface RecoveryDraft {
  documentId: string
  version: string
  displayName: string
  markdown: string
  updatedAt: number
}

export type RecoveryDraftResult<T> = { ok: true; value: T } | { ok: false; error: unknown }

export function createRecoveryDraftStore(storage: RecoveryDraftStorage) {
  return {
    read(documentId: string, version: string): RecoveryDraftResult<RecoveryDraft | undefined> {
      const exact = readDraft(storage, documentId, version)
      if (!exact.ok || exact.value) return exact
      const versions = readVersions(storage, documentId)
      if (!versions.ok) return versions
      const drafts = versions.value.map((candidate) => readDraft(storage, documentId, candidate))
      const error = drafts.find((draft) => !draft.ok)
      if (error && !error.ok) return error
      return {
        ok: true,
        value: drafts
          .flatMap((draft) => (draft.ok && draft.value ? [draft.value] : []))
          .sort((left, right) => right.updatedAt - left.updatedAt)[0],
      }
    },
    write(draft: RecoveryDraft): RecoveryDraftResult<undefined> {
      try {
        storage.setItem(recoveryDraftKey(draft.documentId, draft.version), JSON.stringify(draft))
        const versions = readVersions(storage, draft.documentId)
        storage.setItem(
          recoveryDraftVersionsKey(draft.documentId),
          JSON.stringify([...new Set([...(versions.ok ? versions.value : []), draft.version])]),
        )
        return { ok: true, value: undefined }
      } catch (error) {
        return { ok: false, error }
      }
    },
    remove(documentId: string, version: string): RecoveryDraftResult<undefined> {
      try {
        storage.removeItem(recoveryDraftKey(documentId, version))
        const versions = readVersions(storage, documentId)
        if (!versions.ok) return versions
        const remaining = versions.value.filter((candidate) => candidate !== version)
        if (!remaining.length) storage.removeItem(recoveryDraftVersionsKey(documentId))
        if (remaining.length) storage.setItem(recoveryDraftVersionsKey(documentId), JSON.stringify(remaining))
        return { ok: true, value: undefined }
      } catch (error) {
        return { ok: false, error }
      }
    },
  }
}

export type RecoveryDraftStore = ReturnType<typeof createRecoveryDraftStore>

function recoveryDraftKey(documentId: string, version: string) {
  return `claxedo:document-recovery:${encodeURIComponent(documentId)}:draft:${encodeURIComponent(version)}`
}

function recoveryDraftVersionsKey(documentId: string) {
  return `claxedo:document-recovery:${encodeURIComponent(documentId)}:versions`
}

function readDraft(
  storage: RecoveryDraftStorage,
  documentId: string,
  version: string,
): RecoveryDraftResult<RecoveryDraft | undefined> {
  try {
    const value = storage.getItem(recoveryDraftKey(documentId, version))
    if (!value) return { ok: true, value: undefined }
    const draft = JSON.parse(value) as unknown
    if (!isRecoveryDraft(draft, documentId, version)) {
      return { ok: false, error: new Error("Invalid document recovery draft") }
    }
    return { ok: true, value: draft }
  } catch (error) {
    return { ok: false, error }
  }
}

function readVersions(storage: RecoveryDraftStorage, documentId: string): RecoveryDraftResult<string[]> {
  try {
    const value = storage.getItem(recoveryDraftVersionsKey(documentId))
    if (!value) return { ok: true, value: [] }
    const versions = JSON.parse(value) as unknown
    if (!Array.isArray(versions) || versions.some((version) => typeof version !== "string")) {
      return { ok: false, error: new Error("Invalid document recovery index") }
    }
    return { ok: true, value: versions }
  } catch (error) {
    return { ok: false, error }
  }
}

function isRecoveryDraft(value: unknown, documentId: string, version: string): value is RecoveryDraft {
  if (!value || typeof value !== "object") return false
  const draft = value as Record<string, unknown>
  return (
    draft.documentId === documentId &&
    draft.version === version &&
    typeof draft.displayName === "string" &&
    typeof draft.markdown === "string" &&
    typeof draft.updatedAt === "number"
  )
}
