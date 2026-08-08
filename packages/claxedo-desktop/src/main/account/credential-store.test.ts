import { describe, expect, test } from "bun:test"
import { createCredentialStore, type CredentialFile, type SafeStorageApi } from "./credential-store"

/**
 * The store's job is to refuse in the right places.
 *
 * Reading back what you wrote is the easy half and would pass with no
 * encryption at all. What matters is that it will not write on a machine that
 * cannot keep a secret, and will not READ a credential written under a
 * different backend — that second one is the direction where a token that spent
 * its life in effective plaintext quietly becomes trusted.
 */

/** Reversible, not secure — the point is to observe what gets stored. */
function fakeSafeStorage(overrides: Partial<SafeStorageApi> = {}): SafeStorageApi {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (encrypted) => encrypted.toString().replace(/^enc:/, ""),
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
  }
}

function fakeFile(): CredentialFile & { contents: () => string | undefined; writes: number } {
  let value: string | undefined
  const file = {
    read: () => value,
    write: (contents: string) => {
      value = contents
      file.writes++
    },
    clear: () => {
      value = undefined
    },
    contents: () => value,
    writes: 0,
  }
  return file
}

const TOKENS = { accessToken: "at", refreshToken: "rt", expiresAt: 2_000 }

function store(overrides: { safeStorage?: Partial<SafeStorageApi>; platform?: NodeJS.Platform } = {}) {
  const file = fakeFile()
  const rejections: string[] = []
  return {
    file,
    rejections,
    store: createCredentialStore({
      safeStorage: fakeSafeStorage(overrides.safeStorage),
      file,
      platform: overrides.platform ?? "linux",
      onRejected: (reason) => rejections.push(reason),
    }),
  }
}

describe("save", () => {
  test("round-trips through the OS store", () => {
    const harness = store()

    harness.store.save(TOKENS)

    expect(harness.store.load(1_000)).toEqual(TOKENS)
  })

  test("writes only what safeStorage produced", () => {
    // The obvious bug is JSON.stringify straight to disk with encryption bolted
    // on later, and a round-trip test would not see it. Asserted as "the bytes
    // on disk are exactly the encryptString output" rather than "the file does
    // not contain the token" — the latter is a substring search over base64,
    // which passes or fails on coincidence.
    const encrypted: string[] = []
    const file = fakeFile()
    const api = createCredentialStore({
      safeStorage: fakeSafeStorage({
        encryptString: (plain) => {
          encrypted.push(plain)
          return Buffer.from(`enc:${plain}`)
        },
      }),
      file,
      platform: "linux",
    })

    api.save(TOKENS)

    expect(JSON.parse(encrypted[0]!)).toEqual(TOKENS)
    const record = JSON.parse(file.contents()!)
    expect(record).toMatchObject({ backend: "gnome_libsecret", expiresAt: 2_000 })
    expect(record.ciphertext).toBe(Buffer.from(`enc:${encrypted[0]}`).toString("base64"))
  })

  test("refuses on a machine that cannot keep a secret", () => {
    // Checked at write time and not only before OAuth: a keyring can go away
    // mid-session, and writing anyway is the whole failure this prevents.
    const harness = store({ safeStorage: { getSelectedStorageBackend: () => "basic_text" } })

    expect(() => harness.store.save(TOKENS)).toThrow(/refusing to store/)
    expect(harness.file.contents()).toBeUndefined()
  })

  test("refuses when the OS reports no encryption at all", () => {
    const harness = store({ safeStorage: { isEncryptionAvailable: () => false } })

    expect(() => harness.store.save(TOKENS)).toThrow(/refusing to store/)
  })
})

describe("load", () => {
  test("returns nothing when there is nothing stored", () => {
    expect(store().store.load(1_000)).toBeUndefined()
  })

  test("refuses a credential written under a different backend, and clears it", () => {
    // The direction that matters: a token written under `basic_text` must not
    // become trusted because a keyring appeared later.
    const harness = store()
    harness.file.write(JSON.stringify({ ciphertext: "enc:{}", backend: "basic_text", expiresAt: 9_999 }))

    expect(harness.store.load(1_000)).toBeUndefined()
    expect(harness.file.contents()).toBeUndefined()
    expect(harness.rejections[0]).toContain("backend-changed")
  })

  test("keeps a credential whose access token expired but whose refresh token lives", () => {
    // `expiresAt` on the record is the ACCESS token's. Treating it as the
    // record's own expiry deleted the refresh token unread — so a user who left
    // the app open past one token lifetime was signed out, and no restart could
    // undo it. Renewal is the account service's decision; this must give it
    // something to decide about.
    const harness = store()
    harness.store.save(TOKENS)

    expect(harness.store.load(2_001)).toEqual(TOKENS)
    expect(harness.file.contents()).toBeDefined()
    expect(harness.rejections).toEqual([])
  })

  test("discards an expired credential with nothing to renew it", () => {
    // The other half: no refresh token means no path back to a usable session,
    // and a credential that will never be used again is only a liability.
    const harness = store()
    harness.store.save({ accessToken: "at", expiresAt: 2_000 })

    expect(harness.store.load(2_001)).toBeUndefined()
    expect(harness.file.contents()).toBeUndefined()
    expect(harness.rejections[0]).toContain("expired")
  })

  test("survives a corrupt file instead of throwing at startup", () => {
    // This runs during app boot. A parse error taking down the launch would
    // turn a stale file into an unstartable app.
    const harness = store()
    harness.file.write("not json")

    expect(harness.store.load(1_000)).toBeUndefined()
    expect(harness.rejections[0]).toContain("could not be parsed")
  })

  test("clears a credential it cannot decrypt on a matching backend", () => {
    // The OS key changed under us. Same disposition as unusable — keeping it
    // only invites a future reader that skips the check.
    const harness = store({
      safeStorage: {
        decryptString: () => {
          throw new Error("bad key")
        },
      },
    })
    harness.file.write(JSON.stringify({ ciphertext: "x", backend: "gnome_libsecret", expiresAt: 9_999 }))

    expect(harness.store.load(1_000)).toBeUndefined()
    expect(harness.file.contents()).toBeUndefined()
  })
})

describe("available", () => {
  test("reports the machine verdict without touching storage", () => {
    // Callers use this to refuse sign-in BEFORE opening a browser.
    const harness = store({ safeStorage: { getSelectedStorageBackend: () => "basic_text" } })

    expect(harness.store.available().usable).toBe(false)
    expect(harness.file.writes).toBe(0)
  })

  test("allows macOS, where the backend is not selectable", () => {
    expect(store({ platform: "darwin", safeStorage: { getSelectedStorageBackend: () => "unknown" } }).store.available().usable).toBe(true)
  })
})

describe("clear", () => {
  test("removes the stored credential", () => {
    const harness = store()
    harness.store.save(TOKENS)

    harness.store.clear()

    expect(harness.store.load(1_000)).toBeUndefined()
  })
})
