/**
 * Local secret backend — stores secrets in an encrypted file on disk.
 *
 * Uses AES-256-GCM with a machine-local key derived from a random seed
 * persisted alongside the store. This is appropriate for desktop installs
 * where the user has physical access to the machine.
 */

import fs from "fs"
import path from "path"
import { randomBytes, createCipheriv, createDecipheriv, createHash } from "crypto"
import type { SecretBackend } from "./types"
import { dataDir } from "../paths"

const ALGORITHM = "aes-256-gcm"
const IV_LEN = 12
const TAG_LEN = 16

function storeDir() {
  return path.join(dataDir(), "credentials")
}

function seedPath() {
  return path.join(storeDir(), ".seed")
}

function secretPath(ref: string) {
  const hash = createHash("sha256").update(ref).digest("hex")
  return path.join(storeDir(), `${hash}.enc`)
}

function atomicWriteFileSync(file: string, data: Buffer, mode: number) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`)
  const fd = fs.openSync(tmp, "w", mode)
  try {
    fs.writeFileSync(fd, data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
  try {
    const dir = fs.openSync(path.dirname(file), "r")
    try {
      fs.fsyncSync(dir)
    } finally {
      fs.closeSync(dir)
    }
  } catch {
    // Directory fsync is not available on every platform/filesystem.
  }
}

function ensureDir() {
  const dir = storeDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

function loadOrCreateSeed(): Buffer {
  ensureDir()
  const sp = seedPath()
  if (fs.existsSync(sp)) {
    return fs.readFileSync(sp)
  }
  const seed = randomBytes(32)
  fs.writeFileSync(sp, seed, { mode: 0o600 })
  return seed
}

function deriveKey(seed: Buffer): Buffer {
  return createHash("sha256").update(seed).update("claxedo-credential-store").digest()
}

function encrypt(key: Buffer, plaintext: string): Buffer {
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted])
}

function decrypt(key: Buffer, data: Buffer): string {
  const iv = data.subarray(0, IV_LEN)
  const tag = data.subarray(IV_LEN, IV_LEN + TAG_LEN)
  const encrypted = data.subarray(IV_LEN + TAG_LEN)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted).toString("utf8") + decipher.final("utf8")
}

export function createLocalBackend(): SecretBackend {
  let key: Buffer | undefined

  function getKey() {
    if (!key) key = deriveKey(loadOrCreateSeed())
    return key
  }

  return {
    async put(id, secret) {
      ensureDir()
      const ref = `local:${id}`
      const encrypted = encrypt(getKey(), secret)
      atomicWriteFileSync(secretPath(ref), encrypted, 0o600)
      return ref
    },

    async get(ref) {
      const fp = secretPath(ref)
      if (!fs.existsSync(fp)) return null
      try {
        const data = fs.readFileSync(fp)
        return decrypt(getKey(), data)
      } catch {
        return null
      }
    },

    async delete(ref) {
      const fp = secretPath(ref)
      try {
        fs.unlinkSync(fp)
      } catch {
        // already gone
      }
    },

    async probe() {
      try {
        ensureDir()
        return true
      } catch {
        return false
      }
    },
  }
}
