import { randomUUID } from "node:crypto"

import type { BoundDesktopCredential } from "./auth-descriptor"
import { parseBoundDesktopCredential } from "./auth-descriptor"
import { secureStorageVerdict, storedCredentialDisposition, type StoredCredential } from "./secure-storage"

export type SafeStorageApi = {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
  getSelectedStorageBackend?: () => string
}

export type CredentialFile = {
  read: () => string | undefined
  replace: (contents: string) => void
  quarantine: (reason: string) => void
  clear: () => void
}

export type StoredDesktopCredential = BoundDesktopCredential & {
  revision: string
  persistenceState: "active" | "revocation-pending"
}

type EncryptedDesktopCredential = StoredCredential & {
  format: "claxedo-desktop-native-v2"
  revision: string
  state: "active" | "revocation-pending"
}

export class CredentialStoreConflict extends Error {
  constructor() {
    super("stored credential changed while it was being replaced")
    this.name = "CredentialStoreConflict"
  }
}

export type CredentialStore = {
  available: () => ReturnType<typeof secureStorageVerdict>
  save: (credential: BoundDesktopCredential, expectedRevision?: string | null) => StoredDesktopCredential
  load: (now: number) => StoredDesktopCredential | undefined
  beginRevocation: (expectedRevision: string) => string
  completeRevocation: (expectedRevision: string) => boolean
  reject: (expectedRevision: string, reason: string) => void
  clear: () => void
}

function parseEnvelope(contents: string): EncryptedDesktopCredential | undefined {
  try {
    const value = JSON.parse(contents) as Partial<EncryptedDesktopCredential>
    if (
      value.format !== "claxedo-desktop-native-v2" ||
      typeof value.revision !== "string" ||
      !value.revision ||
      (value.state !== "active" && value.state !== "revocation-pending") ||
      typeof value.ciphertext !== "string" ||
      typeof value.backend !== "string" ||
      typeof value.expiresAt !== "number"
    )
      return undefined
    return value as EncryptedDesktopCredential
  } catch {
    return undefined
  }
}

export function createCredentialStore(input: {
  safeStorage: SafeStorageApi
  file: CredentialFile
  platform: NodeJS.Platform
  onRejected?: (reason: string) => void
  createRevision?: () => string
}): CredentialStore {
  const backend = () => input.safeStorage.getSelectedStorageBackend?.() ?? "unknown"
  const storage = () => {
    const selectedBackend = backend()
    return {
      backend: selectedBackend,
      verdict: secureStorageVerdict({
        available: input.safeStorage.isEncryptionAvailable(),
        backend: selectedBackend,
        platform: input.platform,
      }),
    }
  }
  const rejected = (reason: string) => {
    input.onRejected?.(reason)
    input.file.quarantine(reason)
  }

  return {
    available: () => storage().verdict,

    save(credential, expectedRevision) {
      const secure = storage()
      if (!secure.verdict.usable) throw new Error(`refusing to store a credential: ${secure.verdict.detail}`)

      const currentContents = input.file.read()
      const current = currentContents ? parseEnvelope(currentContents) : undefined
      if (currentContents && !current) throw new CredentialStoreConflict()
      if (expectedRevision === null && current) throw new CredentialStoreConflict()
      if (typeof expectedRevision === "string" && current?.revision !== expectedRevision) {
        throw new CredentialStoreConflict()
      }

      const revision = (input.createRevision ?? randomUUID)()
      const record: EncryptedDesktopCredential = {
        format: "claxedo-desktop-native-v2",
        revision,
        state: "active",
        ciphertext: input.safeStorage.encryptString(JSON.stringify(credential)).toString("base64"),
        backend: secure.backend,
        expiresAt: credential.tokens.expiresAt,
      }
      input.file.replace(JSON.stringify(record))
      return { ...credential, revision, persistenceState: "active" }
    },

    load(now) {
      const contents = input.file.read()
      if (!contents) return undefined
      const record = parseEnvelope(contents)
      if (!record) {
        rejected("stored credential is legacy, unbound, or malformed")
        return undefined
      }

      const secure = storage()
      if (!secure.verdict.usable) {
        if (input.platform === "linux" && secure.backend === "basic_text" && record.backend === "basic_text") {
          rejected("stored credential unusable: basic_text is not protected storage")
        }
        return undefined
      }

      const disposition = storedCredentialDisposition({ stored: record, currentBackend: secure.backend, now })
      if (disposition.state === "dead") {
        rejected(`stored credential unusable: ${disposition.reason}`)
        return undefined
      }

      let credential: BoundDesktopCredential
      try {
        credential = parseBoundDesktopCredential(
          JSON.parse(input.safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"))) as unknown,
        )
      } catch {
        rejected("stored credential could not be decrypted or is not completely bound")
        return undefined
      }
      if (credential.tokens.expiresAt !== record.expiresAt) {
        rejected("stored credential expiry does not match its encrypted payload")
        return undefined
      }
      return { ...credential, revision: record.revision, persistenceState: record.state }
    },

    beginRevocation(expectedRevision) {
      const contents = input.file.read()
      if (!contents) throw new CredentialStoreConflict()
      const current = parseEnvelope(contents)
      if (current?.revision !== expectedRevision || current.state !== "active") {
        throw new CredentialStoreConflict()
      }
      const revision = (input.createRevision ?? randomUUID)()
      input.file.replace(
        JSON.stringify({
          ...current,
          revision,
          state: "revocation-pending",
        } satisfies EncryptedDesktopCredential),
      )
      return revision
    },

    completeRevocation(expectedRevision) {
      const contents = input.file.read()
      if (!contents) return true
      const current = parseEnvelope(contents)
      if (current?.revision !== expectedRevision) return false
      input.file.clear()
      return true
    },

    reject(expectedRevision, reason) {
      const contents = input.file.read()
      if (!contents) return
      const current = parseEnvelope(contents)
      if (current?.revision !== expectedRevision) return
      rejected(reason)
    },

    clear: () => input.file.clear(),
  }
}
