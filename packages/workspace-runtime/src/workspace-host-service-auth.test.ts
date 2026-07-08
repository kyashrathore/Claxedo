import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Hono } from "hono"
import { SignJWT, exportJWK, exportSPKI, generateKeyPair } from "jose"
import { mintRelayHostToken, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import {
  createRelayHostAuthMiddleware,
  loadRelayHostVerificationKeyOrJwks,
  type RelayHostAuthAuditEvent,
} from "./workspace-host-service-auth"

async function app(input: { trustedDirectToken?: string } = {}) {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const app = new Hono()
  const auditEvents: RelayHostAuthAuditEvent[] = []
  app.use("*", createRelayHostAuthMiddleware({
    key: key.publicKey,
    workspaceId: "ws_1",
    hostId: "host_1",
    trustedDirectToken: input.trustedDirectToken,
    audit: (event) => {
      auditEvents.push(event)
    },
  }))
  app.get("/api/wr/health", (c) => c.json({ ok: true, auth: c.get("relayHostAuth")?.workspace_id }))
  return { app, key, auditEvents }
}

const tokenInput = {
  subject: "user_1",
  orgId: "org_1",
  workspaceId: "ws_1",
  hostId: "host_1",
  role: "editor" as const,
  jti: "jti_1",
}

describe("workspace host service relay auth", () => {
  test("accepts relay host tokens scoped to the local workspace and host", async () => {
    const harness = await app()
    const token = await mintRelayHostToken({
      ...tokenInput,
      access: "cloud",
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

  test("accepts the supervisor direct token without accepting anonymous direct calls", async () => {
    const harness = await app({ trustedDirectToken: "direct-secret" })

    const missing = await harness.app.request("http://localhost/api/wr/health", {
      headers: {
        "x-workspace-id": "ws_1",
      },
    })
    expect(missing.status).toBe(401)

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
      access: "cloud",
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
      access: "cloud",
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
    const app = new Hono()
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
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      access: "cloud",
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
      subject: "user_1",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      access: "cloud",
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
      access: "cloud",
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
      access: "cloud",
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
      access: "cloud",
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

  test("user-hosted RHT requires x-forwarded-by marker too", async () => {
    const harness = await app()
    const tokenWith = await mintRelayHostToken({
      ...tokenInput,
      access: "user-hosted",
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
      access: "user-hosted",
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

  test("trustedDirectToken path bypasses the x-forwarded-by check", async () => {
    const harness = await app({ trustedDirectToken: "direct-secret" })

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

  // P-shared.5: integration test for the TokenVerifier override.
  test("uses the injected TokenVerifier when set, bypassing the JWT key path", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const staticVerifier = createStaticTokenVerifier({
      tokens: {
        "static-rht-1": {
          subject: "u-static",
          scopes: [],
          claims: {
            iss: "workspace-relay",
            aud: "workspace-host-service",
            sub: "u-static",
            org_id: "org_static",
            workspace_id: "ws_static",
            host_id: "host_static",
            role: "editor",
            access: "cloud",
            backing: "cloud-vm",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            jti: "jti-static",
          },
        },
      },
    })
    const calls: string[] = []
    const app2 = new Hono()
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
    app2.get("/api/wr/health", (c) => c.json({ ok: true }))
    const res = await app2.request("http://localhost/api/wr/health", {
      headers: {
        authorization: "Bearer static-rht-1",
        "x-workspace-id": "ws_static",
        "x-forwarded-by": "workspace-relay",
      },
    })
    expect(res.status).toBe(200)
    expect(calls).toEqual(["static-rht-1"])
  })

  test("rejects injected TokenVerifier claims outside the relay-host token contract", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const staticVerifier = createStaticTokenVerifier({
      tokens: {
        "static-rht-bad-host": {
          subject: "u-static",
          scopes: [],
          claims: {
            iss: "workspace-relay",
            aud: "workspace-host-service",
            sub: "u-static",
            org_id: "org_static",
            workspace_id: "ws_static",
            host_id: "host_other",
            access: "cloud",
            backing: "cloud-vm",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            jti: "jti-static",
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

  test("rejects injected TokenVerifier claims with inconsistent relay access/backing", async () => {
    const { createStaticTokenVerifier } = await import("@claxedo/workspace-relay-protocol")
    const staticVerifier = createStaticTokenVerifier({
      tokens: {
        "static-rht-bad-pair": {
          subject: "u-static",
          scopes: [],
          claims: {
            iss: "workspace-relay",
            aud: "workspace-host-service",
            sub: "u-static",
            org_id: "org_static",
            workspace_id: "ws_static",
            host_id: "host_static",
            access: "cloud",
            backing: "local-worktree",
            iat: Math.floor(Date.now() / 1000),
            exp: Math.floor(Date.now() / 1000) + 60,
            jti: "jti-static",
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
        authorization: "Bearer static-rht-bad-pair",
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
  })
})

// Reference createHash for test sanity
void createHash
