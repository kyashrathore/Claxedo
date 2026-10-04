/**
 * Envelope encryption for hosted credential secrets.
 *
 * `envelopeCipher` seals a secret for one storage slot and opens it again;
 * `encryptedSecretBackend` composes that cipher over a `SecretBackend` so the
 * inner store only ever holds ciphertext.
 *
 *   - Per-org subkeys: HKDF-SHA-256(KEK, salt = fixed domain string,
 *     info = "org:<orgId>") -> AES-256-GCM key. No single decryption context
 *     ever holds a position over multiple tenants' secrets, and "delete org"
 *     can become a key-destruction operation.
 *   - Key-id-prefixed ciphertext so KEK rotation is "add new KEK, new writes
 *     use it, reads accept any known key-id" instead of a migration event.
 *   - Web Crypto only (global `crypto.subtle`): this module runs inside the
 *     Cloudflare Worker bundle, where `node:crypto` is unavailable.
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
 * The GCM tag also covers `<key-id>:<credential-id>`, the slot the value was
 * sealed for, as AAD (not stored in the value; re-derived on read). For a
 * `SecretBackend` the credential id is the segment of the ref after its
 * `<scheme>:` prefix (`put` is given the raw `<id>`, `get` the full ref); a
 * row store passes the same id to `seal` and `open`. A blob moved to another
 * slot fails authentication even though it decrypts under the same per-org key.
 *
 * Reads fail closed: a stored value that is not a well-formed envelope, uses
 * an unknown key-id, or fails GCM authentication (tamper, wrong org
 * partition, wrong KEK, or a relocated slot) throws and is never returned as
 * a secret.
 *
 * KEK sourcing: `CLAXEDO_CREDENTIALS_KEK` is the active write key;
 * `CLAXEDO_CREDENTIALS_KEK_NEXT` is an optional second accepted decrypt key
 * used to stage a rotation, mirroring the
 * CLAXEDO_RUNTIME_ACCESS_TOKEN_*_NEXT_* signing-key convention. Both are
 * base64 (standard or url-safe) and must decode to at least 32 bytes
 * (generate with `openssl rand -base64 32`). A missing or malformed KEK
 * throws at construction time: without a KEK the hosted credential store
 * refuses to exist.
 *
 * Rotation is a drain, not a swap: every value written before the rotation
 * stays readable only under the old KEK until it is re-sealed, so the old KEK
 * cannot leave configuration on the strength of "new writes use the new
 * key-id". `EnvelopeAdmin` exposes the key-id a stored value carries without
 * decrypting it, which is what lets `credentials/operations/rotate.ts` sweep
 * every ciphertext onto the current KEK and then answer the one question that
 * gates removing the old key: "is any ciphertext still under the retired
 * key-id?".
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

/**
 * Bytes this module owns.
 *
 * Web Crypto's `BufferSource` is an `ArrayBuffer`-backed view; a bare
 * `Uint8Array` may be backed by a `SharedArrayBuffer` and is not assignable to
 * it. Every buffer here is allocated locally (`new Uint8Array`, `subarray`,
 * `TextEncoder.encode`), so saying so in the type is what removes the
 * `as BufferSource` casts rather than papering over the difference.
 */
export type EnvelopeBytes = Uint8Array<ArrayBuffer>

/** Supplies KEK material to the envelope wrapper. */
export interface EnvelopeKeyProvider {
  /** The key new writes encrypt under. */
  current(): Promise<{ keyId: string; kek: EnvelopeBytes }>
  /** KEK bytes for a key-id found in stored ciphertext; undefined if unknown. */
  lookup(keyId: string): Promise<EnvelopeBytes | undefined>
}

/** What a storage slot currently holds, established without decrypting it. */
export type StoredEnvelopeState =
  /** Nothing stored at this ref. */
  | { state: "absent" }
  /** A well-formed `cenc1` envelope carrying this key-id. */
  | { state: "envelope"; keyId: string }
  /**
   * Something is stored but it is not a `cenc1` envelope — legacy plaintext, a
   * foreign format, or corruption. Reads of this slot already fail closed;
   * rotation reports it loudly rather than skipping past it.
   */
  | { state: "foreign" }

