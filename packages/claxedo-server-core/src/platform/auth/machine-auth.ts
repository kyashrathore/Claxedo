import { base64UrlDecode, sha256Hex } from "@claxedo/helpers/crypto"
import { isRecord } from "@claxedo/helpers/guards"
import type { MachineAuthAdapter, MachinePrincipal } from "./authority"
import {
  MACHINE_NONCE_TTL_MS,
  MACHINE_REQUEST_HEADERS,
  MACHINE_REQUEST_SKEW_MS,
  isBase64Url,
  isMachineNonce,
  machineRequestPayload,
} from "./host-connect-contract"

/**
 * Verifies a machine-signed request and returns the machine principal.
 *
 * Route-local by design: the heartbeat, acquire and checkpoint routes call it
 * themselves; it is not a member of `ControlPlaneAuthContext`, so no other
 * route can accept a machine as an owner-equivalent caller by accident.
 *
 * Nothing about the enrollment row is disclosed to a caller that has not
 * proven the key: an unknown id, a stored key that will not import and a
 * signature that does not verify are the one refusal
 * `machine_request_denied`. Only a verified signature earns the distinct
 * eligibility codes (revoked, paused, owner ineligible, key version
 * replaced) — the host exits on those, so they have to be true and specific.
 *
 * The verifier reads the enrollment once and returns what it read
 * (`keyVersion`, `generation`); the mutation re-asserts both inside its batch.
 * The refusals here are the cheap ones; the in-batch predicate is the
 * guarantee.
 */

export type MachineAuthDeps = MachineAuthAdapter & { now: () => number }

export type MachineRequest = {
  method: string
  /** Path only, no query: the signed bytes name the route, not its parameters. */
  pathname: string
  headers: { get: (name: string) => string | null }
  /** The exact body text the signature hashed; the route reads it once and passes it here. */
  bodyText: string
}

export type MachineAuthRefusal = {
  ok: false
  status: 400 | 401 | 403
  code:
    | "machine_headers_invalid"
    | "machine_body_invalid"
    | "machine_timestamp_skew"
    | "machine_request_denied"
    | "machine_nonce_replayed"
    | "enrollment_revoked"
    | "enrollment_paused"
    | "enrollment_owner_ineligible"
    | "enrollment_key_version_mismatch"
}

export type MachineAuthResult = { ok: true; machine: MachinePrincipal } | MachineAuthRefusal

const MAX_ENROLLMENT_ID_LENGTH = 200
const MAX_SIGNATURE_LENGTH = 200

export async function verifyMachineRequest(request: MachineRequest, deps: MachineAuthDeps): Promise<MachineAuthResult> {
  const headers = machineHeaders(request.headers)
  if (!headers) return machineRefusal(400, "machine_headers_invalid")
  const now = deps.now()
  if (Math.abs(now - headers.ts) > MACHINE_REQUEST_SKEW_MS) return machineRefusal(401, "machine_timestamp_skew")
  const body = bodyIdentity(request.bodyText)
  if (!body.ok) return machineRefusal(400, "machine_body_invalid")
  if (body.enrollmentId !== undefined && body.enrollmentId !== headers.enrollmentId) {
    return machineRefusal(400, "machine_body_invalid")
  }

  const row = await deps.lookupEnrollment(headers.enrollmentId)
  if (!row) return machineRefusal(401, "machine_request_denied")
  const key = await importVerifyKey(row.public_key_json)
  if (!key) return machineRefusal(401, "machine_request_denied")
  const payload = machineRequestPayload({
    method: request.method,
    pathname: request.pathname,
    bodySha256Hex: await sha256Hex(request.bodyText),
    ts: headers.ts,
    nonce: headers.nonce,
    enrollmentId: headers.enrollmentId,
  })
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    headers.signature,
    new TextEncoder().encode(payload),
  )
  if (!verified) return machineRefusal(401, "machine_request_denied")

  if (row.revoked_at !== null) return machineRefusal(403, "enrollment_revoked")
  if (row.paused_at !== null) return machineRefusal(403, "enrollment_paused")
  if (!row.ownerEligible) return machineRefusal(403, "enrollment_owner_ineligible")
  if (body.keyVersion !== undefined && body.keyVersion !== row.key_version) {
    return machineRefusal(403, "enrollment_key_version_mismatch")
  }
  if (body.hostId !== undefined && body.hostId !== row.host_id) return machineRefusal(400, "machine_body_invalid")

  const consumed = await deps.consumeNonce({
    enrollmentId: headers.enrollmentId,
    nonce: headers.nonce,
    expiresAt: headers.ts + MACHINE_NONCE_TTL_MS,
  })
  if (!consumed) return machineRefusal(401, "machine_nonce_replayed")

  return {
    ok: true,
    machine: {
      enrollmentId: row.enrollment_id,
      hostId: row.host_id,
      ownerUserId: row.owner_user_id,
      ownerActorId: row.owner_actor_id,
      scope: row.scope,
      keyVersion: row.key_version,
      generation: row.serving_generation,
    },
  }
}

