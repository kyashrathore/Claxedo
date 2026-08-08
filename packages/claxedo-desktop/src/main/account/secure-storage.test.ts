import { describe, expect, test } from "bun:test"
import {
  REFRESH_SKEW_SECONDS,
  secureStorageVerdict,
  shouldRefresh,
  storedCredentialDisposition,
  type SafeStorageReport,
} from "./secure-storage"

function report(overrides: Partial<SafeStorageReport> = {}): SafeStorageReport {
  return { available: true, platform: "linux", backend: "gnome_libsecret", ...overrides }
}

describe("secureStorageVerdict", () => {
  test("refuses when Electron reports basic_text", () => {
    // The case this module exists for. `isEncryptionAvailable()` returns true,
    // encrypt/decrypt round-trip, and the key is published in Chromium's
    // source — so every obvious check passes while the token is readable by
    // any process running as the user.
    const verdict = secureStorageVerdict(report({ backend: "basic_text" }))

    expect(verdict.usable).toBe(false)
    expect(verdict.usable === false && verdict.reason).toBe("no-secure-storage")
    expect(verdict.usable === false && verdict.detail).toContain("published key")
  })

  test("refuses an unrecognised Linux backend", () => {
    // An allowlist, so a future plaintext-ish fallback is refused by default
    // rather than admitted by a denylist that has not heard of it yet.
    expect(secureStorageVerdict(report({ backend: "some_new_fallback" })).usable).toBe(false)
  })

  test("allows the Linux backends that really encrypt", () => {
    for (const backend of ["kwallet", "kwallet5", "kwallet6", "gnome_libsecret"]) {
      expect(secureStorageVerdict(report({ backend })).usable, backend).toBe(true)
    }
  })

  test("allows macOS and Windows, where the backing store is not selectable", () => {
    // Electron reports `unknown` off Linux; treating that as unrecognised would
    // disable sign-in on the two platforms with real OS credential stores.
    expect(secureStorageVerdict({ available: true, platform: "darwin", backend: "unknown" }).usable).toBe(true)
    expect(secureStorageVerdict({ available: true, platform: "win32" }).usable).toBe(true)
  })

  test("refuses when the OS reports no backend at all", () => {
    expect(secureStorageVerdict(report({ available: false })).usable).toBe(false)
    // Including on platforms that would otherwise pass without a backend check.
    expect(secureStorageVerdict({ available: false, platform: "darwin" }).usable).toBe(false)
  })
})

describe("storedCredentialDisposition", () => {
  const stored = { ciphertext: "…", backend: "gnome_libsecret", expiresAt: 2_000 }

  test("accepts a live credential from the same backend", () => {
    expect(storedCredentialDisposition({ stored, currentBackend: "gnome_libsecret", now: 1_000 })).toEqual({
      state: "usable",
    })
  })

  test("calls one written under a different backend dead", () => {
    // The direction that matters: a credential written under `basic_text` must
    // not become trusted merely because a keyring appeared later. Dead, not
    // "expired" — no refresh token can rescue this one.
    const result = storedCredentialDisposition({
      stored: { ...stored, backend: "basic_text" },
      currentBackend: "gnome_libsecret",
      now: 1_000,
    })

    expect(result).toEqual({ state: "dead", reason: "backend-changed" })
  })

  test("calls a passed expiry access-expired, not dead", () => {
    // `expiresAt` is the ACCESS token's. All a passed one establishes is that
    // the access token must be renewed before use; whether it CAN be is a
    // question about the plaintext, which this function cannot see. Answering
    // "dead" here is what deleted still-renewable sessions.
    expect(storedCredentialDisposition({ stored, currentBackend: "gnome_libsecret", now: 2_000 })).toEqual({
      state: "access-expired",
    })
    expect(storedCredentialDisposition({ stored, currentBackend: "gnome_libsecret", now: 2_001 })).toEqual({
      state: "access-expired",
    })
  })

  test("checks the backend before the clock", () => {
    // A wrong-backend credential is a security answer and an expired one is a
    // routine refresh; reporting the refresh first would hide the other.
    const result = storedCredentialDisposition({
      stored: { ...stored, backend: "basic_text", expiresAt: 1 },
      currentBackend: "gnome_libsecret",
      now: 1_000,
    })

    expect(result).toEqual({ state: "dead", reason: "backend-changed" })
  })
})

describe("shouldRefresh", () => {
  test("refreshes before expiry, not at it", () => {
    // Refreshing exactly at expiry races every request already in flight, and
    // the user sees that as a random sign-out.
    expect(shouldRefresh({ expiresAt: 1_000, now: 1_000 - REFRESH_SKEW_SECONDS - 1 })).toBe(false)
    expect(shouldRefresh({ expiresAt: 1_000, now: 1_000 - REFRESH_SKEW_SECONDS })).toBe(true)
    expect(shouldRefresh({ expiresAt: 1_000, now: 1_001 })).toBe(true)
  })
})
