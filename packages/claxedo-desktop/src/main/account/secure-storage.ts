/**
 * Whether this machine can hold an account credential at all.
 *
 * Electron's `safeStorage` always answers — the question is what it is backed
 * by. On macOS it is the Keychain and on Windows DPAPI, both of which bind the
 * secret to the OS user. On Linux it depends on what the desktop session
 * offers, and one of the possible answers is `basic_text`.
 *
 * `basic_text` is not encryption. Electron falls back to it when no keyring is
 * available, and it obfuscates with a hardcoded key that is published in
 * Chromium's source. `encryptString` still returns a buffer, `decryptString`
 * still round-trips, and `isEncryptionAvailable()` still returns true — so
 * every check a reasonable person would write passes while the refresh token
 * sits on disk in effectively plain text, readable by any process running as
 * the user.
 *
 * So this refuses signed mode on that backend rather than storing anything.
 * The product stays useful: local work needs no account, and the desktop's
 * whole point is that it runs without one. Telling the user "sign-in is
 * unavailable because this system has no secure credential store" is a worse
 * experience than signing in, and a much better one than a silently
 * exfiltratable token.
 *
 * Pure: `safeStorage`'s answers come in as data.
 */

/** What Electron reports for the OS-level backing store. */
export type SafeStorageReport = {
  available: boolean
  /**
   * `safeStorage.getSelectedStorageBackend()`, Linux only. Electron returns
   * `"unknown"` off Linux, which is not a problem — the backends there are not
   * selectable.
   */
  backend?: string
  platform: NodeJS.Platform
}

export type SecureStorageVerdict =
  | { usable: true }
  | { usable: false; reason: "no-secure-storage"; detail: string }

/**
 * Linux backends that actually encrypt.
 *
 * An allowlist, not a `!== "basic_text"` check: a future Electron adding
 * another plaintext-ish fallback would silently pass a denylist, and this is
 * the exact class of bug the whole module exists to prevent.
 */
const ENCRYPTING_LINUX_BACKENDS = new Set(["kwallet", "kwallet5", "kwallet6", "gnome_libsecret"])

export function secureStorageVerdict(report: SafeStorageReport): SecureStorageVerdict {
  if (!report.available) {
    return { usable: false, reason: "no-secure-storage", detail: "the OS reported no encryption backend" }
  }
  if (report.platform !== "linux") return { usable: true }

  const backend = report.backend ?? "unknown"
  if (ENCRYPTING_LINUX_BACKENDS.has(backend)) return { usable: true }
  return {
    usable: false,
    reason: "no-secure-storage",
    detail:
      backend === "basic_text"
        ? "this session has no keyring, so Electron would store the credential with a published key"
        : `unrecognised credential backend "${backend}"`,
  }
}

/** What a stored credential looks like on disk. */
export type StoredCredential = {
  /** `safeStorage.encryptString` output, base64. */
  ciphertext: string
  /** Which backend wrote it, so a backend change can invalidate rather than fail. */
  backend: string
  /**
   * Seconds since the epoch; the ACCESS token's expiry, not the refresh
   * token's. Past it the record is not dead — it is a record whose access token
   * needs renewing, and only the ciphertext knows whether it carries a refresh
   * token to renew it with. Treating this field as the record's own expiry is
   * how a still-renewable session gets deleted an hour after it was created.
   */
  expiresAt: number
}

/**
 * What to do with a stored credential.
 *
 * Three answers, not two. The backend check is the security half: if the
 * credential was written under a keyring and the machine now reports
 * `basic_text`, the decrypt would simply fail — but if it went the other way, a
 * credential written in effectively plaintext would be silently promoted to
 * "trusted" once a keyring appeared. Recording the writer makes both directions
 * explicit, and a mismatch is fatal to the record.
 *
 * The clock is the other half, and it is NOT fatal. `expiresAt` is the access
 * token's, so all a passed expiry establishes is that the access token must be
 * renewed before use. Whether it can be is decided by whoever can read the
 * plaintext — this function only sees ciphertext.
 */
export type StoredCredentialDisposition =
  /** Usable as-is. */
  | { state: "usable" }
  /** The access token is spent; usable only if the plaintext carries a refresh token. */
  | { state: "access-expired" }
  /** Nothing here may be used, whatever it decrypts to. */
  | { state: "dead"; reason: "backend-changed" }

export function storedCredentialDisposition(input: {
  stored: StoredCredential
  currentBackend: string
  now: number
}): StoredCredentialDisposition {
  if (input.stored.backend !== input.currentBackend) return { state: "dead", reason: "backend-changed" }
  if (input.stored.expiresAt <= input.now) return { state: "access-expired" }
  return { state: "usable" }
}

/**
 * How early to refresh, in seconds.
 *
 * Refreshing exactly at expiry guarantees a race: the request in flight when
 * the clock ticks over gets a 401 the user sees as a random sign-out.
 */
export const REFRESH_SKEW_SECONDS = 60

export function shouldRefresh(input: { expiresAt: number; now: number }) {
  return input.expiresAt - REFRESH_SKEW_SECONDS <= input.now
}
