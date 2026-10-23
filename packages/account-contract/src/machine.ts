import { base64UrlDecode, base64UrlEncode } from "@claxedo/helpers/crypto"

export const MACHINE_REQUEST_DOMAIN = "claxedo.machine-request.v1"
export const INVITATION_REDEEM_DOMAIN = "claxedo.host-enrollment.redeem.v1"
export const PAIRING_REDEEM_DOMAIN = "claxedo.host-pairing.redeem.v1"
export const INVITATION_TOKEN_PREFIX = "chx_inv_2"

/** How long a pairing code can be redeemed, and how long its machine then waits for the owner's answer. */
export const PAIRING_TTL_MS = 15 * 60_000
export const PAIRING_CODE_LENGTH = 20
/** Crockford's base32: no I, L, O or U, so a code read aloud or retyped survives. */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const PAIRING_CODE_PATTERN = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`)
/** The oldest `claxedo` that understands `connect --pair`; a connect script reuses an installed CLI only at or above it. */
export const MINIMUM_CONNECT_CLI_VERSION = "0.2.2"

/** Read as the connect script reads it: the first three numeric parts, so `0.2.2-beta.1` is `0.2.2`. */
function cliVersionParts(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** Whether a machine's reported `claxedo` is older than the one this control plane accepts; a version it cannot read is not. */
export function cliVersionBelowAccepted(version: string, accepted = MINIMUM_CONNECT_CLI_VERSION) {
  const reported = cliVersionParts(version)
  const minimum = cliVersionParts(accepted)
  if (!reported || !minimum) return false
  const difference = reported[0] - minimum[0] || reported[1] - minimum[1] || reported[2] - minimum[2]
  return difference < 0
}

/**
 * Why a machine that should serve cannot, as the machine itself saw it: its
 * Linux user manager is out of reach (lingering off, or no runtime dir or
 * manager answering), its Windows task waits for its user's next logon, the
 * desktop app's daemon already runs beside it, or it was told to stop.
 */
export const MACHINE_BLOCKED_REASONS = ["linger_off", "user_manager_unreachable", "waiting_for_logon", "desktop_daemon", "stopped"] as const

export type MachineBlockedReason = (typeof MACHINE_BLOCKED_REASONS)[number]

export function isMachineBlockedReason(value: unknown): value is MachineBlockedReason {
  return typeof value === "string" && (MACHINE_BLOCKED_REASONS as readonly string[]).includes(value)
}

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

/**
 * The code as the alphabet spells it, or undefined. Case, spaces and dashes
 * are what a person adds when retyping; `O`, `I` and `L` are what they mistake
 * for the digits Crockford maps them to.
 */
export function pairingCode(input: string): string | undefined {
  const code = input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1")
  return PAIRING_CODE_PATTERN.test(code) ? code : undefined
}

export function pairingRedeemPayload(input: { codeSha256: string; hostId: string; publicKeySha256: string }) {
  return [
    PAIRING_REDEEM_DOMAIN,
    `code_sha256=${input.codeSha256}`,
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

/**
 * Only the control plane that minted an invitation can redeem it, so its URL
 * travels inside the token; the plane a machine would otherwise default to
 * may be another one.
 */
export function invitationToken(input: { controlPlaneUrl: string; invitationId: string; secret: string }) {
  const plane = base64UrlEncode(new TextEncoder().encode(input.controlPlaneUrl))
  return `${INVITATION_TOKEN_PREFIX}.${plane}.${input.invitationId}.${input.secret}`
}

export function decodeInvitationToken(
  token: string,
): { controlPlaneUrl: string; invitationId: string; secret: string } | undefined {
  const [prefix, plane, invitationId, secret, ...rest] = token.split(".")
  if (rest.length > 0 || plane === undefined || invitationId === undefined || secret === undefined) return undefined
  if (prefix !== INVITATION_TOKEN_PREFIX || !isBase64Url(plane) || !isBase64Url(invitationId) || !isBase64Url(secret)) return undefined
  const controlPlaneUrl = new TextDecoder().decode(base64UrlDecode(plane))
  if (!URL.canParse(controlPlaneUrl)) return undefined
  const protocol = new URL(controlPlaneUrl).protocol
  return protocol === "https:" || protocol === "http:" ? { controlPlaneUrl, invitationId, secret } : undefined
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

/**
 * `key_ops` and `ext` are dropped rather than carried: one runtime exports an
 * ECDH public JWK with `key_ops: []` and another with none, and an importer
 * handed the wrong list refuses the key.
 */
export function publicKeyJwk(input: unknown): JsonWebKey & { kty: "EC"; crv: "P-256"; x: string; y: string } {
  const value: unknown = typeof input === "string" ? JSON.parse(input) : input
  if (typeof value !== "object" || value === null) throw new TypeError("public key is not a JWK object")
  const jwk: Record<string, unknown> = { ...value }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new TypeError("public key must be a P-256 EC JWK with x and y")
  }
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }
}
