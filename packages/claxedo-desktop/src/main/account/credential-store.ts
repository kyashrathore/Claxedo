/**
 * Where the account credential actually lives.
 *
 * `secure-storage.ts` decides whether this machine may hold one; this writes
 * and reads it. The split is deliberate — the policy is the part worth reading
 * carefully, and mixing it with file I/O is how a refusal turns into a
 * "temporary" fallback that stores the token anyway.
 *
 * The stored record keeps the BACKEND that wrote it, not just the ciphertext.
 * Without that, a credential written under Electron's Linux `basic_text`
 * fallback would be silently promoted to trusted the moment a real keyring
 * appeared, having spent its life readable by any process running as the user.
 *
 * Electron is injected so this is testable in a plain Node process.
 */

import { secureStorageVerdict, storedCredentialUsable, type StoredCredential } from "./secure-storage"

export type SafeStorageApi = {
  isEncryptionAvailable: () => boolean
  encryptString: (plain: string) => Buffer
  decryptString: (encrypted: Buffer) => string
  /** Linux only; Electron returns "unknown" elsewhere. */
  getSelectedStorageBackend?: () => string
}

export type CredentialFile = {
  read: () => string | undefined
  write: (contents: string) => void
  clear: () => void
}

export type TokenSet = {
  accessToken: string
  refreshToken?: string
  /** Seconds since the epoch. */
  expiresAt: number
}

export type CredentialStore = {
  /** The verdict for this machine, so callers can refuse before OAuth. */
  available: () => ReturnType<typeof secureStorageVerdict>
  save: (tokens: TokenSet) => void
  /** Undefined when absent, unusable, or written by a different backend. */
  load: (now: number) => TokenSet | undefined
  clear: () => void
}

export function createCredentialStore(input: {
  safeStorage: SafeStorageApi
  file: CredentialFile
  platform: NodeJS.Platform
  onRejected?: (reason: string) => void
}): CredentialStore {
  const backend = () => input.safeStorage.getSelectedStorageBackend?.() ?? "unknown"
  const verdict = () =>
    secureStorageVerdict({
      available: input.safeStorage.isEncryptionAvailable(),
      backend: backend(),
      platform: input.platform,
    })

  return {
    available: verdict,

    save(tokens) {
      const usable = verdict()
      // Checked again at write time, not just before OAuth: the keyring can go
      // away mid-session (a locked wallet, a logged-out session bus), and
      // writing anyway is precisely the failure this module exists to prevent.
      if (!usable.usable) throw new Error(`refusing to store a credential: ${usable.detail}`)
      const record: StoredCredential = {
        ciphertext: input.safeStorage.encryptString(JSON.stringify(tokens)).toString("base64"),
        backend: backend(),
        expiresAt: tokens.expiresAt,
      }
      input.file.write(JSON.stringify(record))
    },

    load(now) {
      const contents = input.file.read()
      if (!contents) return undefined
      let record: StoredCredential
      try {
        record = JSON.parse(contents) as StoredCredential
      } catch {
        input.onRejected?.("stored credential could not be parsed")
        return undefined
      }
      const usable = storedCredentialUsable({ stored: record, currentBackend: backend(), now })
      if (!usable.usable) {
        input.onRejected?.(`stored credential unusable: ${usable.reason}`)
        // Cleared rather than left in place. A credential we will never use
        // again is only a liability, and keeping it invites a future reader
        // that skips this check.
        input.file.clear()
        return undefined
      }
      try {
        return JSON.parse(input.safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"))) as TokenSet
      } catch {
        // Decryption failing on a matching backend means the OS key changed
        // under us — same disposition as unusable.
        input.onRejected?.("stored credential could not be decrypted")
        input.file.clear()
        return undefined
      }
    },

    clear: () => input.file.clear(),
  }
}