function machineRefusal(status: MachineAuthRefusal["status"], code: MachineAuthRefusal["code"]): MachineAuthRefusal {
  return { ok: false, status, code }
}

function machineHeaders(headers: MachineRequest["headers"]) {
  const enrollmentId = headers.get(MACHINE_REQUEST_HEADERS.enrollmentId)?.trim() ?? ""
  const tsText = headers.get(MACHINE_REQUEST_HEADERS.ts)?.trim() ?? ""
  const nonce = headers.get(MACHINE_REQUEST_HEADERS.nonce)?.trim() ?? ""
  const signatureText = headers.get(MACHINE_REQUEST_HEADERS.signature)?.trim() ?? ""
  if (!enrollmentId || enrollmentId.length > MAX_ENROLLMENT_ID_LENGTH) return undefined
  if (!/^\d{1,16}$/.test(tsText)) return undefined
  if (!isMachineNonce(nonce)) return undefined
  if (!isBase64Url(signatureText) || signatureText.length > MAX_SIGNATURE_LENGTH) return undefined
  let signature: Uint8Array<ArrayBuffer>
  try {
    signature = new Uint8Array(base64UrlDecode(signatureText))
  } catch {
    return undefined
  }
  // ECDSA P-256 in IEEE P1363 form is r || s, 32 bytes each; Web Crypto
  // accepts no other encoding for this algorithm.
  if (signature.byteLength !== 64) return undefined
  return { enrollmentId, ts: Number(tsText), nonce, signature }
}

type BodyIdentity =
  | { ok: true; enrollmentId?: string; hostId?: string; keyVersion?: number }
  | { ok: false }

/**
 * The fields of the body that name the caller. They are optional at this
 * layer — the route's own schema demands what it needs — but when present
 * they must agree with the header and the row. `hostId` and `keyVersion` are
 * compared only after the signature verified: before that they would let an
 * unsigned caller probe the row.
 */
function bodyIdentity(bodyText: string): BodyIdentity {
  if (bodyText === "") return { ok: true }
  let value: unknown
  try {
    value = JSON.parse(bodyText)
  } catch {
    return { ok: false }
  }
  if (!isRecord(value)) return { ok: false }
  const { enrollmentId, hostId, keyVersion } = value
  if (enrollmentId !== undefined && typeof enrollmentId !== "string") return { ok: false }
  if (hostId !== undefined && typeof hostId !== "string") return { ok: false }
  if (keyVersion !== undefined && typeof keyVersion !== "number") return { ok: false }
  if (keyVersion !== undefined && !Number.isInteger(keyVersion)) return { ok: false }
  return { ok: true, enrollmentId, hostId, keyVersion }
}

async function importVerifyKey(publicKeyJson: string) {
  let jwk: unknown
  try {
    jwk = JSON.parse(publicKeyJson)
  } catch {
    return undefined
  }
  if (!isRecord(jwk)) return undefined
  const { kty, crv, x, y, d } = jwk
  if (kty !== "EC" || crv !== "P-256" || typeof x !== "string" || typeof y !== "string" || d !== undefined) {
    return undefined
  }
  try {
    return await crypto.subtle.importKey("jwk", { kty, crv, x, y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  } catch {
    return undefined
  }
}
