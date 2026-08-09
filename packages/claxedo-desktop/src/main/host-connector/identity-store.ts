import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import type { SafeStorageApi } from "../account/credential-store"
import { secureStorageVerdict } from "../account/secure-storage"
import type { HostConnectorBootstrapIdentity } from "./child-protocol"

export type MachineIdentityFile = {
  read(): string | undefined
  write(contents: string): void
  clear(): void
}

/** The one filesystem adapter for the encrypted per-profile identity record. */
export function machineIdentityFile(userDataDir: string): MachineIdentityFile {
  const path = join(userDataDir, "host-machine-identity.json")
  return {
    read: () => {
      try {
        return readFileSync(path, "utf8")
      } catch {
        return undefined
      }
    },
    write: (contents) => {
      mkdirSync(userDataDir, { recursive: true })
      writeFileSync(path, contents, { mode: 0o600 })
    },
    clear: () => rmSync(path, { force: true }),
  }
}

type MachineIdentityRecord = { ciphertext: string; backend: string }

export type HostConnectorIdentityStoreResult =
  | { ok: true; identity?: HostConnectorBootstrapIdentity }
  | { ok: false; reason: "no-secure-storage"; detail: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function privateIdentity(value: unknown): HostConnectorBootstrapIdentity | undefined {
  const input = record(value)
  const jwk = record(input?.privateKeyJwk)
  if (typeof input?.hostId !== "string" || !input.hostId || typeof jwk?.kty !== "string" || typeof jwk.d !== "string") {
    return
  }
  return { hostId: input.hostId, privateKeyJwk: input.privateKeyJwk as JsonWebKey }
}

function secureBackend(input: { safeStorage: SafeStorageApi; platform: NodeJS.Platform }) {
  const backend = input.safeStorage.getSelectedStorageBackend?.() ?? "unknown"
  const verdict = secureStorageVerdict({
    available: input.safeStorage.isEncryptionAvailable(),
    backend,
    platform: input.platform,
  })
  return { backend, verdict }
}

/** Read the encrypted bootstrap identity without importing connector code. */
export function loadHostConnectorIdentity(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  platform: NodeJS.Platform
  onRejected?: (reason: string) => void
}): HostConnectorIdentityStoreResult {
  const { backend, verdict } = secureBackend(input)
  if (!verdict.usable) return { ok: false, reason: "no-secure-storage", detail: verdict.detail }

  const contents = input.file.read()
  if (!contents) return { ok: true }

  const reject = (reason: string): HostConnectorIdentityStoreResult => {
    input.onRejected?.(`stored machine identity unusable: ${reason}`)
    input.file.clear()
    return { ok: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(contents)
  } catch {
    return reject("could not be parsed")
  }
  const recordValue = record(parsed)
  if (recordValue?.backend !== backend || typeof recordValue.ciphertext !== "string") {
    return reject(recordValue?.backend !== backend ? "backend-changed" : "has no ciphertext")
  }

  let secret: unknown
  try {
    secret = JSON.parse(input.safeStorage.decryptString(Buffer.from(recordValue.ciphertext, "base64")))
  } catch {
    return reject("could not be decrypted")
  }
  const identity = privateIdentity(secret)
  if (!identity) {
    const candidate = record(secret)
    return reject(typeof candidate?.hostId === "string" ? "has no private key" : "has no host id")
  }
  return { ok: true, identity }
}

/** Persist the child-generated identity before allowing enrollment to begin. */
export function storeHostConnectorIdentity(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  platform: NodeJS.Platform
  identity: HostConnectorBootstrapIdentity
}): Exclude<HostConnectorIdentityStoreResult, { ok: true; identity?: HostConnectorBootstrapIdentity }> | { ok: true } {
  const { backend, verdict } = secureBackend(input)
  if (!verdict.usable) return { ok: false, reason: "no-secure-storage", detail: verdict.detail }
  const identity = privateIdentity(input.identity)
  if (!identity) throw new Error("Host Connector child returned an invalid private identity")

  const recordValue: MachineIdentityRecord = {
    ciphertext: input.safeStorage.encryptString(JSON.stringify(identity)).toString("base64"),
    backend,
  }
  input.file.write(JSON.stringify(recordValue))
  return { ok: true }
}
