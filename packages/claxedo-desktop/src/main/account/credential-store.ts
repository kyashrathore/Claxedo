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

import { secureStorageVerdict, storedCredentialDisposition, type StoredCredential } from "./secure-storage"

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
  /**
   * Undefined when absent, written by a different backend, undecryptable, or
   * spent — where spent means the access token has expired AND there is no
   * refresh token to renew it with. A record past `expiresAt` that still holds
   * a refresh token comes back intact; deciding to renew it belongs to the
   * account service, which is the only thing here that can.
   */
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

  return {
    available: () => storage().verdict,

    save(tokens) {
      const secure = storage()
      // Checked again at write time, not just before OAuth: the keyring can go
      // away mid-session (a locked wallet, a logged-out session bus), and
      // writing anyway is precisely the failure this module exists to prevent.
      if (!secure.verdict.usable) throw new Error(`refusing to store a credential: ${secure.verdict.detail}`)
      const record: StoredCredential = {
        ciphertext: input.safeStorage.encryptString(JSON.stringify(tokens)).toString("base64"),
        backend: secure.backend,
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
        input.file.clear()
        return undefined
      }

      const secure = storage()
      if (!secure.verdict.usable) {
        // `basic_text` is not a temporarily locked keyring. A record bearing
        // that backend can only have been written by an old/broken producer,
        // so it must never be decrypted and must not survive for a future
        // reader to promote. Other unavailable backends are recoverable: keep
        // their ciphertext intact until the OS store becomes usable again.
        if (input.platform === "linux" && secure.backend === "basic_text" && record.backend === "basic_text") {
          input.onRejected?.("stored credential unusable: basic_text is not protected storage")
          input.file.clear()
        }
        return undefined
      }

      const disposition = storedCredentialDisposition({ stored: record, currentBackend: secure.backend, now })
      if (disposition.state === "dead") {
        input.onRejected?.(`stored credential unusable: ${disposition.reason}`)
        // Cleared rather than left in place. A credential we will never use
        // again is only a liability, and keeping it invites a future reader
        // that skips this check.
        input.file.clear()
        return undefined
      }

      let tokens: TokenSet
      try {
        tokens = JSON.parse(input.safeStorage.decryptString(Buffer.from(record.ciphertext, "base64"))) as TokenSet
      } catch {
        // Decryption failing on a matching backend means the OS key changed
        // under us — same disposition as dead.
        input.onRejected?.("stored credential could not be decrypted")
        input.file.clear()
        return undefined
      }

      // The access token is spent. That is fatal only when there is nothing to
      // renew it with: deleting a record that still holds a live refresh token
      // signs the user out the first time they leave the app open past one
      // access-token lifetime, and no restart can undo it because the refresh
      // token went with it.
      if (disposition.state === "access-expired" && !tokens.refreshToken) {
        input.onRejected?.("stored credential unusable: expired with nothing to renew it")
        input.file.clear()
        return undefined
      }
      return tokens
    },

    clear: () => input.file.clear(),
  }
}
