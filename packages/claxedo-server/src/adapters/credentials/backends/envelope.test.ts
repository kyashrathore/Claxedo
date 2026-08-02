import { describe, expect, test } from "vitest"
import type { SecretBackend } from "../types"
import {
  CREDENTIALS_KEK_ENV,
  CREDENTIALS_KEK_NEXT_ENV,
  createStaticKeyProvider,
  encryptedSecretBackend,
  envelopeKeyId,
  envelopeKeyProviderFromEnv,
} from "./envelope"

const ENVELOPE_RE = /^cenc1:([0-9a-f]{16}):([A-Za-z0-9+/=]+)$/

function memoryBackend(): SecretBackend & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async put(id, secret) {
      const ref = `mem:${id}`
      values.set(ref, secret)
      return ref
    },
    async get(ref) {
      return values.get(ref) ?? null
    },
    async delete(ref) {
      values.delete(ref)
    },
    async probe() {
      return true
    },
  }
}

function kek(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill)
}

function kekBase64(fill: number): string {
  return Buffer.from(kek(fill)).toString("base64")
}

describe("envelope encryption wrapper", () => {
  test("round-trips a secret and stores only a cenc1 envelope, never plaintext", async () => {
    const inner = memoryBackend()
    const backend = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })

    const ref = await backend.put("cred-1", "super-secret-value")
    expect(ref).toBe("mem:cred-1")
    expect(await backend.get(ref)).toBe("super-secret-value")

    const stored = inner.values.get(ref)!
    expect(stored).toMatch(ENVELOPE_RE)
    expect(stored).not.toContain("super-secret-value")
  })

  test("stored key-id prefix matches the KEK's derived key-id", async () => {
    const inner = memoryBackend()
    const backend = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })
    const ref = await backend.put("cred-1", "v")
    const stored = inner.values.get(ref)!
    expect(stored.split(":")[1]).toBe(await envelopeKeyId(kek(1)))
  })

  test("per-org key separation: org A ciphertext does not decrypt under org B", async () => {
    const inner = memoryBackend()
    const keys = createStaticKeyProvider({ current: kek(1) })
    const orgA = encryptedSecretBackend(inner, keys, { orgId: "org-a" })
    const orgB = encryptedSecretBackend(inner, keys, { orgId: "org-b" })

    const ref = await orgA.put("cred-1", "org-a-secret")
    await expect(orgB.get(ref)).rejects.toThrow(/failed authentication/)
    // Sanity: the rightful org still reads it.
    expect(await orgA.get(ref)).toBe("org-a-secret")
  })

  test("key-id rotation: write under key 1, rotate, read old + write new under key 2", async () => {
    const inner = memoryBackend()

    // Epoch 1: only key 1 exists.
    const epoch1 = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })
    const oldRef = await epoch1.put("old-cred", "written-under-key-1")

    // Epoch 2: key 2 is current, key 1 stays accepted for reads.
    const epoch2 = encryptedSecretBackend(
      inner,
      createStaticKeyProvider({ current: kek(2), previous: [kek(1)] }),
      { orgId: "org-a" },
    )
    expect(await epoch2.get(oldRef)).toBe("written-under-key-1")

    const newRef = await epoch2.put("new-cred", "written-under-key-2")
    expect(inner.values.get(oldRef)!.split(":")[1]).toBe(await envelopeKeyId(kek(1)))
    expect(inner.values.get(newRef)!.split(":")[1]).toBe(await envelopeKeyId(kek(2)))
    expect(await epoch2.get(newRef)).toBe("written-under-key-2")
  })

  test("unknown key-id fails closed with the key-id named", async () => {
    const inner = memoryBackend()
    const writer = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(9) }), { orgId: "org-a" })
    const ref = await writer.put("cred-1", "v")

    const reader = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })
    const keyId = await envelopeKeyId(kek(9))
    await expect(reader.get(ref)).rejects.toThrow(new RegExp(`unknown key-id "${keyId}"`))
  })

  test("tamper detection: modified ciphertext fails GCM authentication", async () => {
    const inner = memoryBackend()
    const backend = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })
    const ref = await backend.put("cred-1", "authentic-value")

    const stored = inner.values.get(ref)!
    const [tag, keyId, payload] = stored.split(":") as [string, string, string]
    const bytes = Buffer.from(payload, "base64")
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff // flip bits inside the GCM tag
    inner.values.set(ref, `${tag}:${keyId}:${bytes.toString("base64")}`)

    await expect(backend.get(ref)).rejects.toThrow(/failed authentication/)
  })

  test("F16: ciphertext is bound to its storage id — decrypting under a DIFFERENT id fails", async () => {
    const inner = memoryBackend()
    const backend = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })

    const ref = await backend.put("cred-a", "slot-a-secret")
    // Rightful slot still reads.
    expect(await backend.get(ref)).toBe("slot-a-secret")

    // Simulate a within-org blob relocation/rollback under the leaked-KV-token
    // threat: copy the ciphertext verbatim into a DIFFERENT credential slot.
    const stored = inner.values.get(ref)!
    inner.values.set("mem:cred-b", stored)
    // Same org key decrypts the bytes, but the GCM AAD (bound to the id) no
    // longer matches → authentication fails, the blob is never served.
    await expect(backend.get("mem:cred-b")).rejects.toThrow(/failed authentication/)
  })

  test("refuses to serve values that are not envelopes (plaintext hole stays closed)", async () => {
    const inner = memoryBackend()
    const backend = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })
    inner.values.set("mem:legacy", "legacy-plaintext-token")
    await expect(backend.get("mem:legacy")).rejects.toThrow(/not a recognized encryption envelope/)
  })

  test("missing ref still reads as null (absence is not an error)", async () => {
    const backend = encryptedSecretBackend(memoryBackend(), createStaticKeyProvider({ current: kek(1) }), {
      orgId: "org-a",
    })
    expect(await backend.get("mem:nope")).toBeNull()
  })

  test("delete and probe pass through to the inner backend", async () => {
    const inner = memoryBackend()
    const backend = encryptedSecretBackend(inner, createStaticKeyProvider({ current: kek(1) }), { orgId: "org-a" })
    const ref = await backend.put("cred-1", "v")
    await backend.delete(ref)
    expect(inner.values.has(ref)).toBe(false)
    expect(await backend.probe()).toBe(true)
  })

  test("requires a non-empty orgId partition", () => {
    expect(() =>
      encryptedSecretBackend(memoryBackend(), createStaticKeyProvider({ current: kek(1) }), { orgId: "  " }),
    ).toThrow(/non-empty orgId/)
  })

  test("rejects KEKs shorter than 32 bytes", () => {
    expect(() => createStaticKeyProvider({ current: new Uint8Array(16) })).toThrow(/at least 32 bytes/)
    expect(() => createStaticKeyProvider({ current: kek(1), previous: [new Uint8Array(8)] })).toThrow(
      /at least 32 bytes/,
    )
  })
})

