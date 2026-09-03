import crypto from "node:crypto"
import path from "node:path"
import { config } from "../config"
import { object, readJsonFile, text, writePrivateJson } from "../json"

/**
 * The MACHINE's signing identity — one per installation, not one per project.
 *
 * That singularity is the whole shape of machine-wide remote access: the
 * control plane enrolls a laptop once, and which workspaces that laptop may
 * serve is the owner's assignment plus the machine's heartbeat-acked set,
 * decided per request. A key per directory would put the machine's identity
 * back inside a project, which is exactly what the retired per-workspace host
 * link did.
 */
export type MachineHostKey = {
  /** Stable for the life of the key file; what the control plane enrolls. */
  hostId: string
  /** JWK JSON. Sent at enrollment; not a secret. */
  publicKey: string
  /** Signs enrollment and heartbeat payloads. Never transmitted. */
  sign(payload: string): string
}

function machineKeyPath() {
  return path.join(config().stateDir, "machine-host.json")
}

function publicJwk(input: crypto.JsonWebKey) {
  return {
    kty: input.kty,
    crv: input.crv,
    x: input.x,
    y: input.y,
  }
}

function identity(hostId: string, jwk: crypto.JsonWebKey): MachineHostKey {
  const privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" })
  return {
    hostId,
    publicKey: JSON.stringify(publicJwk(crypto.createPublicKey(privateKey).export({ format: "jwk" }))),
    sign(payload: string) {
      return crypto
        .sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" })
        .toString("base64url")
    },
  }
}

/**
 * Load this machine's identity, minting it on first use.
 *
 * Id and key live in ONE file so they cannot drift apart: two fields that must
 * agree and can be edited independently eventually disagree, and a host id
 * paired with the wrong key fails at the authority as an attestation denial
 * with nothing pointing at the cause.
 */
export async function loadMachineHostKey(): Promise<MachineHostKey> {
  const pathname = machineKeyPath()
  const existing = object(await readJsonFile(pathname))
  const hostId = text(existing.host_id)
  const privateKeyJwk = existing.private_key_jwk as crypto.JsonWebKey | undefined
  if (hostId && privateKeyJwk) return identity(hostId, privateKeyJwk)

  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
  const jwk = pair.privateKey.export({ format: "jwk" })
  const minted = `host_${crypto.randomUUID()}`
  await writePrivateJson(pathname, {
    host_id: minted,
    private_key_jwk: jwk,
    created_at: Date.now(),
  })
  return identity(minted, jwk)
}

/**
 * Machine-enrollment payload (v1).
 *
 * Byte-identical to the authority's verifier
 * (`hostEnrollmentPayload` in claxedo-server's `workspace/local-host.ts` and
 * the D1/SQLite adapters). Copied rather than imported so the CLI
 * carries no server dependency; the literal IS the contract, and a drifting
 * copy fails loudly at the first enrollment rather than silently.
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
 * Heartbeat v2: ONE signature per interval covers the lease renewal AND the
 * workspaces this machine currently serves (sorted, comma-joined).
 *
 * Routing requires a workspace to be BOTH owner-assigned and inside this
 * signed set, so the set is the machine's consent — not a hint. Byte-identical
 * to `hostEnrollmentHeartbeatPayloadV2`.
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
