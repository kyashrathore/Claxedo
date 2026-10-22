/**
 * The byte encodings a host attestation travels in: base64url for nonces,
 * fingerprints and signatures, SHA-256 hex for the key fingerprint, and the
 * low-S form of a P-256 signature the verifier admits.
 */

import { D1HostAccessAuthorityError } from "./host-access-errors"

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