describe("envelope KEK provider from env", () => {
  test("fails closed when CLAXEDO_CREDENTIALS_KEK is absent", () => {
    expect(() => envelopeKeyProviderFromEnv({})).toThrow(new RegExp(CREDENTIALS_KEK_ENV))
    expect(() => envelopeKeyProviderFromEnv({ [CREDENTIALS_KEK_ENV]: "   " })).toThrow(
      new RegExp(CREDENTIALS_KEK_ENV),
    )
  })

  test("fails closed on malformed or short KEK values", () => {
    expect(() => envelopeKeyProviderFromEnv({ [CREDENTIALS_KEK_ENV]: "!!not-base64!!" })).toThrow(/not valid base64/)
    expect(() =>
      envelopeKeyProviderFromEnv({ [CREDENTIALS_KEK_ENV]: Buffer.alloc(8).toString("base64") }),
    ).toThrow(/at least 32 bytes/)
    expect(() =>
      envelopeKeyProviderFromEnv({
        [CREDENTIALS_KEK_ENV]: kekBase64(1),
        [CREDENTIALS_KEK_NEXT_ENV]: "!!not-base64!!",
      }),
    ).toThrow(new RegExp(CREDENTIALS_KEK_NEXT_ENV))
  })

  test("KEK writes, KEK_NEXT is accepted for reads (rotation drain)", async () => {
    const inner = memoryBackend()

    // Old deployment wrote under key 1.
    const oldProvider = envelopeKeyProviderFromEnv({ [CREDENTIALS_KEK_ENV]: kekBase64(1) })
    const oldBackend = encryptedSecretBackend(inner, oldProvider, { orgId: "org-a" })
    const oldRef = await oldBackend.put("cred-1", "pre-rotation")

    // Rotated deployment: key 2 current, key 1 in the NEXT (drain) slot.
    const rotated = envelopeKeyProviderFromEnv({
      [CREDENTIALS_KEK_ENV]: kekBase64(2),
      [CREDENTIALS_KEK_NEXT_ENV]: kekBase64(1),
    })
    const rotatedBackend = encryptedSecretBackend(inner, rotated, { orgId: "org-a" })
    expect(await rotatedBackend.get(oldRef)).toBe("pre-rotation")

    const newRef = await rotatedBackend.put("cred-2", "post-rotation")
    expect(inner.values.get(newRef)!.split(":")[1]).toBe(await envelopeKeyId(kek(2)))
  })

  test("accepts url-safe base64 KEKs", async () => {
    // Bytes chosen so standard base64 contains "+" / "/" characters.
    const bytes = new Uint8Array(32).map((_, i) => (i * 41 + 250) % 256)
    const urlSafe = Buffer.from(bytes).toString("base64url")
    const provider = envelopeKeyProviderFromEnv({ [CREDENTIALS_KEK_ENV]: urlSafe })
    const current = await provider.current()
    expect(current.keyId).toBe(await envelopeKeyId(bytes))
  })
})
