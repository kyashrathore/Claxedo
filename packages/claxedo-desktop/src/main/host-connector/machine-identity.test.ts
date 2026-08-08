import { describe, expect, test } from "bun:test"
import { loadOrCreateMachineIdentity, type MachineIdentityFile } from "./machine-identity"
import type { SafeStorageApi } from "../account/credential-store"

/**
 * The machine identity is an authorisation credential, so it is tested like
 * one.
 *
 * Two properties carry the whole design and neither shows up in a happy-path
 * round trip: the id must be per-DATA-DIRECTORY (anything derived from the
 * hardware collides across profiles), and the key must never reach disk outside
 * `safeStorage` (a machine key in effective plaintext is a laptop anyone can
 * impersonate, permanently).
 */

/**
 * A `safeStorage` whose ciphertext is structurally distinguishable from its
 * plaintext, so "was this actually encrypted" is answerable.
 */
function fakeSafeStorage(overrides: Partial<SafeStorageApi> = {}) {
  const encrypted: string[] = []
  const api: SafeStorageApi = {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => {
      encrypted.push(plain)
      return Buffer.from(JSON.stringify({ sealed: plain }), "utf8")
    },
    decryptString: (buffer) => {
      const parsed = JSON.parse(buffer.toString("utf8")) as { sealed?: string }
      if (typeof parsed.sealed !== "string") throw new Error("not sealed by this backend")
      return parsed.sealed
    },
    getSelectedStorageBackend: () => "gnome_libsecret",
    ...overrides,
  }
  return { api, encrypted }
}

function memoryFile(initial?: string) {
  let contents = initial
  const cleared = { count: 0 }
  const file: MachineIdentityFile = {
    read: () => contents,
    write: (next) => {
      contents = next
    },
    clear: () => {
      cleared.count++
      contents = undefined
    },
  }
  return { file, cleared, current: () => contents }
}

/** One "data directory": one file, one safeStorage. */
function store(overrides: Partial<SafeStorageApi> = {}) {
  const storage = fakeSafeStorage(overrides)
  const disk = memoryFile()
  const rejected: string[] = []
  return {
    ...storage,
    ...disk,
    rejected,
    load: (platform: NodeJS.Platform = "darwin") =>
      loadOrCreateMachineIdentity({
        safeStorage: storage.api,
        file: disk.file,
        platform,
        onRejected: (reason) => rejected.push(reason),
      }),
  }
}

function expectOk(result: Awaited<ReturnType<ReturnType<typeof store>["load"]>>) {
  if (!result.ok) throw new Error(`expected an identity, got: ${result.detail}`)
  return result
}

describe("host id", () => {
  test("is stable across two reads of the same data directory", async () => {
    const machine = store()

    const first = expectOk(await machine.load())
    const second = expectOk(await machine.load())

    expect(first.created).toBe(true)
    // The second read must RESTORE, not mint. A restart that enrolls a new
    // machine fills the account with orphan rows and drops remote access.
    expect(second.created).toBe(false)
    expect(second.identity.hostId).toBe(first.identity.hostId)
  })

  test("is different across two data directories", async () => {
    // The case that rules out every derived identity: a second profile, or a
    // packaged build beside a dev build, on ONE laptop. A hostname- or
    // MAC-derived id would be identical here and the two would fight over one
    // enrollment.
    const a = expectOk(await store().load())
    const b = expectOk(await store().load())

    expect(a.identity.hostId).not.toBe(b.identity.hostId)
  })

  test("is long and random rather than machine-descriptive", async () => {
    const machine = expectOk(await store().load())

    expect(machine.identity.hostId).toStartWith("host_")
    // 32 bytes base64url. A guessable id is one an outsider can probe for.
    expect(machine.identity.hostId.length).toBeGreaterThanOrEqual(38)
    expect(machine.identity.hostId).not.toContain(process.platform)
  })

  test("fits the authority's host id bounds", async () => {
    // `routes/hosted/host-enrollment.ts`: trimmed, 1..200 characters. An id
    // this side accepts and that side rejects fails at enrollment, not here.
    const machine = expectOk(await store().load())

    expect(machine.identity.hostId.trim()).toBe(machine.identity.hostId)
    expect(machine.identity.hostId.length).toBeLessThanOrEqual(200)
  })
})

describe("the signing key", () => {
  test("survives a restart and still produces verifiable signatures", async () => {
    // The id alone proves nothing — a restored id with a broken key looks fine
    // right up to the moment the control plane rejects every signature.
    const machine = store()
    const first = expectOk(await machine.load())
    const signature = await first.identity.keys.sign("payload")

    const second = expectOk(await machine.load())

    expect(second.identity.keys.publicKey).toBe(first.identity.keys.publicKey)
    const key = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(second.identity.keys.publicKey) as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    )
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
      new TextEncoder().encode("payload"),
    )
    expect(verified).toBe(true)
  })

  test("reaches disk only inside the ciphertext", async () => {
    const machine = store()

    const identity = expectOk(await machine.load())

    const record = JSON.parse(machine.current()!) as Record<string, unknown>
    // Exactly two fields. Anything else on the record is a field nobody
    // encrypted.
    expect(Object.keys(record).sort()).toEqual(["backend", "ciphertext"])
    // It went through `encryptString`, with the private half in it.
    expect(machine.encrypted).toHaveLength(1)
    expect(JSON.parse(machine.encrypted[0]!).privateKeyJwk).toHaveProperty("d")
    // And the public half genuinely lacks it, so enrollment cannot send it.
    expect(JSON.parse(identity.identity.keys.publicKey)).not.toHaveProperty("d")
  })

  test("is not handed back as an exportable JWK", async () => {
    // `createHostKeyPair` returns `privateKeyJwk` beside the signer. Passing
    // that object through would make the returned identity an export path for
    // the one secret this module exists to keep.
    const identity = expectOk(await store().load())

    expect(identity.identity.keys).not.toHaveProperty("privateKeyJwk")
    expect(JSON.stringify(identity.identity)).not.toContain('"d":')
  })
})

