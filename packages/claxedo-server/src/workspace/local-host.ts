import fs from "fs/promises"
import path from "path"
import { createPrivateKey, generateKeyPairSync, randomUUID, sign as signData, type JsonWebKey } from "node:crypto"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { txt } from "./route-support"
import { asRecord } from "@claxedo/server-core/platform/json/index"
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
    const id = txt(asRecord(existing)?.host_id)
    const publicKey = asRecord(asRecord(existing)?.public_key_jwk)
    const privateKey = asRecord(asRecord(existing)?.private_key_jwk)
    if (id && publicKey && privateKey) {
      return {
        hostId: id,
        publicKey: JSON.stringify(publicKey),
        // A JWK is a record of optional string/array members; `crypto.subtle`
        // checks the key material itself when it imports one.
        privateKey,
      }
    }
  } catch (err) {
    if (!asRecord(err) || asRecord(err)?.code !== "ENOENT") {
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

export function signHostPayload(identity: LocalHostIdentity, payload: string) {
  return signData("sha256", Buffer.from(payload), {
    key: createPrivateKey({ key: identity.privateKey, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
}
