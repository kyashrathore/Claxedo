/**
 * `DELETE /auth/:providerID` on the hosted shell surface (routes/hosted/shell.ts)
 * revokes a Pi credential. What has to hold:
 *
 *   1. no verified signed identity  → 401, and the credential sink is never
 *      reached;
 *   2. the identity handed to the sink is the one the *token* proved, never
 *      one the request asked for — a caller holding owner A's token cannot get
 *      a delete attributed to owner B, whatever `?workspaceId=`,
 *      `x-workspace-id:` or body fields it sends.
 *
 * Tripwire: `signedAuth()` in shell.ts returns the context only when
 * `mode === "signed"`. Returning it unconditionally, or sourcing the identity
 * from the request instead of the verified token, fails these cases.
 */
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { HostedShellRoutes } from "./shell"
import type { ControlPlaneAuthConfig, SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"

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
  issuer: "https://example.issuer.dev",
  jwksUrl: "https://example.issuer.dev/.well-known/jwks.json",
  audience: "claxedo-server",
}

// Two separate paying owners. `token-a` must never be able to act as `owner_b`.
const OWNERS: Record<string, { subject: string; orgId: string }> = {
  "token-a": { subject: "user_a", orgId: "org_a" },
  "token-b": { subject: "user_b", orgId: "org_b" },
}

const verifier = async (token: string) => {
  const owner = OWNERS[token]
  if (!owner) throw Object.assign(new Error("unknown token"), { status: 401 })
  return {
    mode: "signed" as const,
    user: {
      subject: owner.subject,
      tokenIdentifier: `${signedConfig.enabled ? signedConfig.issuer : ""}|${owner.subject}`,
      issuer: "https://example.issuer.dev",
      orgId: owner.orgId,
    },
  }
}

type Del = { auth: SignedControlPlaneAuth; providerID: string }

let deletes: Del[] = []

function app() {
  return HostedShellRoutes({
    authConfig: signedConfig,
    verifier,
    deletePiCredential: async (auth, providerID) => {
      deletes.push({ auth, providerID })
    },
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
  deletes = []
})

describe("sign-in methods", () => {
  test("every native harness is answered with the methods its accounts connect with, Pi's ChatGPT plan by login alone", async () => {
    const methods = async (harness: string) => {
      const response = await app().request(`/api/claxedo/agent-config/providers/auth?nativeHarness=${harness}`, { headers: { authorization: "Bearer token-a" } })
      return [response.status, await response.json()] as const
    }
    expect((await app().request("/api/claxedo/agent-config/providers/auth?nativeHarness=claude")).status).toBe(401)
    expect(Object.keys((await methods("claude"))[1])).toEqual(["claude-sdk"])
    expect(Object.keys((await methods("codex"))[1])).toEqual(["codex-app-server"])
    const [, pi] = await methods("pi")
    expect(pi["openai-codex"]).toEqual([{ type: "oauth", label: "ChatGPT Pro/Plus (headless)" }])
    expect(pi.openai).toEqual([{ type: "api", label: "API Key" }])
    expect(pi.openrouter).toEqual([{ type: "api", label: "API Key" }])
    expect((await methods("not-a-harness"))[0]).toBe(400)
  })
})

describe("credential revocation requires a verified signed identity", () => {
  test("provider catalog uses the verified owner and explicit unavailable states", async () => {
    const calls: string[] = []
    const catalog = HostedShellRoutes({
      authConfig: signedConfig,
      verifier,
      piProviderCatalog: async (auth) => {
        calls.push(auth.user.orgId!)
        return { all: [], connected: [auth.user.orgId], default: {} }
      },
    })
    const route = "/api/claxedo/agent-config/providers?nativeHarness=pi"
    expect((await catalog.request(route)).status).toBe(401)
    const response = await catalog.request(`${route}&workspaceId=org_b`, { headers: { authorization: "Bearer token-a" } })
    expect(response.status).toBe(200)
    expect((await response.json()).connected).toEqual(["org_a"])
    expect(calls).toEqual(["org_a"])
    expect((await app().request(route, { headers: { authorization: "Bearer token-a" } })).status).toBe(503)
    expect((await catalog.request("/api/claxedo/agent-config/providers?nativeHarness=claude", { headers: { authorization: "Bearer token-a" } })).status).toBe(400)
  })
  test("DELETE with no Authorization header is 401 and never revokes anything", async () => {
    const res = await del()
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: { code: "missing_bearer_token" } })
    expect(deletes).toEqual([])
  })

  test("DELETE with an unverifiable bearer is 401", async () => {
    const res = await del({ token: "forged-token" })
    expect(res.status).toBe(401)
    expect(deletes).toEqual([])
  })
})

describe("credential revocation is bound to the token's owner, not the request's claims", () => {
  // The cross-tenant case. Owner A's token, with every caller-controllable
  // channel pointing at owner B.
  const IMPERSONATION_ATTEMPTS: Array<[string, { query?: string; headers?: Record<string, string>; body?: string }]> = [
    ["?workspaceId=", { query: "&workspaceId=org_b" }],
    ["?workspace=", { query: "&workspace=org_b" }],
    ["x-workspace-id header", { headers: { "x-workspace-id": "org_b" } }],
    ["x-claxedo-directory header", { headers: { "x-claxedo-directory": "/workspaces/org_b" } }],
    [
      "identity fields in the body",
      { body: JSON.stringify({ subject: "user_b", orgId: "org_b", workspaceId: "org_b" }) },
    ],
  ]

  test.each(IMPERSONATION_ATTEMPTS)(
    "DELETE as owner A cannot revoke on behalf of owner B via %s",
    async (_label, init) => {
      const res = await del({ token: "token-a", ...init })
      expect(res.status).toBe(200)
      expect(deletes).toHaveLength(1)
      expect(deletes[0].auth.user.subject).toBe("user_a")
      expect(deletes[0].auth.user.orgId).toBe("org_a")
    },
  )

  test("owner B's token is attributed to owner B — the binding tracks the token, not a constant", async () => {
    // Without this, a handler that hardcoded/ignored the identity would still
    // pass every case above.
    await del({ token: "token-b" })
    expect(deletes[0].auth.user.subject).toBe("user_b")
    expect(deletes[0].auth.user.orgId).toBe("org_b")
  })
})

describe("the credential surface is inert unless the pi harness is explicitly selected", () => {
  test("DELETE without ?harness=pi is 503 and revokes nothing", async () => {
    const res = await app().request("http://cp.test/auth/anthropic", { method: "DELETE", headers: { authorization: "Bearer token-a" } })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: { code: "pi_credentials_unavailable" } })
    expect(deletes).toEqual([])
  })

  test("a composition that wires no credential sink answers 503 rather than silently succeeding", async () => {
    const bare = HostedShellRoutes({ authConfig: signedConfig, verifier })
    const res = await bare.request("http://cp.test/auth/anthropic?harness=pi", { method: "DELETE", headers: { authorization: "Bearer token-a" } })
    expect(res.status).toBe(503)
  })
})
