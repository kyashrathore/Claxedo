import { describe, expect, test } from "vitest"
import {
  MACHINE_SEAL_DOMAIN,
  MACHINE_SEAL_VERSION,
  isMachineSealingPublicKey,
  machineSealAad,
  machineSealingPublicKey,
  sealForMachine,
} from "./machine-seal"

/**
 * This package has no opener, so a round trip cannot prove the format here.
 * The literal below is what `packages/claxedo-host-connector/src/machine-seal.test.ts`
 * opens with the matching recipient private key: a drift in either copy of
 * the format fails one of the two files.
 */
const RECIPIENT_PUBLIC_JWK =
  '{"crv":"P-256","ext":true,"key_ops":[],"kty":"EC","x":"yvfG-RnxA0zy6NThVgGjtkG-EDuxyzg6XaucwBBsxPo","y":"0wgNIB6PTjxf3_LKFkNusgqYtsXGr9dfvfVYZiwB-kg"}'

const EPHEMERAL_PRIVATE_JWK: JsonWebKey = {
  crv: "P-256",
  d: "588iwqD4GM7rkgs50oRZEXY49xZi1mr9VIfqG5mrTTs",
  ext: true,
  key_ops: ["deriveBits"],
  kty: "EC",
  x: "KoOErDPzS1BvAevg3CD2QAhnmZj0jFltHGcRHUnyhB4",
  y: "l96g7zHP_A2ZtOIywOFg4E2gSGnXdwxfuZyAdJ5B1Zs",
}

const IV = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

const AAD = "claxedo.machine-seal.v1\nenr_vector\n7"

const PLAINTEXT =
  '{"providers":{"openai":{"baseUrl":"https://api.openai.com","placeholder":"sk-vector","authMode":"bearer","apiPath":"/v1"}}}'

const SEALED =
  "mseal1.BCqDhKwz80tQbwHr4Nwg9kAIZ5mY9IxZbRxnER1J8oQel96g7zHP_A2ZtOIywOFg4E2gSGnXdwxfuZyAdJ5B1Zs.AQIDBAUGBwgJCgsM.w4jzlZKp5qO8CJC2cr6RNDvfZgJUSorAYOFKidzEhWEFPc4nZW1_TwEm5ywotb07NFA9Ns4IYKoDwJ8qWzsX1zeb2zrjFUFr9rJ4nDI0x9JLOTzZTR2FT7iaf4OXKVSJSe1jWIrNdmiNgVuWL_GHXT9MtLtl0P0IiSSoVAwnBGIiIMH1o4jpKKV1Og"

const ECDH_P256 = { name: "ECDH", namedCurve: "P-256" } as const

