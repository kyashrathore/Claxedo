/**
 * The machine's SEALING identity, and how it opens what the control plane
 * sealed for it.
 *
 * The enrollment key (`./host-identity`) is ECDSA P-256 and Web Crypto will
 * not derive bits with it: an ECDSA key pair is generated and imported with
 * `sign`/`verify` usages, and the private half is imported non-extractable, so
 * it can neither be used for ECDH nor re-exported as an ECDH key. A machine
 * that is to RECEIVE a secret therefore carries a second key pair — ECDH
 * P-256 — whose public half it declares on every beat and whose private half
 * never leaves it.
 *
 * The control plane holds the sealing half (`machine-seal.ts` in
 * `@claxedo/server-core`, pinned to the literals below by both packages'
 * tests) and only ever writes the output of it. After a seal there is no
 * plaintext at the control plane and no key there that opens one.
 *
 * Web Crypto only, no Node built-ins: this runs under Node, Bun and Electron's
 * utility process, and `crypto.subtle` is the one implementation all three
 * share.
 */

import { base64url, base64urlDecode } from "./host-identity"

export const MACHINE_SEAL_VERSION = "mseal1"
/** HKDF `info`, and the first line of the AAD; a blob sealed under another domain never opens. */
export const MACHINE_SEAL_DOMAIN = "claxedo.machine-seal.v1"
const SEALING_ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const
const IV_BYTES = 12
const SHARED_SECRET_BITS = 256

export type MachineSealingKeyPair = {
  /** JWK JSON of the ECDH public half. Declared to the control plane; not a secret. */
  publicKey: string
  privateKeyJwk: JsonWebKey
}

export async function createMachineSealingKeyPair(): Promise<MachineSealingKeyPair> {
  const pair = await crypto.subtle.generateKey(SEALING_ALGORITHM, true, ["deriveBits"])
  const [publicJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ])
  return { publicKey: JSON.stringify(publicJwk), privateKeyJwk }
}

/**
 * An ECDH P-256 public JWK from JSON text or a parsed object.
 *
 * `key_ops` and `ext` are dropped rather than carried: an ECDH public JWK
 * exported by one runtime states `key_ops: []` and another states nothing, and
 * an importer that is handed the wrong list refuses the key outright.
 */
export function sealingPublicKeyJwk(input: unknown): JsonWebKey {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input
  if (typeof value !== "object" || value === null) throw new Error("sealing key is not a JWK object")
  const jwk: Record<string, unknown> = { ...value }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("sealing key must be a P-256 EC JWK with x and y")
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
}

/**
 * What a sealed blob is bound to: one enrollment, at one revision. A
 * ciphertext lifted onto another machine's row, or re-labelled as a different
 * revision, fails the tag rather than decrypting. It does NOT refuse a replay
 * of the original pair — that blob really was sealed at that revision, so its
 * tag verifies; the machine's monotonic revision check in `connector.ts` is
 * what refuses a rollback to a rotated or withdrawn credential.
 */
export function hostMachineSealAad(input: { enrollmentId: string; revision: number }) {
  return [MACHINE_SEAL_DOMAIN, input.enrollmentId, String(input.revision)].join("\n")
}

function sealParts(sealed: string) {
  const parts = sealed.split(".")
  if (parts.length !== 4 || parts[0] !== MACHINE_SEAL_VERSION) {
    throw new Error(`sealed provider configuration is not ${MACHINE_SEAL_VERSION}`)
  }
  return { ephemeral: parts[1] ?? "", iv: parts[2] ?? "", ciphertext: parts[3] ?? "" }
}

async function hostSealContentKey(sharedSecret: ArrayBuffer, ephemeralPublicRaw: Uint8Array<ArrayBuffer>) {
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
    ["encrypt", "decrypt"],
  )
}

/**
 * Seal `plaintext` for a machine's declared sealing key.
 *
 * Production on this side never seals — the control plane does. This exists
 * for `./fake-control-plane.test-support`, which models the control plane for
 * every consumer's tests, and it is here rather than there so the format lives
 * beside the opener it must agree with.
 *
 * `ephemeralKeyPair` and `iv` exist so the two implementations of this format
 * can be pinned to one another by a literal ciphertext — nothing else can fix
 * the bytes an ECIES seal produces. Production passes neither and both are
 * fresh per call.
 */
export async function sealForHostMachine(
  publicKey: JsonWebKey | string,
  plaintext: string,
  aad: string,
  fixed?: { ephemeralKeyPair?: CryptoKeyPair; iv?: Uint8Array<ArrayBuffer> },
): Promise<string> {
  const recipient = await crypto.subtle.importKey("jwk", sealingPublicKeyJwk(publicKey), SEALING_ALGORITHM, false, [])
  const ephemeral = fixed?.ephemeralKeyPair ?? (await crypto.subtle.generateKey(SEALING_ALGORITHM, true, ["deriveBits"]))
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipient },
    ephemeral.privateKey,
    SHARED_SECRET_BITS,
  )
  const key = await hostSealContentKey(shared, ephemeralPublicRaw)
  const iv = fixed?.iv ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  )
  return [MACHINE_SEAL_VERSION, base64url(ephemeralPublicRaw), base64url(iv), base64url(ciphertext)].join(".")
}

/**
 * Open a blob sealed for this machine. Throws when the blob was sealed for
 * another key, another enrollment or another revision — the tag covers all
 * three — so a caller cannot mistake a foreign credential for its own.
 */
export async function openMachineSeal(privateKeyJwk: JsonWebKey, sealed: string, aad: string): Promise<string> {
  const parts = sealParts(sealed)
  // `key_ops`/`ext` from the exporting runtime would be compared against the
  // usages below and refuse the key; the five members are all ECDH needs.
  const { kty, crv, x, y, d } = privateKeyJwk
  const priv = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, SEALING_ALGORITHM, false, ["deriveBits"])
  const ephemeralPublicRaw = base64urlDecode(parts.ephemeral)
  const ephemeralPublic = await crypto.subtle.importKey("raw", ephemeralPublicRaw, SEALING_ALGORITHM, false, [])
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublic }, priv, SHARED_SECRET_BITS)
  const key = await hostSealContentKey(shared, ephemeralPublicRaw)
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(parts.iv), additionalData: new TextEncoder().encode(aad) },
    key,
    base64urlDecode(parts.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
