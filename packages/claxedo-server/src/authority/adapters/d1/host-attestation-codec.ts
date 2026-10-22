/**
 * How a host attestation is checked: the public key a machine presents, the
 * signature it makes with it, and the byte encodings both travel in —
 * base64url for nonces, fingerprints and signatures, SHA-256 hex for the key
 * fingerprint, and the low-S form of a P-256 signature the verifier admits.
 */

import { publicKeyFingerprint } from "@claxedo/account-contract/machine"
import { asRecord, parseJson } from "@claxedo/server-core/platform/json/index"
import { D1HostAccessAuthorityError } from "./host-access-errors"
import { requireText } from "./host-enrollment-records"

export function randomBase64Url(size: number) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)))
}

function base64Url(value: Uint8Array) {
  let text = ""
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")
}

export function base64UrlBytes(input: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host signature encoding")
  }
  try {
    const normalized = input.replace(/-/g, "+").replace(/_/g, "/")
    const value = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="))
    return Uint8Array.from(value, (character) => character.charCodeAt(0))
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host signature encoding")
  }
}

export async function sha256(value: Uint8Array) {
  // A fresh copy rather than a view: `crypto.subtle.digest` takes a BufferSource,
  // and slicing the underlying buffer through `as ArrayBuffer` also asserted away
  // the SharedArrayBuffer case the DOM type admits.
  const result = await crypto.subtle.digest("SHA-256", Uint8Array.from(value))
  return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function canonicalP256Signature(value: Uint8Array) {
  if (value.byteLength !== 64) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid P-256 signature length")
  }
  const order = BigInt("0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551")
  const s = BigInt(`0x${hex(value.slice(32))}`)
  if (s === 0n || s >= order) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid P-256 signature scalar")
  }
  const canonicalS = s > order / 2n ? order - s : s
  const result = new Uint8Array(64)
  result.set(value.slice(0, 32), 0)
  const encodedS = canonicalS.toString(16).padStart(64, "0")
  for (let index = 0; index < 32; index += 1) {
    result[32 + index] = Number.parseInt(encodedS.slice(index * 2, index * 2 + 2), 16)
  }
  return result
}

function hex(value: Uint8Array) {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

export async function storedKeyFingerprint(publicKeyJson: string) {
  const jwk = storedJsonWebKey(publicKeyJson)
  if (!jwk) throw new D1HostAccessAuthorityError("resource_conflict", "Stored host public key is malformed")
  return await publicKeyFingerprint(jwk)
}

export async function verifiedPublicKey(input: string) {
  const value = requireText(input, "publicKey", 8_000)
  const jwk = storedJsonWebKey(value)
  if (!jwk) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host public key")
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.x !== "string" || typeof jwk.y !== "string" || jwk.d) {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Host public key must be a public P-256 JWK")
  }
  const normalized = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }
  try {
    await crypto.subtle.importKey("jwk", normalized, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  } catch {
    throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host public key")
  }
  // Stored as exactly these four members so the same key always serializes
  // to the same text, which is what the re-enroll upsert compares.
  return JSON.stringify(normalized)
}

export async function verifyHostSignature(input: { publicKey: string; payload: string; signature: string }) {
  const jwk = storedJsonWebKey(input.publicKey)
  if (!jwk) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid stored host public key")
  const signatureBytes = base64UrlBytes(requireText(input.signature, "signature", 2_000))
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"])
  if (!await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    signatureBytes,
    new TextEncoder().encode(input.payload),
  )) throw new D1HostAccessAuthorityError("host_attestation_denied", "Invalid host attestation")
  return await sha256(canonicalP256Signature(signatureBytes))
}

/** A stored JWK, read as the record it is; the caller checks the key material itself. */
function storedJsonWebKey(raw: string): JsonWebKey | undefined {
  try {
    return asRecord(parseJson(raw))
  } catch {
    return undefined
  }
}
