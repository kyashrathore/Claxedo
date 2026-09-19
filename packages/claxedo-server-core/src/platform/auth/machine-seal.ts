/**
 * Sealing a secret for one enrolled machine.
 *
 * The control plane holds plaintext for exactly as long as one call to
 * `sealForMachine` takes; what it writes is the output, and it holds no key
 * that opens that. The machine holds the only opener (`machine-seal.ts` in
 * `@claxedo/host-connector`), which must not import server code — so, like the
 * machine-request payloads in `./host-connect-contract`, the format lives in
 * two copies and both packages' tests pin it to the same literal ciphertext.
 *
 * The recipient key is NOT the enrollment's signing key. That one is ECDSA
 * P-256 with `sign`/`verify` usages, which Web Crypto will not derive bits
 * with; a machine declares a separate ECDH P-256 public key on its beat, and a
 * machine that has declared none cannot be pushed to.
 *
 * Pure Web Crypto, no Node built-ins, so the same file runs in the Worker.
 */

import { base64UrlEncode } from "@claxedo/helpers/crypto"

export const MACHINE_SEAL_VERSION = "mseal1"
/** HKDF `info`, and the first line of the AAD; a blob sealed under another domain never opens. */
export const MACHINE_SEAL_DOMAIN = "claxedo.machine-seal.v1"
const SEALING_ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const
const IV_BYTES = 12
const SHARED_SECRET_BITS = 256

/**
 * What a sealed blob is bound to: one enrollment, at one revision. A
 * ciphertext lifted onto another machine's row, or re-labelled as a different
 * revision, fails the tag rather than decrypting. It does NOT refuse a replay
 * of the original pair — that blob really was sealed at that revision, so its
 * tag verifies; the machine's monotonic revision check in `connector.ts` is
 * what refuses a rollback to a rotated or withdrawn credential.
 */
export function machineSealAad(input: { enrollmentId: string; revision: number }) {
  return [MACHINE_SEAL_DOMAIN, input.enrollmentId, String(input.revision)].join("\n")
}

/**
 * An ECDH P-256 public JWK from JSON text or a parsed object; anything else
 * throws with the reason. `key_ops` and `ext` are dropped rather than carried:
 * the exporting runtime's list is compared against the importer's usages and
 * would refuse the key.
 */
export function machineSealingPublicKey(input: unknown): JsonWebKey {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input
  if (typeof value !== "object" || value === null) throw new TypeError("sealing key is not a JWK object")
  const jwk: Record<string, unknown> = { ...value }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("sealing key must be a P-256 EC JWK with x and y")
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
}

/** Whether a declared key is one this module can seal for, without throwing on the caller's behalf. */
export function isMachineSealingPublicKey(input: unknown): boolean {
  try {
    machineSealingPublicKey(input)
    return true
  } catch {
    return false
  }
}

async function machineSealContentKey(sharedSecret: ArrayBuffer, ephemeralPublicRaw: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveKey"])
  return await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      // The ephemeral public key as salt: every seal derives a different
      // content key even for one recipient and one plaintext.
      salt: ephemeralPublicRaw,
      info: new TextEncoder().encode(MACHINE_SEAL_DOMAIN),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  )
}

/**
 * `mseal1.<ephemeral public>.<iv>.<ciphertext||tag>`, each part base64url.
 *
 * `fixed` exists so the two implementations of this format can be pinned to
 * one another by a literal ciphertext — nothing else can fix the bytes an
 * ECIES seal produces. Production passes neither member and both are fresh
 * per call.
 */
export async function sealForMachine(
  publicKey: JsonWebKey | string,
  plaintext: string,
  aad: string,
  fixed?: { ephemeralKeyPair?: CryptoKeyPair; iv?: Uint8Array<ArrayBuffer> },
): Promise<string> {
  const recipient = await crypto.subtle.importKey("jwk", machineSealingPublicKey(publicKey), SEALING_ALGORITHM, false, [])
  const ephemeral = fixed?.ephemeralKeyPair ?? (await crypto.subtle.generateKey(SEALING_ALGORITHM, true, ["deriveBits"]))
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: recipient }, ephemeral.privateKey, SHARED_SECRET_BITS)
  const key = await machineSealContentKey(shared, ephemeralPublicRaw)
  const iv = fixed?.iv ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  )
  return [MACHINE_SEAL_VERSION, base64UrlEncode(ephemeralPublicRaw), base64UrlEncode(iv), base64UrlEncode(ciphertext)].join(".")
}
