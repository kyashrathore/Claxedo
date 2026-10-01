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

export function isBase64Url(value: string) {
  return value.length > 0 && BASE64URL.test(value)
}

/**
 * base64url(sha256(x || y)) over the DECODED coordinate bytes of a public
 * P-256 JWK. Keys are compared by this value, never by JSON text, because two
 * serializations of one key differ in field order and optional members.
 */
export async function publicKeyFingerprint(input: JsonWebKey | string) {
  const jwk = publicKeyJwk(input)
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

export function decodeInvitationToken(token: string): { invitationId: string; secret: string } | undefined {
  const [prefix, invitationId, secret, ...rest] = token.split(".")
  if (rest.length > 0 || invitationId === undefined || secret === undefined) return undefined
  if (prefix !== INVITATION_TOKEN_PREFIX || !isBase64Url(invitationId) || !isBase64Url(secret)) return undefined
  return { invitationId, secret }
}

export function enrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/** AAD rejects relabelling, not replay; the caller must enforce monotonic revisions. */
export function machineSealAad(input: { enrollmentId: string; revision: number }) {
  return [MACHINE_SEAL_DOMAIN, input.enrollmentId, String(input.revision)].join("\n")
}

export const MACHINE_SEAL_VERSION = "mseal1"
export const MACHINE_SEAL_DOMAIN = "claxedo.machine-seal.v1"

export function encodeMachineSeal(input: {
  ephemeral: Uint8Array
  iv: Uint8Array
  ciphertext: ArrayBuffer | Uint8Array
}) {
  return [
    MACHINE_SEAL_VERSION,
    base64UrlEncode(input.ephemeral),
    base64UrlEncode(input.iv),
    base64UrlEncode(input.ciphertext),
  ].join(".")
}

export function decodeMachineSeal(sealed: string) {
  const parts = sealed.split(".")
  if (parts.length !== 4 || parts[0] !== MACHINE_SEAL_VERSION) {
    throw new Error(`sealed provider configuration is not ${MACHINE_SEAL_VERSION}`)
  }
  return { ephemeral: parts[1] ?? "", iv: parts[2] ?? "", ciphertext: parts[3] ?? "" }
}

export function publicKeyJwk(input: unknown): JsonWebKey & { kty: "EC"; crv: "P-256"; x: string; y: string } {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input
  if (typeof value !== "object" || value === null) throw new TypeError("public key is not a JWK object")
  const jwk: Record<string, unknown> = { ...value }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("public key must be a P-256 EC JWK with x and y")
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
}
