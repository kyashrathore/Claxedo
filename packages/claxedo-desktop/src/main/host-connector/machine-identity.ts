/**
 * This machine's remote-access identity: an id, and the key that proves it.
 *
 * Remote access rests on one claim — "this machine is the one the owner
 * enrolled" — and that claim is only worth anything if the private half of the
 * P-256 pair in `@claxedo/host-connector/host-identity` is genuinely private.
 * So this module answers two questions and nothing else: what is this machine
 * called, and where does its key live.
 *
 * ## Why the id is RANDOM and PERSISTED rather than derived
 *
 * The obvious implementation derives a host id from the machine — hostname,
 * MAC address, `/etc/machine-id`, a hardware serial. All of them are wrong
 * here, for two independent reasons:
 *
 *   1. **Two data dirs on one laptop must be two machines.** A second profile,
 *      a packaged build beside a dev build, a test fixture — each has its own
 *      `userData` directory and its own enrollment. Anything derived from the
 *      hardware gives all of them the same id, so they fight over one
 *      enrollment row and the last one to heartbeat wins. `machine-identity.test.ts`
 *      pins this with two independent stores.
 *   2. **A derived id is guessable, and it leaks.** A hostname or a MAC is
 *      public information on the user's network; sending it to the control
 *      plane hands over the laptop's network identity for no benefit, and an id
 *      an outsider can guess is one they can probe for or pre-claim. 256 bits
 *      from the CSPRNG is not guessable and says nothing about the machine.
 *
 * Persisted, therefore: the id must survive a restart or every launch enrolls a
 * new machine and the account fills with orphan rows.
 *
 * ## Why the id and the key share ONE encrypted record
 *
 * They have the same lifetime and are meaningless apart — an id with no key
 * cannot enroll, and a key with no id cannot say who it is for. Keeping them in
 * one record also makes an impersonation-shaped event impossible: a hostId that
 * outlives its key would re-enroll the SAME machine id presenting a DIFFERENT
 * public key, which is indistinguishable from an attacker taking over that id.
 * A rotated key gets a fresh id, and the control plane sees an honest new
 * machine.
 *
 * ## Why it goes through `safeStorage`, and refuses when that is a lie
 *
 * The same discipline `account/credential-store.ts` applies to the account
 * token, for a stronger reason. The account token expires; this key does not,
 * and it is the entire authorisation for reaching this laptop remotely. Linux's
 * `basic_text` backend is not encryption — it obfuscates with a key published
 * in Chromium's source — so a key stored under it is a laptop anyone with read
 * access to the home directory can impersonate, permanently. `secureStorageVerdict`
 * already encodes that policy, and it is reused rather than re-stated.
 */

import { createHostKeyPair, hostKeyPairFromJwk, type HostKeyPair } from "@claxedo/host-connector/host-identity"
import type { SafeStorageApi } from "../account/credential-store"
import { secureStorageVerdict } from "../account/secure-storage"

/** The record's home on disk. Injected so this is testable in a plain process. */
export type MachineIdentityFile = {
  read: () => string | undefined
  write: (contents: string) => void
  clear: () => void
}

/** What is inside the ciphertext. Never written unencrypted. */
type MachineIdentitySecret = { hostId: string; privateKeyJwk: JsonWebKey }

/**
 * What is on disk.
 *
 * The writing BACKEND is recorded for the same reason `credential-store.ts`
 * records it: without it, a record written under `basic_text` would be silently
 * promoted to trusted the moment a real keyring appeared, having spent its life
 * readable by any process running as the user.
 */
type MachineIdentityRecord = { ciphertext: string; backend: string }

export type MachineIdentity = { hostId: string; keys: HostKeyPair }

export type MachineIdentityResult =
  | { ok: true; identity: MachineIdentity; created: boolean }
  /**
   * No identity, rather than an identity stored in the clear.
   *
   * The caller turns this into "Remote Access is unavailable on this system",
   * which is a worse experience than enrolling and a much better one than a
   * permanently exfiltratable machine key.
   */
  | { ok: false; reason: "no-secure-storage"; detail: string }

/** 256 bits, base64url. Long enough that guessing is not a strategy. */
function newHostId() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return `host_${Buffer.from(bytes).toString("base64url")}`
}

function isJwk(value: unknown): value is JsonWebKey {
  return typeof value === "object" && value !== null && typeof (value as JsonWebKey).kty === "string"
}

export async function loadOrCreateMachineIdentity(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  platform: NodeJS.Platform
  onRejected?: (reason: string) => void
}): Promise<MachineIdentityResult> {
  const backend = input.safeStorage.getSelectedStorageBackend?.() ?? "unknown"
  const verdict = secureStorageVerdict({
    available: input.safeStorage.isEncryptionAvailable(),
    backend,
    platform: input.platform,
  })
  // Checked before reading as well as before writing: a machine whose keyring
  // disappeared must not keep using a key it can no longer protect, and must
  // certainly not mint a replacement.
  if (!verdict.usable) return { ok: false, reason: "no-secure-storage", detail: verdict.detail }

  const existing = readSecret({ ...input, backend })
  if (existing) {
    return { ok: true, identity: { hostId: existing.hostId, keys: await restore(existing.privateKeyJwk) }, created: false }
  }

  const created = await createHostKeyPair()
  const hostId = newHostId()
  const secret: MachineIdentitySecret = { hostId, privateKeyJwk: created.privateKeyJwk }
  const record: MachineIdentityRecord = {
    ciphertext: input.safeStorage.encryptString(JSON.stringify(secret)).toString("base64"),
    backend,
  }
  input.file.write(JSON.stringify(record))
  // Re-imported through the same path a restored identity takes: one code path
  // for signing, and the freshly generated extractable key does not escape into
  // the returned handle.
  return { ok: true, identity: { hostId, keys: await restore(created.privateKeyJwk) }, created: true }
}

function restore(privateKeyJwk: JsonWebKey) {
  return hostKeyPairFromJwk(privateKeyJwk)
}

/**
 * The stored secret, or nothing.
 *
 * Every rejection CLEARS the file. A record this process will never use again
 * is only a liability, and leaving it invites a future reader that skips one of
 * these checks.
 */
function readSecret(input: {
  safeStorage: SafeStorageApi
  file: MachineIdentityFile
  backend: string
  onRejected?: (reason: string) => void
}): MachineIdentitySecret | undefined {
  const contents = input.file.read()
  // Absent is the normal state before the first enrollment, not a rejection.
  if (!contents) return undefined

  const reject = (reason: string) => {
    input.onRejected?.(`stored machine identity unusable: ${reason}`)
    input.file.clear()
    return undefined
  }

  let record: MachineIdentityRecord
  try {
    record = JSON.parse(contents) as MachineIdentityRecord
  } catch {
    return reject("could not be parsed")
  }
  if (record?.backend !== input.backend) return reject("backend-changed")

  let secret: unknown
  try {
    secret = JSON.parse(input.safeStorage.decryptString(Buffer.from(record.ciphertext, "base64")))
  } catch {
    // Decryption failing on a MATCHING backend means the OS key changed under
    // us — same disposition as a backend change.
    return reject("could not be decrypted")
  }

  const candidate = secret as Partial<MachineIdentitySecret>
  if (typeof candidate?.hostId !== "string" || !candidate.hostId) return reject("has no host id")
  if (!isJwk(candidate.privateKeyJwk)) return reject("has no private key")
  return { hostId: candidate.hostId, privateKeyJwk: candidate.privateKeyJwk }
}
