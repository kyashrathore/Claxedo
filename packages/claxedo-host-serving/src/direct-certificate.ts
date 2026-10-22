/**
 * The direct listener's TLS identity: a self-signed X.509 certificate over the
 * host's own P-256 key, DER-encoded here so the CLI install gains no
 * dependency. No client validates its chain, names or dates — a client pins
 * the key by `spkiSha256` — so the certificate carries only what a TLS stack
 * needs to present it.
 */

const ECDSA_P256 = { name: "ECDSA", namedCurve: "P-256" } as const
const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2"
const COMMON_NAME = "2.5.4.3"
const VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000

export type DirectTlsIdentity = {
  keyPem: string
  certPem: string
  /** SHA-256 over the DER SubjectPublicKeyInfo, base64url: what a client pins. */
  spkiSha256: string
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function lengthOctets(length: number): number[] {
  if (length < 0x80) return [length]
  const octets: number[] = []
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) octets.unshift(rest % 256)
  return [0x80 | octets.length, ...octets]
}

function tlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat([Uint8Array.of(tag, ...lengthOctets(content.length)), content])
}

const sequence = (...items: Uint8Array[]) => tlv(0x30, concat(items))

function integer(magnitude: Uint8Array): Uint8Array {
  let start = 0
  while (start < magnitude.length - 1 && magnitude[start] === 0) start++
  const trimmed = magnitude.subarray(start)
  return tlv(0x02, trimmed[0] & 0x80 ? concat([Uint8Array.of(0), trimmed]) : trimmed)
}

function objectIdentifier(dotted: string): Uint8Array {
  const [first, second, ...rest] = dotted.split(".").map(Number)
  const body: number[] = [first * 40 + second]
  for (const arc of rest) {
    const groups: number[] = [arc & 0x7f]
    for (let value = arc >>> 7; value > 0; value >>>= 7) groups.unshift((value & 0x7f) | 0x80)
    body.push(...groups)
  }
  return tlv(0x06, Uint8Array.from(body))
}

function utcTime(at: number): Uint8Array {
  const text = new Date(at).toISOString().replace(/[-:T]/g, "").slice(2, 14)
  return tlv(0x17, new TextEncoder().encode(`${text}Z`))
}

function commonName(name: string): Uint8Array {
  return sequence(tlv(0x31, sequence(objectIdentifier(COMMON_NAME), tlv(0x0c, new TextEncoder().encode(name)))))
}

/** WebCrypto signs ECDSA as `r || s`; X.509 carries `SEQUENCE { INTEGER r, INTEGER s }`. */
function ecdsaSignatureValue(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2
  return sequence(integer(raw.subarray(0, half)), integer(raw.subarray(half)))
}

function pemBlock(label: string, der: Uint8Array): string {
  const body = Buffer.from(der).toString("base64").replace(/.{64}/g, "$&\n").replace(/\n$/, "")
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

export async function createDirectTlsKey(): Promise<JsonWebKey> {
  const pair = await crypto.subtle.generateKey(ECDSA_P256, true, ["sign", "verify"])
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return { kty, crv, x, y, d }
}

export async function directTlsIdentity(privateKeyJwk: JsonWebKey, now = Date.now()): Promise<DirectTlsIdentity> {
  const { kty, crv, x, y } = privateKeyJwk
  const [signingKey, publicKey] = await Promise.all([
    crypto.subtle.importKey("jwk", { kty, crv, x, y, d: privateKeyJwk.d }, ECDSA_P256, true, ["sign"]),
    crypto.subtle.importKey("jwk", { kty, crv, x, y }, ECDSA_P256, true, ["verify"]),
  ])
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", publicKey))
  const algorithm = sequence(objectIdentifier(ECDSA_WITH_SHA256))
  const name = commonName("claxedo-direct")
  const tbs = sequence(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(crypto.getRandomValues(new Uint8Array(16)).map((byte, index) => (index === 0 ? byte & 0x7f : byte))),
    algorithm,
    name,
    sequence(utcTime(now - 60 * 60 * 1000), utcTime(now + VALIDITY_MS)),
    name,
    spki,
  )
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, tbs))
  const certificate = sequence(tbs, algorithm, tlv(0x03, concat([Uint8Array.of(0), ecdsaSignatureValue(signature)])))
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", signingKey))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki))
  return {
    keyPem: pemBlock("PRIVATE KEY", pkcs8),
    certPem: pemBlock("CERTIFICATE", certificate),
    spkiSha256: Buffer.from(digest).toString("base64url"),
  }
}
