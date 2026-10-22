import { decodeMachineSeal } from "@claxedo/account-contract/machine"
import { machineSealContentKey } from "@claxedo/account-contract/machine-seal"

/** Opens what the control plane sealed for a machine, with that machine's ECDH private key, as the machine itself does. */
export async function openSeal(privateKey: CryptoKey, sealed: string, aad: string) {
  const parts = decodeMachineSeal(sealed)
  const bytes = (text: string) => new Uint8Array(Buffer.from(text, "base64url"))
  const ephemeralRaw = bytes(parts.ephemeral)
  const ephemeral = await crypto.subtle.importKey("raw", ephemeralRaw, { name: "ECDH", namedCurve: "P-256" }, false, [])
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: ephemeral }, privateKey, 256)
  const key = await machineSealContentKey(shared, ephemeralRaw, ["decrypt"])
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(parts.iv), additionalData: new TextEncoder().encode(aad) }, key, bytes(parts.ciphertext))
  return new TextDecoder().decode(plaintext)
}
