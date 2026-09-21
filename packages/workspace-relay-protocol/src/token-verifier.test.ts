import { describe, expect, test } from "bun:test"
import { exportJWK, generateKeyPair, SignJWT } from "jose"
import {
  createOidcTokenVerifier,
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
  test.each(["http://verify.example/v", "http://localhost/v", "file:///tmp/keys", "https://user:pass@verify.example/v", "https://verify.example/v#other"])("refuses an insecure endpoint without transmitting a token: %s", (endpoint) => {
    let requests = 0
    expect(() => createHttpTokenVerifier({ endpoint, fetch: asFetch(async () => { requests++; return Response.json({}) }) })).toThrow("Verifier endpoint requires HTTPS")
    expect(requests).toBe(0)
  })

  test.each(["http://localhost.evil.test/v", "http://127.0.0.2/v", "http://0.0.0.0/v"])("the development exception cannot authorize %s", (endpoint) => {
    expect(() => createHttpTokenVerifier({ endpoint, allowInsecureLoopback: true })).toThrow("Verifier endpoint requires HTTPS")
  })

  test.each([
    { exp: now - 1 }, { exp: now }, { exp: now + 60, iat: now + 61 }, { iat: now + 1_000 }, { nbf: now + 1_000 }, { nbf: "tomorrow" },
  ])("locally refuses invalid temporal claims %j", async (changed) => {
    const verifier = createHttpTokenVerifier({ endpoint: "https://verify.example/v", fetch: asFetch(async () => Response.json({ subject: "user_1", claims: { ...baseClaims, ...changed } })) })
    await expect(verifier.verify("synthetic-token")).rejects.toMatchObject({ code: "verifier_claims_invalid" })
  })

  test("a real redirect never transmits the bearer to its target", async () => {
    let received = 0
    const destination = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { received++; return Response.json({ subject: "user_1", claims: baseClaims }) } })
    const source = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null, { status: 307, headers: { location: destination.url.href } }) })
    try {
      const verifier = createHttpTokenVerifier({ endpoint: source.url.href, allowInsecureLoopback: true })
      await expect(verifier.verify("synthetic-token")).rejects.toMatchObject({ code: "verifier_unreachable" })
      expect(received).toBe(0)
      await expect(createHttpTokenVerifier({ endpoint: destination.url.href, allowInsecureLoopback: true }).verify("synthetic-token")).resolves.toMatchObject({ subject: "user_1" })
      expect(received).toBe(1)
    } finally {
      await source.stop(true)
      await destination.stop(true)
    }
  })

  test("returns claims when the verifier endpoint accepts the token", async () => {
    const fetchMock = asFetch(async (url, init) => {
      const raw = init?.body
      const body: { token?: string } | null = typeof raw === "string" ? JSON.parse(raw) : null
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
      status: 503,
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
      status: 503,
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

  test("preserves 403 rejection and classifies a 500 as verifier unavailability", async () => {
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
      code: "verifier_unavailable",
      status: 503,
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

describe("OidcTokenVerifier", () => {
  test("verifies a session JWT against JWKS", async () => {
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
        .setIssuer("https://idp.example.test")
        .setAudience("claxedo")
        .setSubject("user_1")
        .setJti("jti_1")
        .setIssuedAt(now)
        .setExpirationTime(now + 300)
        .sign(key.privateKey)

      await expect(createOidcTokenVerifier({
        issuer: "https://idp.example.test",
        audience: "claxedo",
        jwksUrl: String(server.url),
      }).verify(token)).resolves.toMatchObject({
        subject: "user_1",
        scopes: ["session:read", "workspace:write"],
        claims: {
          iss: "https://idp.example.test",
          aud: "claxedo",
          sub: "user_1",
          sid: "sess_1",
          jti: "jti_1",
          org_id: "org_1",
        },
      })
    } finally {
      await server.stop(true)
    }
  })

  test("rejects invalid session tokens", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ keys: [] }),
    })
    try {
      await expect(createOidcTokenVerifier({
        issuer: "https://idp.example.test",
        jwksUrl: String(server.url),
      }).verify("not-a-jwt")).rejects.toMatchObject({
        code: "oidc_token_invalid",
      })
    } finally {
      await server.stop(true)
    }
  })
})
