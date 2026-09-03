import { describe, expect, test } from "bun:test"

import type { BoundDesktopCredential } from "./auth-descriptor"
import {
  CredentialStoreConflict,
  createCredentialStore,
  type CredentialFile,
  type SafeStorageApi,
} from "./credential-store"

const CREDENTIAL: BoundDesktopCredential = {
  binding: {
    kind: "desktop",
    tokenKind: "access-token",
    adapter: "better-auth",
    deploymentId: "dep_1",
    configurationVersion: "config_1",
    issuer: "https://core.example/api/auth",
    flow: "authorization-code-pkce",
    tokenEndpointOrigin: "https://core.example",
    controlPlaneOrigin: "https://core.example",
    id: "desktop_1",
    resource: "https://core.example/api/claxedo",
    scopes: ["openid", "offline_access"],
  },
  tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 2_000 },
}

function safeStorage(overrides: Partial<SafeStorageApi> = {}): SafeStorageApi {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${plain}`),
    decryptString: (encrypted) => encrypted.toString().replace(/^enc:/, ""),
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
  }
}

function fakeFile(initial?: string) {
  let value = initial
  const quarantined: string[] = []
  const file: CredentialFile & { contents(): string | undefined; quarantined: string[] } = {
    read: () => value,
    replace: (contents) => {
      value = contents
    },
    quarantine: (reason) => {
      quarantined.push(reason)
      value = undefined
    },
    clear: () => {
      value = undefined
    },
    contents: () => value,
    quarantined,
  }
  return file
}

function harness(initial?: string, safe: Partial<SafeStorageApi> = {}) {
  const file = fakeFile(initial)
  let revision = 0
  return {
    file,
    store: createCredentialStore({
      safeStorage: safeStorage(safe),
      file,
      platform: "linux",
      createRevision: () => `r${++revision}`,
    }),
  }
}

describe("bound encrypted credential store", () => {
  test("encrypts and round-trips the complete immutable binding plus token set", () => {
    const h = harness()
    const stored = h.store.save(CREDENTIAL, null)

    expect(stored.revision).toBe("r1")
    expect(h.store.load(1_000)).toEqual({
      ...CREDENTIAL,
      revision: "r1",
      persistenceState: "active",
    })
    const envelope = JSON.parse(h.file.contents()!)
    expect(envelope).toMatchObject({
      format: "claxedo-desktop-native-v2",
      revision: "r1",
      state: "active",
      backend: "gnome_libsecret",
      expiresAt: 2_000,
    })
    expect(h.file.contents()).not.toContain('"accessToken"')
    expect(h.file.contents()).not.toContain('"refreshToken"')
  })

  test("compare-and-swap refuses a stale refresh owner", () => {
    const h = harness()
    h.store.save(CREDENTIAL, null)
    h.store.save({ ...CREDENTIAL, tokens: { ...CREDENTIAL.tokens, accessToken: "winner" } }, "r1")

    expect(() => h.store.save(CREDENTIAL, "r1")).toThrow(CredentialStoreConflict)
    expect(h.store.load(1_000)?.tokens.accessToken).toBe("winner")
  })

  test("atomically marks logout pending and keeps the encrypted credential retryable until confirmation", () => {
    const h = harness()
    h.store.save(CREDENTIAL, null)

    const pendingRevision = h.store.beginRevocation("r1")
    expect(pendingRevision).toBe("r2")
    expect(h.store.load(1_000)).toMatchObject({
      revision: "r2",
      persistenceState: "revocation-pending",
      binding: CREDENTIAL.binding,
    })
    expect(h.store.completeRevocation("r1")).toBe(false)
    expect(h.store.completeRevocation("r2")).toBe(true)
    expect(h.file.contents()).toBeUndefined()
  })

  test("quarantines every legacy token-only record without decrypting it", () => {
    let decrypts = 0
    const h = harness(
      JSON.stringify({
        ciphertext: Buffer.from(JSON.stringify({ accessToken: "legacy" })).toString("base64"),
        backend: "gnome_libsecret",
        expiresAt: 2_000,
      }),
      {
        decryptString: () => {
          decrypts++
          return "{}"
        },
      },
    )

    expect(h.store.load(1_000)).toBeUndefined()
    expect(decrypts).toBe(0)
    expect(h.file.quarantined[0]).toContain("legacy")
  })

  test("quarantines a decrypted record missing any binding or refresh-token field", () => {
    const h = harness()
    h.store.save(CREDENTIAL, null)
    const envelope = JSON.parse(h.file.contents()!)
    envelope.ciphertext = Buffer.from(`enc:${JSON.stringify({ tokens: CREDENTIAL.tokens })}`).toString("base64")
    h.file.replace(JSON.stringify(envelope))

    expect(h.store.load(1_000)).toBeUndefined()
    expect(h.file.quarantined[0]).toContain("completely bound")
  })

  test("preserves protected ciphertext while the OS keyring is temporarily unavailable", () => {
    const written = harness()
    written.store.save(CREDENTIAL, null)
    const contents = written.file.contents()!
    const h = harness(contents, { isEncryptionAvailable: () => false })

    expect(h.store.load(1_000)).toBeUndefined()
    expect(h.file.contents()).toBe(contents)
    expect(h.file.quarantined).toEqual([])
  })

  test("refuses a write when protected storage is unavailable", () => {
    const h = harness(undefined, {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => "basic_text",
    })
    expect(() => h.store.save(CREDENTIAL, null)).toThrow("refusing to store")
    expect(h.file.contents()).toBeUndefined()
  })
})
