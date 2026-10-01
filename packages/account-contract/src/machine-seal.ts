import { MACHINE_SEAL_DOMAIN, encodeMachineSeal, publicKeyJwk } from "./machine"

const SEALING_ALGORITHM = { name: "ECDH", namedCurve: "P-256" } as const
const IV_BYTES = 12
const SHARED_SECRET_BITS = 256

export function isMachineSealingPublicKey(input: unknown): boolean {
  try {
    publicKeyJwk(input)
    return true
  } catch {
    return false
  }
}

export async function machineSealContentKey(
  sharedSecret: ArrayBuffer,
  ephemeralPublicRaw: Uint8Array<ArrayBuffer>,
  usages: KeyUsage[],
) {
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
    usages,
  )
}

/**
 * `mseal1.<ephemeral public>.<iv>.<ciphertext||tag>`, each part base64url.
 *
 * Fixed ephemeral keys and IVs pin ciphertext bytes in tests. Production
 * generates both per call.
 */
export async function sealForMachine(
  publicKey: JsonWebKey | string,
  plaintext: string,
  aad: string,
  fixed?: { ephemeralKeyPair?: CryptoKeyPair; iv?: Uint8Array<ArrayBuffer> },
): Promise<string> {
  const recipient = await crypto.subtle.importKey("jwk", publicKeyJwk(publicKey), SEALING_ALGORITHM, false, [])
  const ephemeral =
    fixed?.ephemeralKeyPair ?? (await crypto.subtle.generateKey(SEALING_ALGORITHM, true, ["deriveBits"]))
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey))
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: recipient },
    ephemeral.privateKey,
    SHARED_SECRET_BITS,
  )
  const key = await machineSealContentKey(shared, ephemeralPublicRaw, ["encrypt"])
  const iv = fixed?.iv ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(IV_BYTES)))
  const encoder = new TextEncoder()
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(plaintext),
  )
  return encodeMachineSeal({ ephemeral: ephemeralPublicRaw, iv, ciphertext })
}
