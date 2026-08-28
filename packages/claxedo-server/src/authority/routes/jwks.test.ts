import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Hono } from "hono"
import {
  decodeProtectedHeader,
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
} from "jose"
import { JwksRoutes } from "./jwks"
import { runtimeAccessTokenSigner } from "@claxedo/server-core/platform/auth/runtime-access-token"

const ENV_KEYS = [
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_KID",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_KID",
  "CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM",
] as const

const previous: Partial<Record<typeof ENV_KEYS[number], string | undefined>> = {}

async function ed25519Pair() {
  const keyPair = await generateKeyPair("EdDSA", { extractable: true })
  return {
    publicPem: await exportSPKI(keyPair.publicKey),
    privatePem: await exportPKCS8(keyPair.privateKey),
    publicKey: keyPair.publicKey,
    privateKey: keyPair.privateKey,
  }
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    previous[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
})

describe("JwksRoutes", () => {
  test("GET /.well-known/jwks.json returns a valid JWKS shape", async () => {
    const current = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toMatch(/application\/json/)
    const body = (await response.json()) as { keys: Array<Record<string, unknown>> }
    expect(Array.isArray(body.keys)).toBe(true)
    expect(body.keys.length).toBe(1)
    const jwk = body.keys[0]!
    expect(jwk.kty).toBe("OKP")
    expect(jwk.crv).toBe("Ed25519")
    expect(typeof jwk.x).toBe("string")
    expect((jwk.x as string).length).toBeGreaterThan(0)
    expect(typeof jwk.kid).toBe("string")
    expect((jwk.kid as string).length).toBeGreaterThan(0)
    expect(jwk.alg).toBe("EdDSA")
    expect(jwk.use).toBe("sig")
  })

  test("response sets Cache-Control: public, max-age=300", async () => {
    const current = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=300")
  })

  test("includes both current and next keys when both are configured", async () => {
    const current = await ed25519Pair()
    const next = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM = next.publicPem

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { keys: Array<Record<string, unknown>> }
    expect(body.keys.length).toBe(2)
    const kids = body.keys.map((k) => k.kid as string)
    expect(new Set(kids).size).toBe(2)
    for (const jwk of body.keys) {
      expect(jwk.kty).toBe("OKP")
      expect(jwk.crv).toBe("Ed25519")
      expect(jwk.alg).toBe("EdDSA")
      expect(jwk.use).toBe("sig")
    }
  })

  test("only current key appears when next is not configured", async () => {
    const current = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")
    const body = (await response.json()) as { keys: Array<Record<string, unknown>> }
    expect(body.keys.length).toBe(1)
  })

  test("kid in JWKS matches kid on a freshly minted RAT", async () => {
    const current = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM = current.privatePem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")
    const body = (await response.json()) as { keys: Array<{ kid: string }> }
    const jwksKids = new Set(body.keys.map((k) => k.kid))

    const sign = runtimeAccessTokenSigner()
    const minted = await sign({
      principalKind: "user",
      actorId: "u",
      actorKind: "human",
      orgId: "o",
      workspaceId: "w",
      hostId: "h",
      role: "editor",
    })
    const header = decodeProtectedHeader(minted.runtimeAccessToken)
    expect(typeof header.kid).toBe("string")
    expect(jwksKids.has(header.kid as string)).toBe(true)
  })

  test("returns 503 with 'no_keys_configured' when no public key env is set", async () => {
    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")
    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe("jwks_no_keys_configured")
  })

  test("uses injected env instead of ambient process env", async () => {
    const current = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem

    const app = new Hono().route("/", JwksRoutes({}))
    const response = await app.request("/.well-known/jwks.json")

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe("jwks_no_keys_configured")
  })

  test("returns 500 if a configured PEM is not a valid Ed25519 public key", async () => {
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = "-----BEGIN PUBLIC KEY-----\nnot a real key\n-----END PUBLIC KEY-----"

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")
    expect(response.status).toBe(500)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe("jwks_invalid_key")
  })

  test("rejects a configured non-EdDSA signing algorithm instead of publishing incompatible keys", async () => {
    const current = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "RS256"

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")

    expect(response.status).toBe(500)
    const body = (await response.json()) as { error?: { code?: string } }
    expect(body.error?.code).toBe("runtime_access_token_algorithm_unsupported")
  })

  test("explicit kid env vars are respected", async () => {
    const current = await ed25519Pair()
    const next = await ed25519Pair()
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = current.publicPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_KID = "current-2026-05"
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_PUBLIC_KEY_PEM = next.publicPem
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_NEXT_KID = "next-2026-06"

    const app = new Hono().route("/", JwksRoutes(process.env))
    const response = await app.request("/.well-known/jwks.json")
    const body = (await response.json()) as { keys: Array<{ kid: string }> }
    const kids = body.keys.map((k) => k.kid)
    expect(kids).toContain("current-2026-05")
    expect(kids).toContain("next-2026-06")
  })
})
