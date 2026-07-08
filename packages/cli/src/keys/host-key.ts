import crypto from "node:crypto"
import path from "node:path"
import { config } from "../config"
import { readJsonFile, writePrivateJson } from "../json"

export type HostKey = {
  publicKey: string
  sign(payload: string): string
}

function hostKeyPath(hostId: string) {
  return path.join(config().stateDir, "hosts", `${hostId}.jwk`)
}

function base64url(bytes: Buffer) {
  return bytes.toString("base64url")
}

function publicJwk(input: crypto.JsonWebKey) {
  return {
    kty: input.kty,
    crv: input.crv,
    x: input.x,
    y: input.y,
  }
}

export async function loadHostKey(hostId: string): Promise<HostKey> {
  const pathname = hostKeyPath(hostId)
  const existing = (await readJsonFile(pathname)) as crypto.JsonWebKey | undefined
  const jwk =
    existing ??
    (() => {
      const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      return pair.privateKey.export({ format: "jwk" })
    })()
  if (!existing) await writePrivateJson(pathname, jwk)
  const privateKey = crypto.createPrivateKey({ key: jwk, format: "jwk" })
  return {
    publicKey: JSON.stringify(publicJwk(crypto.createPublicKey(privateKey).export({ format: "jwk" }))),
    sign(payload: string) {
      return base64url(
        crypto.sign("sha256", Buffer.from(payload), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        }),
      )
    },
  }
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

export function heartbeatPayload(input: { workspaceId: string; hostId: string; ttlMs?: number }) {
  return [
    "claxedo.local-host-link.heartbeat.v1",
    `workspace_id=${input.workspaceId}`,
    `host_id=${input.hostId}`,
    `ttl_ms=${input.ttlMs ?? ""}`,
  ].join("\n")
}
