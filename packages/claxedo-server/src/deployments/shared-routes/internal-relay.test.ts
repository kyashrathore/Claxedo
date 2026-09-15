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

describe("InternalRelayResolverRoutes /internal/relay/host-generation", () => {
  const enrollment = (overrides: Partial<{ revoked_at: number | null; paused_at: number | null; serving_generation: number }> = {}) => ({
    enrollment_id: "enr_1",
    host_id: "host_1",
    owner_user_id: "usr_1",
    owner_actor_id: "act_1",
    public_key_json: "{}",
    key_version: 1,
    serving_generation: 3,
    revoked_at: null,
    paused_at: null,
    scope: undefined,
    ownerEligible: true,
    ...overrides,
  })
  const withLookup = (row: ReturnType<typeof enrollment> | undefined) => {
    const app = new Hono()
    app.route("/", InternalRelayResolverRoutes({
      resolverToken: RESOLVER_TOKEN,
      authority: {
        machineAuth: { lookupEnrollment: async () => row, consumeNonce: async () => true },
      } as never,
    }))
    return app
  }

  test("answers the enrollment's current serving generation in the relay's spelling", async () => {
    const res = await withLookup(enrollment()).fetch(authedRequest("/internal/relay/host-generation?enrollmentId=enr_1"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enrollmentId: "enr_1", generation: 3, revoked: false })
  })

  test("reports a revoked or paused enrollment as revoked: its tunnel must close either way", async () => {
    const revoked = await withLookup(enrollment({ revoked_at: 5 })).fetch(authedRequest("/internal/relay/host-generation?enrollmentId=enr_1"))
    expect(await revoked.json()).toMatchObject({ revoked: true })
    const paused = await withLookup(enrollment({ paused_at: 5 })).fetch(authedRequest("/internal/relay/host-generation?enrollmentId=enr_1"))
    expect(await paused.json()).toMatchObject({ revoked: true })
  })

  test("404s an enrollment the authority does not know", async () => {
    const res = await withLookup(undefined).fetch(authedRequest("/internal/relay/host-generation?enrollmentId=enr_x"))
    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "relay_resolver_enrollment_not_found" } })
  })

  test("requires enrollmentId and the resolver bearer, and 501s without a machine-auth authority", async () => {
    expect((await withLookup(enrollment()).fetch(authedRequest("/internal/relay/host-generation"))).status).toBe(400)
    expect(
      (await withLookup(enrollment()).fetch(new Request("http://relay.test/internal/relay/host-generation?enrollmentId=enr_1"))).status,
    ).toBe(401)
    const bare = buildApp({ revocationLookup: async () => ({ active: true }) })
    expect((await bare.fetch(authedRequest("/internal/relay/host-generation?enrollmentId=enr_1"))).status).toBe(501)
  })
})
