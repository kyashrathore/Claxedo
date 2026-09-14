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

/**
 * Heartbeat v2: the machine's one signature per interval also covers the
 * workspaces it currently serves. The authority verifies this exact literal
 * (`hostEnrollmentHeartbeatPayloadV2` in host-access-authority.ts) — both
 * sides assert the same string, so drift fails loudly at the first beat.
 */
export function heartbeatPayloadV2(input: {
  hostId: string
  ttlMs?: number
  workspaceIds: readonly string[]
}) {
  return [
    "claxedo.host-enrollment.heartbeat.v2",
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
    `workspaces=${[...input.workspaceIds].sort().join(",")}`,
  ].join("\n")
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
 * The bytes a machine-signed request is signed over (P1.1). Every field is a
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
  return [
    "claxedo.machine-request.v1",
    input.method.toUpperCase(),
    input.pathname,
    await hostSha256Hex(input.bodyText),
    String(input.ts),
    input.nonce,
    input.enrollmentId,
  ].join("\n")
}

export async function machineRequestSignature(
  keys: HostKeyPair,
  input: Parameters<typeof hostMachineRequestPayload>[0],
) {
  return await keys.sign(await hostMachineRequestPayload(input))
}

/**
 * How the control plane identifies a public key: sha256 over the raw P-256
 * coordinates, base64url. Never the JWK text — two serializations of one key
 * (field order, `ext`, `key_ops`) must compare equal.
 */
export async function hostPublicKeyFingerprint(jwk: JsonWebKey | string) {
  const parsed: JsonWebKey = typeof jwk === "string" ? JSON.parse(jwk) : jwk
  if (parsed.kty !== "EC" || parsed.crv !== "P-256" || !parsed.x || !parsed.y) {
    throw new Error("public key fingerprint needs a P-256 EC JWK with x and y")
  }
  const x = base64urlDecode(parsed.x)
  const y = base64urlDecode(parsed.y)
  const joined = new Uint8Array(new ArrayBuffer(x.length + y.length))
  joined.set(x, 0)
  joined.set(y, x.length)
  return base64url(await crypto.subtle.digest("SHA-256", joined))
}

export function hostInvitationRedeemPayload(input: { invitationId: string; hostId: string; publicKeySha256: string }) {
  return [
    "claxedo.host-enrollment.redeem.v1",
    `invitation_id=${input.invitationId}`,
    `host_id=${input.hostId}`,
    `public_key_sha256=${input.publicKeySha256}`,
  ].join("\n")
}

export const INVITATION_TOKEN_PREFIX = "chx_inv_1"

export const MACHINE_REQUEST_HEADERS = {
  enrollmentId: "x-claxedo-enrollment-id",
  ts: "x-claxedo-host-ts",
  nonce: "x-claxedo-host-nonce",
  signature: "x-claxedo-host-signature",
} as const

const BASE64URL = /^[A-Za-z0-9_-]+$/

/**
 * `chx_inv_1.<invitation_id>.<secret>` — the id is a row key and not secret,
 * the secret is what the control plane hashes. Both parts are base64url, so a
 * dot can only be a separator and anything else is a malformed token.
 */
export function parseInvitationToken(token: string) {
  const parts = token.trim().split(".")
  if (parts.length !== 3 || parts[0] !== INVITATION_TOKEN_PREFIX) {
    throw new Error(`invitation token is not of the form ${INVITATION_TOKEN_PREFIX}.<invitation_id>.<secret>`)
  }
  const [, invitationId, secret] = parts as [string, string, string]
  if (!BASE64URL.test(invitationId) || !BASE64URL.test(secret)) {
    throw new Error("invitation token carries characters outside base64url")
  }
  return { invitationId, secret }
}

/** A request nonce: 32 random bytes, 43 base64url characters. */
export function randomNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

/** A host id is minted with its state file; a fresh state dir is a fresh host id by construction. */
export function newHostId() {
  return `host_${randomNonce()}`
}