async function fixedEphemeralKeyPair(): Promise<CryptoKeyPair> {
  const publicJwk: JsonWebKey = {
    kty: EPHEMERAL_PRIVATE_JWK.kty,
    crv: EPHEMERAL_PRIVATE_JWK.crv,
    x: EPHEMERAL_PRIVATE_JWK.x,
    y: EPHEMERAL_PRIVATE_JWK.y,
  }
  return {
    privateKey: await crypto.subtle.importKey("jwk", EPHEMERAL_PRIVATE_JWK, ECDH_P256, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("jwk", publicJwk, ECDH_P256, true, []),
  }
}

describe("machineSealAad", () => {
  test("is the domain, the enrollment and the revision, one per line", () => {
    expect(machineSealAad({ enrollmentId: "enr_vector", revision: 7 })).toBe(AAD)
    expect(AAD.startsWith(`${MACHINE_SEAL_DOMAIN}\n`)).toBe(true)
  })
})

describe("sealForMachine", () => {
  test("produces the committed ciphertext for the committed ephemeral key and iv", async () => {
    const fixed = { ephemeralKeyPair: await fixedEphemeralKeyPair(), iv: IV }

    expect(await sealForMachine(RECIPIENT_PUBLIC_JWK, PLAINTEXT, AAD, fixed)).toBe(SEALED)
    expect(await sealForMachine(JSON.parse(RECIPIENT_PUBLIC_JWK) as JsonWebKey, PLAINTEXT, AAD, fixed)).toBe(SEALED)
  })

  test("binds the blob to the AAD: the same key and iv under another revision seal differently", async () => {
    const fixed = { ephemeralKeyPair: await fixedEphemeralKeyPair(), iv: IV }
    const other = await sealForMachine(RECIPIENT_PUBLIC_JWK, PLAINTEXT, machineSealAad({ enrollmentId: "enr_vector", revision: 8 }), fixed)

    expect(other).not.toBe(SEALED)
    expect(other.split(".").slice(0, 3)).toEqual(SEALED.split(".").slice(0, 3))
  })

  test("without a fixed ephemeral key and iv, two seals of one plaintext never repeat", async () => {
    const first = await sealForMachine(RECIPIENT_PUBLIC_JWK, PLAINTEXT, AAD)
    const second = await sealForMachine(RECIPIENT_PUBLIC_JWK, PLAINTEXT, AAD)

    for (const sealed of [first, second]) {
      const parts = sealed.split(".")
      expect(parts).toHaveLength(4)
      expect(parts[0]).toBe(MACHINE_SEAL_VERSION)
      expect(sealed).not.toContain("sk-vector")
    }
    expect(first).not.toBe(second)
    expect(first.split(".")[1]).not.toBe(second.split(".")[1])
    expect(first.split(".")[2]).not.toBe(second.split(".")[2])
  })
})

describe("machineSealingPublicKey", () => {
  const p384 = JSON.stringify({
    kty: "EC",
    crv: "P-384",
    x: "yvfG-RnxA0zy6NThVgGjtkG-EDuxyzg6XaucwBBsxPo",
    y: "0wgNIB6PTjxf3_LKFkNusgqYtsXGr9dfvfVYZiwB-kg",
  })

  test("keeps exactly the four members the sealer imports", () => {
    expect(machineSealingPublicKey(RECIPIENT_PUBLIC_JWK)).toEqual({
      kty: "EC",
      crv: "P-256",
      x: "yvfG-RnxA0zy6NThVgGjtkG-EDuxyzg6XaucwBBsxPo",
      y: "0wgNIB6PTjxf3_LKFkNusgqYtsXGr9dfvfVYZiwB-kg",
    })
    expect(isMachineSealingPublicKey(RECIPIENT_PUBLIC_JWK)).toBe(true)
  })

  test("rejects a JWK that is not a P-256 EC key, and the predicate says so without throwing", () => {
    expect(() => machineSealingPublicKey(p384)).toThrow(TypeError)
    expect(() => machineSealingPublicKey({ kty: "RSA", n: "a", e: "AQAB" })).toThrow(TypeError)
    expect(() => machineSealingPublicKey('{"kty":"EC","crv":"P-256","x":"only"}')).toThrow(TypeError)
    expect(() => machineSealingPublicKey("[]")).toThrow(TypeError)
    expect(() => machineSealingPublicKey("not json")).toThrow(SyntaxError)

    expect(isMachineSealingPublicKey(p384)).toBe(false)
    expect(isMachineSealingPublicKey({ kty: "RSA", n: "a", e: "AQAB" })).toBe(false)
    expect(isMachineSealingPublicKey("not json")).toBe(false)
    expect(isMachineSealingPublicKey(undefined)).toBe(false)
  })

  test("refuses to seal for a key it cannot use", async () => {
    await expect(sealForMachine(p384, PLAINTEXT, AAD)).rejects.toThrow(TypeError)
  })
})

/**
 * The control plane's half of the format is sealing and nothing else. Its only
 * `deriveBits` is against a per-call ephemeral private key that is never
 * returned or stored, so once `sealForMachine` resolves there is nothing here
 * that can derive the content key again: not the recipient's private half,
 * which is only ever on the machine, and not the ephemeral half, which is
 * gone. An opener added to this module would quietly end that property, so
 * its absence is asserted rather than assumed.
 */
test("this package ships no way to open what it sealed", async () => {
  const module: Record<string, unknown> = await import("./machine-seal")
  expect(Object.keys(module).filter((name) => /open|decrypt|unseal/i.test(name))).toEqual([])
})
