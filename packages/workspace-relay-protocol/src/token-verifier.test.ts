import { describe, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  createClerkTokenVerifier,
  createHttpTokenVerifier,
  createStaticTokenVerifier,
  TokenVerifierError,
  type TokenVerifierBaseClaims,
} from "./token-verifier"

// Bun's `fetch` type carries a `preconnect` member that the standard
// DOM lib type lacks. Tests cast through `unknown` to keep the mock
// shape minimal.
type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>
const asFetch = (fn: FetchLike) => fn as unknown as typeof fetch
const now = Math.floor(Date.now() / 1000)
const baseClaims = {
  iss: "issuer",
  aud: "audience",
  sub: "user_1",
  workspace_id: "ws_1",
  host_id: "host_1",
  exp: now + 60,
  iat: now,
  jti: "jti_1",
} satisfies TokenVerifierBaseClaims

describe("StaticTokenVerifier", () => {
  test("returns claims for a known token", async () => {
    const verifier = createStaticTokenVerifier({
      tokens: {
        "tok-good": { subject: "user_1", scopes: ["read"], claims: baseClaims },
      },
    })
    const result = await verifier.verify("tok-good")
    expect(result.subject).toBe("user_1")
    expect(result.scopes).toEqual(["read"])
    expect(result.claims).toEqual(baseClaims)
  })

  test("rejects an unknown token", async () => {
    const verifier = createStaticTokenVerifier({ tokens: {} })
    await expect(verifier.verify("tok-bad")).rejects.toBeInstanceOf(TokenVerifierError)
    await expect(verifier.verify("tok-bad")).rejects.toMatchObject({
      code: "token_not_in_static_table",
      status: 401,
    })
  })

  test("rejects Object.prototype member names as tokens", async () => {
    // A plain-object lookup resolves inherited keys, so these would verify
    // successfully and hand the caller an Object.prototype member in place of
    // claims — an authentication bypass requiring no knowledge of any token.
    const verifier = createStaticTokenVerifier({
      tokens: { "tok-good": { subject: "workspace-1", scopes: [], claims: {} } },
    })
    for (const inherited of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
      await expect(verifier.verify(inherited)).rejects.toMatchObject({ code: "token_not_in_static_table" })
    }
    await expect(verifier.verify("tok-good")).resolves.toMatchObject({ subject: "workspace-1" })
  })
})

describe("HttpTokenVerifier", () => {
  test("returns claims when the verifier endpoint accepts the token", async () => {
    const fetchMock = asFetch(async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null
      expect(url).toBe("https://verify.example/v")
      expect(body?.token).toBe("tok-1")
      return new Response(
        JSON.stringify({ subject: "user_1", scopes: ["x"], claims: baseClaims }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: fetchMock,
    })
    const claims = await verifier.verify("tok-1")
    expect(claims).toEqual({ subject: "user_1", scopes: ["x"], claims: baseClaims })
  })

  test("propagates 401 from the verifier endpoint as TokenVerifierError(401)", async () => {
    const fetchMock = asFetch(async () => new Response("nope", { status: 401 }))
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: fetchMock,
    })
    await expect(verifier.verify("bad")).rejects.toMatchObject({
      code: "verifier_rejected",
      status: 401,
    })
  })

  test("normalises a missing subject to verifier_response_invalid", async () => {
    const fetchMock = asFetch(async () => new Response("{}", { status: 200 }))
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: fetchMock,
    })
    await expect(verifier.verify("any")).rejects.toMatchObject({
      code: "verifier_response_invalid",
    })
  })

  test("maps fetch throws to verifier_unreachable", async () => {
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () => {
        throw new Error("network down")
      }),
    })

    await expect(verifier.verify("tok")).rejects.toMatchObject({
      code: "verifier_unreachable",
      status: 401,
    })
  })

  test("maps timeout aborts to verifier_unreachable", async () => {
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      timeoutMs: 1,
      fetch: asFetch((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
        }),
      ),
    })

    await expect(verifier.verify("tok")).rejects.toMatchObject({
      code: "verifier_unreachable",
    })
  })

  test("maps non-JSON 200 responses to verifier_response_invalid", async () => {
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () => new Response("not json", { status: 200 })),
    })

    await expect(verifier.verify("tok")).rejects.toMatchObject({
      code: "verifier_response_invalid",
    })
  })

  test("preserves 403 and normalizes 500 verifier rejections", async () => {
    const forbidden = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () => new Response("forbidden", { status: 403 })),
    })
    await expect(forbidden.verify("tok")).rejects.toMatchObject({
      code: "verifier_rejected",
      status: 403,
    })

    const failed = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () => new Response("oops", { status: 500 })),
    })
    await expect(failed.verify("tok")).rejects.toMatchObject({
      code: "verifier_rejected",
      status: 401,
    })
  })

  test("rejects incomplete verifier claim payloads", async () => {
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () =>
        new Response(JSON.stringify({
          subject: "user_1",
          claims: {
            ...baseClaims,
            host_id: undefined,
          },
        }), { status: 200 }),
      ),
    })

    await expect(verifier.verify("tok")).rejects.toMatchObject({
      code: "verifier_response_invalid",
    })
  })

  test("rejects subject and claims sub mismatches", async () => {
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () =>
        new Response(JSON.stringify({
          subject: "user_other",
          claims: baseClaims,
        }), { status: 200 }),
      ),
    })

    await expect(verifier.verify("tok")).rejects.toMatchObject({
      code: "verifier_response_invalid",
    })
  })

  test("filters non-string scopes", async () => {
    const verifier = createHttpTokenVerifier({
      endpoint: "https://verify.example/v",
      fetch: asFetch(async () =>
        new Response(JSON.stringify({
          subject: "user_1",
          scopes: ["read", 42, "write"],
          claims: baseClaims,
        }), { status: 200 }),
      ),
    })

    await expect(verifier.verify("tok")).resolves.toEqual({
      subject: "user_1",
      scopes: ["read", "write"],
      claims: baseClaims,
    })
  })
})

describe("ClerkTokenVerifier", () => {
  test("verifies a Clerk-style session JWT against JWKS", async () => {
    const key = await generateKeyPair("ES256")
    const publicJwk = await exportJWK(key.publicKey)
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [{ ...publicJwk, kid: "kid-1", alg: "ES256", use: "sig" }] }),
    })
    try {
      const token = await new SignJWT({
        sid: "sess_1",
        org_id: "org_1",
        scp: ["session:read", "workspace:write"],
      })
        .setProtectedHeader({ alg: "ES256", kid: "kid-1" })
        .setIssuer("https://clerk.example.test")
        .setAudience("claxedo")
        .setSubject("user_1")
        .setJti("jti_1")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(key.privateKey)

      await expect(createClerkTokenVerifier({
        issuer: "https://clerk.example.test",
        audience: "claxedo",
        jwksUrl: String(server.url),
      }).verify(token)).resolves.toMatchObject({
        subject: "user_1",
        scopes: ["session:read", "workspace:write"],
        claims: {
          iss: "https://clerk.example.test",
          aud: "claxedo",
          sub: "user_1",
          sid: "sess_1",
          jti: "jti_1",
          org_id: "org_1",
        },
      })
    } finally {
      server.stop(true)
    }
  })

  test("rejects invalid Clerk session tokens", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [] }),
    })
    try {
      await expect(createClerkTokenVerifier({
        issuer: "https://clerk.example.test",
        jwksUrl: String(server.url),
      }).verify("not-a-jwt")).rejects.toMatchObject({
        code: "clerk_token_invalid",
      })
    } finally {
      server.stop(true)
    }
  })
})
