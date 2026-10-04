import { machineSealContentKey } from "@claxedo/account-contract/machine-seal"
import { decodeMachineSeal } from "@claxedo/account-contract/machine"

import { base64urlDecode } from "./host-identity"

const SEALING_ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const
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
 * Open a blob sealed for this machine. Throws when the blob was sealed for
 * another key, another enrollment or another revision — the tag covers all
 * three — so a caller cannot mistake a foreign credential for its own.
 */
export async function openMachineSeal(privateKeyJwk: JsonWebKey, sealed: string, aad: string): Promise<string> {
  const parts = decodeMachineSeal(sealed)
  // `key_ops`/`ext` from the exporting runtime would be compared against the
  // usages below and refuse the key; the five members are all ECDH needs.
  const { kty, crv, x, y, d } = privateKeyJwk
  const priv = await crypto.subtle.importKey("jwk", { kty, crv, x, y, d }, SEALING_ALGORITHM, false, ["deriveBits"])
  const ephemeralPublicRaw = base64urlDecode(parts.ephemeral)
  const ephemeralPublic = await crypto.subtle.importKey("raw", ephemeralPublicRaw, SEALING_ALGORITHM, false, [])
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeralPublic }, priv, SHARED_SECRET_BITS)
  const key = await machineSealContentKey(shared, ephemeralPublicRaw, ["decrypt"])
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64urlDecode(parts.iv), additionalData: new TextEncoder().encode(aad) },
    key,
    base64urlDecode(parts.ciphertext),
  )
  return new TextDecoder().decode(plaintext)
}
