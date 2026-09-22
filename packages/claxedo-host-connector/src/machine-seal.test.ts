import { describe, expect, test } from "vitest"

import {
  createMachineSealingKeyPair,
  hostMachineSealAad,
  MACHINE_SEAL_DOMAIN,
  MACHINE_SEAL_VERSION,
  openMachineSeal,
  sealForHostMachine,
  sealingPublicKeyJwk,
} from "./machine-seal"

/**
 * The control plane's copy of this format is
 * `claxedo-server-core/src/platform/auth/machine-seal.ts`, and its test seals
 * the same plaintext for the same recipient with the same ephemeral key and IV
 * and asserts it produces exactly `SEALED` below. This test opens that literal.
 * Nothing but a fixed ciphertext can pin an ECIES format across two
 * implementations, and a drift on either side fails here or there.
 */
const RECIPIENT_PUBLIC =
  '{"crv":"P-256","ext":true,"key_ops":[],"kty":"EC","x":"yvfG-RnxA0zy6NThVgGjtkG-EDuxyzg6XaucwBBsxPo","y":"0wgNIB6PTjxf3_LKFkNusgqYtsXGr9dfvfVYZiwB-kg"}'
const RECIPIENT_PRIVATE: JsonWebKey = {
  crv: "P-256",
  d: "2PWXDsoh4LM9pF76TFo61wpCMYw7qab2SJYu-6zmvMQ",
  ext: true,
  key_ops: ["deriveBits"],
  kty: "EC",
  x: "yvfG-RnxA0zy6NThVgGjtkG-EDuxyzg6XaucwBBsxPo",
  y: "0wgNIB6PTjxf3_LKFkNusgqYtsXGr9dfvfVYZiwB-kg",
}
const VECTOR_AAD = hostMachineSealAad({ enrollmentId: "enr_vector", revision: 7 })
const VECTOR_PLAINTEXT =
  '{"providers":{"openai":{"baseUrl":"https://api.openai.com","placeholder":"sk-vector","authMode":"bearer","apiPath":"/v1"}}}'
const SEALED =
  "mseal1.BCqDhKwz80tQbwHr4Nwg9kAIZ5mY9IxZbRxnER1J8oQel96g7zHP_A2ZtOIywOFg4E2gSGnXdwxfuZyAdJ5B1Zs.AQIDBAUGBwgJCgsM.w4jzlZKp5qO8CJC2cr6RNDvfZgJUSorAYOFKidzEhWEFPc4nZW1_TwEm5ywotb07NFA9Ns4IYKoDwJ8qWzsX1zeb2zrjFUFr9rJ4nDI0x9JLOTzZTR2FT7iaf4OXKVSJSe1jWIrNdmiNgVuWL_GHXT9MtLtl0P0IiSSoVAwnBGIiIMH1o4jpKKV1Og"

describe("the format both sides implement", () => {
  test("opens the control plane's committed ciphertext", async () => {
    expect(await openMachineSeal(RECIPIENT_PRIVATE, SEALED, VECTOR_AAD)).toBe(VECTOR_PLAINTEXT)
  })

  test("the recipient the control plane sealed for is this private key's own public half", () => {
    const { d: _private, ext: _ext, key_ops: _ops, ...publicHalf } = RECIPIENT_PRIVATE
    expect(sealingPublicKeyJwk(publicHalf)).toEqual(sealingPublicKeyJwk(RECIPIENT_PUBLIC))
  })

  test("the literals the control plane's copy pins to the same values", () => {
    expect(MACHINE_SEAL_VERSION).toBe("mseal1")
    expect(MACHINE_SEAL_DOMAIN).toBe("claxedo.machine-seal.v1")
    expect(VECTOR_AAD).toBe("claxedo.machine-seal.v1\nenr_vector\n7")
    expect(SEALED.split(".")[0]).toBe(MACHINE_SEAL_VERSION)
  })
})