/**
 * The rotation surface an envelope-wrapped backend exposes.
 *
 * Deliberately minimal: it reveals the KEY-ID a slot was written under (public
 * metadata that is already the ciphertext's plaintext prefix) and nothing else.
 * It does not expose the raw byte store, the ciphertext, or the KEK, so it
 * cannot be used to reopen the "reach the bytes unencrypted" hole this
 * module closes: `credentials/operations/rotate.ts` re-encrypts through the ordinary
 * `get`/`put` pair, which never lets plaintext touch the inner store.
 */
export interface EnvelopeAdmin {
  /** The key-id new writes encrypt under. */
  currentKeyId(): Promise<string>
  /** What `ref` holds, without decrypting or authenticating it. */
  inspect(ref: string): Promise<StoredEnvelopeState>
}

/**
 * Take a private, `ArrayBuffer`-backed copy of caller key material.
 *
 * A caller's `Uint8Array` may be backed by a `SharedArrayBuffer`, which Web
 * Crypto will not accept, and a caller that keeps its array can mutate bytes
 * this module has already derived a key-id from. One 32-byte copy at the entry
 * point settles both.
 */
function adoptBytes(bytes: Uint8Array): EnvelopeBytes {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  return copy
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function fromBase64(value: string): EnvelopeBytes {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

/** First 8 bytes of SHA-256(kek), lowercase hex — the envelope key-id. */
export async function envelopeKeyId(kek: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", adoptBytes(kek))
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
export function createStaticKeyProvider(input: {
  current: Uint8Array
  previous?: Uint8Array[]
}): EnvelopeKeyProvider {
  assertKekBytes(input.current, "envelope KEK (current)")
  for (const kek of input.previous ?? []) assertKekBytes(kek, "envelope KEK (previous)")

  const current = adoptBytes(input.current)
  const all = [current, ...(input.previous ?? []).map(adoptBytes)]
  let table: Promise<Map<string, EnvelopeBytes>> | undefined
  let currentId: Promise<string> | undefined

  function ids(): Promise<Map<string, EnvelopeBytes>> {
    if (!table) {
      table = (async () => {
        const map = new Map<string, EnvelopeBytes>()
        for (const kek of all) map.set(await envelopeKeyId(kek), kek)
        return map
      })()
    }
    return table
  }

  return {
    async current() {
      if (!currentId) currentId = envelopeKeyId(current)
      return { keyId: await currentId, kek: current }
    },
    async lookup(keyId) {
      return (await ids()).get(keyId)
    },
  }
}

function decodeKekEnv(raw: string | undefined, name: string): EnvelopeBytes | undefined {
  const value = raw?.trim()
  if (!value) return undefined
  let bytes: EnvelopeBytes
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
 * KEK provider from env / Worker secrets. Fails closed: throws when
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

/**
 * The credential id a backend ref points at: the segment after the `<scheme>:`
 * prefix all `SecretBackend`s use (`cf:<id>`, `local:<id>`, `test:<id>`,
 * `mem:<id>`). `put` binds AAD to the raw `<id>` it is handed; `get` re-derives
 * the same id by stripping the scheme, so the two match for the rightful slot
 * and diverge (→ auth failure) if a blob is relocated to another slot.
 */
export function credentialIdFromRef(ref: string): string {
  const colon = ref.indexOf(":")
  return colon >= 0 ? ref.slice(colon + 1) : ref
}

/** GCM AAD binding a ciphertext to its key-id + credential (storage) id. */
function credentialAad(keyId: string, credentialId: string): EnvelopeBytes {
  return encoder.encode(`${keyId}:${credentialId}`)
}

type ParsedEnvelope = { keyId: string; iv: EnvelopeBytes; ciphertext: EnvelopeBytes }

const ENVELOPE_RE = new RegExp(`^${FORMAT_TAG}:([0-9a-f]{${KEY_ID_HEX_LEN}}):([A-Za-z0-9+/=_-]+)$`)

function parseEnvelope(stored: string): ParsedEnvelope {
  const match = ENVELOPE_RE.exec(stored)
  if (!match) {
    throw new Error(
      "stored credential value is not a recognized encryption envelope — refusing to return it (plaintext or foreign-format values are never served)",
    )
  }
  let packed: EnvelopeBytes
  try {
    packed = fromBase64(match[2])
  } catch {
    throw new Error("credential envelope payload is not valid base64 — refusing to return it")
  }
  // 12-byte IV + 16-byte GCM tag minimum (empty plaintext).
  if (packed.length < IV_LEN + 16) {
    throw new Error("credential envelope payload is truncated — refusing to return it")
  }
  return { keyId: match[1], iv: packed.subarray(0, IV_LEN), ciphertext: packed.subarray(IV_LEN) }
}

/**
 * The key-id a stored value carries, or undefined when the value is not a
 * well-formed envelope. Non-throwing on purpose: rotation must be able to
 * classify every slot (including foreign/corrupt ones) before deciding what to
 * do with it, where `parseEnvelope`'s fail-closed throw is the read path's job.
 */
export function envelopeKeyIdOf(stored: string): string | undefined {
  return ENVELOPE_RE.exec(stored)?.[1]
}

/** Seals and opens envelopes for one org partition. */
export interface EnvelopeCipher {
  /** The `cenc1` envelope of `plaintext`, bound to `credentialId`, under the current KEK. */
  seal(credentialId: string, plaintext: string): Promise<string>
  /** The plaintext of `stored`, which must be an envelope sealed for `credentialId` under a known key-id. */
  open(credentialId: string, stored: string): Promise<string>
  /** The key-id new writes encrypt under. */
  currentKeyId(): Promise<string>
}

export function envelopeCipher(keys: EnvelopeKeyProvider, opts: { orgId: string }): EnvelopeCipher {
  const orgId = opts.orgId?.trim()
  if (!orgId) throw new Error("envelopeCipher requires a non-empty orgId partition")

  // keyId -> derived per-org AES key (orgId is fixed per cipher instance).
  const derived = new Map<string, Promise<CryptoKey>>()

  function orgKey(keyId: string, kek: EnvelopeBytes): Promise<CryptoKey> {
    const cached = derived.get(keyId)
    if (cached) return cached
    const pending = (async () => {
      const ikm = await crypto.subtle.importKey("raw", kek, "HKDF", false, ["deriveKey"])
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
    async seal(credentialId, plaintext) {
      const { keyId, kek } = await keys.current()
      const key = await orgKey(keyId, kek)
      const iv = crypto.getRandomValues(new Uint8Array(IV_LEN))
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: credentialAad(keyId, credentialId) },
          key,
          encoder.encode(plaintext),
        ),
      )
      const packed = new Uint8Array(iv.length + ciphertext.length)
      packed.set(iv, 0)
      packed.set(ciphertext, iv.length)
      return `${FORMAT_TAG}:${keyId}:${toBase64(packed)}`
    },

    async open(credentialId, stored) {
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
          {
            name: "AES-GCM",
            iv: parsed.iv,
            additionalData: credentialAad(parsed.keyId, credentialId),
          },
          key,
          parsed.ciphertext,
        )
      } catch {
        throw new Error(
          "credential envelope failed authentication — tampered ciphertext, wrong org partition, wrong KEK, or a relocated/rolled-back slot",
        )
      }
      return decoder.decode(plaintext)
    },

    async currentKeyId() {
      return (await keys.current()).keyId
    },
  }
}

/**
 * Wrap a `SecretBackend` so every value it stores is an AES-256-GCM envelope
 * under a per-org HKDF subkey. The inner backend only ever sees ciphertext.
 */
export function encryptedSecretBackend(
  inner: SecretBackend,
  keys: EnvelopeKeyProvider,
  opts: { orgId: string },
): SecretBackend & EnvelopeAdmin {
  const cipher = envelopeCipher(keys, opts)

  return {
    async put(id, secret) {
      return inner.put(id, await cipher.seal(id, secret))
    },

    async get(ref) {
      const stored = await inner.get(ref)
      if (stored === null) return null
      return cipher.open(credentialIdFromRef(ref), stored)
    },

    async delete(ref) {
      return inner.delete(ref)
    },

    async probe() {
      return inner.probe()
    },

    currentKeyId: () => cipher.currentKeyId(),

    async inspect(ref) {
      const stored = await inner.get(ref)
      if (stored === null) return { state: "absent" }
      const keyId = envelopeKeyIdOf(stored)
      return keyId ? { state: "envelope", keyId } : { state: "foreign" }
    },
  }
}
