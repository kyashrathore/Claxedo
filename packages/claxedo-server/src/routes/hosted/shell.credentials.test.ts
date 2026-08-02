/**
 * `PUT`/`DELETE /auth/:providerID` on the hosted shell surface
 * (routes/hosted-shell.ts) — provider **credential storage**.
 *
 * The only pre-existing test file for this router (hosted-shell.catalog.test.ts)
 * covers the extension catalog and machine-scan, both unauthenticated reads.
 * These two routes are the write surface: they hand a caller-supplied API key
 * to `putPiCredential`, and `deletePiCredential` revokes one. What has to hold:
 *
 *   1. no verified signed identity  → 401, and the credential sink is never
 *      reached (a 400 body-validation error would already mean the handler ran
 *      past the gate);
 *   2. the identity handed to the sink is the one the *token* proved, never
 *      one the request asked for — a caller holding owner A's token cannot get
 *      a write or delete attributed to owner B, whatever `?workspaceId=`,
 *      `x-workspace-id:` or body fields it sends;
 *   3. a malformed payload is refused before any write.
 *
 * Tripwire for (1)/(2): `signedAuth()` in hosted-shell.ts returns the context
 * only when `mode === "signed"`. Returning it unconditionally, or sourcing the
 * identity from the request instead of the verified token, fails these cases.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./shell"
import type { ControlPlaneAuthConfig, SignedControlPlaneAuth } from "../../control-plane/auth"

// An unverifiable bearer falls back to `verifyCliAccessBearer`, which reads
// these from process.env. Clear them so "invalid token" is deterministic here
// rather than depending on the developer's shell.
const prevCliToken = {
  pub: process.env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM,
  runtimePub: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
}
delete process.env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM
delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM

afterAll(() => {
  if (prevCliToken.pub !== undefined) process.env.CLAXEDO_CLI_TOKEN_PUBLIC_KEY_PEM = prevCliToken.pub
  if (prevCliToken.runtimePub !== undefined) {
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = prevCliToken.runtimePub
  }
})

const signedConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://example.clerk.dev",
  jwksUrl: "https://example.clerk.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

// Two separate paying owners. `token-a` must never be able to act as `owner_b`.
const OWNERS: Record<string, { subject: string; orgId: string }> = {
  "token-a": { subject: "user_a", orgId: "org_a" },
  "token-b": { subject: "user_b", orgId: "org_b" },
}

const verifier = async (token: string) => {
  const owner = OWNERS[token]
  if (!owner) throw new Error("unknown token")
  return {
    mode: "signed" as const,
    user: {
      subject: owner.subject,
      tokenIdentifier: `${signedConfig.enabled ? signedConfig.issuer : ""}|${owner.subject}`,
      issuer: "https://example.clerk.dev",
      orgId: owner.orgId,
    },
  }
}

type Put = { auth: SignedControlPlaneAuth; providerID: string; key: string }
type Del = { auth: SignedControlPlaneAuth; providerID: string }

let puts: Put[] = []
let deletes: Del[] = []

function app() {
  return HostedShellRoutes({
    authConfig: signedConfig,
    verifier,
    putPiCredential: async (auth, providerID, key) => {
      puts.push({ auth, providerID, key })
    },
    deletePiCredential: async (auth, providerID) => {
      deletes.push({ auth, providerID })
    },
  })
}

function put(init: { token?: string; body?: string; query?: string; headers?: Record<string, string> } = {}) {
  return app().request(`http://cp.test/auth/anthropic?harness=pi${init.query ?? ""}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
    body: init.body ?? JSON.stringify({ auth: { key: "sk-secret" } }),
  })
}

function del(init: { token?: string; query?: string; headers?: Record<string, string> } = {}) {
  return app().request(`http://cp.test/auth/anthropic?harness=pi${init.query ?? ""}`, {
    method: "DELETE",
    headers: {
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...init.headers,
    },
  })
}

beforeEach(() => {
  puts = []
  deletes = []
})

describe("credential writes require a verified signed identity", () => {
  test("PUT with no Authorization header is 401 and never reaches the credential store", async () => {
    const res = await put()
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    expect(puts).toEqual([])
  })

  test("DELETE with no Authorization header is 401 and never revokes anything", async () => {
    const res = await del()
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    expect(deletes).toEqual([])
  })

  test("PUT with an unverifiable bearer is 401, not a fall-through to the store", async () => {
    const res = await put({ token: "forged-token" })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "invalid_bearer_token" } })
    expect(puts).toEqual([])
  })

  test("DELETE with an unverifiable bearer is 401", async () => {
    const res = await del({ token: "forged-token" })
    expect(res.status).toBe(401)
    expect(deletes).toEqual([])
  })

  test("the auth gate runs BEFORE payload validation", async () => {
    // A malformed body from an unauthenticated caller must still be 401. A 400
    // here would prove the handler validated the body first, i.e. that
    // unauthenticated requests reach handler logic at all.
    const res = await put({ body: JSON.stringify({}) })
    expect(res.status).toBe(401)
    expect(puts).toEqual([])
  })
})

describe("credential writes are bound to the token's owner, not the request's claims", () => {
  // The cross-tenant case. Owner A's token, with every caller-controllable
  // channel pointing at owner B.
  const IMPERSONATION_ATTEMPTS: Array<[string, { query?: string; headers?: Record<string, string>; body?: string }]> = [
    ["?workspaceId=", { query: "&workspaceId=org_b" }],
    ["?workspace=", { query: "&workspace=org_b" }],
    ["x-workspace-id header", { headers: { "x-workspace-id": "org_b" } }],
    ["x-opencode-directory header", { headers: { "x-opencode-directory": "/workspaces/org_b" } }],
    [
      "identity fields in the body",
      { body: JSON.stringify({ auth: { key: "sk-secret" }, subject: "user_b", orgId: "org_b", workspaceId: "org_b" }) },
    ],
  ]

  test.each(IMPERSONATION_ATTEMPTS)(
    "PUT as owner A cannot be attributed to owner B via %s",
    async (_label, init) => {
      const res = await put({ token: "token-a", ...init })
      expect(res.status).toBe(200)
      expect(puts).toHaveLength(1)
      // The credential is stored against the identity the TOKEN proved.
      expect(puts[0]!.auth.user.subject).toBe("user_a")
      expect(puts[0]!.auth.user.orgId).toBe("org_a")
      expect(puts[0]!.auth.token).toBe("token-a")
    },
  )

  test.each(IMPERSONATION_ATTEMPTS)(
    "DELETE as owner A cannot revoke on behalf of owner B via %s",
    async (_label, init) => {
      const res = await del({ token: "token-a", ...init })
      expect(res.status).toBe(200)
      expect(deletes).toHaveLength(1)
      expect(deletes[0]!.auth.user.subject).toBe("user_a")
      expect(deletes[0]!.auth.user.orgId).toBe("org_a")
    },
  )

  test("owner B's token is attributed to owner B — the binding tracks the token, not a constant", async () => {
    // Without this, a handler that hardcoded/ignored the identity would still
    // pass every case above.
    await put({ token: "token-b" })
    expect(puts[0]!.auth.user.subject).toBe("user_b")
    expect(puts[0]!.auth.user.orgId).toBe("org_b")
  })
})

describe("malformed credential payloads are refused before any write", () => {
  const MALFORMED: Array<[string, string]> = [
    ["empty object", JSON.stringify({})],
    ["missing auth.key", JSON.stringify({ auth: {} })],
    ["empty auth.key", JSON.stringify({ auth: { key: "" } })],
    ["null auth", JSON.stringify({ auth: null })],
    ["auth.key is not a string", JSON.stringify({ auth: { key: 0 } })],
    ["key at the top level instead of under auth", JSON.stringify({ key: "sk-secret" })],
    ["not JSON at all", "<<<not json>>>"],
    ["empty body", ""],
  ]

  test.each(MALFORMED)("PUT with %s is 400 and stores nothing", async (_label, body) => {
    const res = await put({ token: "token-a", body })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: "pi_auth_key_required" } })
    expect(puts).toEqual([])
  })
})

describe("the credential surface is inert unless the pi harness is explicitly selected", () => {
  // Fail-closed default: no `?harness=pi` means no credential storage at all.
  test("PUT without ?harness=pi is 503 and stores nothing", async () => {
    const res = await app().request("http://cp.test/auth/anthropic", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer token-a" },
      body: JSON.stringify({ auth: { key: "sk-secret" } }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "pi_credentials_unavailable" } })
    expect(puts).toEqual([])
  })

  test("a composition that wires no credential sink answers 503 rather than silently succeeding", async () => {
    const bare = HostedShellRoutes({ authConfig: signedConfig, verifier })
    const res = await bare.request("http://cp.test/auth/anthropic?harness=pi", {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "Bearer token-a" },
      body: JSON.stringify({ auth: { key: "sk-secret" } }),
    })
    expect(res.status).toBe(503)
  })
})
