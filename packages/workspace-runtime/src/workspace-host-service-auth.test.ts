import { describe, expect, test } from "bun:test"
import type { RelayHostVerifierClaims } from "@claxedo/workspace-relay-protocol"
import { Hono } from "hono"
import { exportJWK, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { createServer } from "node:http"
import {
  createRelayHostAuthMiddleware,
  createRelayHostTokenVerifier,
  loadRelayHostVerificationKeyOrJwks,
  type RelayHostAuthAuditEvent,
  type RelayHostAuthContext,
  type RelayHostAuthOptions,
} from "./workspace-host-service-auth"

async function app(input: { trustedDirectTokenForRequest?: RelayHostAuthOptions["trustedDirectTokenForRequest"] } = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const app = new Hono<{ Variables: RelayHostAuthContext }>()
  const auditEvents: RelayHostAuthAuditEvent[] = []
  app.use("*", createRelayHostAuthMiddleware({
    key: key.publicKey,
    workspaceId: "ws_1",
    hostId: "host_1",
    trustedDirectTokenForRequest: input.trustedDirectTokenForRequest,
    audit: (event) => {
      auditEvents.push(event)
    },
  }))
  app.get("/api/wr/health", (c) => c.json({
    ok: true,
    auth: c.get("relayHostAuth")?.workspace_id,
    actorId: c.get("relayHostAuth")?.actor_id,
    actorKind: c.get("relayHostAuth")?.actor_kind,
  }))
  return { app, key, auditEvents }
}

const tokenInput = {
  principalKind: "user" as const,
  actorId: "actor_1",
  actorKind: "human" as const,
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  jti: "jti_1",
  parentJti: "rat_jti_1",
}

describe("workspace host service relay auth", () => {
  test("accepts relay host tokens scoped to the local workspace and host", async () => {
    const harness = await app()
    const token = await mintRelayHostToken({
      ...tokenInput,
      backing: "cloud-vm",
    }, harness.key.privateKey, "EdDSA")

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
      auth: "ws_1",
      actorId: "actor_1",
      actorKind: "human",
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.accepted",
      result: "allow",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("rejects direct client Runtime Access Tokens", async () => {
    const harness = await app()
    const token = await mintRuntimeAccessToken(tokenInput, harness.key.privateKey, "EdDSA")

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
      },
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "invalid_relay_token",
        message: "Relay Host Token is invalid",
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "invalid_relay_token",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("a request-scoped direct grant covers only the route it names", async () => {
    const harness = await app({
      trustedDirectTokenForRequest: ({ token, method, path }) =>
        token === "direct-secret" && method === "GET" && path === "/api/wr/health",
    })
    harness.app.post("/session", (c) => c.json({ ok: true }))

    const missing = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        "x-workspace-id": "ws_1",
      },
    })
    expect(missing.status).toBe(401)

    const outsideGrant = await harness.app.request("http://localhost/session", {
      method: "POST",
      headers: {
        authorization: "Bearer direct-secret",
        "x-workspace-id": "ws_1",
      },
    })
    expect(outsideGrant.status).toBe(401)
    await expect(outsideGrant.json()).resolves.toEqual({
      error: {
        code: "invalid_relay_token",
        message: expect.any(String),
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "invalid_relay_token",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/session",
      method: "POST",
    })

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: "Bearer direct-secret",
        "x-workspace-id": "ws_1",
      },
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      ok: true,
    })
    expect(harness.auditEvents).toContainEqual({
      action: "direct_host_token.accepted",
      result: "allow",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("rejects missing tokens and wrong workspace scopes", async () => {
    const harness = await app()

    const missing = await harness.app.request("http://localhost/api/wr/health")
    expect(missing.status).toBe(401)
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "relay_host_token_required",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })

    const wrongWorkspace = await mintRelayHostToken({
      ...tokenInput,
      workspaceId: "ws_2",
      backing: "cloud-vm",
    }, harness.key.privateKey, "EdDSA")
    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${wrongWorkspace}`,
        "x-workspace-id": "ws_2",
      },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_token_workspace_mismatch",
        message: "Relay Host Token is invalid",
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "relay_token_workspace_mismatch",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("rejects relay requests for workspace ids not hosted by this runtime", async () => {
    const harness = await app()
    const token = await mintRelayHostToken({
      ...tokenInput,
      backing: "cloud-vm",
    }, harness.key.privateKey, "EdDSA")

    const missingHeader = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
      },
    })
    expect(missingHeader.status).toBe(400)
    await expect(missingHeader.json()).resolves.toEqual({
      error: {
        code: "relay_workspace_required",
        message: "Relay request workspace header is required",
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "relay_workspace_required",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_missing",
      },
    })

    expect(res.status).toBe(404)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_workspace_unknown",
        message: "Relay request workspace is not hosted by this Workspace Host Service",
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "relay_workspace_unknown",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })
})

describe("loadRelayHostVerificationKeyOrJwks", () => {
  test("returns a JWKS resolver function when WORKSPACE_RUNTIME_RELAY_JWKS_URL is set", async () => {
    const result = await loadRelayHostVerificationKeyOrJwks({
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.example.test/.well-known/jwks.json",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: undefined,
    })
    expect(typeof result).toBe("function")
  })

  test("falls back to PEM verification key when JWKS URL is unset", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const result = await loadRelayHostVerificationKeyOrJwks({
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: undefined,
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: spki,
    })
    expect(typeof result).not.toBe("function")
    expect(typeof result).toBe("object")
  })

  test("supports PEM with escaped newlines", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const escaped = spki.replace(/\n/g, "\\n")
    const result = await loadRelayHostVerificationKeyOrJwks({
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: undefined,
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: escaped,
    })
    expect(typeof result).toBe("object")
  })

  test("JWKS URL takes precedence when both set", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const result = await loadRelayHostVerificationKeyOrJwks({
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.example.test/.well-known/jwks.json",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: spki,
    })
    expect(typeof result).toBe("function")
  })

  test("rejects when neither env var is set (fail closed)", async () => {
    await expect(
      loadRelayHostVerificationKeyOrJwks({
        WORKSPACE_RUNTIME_RELAY_JWKS_URL: undefined,
        WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: undefined,
      }),
    ).rejects.toThrow(/WORKSPACE_RUNTIME_RELAY_JWKS_URL|WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM/)
  })

  test("rejects when both are whitespace only", async () => {
    await expect(
      loadRelayHostVerificationKeyOrJwks({
        WORKSPACE_RUNTIME_RELAY_JWKS_URL: "   ",
        WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: "",
      }),
    ).rejects.toThrow()
  })

  test("rejects malformed JWKS URL", async () => {
    await expect(
      loadRelayHostVerificationKeyOrJwks({
        WORKSPACE_RUNTIME_RELAY_JWKS_URL: "not-a-url",
        WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: undefined,
      }),
    ).rejects.toThrow()
  })
})

describe("createRelayHostAuthMiddleware with a JWKS resolver", () => {
  test("verifies an RHT signed with kid=x when JWKS contains kid=x", async () => {
    const { createLocalJWKSet } = await import("jose")
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "kid-current", alg: "EdDSA", use: "sig" }
    const resolver = createLocalJWKSet({ keys: [jwk] })

    const auditEvents: RelayHostAuthAuditEvent[] = []
    const app = new Hono<{ Variables: RelayHostAuthContext }>()
    app.use("*", createRelayHostAuthMiddleware({
      key: resolver as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_1",
      hostId: "host_1",
      audit: (event) => {
        auditEvents.push(event)
      },
    }))
    app.get("/api/wr/health", (c) => c.json({ ok: true, kid: c.get("relayHostAuth")?.workspace_id }))

    const token = await mintRelayHostToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      parentJti: "rat_jti_current",
      backing: "cloud-vm",
      kid: "kid-current",
    }, key.privateKey, "EdDSA")

    const res = await app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      },
    })

    expect(res.status).toBe(200)
    expect(auditEvents).toContainEqual({
      action: "relay_host_token.accepted",
      result: "allow",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("rejects an RHT whose kid is not in the JWKS", async () => {
    const { createLocalJWKSet } = await import("jose")
    const knownKey = await generateKeyPair("EdDSA", { extractable: true })
    const otherKey = await generateKeyPair("EdDSA", { extractable: true })
    const jwk = { ...(await exportJWK(knownKey.publicKey)), kid: "kid-known", alg: "EdDSA", use: "sig" }
    const resolver = createLocalJWKSet({ keys: [jwk] })

    const app = new Hono()
    app.use("*", createRelayHostAuthMiddleware({
      key: resolver as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_1",
      hostId: "host_1",
    }))
    app.get("/api/wr/health", (c) => c.json({ ok: true }))

    const token = await mintRelayHostToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      parentJti: "rat_jti_other",
      backing: "cloud-vm",
      kid: "kid-other",
    }, otherKey.privateKey, "EdDSA")

    const res = await app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
      },
    })

    expect(res.status).toBe(401)
  })
})

describe("x-forwarded-by: workspace-relay marker enforcement", () => {
  test("cloud-vm RHT WITH x-forwarded-by: workspace-relay succeeds", async () => {
    const harness = await app()
    const token = await mintRelayHostToken({
      ...tokenInput,
      backing: "cloud-vm",
    }, harness.key.privateKey, "EdDSA")

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      },
    })

    expect(res.status).toBe(200)
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.accepted",
      result: "allow",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("cloud-vm RHT WITHOUT x-forwarded-by marker fails 401", async () => {
    const harness = await app()
    const token = await mintRelayHostToken({
      ...tokenInput,
      backing: "cloud-vm",
    }, harness.key.privateKey, "EdDSA")

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
      },
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_marker_required",
        message: expect.any(String),
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "relay_marker_required",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("cloud-vm RHT with WRONG x-forwarded-by marker fails 401", async () => {
    const harness = await app()
    const token = await mintRelayHostToken({
      ...tokenInput,
      backing: "cloud-vm",
    }, harness.key.privateKey, "EdDSA")

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "evil",
      },
    })

    expect(res.status).toBe(401)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_marker_required",
        message: expect.any(String),
      },
    })
    expect(harness.auditEvents).toContainEqual({
      action: "relay_host_token.rejected",
      result: "deny",
      reason: "relay_marker_required",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("a machine-placed RHT requires the x-forwarded-by marker too", async () => {
    const harness = await app()
    const tokenWith = await mintRelayHostToken({
      ...tokenInput,
      backing: "local-worktree",
    }, harness.key.privateKey, "EdDSA")

    const ok = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${tokenWith}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      },
    })
    expect(ok.status).toBe(200)

    const tokenWithout = await mintRelayHostToken({
      ...tokenInput,
      jti: "jti_2",
      backing: "local-worktree",
    }, harness.key.privateKey, "EdDSA")
    const bad = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${tokenWithout}`,
        "x-workspace-id": "ws_1",
      },
    })
    expect(bad.status).toBe(401)
    await expect(bad.json()).resolves.toEqual({
      error: {
        code: "relay_marker_required",
        message: expect.any(String),
      },
    })
  })

  test("a request-scoped direct grant bypasses the x-forwarded-by check", async () => {
    const harness = await app({ trustedDirectTokenForRequest: ({ token }) => token === "direct-secret" })

    const res = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: "Bearer direct-secret",
        "x-workspace-id": "ws_1",
      },
    })

    expect(res.status).toBe(200)
    expect(harness.auditEvents).toContainEqual({
      action: "direct_host_token.accepted",
      result: "allow",
      workspaceId: "ws_1",
      hostId: "host_1",
      path: "/api/wr/health",
      method: "GET",
    })
  })

  test("uses the injected TokenVerifier when set, bypassing the JWT key path", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const staticVerifier = createStaticTokenVerifier<RelayHostVerifierClaims>({
      tokens: {
        "static-rht-1": {
          scopes: [],
          claims: {
            iss: "workspace-relay",
            aud: "workspace-host-service",
            principal_kind: "user",
            actor_id: "u-static",
            actor_kind: "human",
            org_id: "org_static",
            workspace_id: "ws_static",
            host_id: "host_static",
            role: "editor",
            backing: "cloud-vm",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            jti: "jti-static",
            parent_jti: "rat-jti-static",
          },
        },
      },
    })
    const calls: string[] = []
    const app2 = new Hono<{ Variables: RelayHostAuthContext }>()
    app2.use("*", createRelayHostAuthMiddleware({
      key: new Uint8Array(32) as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_static",
      hostId: "host_static",
      verifier: {
        async verify(token) {
          calls.push(token)
          return staticVerifier.verify(token)
        },
      },
    }))
    app2.get("/api/wr/health", (c) => c.json({ ok: true, role: c.get("relayHostAuth")?.role }))
    const res = await app2.request("http://localhost/api/wr/health", {
      headers: {
        authorization: "Bearer static-rht-1",
        "x-workspace-id": "ws_static",
        "x-forwarded-by": "workspace-relay",
      },
    })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, role: "editor" })
    expect(calls).toEqual(["static-rht-1"])
  })

  test("rejects an injected actor avatar without the required display identity", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const now = Math.floor(Date.now() / 1000)
    const verifier = createStaticTokenVerifier<RelayHostVerifierClaims>({
      tokens: {
        incomplete: {
          subject: "u-static",
          scopes: [],
          claims: {
            iss: "workspace-relay",
            aud: "workspace-host-service",
            principal_kind: "user",
            actor_id: "u-static",
            actor_kind: "human",
            org_id: "org_static",
            workspace_id: "ws_static",
            host_id: "host_static",
            role: "editor",
            backing: "cloud-vm",
            actor_avatar_url: "https://images.example.test/actor.png",
            iat: now,
            exp: now + 60,
            jti: "jti-static",
            parent_jti: "rat-jti-static",
          } as RelayHostVerifierClaims,
        },
      },
    })
    const app2 = new Hono()
    app2.use("*", createRelayHostAuthMiddleware({
      key: new Uint8Array(32) as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_static",
      hostId: "host_static",
      verifier,
    }))
    app2.get("/api/wr/health", (c) => c.json({ ok: true }))

    const response = await app2.request("http://localhost/api/wr/health", {
      headers: {
        authorization: "Bearer incomplete",
        "x-workspace-id": "ws_static",
        "x-forwarded-by": "workspace-relay",
      },
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "relay_token_claims_invalid" },
    })
  })

  test("rejects injected TokenVerifier claims with missing or malformed roles", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const now = Math.floor(Date.now() / 1000)
    const claims = {
      iss: "workspace-relay",
      aud: "workspace-host-service",
      principal_kind: "user",
            actor_id: "u-static",
            actor_kind: "human",
      org_id: "org_static",
      workspace_id: "ws_static",
      host_id: "host_static",
      backing: "cloud-vm",
      iat: now,
      exp: now + 60,
      jti: "jti-static",
      parent_jti: "rat-jti-static",
      // NOTE: `role` is deliberately absent — this is the "missing role" half
      // of the case. The cast below keeps it that way.
    } as const
    const verifier = createStaticTokenVerifier<RelayHostVerifierClaims>({
      tokens: {
        missing: { scopes: [], claims: claims as unknown as RelayHostVerifierClaims },
        malformed: {
          scopes: [],
          // Deliberately invalid: "maintainer" is not a RelayHostVerifierClaims
          // role. The point of the case is that the middleware rejects claims a
          // verifier vouched for but the contract does not allow, so the cast
          // stays — typing it as valid would delete the test.
          claims: { ...claims, role: "maintainer" } as unknown as RelayHostVerifierClaims,
        },
      },
    })
    const app2 = new Hono()
    app2.use("*", createRelayHostAuthMiddleware({
      key: new Uint8Array(32) as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_static",
      hostId: "host_static",
      verifier: verifier as unknown as NonNullable<Parameters<typeof createRelayHostAuthMiddleware>[0]["verifier"]>,
    }))
    app2.get("/api/wr/health", (c) => c.json({ ok: true }))

    for (const token of ["missing", "malformed"]) {
      const res = await app2.request("http://localhost/api/wr/health", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-workspace-id": "ws_static",
          "x-forwarded-by": "workspace-relay",
        },
      })

      expect(res.status).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Relay Host Token is invalid",
        },
      })
    }
  })

  test("rejects injected TokenVerifier claims outside the relay-host token contract", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const staticVerifier = createStaticTokenVerifier<RelayHostVerifierClaims>({
      tokens: {
        "static-rht-bad-host": {
          scopes: [],
          claims: {
            iss: "workspace-relay",
            aud: "workspace-host-service",
            principal_kind: "user",
            actor_id: "u-static",
            actor_kind: "human",
            org_id: "org_static",
            workspace_id: "ws_static",
            host_id: "host_other",
            role: "editor",
            backing: "cloud-vm",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            jti: "jti-static",
            parent_jti: "rat-jti-static",
          },
        },
      },
    })
    const app2 = new Hono()
    app2.use("*", createRelayHostAuthMiddleware({
      key: new Uint8Array(32) as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_static",
      hostId: "host_static",
      verifier: staticVerifier,
    }))
    app2.get("/api/wr/health", (c) => c.json({ ok: true }))

    const res = await app2.request("http://localhost/api/wr/health", {
      headers: {
        authorization: "Bearer static-rht-bad-host",
        "x-workspace-id": "ws_static",
        "x-forwarded-by": "workspace-relay",
      },
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "relay_token_host_mismatch",
        message: "Relay Host Token is invalid",
      },
    })
  })

  test("rejects injected TokenVerifier claims whose backing names no placement", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const base = {
      iss: "workspace-relay",
      aud: "workspace-host-service",
      principal_kind: "user",
      actor_id: "u-static",
      actor_kind: "human",
      org_id: "org_static",
      workspace_id: "ws_static",
      host_id: "host_static",
      role: "editor",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: "jti-static",
      parent_jti: "rat-jti-static",
    }
    const staticVerifier = createStaticTokenVerifier<RelayHostVerifierClaims>({
      tokens: {
        // The placement word a control plane on the other side of this change
        // minted, and the same fact spelled twice by one that carried both.
        "static-rht-retired-backing": {
          scopes: [],
          claims: { ...base, backing: "user-hosted" } as unknown as RelayHostVerifierClaims,
        },
        "static-rht-carries-access": {
          scopes: [],
          claims: { ...base, access: "cloud", backing: "cloud-vm" } as unknown as RelayHostVerifierClaims,
        },
      },
    })
    const app2 = new Hono()
    app2.use("*", createRelayHostAuthMiddleware({
      key: new Uint8Array(32) as unknown as Parameters<typeof createRelayHostAuthMiddleware>[0]["key"],
      workspaceId: "ws_static",
      hostId: "host_static",
      verifier: staticVerifier,
    }))
    app2.get("/api/wr/health", (c) => c.json({ ok: true }))

    for (const token of ["static-rht-retired-backing", "static-rht-carries-access"]) {
      const res = await app2.request("http://localhost/api/wr/health", {
        headers: {
          authorization: `Bearer ${token}`,
          "x-workspace-id": "ws_static",
          "x-forwarded-by": "workspace-relay",
        },
      })

      expect(res.status, token).toBe(401)
      await expect(res.json()).resolves.toEqual({
        error: {
          code: "relay_token_claims_invalid",
          message: "Relay Host Token is invalid",
        },
      })
    }
  })
})

