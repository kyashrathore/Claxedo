import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import {
  createLocalJWKSet,
  exportJWK,
  exportSPKI,
  generateKeyPair,
} from "jose"
import { mintRelayHostToken } from "@claxedo/workspace-relay"
import {
  configTokenFromEnv,
  hostTunnelFromEnv,
  managementAuthFromEnv,
  managementTargetFromEnv,
  relayHostAuthFromEnv,
  workspaceRelayRuntimeOptionsFromEnv,
} from "./workspace-relay-env"
import { createRelayHostAuthMiddleware } from "./workspace-host-service-auth"

describe("workspace relay runtime env", () => {
  test("leaves Local Personal Mode unsigned when relay env is absent", async () => {
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
    } as NodeJS.ProcessEnv

    expect(hostTunnelFromEnv(env, 3300)).toBeUndefined()
    await expect(relayHostAuthFromEnv(env)).resolves.toBeUndefined()
    await expect(workspaceRelayRuntimeOptionsFromEnv(env, 3300)).resolves.toEqual({
      relayHostAuth: undefined,
      hostTunnel: undefined,
      configToken: undefined,
    })
  })

  test("builds host tunnel options from explicit relay env", () => {
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_URL: "https://relay.example.test/",
      WORKSPACE_RUNTIME_RELAY_WORKSPACE_IDS: "ws_1, ws_2",
      WORKSPACE_RUNTIME_RELAY_TUNNEL_TOKEN: "secret",
      WORKSPACE_RUNTIME_RELAY_PING_INTERVAL_MS: "2500",
    } as NodeJS.ProcessEnv

    expect(hostTunnelFromEnv(env, 3300)).toEqual({
      relayUrl: "https://relay.example.test",
      hostId: "host_1",
      workspaceIds: ["ws_1", "ws_2"],
      localBaseUrl: "http://127.0.0.1:3300",
      headers: {
        authorization: "Bearer secret",
      },
      pingIntervalMs: 2500,
    })
  })

  test("imports Relay Host Token verification key from PEM env", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
      WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "direct-secret",
    } as NodeJS.ProcessEnv

    await expect(relayHostAuthFromEnv(env)).resolves.toMatchObject({
      workspaceId: "ws_1",
      hostId: "host_1",
      trustedDirectToken: "direct-secret",
    })
  })

  test("reads supervisor runtime config token from env", async () => {
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_CONFIG_TOKEN: "cfg-secret",
    } as NodeJS.ProcessEnv

    expect(configTokenFromEnv(env)).toBe("cfg-secret")
    await expect(workspaceRelayRuntimeOptionsFromEnv(env, 3300)).resolves.toMatchObject({
      configToken: "cfg-secret",
    })
  })

  test("uses the trusted supervisor direct token for user-hosted runtime config pushes", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: await exportSPKI(key.publicKey),
      WORKSPACE_RUNTIME_TRUSTED_DIRECT_TOKEN: "direct-secret",
    } as NodeJS.ProcessEnv

    expect(configTokenFromEnv(env)).toBe("direct-secret")
    await expect(workspaceRelayRuntimeOptionsFromEnv(env, 3300)).resolves.toMatchObject({
      relayHostAuth: expect.objectContaining({
        trustedDirectToken: "direct-secret",
      }),
      configToken: "direct-secret",
    })
  })

  test("uses runtime host id for management auth target", async () => {
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_MANAGEMENT_JWKS_URL: "https://control.example.test/.well-known/jwks.json",
      WORKSPACE_RUNTIME_MANAGEMENT_ISSUER: "claxedo-control-plane",
      WORKSPACE_RUNTIME_MANAGEMENT_AUDIENCE: "supervisor-backplane",
    } as NodeJS.ProcessEnv

    await expect(managementAuthFromEnv(env)).resolves.toBeDefined()
    expect(managementTargetFromEnv(env)).toMatchObject({
      workspaceId: "ws_1",
      hostId: "host_1",
    })
  })

  test("falls back to workspace id for management auth target when host id is absent", async () => {
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
    } as NodeJS.ProcessEnv

    expect(managementTargetFromEnv(env)).toMatchObject({
      workspaceId: "ws_1",
      hostId: "ws_1",
    })
  })

  test("loads RHT verification key from WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: spki,
    } as NodeJS.ProcessEnv

    const result = await relayHostAuthFromEnv(env)
    expect(result).toBeDefined()
    expect(result?.workspaceId).toBe("ws_1")
    expect(result?.hostId).toBe("host_1")
    // PEM path -> KeyLike (object), not a function
    expect(typeof result?.key).toBe("object")
  })

  test("loads RHT verification key from WORKSPACE_RUNTIME_RELAY_JWKS_URL", async () => {
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.example.test/.well-known/jwks.json",
    } as NodeJS.ProcessEnv

    const result = await relayHostAuthFromEnv(env)
    expect(result).toBeDefined()
    // JWKS path -> resolver function
    expect(typeof result?.key).toBe("function")
  })

  test("integration: middleware bootstrapped from JWKS env validates RHTs signed with a key in the JWKS", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const jwk = { ...(await exportJWK(key.publicKey)), kid: "kid-rotated", alg: "EdDSA", use: "sig" }
    const resolver = createLocalJWKSet({ keys: [jwk] })

    // Bootstrap path: build options from env (T6 loader path) and assert the
    // middleware accepts an RHT whose kid matches the JWKS.
    const options = await relayHostAuthFromEnv({
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.example.test/.well-known/jwks.json",
    } as NodeJS.ProcessEnv)
    expect(options).toBeDefined()

    // Replace the JWKS resolver with a local one so the test does not hit the
    // network. This still exercises the "key is a function" code path.
    const app = new Hono()
    app.use("*", createRelayHostAuthMiddleware({
      ...options!,
      key: resolver as unknown as NonNullable<typeof options>["key"],
    }))
    app.get("/api/wr/health", (c) => c.json({ ok: true }))

    const goodToken = await mintRelayHostToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      parentJti: "rat_jti_good",
      access: "cloud",
      backing: "cloud-vm",
      kid: "kid-rotated",
    }, key.privateKey, "EdDSA")

    const goodRes = await app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${goodToken}`,
        "x-workspace-id": "ws_1",
        "x-forwarded-by": "workspace-relay",
      },
    })
    expect(goodRes.status).toBe(200)

    const otherKey = await generateKeyPair("EdDSA", { extractable: true })
    const badToken = await mintRelayHostToken({
      principalKind: "user",
      actorId: "user_1",
      actorKind: "human",
      orgId: "org_1",
      workspaceId: "ws_1",
      hostId: "host_1",
      role: "editor",
      parentJti: "rat_jti_bad",
      access: "cloud",
      backing: "cloud-vm",
      kid: "kid-not-in-jwks",
    }, otherKey.privateKey, "EdDSA")

    const badRes = await app.request("http://localhost/api/wr/health", {
      headers: {
        authorization: `Bearer ${badToken}`,
        "x-workspace-id": "ws_1",
      },
    })
    expect(badRes.status).toBe(401)
  })

  test("prefers JWKS over PEM when both relay verification env vars are set", async () => {
    const pair = await generateKeyPair("EdDSA", { extractable: true })
    const spki = await exportSPKI(pair.publicKey)
    const env = {
      WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_1",
      WORKSPACE_RUNTIME_HOST_ID: "host_1",
      WORKSPACE_RUNTIME_RELAY_HOST_VERIFY_PEM: spki,
      WORKSPACE_RUNTIME_RELAY_JWKS_URL: "https://relay.example.test/.well-known/jwks.json",
    } as NodeJS.ProcessEnv

    const result = await relayHostAuthFromEnv(env)
    expect(result).toBeDefined()
    expect(typeof result?.key).toBe("function")
  })
})
