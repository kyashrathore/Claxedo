/**
 * The bytes a machine signs and the control plane verifies, as literal strings.
 *
 * The host side (`@claxedo/host-connector`) must not import server code, so it
 * carries its own copy of these builders; both copies are pinned by tests that
 * assert the same literal strings, and a drift fails at enrollment rather
 * than admitting the wrong thing. Pure builders and constants only — no I/O,
 * Web Crypto only, so the same file runs in the Worker.
 */

import { base64UrlDecode, base64UrlEncode } from "@claxedo/helpers/crypto"

export const MACHINE_REQUEST_DOMAIN = "claxedo.machine-request.v1"
export const INVITATION_REDEEM_DOMAIN = "claxedo.host-enrollment.redeem.v1"
export const INVITATION_TOKEN_PREFIX = "chx_inv_1"

export const MACHINE_REQUEST_HEADERS = {
  enrollmentId: "x-claxedo-enrollment-id",
  ts: "x-claxedo-host-ts",
  nonce: "x-claxedo-host-nonce",
  signature: "x-claxedo-host-signature",
} as const

/** |server now − x-claxedo-host-ts| above this is refused. */
export const MACHINE_REQUEST_SKEW_MS = 60_000
/** A consumed nonce stays refused for this long after its `ts`; it outlives the skew window on both sides. */
export const MACHINE_NONCE_TTL_MS = 120_000
export const MACHINE_NONCE_MIN_LENGTH = 16
export const MACHINE_NONCE_MAX_LENGTH = 64

const BASE64URL = /^[A-Za-z0-9_-]+$/

export function machineRequestPayload(input: {
  method: string
  pathname: string
  bodySha256Hex: string
  ts: number
  nonce: string
  enrollmentId: string
}) {
  return [
    MACHINE_REQUEST_DOMAIN,
    input.method.toUpperCase(),
    input.pathname,
    input.bodySha256Hex,
    String(input.ts),
    input.nonce,
    input.enrollmentId,
  ].join("\n")
}

export function invitationRedeemPayload(input: { invitationId: string; hostId: string; publicKeySha256: string }) {
  return [
    INVITATION_REDEEM_DOMAIN,
    `invitation_id=${input.invitationId}`,
    `host_id=${input.hostId}`,
    `public_key_sha256=${input.publicKeySha256}`,
  ].join("\n")
}

export function isMachineNonce(value: string) {
  return value.length >= MACHINE_NONCE_MIN_LENGTH && value.length <= MACHINE_NONCE_MAX_LENGTH && BASE64URL.test(value)
}

export function isBase64Url(value: string) {
  return value.length > 0 && BASE64URL.test(value)
}

/**
 * base64url(sha256(x || y)) over the DECODED coordinate bytes of a public
 * P-256 JWK. Keys are compared by this value, never by JSON text, because two
 * serializations of one key differ in field order and optional members.
 */
export async function publicKeyFingerprint(jwk: JsonWebKey) {
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("publicKeyFingerprint requires a P-256 JWK with x and y")
  }
  const x = base64UrlDecode(jwk.x, { error: (message) => new TypeError(`publicKeyFingerprint x: ${message}`) })
  const y = base64UrlDecode(jwk.y, { error: (message) => new TypeError(`publicKeyFingerprint y: ${message}`) })
  const material = new Uint8Array(x.length + y.length)
  material.set(x, 0)
  material.set(y, x.length)
  return base64UrlEncode(await crypto.subtle.digest("SHA-256", material))
}

export function invitationToken(input: { invitationId: string; secret: string }) {
  return `${INVITATION_TOKEN_PREFIX}.${input.invitationId}.${input.secret}`
}

/** Parses `chx_inv_1.<invitation_id>.<secret>`; both parts are base64url, so a dot can only be a separator. */
export function invitationTokenParts(token: string): { invitationId: string; secret: string } | undefined {
  const [prefix, invitationId, secret, ...rest] = token.split(".")
  if (rest.length > 0 || invitationId === undefined || secret === undefined) return undefined
  if (prefix !== INVITATION_TOKEN_PREFIX || !isBase64Url(invitationId) || !isBase64Url(secret)) return undefined
  return { invitationId, secret }
}
