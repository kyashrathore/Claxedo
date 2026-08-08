/**
 * The machine's signing identity.
 *
 * Remote access rests on one claim: "this machine is the one the owner
 * enrolled". A P-256 key pair is how the machine makes that claim, and the
 * private half never leaves it — the control plane stores only the public key
 * and verifies signatures.
 *
 * That is why this package exists at all. The desktop's ACCOUNT credential
 * lives in Electron main behind `safeStorage`; this key is a different secret
 * with a different lifetime, held by whatever process runs the connector — a
 * headless CLI on a server, or the desktop. Mixing the two would mean a machine
 * that cannot run unattended without an account token on disk.
 *
 * Web Crypto only, no Node built-ins: the connector must run under Node, Bun
 * and Electron, and `crypto.subtle` is the one implementation all three share.
 */

export type HostKeyPair = {
  /** JWK JSON. Sent to the control plane at enrollment; not a secret. */
  publicKey: string
  /** Signs enrollment and heartbeat payloads. Never transmitted. */
  sign: (payload: string) => Promise<string>
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const
const SIGN_PARAMS = { name: "ECDSA", hash: "SHA-256" } as const

function base64url(bytes: ArrayBuffer) {
  let value = ""
  for (const byte of new Uint8Array(bytes)) value += String.fromCharCode(byte)
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
  const { d: _private, key_ops: _ops, ext: _ext, ...publicJwk } = privateKeyJwk as Record<string, unknown>
  return {
    publicKey: JSON.stringify(publicJwk),
    sign: async (payload) =>
      base64url(await crypto.subtle.sign(SIGN_PARAMS, privateKey, new TextEncoder().encode(payload))),
  }
}

/**
 * Payload builders, matching the authority's verifiers exactly.
 *
 * Duplicated here rather than imported from the server: the connector runs on
 * the user's machine and must not depend on server code. The domain prefix and
 * field order are the contract, and both sides' tests assert the same literal
 * strings — a mismatch fails loudly at enrollment rather than silently
 * accepting the wrong thing.
 */
export function enrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

export function heartbeatPayload(input: { hostId: string; ttlMs?: number }) {
  return ["claxedo.host-enrollment.heartbeat.v1", `host_id=${input.hostId}`, `ttl_ms=${input.ttlMs ?? ""}`].join("\n")
}
