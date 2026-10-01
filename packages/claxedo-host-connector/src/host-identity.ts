import { machineRequestPayload } from "@claxedo/account-contract/machine"

export type HostKeyPair = {
  /** JWK JSON. Sent to the control plane at enrollment; not a secret. */
  publicKey: string
  /** Signs enrollment and heartbeat payloads. Never transmitted. */
  sign: (payload: string) => Promise<string>
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const

export function base64url(bytes: ArrayBuffer | Uint8Array) {
  let value = ""
  for (const byte of bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) value += String.fromCharCode(byte)
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export async function createHostKeyPair(): Promise<HostKeyPair & { privateKeyJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])
  const [publicJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey("jwk", pair.publicKey),
    crypto.subtle.exportKey("jwk", pair.privateKey),
  ])
  return {
    publicKey: JSON.stringify(publicJwk),
    privateKeyJwk,
    sign: async (payload) =>
      base64url(await crypto.subtle.sign(SIGN_PARAMS, pair.privateKey, new TextEncoder().encode(payload))),
  }
}

/**
 * Rebuild an identity from a stored private key.
 *
 * Imported as non-extractable, so a caller that later wants the JWK back has to
 * have kept it — this cannot become an accidental export path for the private
 * half.
 */
export async function hostKeyPairFromJwk(privateKeyJwk: JsonWebKey): Promise<HostKeyPair> {
  const privateKey = await crypto.subtle.importKey("jwk", privateKeyJwk, ALGORITHM, false, ["sign"])
  // The public half is derived from the private JWK's own coordinates rather
  // than stored separately: two fields that must agree and can be edited
  // independently will eventually disagree.
  const { d: _private, key_ops: _ops, ext: _ext, ...publicJwk } = privateKeyJwk
  return {
    publicKey: JSON.stringify(publicJwk),
    sign: async (payload) =>
      base64url(await crypto.subtle.sign(SIGN_PARAMS, privateKey, new TextEncoder().encode(payload))),
  }
}

export function base64urlDecode(text: string) {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

export async function hostSha256Hex(text: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * The bytes a machine-signed request is signed over. Every field is a
 * header or the body of the same request, so the verifier rebuilds this string
 * from what arrived and nothing else; a body edited in transit changes the
 * hash, a replayed header set is caught by the single-use nonce.
 */
export async function hostMachineRequestPayload(input: {
  method: string
  pathname: string
  bodyText: string
  ts: number
  nonce: string
  enrollmentId: string
}) {
  return machineRequestPayload({ ...input, bodySha256Hex: await hostSha256Hex(input.bodyText) })
}

export async function machineRequestSignature(
  keys: HostKeyPair,
  input: Parameters<typeof hostMachineRequestPayload>[0],
) {
  return await keys.sign(await hostMachineRequestPayload(input))
}

/** A request nonce: 32 random bytes, 43 base64url characters. */
export function randomNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

/** A host id is minted with its state file; a fresh state dir is a fresh host id by construction. */
export function newHostId() {
  return `host_${randomNonce()}`
}
