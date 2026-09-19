import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { asRecord } from "@claxedo/helpers/guards"

import type { SafeStorageApi } from "../account/credential-store"
import { secureStorageVerdict } from "../account/secure-storage"
import { readString } from "../../shared/json-read"
import {
  hostConnectorProviderConfig,
  isJsonWebKey,
  type HostConnectorBootstrapIdentity,
  type HostConnectorProviderConfig,
} from "./child-protocol"

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

/**
 * What the ciphertext holds: the identity, and beside it the latest
 * provider-configuration revision exactly as the control plane sealed it.
 * The blob is ciphertext under the machine's sealing key already; it sits
 * inside safeStorage as well because the revision number beside it is what
 * the machine declares as held, and a reader of the plain file must not be
 * able to move that.
 */
type MachineSecretRecord = HostConnectorBootstrapIdentity & { providerConfig?: HostConnectorProviderConfig }

export type HostConnectorIdentityStoreResult =
  | { ok: true; identity?: HostConnectorBootstrapIdentity; providerConfig?: HostConnectorProviderConfig }
  | { ok: false; reason: "no-secure-storage"; detail: string }

type StoreOutcome = { ok: true } | { ok: false; reason: "no-secure-storage"; detail: string }

/** A JWK with its private scalar; the public members alone can neither sign nor open. */
function isPrivateJwk(value: unknown): value is JsonWebKey {
  return isJsonWebKey(value) && typeof value.d === "string"
}

/** The stored record must carry the PRIVATE half, or it cannot sign a beat. */
function privateIdentity(value: unknown): HostConnectorBootstrapIdentity | undefined {
  const hostId = readString(value, "hostId")
  const input = asRecord(value)
  const privateKeyJwk = input?.privateKeyJwk
  if (!hostId || !isPrivateJwk(privateKeyJwk)) return undefined
  const sealingPrivateKeyJwk = input?.sealingPrivateKeyJwk
  if (sealingPrivateKeyJwk !== undefined && !isPrivateJwk(sealingPrivateKeyJwk)) return undefined
  return { hostId, privateKeyJwk, ...(sealingPrivateKeyJwk === undefined ? {} : { sealingPrivateKeyJwk }) }
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
  const recordValue = asRecord(parsed)
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
    const candidate = asRecord(secret)
    return reject(typeof candidate?.hostId === "string" ? "has no private key" : "has no host id")
  }
  const heldConfig = asRecord(secret)?.providerConfig
  const held = heldConfig === undefined ? undefined : hostConnectorProviderConfig(heldConfig)
  // An unreadable revision beside a readable identity drops the revision
  // alone: the control plane re-delivers it on the first beat.
  return { ok: true, identity, ...(held ? { providerConfig: held } : {}) }
}

function writeSecret(
  input: { safeStorage: SafeStorageApi; file: MachineIdentityFile; platform: NodeJS.Platform },
  secret: MachineSecretRecord,
): StoreOutcome {
  const { backend, verdict } = secureBackend(input)
  if (!verdict.usable) return { ok: false, reason: "no-secure-storage", detail: verdict.detail }
  const recordValue: MachineIdentityRecord = {
    ciphertext: input.safeStorage.encryptString(JSON.stringify(secret)).toString("base64"),
    backend,
  }
  input.file.write(JSON.stringify(recordValue))
  return { ok: true }
}

/** Persist the child-generated identity before allowing enrollment to begin. */
export function storeHostConnectorIdentity(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  platform: NodeJS.Platform
  identity: HostConnectorBootstrapIdentity
}): StoreOutcome {
  const identity = privateIdentity(input.identity)
  if (!identity) throw new Error("Host Connector child returned an invalid private identity")
  return writeSecret(input, identity)
}

/**
 * Add the sealing half to an identity stored without one. Any revision held
 * beside the old record was sealed for a key this machine no longer has, so
 * it does not survive; the control plane re-seals for the new key.
 */
export function storeHostConnectorSealingKey(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  platform: NodeJS.Platform
  sealingPrivateKeyJwk: JsonWebKey
}): StoreOutcome | { ok: false; reason: "no-identity"; detail: string } {
  if (!isPrivateJwk(input.sealingPrivateKeyJwk)) throw new Error("Host Connector child returned an invalid sealing key")
  const loaded = loadHostConnectorIdentity(input)
  if (!loaded.ok) return loaded
  if (!loaded.identity) return { ok: false, reason: "no-identity", detail: "no machine identity is stored to hold a sealing key" }
  return writeSecret(input, { ...loaded.identity, sealingPrivateKeyJwk: input.sealingPrivateKeyJwk })
}

/** Persist one delivered revision, ciphertext and all, beside the identity that can open it. */
export function storeHostProviderConfig(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  platform: NodeJS.Platform
  providerConfig: HostConnectorProviderConfig
}): StoreOutcome | { ok: false; reason: "no-identity"; detail: string } {
  const loaded = loadHostConnectorIdentity(input)
  if (!loaded.ok) return loaded
  if (!loaded.identity) {
    return { ok: false, reason: "no-identity", detail: "no machine identity is stored to hold a provider configuration" }
  }
  return writeSecret(input, { ...loaded.identity, providerConfig: input.providerConfig })
}