describe("relay host token verifier outside a middleware", () => {
  const KID = "relay-host-current"

  /** The relay's published key set, served the way a host reaches it. */
  async function relayKeys() {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const jwk = { ...(await exportJWK(key.publicKey)), kid: KID, alg: "EdDSA", use: "sig" }
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({ keys: [jwk] }))
    })
    const url = await new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address()
        if (!address || typeof address === "string") throw new Error("no port")
        resolve(`http://127.0.0.1:${address.port}/.well-known/jwks.json`)
      })
    })
    const mint = (overrides: Partial<typeof tokenInput> = {}) => mintRelayHostToken({
      ...tokenInput,
      ...overrides,
      backing: "local-worktree",
      kid: KID,
    }, key.privateKey, "EdDSA")
    return { server, url, mint }
  }

  test("answers the claims for a token this host and workspace were issued, and nothing for every other one", async () => {
    const relay = await relayKeys()
    try {
      const verify = createRelayHostTokenVerifier(() => relay.url)
      const token = await relay.mint()
      const otherHost = await relay.mint({ hostId: "host_other" })
      const otherKey = await generateKeyPair("EdDSA", { extractable: true })
      const forged = await mintRelayHostToken({
        ...tokenInput,
        backing: "local-worktree",
        kid: KID,
      }, otherKey.privateKey, "EdDSA")

      const mine = await verify({ token, workspaceId: "ws_1", hostId: "host_1" })
      const wrongWorkspace = await verify({ token, workspaceId: "ws_2", hostId: "host_1" })
      const wrongHost = await verify({ token: otherHost, workspaceId: "ws_1", hostId: "host_1" })
      const unsignedByRelay = await verify({ token: forged, workspaceId: "ws_1", hostId: "host_1" })
      const garbage = await verify({ token: "not-a-token", workspaceId: "ws_1", hostId: "host_1" })

      expect(mine).toMatchObject({ actor_id: "actor_1", org_id: "org_1", role: "editor", workspace_id: "ws_1" })
      expect(wrongWorkspace).toBeUndefined()
      expect(wrongHost).toBeUndefined()
      expect(unsignedByRelay).toBeUndefined()
      expect(garbage).toBeUndefined()
    } finally {
      await new Promise<void>((resolve) => relay.server.close(() => resolve()))
    }
  })

  test("verifies nothing until the key set address is known, then verifies without a restart", async () => {
    const relay = await relayKeys()
    try {
      let url: string | undefined
      const verify = createRelayHostTokenVerifier(() => url)
      const token = await relay.mint()

      const beforeEndpoints = await verify({ token, workspaceId: "ws_1", hostId: "host_1" })
      url = relay.url
      const afterEndpoints = await verify({ token, workspaceId: "ws_1", hostId: "host_1" })

      expect(beforeEndpoints).toBeUndefined()
      expect(afterEndpoints).toMatchObject({ actor_id: "actor_1" })
    } finally {
      await new Promise<void>((resolve) => relay.server.close(() => resolve()))
    }
  })
})
