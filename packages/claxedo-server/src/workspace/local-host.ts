import fs from "fs/promises"
import path from "path"
import { createPrivateKey, generateKeyPairSync, randomUUID, sign as signData, type JsonWebKey } from "node:crypto"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { rec, txt } from "./route-support"
const log = Log.create({ service: "workspace-local-host" })

export type LocalHostIdentity = {
  hostId: string
  publicKey: string
  privateKey: JsonWebKey
}

let identityPromise: Promise<LocalHostIdentity> | undefined

async function loadLocalHostIdentity(): Promise<LocalHostIdentity> {
  const file = path.join(dataDir(), "local-host-identity.json")
  try {
    const existing = JSON.parse(await fs.readFile(file, "utf8")) as unknown
    const id = txt(rec(existing)?.host_id)
    const publicKey = rec(existing)?.public_key_jwk
    const privateKey = rec(existing)?.private_key_jwk
    if (id && publicKey && privateKey) {
      return {
        hostId: id,
        publicKey: JSON.stringify(publicKey),
        privateKey: privateKey as JsonWebKey,
      }
    }
  } catch (err) {
    if (!rec(err) || rec(err)?.code !== "ENOENT") {
      log.warn("local host identity is invalid; replacing", { file })
    }
  }
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" })
  const record = {
    host_id: `host_${randomUUID()}`,
    public_key_jwk: pair.publicKey.export({ format: "jwk" }),
    private_key_jwk: pair.privateKey.export({ format: "jwk" }),
    created_at: Date.now(),
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  return {
    hostId: record.host_id,
    publicKey: JSON.stringify(record.public_key_jwk),
    privateKey: record.private_key_jwk,
  }
}

/** One process-wide identity load prevents concurrent first callers rotating the key. */
export function localHostIdentity(): Promise<LocalHostIdentity> {
  identityPromise ??= loadLocalHostIdentity()
  return identityPromise
}

/**
 * Machine-wide enrollment payload (v1). The literal mirrors the authority
 * adapters' `hostEnrollmentPayload` byte for byte — deliberately copied rather
 * than imported so the local host machinery never depends on an authority
 * adapter module.
 */
export function hostEnrollmentPayload(input: { hostId: string; requestId: string; nonce: string }) {
  return [
    "claxedo.host-enrollment.enroll.v1",
    `host_id=${input.hostId}`,
    `request_id=${input.requestId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

/**
 * Heartbeat v2: the machine's ONE signature per interval also covers the
 * workspaces it currently serves (sorted, comma-joined). The literal mirrors
 * the authority adapters' `hostEnrollmentHeartbeatPayloadV2` byte for byte.
 */
export function hostEnrollmentHeartbeatPayloadV2(input: {
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

export function signHostPayload(identity: LocalHostIdentity, payload: string) {
  return signData("sha256", Buffer.from(payload), {
    key: createPrivateKey({ key: identity.privateKey, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
}