describe("refusing an insecure store", () => {
  test("refuses Linux basic_text and writes nothing", async () => {
    const machine = store({ getSelectedStorageBackend: () => "basic_text" })

    const result = await machine.load("linux")

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe("no-secure-storage")
    // The point of refusing: nothing on disk, and no key generated to leak.
    expect(machine.current()).toBeUndefined()
    expect(machine.encrypted).toHaveLength(0)
  })

  test("refuses when the OS reports no encryption at all", async () => {
    const machine = store({ isEncryptionAvailable: () => false })

    const result = await machine.load()

    expect(result.ok).toBe(false)
    expect(machine.current()).toBeUndefined()
  })

  test("refuses an unrecognised Linux backend rather than allowlisting by exclusion", async () => {
    const machine = store({ getSelectedStorageBackend: () => "some_new_fallback" })

    const result = await machine.load("linux")

    expect(result.ok).toBe(false)
    expect(machine.encrypted).toHaveLength(0)
  })

  test("accepts a real Linux keyring", async () => {
    // Positive control: without this, a `return { ok: false }` for every Linux
    // machine would pass every refusal test above.
    const machine = store({ getSelectedStorageBackend: () => "kwallet6" })

    expect(expectOk(await machine.load("linux")).created).toBe(true)
  })
})

describe("rejecting a stored record", () => {
  test("a backend change mints a NEW identity rather than reusing the id", async () => {
    // A hostId that outlives its key would re-enroll the same machine id under
    // a different public key — which is exactly what an impersonation looks
    // like from the control plane's side.
    const backend = { value: "gnome_libsecret" }
    const storage = fakeSafeStorage({ getSelectedStorageBackend: () => backend.value })
    const disk = memoryFile()
    const rejected: string[] = []
    const load = () =>
      loadOrCreateMachineIdentity({
        safeStorage: storage.api,
        file: disk.file,
        platform: "linux",
        onRejected: (reason) => rejected.push(reason),
      })

    const first = expectOk(await load())
    backend.value = "kwallet6"
    const second = expectOk(await load())

    expect(second.created).toBe(true)
    expect(second.identity.hostId).not.toBe(first.identity.hostId)
    expect(rejected.join(" ")).toContain("backend-changed")
  })

  test("unparseable contents are cleared and replaced", async () => {
    const storage = fakeSafeStorage()
    const disk = memoryFile("not json")
    const rejected: string[] = []

    const result = expectOk(
      await loadOrCreateMachineIdentity({
        safeStorage: storage.api,
        file: disk.file,
        platform: "darwin",
        onRejected: (reason) => rejected.push(reason),
      }),
    )

    expect(result.created).toBe(true)
    expect(disk.cleared.count).toBe(1)
    expect(rejected.join(" ")).toContain("could not be parsed")
  })

  test("a record the backend cannot decrypt is cleared", async () => {
    const storage = fakeSafeStorage()
    const disk = memoryFile(
      JSON.stringify({ ciphertext: Buffer.from("garbage").toString("base64"), backend: "gnome_libsecret" }),
    )
    const rejected: string[] = []

    const result = expectOk(
      await loadOrCreateMachineIdentity({
        safeStorage: storage.api,
        file: disk.file,
        platform: "darwin",
        onRejected: (reason) => rejected.push(reason),
      }),
    )

    expect(result.created).toBe(true)
    expect(disk.cleared.count).toBe(1)
    expect(rejected.join(" ")).toContain("could not be decrypted")
  })

  test("a decrypted record missing its key is rejected rather than half-used", async () => {
    // A record with an id and no key would produce a connector that enrolls a
    // machine it cannot sign for.
    const storage = fakeSafeStorage()
    const disk = memoryFile(
      JSON.stringify({
        ciphertext: Buffer.from(JSON.stringify({ sealed: JSON.stringify({ hostId: "host_x" }) })).toString("base64"),
        backend: "gnome_libsecret",
      }),
    )
    const rejected: string[] = []

    const result = expectOk(
      await loadOrCreateMachineIdentity({
        safeStorage: storage.api,
        file: disk.file,
        platform: "darwin",
        onRejected: (reason) => rejected.push(reason),
      }),
    )

    expect(result.identity.hostId).not.toBe("host_x")
    expect(rejected.join(" ")).toContain("has no private key")
  })

  test("a decrypted record missing its id is rejected", async () => {
    const storage = fakeSafeStorage()
    const disk = memoryFile(
      JSON.stringify({
        ciphertext: Buffer.from(
          JSON.stringify({ sealed: JSON.stringify({ privateKeyJwk: { kty: "EC" } }) }),
        ).toString("base64"),
        backend: "gnome_libsecret",
      }),
    )
    const rejected: string[] = []

    expectOk(
      await loadOrCreateMachineIdentity({
        safeStorage: storage.api,
        file: disk.file,
        platform: "darwin",
        onRejected: (reason) => rejected.push(reason),
      }),
    )

    expect(rejected.join(" ")).toContain("has no host id")
  })
})
