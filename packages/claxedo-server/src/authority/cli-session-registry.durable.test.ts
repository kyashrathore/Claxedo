/**
 * The DURABLE half of CLI session token revocation.
 *
 * `cli-session-token.test.ts` proves the token logic against an in-memory
 * registry. That is necessary and not sufficient: the hosted Worker ran with NO
 * registry at all, so `/api/auth/cli/exchange` answered 503 and no CLI bearer
 * verified — while the suite stayed green, because the one hosted test installed
 * the in-memory registry itself. A passing suite was compatible with the feature
 * being completely broken in production.
 *
 * So the assertions here are deliberately about the things a second
 * implementation of the port cannot fake:
 *
 *   1. the hosted composition actually SERVES a CLI exchange (no 503) — the
 *      direct inverse of the bug;
 *   2. the safety property survives: with nothing configured, the same route
 *      still fails closed;
 *   3. `convex/cliSessionTokens.ts` enforces its own authorization — service
 *      token required, revocation scoped to the owner named, and no argument
 *      shape that lets one user reach another's rows;
 *   4. rotation is ATOMIC: the burn and the registration are one transaction,
 *      so there is no window where both the spent token and its replacement
 *      verify, and a rejected rotation writes nothing.
 *
 * Tests 3 and 4 run the real Convex handlers (via `_handler`, the repo's
 * convention for Convex policy tests); test 1 runs them underneath the real
 * adapter stack, so the wire argument names are covered too.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { decodeJwt, exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import {
  active,
  reapExpired,
  recordMint,
  revoke,
  revokeForUser,
  revokeMine,
  revokeSession,
  rotate,
} from "../../../../convex/cliSessionTokens"
import { createHostedApp } from "../deployments/hosted-shared/hosted-app"
import { HostedDeviceAuthRoutes } from "../routes/hosted/device-auth"
import {
  cliSessionHandler,
  durableCliSessionTokenRegistry,
  fakeCliSessionTokenDb,
} from "../test-support/cli-session-registry"
import {
  configureCliSessionTokenRegistry,
  type CliSessionTokenRegistry,
} from "./cli-session-registry"
import { mintCliSessionTokens, refreshCliSessionTokens, verifyCliAccessBearer } from "./cli-session-token"
import { composeHostedControlPlane, sandboxRelayTargetLookup, type HostedControlPlane } from "./hosted-services"
import type { ControlPlaneServices } from "./services"
import type { SignedControlPlaneAuth } from "./auth"

const SERVICE_TOKEN = "service-secret"
const OWNER = "https://clerk.test|user_1"
const INTRUDER = "https://clerk.test|user_2"

const previousServiceToken = process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN

beforeEach(() => {
  process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = SERVICE_TOKEN
})

afterEach(() => {
  if (previousServiceToken === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN
  else process.env.CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN = previousServiceToken
  // No test may leak its registry into the next one; the fail-closed case below
  // depends on the seam being empty.
  configureCliSessionTokenRegistry(undefined)
})

function record(input: Partial<Record<string, unknown>> = {}) {
  const now = Date.now()
  return {
    jti: "jti_access",
    kind: "access" as const,
    token_identifier: OWNER,
    subject: "user_1",
    session_id: "chain_1",
    expires_at: now + 60_000,
    session_expires_at: now + 600_000,
    ...input,
  }
}

function seeded(rows: Record<string, unknown>[]) {
  return fakeCliSessionTokenDb(
    rows.map((row, index) => ({ _id: `cli_token_${index + 1}`, created_at: Date.now(), ...row })) as never,
  )
}

async function keyEnv() {
  const pair = await generateKeyPair("EdDSA", { extractable: true })
  return {
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(pair.privateKey),
    CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(pair.publicKey),
    CLAXEDO_CLI_ACCESS_TOKEN_TTL_SECONDS: "600",
  }
}

function fakePlane(cliSessionTokenRegistry: CliSessionTokenRegistry, env: Record<string, string | undefined>): HostedControlPlane {
  const services = {
    auth: {
      config: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" },
      verifier: vi.fn(async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: `https://clerk.test|${token}`, issuer: "https://clerk.test" },
      })),
    },
    relay: {
      relayUrl: "https://relay.test",
      resolverToken: "resolver-token",
      runtimeAccessTokenSigner: vi.fn(),
      hostTunnelTokenSigner: vi.fn(),
    },
    sandbox: {},
    authority: { usersMe: vi.fn(async () => ({ id: "user_1" })), listWorkspaces: vi.fn(async () => []) },
    projectionStore: {},
    durableSessionLog: {},
    telemetry: { capture: vi.fn() },
    localExecution: { enabled: false },
  } as unknown as ControlPlaneServices

  return {
    services,
    relayUrl: "https://relay.test",
    resolverToken: "resolver-token",
    safetyLimits: {
      connectionRateLimit: 6,
      connectionRateLimitWindowMs: 60_000,
      controlPlaneRateLimit: 120,
      controlPlaneRateLimitWindowMs: 60_000,
      defaultRequestRateLimit: 600,
      defaultRequestRateLimitWindowMs: 60_000,
      sandboxMaxRetryCount: 5,
    },
    relayTargetLookup: sandboxRelayTargetLookup({ telemetry: services.telemetry }),
    cliSessionTokenRegistry,
    env: {
      CLAXEDO_DEPLOYMENT_MODE: "hosted",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: SERVICE_TOKEN,
      ...env,
    },
  }
}

function auth(subject = "user_1"): SignedControlPlaneAuth {
  return {
    mode: "signed",
    token: "clerk-token",
    user: {
      subject,
      tokenIdentifier: `https://clerk.test|${subject}`,
      issuer: "https://clerk.test",
    },
  }
}

describe("the hosted composition serves CLI login", () => {
  test("POST /api/auth/cli/exchange succeeds — the 503 is gone", async () => {
    // The bug, stated as a test. With no durable registry this route answered
    // 503 `cli_token_issuer_unavailable` ("CLI session token registry is not
    // configured"), so `claxedo login` could not complete against the hosted
    // Worker at all. Nothing is configured by hand here: `createHostedApp`
    // installs the plane's registry, which is the wiring that was missing.
    const env = await keyEnv()
    const app = createHostedApp(fakePlane(durableCliSessionTokenRegistry().registry, env))

    const response = await app.fetch(
      new Request("http://cp.test/api/auth/cli/exchange", {
        method: "POST",
        headers: { authorization: "Bearer user_1" },
      }),
    )

    expect(response.status).toBe(200)
    const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
    expect(body.access_token).toMatch(/^ey/)
    expect(body.refresh_token).toMatch(/^claxedo_cli_refresh:/)
    expect(body.expires_in).toBe(600)
  })

  test("the minted token is durably recorded and verifies as a bearer on another isolate", async () => {
    // The property an in-memory registry cannot demonstrate: a token minted by
    // one app instance is accepted by a different one, because both read the
    // same durable rows.
    const env = await keyEnv()
    const durable = durableCliSessionTokenRegistry()
    const minted = (await (await createHostedApp(fakePlane(durable.registry, env)).fetch(
      new Request("http://cp.test/api/auth/cli/exchange", {
        method: "POST",
        headers: { authorization: "Bearer user_1" },
      }),
    )).json()) as { access_token: string }

    const stored = [...durable.rows.values()]
    expect(stored.map((row) => row.kind).sort()).toEqual(["access", "refresh"])
    expect(new Set(stored.map((row) => row.token_identifier))).toEqual(new Set([OWNER]))
    expect(stored.map((row) => row.jti)).toContain(decodeJwt(minted.access_token).jti)

    // A second isolate: fresh app, same durable table.
    createHostedApp(fakePlane(durable.registry, env))
    await expect(verifyCliAccessBearer(minted.access_token, env)).resolves.toMatchObject({
      tokenKind: "cli",
      user: { tokenIdentifier: OWNER },
    })
  })

  test("still fails closed when no registry is configured", async () => {
    // The safety property must survive the fix. Mounted without the hosted
    // composition (so nothing installs a registry), the same route refuses to
    // mint rather than issuing a credential nothing could ever revoke.
    configureCliSessionTokenRegistry(undefined)
    const env = await keyEnv()
    const app = HostedDeviceAuthRoutes({
      authConfig: { enabled: true, issuer: "https://clerk.test", jwksUrl: "https://clerk.test/jwks" } as never,
      verifier: (async (token: string) => ({
        mode: "signed",
        user: { subject: token, tokenIdentifier: `https://clerk.test|${token}`, issuer: "https://clerk.test" },
      })) as never,
      env,
    })

    const response = await app.fetch(
      new Request("http://cp.test/api/auth/cli/exchange", {
        method: "POST",
        headers: { authorization: "Bearer user_1" },
      }),
    )

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { code: "cli_token_issuer_unavailable", message: /registry is not configured/ as never },
    })
  })

  test("hosted composition fails at boot when durable token storage cannot authenticate", () => {
    expect(() => composeHostedControlPlane({
      CLAXEDO_SIGNED_CLOUD_AUTH: "true",
      CLERK_JWT_ISSUER: "https://clerk.test",
      CLERK_JWKS_URL: "https://clerk.test/jwks",
      CLAXEDO_WORKSPACE_AUTHORITY_URL: "https://convex.test",
      CLAXEDO_WORKSPACE_RELAY_URL: "https://relay.test",
      CLAXEDO_RELAY_RESOLVER_TOKEN: "resolver-token",
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: "pem",
      CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN: undefined,
    })).toThrow(/CLAXEDO_CONTROL_PLANE_SERVICE_TOKEN/)
  })
})

describe("round trip through the durable registry", () => {
  test("mint, verify, rotate, replay-rejected, revoke", async () => {
    const env = await keyEnv()
    const { registry, rows } = durableCliSessionTokenRegistry()

    const first = await mintCliSessionTokens(auth(), env, { registry })
    await expect(verifyCliAccessBearer(first.access_token, env, { registry })).resolves.toBeTruthy()

    const second = await refreshCliSessionTokens(first.refresh_token, env, { registry })
    const burned = decodeJwt(first.refresh_token.slice("claxedo_cli_refresh:".length)).jti
    const rotatedIn = decodeJwt(second.access_token).jti

    // Old jti burned, new jti registered, chain identity carried through.
    expect([...rows.values()].find((row) => row.jti === burned)?.revoked_at).toBeTypeOf("number")
    expect([...rows.values()].find((row) => row.jti === rotatedIn)?.revoked_at).toBeUndefined()
    expect(decodeJwt(second.access_token).claxedo_cli_session_id).toBe(
      decodeJwt(first.access_token).claxedo_cli_session_id,
    )

    // Old accepted no more; new accepted.
    await expect(refreshCliSessionTokens(first.refresh_token, env, { registry })).rejects.toThrow(/revoked/i)
    await expect(verifyCliAccessBearer(second.access_token, env, { registry })).resolves.toBeTruthy()

    // Revoked: rejected.
    expect(await registry.revokeForUser({ tokenIdentifier: OWNER })).toMatchObject({ revoked: expect.any(Number) })
    await expect(verifyCliAccessBearer(second.access_token, env, { registry })).rejects.toThrow(/revoked/i)
  })

  test("a concurrent second rotation of the same refresh token loses", async () => {
    // Two refreshes racing on one token must not both succeed: that would fork
    // one login chain into two live credentials, which is what a
    // mint-then-revoke rotation permits in the gap between its two writes.
    const env = await keyEnv()
    const { registry } = durableCliSessionTokenRegistry()
    const first = await mintCliSessionTokens(auth(), env, { registry })

    const results = await Promise.allSettled([
      refreshCliSessionTokens(first.refresh_token, env, { registry }),
      refreshCliSessionTokens(first.refresh_token, env, { registry }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
  })

  test("a rejected rotation writes nothing and leaves the presented token untouched", async () => {
    const env = await keyEnv()
    const { registry, rows } = durableCliSessionTokenRegistry()
    const first = await mintCliSessionTokens(auth(), env, { registry })
    const before = rows.size

    // A rotation whose `previous` is unknown: the replacements must not land.
    const rotated = await registry.rotate({
      previous: { jti: "never-minted", tokenIdentifier: OWNER },
      minted: [
        {
          jti: "would-be-access",
          kind: "access",
          tokenIdentifier: OWNER,
          subject: "user_1",
          sessionId: "chain_x",
          expiresAt: Date.now() + 60_000,
          sessionExpiresAt: Date.now() + 600_000,
        },
      ],
    })

    expect(rotated).toMatchObject({ ok: false, code: "cli_session_token_unknown" })
    expect(rows.size).toBe(before)
    // The real refresh token is still the live one — no coverage gap.
    await expect(refreshCliSessionTokens(first.refresh_token, env, { registry })).resolves.toBeTruthy()
  })
})

describe("convex/cliSessionTokens authorization", () => {
  test("every service function rejects a wrong service token", async () => {
    const { db } = seeded([record()])
    const wrong = { service_token: "wrong" }

    await expect(cliSessionHandler(recordMint)({ db }, { ...wrong, ...record({ jti: "other" }) })).rejects.toThrow(
      "Unauthenticated",
    )
    await expect(
      cliSessionHandler(active)({ db }, { ...wrong, jti: "jti_access", kind: "access", token_identifier: OWNER }),
    ).rejects.toThrow("Unauthenticated")
    await expect(
      cliSessionHandler(rotate)({ db }, { ...wrong, previous_jti: "jti_access", token_identifier: OWNER, minted: [] }),
    ).rejects.toThrow("Unauthenticated")
    await expect(cliSessionHandler(revoke)({ db }, { ...wrong, jti: "jti_access", token_identifier: OWNER }))
      .rejects.toThrow("Unauthenticated")
    await expect(
      cliSessionHandler(revokeSession)({ db }, { ...wrong, session_id: "chain_1", token_identifier: OWNER }),
    ).rejects.toThrow("Unauthenticated")
    await expect(cliSessionHandler(revokeForUser)({ db }, { ...wrong, token_identifier: OWNER })).rejects.toThrow(
      "Unauthenticated",
    )
  })

  test("revocation cannot reach another user's rows", async () => {
    // The denial-of-service shape: naming a victim's jti / chain / owner under
    // your own identity must be a no-op, not a sign-out.
    const { db, rows } = seeded([
      record({ jti: "victim_access" }),
      record({ jti: "victim_refresh", kind: "refresh" }),
    ])
    const service = { service_token: SERVICE_TOKEN }

    expect(await cliSessionHandler(revoke)({ db }, { ...service, jti: "victim_access", token_identifier: INTRUDER }))
      .toEqual({ revoked: 0 })
    expect(
      await cliSessionHandler(revokeSession)({ db }, { ...service, session_id: "chain_1", token_identifier: INTRUDER }),
    ).toEqual({ revoked: 0 })
    expect(await cliSessionHandler(revokeForUser)({ db }, { ...service, token_identifier: INTRUDER }))
      .toEqual({ revoked: 0 })

    expect([...rows.values()].every((row) => row.revoked_at === undefined)).toBe(true)
    // Positive control: the real owner CAN.
    expect(await cliSessionHandler(revokeForUser)({ db }, { ...service, token_identifier: OWNER }))
      .toEqual({ revoked: 2 })
  })

  test("revokeMine takes no owner argument — it reads the authenticated identity", async () => {
    // The end-user path. There is no argument that names a victim, so "revoke
    // someone else's sessions" is unrepresentable rather than merely refused.
    const { db, rows } = seeded([
      record({ jti: "mine_access" }),
      record({ jti: "theirs_access", token_identifier: INTRUDER, session_id: "chain_2" }),
    ])
    const ctx = {
      db,
      auth: { getUserIdentity: async () => ({ tokenIdentifier: OWNER, subject: "user_1" }) },
    }

    expect(await cliSessionHandler(revokeMine)(ctx, {})).toEqual({ revoked: 1 })
    expect([...rows.values()].find((row) => row.jti === "mine_access")?.revoked_at).toBeTypeOf("number")
    expect([...rows.values()].find((row) => row.jti === "theirs_access")?.revoked_at).toBeUndefined()
  })

  test("revokeMine refuses an unauthenticated caller", async () => {
    const { db } = seeded([record()])
    await expect(
      cliSessionHandler(revokeMine)({ db, auth: { getUserIdentity: async () => null } }, {}),
    ).rejects.toThrow("Unauthenticated")
  })

  test("active fails closed on unknown, revoked, expired, and wrong-owner rows", async () => {
    const now = Date.now()
    const { db } = seeded([
      record({ jti: "live" }),
      record({ jti: "dead", revoked_at: now }),
      record({ jti: "stale", expires_at: now - 1 }),
      record({ jti: "chain_over", session_expires_at: now - 1 }),
    ])
    const check = (jti: string, token_identifier = OWNER, kind = "access") =>
      cliSessionHandler(active)({ db }, { service_token: SERVICE_TOKEN, jti, kind, token_identifier })

    await expect(check("live")).resolves.toMatchObject({ active: true, record: { tokenIdentifier: OWNER } })
    await expect(check("absent")).resolves.toMatchObject({ active: false, code: "cli_session_token_unknown" })
    await expect(check("dead")).resolves.toMatchObject({ active: false, code: "cli_session_token_revoked" })
    await expect(check("stale")).resolves.toMatchObject({ active: false, code: "cli_session_token_expired" })
    await expect(check("chain_over")).resolves.toMatchObject({ active: false, code: "cli_session_token_expired" })
    // An access token presented as a refresh token, and a token claimed by the
    // wrong owner, are both mismatches rather than accepts.
    await expect(check("live", OWNER, "refresh")).resolves.toMatchObject({
      active: false,
      code: "cli_session_token_mismatch",
    })
    await expect(check("live", INTRUDER)).resolves.toMatchObject({
      active: false,
      code: "cli_session_token_mismatch",
    })
  })

  test("rotate burns and registers in one step, and refuses to mint for another owner", async () => {
    const now = Date.now()
    const { db, rows } = seeded([record({ jti: "spent", kind: "refresh" })])
    const service = { service_token: SERVICE_TOKEN }
    const replacement = (jti: string, token_identifier = OWNER) => ({
      jti,
      kind: "access" as const,
      token_identifier,
      subject: "user_1",
      session_id: "chain_1",
      expires_at: now + 60_000,
      session_expires_at: now + 600_000,
    })

    // Owner-pinned: the replacements inherit the burned token's owner, so a
    // held chain cannot be used to mint credentials for somebody else.
    expect(
      await cliSessionHandler(rotate)({ db }, {
        ...service,
        previous_jti: "spent",
        token_identifier: OWNER,
        minted: [replacement("hijack", INTRUDER)],
      }),
    ).toMatchObject({ ok: false, code: "cli_session_token_mismatch" })
    expect(rows.size).toBe(1)
    expect([...rows.values()][0]!.revoked_at).toBeUndefined()

    expect(
      await cliSessionHandler(rotate)({ db }, {
        ...service,
        previous_jti: "spent",
        token_identifier: OWNER,
        minted: [replacement("fresh")],
      }),
    ).toEqual({ ok: true })
    expect([...rows.values()].find((row) => row.jti === "spent")?.revoked_at).toBeTypeOf("number")
    expect([...rows.values()].find((row) => row.jti === "fresh")?.revoked_at).toBeUndefined()

    // Replay of the now-spent token registers nothing.
    expect(
      await cliSessionHandler(rotate)({ db }, {
        ...service,
        previous_jti: "spent",
        token_identifier: OWNER,
        minted: [replacement("replayed")],
      }),
    ).toMatchObject({ ok: false, code: "cli_session_token_revoked" })
    expect([...rows.values()].some((row) => row.jti === "replayed")).toBe(false)
  })

  test("recordMint refuses to shadow an existing jti", async () => {
    const { db } = seeded([record({ jti: "taken" })])
    await expect(
      cliSessionHandler(recordMint)({ db }, { service_token: SERVICE_TOKEN, ...record({ jti: "taken" }) }),
    ).rejects.toThrow(/already recorded/)
  })
})

describe("the reaper keeps the table bounded", () => {
  test("deletes rows whose token has expired past the retention cushion, in bounded batches", async () => {
    const now = Date.now()
    const { db, rows } = seeded([
      record({ jti: "ancient", expires_at: now - 10 * 60 * 60 * 1000 }),
      record({ jti: "old", expires_at: now - 9 * 60 * 60 * 1000 }),
      // Expired, but still inside the cushion: kept.
      record({ jti: "recent", expires_at: now - 60_000 }),
      record({ jti: "live", expires_at: now + 60_000 }),
    ])

    expect(await cliSessionHandler(reapExpired)({ db }, { retain_ms: 60 * 60 * 1000, limit: 1 }))
      .toEqual({ deleted: 1 })
    expect(rows.size).toBe(3)

    expect(await cliSessionHandler(reapExpired)({ db }, { retain_ms: 60 * 60 * 1000, limit: 100 }))
      .toEqual({ deleted: 1 })
    expect([...rows.values()].map((row) => row.jti).sort()).toEqual(["live", "recent"])
  })
})
