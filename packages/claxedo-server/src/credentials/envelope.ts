/**
 * Envelope encryption above the `SecretBackend` seam (launch-plan D10, I-5).
 *
 * The Cloudflare KV byte store (and any future hosted byte store) holds
 * OPAQUE CIPHERTEXT ONLY. This module supplies the mandatory wrapper that
 * turns any `SecretBackend` into an encrypting one:
 *
 *   - Per-org subkeys: HKDF-SHA-256(KEK, salt = fixed domain string,
 *     info = "org:<orgId>") -> AES-256-GCM key. No single decryption context
 *     ever holds a position over multiple tenants' secrets, and "delete org"
 *     can become a key-destruction operation.
 *   - Key-id-prefixed ciphertext so KEK rotation is "add new KEK, new writes
 *     use it, reads accept any known key-id" instead of a migration event.
 *   - Web Crypto ONLY (global `crypto.subtle`) — this module must run inside
 *     the Cloudflare Worker bundle; `node:crypto` is forbidden there
 *     (enforced by src/worker.import-graph.test.ts).
 *
 * Stored value layout (string, versioned):
 *
 *   cenc1:<key-id>:<base64(iv || ciphertext || gcm-tag)>
 *
 *   - "cenc1"   fixed format tag (credential-envelope v1)
 *   - key-id    16 lowercase hex chars = first 8 bytes of SHA-256(KEK bytes)
 *   - iv        12 random bytes
 *   - tag       16 bytes, appended to the ciphertext by AES-GCM
 *
 * Reads FAIL CLOSED: a stored value that is not a well-formed envelope, uses
 * an unknown key-id, or fails GCM authentication (tamper, wrong org
 * partition, wrong KEK) throws — it is never returned as a secret.
 *
 * KEK sourcing (hosted): `CLAXEDO_CREDENTIALS_KEK` is the active write key;
 * `CLAXEDO_CREDENTIALS_KEK_NEXT` is an optional second accepted decrypt key
 * used to stage/drain a rotation, mirroring the
 * CLAXEDO_RUNTIME_ACCESS_TOKEN_*_NEXT_* signing-key convention. Both are
 * base64 (standard or url-safe) and must decode to at least 32 bytes
 * (generate with `openssl rand -base64 32`). A missing or malformed KEK
 * throws at construction time — absent KEK in a hosted context means the
 * credential store refuses to exist.
 */

import type { SecretBackend } from "./types"

const FORMAT_TAG = "cenc1"
const IV_LEN = 12
const MIN_KEK_BYTES = 32
const KEY_ID_HEX_LEN = 16
const HKDF_SALT = "claxedo-credential-envelope:v1"

export const CREDENTIALS_KEK_ENV = "CLAXEDO_CREDENTIALS_KEK"
export const CREDENTIALS_KEK_NEXT_ENV = "CLAXEDO_CREDENTIALS_KEK_NEXT"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

type EnvLike = Record<string, string | undefined>

/** Supplies KEK material to the envelope wrapper. */
export interface EnvelopeKeyProvider {
  /** The key new writes encrypt under. */
  current(): Promise<{ keyId: string; kek: Uint8Array }>
  /** KEK bytes for a key-id found in stored ciphertext; undefined if unknown. */
  lookup(keyId: string): Promise<Uint8Array | undefined>
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** First 8 bytes of SHA-256(kek), lowercase hex — the envelope key-id. */
export async function envelopeKeyId(kek: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", kek as BufferSource)
  let hex = ""
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex.slice(0, KEY_ID_HEX_LEN)
}

function assertKekBytes(kek: Uint8Array, label: string) {
  if (kek.length < MIN_KEK_BYTES) {
    throw new Error(`${label} must be at least ${MIN_KEK_BYTES} bytes of key material (got ${kek.length})`)
  }
}

/**
 * Static key provider: one current write key plus optional additional keys
 * accepted for decryption (rotation drain).
 */
export function createStaticKeyProvider(input: { current: Uint8Array; previous?: Uint8Array[] }): EnvelopeKeyProvider {
  assertKekBytes(input.current, "envelope KEK (current)")
  for (const kek of input.previous ?? []) assertKekBytes(kek, "envelope KEK (previous)")

  const all = [input.current, ...(input.previous ?? [])]
  let table: Promise<Map<string, Uint8Array>> | undefined
  let currentId: Promise<string> | undefined

  function ids(): Promise<Map<string, Uint8Array>> {
    if (!table) {
      table = (async () => {
        const map = new Map<string, Uint8Array>()
        for (const kek of all) map.set(await envelopeKeyId(kek), kek)
        return map
      })()
    }
    return table
  }

  return {
    async current() {
      if (!currentId) currentId = envelopeKeyId(input.current)
      return { keyId: await currentId, kek: input.current }
    },
    async lookup(keyId) {
      return (await ids()).get(keyId)
    },
  }
}

function decodeKekEnv(raw: string | undefined, name: string): Uint8Array | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  let bytes: Uint8Array
  try {
    bytes = fromBase64(value)
  } catch {
    throw new Error(`${name} is not valid base64 — expected e.g. \`openssl rand -base64 32\` output`)
  }
  if (bytes.length < MIN_KEK_BYTES) {
    throw new Error(`${name} must decode to at least ${MIN_KEK_BYTES} bytes of key material (got ${bytes.length})`)
  }
  return bytes
}

