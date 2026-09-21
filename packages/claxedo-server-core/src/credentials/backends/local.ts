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
import type { SecretBackend } from "../types"
import { isJsonRecord } from "@claxedo/server-core/platform/runtime/lib/json"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"

const ALGORITHM = "aes-256-gcm"
const IV_LEN = 12
const TAG_LEN = 16
const SEED_LEN = 32

/**
 * A filesystem error meaning the path is simply not there.
 *
 * `catch` binds `unknown`, and Node's errno errors carry `code` without a type
 * that says so. Testing the property is the check; asserting the shape only
 * assumed it.
 */
function isMissingFile(error: unknown): boolean {
  return isJsonRecord(error) && error.code === "ENOENT"
}

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
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  // `mkdirSync` applies its mode only to a directory it creates; a restored or
  // umask-widened one is narrowed on every open instead.
  const stat = fs.lstatSync(dir)
  if (!stat.isDirectory()) throw new Error(`Credential store at ${dir} is not a directory`)
  if (stat.mode & 0o077) fs.chmodSync(dir, 0o700)
}

function loadOrCreateSeed(): Buffer {
  ensureDir()
  const sp = seedPath()
  const existing = fs.lstatSync(sp, { throwIfNoEntry: false })
  if (existing === undefined) {
    const seed = randomBytes(SEED_LEN)
    // `wx` makes a name that appeared since the lstat — a symlink included — a
    // failure rather than a write through to its target.
    fs.writeFileSync(sp, seed, { mode: 0o600, flag: "wx" })
    return seed
  }
  // A symlink answers its own type to lstat; refusing here is what keeps a
  // linked-in seed from being read or chmodded through to its target.
  if (!existing.isFile()) throw new Error(`Credential seed at ${sp} is not a regular file`)
  // O_NOFOLLOW covers the swap between lstat and open; the fstat and fchmod
  // below then act on the same file the read does.
  const fd = fs.openSync(sp, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size !== SEED_LEN) {
      throw new Error(`Credential seed at ${sp} is not a regular ${SEED_LEN}-byte file`)
    }
    if (stat.mode & 0o177) fs.fchmodSync(fd, 0o600)
    const seed = Buffer.alloc(SEED_LEN)
    fs.readSync(fd, seed, 0, SEED_LEN, 0)
    return seed
  } finally {
    fs.closeSync(fd)
  }
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
      try {
        const data = fs.readFileSync(secretPath(ref))
        return decrypt(getKey(), data)
      } catch (error) {
        if (isMissingFile(error)) return null
        throw error
      }
    },

    async delete(ref) {
      try {
        fs.unlinkSync(secretPath(ref))
      } catch (error) {
        if (isMissingFile(error)) return
        throw error
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
