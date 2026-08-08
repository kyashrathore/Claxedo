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

export function registrationPayload(input: {
  workspaceId: string
  hostId: string
  challengeId: string
  nonce: string
}) {
  return [
    "claxedo.local-host-link.register.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `challenge_id=${input.challengeId}`,
    `nonce=${input.nonce}`,
  ].join("\n")
}

export function heartbeatPayload(input: {
  workspaceId: string
  hostId: string
  ttlMs?: number
}) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}

export function signHostPayload(identity: LocalHostIdentity, payload: string) {
  return signData("sha256", Buffer.from(payload), {
    key: createPrivateKey({ key: identity.privateKey, format: "jwk" }),
    dsaEncoding: "ieee-p1363",
  }).toString("base64url")
}