/**
 * KEK provider from env / Worker secrets. FAILS CLOSED: throws when
 * `CLAXEDO_CREDENTIALS_KEK` is absent or malformed. `CLAXEDO_CREDENTIALS_KEK_NEXT`
 * is an optional second accepted decrypt key for rotation.
 */
export function envelopeKeyProviderFromEnv(env: EnvLike = process.env): EnvelopeKeyProvider {
  const current = decodeKekEnv(env[CREDENTIALS_KEK_ENV], CREDENTIALS_KEK_ENV)
  if (!current) {
    throw new Error(
      `${CREDENTIALS_KEK_ENV} is not configured — the hosted credential store refuses to operate without envelope encryption`,
    )
  }
  const next = decodeKekEnv(env[CREDENTIALS_KEK_NEXT_ENV], CREDENTIALS_KEK_NEXT_ENV)
  return createStaticKeyProvider({ current, previous: next ? [next] : [] })
}

type ParsedEnvelope = { keyId: string; iv: Uint8Array; ciphertext: Uint8Array }

const ENVELOPE_RE = new RegExp(`^${FORMAT_TAG}:([0-9a-f]{${KEY_ID_HEX_LEN}}):([A-Za-z0-9+/=_-]+)$`)

function parseEnvelope(stored: string): ParsedEnvelope {
  const match = ENVELOPE_RE.exec(stored)
  if (!match) {
    throw new Error(
      "stored credential value is not a recognized encryption envelope — refusing to return it (plaintext or foreign-format values are never served)",
    )
  }
  let packed: Uint8Array
  try {
    packed = fromBase64(match[2]!)
  } catch {
    throw new Error("credential envelope payload is not valid base64 — refusing to return it")
  }
  // 12-byte IV + 16-byte GCM tag minimum (empty plaintext).
  if (packed.length < IV_LEN + 16) {
    throw new Error("credential envelope payload is truncated — refusing to return it")
  }
  return { keyId: match[1]!, iv: packed.subarray(0, IV_LEN), ciphertext: packed.subarray(IV_LEN) }
}

/**
 * Wrap a `SecretBackend` so every value it stores is an AES-256-GCM envelope
 * under a per-org HKDF subkey. The inner backend only ever sees ciphertext.
 */
export function encryptedSecretBackend(
  inner: SecretBackend,
  keys: EnvelopeKeyProvider,
  opts: { orgId: string },
): SecretBackend {
  const orgId = opts.orgId?.trim()
  if (!orgId) throw new Error("encryptedSecretBackend requires a non-empty orgId partition")

  // keyId -> derived per-org AES key (orgId is fixed per wrapper instance).
  const derived = new Map<string, Promise<CryptoKey>>()

  function orgKey(keyId: string, kek: Uint8Array): Promise<CryptoKey> {
    const cached = derived.get(keyId)
    if (cached) return cached
    const pending = (async () => {
      const ikm = await crypto.subtle.importKey("raw", kek as BufferSource, "HKDF", false, ["deriveKey"])
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: encoder.encode(HKDF_SALT),
          info: encoder.encode(`org:${orgId}`),
        },
        ikm,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      )
    })()
    derived.set(keyId, pending)
    return pending
  }

  return {
    async put(id, secret) {
      const { keyId, kek } = await keys.current()
      const key = await orgKey(keyId, kek)
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(secret)),
      )
      const packed = new Uint8Array(iv.length + ciphertext.length)
      packed.set(iv, 0)
      packed.set(ciphertext, iv.length)
      return inner.put(id, `${FORMAT_TAG}:${keyId}:${toBase64(packed)}`)
    },

    async get(ref) {
      const stored = await inner.get(ref)
      if (stored === null) return null
      const parsed = parseEnvelope(stored)
      const kek = await keys.lookup(parsed.keyId)
      if (!kek) {
        throw new Error(
          `credential envelope was written under unknown key-id "${parsed.keyId}" — configure the matching KEK (rotation slot) before reading`,
        )
      }
      const key = await orgKey(parsed.keyId, kek)
      let plaintext: ArrayBuffer
      try {
        plaintext = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: parsed.iv as BufferSource },
          key,
          parsed.ciphertext as BufferSource,
        )
      } catch {
        throw new Error(
          "credential envelope failed authentication — tampered ciphertext, wrong org partition, or wrong KEK",
        )
      }
      return decoder.decode(plaintext)
    },

    async delete(ref) {
      return inner.delete(ref)
    },

    async probe() {
      return inner.probe()
    },
  }
}