describe("sealing to a machine", () => {
  test("a freshly minted pair round trips, and the public half is declarable as JSON", async () => {
    const pair = await createMachineSealingKeyPair()
    expect(sealingPublicKeyJwk(pair.publicKey)).toEqual({
      kty: "EC",
      crv: "P-256",
      x: expect.any(String),
      y: expect.any(String),
    })
    const aad = hostMachineSealAad({ enrollmentId: "enr_1", revision: 3 })
    const sealed = await sealForHostMachine(pair.publicKey, "the secret", aad)
    expect(await openMachineSeal(pair.privateKeyJwk, sealed, aad)).toBe("the secret")
  })

  test("two seals of one plaintext for one machine share no bytes but the version", async () => {
    const pair = await createMachineSealingKeyPair()
    const aad = hostMachineSealAad({ enrollmentId: "enr_1", revision: 1 })
    const first = await sealForHostMachine(pair.publicKey, "the secret", aad)
    const second = await sealForHostMachine(pair.publicKey, "the secret", aad)
    expect(first).not.toBe(second)
    expect(first.split(".")[1]).not.toBe(second.split(".")[1])
  })

  test("the ciphertext carries no plaintext", async () => {
    const pair = await createMachineSealingKeyPair()
    const sealed = await sealForHostMachine(pair.publicKey, "sk-live-not-in-the-blob", hostMachineSealAad({ enrollmentId: "e", revision: 1 }))
    expect(sealed).not.toContain("sk-live")
  })
})

describe("what a blob is bound to", () => {
  test("another machine's key does not open it", async () => {
    const mine = await createMachineSealingKeyPair()
    const theirs = await createMachineSealingKeyPair()
    const aad = hostMachineSealAad({ enrollmentId: "enr_1", revision: 1 })
    const sealed = await sealForHostMachine(mine.publicKey, "the secret", aad)
    await expect(openMachineSeal(theirs.privateKeyJwk, sealed, aad)).rejects.toThrow()
  })

  test("another enrollment id does not open it", async () => {
    const pair = await createMachineSealingKeyPair()
    const sealed = await sealForHostMachine(pair.publicKey, "the secret", hostMachineSealAad({ enrollmentId: "enr_1", revision: 1 }))
    await expect(
      openMachineSeal(pair.privateKeyJwk, sealed, hostMachineSealAad({ enrollmentId: "enr_2", revision: 1 })),
    ).rejects.toThrow()
  })

  test("a replay at an older revision does not open it", async () => {
    const pair = await createMachineSealingKeyPair()
    const sealed = await sealForHostMachine(pair.publicKey, "the secret", hostMachineSealAad({ enrollmentId: "enr_1", revision: 4 }))
    await expect(
      openMachineSeal(pair.privateKeyJwk, sealed, hostMachineSealAad({ enrollmentId: "enr_1", revision: 3 })),
    ).rejects.toThrow()
  })

  test("an edited ciphertext does not open it", async () => {
    const pair = await createMachineSealingKeyPair()
    const aad = hostMachineSealAad({ enrollmentId: "enr_1", revision: 1 })
    const sealed = await sealForHostMachine(pair.publicKey, "the secret", aad)
    const parts = sealed.split(".")
    // The first character's six bits are all ciphertext; the last one's may
    // be padding a decoder ignores, and "A" to "B" there changes nothing.
    const flipped = `${parts[3]?.startsWith("A") ? "B" : "A"}${parts[3]?.slice(1) ?? ""}`
    await expect(openMachineSeal(pair.privateKeyJwk, [parts[0], parts[1], parts[2], flipped].join("."), aad)).rejects.toThrow()
  })
})

describe("refusals", () => {
  test("a blob of another version names the version it wanted", async () => {
    const pair = await createMachineSealingKeyPair()
    await expect(openMachineSeal(pair.privateKeyJwk, "mseal2.a.b.c", "aad")).rejects.toThrow("mseal1")
  })

  test("a blob with the wrong number of parts is refused before any key work", async () => {
    const pair = await createMachineSealingKeyPair()
    await expect(openMachineSeal(pair.privateKeyJwk, "mseal1.a.b", "aad")).rejects.toThrow("mseal1")
  })

  test("a declared key that is not a P-256 EC JWK is refused with the reason", () => {
    expect(() => sealingPublicKeyJwk('{"kty":"OKP","crv":"X25519","x":"a"}')).toThrow("P-256")
    expect(() => sealingPublicKeyJwk('{"kty":"EC","crv":"P-384","x":"a","y":"b"}')).toThrow("P-256")
    expect(() => sealingPublicKeyJwk('"not an object"')).toThrow("JWK object")
  })
})
