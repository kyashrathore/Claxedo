import { Hono } from "hono"
import { describe, expect, test } from "vitest"
import {
  InternalRelayResolverRoutes,
  type LocalRelayTargetExists,
  type RelayTargetLookup,
} from "./internal-relay"

const RESOLVER_TOKEN = "test-resolver-token"

function buildApp(opts: {
  revocationLookup: (args: { jti: string; workspaceId: string; hostId: string }) => Promise<unknown>
  resolverToken?: string
  targetLookup?: RelayTargetLookup
  localTargetExists?: LocalRelayTargetExists
}) {
  const app = new Hono()
  app.route("/", InternalRelayResolverRoutes({
    ...opts,
    resolverToken: opts.resolverToken ?? RESOLVER_TOKEN,
  }))
  return app
}

function authedRequest(path: string) {
  return new Request(`http://relay.test${path}`, {
    headers: { authorization: `Bearer ${RESOLVER_TOKEN}` },
  })
}

describe("InternalRelayResolverRoutes /internal/relay/revocation", () => {
  test("fails closed without an injected revocation lookup or authority", async () => {
    const app = new Hono()
    app.route("/", InternalRelayResolverRoutes({ resolverToken: RESOLVER_TOKEN }))
    const res = await app.fetch(authedRequest(
      "/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1",
    ))
    expect(await res.json()).toEqual({
      active: false,
      code: "runtime_access_token_lookup_unconfigured",
      reason: "Runtime Access Token revocation authority is not configured",
    })
  })

  test("returns active=true when the authority says active", async () => {
    let called = 0
    const app = buildApp({
      revocationLookup: async (args) => {
        called++
        expect(args).toEqual({ jti: "jti_1", workspaceId: "ws_1", hostId: "host_1" })
        return { active: true }
      },
    })

    const res = await app.fetch(authedRequest("/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: true })
    expect(called).toBe(1)
  })

  test("allows loopback resolver calls when no resolver token is configured", async () => {
    const app = buildApp({
      resolverToken: "",
      revocationLookup: async () => ({ active: true }),
    })

    const res = await app.fetch(
      new Request("http://127.0.0.1/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1"),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: true })
  })

  test("allows loopback revocation checks for local workspace targets missing from signed token storage", async () => {
    const app = buildApp({
      resolverToken: "",
      localTargetExists: async () => true,
      revocationLookup: async () => ({
        active: false,
        code: "runtime_access_token_workspace_not_found",
        reason: "Runtime Access Token workspace was not found",
      }),
    })

    const res = await app.fetch(
      new Request("http://127.0.0.1/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1"),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ active: true })
  })

  test("keeps signed resolver revocation checks fail-closed when token storage is missing the workspace", async () => {
    const app = buildApp({
      localTargetExists: async () => true,
      revocationLookup: async () => ({
        active: false,
        code: "runtime_access_token_workspace_not_found",
        reason: "Runtime Access Token workspace was not found",
      }),
    })

    const res = await app.fetch(authedRequest("/internal/relay/revocation?jti=jti_1&workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      active: false,
      code: "runtime_access_token_workspace_not_found",
      reason: "Runtime Access Token workspace was not found",
    })
  })

  test("passes through revoked response from the authority", async () => {
    const app = buildApp({
      revocationLookup: async () => ({
        active: false,
        code: "runtime_access_token_revoked",
        reason: "Runtime Access Token has been revoked",
      }),
    })

    const res = await app.fetch(authedRequest("/internal/relay/revocation?jti=jti_2&workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      active: false,
      code: "runtime_access_token_revoked",
      reason: "Runtime Access Token has been revoked",
    })
  })

  test("returns runtime_access_token_unknown when the authority reports unknown jti", async () => {
    const app = buildApp({
      revocationLookup: async () => ({
        active: false,
        code: "runtime_access_token_unknown",
        reason: "Runtime Access Token has not been recorded",
      }),
    })

    const res = await app.fetch(authedRequest("/internal/relay/revocation?jti=jti_unknown&workspaceId=ws_1&hostId=host_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      active: false,
      code: "runtime_access_token_unknown",
      reason: "Runtime Access Token has not been recorded",
    })
  })

  test("returns runtime_access_token_mismatch when workspace or host doesn't match recorded token", async () => {
    const app = buildApp({
      revocationLookup: async () => ({
        active: false,
        code: "runtime_access_token_mismatch",
        reason: "Runtime Access Token does not match workspace or host",
      }),
    })

    const res = await app.fetch(authedRequest("/internal/relay/revocation?jti=jti_3&workspaceId=ws_other&hostId=host_other"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      active: false,
      code: "runtime_access_token_mismatch",
      reason: "Runtime Access Token does not match workspace or host",
    })
  })

  test("rejects unauthenticated calls (no bearer)", async () => {
    let called = 0
    const app = buildApp({
      revocationLookup: async () => {
        called++
        return { active: true }
      },
    })

    const res = await app.fetch(
      new Request("http://relay.test/internal/relay/revocation?jti=jti_x&workspaceId=ws_1&hostId=host_1"),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: "relay_resolver_unauthorized" },
    })
    expect(called).toBe(0)
  })

  test("requires jti, workspaceId, and hostId query params", async () => {
    const app = buildApp({
      revocationLookup: async () => ({ active: true }),
    })
    const res = await app.fetch(authedRequest("/internal/relay/revocation?jti=jti_1"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: "relay_resolver_revocation_required",
        message: "jti, workspaceId, and hostId are required",
      },
    })
  })

  test("rejects calls with wrong bearer token", async () => {
    let called = 0
    const app = buildApp({
      revocationLookup: async () => {
        called++
        return { active: true }
      },
    })

    const res = await app.fetch(
      new Request("http://relay.test/internal/relay/revocation?jti=jti_x&workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    )
    expect(res.status).toBe(401)
    expect(called).toBe(0)
  })

  test("rejects calls with malformed Authorization header (missing Bearer prefix)", async () => {
    let called = 0
    const app = buildApp({
      revocationLookup: async () => {
        called++
        return { active: true }
      },
    })

    const res = await app.fetch(
      new Request("http://relay.test/internal/relay/revocation?jti=jti_x&workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: RESOLVER_TOKEN },
      }),
    )
    // The current handler strips "Bearer " case-insensitively; without the prefix it
    // compares the raw header against the expected token. Either way: not the matching
    // bearer should be 401. If the handler accepts a raw token without the Bearer
    // prefix, this test will fail and we should tighten the check.
    expect(res.status).toBe(401)
    expect(called).toBe(0)
  })
})

describe("InternalRelayResolverRoutes /internal/relay/target auth", () => {
  test("rejects /target without Authorization header", async () => {
    const app = buildApp({
      revocationLookup: async () => ({ active: true }),
    })
    const res = await app.fetch(
      new Request("http://relay.test/internal/relay/target?workspaceId=ws_1&hostId=host_1"),
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({
      error: { code: "relay_resolver_unauthorized" },
    })
  })

  test("rejects /target with wrong bearer token", async () => {
    const app = buildApp({
      revocationLookup: async () => ({ active: true }),
    })
    const res = await app.fetch(
      new Request("http://relay.test/internal/relay/target?workspaceId=ws_1&hostId=host_1", {
        headers: { authorization: "Bearer wrong-token" },
      }),
    )
    expect(res.status).toBe(401)
  })

  test("requires workspaceId and hostId query params", async () => {
    const app = buildApp({
      revocationLookup: async () => ({ active: true }),
    })
    const res = await app.fetch(authedRequest("/internal/relay/target?workspaceId=ws_1"))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: "relay_resolver_target_required",
        message: "workspaceId and hostId are required",
      },
    })
  })
})
