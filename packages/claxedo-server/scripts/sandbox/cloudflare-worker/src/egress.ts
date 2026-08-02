// VENDORED from @claxedo/sandbox-manager/src/drivers/cloudflare-egress.ts
// Canonical source + unit tests live there; this dependency-free copy exists
// because the Worker deploys standalone (its own npm install). Keep in sync.
// Cloudflare egress credential broker — the runtime-agnostic core of the
// Worker-proxy pattern (https://developers.cloudflare.com/sandbox/guides/proxy-requests/).
//
// Unlike Daytona/Vercel, Cloudflare has no transparent egress interception, so
// brokering is an explicit authenticated proxy: the sandbox holds only a
// short-lived JWT and routes outbound requests for brokered hosts through the
// Worker, which validates the token, injects the real credential as a header,
// and forwards. The raw secret value lives only in the Worker's per-sandbox
// store and NEVER enters the sandbox.
//
// This module is Web-Crypto + fetch only, so the same code runs in the driver
// (mint tokens) and inside the Cloudflare Worker (verify + forward).

function b64urlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeJson(value: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )
}

// Constant-time compare of two base64url signatures.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export type EgressTokenClaims = {
  /** Sandbox the token is bound to. */
  sub: string
  /** Hosts the sandbox may reach through the broker. */
  hosts: string[]
  /** Expiry (epoch seconds). */
  exp: number
}

/** Mint a short-lived HS256 token binding a sandbox to its brokered hosts. Carries NO secret values. */
export async function mintEgressToken(input: {
  sandboxId: string
  hosts: string[]
  signingSecret: string
  ttlSeconds?: number
  now?: () => number
}): Promise<string> {
  const now = input.now ?? Date.now
  const header = encodeJson({ alg: "HS256", typ: "JWT" })
  const payload = encodeJson({
    sub: input.sandboxId,
    hosts: input.hosts,
    exp: Math.floor(now() / 1000) + (input.ttlSeconds ?? 15 * 60),
  } satisfies EgressTokenClaims)
  const key = await hmacKey(input.signingSecret)
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`)))
  return `${header}.${payload}.${b64urlEncode(sig)}`
}

/** Verify a token and return its claims, or null if invalid/expired. */
export async function verifyEgressToken(
  token: string,
  signingSecret: string,
  now: () => number = Date.now,
): Promise<EgressTokenClaims | null> {
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [header, payload, sig] = parts as [string, string, string]
  const key = await hmacKey(signingSecret)
  const expected = b64urlEncode(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${header}.${payload}`))),
  )
  if (!timingSafeEqual(sig, expected)) return null
  let claims: EgressTokenClaims
  try {
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(payload))) as EgressTokenClaims
  } catch {
    return null
  }
  if (typeof claims.sub !== "string" || !Array.isArray(claims.hosts) || typeof claims.exp !== "number") return null
  if (claims.exp <= Math.floor(now() / 1000)) return null
  return claims
}

/** How the sandbox names its egress target: header carries the absolute upstream URL. */
export const EGRESS_TARGET_HEADER = "x-claxedo-egress-target"

/** Resolves the brokered credential for a (sandbox, host) pair — Worker-side only, never the sandbox. */
export type EgressSecretResolver = (
  sandboxId: string,
  host: string,
) => Promise<{ header: string; value: string } | undefined> | { header: string; value: string } | undefined

/**
 * Handle one egress-proxy request from a sandbox: validate the JWT, confirm
 * the target host is allowed, inject the brokered credential as its header,
 * and forward. The credential is read from `resolveSecret` (Worker store) and
 * never round-trips through the sandbox.
 */
export async function handleEgressRequest(
  request: Request,
  options: {
    signingSecret: string
    resolveSecret: EgressSecretResolver
    fetchImpl?: typeof fetch
    now?: () => number
  },
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch
  const auth = request.headers.get("authorization")
  const token = auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7) : undefined
  if (!token) return egressError(401, "missing egress token")

  const claims = await verifyEgressToken(token, options.signingSecret, options.now)
  if (!claims) return egressError(401, "invalid or expired egress token")

  const targetRaw = request.headers.get(EGRESS_TARGET_HEADER)
  if (!targetRaw) return egressError(400, "missing egress target")
  let target: URL
  try {
    target = new URL(targetRaw)
  } catch {
    return egressError(400, "malformed egress target")
  }
  if (target.protocol !== "https:") return egressError(400, "egress target must be https")
  if (!claims.hosts.includes(target.host)) return egressError(403, "host not permitted for this sandbox")

  const secret = await options.resolveSecret(claims.sub, target.host)
  if (!secret) return egressError(403, "no brokered credential for host")

  // Forward with the credential injected and the sandbox-facing auth stripped.
  const headers = new Headers(request.headers)
  headers.delete("authorization")
  headers.delete(EGRESS_TARGET_HEADER)
  headers.set(secret.header, secret.value)
  headers.set("host", target.host)

  try {
    const upstream = await fetchImpl(target.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    })
    // Never let an upstream response echo the injected credential back.
    const outHeaders = new Headers(upstream.headers)
    outHeaders.delete(secret.header)
    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders })
  } catch {
    return egressError(502, "upstream request failed")
  }
}

function egressError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  })
}
